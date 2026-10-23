//! Headless entry points used by CI smoke tests and the interactive runner.

pub mod engine;

use std::collections::BTreeMap;
use std::io::{self, BufRead, BufReader, Read};
use std::path::PathBuf;
use std::sync::mpsc::{Receiver, TryRecvError};
use std::time::Duration;

use cch_tui_proto::{ControlRequest, EngineEvent, parse_line};
use cch_tui_render::{DEFAULT_INLINE_HEIGHT, TerminalSession};
use cch_tui_ui::{ChatView, SessionView};
use engine::{EngineMessage, EngineProcess};
use ratatui::crossterm::event::{self, Event, KeyCode, KeyEventKind, KeyModifiers};

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
    let mut session = if fullscreen {
        TerminalSession::fullscreen()?
    } else {
        TerminalSession::inline(DEFAULT_INLINE_HEIGHT)?
    };
    let mut view = ChatView::new();
    let mut engine: Option<EngineProcess> = None;

    let rx: Receiver<EngineMessage> = match source {
        Source::Replay { path, frame_delay } => engine::replay(path, frame_delay)?,
        Source::Engine { program, args } => {
            let (process, rx) = EngineProcess::spawn(&program, &args)?;
            engine = Some(process);
            rx
        }
    };

    let mut engine_closed = false;
    let mut pending_permission: Option<(String, String, serde_json::Value)> = None;
    loop {
        // Drain engine/replay frames.
        loop {
            match rx.try_recv() {
                Ok(EngineMessage::Event(event)) => {
                    match &event {
                        EngineEvent::ControlRequest {
                            request_id,
                            request: ControlRequest::CanUseTool(permission),
                        } => {
                            pending_permission = Some((
                                request_id.clone(),
                                permission.tool_name.clone(),
                                serde_json::Value::Object(permission.input.clone()),
                            ));
                        }
                        EngineEvent::ControlResponse { .. } => pending_permission = None,
                        _ => {}
                    }
                    let frozen = view.ingest(&event);
                    session.insert_rows(&frozen)?;
                }
                Ok(EngineMessage::Malformed(line)) => {
                    view.completed.push(cch_tui_ui::Row::new(
                        cch_tui_ui::RowStyle::Error,
                        format!("[protocol] {line}"),
                    ));
                }
                Ok(EngineMessage::Closed) => {
                    engine_closed = true;
                    break;
                }
                Err(TryRecvError::Empty) => break,
                Err(TryRecvError::Disconnected) => {
                    engine_closed = true;
                    break;
                }
            }
        }
        if engine_closed {
            view.status = Some("engine exited — press q".into());
        }

        session.draw(&view)?;

        if !event::poll(Duration::from_millis(33))? {
            continue;
        }
        let Event::Key(key) = event::read()? else {
            continue;
        };
        if key.kind != KeyEventKind::Press {
            continue;
        }
        // Permission prompt: y allows, n (or Esc) denies. Takes precedence over
        // text input while a request is pending.
        if let Some((request_id, tool_name, input)) = pending_permission.clone() {
            let decision = match key.code {
                KeyCode::Char('y') | KeyCode::Char('Y') => Some(true),
                KeyCode::Char('n') | KeyCode::Char('N') | KeyCode::Esc => Some(false),
                _ => None,
            };
            if let Some(allow) = decision {
                if let Some(process) = engine.as_mut() {
                    let response = if allow {
                        serde_json::json!({ "behavior": "allow", "updatedInput": input })
                    } else {
                        serde_json::json!({ "behavior": "deny", "message": "Denied by user" })
                    };
                    process.send_control_response(&request_id, response)?;
                }
                view.status = Some(format!(
                    "{} {}",
                    if allow { "allowed" } else { "denied" },
                    tool_name
                ));
                pending_permission = None;
                continue;
            }
        }

        match key.code {
            KeyCode::Char('c') if key.modifiers.contains(KeyModifiers::CONTROL) => break,
            KeyCode::Esc | KeyCode::Char('q') if view.input.is_empty() && engine_closed => break,
            KeyCode::Esc => view.input.clear(),
            KeyCode::Backspace => {
                view.input.pop();
            }
            KeyCode::Enter => {
                if let Some(row) = view.submit_input() {
                    session.insert_rows(std::slice::from_ref(&row))?;
                    if let Some(process) = engine.as_mut() {
                        process.send_prompt(row.text.trim_start_matches("> "))?;
                        view.status = Some("sent".into());
                    }
                }
            }
            KeyCode::Char(ch) => view.input.push(ch),
            _ => {}
        }
    }

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
