//! Domain components (transcript, message blocks, permission dialog, prompt
//! input, status line, task panels). M0 only defines the event-to-view-model
//! seam so the binary can be exercised headlessly.

use cch_tui_proto::EngineEvent;

/// Minimal view model the transcript consumes in M0.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct SessionView {
    pub session_id: Option<String>,
    pub model: Option<String>,
    pub assistant_messages: usize,
    pub user_messages: usize,
    pub stream_deltas: usize,
    pub pending_permissions: usize,
    pub last_error: Option<String>,
}

impl SessionView {
    /// Fold one engine event into the view. Unknown frames are ignored.
    pub fn apply(&mut self, event: &EngineEvent) {
        match event {
            EngineEvent::System { subtype, extra } => {
                if subtype == "init" {
                    self.session_id = string_field(extra, "session_id");
                    self.model = string_field(extra, "model");
                }
            }
            EngineEvent::User { .. } => self.user_messages += 1,
            EngineEvent::Assistant { .. } => self.assistant_messages += 1,
            EngineEvent::StreamEvent { .. } => self.stream_deltas += 1,
            EngineEvent::ControlRequest { .. } => self.pending_permissions += 1,
            EngineEvent::ControlResponse { .. } => {
                self.pending_permissions = self.pending_permissions.saturating_sub(1);
            }
            EngineEvent::Result { extra } => {
                if string_field(extra, "subtype").as_deref() == Some("error") {
                    self.last_error = string_field(extra, "error");
                }
            }
            EngineEvent::ControlCancelRequest { .. }
            | EngineEvent::KeepAlive
            | EngineEvent::Unknown => {}
        }
    }
}

fn string_field(extra: &serde_json::Map<String, serde_json::Value>, key: &str) -> Option<String> {
    extra
        .get(key)
        .and_then(serde_json::Value::as_str)
        .map(ToOwned::to_owned)
}

#[cfg(test)]
mod tests {
    use super::*;
    use cch_tui_proto::parse_line;

    #[test]
    fn folds_engine_events_into_the_session_view() {
        let mut view = SessionView::default();
        for line in [
            r#"{"type":"system","subtype":"init","session_id":"s1","model":"m1"}"#,
            r#"{"type":"user","uuid":"u1"}"#,
            r#"{"type":"assistant","uuid":"a1"}"#,
            r#"{"type":"stream_event","uuid":"a1"}"#,
            r#"{"type":"control_request","request_id":"r1","request":{"subtype":"can_use_tool","tool_name":"Bash","tool_use_id":"t1"}}"#,
            r#"{"type":"control_response","response":{"subtype":"success","request_id":"r1"}}"#,
            r#"{"type":"result","subtype":"error","error":"boom"}"#,
        ] {
            view.apply(&parse_line(line).expect("valid frame"));
        }

        assert_eq!(view.session_id.as_deref(), Some("s1"));
        assert_eq!(view.model.as_deref(), Some("m1"));
        assert_eq!(view.user_messages, 1);
        assert_eq!(view.assistant_messages, 1);
        assert_eq!(view.stream_deltas, 1);
        assert_eq!(view.pending_permissions, 0);
        assert_eq!(view.last_error.as_deref(), Some("boom"));
    }
}
