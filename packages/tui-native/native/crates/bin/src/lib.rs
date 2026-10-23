//! `cch-tui` development binary: replay/engine adapters around the runner.
//!
//! The interactive loop lives in `cch-tui-runner`; shipping builds embed that
//! crate through the napi bindings instead of installing this executable.

pub mod bench;
pub mod engine;

use std::collections::BTreeMap;
use std::io::{self, BufRead, BufReader, Read};
use std::path::PathBuf;
use std::sync::mpsc::{self, Sender};
use std::thread;
use std::time::Duration;

use cch_tui_fullscreen::TranscriptModel;
use cch_tui_proto::{EngineEvent, parse_line};
use cch_tui_runner::RunOptions;
use cch_tui_ui::{Row, SessionView};
use engine::{EngineMessage, EngineProcess};

#[derive(Debug, Default, PartialEq, Eq)]
pub struct CheckReport {
    pub frames: usize,
    pub errors: usize,
    pub by_kind: BTreeMap<&'static str, usize>,
    pub view: SessionView,
}

impl CheckReport {
    pub fn summary(&self) -> String {
        let kinds = self
            .by_kind
            .iter()
            .map(|(kind, count)| format!("{kind}={count}"))
            .collect::<Vec<_>>()
            .join(",");
        format!(
            "frames={} errors={} kinds=[{}] session={} model={} user={} assistant={} deltas={} pending_permissions={}",
            self.frames,
            self.errors,
            kinds,
            self.view.session_id.as_deref().unwrap_or("-"),
            self.view.model.as_deref().unwrap_or("-"),
            self.view.user_messages,
            self.view.assistant_messages,
            self.view.stream_deltas,
            self.view.pending_permissions,
        )
    }
}

/// Parse every line from `reader`, folding valid frames into a session view.
/// Blank lines are ignored; a malformed line counts as an error but does not
/// abort, mirroring the interactive TUI's forward-compatible parsing.
/// Freeze rows through the runner's spacing rules (benchmark/legacy path).
pub fn freeze_fullscreen(transcript: &mut TranscriptModel, rows: &[Row]) {
    cch_tui_runner::freeze_rows(transcript, rows);
}

pub fn check_stream(reader: impl Read) -> CheckReport {
    let mut report = CheckReport::default();
    for line in BufReader::new(reader).lines() {
        let Ok(line) = line else {
            report.errors += 1;
            continue;
        };
        if line.trim().is_empty() {
            continue;
        }
        match parse_line(&line) {
            Ok(event) => {
                report.frames += 1;
                if event == EngineEvent::Unknown {
                    report.errors += 1;
                }
                *report.by_kind.entry(event.kind()).or_default() += 1;
                report.view.apply(&event);
            }
            Err(_) => report.errors += 1,
        }
    }
    report
}

/// Where the interactive runner gets events from.
pub enum Source {
    /// Replay an NDJSON fixture with the given pacing.
    Replay {
        path: PathBuf,
        frame_delay: Duration,
    },
    /// Spawn a real engine process.
    Engine { program: String, args: Vec<String> },
}

/// Run the interactive TUI until the user quits.
pub fn run(source: Source, fullscreen: bool) -> io::Result<()> {
    run_with_deadline(source, fullscreen, None)
}

/// Run the interactive TUI with an optional wall-clock budget.
///
/// `exit_after` is a test-only escape hatch (`--exit-after-ms`): once the
/// duration has elapsed the loop breaks and the terminal session is dropped,
/// which runs the normal restore path. `None` keeps the interactive behaviour.
pub fn run_with_deadline(
    source: Source,
    fullscreen: bool,
    exit_after: Option<Duration>,
) -> io::Result<()> {
    let (inbox, events) = mpsc::channel();
    match source {
        Source::Replay { path, frame_delay } => spawn_replay(path, frame_delay, inbox)?,
        Source::Engine { program, args } => spawn_engine(&program, &args, inbox)?,
    }
    // The development binary has no TypeScript host; commands are drained into
    // nothing while the loop runs.
    let (outbox, _commands) = mpsc::channel();
    cch_tui_runner::run_interactive_with_deadline(
        RunOptions {
            inbox: events,
            outbox,
            fullscreen,
            theme: None,
        },
        exit_after,
    )
}

/// Feed a fixture file into the inbox with optional pacing.
fn spawn_replay(
    path: PathBuf,
    frame_delay: Duration,
    inbox: Sender<EngineEvent>,
) -> io::Result<()> {
    let content = std::fs::read_to_string(path)?;
    let _ = thread::spawn(move || {
        for line in content.lines() {
            if line.trim().is_empty() {
                continue;
            }
            if let Ok(event) = parse_line(line)
                && inbox.send(event).is_err()
            {
                return;
            }
            if !frame_delay.is_zero() {
                thread::sleep(frame_delay);
            }
        }
    });
    Ok(())
}

/// Spawn the engine child process and forward parsed frames into the inbox.
fn spawn_engine(program: &str, args: &[String], inbox: Sender<EngineEvent>) -> io::Result<()> {
    let (process, messages) = EngineProcess::spawn(program, args)?;
    let _ = thread::spawn(move || {
        // Held for the lifetime of the reader so the child is killed by the
        // normal `Drop` path once the stream closes.
        let _process = process;
        for message in messages {
            match message {
                EngineMessage::Event(event) => {
                    if inbox.send(event).is_err() {
                        return;
                    }
                }
                // Malformed frames have no representation in the runner's
                // typed inbox; they are dropped instead of aborting the stream.
                EngineMessage::Malformed(_) => {}
                EngineMessage::Closed => return,
            }
        }
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counts_frames_and_tolerates_bad_lines() {
        let input = concat!(
            r#"{"type":"system","subtype":"init","session_id":"s1","model":"m"}"#,
            "\n",
            "\n",
            "not json\n",
            r#"{"type":"assistant","uuid":"a1"}"#,
            "\n",
            r#"{"type":"brand_new","x":1}"#,
            "\n",
        );
        let report = check_stream(input.as_bytes());

        assert_eq!(report.frames, 3);
        // One bad JSON line + one unknown frame type.
        assert_eq!(report.errors, 2);
        assert_eq!(report.by_kind.get("assistant"), Some(&1));
        assert_eq!(report.view.session_id.as_deref(), Some("s1"));
        assert_eq!(report.view.assistant_messages, 1);
    }
}
