//! Wire types for the engine <-> TUI NDJSON protocol.
//!
//! The shapes mirror the SDK schemas the engine already speaks:
//! `src/entrypoints/sdk/coreSchemas.ts` and
//! `src/entrypoints/sdk/controlSchemas.ts`. Unknown values must never abort the
//! stream: every message keeps a flattened `extra` map, and unknown control
//! subtypes decode to [`ControlRequest::Unknown`].

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

/// Bumped whenever a field changes meaning; the TUI refuses mismatched engines.
pub const PROTOCOL_VERSION: &str = "1";

pub type Extra = Map<String, Value>;

/// One NDJSON frame produced by the engine.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum EngineEvent {
    /// `{"type":"system","subtype":"init"|"status"|"compact_boundary",...}`
    System {
        subtype: String,
        #[serde(flatten)]
        extra: Extra,
    },
    User {
        #[serde(flatten)]
        extra: Extra,
    },
    Assistant {
        #[serde(flatten)]
        extra: Extra,
    },
    /// Raw `BetaRawMessageStreamEvent` with the engine's uuid attached.
    StreamEvent {
        #[serde(flatten)]
        extra: Extra,
    },
    Result {
        #[serde(flatten)]
        extra: Extra,
    },
    /// Top-level `rate_limit_event` frame emitted by the SDK stream (it is not
    /// wrapped in a `system` envelope).
    RateLimitEvent {
        #[serde(flatten)]
        extra: Extra,
    },
    ControlRequest {
        request_id: String,
        request: ControlRequest,
    },
    ControlResponse {
        response: ControlResponse,
    },
    ControlCancelRequest {
        request_id: String,
    },
    KeepAlive,
    /// Forward-compatible: a frame we do not model yet is skipped, not fatal.
    #[serde(other)]
    Unknown,
}

impl EngineEvent {
    /// Stable tag used for counters and logs.
    pub fn kind(&self) -> &'static str {
        match self {
            EngineEvent::System { .. } => "system",
            EngineEvent::User { .. } => "user",
            EngineEvent::Assistant { .. } => "assistant",
            EngineEvent::StreamEvent { .. } => "stream_event",
            EngineEvent::Result { .. } => "result",
            EngineEvent::RateLimitEvent { .. } => "rate_limit_event",
            EngineEvent::ControlRequest { .. } => "control_request",
            EngineEvent::ControlResponse { .. } => "control_response",
            EngineEvent::ControlCancelRequest { .. } => "control_cancel_request",
            EngineEvent::KeepAlive => "keep_alive",
            EngineEvent::Unknown => "unknown",
        }
    }
}

