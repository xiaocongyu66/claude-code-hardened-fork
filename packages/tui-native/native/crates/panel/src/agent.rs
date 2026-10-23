//! Subagent panel: one row per agent, keyed by `agent_id` or
//! `parent_tool_use_id`, showing the latest output summary.

use cch_tui_proto::{EngineEvent, Extra};
use cch_tui_ui::{Row, RowStyle};
use serde_json::Value;

use crate::common::{first_string, short_id, string_field, truncate_line, value_text};
use crate::task::{TaskKind, TaskStatus};

/// Default number of agent rows shown before folding.
pub const DEFAULT_MAX_VISIBLE: usize = 5;

/// One subagent tracked by the panel.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentItem {
    /// Grouping key: `agent_id`, `parent_tool_use_id` or the task id.
    pub id: String,
    pub label: String,
    /// Free-form engine status (`running`, `completed`, ...).
    pub status: String,
    /// Last output summary observed for this agent.
    pub message: String,
    pub updated_at_ms: u64,
}

/// Model behind the subagent panel.
#[derive(Debug, Clone, Default)]
pub struct AgentPanel {
    agents: Vec<AgentItem>,
    /// Rows shown before collapsing the tail into `… +N more`.
    pub max_visible: usize,
    /// Caller-supplied clock used to order updates.
    pub now_ms: u64,
}

impl AgentPanel {
    pub fn new() -> Self {
        Self {
            agents: Vec::new(),
            max_visible: DEFAULT_MAX_VISIBLE,
            now_ms: 0,
        }
    }

    pub fn with_max_visible(max_visible: usize) -> Self {
        Self {
            max_visible,
            ..Self::new()
        }
    }

    pub fn agents(&self) -> &[AgentItem] {
        &self.agents
    }

    pub fn is_empty(&self) -> bool {
        self.agents.is_empty()
    }

    pub fn len(&self) -> usize {
        self.agents.len()
    }

    pub fn get(&self, agent_id: &str) -> Option<&AgentItem> {
        self.agents.iter().find(|agent| agent.id == agent_id)
    }

    /// Insert or update an agent by id. Empty label/status/message strings
    /// leave the existing value untouched.
    pub fn upsert_agent(
        &mut self,
        agent_id: impl Into<String>,
        label: impl Into<String>,
        status: impl Into<String>,
        message: impl Into<String>,
    ) {
        let label = label.into();
        let status = status.into();
        let message = message.into();
        let label = (!label.is_empty()).then_some(label);
        let status = (!status.is_empty()).then_some(status);
        let message = (!message.is_empty()).then_some(message);
        self.record(agent_id.into(), label, status, message);
    }

    /// Fold one engine event into the panel. Returns whether anything changed.
    pub fn apply_engine_event(&mut self, event: &EngineEvent) -> bool {
        match event {
            EngineEvent::Assistant { extra } => self.apply_assistant(extra),
            EngineEvent::System { subtype, extra } if subtype.starts_with("task_") => {
                self.apply_system_task(subtype, extra)
            }
            _ => false,
        }
    }

    /// One row per visible agent, newest activity first within each status.
    pub fn rows(&self, width: usize) -> Vec<Row> {
        let ordered = self.ordered();
        let visible = self.max_visible.min(ordered.len());
        let mut rows = Vec::with_capacity(visible + 1);
        for agent in ordered.iter().take(visible) {
            rows.push(Row::new(
                row_style(&agent.status),
                truncate_line(&row_text(agent), width),
            ));
        }
        let hidden = ordered.len() - visible;
        if hidden > 0 {
            rows.push(Row::new(
                RowStyle::System,
                truncate_line(&format!("… +{hidden} more"), width),
            ));
        }
        rows
    }

    /// Compact status bar text such as `2 running · 1 completed`.
    pub fn summary_line(&self) -> String {
        let mut parts = Vec::new();
        for status in [
            TaskStatus::Running,
            TaskStatus::Pending,
            TaskStatus::Failed,
            TaskStatus::Completed,
            TaskStatus::Killed,
        ] {
            let count = self
                .agents
                .iter()
                .filter(|agent| TaskStatus::from_status(&agent.status) == Some(status))
                .count();
            if count > 0 {
                parts.push(format!("{count} {status}"));
            }
        }
        if parts.is_empty() && !self.agents.is_empty() {
            let count = self.agents.len();
            parts.push(format!(
                "{count} agent{}",
                if count == 1 { "" } else { "s" }
            ));
        }
        parts.join(" · ")
    }

