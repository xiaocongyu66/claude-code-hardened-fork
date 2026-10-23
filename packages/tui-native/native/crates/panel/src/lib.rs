//! Background task and subagent panel view models.
//!
//! Pure logic: the panels consume [`cch_tui_proto::EngineEvent`] values and
//! produce logical [`cch_tui_ui::Row`]s. No terminal, clock, or engine I/O is
//! performed here — the caller supplies the current time via `now_ms` and the
//! renderer paints the rows.
//!
//! * [`TaskPanel`] tracks background Bash tasks, subagents and workflows from
//!   `system:task_started` / `task_progress` / `task_notification` frames (and
//!   from `task_*` content in assistant messages).
//! * [`AgentPanel`] groups subagent activity by `agent_id` or
//!   `parent_tool_use_id` and keeps the latest output summary per agent.

#![forbid(unsafe_code)]

mod agent;
mod common;
mod task;

pub use agent::{AgentItem, AgentPanel};
pub use task::{TaskItem, TaskKind, TaskPanel, TaskStatus, format_elapsed};
