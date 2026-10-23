//! The `can_use_tool` permission dialog.
//!
//! A dialog is created from one engine request and produces at most one
//! terminal [`PermissionDecision`]. Once the dialog is resolved, cancelled by
//! the user (`Esc`), timed out, or cancelled by the engine, every later
//! confirmation is rejected: `resolve` returns `None` and the state never
//! produces a second response for the same `request_id`.

use cch_tui_proto::{CanUseToolRequest, ControlRequest, Extra};
use serde_json::{Map, Value, json};

/// One selectable row in a permission dialog.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum PermissionOption {
    /// Allow just this tool call.
    AllowOnce,
    /// Allow and persist the engine-provided permission suggestions.
    AllowAlways,
    /// Reject the tool call.
    Deny,
}

impl PermissionOption {
    /// User-facing row label.
    pub const fn label(self) -> &'static str {
        match self {
            Self::AllowOnce => "Allow once",
            Self::AllowAlways => "Allow and don't ask again",
            Self::Deny => "Deny",
        }
    }
}

/// The terminal answer to a permission request.
#[derive(Debug, Clone, PartialEq)]
pub enum PermissionDecision {
    /// Allow the tool call, optionally with rewritten input and permission
    /// updates (the `permission_suggestions` from the request).
    Allow {
        updated_input: Extra,
        updated_permissions: Vec<Value>,
    },
    /// Reject the tool call with a message shown to the model.
    Deny { message: String },
}

impl PermissionDecision {
    /// Build a denial with the conventional user-facing message.
    pub fn deny(message: impl Into<String>) -> Self {
        Self::Deny {
            message: message.into(),
        }
    }

    pub fn is_allow(&self) -> bool {
        matches!(self, Self::Allow { .. })
    }

    /// Wire shape of the `response` payload inside `control_response`.
    ///
    /// Matches the SDK `PermissionResult` schema: `behavior` plus
    /// `updatedInput`/`updatedPermissions` for allows, `message` for denials.
    pub fn to_response(&self) -> Value {
        match self {
            Self::Allow {
                updated_input,
                updated_permissions,
            } => {
                let mut response = Map::new();
                response.insert("behavior".into(), json!("allow"));
                response.insert("updatedInput".into(), Value::Object(updated_input.clone()));
                if !updated_permissions.is_empty() {
                    response.insert(
                        "updatedPermissions".into(),
                        Value::Array(updated_permissions.clone()),
                    );
                }
                Value::Object(response)
            }
            Self::Deny { message } => json!({
                "behavior": "deny",
                "message": message,
            }),
        }
    }
}

/// State of one permission request.
#[derive(Debug, Clone)]
pub struct PermissionDialog {
    request_id: String,
    tool_name: String,
    input: Extra,
    description: Option<String>,
    suggestions: Vec<Value>,
    selected: usize,
    decision: Option<PermissionDecision>,
    closed: bool,
}

impl PermissionDialog {
    /// Build a dialog from an owned `can_use_tool` payload.
    pub fn new(request_id: impl Into<String>, request: CanUseToolRequest) -> Self {
        Self {
            request_id: request_id.into(),
            tool_name: request.tool_name,
            input: request.input,
            description: request.description,
            suggestions: request.permission_suggestions.unwrap_or_default(),
            selected: 0,
            decision: None,
            closed: false,
        }
    }

    /// Build a dialog from a borrowed `can_use_tool` payload.
    pub fn from_can_use_tool(request_id: impl Into<String>, request: &CanUseToolRequest) -> Self {
        Self::new(request_id, request.clone())
    }

    /// Build a dialog from a control request. Returns `None` for any subtype
    /// other than `can_use_tool`.
    pub fn from_request(request_id: impl Into<String>, request: &ControlRequest) -> Option<Self> {
        match request {
            ControlRequest::CanUseTool(can_use_tool) => {
                Some(Self::from_can_use_tool(request_id, can_use_tool.as_ref()))
            }
            _ => None,
        }
    }

    pub fn request_id(&self) -> &str {
        &self.request_id
    }

    pub fn tool_name(&self) -> &str {
        &self.tool_name
    }

    pub fn input(&self) -> &Extra {
        &self.input
    }

    pub fn description(&self) -> Option<&str> {
        self.description.as_deref()
    }

    pub fn suggestions(&self) -> &[Value] {
        &self.suggestions
    }

    /// Selectable options in display order. `AllowAlways` only exists when the
    /// engine supplied permission suggestions.
    pub fn options(&self) -> Vec<PermissionOption> {
        let mut options = vec![PermissionOption::AllowOnce];
        if !self.suggestions.is_empty() {
            options.push(PermissionOption::AllowAlways);
        }
        options.push(PermissionOption::Deny);
        options
    }