    fn apply_assistant(&mut self, extra: &Extra) -> bool {
        let message = extra.get("message");
        let message_map = message.and_then(Value::as_object);
        let agent_id = string_field(extra, "agent_id")
            .or_else(|| message_map.and_then(|map| string_field(map, "agent_id")));
        let parent_tool_use_id = string_field(extra, "parent_tool_use_id");
        let Some(id) = agent_id
            .map(ToOwned::to_owned)
            .or_else(|| parent_tool_use_id.map(ToOwned::to_owned))
        else {
            // Main-thread traffic (no agent grouping key).
            return false;
        };

        let label = string_field(extra, "agent_name")
            .or_else(|| string_field(extra, "agent_label"))
            .or_else(|| message_map.and_then(|map| string_field(map, "agent_name")));
        let failed = message.is_some_and(message_failed);
        let status = string_field(extra, "status")
            .and_then(TaskStatus::from_status)
            .map(|status| status.label().to_string())
            .or_else(|| failed.then(|| TaskStatus::Failed.label().to_string()))
            .unwrap_or_else(|| TaskStatus::Running.label().to_string());
        let summary = message.and_then(summarize_message);

        self.record(id, label.map(ToOwned::to_owned), Some(status), summary)
    }

    fn apply_system_task(&mut self, subtype: &str, extra: &Extra) -> bool {
        let task_type = string_field(extra, "task_type").map(TaskKind::from_task_type);
        let id = first_string(extra, &["task_id", "id", "agent_id", "parent_tool_use_id"]);
        let Some(id) = id else {
            return false;
        };
        let task_id = first_string(extra, &["task_id", "id"]);

        // Only agent-kind tasks (or ids already known to the panel) belong here;
        // shell tasks are left to the task panel.
        let known = task_id
            .as_deref()
            .and_then(|task_id| self.get(task_id))
            .is_some()
            || self.get(&id).is_some();
        let agentish = matches!(task_type, Some(TaskKind::Agent))
            || extra.contains_key("agent_id")
            || extra.contains_key("parent_tool_use_id");
        if !agentish && !known {
            return false;
        }

        let label = first_string(extra, &["description", "workflow_name"]);
        let status = match subtype {
            "task_notification" => string_field(extra, "status")
                .and_then(TaskStatus::from_status)
                .unwrap_or(TaskStatus::Completed),
            _ => string_field(extra, "status")
                .and_then(TaskStatus::from_status)
                .unwrap_or(TaskStatus::Running),
        };
        let summary = first_string(extra, &["output", "summary", "last_tool_name", "message"]);

        self.record(id, label, Some(status.label().to_string()), summary)
    }

    fn record(
        &mut self,
        id: String,
        label: Option<String>,
        status: Option<String>,
        message: Option<String>,
    ) -> bool {
        if let Some(agent) = self.agents.iter_mut().find(|agent| agent.id == id) {
            if let Some(label) = label {
                agent.label = label;
            }
            if let Some(status) = status {
                agent.status = status;
            }
            if let Some(message) = message {
                agent.message = message;
            }
            agent.updated_at_ms = self.now_ms;
        } else {
            let label = label.unwrap_or_else(|| format!("agent {}", short_id(&id)));
            let status = status.unwrap_or_else(|| TaskStatus::Running.label().to_string());
            self.agents.push(AgentItem {
                id,
                label,
                status,
                message: message.unwrap_or_default(),
                updated_at_ms: self.now_ms,
            });
        }
        true
    }

    fn ordered(&self) -> Vec<&AgentItem> {
        let mut agents: Vec<&AgentItem> = self.agents.iter().collect();
        agents.sort_by(|left, right| {
            status_rank(&left.status)
                .cmp(&status_rank(&right.status))
                .then_with(|| right.updated_at_ms.cmp(&left.updated_at_ms))
                .then_with(|| left.id.cmp(&right.id))
        });
        agents
    }
}

fn status_rank(status: &str) -> u8 {
    match TaskStatus::from_status(status) {
        Some(TaskStatus::Running) => 0,
        Some(TaskStatus::Pending) => 1,
        Some(TaskStatus::Failed) => 2,
        Some(TaskStatus::Completed) => 3,
        Some(TaskStatus::Killed) => 4,
        None => 5,
    }
}

