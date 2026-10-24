//! The interaction state machine: permission dialog + streaming + queue.

use cch_tui_keymap::Action;
use cch_tui_proto::ControlRequest;

use crate::permission::{PermissionDecision, PermissionDialog, PermissionOption};
use crate::queue::{Queue, QueuedInput};

/// The externally visible interaction phase.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default)]
pub enum InteractionPhase {
    /// No turn in flight and nothing queued.
    #[default]
    Idle,
    /// A turn is streaming from the engine.
    Streaming,
    /// The engine is blocked on a permission request.
    PermissionPending,
    /// No turn is running but input is waiting to be sent.
    Queueing,
}

/// Which global (non-prompt) actions every phase routes.
const GLOBAL_ACTIONS: &[Action] = &[
    Action::APP_INTERRUPT,
    Action::APP_EXIT,
    Action::APP_REDRAW,
    Action::APP_TOGGLE_TRANSCRIPT,
];

/// Navigation and confirmation inside a permission dialog.
const DIALOG_ACTIONS: &[Action] = &[
    Action::DIALOG_PREVIOUS,
    Action::DIALOG_NEXT,
    Action::DIALOG_CONFIRM,
    Action::DIALOG_DISMISS,
];

/// Prompt editing, submission, and history actions.
const PROMPT_ACTIONS: &[Action] = &[
    Action::PROMPT_SUBMIT,
    Action::PROMPT_SEND_NOW,
    Action::PROMPT_QUEUE_SUBMIT,
    Action::PROMPT_NEWLINE,
    Action::PROMPT_ESCAPE,
    Action::PROMPT_UNDO,
    Action::PROMPT_EXTERNAL_EDITOR,
    Action::PROMPT_STASH,
    Action::PROMPT_KILL_AGENTS,
    Action::EDIT_BACKSPACE,
    Action::EDIT_DELETE,
    Action::EDIT_LEFT,
    Action::EDIT_RIGHT,
    Action::EDIT_LINE_START,
    Action::EDIT_LINE_END,
    Action::EDIT_CHAR_BACKWARD,
    Action::EDIT_CHAR_FORWARD,
    Action::EDIT_KILL_TO_END,
    Action::EDIT_KILL_TO_START,
    Action::EDIT_KILL_WORD_BEFORE,
    Action::EDIT_YANK,
    Action::HISTORY_PREVIOUS,
    Action::HISTORY_NEXT,
    Action::HISTORY_SEARCH,
    Action::HISTORY_SEARCH_NEXT,
    Action::HISTORY_SEARCH_ACCEPT,
    Action::HISTORY_SEARCH_CANCEL,
    Action::HISTORY_SEARCH_EXECUTE,
];

/// How the prompt, queue, and permission dialog interact.
///
/// The phase is derived, never set directly, so every mutation stays
/// consistent: permission dialog > streaming turn > non-empty queue > idle.
/// See the crate docs for the transition diagram.
#[derive(Debug, Default)]
pub struct InteractionState {
    phase: InteractionPhase,
    streaming: bool,
    dialog: Option<PermissionDialog>,
    queue: Queue,
}

impl InteractionState {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn phase(&self) -> InteractionPhase {
        self.phase
    }

    pub fn queue(&self) -> &Queue {
        &self.queue
    }

    pub fn dialog(&self) -> Option<&PermissionDialog> {
        self.dialog.as_ref()
    }

    /// `true` while the engine is working on a turn.
    pub fn is_streaming(&self) -> bool {
        self.streaming
    }

    /// Append normal-priority input. Moves an idle machine to `Queueing`.
    pub fn enqueue(&mut self, text: impl Into<String>) {
        self.queue.enqueue(text);
        self.refresh();
    }

    /// Queue input that must go out as soon as the current turn ends,
    /// ahead of normal queued input.
    pub fn send_now(&mut self, text: impl Into<String>) {
        self.queue.send_now(text);
        self.refresh();
    }

    /// Push an input back to the head of its queue lane.
    pub fn backfill(&mut self, input: QueuedInput) {
        self.queue.backfill(input);
        self.refresh();
    }

    /// A turn started streaming.
    pub fn start_turn(&mut self) {
        self.streaming = true;
        self.refresh();
    }

