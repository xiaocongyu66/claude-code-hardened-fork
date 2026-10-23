//! Background task panel: one row per task, running tasks first.

use cch_tui_proto::{EngineEvent, Extra};
use cch_tui_ui::{Row, RowStyle};
use serde_json::Value;

use crate::common::{
    duration_ms, first_string, string_field, truncate_line, u64_field, value_text,
};

/// Default number of task rows shown before folding.
pub const DEFAULT_MAX_VISIBLE: usize = 5;

/// What spawned the background task.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum TaskKind {
    Bash,
    Agent,
    Workflow,
    #[default]
    Other,
}

impl TaskKind {
    /// Map the engine's `task_type` (e.g. `local_bash`, `local_agent`,
    /// `local_workflow`) onto a panel kind. Unknown values are `Other`.
    pub fn from_task_type(task_type: &str) -> Self {
        let lowered = task_type.to_ascii_lowercase();
        if lowered.contains("bash") {
            Self::Bash
        } else if lowered.contains("agent") || lowered.contains("teammate") {
            Self::Agent
        } else if lowered.contains("workflow") {
            Self::Workflow
        } else {
            Self::Other
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::Bash => "bash",
            Self::Agent => "agent",
            Self::Workflow => "workflow",
            Self::Other => "task",
        }
    }
}

/// Lifecycle state of a background task.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum TaskStatus {
    Pending,
    #[default]
    Running,
    Completed,
    Failed,
    Killed,
}

impl TaskStatus {
    /// Parse the engine's status string. `stopped` (and cancellation
    /// synonyms) maps to [`TaskStatus::Killed`].
    pub fn from_status(status: &str) -> Option<Self> {
        match status.to_ascii_lowercase().as_str() {
            "pending" | "queued" | "waiting" => Some(Self::Pending),
            "running" | "in_progress" | "started" | "active" => Some(Self::Running),
            "completed" | "complete" | "success" | "succeeded" | "done" => Some(Self::Completed),
            "failed" | "failure" | "error" => Some(Self::Failed),
            "killed" | "stopped" | "cancelled" | "canceled" | "aborted" | "interrupted" => {
                Some(Self::Killed)
            }
            _ => None,
        }
    }

    pub fn is_terminal(self) -> bool {
        matches!(self, Self::Completed | Self::Failed | Self::Killed)
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Running => "running",
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Killed => "killed",
        }
    }

    pub fn icon(self) -> &'static str {
        match self {
            Self::Pending => "○",
            Self::Running => "◐",
            Self::Completed => "✓",
            Self::Failed => "✗",
            Self::Killed => "⊘",
        }
    }

    /// Sort weight: running tasks first, then queued, then failures and
    /// finished work.
    fn rank(self) -> u8 {
        match self {
            Self::Running => 0,
            Self::Pending => 1,
            Self::Failed => 2,
            Self::Completed => 3,
            Self::Killed => 4,
        }
    }

    fn row_style(self) -> RowStyle {
        match self {
            Self::Failed => RowStyle::Error,
            Self::Running | Self::Pending => RowStyle::Tool,
            Self::Completed | Self::Killed => RowStyle::System,
        }
    }
}

impl std::fmt::Display for TaskStatus {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.label())
    }
}

/// One tracked background task or subagent.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskItem {
    pub id: String,
    pub kind: TaskKind,
    pub title: String,
    pub status: TaskStatus,
    pub started_at_ms: u64,
    /// Set once the task reaches a terminal state.
    pub finished_at_ms: Option<u64>,
    /// Last detail (summary, output or last tool) reported by the engine.
    pub detail: String,
}

impl TaskItem {
    /// Elapsed time in milliseconds, using `now_ms` while the task is live.
    pub fn elapsed_ms(&self, now_ms: u64) -> u64 {
        match self.finished_at_ms {
            Some(finished) => finished.saturating_sub(self.started_at_ms),
            None => now_ms.saturating_sub(self.started_at_ms),
        }
    }
}

/// Model behind the task / subagent panel.
#[derive(Debug, Clone, Default)]
pub struct TaskPanel {
    tasks: Vec<TaskItem>,
    /// Rows shown before collapsing the tail into `… +N more`.
    pub max_visible: usize,
    /// Caller-supplied clock used for elapsed time and synthetic start times.
    pub now_ms: u64,
}

