//! Headless entry points used by CI smoke tests.
//!
//! `--check-tui` reads NDJSON frames from stdin and reports what it parsed.
//! It exercises the same parser the interactive TUI will use, without needing
//! a terminal, an engine process, or the ratatui stack.

use std::collections::BTreeMap;
use std::io::{BufRead, BufReader, Read};

use cch_tui_proto::{EngineEvent, parse_line};
use cch_tui_ui::SessionView;

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