    /// The current turn ended; queued input may now be sent.
    pub fn finish_turn(&mut self) {
        self.streaming = false;
        self.refresh();
    }

    /// `Esc` interrupted the current turn. The draft, when non-blank, is
    /// backfilled to the head of the normal lane so it is sent next.
    pub fn interrupt(&mut self, draft: impl Into<String>) {
        self.streaming = false;
        let draft = draft.into();
        if !draft.trim().is_empty() {
            self.queue.backfill_text(draft);
        }
        self.refresh();
    }

    /// Pop the next input when the machine is ready to send one: no active
    /// turn and no permission dialog. Starting the turn flips the phase to
    /// `Streaming`.
    pub fn next_to_send(&mut self) -> Option<QueuedInput> {
        if self.streaming || self.dialog.is_some() {
            return None;
        }
        let input = self.queue.take_next()?;
        self.streaming = true;
        self.refresh();
        Some(input)
    }

    /// Open a permission dialog from a control request. Returns `false` when
    /// the request is not `can_use_tool` or a dialog is already open (the
    /// caller should resolve the current one first).
    pub fn permission_request(
        &mut self,
        request_id: impl Into<String>,
        request: &ControlRequest,
    ) -> bool {
        if self.dialog.is_some() {
            return false;
        }
        let Some(dialog) = PermissionDialog::from_request(request_id, request) else {
            return false;
        };
        self.dialog = Some(dialog);
        self.refresh();
        true
    }

    /// Confirm the highlighted permission option. Returns the decision once;
    /// late calls (after resolution, cancel, timeout, or engine cancellation)
    /// return `None` and leave the phase unchanged.
    pub fn resolve_permission(&mut self) -> Option<PermissionDecision> {
        let decision = self.dialog.as_mut()?.resolve()?;
        self.dialog = None;
        self.refresh();
        Some(decision)
    }

    /// User `Esc` in the permission dialog: deny, then close it.
    pub fn cancel_permission(&mut self) -> Option<PermissionDecision> {
        let decision = self.dialog.as_mut()?.cancel()?;
        self.dialog = None;
        self.refresh();
        Some(decision)
    }

    /// Engine sent `control_cancel_request` for `request_id`. Closes the
    /// matching dialog without producing a decision, so a late confirm is
    /// rejected. Returns `false` when the id does not match the open dialog.
    pub fn cancel_request(&mut self, request_id: &str) -> bool {
        let matches_open = self
            .dialog
            .as_ref()
            .is_some_and(|dialog| dialog.request_id() == request_id);
        if !matches_open {
            return false;
        }
        if let Some(mut dialog) = self.dialog.take() {
            dialog.cancel_from_engine();
        }
        self.refresh();
        true
    }

    /// Highlight the previous permission option, if a dialog is open.
    pub fn select_previous_permission(&mut self) -> Option<PermissionOption> {
        self.dialog.as_mut().map(PermissionDialog::select_previous)
    }

    /// Highlight the next permission option, if a dialog is open.
    pub fn select_next_permission(&mut self) -> Option<PermissionOption> {
        self.dialog.as_mut().map(PermissionDialog::select_next)
    }

    /// `true` when `action` should be routed in the current phase.
    ///
    /// - `PermissionPending`: dialog navigation/confirm/dismiss plus global
    ///   actions; prompt editing and submission are blocked.
    /// - `Idle`/`Streaming`/`Queueing`: prompt editing, submission, history,
    ///   and global actions. Submission during `Streaming` is what queues new
    ///   input in the first place.
    pub fn accepts(&self, action: Action) -> bool {
        if GLOBAL_ACTIONS.contains(&action) {
            return true;
        }
        match self.phase {
            InteractionPhase::PermissionPending => DIALOG_ACTIONS.contains(&action),
            InteractionPhase::Idle | InteractionPhase::Streaming | InteractionPhase::Queueing => {
                PROMPT_ACTIONS.contains(&action) || action == Action::APP_ESCAPE
            }
        }
    }