    /// Index of the highlighted option.
    pub fn selected(&self) -> usize {
        self.selected
    }

    /// Currently highlighted option.
    pub fn selected_option(&self) -> PermissionOption {
        if self.selected == 0 {
            return PermissionOption::AllowOnce;
        }
        if self.selected == 1 && !self.suggestions.is_empty() {
            return PermissionOption::AllowAlways;
        }
        PermissionOption::Deny
    }

    /// Move the highlight up, wrapping around. Navigation is inert once the
    /// dialog is terminal.
    pub fn select_previous(&mut self) -> PermissionOption {
        if !self.closed {
            let count = self.option_count();
            self.selected = (self.selected + count - 1) % count;
        }
        self.selected_option()
    }

    /// Move the highlight down, wrapping around. Navigation is inert once the
    /// dialog is terminal.
    pub fn select_next(&mut self) -> PermissionOption {
        if !self.closed {
            self.selected = (self.selected + 1) % self.option_count();
        }
        self.selected_option()
    }

    /// `true` until the dialog resolves or is cancelled/timed out.
    pub fn is_open(&self) -> bool {
        !self.closed
    }

    /// The terminal decision, if the dialog produced one.
    pub fn decision(&self) -> Option<&PermissionDecision> {
        self.decision.as_ref()
    }

    /// Confirm the highlighted option. Returns the decision exactly once;
    /// a repeat call, or a call after cancel/timeout/engine cancellation,
    /// returns `None`.
    pub fn resolve(&mut self) -> Option<PermissionDecision> {
        if self.closed {
            return None;
        }
        let decision = match self.selected_option() {
            PermissionOption::AllowOnce => PermissionDecision::Allow {
                updated_input: self.input.clone(),
                updated_permissions: Vec::new(),
            },
            PermissionOption::AllowAlways => PermissionDecision::Allow {
                updated_input: self.input.clone(),
                updated_permissions: self.suggestions.clone(),
            },
            PermissionOption::Deny => PermissionDecision::deny("Denied by user"),
        };
        self.decision = Some(decision.clone());
        self.closed = true;
        Some(decision)
    }

    /// User cancelled with `Esc`. Produces a denial, exactly once.
    pub fn cancel(&mut self) -> Option<PermissionDecision> {
        if self.closed {
            return None;
        }
        let decision = PermissionDecision::deny("Denied by user");
        self.decision = Some(decision.clone());
        self.closed = true;
        Some(decision)
    }

    /// Dialog timed out. Closes without producing a decision.
    pub fn timeout(&mut self) -> bool {
        self.close_without_decision()
    }

    /// The engine sent `control_cancel_request` for this dialog. Closes
    /// without producing a decision; a later confirm is rejected.
    pub fn cancel_from_engine(&mut self) -> bool {
        self.close_without_decision()
    }

    fn close_without_decision(&mut self) -> bool {
        if self.closed {
            return false;
        }
        self.closed = true;
        true
    }