impl TaskPanel {
    pub fn new() -> Self {
        Self {
            tasks: Vec::new(),
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

    pub fn tasks(&self) -> &[TaskItem] {
        &self.tasks
    }

    pub fn is_empty(&self) -> bool {
        self.tasks.is_empty()
    }

    pub fn len(&self) -> usize {
        self.tasks.len()
    }

    pub fn get(&self, id: &str) -> Option<&TaskItem> {
        self.tasks.iter().find(|task| task.id == id)
    }

    /// Fold one engine event into the panel. Returns whether anything changed.
    pub fn apply_engine_event(&mut self, event: &EngineEvent) -> bool {
        match event {
            EngineEvent::System { subtype, extra } => match subtype.as_str() {
                "task_started" => self.apply_task_payload(extra, PayloadPhase::Started),
                "task_progress" => self.apply_task_payload(extra, PayloadPhase::Progress),
                "task_notification" => self.apply_task_payload(extra, PayloadPhase::Notification),
                _ => false,
            },
            EngineEvent::Assistant { extra } => self.apply_assistant(extra),
            _ => false,
        }
    }

    /// One summary row per visible task (running first), then a fold row.
    pub fn rows(&self, width: usize) -> Vec<Row> {
        let ordered = self.ordered();
        let visible = self.max_visible.min(ordered.len());
        let mut rows = Vec::with_capacity(visible + 1);
        for task in ordered.iter().take(visible) {
            rows.push(Row::new(
                task.status.row_style(),
                truncate_line(&self.row_text(task), width),
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

    /// Compact status bar text such as `2 running · 1 failed`.
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
                .tasks
                .iter()
                .filter(|task| task.status == status)
                .count();
            if count > 0 {
                parts.push(format!("{count} {status}"));
            }
        }
        parts.join(" · ")
    }

    fn row_text(&self, task: &TaskItem) -> String {
        format!(
            "{} {} · {} · {}",
            task.status.icon(),
            task.title,
            task.status.label(),
            format_elapsed(task.elapsed_ms(self.now_ms))
        )
    }

    fn ordered(&self) -> Vec<&TaskItem> {
        let mut tasks: Vec<&TaskItem> = self.tasks.iter().collect();
        tasks.sort_by(|left, right| {
            left.status
                .rank()
                .cmp(&right.status.rank())
                .then_with(|| right.started_at_ms.cmp(&left.started_at_ms))
                .then_with(|| left.id.cmp(&right.id))
        });
        tasks
    }

    fn apply_assistant(&mut self, extra: &Extra) -> bool {
        let mut changed = false;
        if extra.contains_key("task_id") {
            changed |= self.apply_task_payload(extra, phase_for(extra));
        }
        let Some(message) = extra.get("message") else {
            return changed;
        };
        let Some(Value::Array(blocks)) = message.get("content") else {
            return changed;
        };
        for block in blocks {
            let Some(object) = block.as_object() else {
                continue;
            };
            let block_type = object
                .get("type")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if block_type == "tool_use" && is_agent_tool(object) {
                changed |= self.record_agent_tool(object);
            } else if block_type == "tool_result" {
                changed |= self.record_tool_result(object);
            } else if block_type.starts_with("task_") {
                let phase = if block_type == "task_notification" {
                    PayloadPhase::Notification
                } else {
                    phase_for(object)
                };
                changed |= self.apply_task_payload(object, phase);
            } else if object.contains_key("task_id") {
                changed |= self.apply_task_payload(object, phase_for(object));
            }
        }
        changed
    }

    /// An `Agent` tool call announces a subagent before any `task_*` frame.
    fn record_agent_tool(&mut self, block: &Extra) -> bool {
        let Some(id) = string_field(block, "id") else {
            return false;
        };
        let input = block.get("input").and_then(Value::as_object);
        let title = input
            .and_then(|input| first_string(input, &["description", "subagent_type", "name"]))
            .unwrap_or_else(|| "subagent".to_string());
        let detail = input
            .and_then(|input| first_string(input, &["description", "prompt", "subagent_type"]))
            .unwrap_or_default();
        let task = TaskItem {
            id: id.to_string(),
            kind: TaskKind::Agent,
            title,
            status: TaskStatus::Running,
            started_at_ms: self.now_ms,
            finished_at_ms: None,
            detail,
        };
        self.upsert(id, task);
        true
    }

    /// A tool result closes the subagent started by the matching tool call.
    fn record_tool_result(&mut self, block: &Extra) -> bool {
        let Some(id) = string_field(block, "tool_use_id") else {
            return false;
        };
        let Some(index) = self.tasks.iter().position(|task| task.id == id) else {
            return false;
        };
        let failed = block.get("is_error").and_then(Value::as_bool) == Some(true);
        let detail = block.get("content").and_then(value_text);
        let task = &mut self.tasks[index];
        task.status = if failed {
            TaskStatus::Failed
        } else {
            TaskStatus::Completed
        };
        task.finished_at_ms = Some(self.now_ms);
        if let Some(detail) = detail {
            task.detail = detail;
        }
        true
    }

    fn apply_task_payload(&mut self, payload: &Extra, phase: PayloadPhase) -> bool {
        let Some(id) = first_string(payload, &["task_id", "id", "tool_use_id"]) else {
            return false;
        };
        let kind_hint = string_field(payload, "task_type").map(TaskKind::from_task_type);
        let title = first_string(payload, &["description", "summary", "workflow_name"]);
        let detail = first_string(
            payload,
            &[
                "output",
                "summary",
                "last_tool_name",
                "message",
                "output_file",
            ],
        )
        .or_else(|| payload.get("output").and_then(value_text));
        let parsed_status = string_field(payload, "status").and_then(TaskStatus::from_status);
        let duration = duration_ms(payload);

        if let Some(index) = self.tasks.iter().position(|task| task.id == id) {
            let task = &mut self.tasks[index];
            if let Some(kind) = kind_hint {
                task.kind = kind;
            }
            if let Some(title) = title.filter(|title| !title.is_empty()) {
                task.title = title;
            }
            if let Some(detail) = detail.filter(|detail| !detail.is_empty()) {
                task.detail = detail;
            }
            task.status = match phase {
                PayloadPhase::Started => parsed_status.unwrap_or(TaskStatus::Running),
                // A stale progress frame must not reopen a finished task.
                PayloadPhase::Progress => {
                    if task.status.is_terminal() {
                        task.status
                    } else {
                        parsed_status.unwrap_or(TaskStatus::Running)
                    }
                }
                PayloadPhase::Notification => {
                    terminal_status(parsed_status.unwrap_or(TaskStatus::Completed))
                }
            };
            if task.started_at_ms == 0 {
                task.started_at_ms = self.now_ms.saturating_sub(duration.unwrap_or(0));
            }
            if task.status.is_terminal() {
                task.finished_at_ms.get_or_insert(self.now_ms);
            } else {
                task.finished_at_ms = None;
            }
        } else {
            let status = match phase {
                PayloadPhase::Started => parsed_status.unwrap_or(TaskStatus::Running),
                PayloadPhase::Progress => parsed_status.unwrap_or(TaskStatus::Running),
                PayloadPhase::Notification => {
                    terminal_status(parsed_status.unwrap_or(TaskStatus::Completed))
                }
            };
            let started_at_ms = u64_field(payload, "started_at_ms")
                .unwrap_or_else(|| self.now_ms.saturating_sub(duration.unwrap_or(0)));
            let task = TaskItem {
                id,
                kind: kind_hint.unwrap_or_default(),
                title: title.unwrap_or_else(|| "task".to_string()),
                status,
                started_at_ms,
                finished_at_ms: status.is_terminal().then_some(self.now_ms),
                detail: detail.unwrap_or_default(),
            };
            self.tasks.push(task);
        }
        true
    }

    fn upsert(&mut self, id: &str, task: TaskItem) {
        if let Some(index) = self.tasks.iter().position(|existing| existing.id == id) {
            self.tasks[index] = task;
        } else {
            self.tasks.push(task);
        }
    }
}

/// Which SDK task frame produced a payload.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PayloadPhase {
    Started,
    Progress,
    Notification,
}

fn phase_for(payload: &Extra) -> PayloadPhase {
    match string_field(payload, "status").and_then(TaskStatus::from_status) {
        Some(status) if status.is_terminal() => PayloadPhase::Notification,
        _ => PayloadPhase::Progress,
    }
}

/// Notifications only describe terminal states; anything else is completed.
fn terminal_status(status: TaskStatus) -> TaskStatus {
    if status.is_terminal() {
        status
    } else {
        TaskStatus::Completed
    }
}

fn is_agent_tool(block: &Extra) -> bool {
    matches!(
        string_field(block, "name"),
        Some("Agent" | "Task" | "agent" | "task")
    )
}

/// Human-readable elapsed time: `250ms`, `1.5s`, `1m05s`, `2h03m`.
pub fn format_elapsed(ms: u64) -> String {
    if ms < 1_000 {
        return format!("{ms}ms");
    }
    if ms < 60_000 {
        let tenths = ms / 100;
        let whole = tenths / 10;
        let fraction = tenths % 10;
        return if fraction == 0 {
            format!("{whole}s")
        } else {
            format!("{whole}.{fraction}s")
        };
    }
    if ms < 3_600_000 {
        let seconds = ms / 1_000;
        return format!("{}m{:02}s", seconds / 60, seconds % 60);
    }
    let minutes = ms / 60_000;
    format!("{}h{:02}m", minutes / 60, minutes % 60)
}

#[cfg(test)]
mod tests {
    use super::*;
    use cch_tui_proto::parse_line;

    fn event(line: &str) -> EngineEvent {
        parse_line(line).expect("valid frame")
    }

    fn panel_at(now_ms: u64) -> TaskPanel {
        let mut panel = TaskPanel::new();
        panel.now_ms = now_ms;
        panel
    }

    #[test]
    fn task_started_creates_a_running_task() {
        let mut panel = panel_at(1_000);
        assert!(panel.apply_engine_event(&event(
            r#"{"type":"system","subtype":"task_started","task_id":"t1","description":"run tests","task_type":"local_bash","prompt":"cargo test"}"#
        )));

        let task = panel.get("t1").expect("task");
        assert_eq!(task.kind, TaskKind::Bash);
        assert_eq!(task.title, "run tests");
        assert_eq!(task.status, TaskStatus::Running);
        assert_eq!(task.started_at_ms, 1_000);
        assert_eq!(task.finished_at_ms, None);
        assert_eq!(panel.len(), 1);
    }

    #[test]
    fn task_progress_updates_detail_and_keeps_running() {
        let mut panel = panel_at(2_000);
        panel.apply_engine_event(&event(
            r#"{"type":"system","subtype":"task_started","task_id":"t1","description":"agent run","task_type":"local_agent"}"#,
        ));
        panel.apply_engine_event(&event(
            r#"{"type":"system","subtype":"task_progress","task_id":"t1","summary":"editing src/lib.rs","usage":{"duration_ms":1500},"last_tool_name":"Edit"}"#,
        ));

        panel.now_ms = 3_000;
        let task = panel.get("t1").expect("task");
        assert_eq!(task.kind, TaskKind::Agent);
        assert_eq!(task.status, TaskStatus::Running);
        assert_eq!(task.detail, "editing src/lib.rs");
        assert_eq!(task.elapsed_ms(panel.now_ms), 1_000);
    }

    #[test]
    fn notification_sets_terminal_state_and_finish_time() {
        let mut panel = panel_at(1_000);
        panel.apply_engine_event(&event(
            r#"{"type":"system","subtype":"task_started","task_id":"t1","description":"run tests","task_type":"local_bash"}"#,
        ));
        panel.now_ms = 5_000;
        panel.apply_engine_event(&event(
            r#"{"type":"system","subtype":"task_notification","task_id":"t1","status":"completed","summary":"42 passed","output_file":"/tmp/out"}"#,
        ));

        let task = panel.get("t1").expect("task");
        assert_eq!(task.status, TaskStatus::Completed);
        assert_eq!(task.finished_at_ms, Some(5_000));
        assert_eq!(task.detail, "42 passed");
        assert_eq!(task.elapsed_ms(99_999), 4_000);
    }

    #[test]
    fn notification_status_mapping_covers_failed_and_stopped() {
        let mut panel = panel_at(100);
        panel.apply_engine_event(&event(
            r#"{"type":"system","subtype":"task_started","task_id":"a","description":"a"}"#,
        ));
        panel.apply_engine_event(&event(
            r#"{"type":"system","subtype":"task_started","task_id":"b","description":"b"}"#,
        ));
        panel.apply_engine_event(&event(
            r#"{"type":"system","subtype":"task_notification","task_id":"a","status":"failed"}"#,
        ));
        panel.apply_engine_event(&event(
            r#"{"type":"system","subtype":"task_notification","task_id":"b","status":"stopped"}"#,
        ));

        assert_eq!(panel.get("a").unwrap().status, TaskStatus::Failed);
        assert_eq!(panel.get("b").unwrap().status, TaskStatus::Killed);
    }

    #[test]
    fn stale_progress_does_not_reopen_a_finished_task() {
        let mut panel = panel_at(10);
        panel.apply_engine_event(&event(
            r#"{"type":"system","subtype":"task_notification","task_id":"t1","status":"completed","summary":"done"}"#,
        ));
        panel.apply_engine_event(&event(
            r#"{"type":"system","subtype":"task_progress","task_id":"t1","summary":"late packet"}"#,
        ));

        let task = panel.get("t1").unwrap();
        assert_eq!(task.status, TaskStatus::Completed);
        assert_eq!(task.detail, "late packet");
    }

    #[test]
    fn elapsed_formats_each_magnitude() {
        assert_eq!(format_elapsed(0), "0ms");
        assert_eq!(format_elapsed(250), "250ms");
        assert_eq!(format_elapsed(1_000), "1s");
        assert_eq!(format_elapsed(1_500), "1.5s");
        assert_eq!(format_elapsed(59_900), "59.9s");
        assert_eq!(format_elapsed(60_000), "1m00s");
        assert_eq!(format_elapsed(65_000), "1m05s");
        assert_eq!(format_elapsed(3_600_000), "1h00m");
        assert_eq!(format_elapsed(3_661_000), "1h01m");
    }

    #[test]
    fn rows_sort_running_first_and_fold_the_tail() {
        let mut panel = TaskPanel::with_max_visible(2);
        panel.now_ms = 100;
        panel.apply_engine_event(&event(
            r#"{"type":"system","subtype":"task_notification","task_id":"done","status":"completed","description":"finished"}"#,
        ));
        panel.apply_engine_event(&event(
            r#"{"type":"system","subtype":"task_started","task_id":"run","description":"working"}"#,
        ));
        panel.apply_engine_event(&event(
            r#"{"type":"system","subtype":"task_notification","task_id":"bad","status":"failed","description":"broke"}"#,
        ));

        let rows = panel.rows(80);
        assert_eq!(rows.len(), 3, "{rows:?}");
        assert!(rows[0].text.contains("working"), "{:?}", rows[0].text);
        assert!(rows[1].text.contains("broke"), "{:?}", rows[1].text);
        assert_eq!(rows[2].style, RowStyle::System);
        assert!(rows[2].text.contains("+1 more"), "{:?}", rows[2].text);
    }

    #[test]
    fn rows_show_icon_title_status_and_elapsed() {
        let mut panel = panel_at(2_500);
        panel.apply_engine_event(&event(
            r#"{"type":"system","subtype":"task_started","task_id":"t1","description":"sleep","task_type":"local_bash"}"#,
        ));
        panel.now_ms = 5_000;
        let rows = panel.rows(80);
        assert_eq!(rows.len(), 1);
        assert!(rows[0].text.starts_with("◐ sleep"), "{:?}", rows[0].text);
        assert!(rows[0].text.contains("running"));
        assert!(rows[0].text.contains("2.5s"));
        assert_eq!(rows[0].style, RowStyle::Tool);
    }

    #[test]
    fn rows_truncate_to_width() {
        let mut panel = panel_at(0);
        panel.apply_engine_event(&event(
            r#"{"type":"system","subtype":"task_started","task_id":"t1","description":"a very long task title indeed","task_type":"local_bash"}"#,
        ));
        let rows = panel.rows(12);
        assert_eq!(rows.len(), 1);
        assert!(rows[0].text.ends_with('…'), "{:?}", rows[0].text);
        assert_eq!(cch_tui_ui::wrap_text(&rows[0].text, 12).len(), 1);
    }

    #[test]
    fn summary_line_counts_by_status() {
        let mut panel = panel_at(0);
        for line in [
            r#"{"type":"system","subtype":"task_started","task_id":"a","description":"a"}"#,
            r#"{"type":"system","subtype":"task_started","task_id":"b","description":"b"}"#,
            r#"{"type":"system","subtype":"task_notification","task_id":"c","status":"failed","description":"c"}"#,
        ] {
            panel.apply_engine_event(&event(line));
        }
        assert_eq!(panel.summary_line(), "2 running · 1 failed");
    }

    #[test]
    fn empty_panel_has_no_rows_or_summary() {
        let panel = TaskPanel::new();
        assert!(panel.is_empty());
        assert!(panel.rows(80).is_empty());
        assert_eq!(panel.summary_line(), "");
    }

    #[test]
    fn unknown_fields_and_unrelated_events_are_tolerated() {
        let mut panel = panel_at(1);
        assert!(!panel.apply_engine_event(&event(
            r#"{"type":"system","subtype":"init","session_id":"s1"}"#
        )));
        assert!(!panel.apply_engine_event(&event(
            r#"{"type":"system","subtype":"task_started","description":"no id"}"#
        )));
        assert!(panel.apply_engine_event(&event(
            r#"{"type":"system","subtype":"task_started","task_id":"t1","description":"ok","future_field":{"nested":true},"task_type":"made_up"}"#
        )));
        assert_eq!(panel.get("t1").unwrap().kind, TaskKind::Other);

        // An unrelated task frame without an id changes nothing.
        assert!(!panel.apply_engine_event(&event(
            r#"{"type":"system","subtype":"task_progress","summary":"orphan"}"#
        )));
        assert_eq!(panel.len(), 1);
    }

    #[test]
    fn notification_without_start_uses_usage_duration() {
        let mut panel = panel_at(10_000);
        panel.apply_engine_event(&event(
            r#"{"type":"system","subtype":"task_notification","task_id":"t1","status":"completed","summary":"done","usage":{"duration_ms":4000}}"#,
        ));
        let task = panel.get("t1").unwrap();
        assert_eq!(task.started_at_ms, 6_000);
        assert_eq!(task.elapsed_ms(panel.now_ms), 4_000);
    }

    #[test]
    fn assistant_agent_tool_use_creates_a_subagent_task() {
        let mut panel = panel_at(500);
        assert!(panel.apply_engine_event(&event(
            r#"{"type":"assistant","uuid":"u1","message":{"role":"assistant","content":[{"type":"tool_use","id":"tu1","name":"Agent","input":{"description":"explore repo","subagent_type":"Explore","prompt":"look around"}}]}}"#
        )));
        let task = panel.get("tu1").expect("agent task");
        assert_eq!(task.kind, TaskKind::Agent);
        assert_eq!(task.title, "explore repo");
        assert_eq!(task.status, TaskStatus::Running);
        assert_eq!(task.detail, "explore repo");

        assert!(panel.apply_engine_event(&event(
            r#"{"type":"assistant","uuid":"u2","message":{"role":"assistant","content":[{"type":"tool_result","tool_use_id":"tu1","content":[{"type":"text","text":"found it"}],"is_error":false}]}}"#
        )));
        let task = panel.get("tu1").unwrap();
        assert_eq!(task.status, TaskStatus::Completed);
        assert_eq!(task.detail, "found it");
    }

    #[test]
    fn assistant_task_blocks_are_ingested() {
        let mut panel = panel_at(700);
        assert!(panel.apply_engine_event(&event(
            r#"{"type":"assistant","uuid":"u1","message":{"role":"assistant","content":[{"type":"task_progress","task_id":"t9","task_type":"local_workflow","description":"spec","summary":"phase 2"}]}}"#
        )));
        let task = panel.get("t9").expect("task");
        assert_eq!(task.kind, TaskKind::Workflow);
        assert_eq!(task.title, "spec");
        assert_eq!(task.detail, "phase 2");
        assert_eq!(task.status, TaskStatus::Running);
    }

    #[test]
    fn task_kind_and_status_parsing_are_tolerant() {
        assert_eq!(TaskKind::from_task_type("local_bash"), TaskKind::Bash);
        assert_eq!(TaskKind::from_task_type("remote_agent"), TaskKind::Agent);
        assert_eq!(
            TaskKind::from_task_type("in_process_teammate"),
            TaskKind::Agent
        );
        assert_eq!(
            TaskKind::from_task_type("local_workflow"),
            TaskKind::Workflow
        );
        assert_eq!(TaskKind::from_task_type("mystery"), TaskKind::Other);

        assert_eq!(TaskStatus::from_status("STOPPED"), Some(TaskStatus::Killed));
        assert_eq!(
            TaskStatus::from_status("in_progress"),
            Some(TaskStatus::Running)
        );
        assert_eq!(TaskStatus::from_status("nope"), None);
        assert!(TaskStatus::Failed.is_terminal());
        assert!(!TaskStatus::Running.is_terminal());
    }
}