fn row_style(status: &str) -> RowStyle {
    match TaskStatus::from_status(status) {
        Some(TaskStatus::Failed) => RowStyle::Error,
        Some(TaskStatus::Completed | TaskStatus::Killed) => RowStyle::System,
        Some(TaskStatus::Running | TaskStatus::Pending) => RowStyle::Tool,
        None => RowStyle::Tool,
    }
}

fn row_text(agent: &AgentItem) -> String {
    let icon = TaskStatus::from_status(&agent.status)
        .map(TaskStatus::icon)
        .unwrap_or("●");
    let mut text = format!("{icon} {} · {}", agent.label, agent.status);
    if !agent.message.is_empty() {
        text.push_str(" · ");
        text.push_str(&agent.message);
    }
    text
}

fn message_failed(message: &Value) -> bool {
    message
        .get("content")
        .and_then(Value::as_array)
        .is_some_and(|blocks| {
            blocks
                .iter()
                .any(|block| block.get("is_error").and_then(Value::as_bool) == Some(true))
        })
}

/// The last text/tool activity in a message, used as the agent row summary.
fn summarize_message(message: &Value) -> Option<String> {
    match message.get("content") {
        Some(Value::String(text)) if !text.is_empty() => Some(text.clone()),
        Some(Value::Array(blocks)) => {
            let mut summary = None;
            for block in blocks {
                match block.get("type").and_then(Value::as_str) {
                    Some("text") => {
                        if let Some(text) = block
                            .get("text")
                            .and_then(Value::as_str)
                            .filter(|text| !text.is_empty())
                        {
                            summary = Some(text.to_string());
                        }
                    }
                    Some("tool_use") => {
                        let name = block.get("name").and_then(Value::as_str).unwrap_or("tool");
                        summary = Some(format!("→ {name}"));
                    }
                    Some("tool_result") => {
                        let failed = block.get("is_error").and_then(Value::as_bool) == Some(true);
                        if let Some(text) = block.get("content").and_then(value_text) {
                            summary = Some(if failed { format!("✗ {text}") } else { text });
                        }
                    }
                    _ => {}
                }
            }
            summary
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use cch_tui_proto::parse_line;

    fn event(line: &str) -> EngineEvent {
        parse_line(line).expect("valid frame")
    }

    fn panel_at(now_ms: u64) -> AgentPanel {
        let mut panel = AgentPanel::new();
        panel.now_ms = now_ms;
        panel
    }

    #[test]
    fn groups_assistant_messages_by_parent_tool_use_id() {
        let mut panel = panel_at(10);
        panel.apply_engine_event(&event(
            r#"{"type":"assistant","uuid":"u1","parent_tool_use_id":"tu1","message":{"role":"assistant","content":[{"type":"text","text":"first"}]}}"#,
        ));
        panel.now_ms = 20;
        panel.apply_engine_event(&event(
            r#"{"type":"assistant","uuid":"u2","parent_tool_use_id":"tu1","message":{"role":"assistant","content":[{"type":"text","text":"second"}]}}"#,
        ));

        assert_eq!(panel.len(), 1);
        let agent = panel.get("tu1").expect("agent");
        assert_eq!(agent.message, "second");
        assert_eq!(agent.status, "running");
        assert_eq!(agent.updated_at_ms, 20);
    }

    #[test]
    fn agent_id_wins_over_parent_tool_use_id() {
        let mut panel = panel_at(0);
        panel.apply_engine_event(&event(
            r#"{"type":"assistant","uuid":"u1","agent_id":"a1","parent_tool_use_id":"tu1","agent_name":"Explore","message":{"role":"assistant","content":[{"type":"text","text":"hi"}]}}"#,
        ));

        assert!(panel.get("a1").is_some());
        assert!(panel.get("tu1").is_none());
        assert_eq!(panel.get("a1").unwrap().label, "Explore");
    }

    #[test]
    fn upsert_agent_updates_in_place_and_ignores_empty_fields() {
        let mut panel = panel_at(5);
        panel.upsert_agent("a1", "Explore", "running", "searching");
        panel.now_ms = 9;
        panel.upsert_agent("a1", "", "completed", "found 3 files");

        let agent = panel.get("a1").unwrap();
        assert_eq!(agent.label, "Explore");
        assert_eq!(agent.status, "completed");
        assert_eq!(agent.message, "found 3 files");
        assert_eq!(agent.updated_at_ms, 9);
        assert_eq!(panel.len(), 1);
    }

    #[test]
    fn task_events_track_agent_kind_and_completion() {
        let mut panel = panel_at(100);
        assert!(panel.apply_engine_event(&event(
            r#"{"type":"system","subtype":"task_started","task_id":"t1","description":"explore","task_type":"local_agent"}"#
        )));
        assert!(panel.apply_engine_event(&event(
            r#"{"type":"system","subtype":"task_notification","task_id":"t1","status":"completed","summary":"all done"}"#
        )));

        let agent = panel.get("t1").expect("agent");
        assert_eq!(agent.label, "explore");
        assert_eq!(agent.status, "completed");
        assert_eq!(agent.message, "all done");
        assert_eq!(panel.len(), 1);
    }

    #[test]
    fn shell_tasks_are_not_agents() {
        let mut panel = panel_at(0);
        assert!(!panel.apply_engine_event(&event(
            r#"{"type":"system","subtype":"task_started","task_id":"sh1","description":"ls","task_type":"local_bash"}"#
        )));
        assert!(panel.is_empty());
    }

    #[test]
    fn failed_tool_result_marks_the_agent_failed() {
        let mut panel = panel_at(0);
        panel.apply_engine_event(&event(
            r#"{"type":"assistant","uuid":"u1","parent_tool_use_id":"tu1","message":{"role":"assistant","content":[{"type":"tool_result","tool_use_id":"tu1","content":[{"type":"text","text":"boom"}],"is_error":true}]}}"#,
        ));

        let agent = panel.get("tu1").unwrap();
        assert_eq!(agent.status, "failed");
        assert_eq!(agent.message, "✗ boom");
    }

    #[test]
    fn main_thread_messages_without_grouping_key_are_ignored() {
        let mut panel = panel_at(0);
        assert!(!panel.apply_engine_event(&event(
            r#"{"type":"assistant","uuid":"u1","parent_tool_use_id":null,"message":{"role":"assistant","content":[{"type":"text","text":"main"}]}}"#,
        )));
        assert!(panel.is_empty());
    }

    #[test]
    fn rows_show_last_summary_running_first_and_fold() {
        let mut panel = AgentPanel::with_max_visible(2);
        panel.now_ms = 10;
        panel.upsert_agent("done", "Reviewer", "completed", "approved");
        panel.now_ms = 20;
        panel.upsert_agent("run", "Explorer", "running", "reading files");
        panel.now_ms = 30;
        panel.upsert_agent("fail", "Tester", "failed", "tests broke");

        let rows = panel.rows(80);
        assert_eq!(rows.len(), 3);
        assert!(rows[0].text.contains("Explorer"), "{:?}", rows[0].text);
        assert!(rows[0].text.contains("reading files"));
        assert!(rows[1].text.contains("Tester"), "{:?}", rows[1].text);
        assert_eq!(rows[2].style, RowStyle::System);
        assert!(rows[2].text.contains("+1 more"));
    }

    #[test]
    fn rows_are_truncated_to_width() {
        let mut panel = panel_at(0);
        panel.upsert_agent("a1", "Explore", "running", "a fairly long output summary");
        let rows = panel.rows(10);
        assert!(rows[0].text.ends_with('…'), "{:?}", rows[0].text);
        assert_eq!(cch_tui_ui::wrap_text(&rows[0].text, 10).len(), 1);
    }

    #[test]
    fn summary_line_counts_known_states() {
        let mut panel = panel_at(0);
        panel.upsert_agent("a", "A", "running", "");
        panel.upsert_agent("b", "B", "running", "");
        panel.upsert_agent("c", "C", "completed", "");
        assert_eq!(panel.summary_line(), "2 running · 1 completed");
    }

    #[test]
    fn empty_panel_has_no_rows_or_summary() {
        let panel = AgentPanel::new();
        assert!(panel.is_empty());
        assert!(panel.rows(80).is_empty());
        assert_eq!(panel.summary_line(), "");
    }

    #[test]
    fn unknown_system_subtypes_are_ignored() {
        let mut panel = panel_at(0);
        assert!(!panel.apply_engine_event(&event(
            r#"{"type":"system","subtype":"init","session_id":"s1"}"#
        )));
        assert!(panel.is_empty());
    }
}