    fn option_count(&self) -> usize {
        if self.suggestions.is_empty() { 2 } else { 3 }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(suggestions: Option<Vec<Value>>) -> CanUseToolRequest {
        CanUseToolRequest {
            tool_name: "Bash".into(),
            input: Extra::from_iter([("command".into(), json!("ls -la"))]),
            tool_use_id: "tool-1".into(),
            permission_suggestions: suggestions,
            blocked_path: None,
            decision_reason: None,
            title: None,
            display_name: None,
            agent_id: None,
            description: Some("list files".into()),
        }
    }

    fn make_dialog(suggestions: Option<Vec<Value>>) -> PermissionDialog {
        PermissionDialog::new("req-1", request(suggestions))
    }

    fn suggestion() -> Value {
        json!({
            "type": "addRules",
            "rules": [{ "toolName": "Bash", "ruleContent": "ls:*" }],
            "behavior": "allow",
            "destination": "session",
        })
    }

    fn control_request(suggestions: Option<Vec<Value>>) -> ControlRequest {
        ControlRequest::CanUseTool(Box::new(request(suggestions)))
    }

    #[test]
    fn stores_the_request_fields() {
        let dialog = make_dialog(Some(vec![suggestion()]));
        assert_eq!(dialog.request_id(), "req-1");
        assert_eq!(dialog.tool_name(), "Bash");
        assert_eq!(dialog.input().get("command"), Some(&json!("ls -la")));
        assert_eq!(dialog.description(), Some("list files"));
        assert_eq!(dialog.suggestions().len(), 1);
        assert!(dialog.is_open());
        assert!(dialog.decision().is_none());
    }

    #[test]
    fn always_allow_is_only_offered_with_suggestions() {
        assert_eq!(
            make_dialog(None).options(),
            [PermissionOption::AllowOnce, PermissionOption::Deny]
        );
        assert_eq!(
            make_dialog(Some(vec![suggestion()])).options(),
            [
                PermissionOption::AllowOnce,
                PermissionOption::AllowAlways,
                PermissionOption::Deny
            ]
        );
        assert_eq!(
            PermissionOption::AllowAlways.label(),
            "Allow and don't ask again"
        );
    }

    #[test]
    fn navigation_wraps_in_both_directions() {
        let mut dialog = make_dialog(Some(vec![suggestion()]));
        assert_eq!(dialog.selected_option(), PermissionOption::AllowOnce);

        assert_eq!(dialog.select_next(), PermissionOption::AllowAlways);
        assert_eq!(dialog.select_next(), PermissionOption::Deny);
        assert_eq!(dialog.select_next(), PermissionOption::AllowOnce);

        assert_eq!(dialog.select_previous(), PermissionOption::Deny);
        assert_eq!(dialog.select_previous(), PermissionOption::AllowAlways);

        // Without suggestions the list is two rows.
        let mut short = make_dialog(None);
        assert_eq!(short.select_next(), PermissionOption::Deny);
        assert_eq!(short.select_next(), PermissionOption::AllowOnce);
    }

    #[test]
    fn allow_once_echoes_input_without_permission_updates() {
        let mut dialog = make_dialog(Some(vec![suggestion()]));
        let decision = dialog.resolve().expect("first resolve");
        let PermissionDecision::Allow {
            updated_input,
            updated_permissions,
        } = &decision
        else {
            panic!("expected allow, got {decision:?}");
        };
        assert_eq!(updated_input.get("command"), Some(&json!("ls -la")));
        assert!(updated_permissions.is_empty());
        assert!(dialog.decision().is_some() && !dialog.is_open());
        assert_eq!(dialog.resolve(), None, "terminal decision is emitted once");
    }

    #[test]
    fn allow_always_carries_the_suggestions() {
        let mut dialog = make_dialog(Some(vec![suggestion()]));
        dialog.select_next();
        let decision = dialog.resolve().expect("first resolve");
        let PermissionDecision::Allow {
            updated_permissions,
            ..
        } = &decision
        else {
            panic!("expected allow, got {decision:?}");
        };
        assert_eq!(updated_permissions, &[suggestion()]);

        let response = decision.to_response();
        assert_eq!(response.get("behavior"), Some(&json!("allow")));
        assert_eq!(
            response.get("updatedPermissions"),
            Some(&json!([suggestion()]))
        );
        assert_eq!(
            response.get("updatedInput"),
            Some(&json!({"command": "ls -la"}))
        );
    }

    #[test]
    fn deny_and_esc_are_terminal_denials() {
        let mut dialog = make_dialog(None);
        dialog.select_next(); // Deny
        let decision = dialog.resolve().expect("deny");
        assert_eq!(decision, PermissionDecision::deny("Denied by user"));
        assert_eq!(dialog.resolve(), None);

        let mut cancelled = make_dialog(None);
        assert_eq!(
            cancelled.cancel(),
            Some(PermissionDecision::deny("Denied by user"))
        );
        assert_eq!(
            cancelled.resolve(),
            None,
            "late confirm after Esc is rejected"
        );
        assert_eq!(cancelled.cancel(), None, "cancel is idempotent");
        assert_eq!(
            cancelled.selected_option(),
            PermissionOption::AllowOnce,
            "navigation is inert once terminal"
        );
    }

    #[test]
    fn engine_cancel_and_timeout_reject_late_confirmation() {
        let mut cancelled = make_dialog(None);
        assert!(cancelled.cancel_from_engine());
        assert!(!cancelled.cancel_from_engine());
        assert_eq!(cancelled.resolve(), None);
        assert!(cancelled.decision().is_none());

        let mut timed_out = make_dialog(Some(vec![suggestion()]));
        assert!(timed_out.timeout());
        assert!(!timed_out.timeout());
        assert_eq!(timed_out.resolve(), None);
        assert_eq!(timed_out.cancel(), None);
    }

    #[test]
    fn constructs_from_a_control_request_and_rejects_other_subtypes() {
        let dialog =
            PermissionDialog::from_request("req-9", &control_request(Some(vec![suggestion()])))
                .expect("can_use_tool");
        assert_eq!(dialog.request_id(), "req-9");
        assert_eq!(dialog.options().len(), 3);

        assert!(
            PermissionDialog::from_request("req-9", &ControlRequest::Interrupt).is_none(),
            "only can_use_tool opens a permission dialog"
        );
    }
}