    fn refresh(&mut self) {
        self.phase = if self.dialog.is_some() {
            InteractionPhase::PermissionPending
        } else if self.streaming {
            InteractionPhase::Streaming
        } else if self.queue.is_empty() {
            InteractionPhase::Idle
        } else {
            InteractionPhase::Queueing
        };
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use cch_tui_proto::{CanUseToolRequest, Extra};
    use serde_json::json;

    fn can_use_tool() -> ControlRequest {
        ControlRequest::CanUseTool(Box::new(CanUseToolRequest {
            tool_name: "Bash".into(),
            input: Extra::from_iter([("command".into(), json!("ls"))]),
            tool_use_id: "tool-1".into(),
            permission_suggestions: None,
            blocked_path: None,
            decision_reason: None,
            title: None,
            display_name: None,
            agent_id: None,
            description: None,
        }))
    }

    #[test]
    fn starts_idle_and_streaming_round_trips() {
        let mut state = InteractionState::new();
        assert_eq!(state.phase(), InteractionPhase::Idle);

        state.start_turn();
        assert_eq!(state.phase(), InteractionPhase::Streaming);
        state.finish_turn();
        assert_eq!(state.phase(), InteractionPhase::Idle);
    }

    #[test]
    fn queue_drives_queueing_and_next_to_send_drives_streaming() {
        let mut state = InteractionState::new();
        state.enqueue("hello");
        assert_eq!(state.phase(), InteractionPhase::Queueing);
        assert_eq!(state.queue().len(), 1);

        let next = state.next_to_send().expect("queued input");
        assert_eq!(next.text, "hello");
        assert_eq!(state.phase(), InteractionPhase::Streaming);
        assert_eq!(state.next_to_send(), None, "a turn is already streaming");

        state.finish_turn();
        assert_eq!(state.phase(), InteractionPhase::Idle);
    }

    #[test]
    fn enqueue_during_streaming_stays_streaming_then_queueing() {
        let mut state = InteractionState::new();
        state.start_turn();
        state.enqueue("queued");
        assert_eq!(state.phase(), InteractionPhase::Streaming);

        state.finish_turn();
        assert_eq!(state.phase(), InteractionPhase::Queueing);
    }

    #[test]
    fn send_now_is_taken_before_normal_input() {
        let mut state = InteractionState::new();
        state.start_turn();
        state.enqueue("normal");
        state.send_now("now");
        state.finish_turn();

        assert_eq!(
            state.next_to_send().map(|input| input.text),
            Some("now".to_string())
        );
        state.finish_turn();
        assert_eq!(
            state.next_to_send().map(|input| input.text),
            Some("normal".to_string())
        );
    }

    #[test]
    fn interrupt_backfills_the_draft_at_the_head() {
        let mut state = InteractionState::new();
        state.start_turn();
        state.enqueue("already queued");
        state.interrupt("  interrupted draft  ");

        assert_eq!(state.phase(), InteractionPhase::Queueing);
        assert_eq!(state.queue().len(), 2);
        assert_eq!(
            state.queue().peek().map(|input| input.text.as_str()),
            Some("  interrupted draft  ")
        );
        assert_eq!(
            state.next_to_send().map(|input| input.text),
            Some("  interrupted draft  ".to_string())
        );
    }

    #[test]
    fn interrupt_does_not_backfill_blank_drafts() {
        let mut state = InteractionState::new();
        state.start_turn();
        state.interrupt("   \n");
        assert_eq!(state.phase(), InteractionPhase::Idle);
        assert!(state.queue().is_empty());
    }

    #[test]
    fn permission_dialog_round_trip_restores_the_underlying_phase() {
        let mut state = InteractionState::new();
        state.start_turn();
        assert!(state.permission_request("req-1", &can_use_tool()));
        assert_eq!(state.phase(), InteractionPhase::PermissionPending);
        assert!(!state.permission_request("req-2", &can_use_tool()));

        assert_eq!(state.select_next_permission(), Some(PermissionOption::Deny));
        let decision = state.resolve_permission().expect("decision");
        assert!(!decision.is_allow());
        assert_eq!(state.phase(), InteractionPhase::Streaming);
        assert_eq!(
            state.resolve_permission(),
            None,
            "only one terminal decision"
        );
    }

    #[test]
    fn permission_from_idle_returns_to_idle_or_queueing() {
        let mut state = InteractionState::new();
        state.enqueue("waiting");
        assert_eq!(state.phase(), InteractionPhase::Queueing);

        assert!(state.permission_request("req-1", &can_use_tool()));
        assert_eq!(state.phase(), InteractionPhase::PermissionPending);
        assert_eq!(
            state.cancel_permission(),
            Some(PermissionDecision::deny("Denied by user"))
        );
        assert_eq!(state.phase(), InteractionPhase::Queueing);
        assert_eq!(state.queue().len(), 1);

        state.finish_turn();
        assert_eq!(state.phase(), InteractionPhase::Queueing);
    }

    #[test]
    fn engine_cancel_rejects_a_late_confirmation() {
        let mut state = InteractionState::new();
        state.start_turn();
        state.permission_request("req-1", &can_use_tool());

        assert!(!state.cancel_request("other-id"));
        assert!(state.cancel_request("req-1"));
        assert_eq!(state.phase(), InteractionPhase::Streaming);
        assert_eq!(state.resolve_permission(), None);
        assert_eq!(state.cancel_permission(), None);
        assert!(!state.cancel_request("req-1"), "already closed");
    }

    #[test]
    fn queueing_items_do_not_send_while_a_dialog_is_open() {
        let mut state = InteractionState::new();
        state.enqueue("queued");
        state.permission_request("req-1", &can_use_tool());
        assert_eq!(state.next_to_send(), None, "permission gates the queue");

        state.resolve_permission();
        assert_eq!(
            state.next_to_send().map(|input| input.text),
            Some("queued".to_string())
        );
    }

    fn plan_request() -> ControlRequest {
        ControlRequest::CanUseTool(Box::new(CanUseToolRequest {
            tool_name: "ExitPlanMode".into(),
            input: Extra::from_iter([("plan".into(), json!("# Plan\n\n1. Ship it"))]),
            tool_use_id: "tool-plan".into(),
            permission_suggestions: Some(vec![json!({
                "type": "setMode",
                "mode": "acceptEdits",
                "destination": "session",
            })]),
            blocked_path: None,
            decision_reason: None,
            title: None,
            display_name: None,
            agent_id: None,
            description: None,
        }))
    }

    #[test]
    fn plan_approval_maps_each_row_to_an_engine_response() {
        // Row 0: approve and switch to acceptEdits.
        let mut state = InteractionState::new();
        state.start_turn();
        assert!(state.permission_request("plan-1", &plan_request()));
        let allow = state.resolve_permission().expect("auto-accept decision");
        assert!(allow.is_allow());
        let response = allow.to_response();
        assert_eq!(
            response.get("updatedPermissions"),
            Some(&json!([{
                "type": "setMode",
                "mode": "acceptEdits",
                "destination": "session",
            }]))
        );
        assert_eq!(state.phase(), InteractionPhase::Streaming);

        // Row 1: approve without a mode change.
        let mut manual = InteractionState::new();
        manual.start_turn();
        manual.permission_request("plan-2", &plan_request());
        manual.select_next_permission();
        let allow = manual.resolve_permission().expect("manual approve");
        assert!(allow.is_allow());
        assert_eq!(allow.to_response().get("updatedPermissions"), None);
        assert_eq!(manual.phase(), InteractionPhase::Streaming);

        // Row 2: reject and stay in plan mode.
        let mut keep = InteractionState::new();
        keep.start_turn();
        keep.permission_request("plan-3", &plan_request());
        keep.select_next_permission();
        keep.select_next_permission();
        let deny = keep.resolve_permission().expect("keep planning");
        assert!(!deny.is_allow());
        assert_eq!(
            deny.to_response(),
            json!({
                "behavior": "deny",
                "message": "User rejected the plan and kept planning",
            })
        );
        assert_eq!(keep.phase(), InteractionPhase::Streaming);
    }

    #[test]
    fn plan_escape_and_engine_cancel_do_not_hang() {
        // Esc produces one deny and restores the underlying phase.
        let mut state = InteractionState::new();
        state.start_turn();
        state.permission_request("plan-1", &plan_request());
        assert_eq!(
            state.cancel_permission(),
            Some(PermissionDecision::deny("Denied by user"))
        );
        assert_eq!(state.phase(), InteractionPhase::Streaming);
        assert_eq!(state.resolve_permission(), None);
        assert_eq!(state.cancel_permission(), None);

        // The engine cancelling the request closes the dialog without a
        // decision; a late Enter is rejected.
        let mut cancelled = InteractionState::new();
        cancelled.start_turn();
        cancelled.permission_request("plan-2", &plan_request());
        assert!(cancelled.cancel_request("plan-2"));
        assert_eq!(cancelled.phase(), InteractionPhase::Streaming);
        assert_eq!(cancelled.resolve_permission(), None);
        assert!(!cancelled.cancel_request("plan-2"));
    }

    #[test]
    fn non_permission_control_requests_do_not_open_a_dialog() {
        let mut state = InteractionState::new();
        assert!(!state.permission_request("req-1", &ControlRequest::Interrupt));
        assert_eq!(state.phase(), InteractionPhase::Idle);
    }

    #[test]
    fn action_matrix_matches_the_phase() {
        let prompt_actions = [
            Action::PROMPT_SUBMIT,
            Action::PROMPT_ESCAPE,
            Action::PROMPT_NEWLINE,
            Action::EDIT_BACKSPACE,
            Action::EDIT_LEFT,
            Action::HISTORY_PREVIOUS,
        ];
        let dialog_actions = [
            Action::DIALOG_PREVIOUS,
            Action::DIALOG_NEXT,
            Action::DIALOG_CONFIRM,
            Action::DIALOG_DISMISS,
        ];
        let globals = [
            Action::APP_INTERRUPT,
            Action::APP_EXIT,
            Action::APP_REDRAW,
            Action::APP_TOGGLE_TRANSCRIPT,
        ];

        let mut idle = InteractionState::new();
        assert_eq!(idle.phase(), InteractionPhase::Idle);
        for action in prompt_actions.iter().chain(globals.iter()) {
            assert!(idle.accepts(*action), "idle should accept {action}");
        }
        for action in dialog_actions {
            assert!(!idle.accepts(action), "idle should reject {action}");
        }

        idle.start_turn();
        assert_eq!(idle.phase(), InteractionPhase::Streaming);
        for action in prompt_actions.iter().chain(globals.iter()) {
            assert!(idle.accepts(*action), "streaming should accept {action}");
        }
        for action in dialog_actions {
            assert!(!idle.accepts(action), "streaming should reject {action}");
        }

        idle.finish_turn();
        idle.enqueue("later");
        assert_eq!(idle.phase(), InteractionPhase::Queueing);
        for action in prompt_actions.iter().chain(globals.iter()) {
            assert!(idle.accepts(*action), "queueing should accept {action}");
        }

        idle.permission_request("req-1", &can_use_tool());
        assert_eq!(idle.phase(), InteractionPhase::PermissionPending);
        for action in dialog_actions.iter().chain(globals.iter()) {
            assert!(idle.accepts(*action), "permission should accept {action}");
        }
        for action in prompt_actions {
            assert!(
                !idle.accepts(action),
                "permission should reject prompt action {action}"
            );
        }
        assert!(!idle.accepts(Action::APP_ESCAPE));
    }

    #[test]
    fn transition_matrix_is_consistent() {
        use InteractionPhase::{Idle, PermissionPending, Queueing, Streaming};

        // (setup description, phase after the mutation)
        let mut state = InteractionState::new();
        let mut seen = vec![(Idle, state.phase())];

        state.start_turn();
        seen.push((Streaming, state.phase()));
        state.permission_request("r1", &can_use_tool());
        seen.push((PermissionPending, state.phase()));
        state.resolve_permission();
        seen.push((Streaming, state.phase()));
        state.enqueue("a");
        seen.push((Streaming, state.phase()));
        state.finish_turn();
        seen.push((Queueing, state.phase()));
        state.next_to_send();
        seen.push((Streaming, state.phase()));
        state.interrupt("");
        seen.push((Idle, state.phase()));

        for (expected, actual) in seen {
            assert_eq!(expected, actual);
        }
    }
}