/// A request the engine sends to the TUI and awaits a response for.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "subtype", rename_all = "snake_case")]
pub enum ControlRequest {
    /// Boxed: the permission payload is much larger than the other variants.
    CanUseTool(Box<CanUseToolRequest>),
    Interrupt,
    SetPermissionMode {
        mode: String,
    },
    GetContextUsage,
    /// Subtypes this build does not implement; the TUI replies with an error
    /// response instead of dropping the request.
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CanUseToolRequest {
    pub tool_name: String,
    #[serde(default)]
    pub input: Extra,
    pub tool_use_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub permission_suggestions: Option<Vec<Value>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub blocked_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub decision_reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

impl ControlRequest {
    /// The subtype string, including for [`ControlRequest::Unknown`], so an
    /// error response can name what was rejected.
    pub fn subtype(&self) -> &'static str {
        match self {
            ControlRequest::CanUseTool(_) => "can_use_tool",
            ControlRequest::Interrupt => "interrupt",
            ControlRequest::SetPermissionMode { .. } => "set_permission_mode",
            ControlRequest::GetContextUsage => "get_context_usage",
            ControlRequest::Unknown => "unknown",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "subtype", rename_all = "snake_case")]
pub enum ControlResponse {
    Success {
        request_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        response: Option<Extra>,
    },
    Error {
        request_id: String,
        error: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pending_permission_requests: Option<Vec<EngineEvent>>,
    },
}

#[derive(Debug, thiserror::Error)]
pub enum ProtocolError {
    #[error("line is not valid JSON: {0}")]
    Json(#[from] serde_json::Error),
    #[error("frame has no string `type` field")]
    MissingType,
}

/// Parse a single NDJSON line (without its trailing newline).
pub fn parse_line(line: &str) -> Result<EngineEvent, ProtocolError> {
    let value: Value = serde_json::from_str(line)?;
    match value.get("type").and_then(Value::as_str) {
        Some(_) => Ok(serde_json::from_value(value)?),
        None => Err(ProtocolError::MissingType),
    }
}

/// Serialise one frame, without the trailing newline.
pub fn encode(event: &EngineEvent) -> Result<String, serde_json::Error> {
    serde_json::to_string(event)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse_all(lines: &[&str]) -> Vec<EngineEvent> {
        lines
            .iter()
            .map(|line| parse_line(line).expect("valid frame"))
            .collect()
    }

    #[test]
    fn parses_sdk_message_shapes() {
        let events = parse_all(&[
            r#"{"type":"system","subtype":"init","session_id":"s1","model":"m"}"#,
            r#"{"type":"assistant","uuid":"u1","message":{"role":"assistant","content":[]}}"#,
            r#"{"type":"user","uuid":"u2","message":{"role":"user","content":"hi"}}"#,
            r#"{"type":"stream_event","uuid":"u3","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"x"}}}"#,
            r#"{"type":"result","subtype":"success","total_cost_usd":0.1}"#,
            r#"{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","utilization":0.5}}"#,
        ]);

        assert!(matches!(&events[0], EngineEvent::System { subtype, .. } if subtype == "init"));
        assert!(matches!(&events[1], EngineEvent::Assistant { .. }));
        assert!(matches!(&events[2], EngineEvent::User { .. }));
        assert!(matches!(&events[3], EngineEvent::StreamEvent { .. }));
        assert!(matches!(&events[4], EngineEvent::Result { .. }));
        assert!(matches!(&events[5], EngineEvent::RateLimitEvent { .. }));
    }

    #[test]
    fn parses_permission_request_and_round_trips() {
        let line = r#"{"type":"control_request","request_id":"r1","request":{"subtype":"can_use_tool","tool_name":"Bash","input":{"command":"ls"},"tool_use_id":"t1","description":"run ls"}}"#;
        let event = parse_line(line).expect("valid frame");
        let EngineEvent::ControlRequest {
            request_id,
            request,
        } = &event
        else {
            panic!("expected control_request, got {event:?}");
        };
        assert_eq!(request_id, "r1");
        let ControlRequest::CanUseTool(permission) = request else {
            panic!("expected can_use_tool, got {request:?}");
        };
        assert_eq!(permission.tool_name, "Bash");
        assert_eq!(permission.tool_use_id, "t1");

        let encoded = encode(&event).expect("encode");
        assert_eq!(parse_line(&encoded).expect("reparse"), event);
    }

    #[test]
    fn keeps_unknown_control_subtypes_non_fatal() {
        let line = r#"{"type":"control_request","request_id":"r2","request":{"subtype":"some_future_thing","x":1}}"#;
        let event = parse_line(line).expect("valid frame");
        let EngineEvent::ControlRequest { request, .. } = &event else {
            panic!("expected control_request");
        };
        assert_eq!(*request, ControlRequest::Unknown);
        assert_eq!(request.subtype(), "unknown");
    }

    #[test]
    fn skips_unknown_frame_types_without_error() {
        let event = parse_line(r#"{"type":"brand_new_thing","payload":1}"#).expect("valid frame");
        assert_eq!(event, EngineEvent::Unknown);
    }

    #[test]
    fn rejects_frames_without_type() {
        assert!(matches!(
            parse_line(r#"{"session_id":"s1"}"#),
            Err(ProtocolError::MissingType)
        ));
    }

    #[test]
    fn round_trips_control_responses_and_keep_alive() {
        let success = EngineEvent::ControlResponse {
            response: ControlResponse::Success {
                request_id: "r1".into(),
                response: Some(Extra::from_iter([(
                    "behavior".into(),
                    Value::String("allow".into()),
                )])),
            },
        };
        let encoded = encode(&success).expect("encode");
        assert_eq!(parse_line(&encoded).expect("reparse"), success);

        let error = EngineEvent::ControlResponse {
            response: ControlResponse::Error {
                request_id: "r2".into(),
                error: "denied".into(),
                pending_permission_requests: None,
            },
        };
        let encoded = encode(&error).expect("encode");
        assert_eq!(parse_line(&encoded).expect("reparse"), error);

        assert_eq!(
            parse_line(r#"{"type":"keep_alive"}"#).expect("parse"),
            EngineEvent::KeepAlive
        );
    }
}
