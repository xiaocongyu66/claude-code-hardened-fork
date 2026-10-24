//! Domain view model: turns engine events into logical rows.
//!
//! No terminal or ratatui types here. The renderer wraps and paints these
//! rows; the binary decides which rows are frozen into scrollback.

use cch_tui_proto::EngineEvent;
use serde_json::Value;
use std::collections::HashMap;
use unicode_width::UnicodeWidthChar;

/// Visual role of a logical row; the renderer maps it to a palette token.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RowStyle {
    User,
    Assistant,
    System,
    Error,
    Tool,
    /// A tool invocation line (`name(args)`), rendered with the message bullet.
    ToolCall,
    /// A tool call whose result has not arrived yet (dim bullet).
    ToolCallPending,
    /// A tool call that ended in an error result (red bullet).
    ToolCallError,
    /// A tool result line, rendered with the `⎿` gutter.
    ToolResult,
    /// A de-emphasized system line (hook progress, rate limits, task
    /// notifications); painted with the theme's dim color.
    Hook,
    /// A warning-level system line (API retries); painted with the theme's
    /// error color at normal intensity.
    Warning,
    /// The per-message meta header (clock + model) that full-screen transcript
    /// mode right-aligns above assistant replies (`MessageRow.tsx:229-233`).
    /// Inline mode drops these rows.
    MessageMeta,
    /// Markdown heading, carrying its level (`1..=6`).
    Heading(u8),
    /// A logical row made up entirely of inline code.
    InlineCode,
    /// A fenced or indented code block, kept verbatim for the highlighter.
    CodeBlock,
    /// Content of an unordered or ordered list item (marker included).
    ListItem,
    /// Content of a blockquote (prefix included).
    Blockquote,
    /// A horizontal rule.
    Rule,
    /// Header row of a Markdown table.
    TableHeader,
    /// Body row or header separator of a Markdown table.
    TableRow,
    /// Diff hunk header (`@@ ... @@`).
    DiffHunk,
    /// Added line in a structured diff.
    DiffAdded,
    /// Removed line in a structured diff.
    DiffRemoved,
    /// Context line in a structured diff.
    DiffContext,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Row {
    pub style: RowStyle,
    pub text: String,
}

impl Row {
    pub fn new(style: RowStyle, text: impl Into<String>) -> Self {
        Self {
            style,
            text: text.into(),
        }
    }
}

/// Minimal view model the transcript consumes in M0/M1.
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

/// Everything the renderer needs for one frame.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct ChatView {
    pub session: SessionView,
    /// Text accumulated from `stream_event` deltas, not yet committed.
    pub live_text: String,
    /// Current input buffer.
    pub input: String,
    /// Rows already frozen into scrollback (kept for the headless renderer and
    /// tests; the interactive binary performs the `insert_before` itself).
    pub completed: Vec<Row>,
    /// Transient status, e.g. "waiting for permission".
    pub status: Option<String>,
    /// Vim mode indicator (`-- INSERT --` / `-- NORMAL --`), when enabled.
    pub vim_mode: Option<String>,
    /// One-line task/agent summary appended to the status line.
    pub panel_summary: Option<String>,
    /// Context-window usage in percent, when the engine reported it.
    pub context_percent: Option<f64>,
    /// Active message focus as `(index, total)`, both one-based. Shown on the
    /// status line while message actions are open.
    pub focus: Option<(usize, usize)>,
    /// Index into `completed` for each tool id, so a later tool_result can
    /// flip the call's bullet from pending to success/error.
    #[allow(clippy::type_complexity)]
    tool_rows: HashMap<String, usize>,
    /// True while a turn is in flight (drives the spinner).
    pub busy: bool,
    /// Monotonic tick used to pick a spinner frame.
    pub spinner_frame: usize,
    /// Prompts waiting for the current turn to finish.
    pub queued: usize,
}

impl ChatView {
    pub fn new() -> Self {
        Self::default()
    }

    /// Fold an event into the view. Returns rows that became complete and can
    /// be frozen into scrollback by the caller.
    pub fn ingest(&mut self, event: &EngineEvent) -> Vec<Row> {
        self.session.apply(event);
        match event {
            EngineEvent::System { subtype, extra } => system_rows(subtype, extra),
            EngineEvent::User { extra } => {
                let rows = match structured_diff_rows(extra.get("tool_use_result")) {
                    Some(diff_rows) => diff_rows,
                    None => message_rows(extra.get("message"), false),
                };
                self.resolve_tool_results(extra.get("message"));
                self.completed.extend(rows.clone());
                rows
            }
            EngineEvent::Assistant { extra } => {
                self.live_text.clear();
                let mut rows = message_rows(extra.get("message"), true);
                if let Some(meta) = message_meta_row(extra.get("message"), extra) {
                    rows.insert(0, meta);
                }
                self.record_tool_calls(extra.get("message"), &rows);
                self.completed.extend(rows.clone());
                rows
            }
            EngineEvent::StreamEvent { extra } => {
                if let Some(text) = delta_text(extra.get("event")) {
                    self.live_text.push_str(&text);
                }
                Vec::new()
            }
            EngineEvent::Result { extra } => {
                let mut rows = Vec::new();
                if !self.live_text.is_empty() {
                    rows.push(Row::new(RowStyle::Assistant, self.live_text.clone()));
                    self.live_text.clear();
                }
                if let Some(err) = string_field(extra, "error") {
                    rows.push(Row::new(RowStyle::Error, err));
                }
                self.completed.extend(rows.clone());
                rows
            }
            EngineEvent::ControlRequest { request, .. } => {
                self.status = Some(format!("permission: {} — y/n", request.subtype()));
                Vec::new()
            }
            EngineEvent::ControlResponse { .. } => {
                self.status = None;
                Vec::new()
            }
            EngineEvent::ControlCancelRequest { .. }
            | EngineEvent::KeepAlive
            | EngineEvent::Unknown => Vec::new(),
        }
    }

    /// Map `tool_use` ids to the transcript row indexes they produced.
    fn record_tool_calls(&mut self, message: Option<&Value>, rows: &[Row]) {
        let Some(blocks) = message
            .and_then(|message| message.get("content"))
            .and_then(Value::as_array)
        else {
            return;
        };
        let ids = blocks.iter().filter_map(|block| {
            (block.get("type")?.as_str()? == "tool_use")
                .then(|| block.get("id")?.as_str().map(ToOwned::to_owned))
                .flatten()
        });
        let base = self.completed.len();
        let mut row_index = 0usize;
        for id in ids {
            // Each tool_use block produced exactly one ToolCallPending row.
            while row_index < rows.len() && rows[row_index].style != RowStyle::ToolCallPending {
                row_index += 1;
            }
            if row_index == rows.len() {
                break;
            }
            self.tool_rows.insert(id, base + row_index);
            row_index += 1;
        }
    }

    /// Flip a tool call's bullet once its result arrives.
    fn resolve_tool_results(&mut self, message: Option<&Value>) {
        let Some(blocks) = message
            .and_then(|message| message.get("content"))
            .and_then(Value::as_array)
        else {
            return;
        };
        for block in blocks {
            if block.get("type").and_then(Value::as_str) != Some("tool_result") {
                continue;
            }
            let Some(id) = block.get("tool_use_id").and_then(Value::as_str) else {
                continue;
            };
            let Some(index) = self.tool_rows.get(id).copied() else {
                continue;
            };
            let failed = block.get("is_error").and_then(Value::as_bool) == Some(true);
            if let Some(row) = self.completed.get_mut(index) {
                row.style = if failed {
                    RowStyle::ToolCallError
                } else {
                    RowStyle::ToolCall
                };
            }
        }
    }

    /// Submit the current input buffer as a frozen user row.
    pub fn submit_input(&mut self) -> Option<Row> {
        let text = std::mem::take(&mut self.input);
        if text.trim().is_empty() {
            return None;
        }
        let row = Row::new(RowStyle::User, text);
        self.completed.push(row.clone());
        Some(row)
    }

    /// Status line content.
    ///
    /// A transient status, when present, replaces the model/session summary.
    /// The message focus and vim mode indicator are appended in both cases.
    pub fn status_line(&self) -> String {
        let mut line = if let Some(status) = &self.status {
            status.clone()
        } else {
            let model = self.session.model.as_deref().unwrap_or("unknown model");
            let session = self.session.session_id.as_deref().unwrap_or("-");
            let mut line = format!("{model} · session {session}");
            if let Some(percent) = self.context_percent {
                line.push_str(&format!(" · {percent:.0}% ctx"));
            }
            if let Some(summary) = &self.panel_summary
                && !summary.is_empty()
            {
                line.push_str(" · ");
                line.push_str(summary);
            }
            line
        };
        if let Some((index, total)) = self.focus {
            line.push_str(&format!(" · msg {index}/{total}"));
        }
        if let Some(vim) = &self.vim_mode {
            line.push_str(" · ");
            line.push_str(vim);
        }
        if self.queued > 0 {
            line.push_str(&format!(" · queued {}", self.queued));
        }
        if self.busy {
            // Matches getDefaultCharacters() + reverse sweep in the Ink app.
            const FRAMES: [&str; 12] = ["·", "✢", "✱", "✶", "✻", "✽", "✽", "✻", "✶", "✱", "✢", "·"];
            line = format!("{} {line}", FRAMES[self.spinner_frame % FRAMES.len()]);
        }
        line
    }
}

impl SessionView {
    /// Fold one engine event into the session counters. Unknown frames are
    /// ignored.
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

/// Rows for a `system` frame.
///
/// Mirrors the subtypes Ink renders through `SystemTextMessage` (compact
/// boundary, hook progress, API retries, rate limits and task notifications).
/// Anything else stays invisible.
fn system_rows(subtype: &str, extra: &serde_json::Map<String, Value>) -> Vec<Row> {
    match subtype {
        // Matches CompactBoundaryMessage in the Ink app.
        "compact_boundary" => vec![Row::new(
            RowStyle::System,
            "✻ Conversation compacted (ctrl+o for history)".to_string(),
        )],
        "hook_started" | "hook_progress" | "hook_response" => {
            vec![Row::new(RowStyle::Hook, hook_line(subtype, extra))]
        }
        "api_retry" => vec![Row::new(RowStyle::Warning, api_retry_line(extra))],
        "rate_limit_event" => vec![Row::new(RowStyle::Hook, rate_limit_line(extra))],
        "task_notification" => vec![Row::new(RowStyle::Hook, task_notification_line(extra))],
        _ => Vec::new(),
    }
}

/// `  ⎿  {hook_name} {status}` for the three hook lifecycle frames.
///
/// Older emitters may omit `hook_name` (fall back to `hook_event`) or the
/// output text; the status then describes the lifecycle phase instead.
fn hook_line(subtype: &str, extra: &serde_json::Map<String, Value>) -> String {
    let name = string_field(extra, "hook_name")
        .or_else(|| string_field(extra, "hook_event"))
        .unwrap_or_else(|| "hook".to_string());
    let status = match subtype {
        "hook_started" => "started".to_string(),
        "hook_progress" => first_output_line(extra).unwrap_or_else(|| "running".to_string()),
        _ => string_field(extra, "outcome")
            .or_else(|| first_output_line(extra))
            .unwrap_or_else(|| "done".to_string()),
    };
    format!("  ⎿  {name} {status}")
}

/// `API error · retrying in {n}s (attempt i/max)`.
fn api_retry_line(extra: &serde_json::Map<String, Value>) -> String {
    let attempt = extra.get("attempt").and_then(Value::as_u64).unwrap_or(0);
    let max = extra
        .get("max_retries")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let delay_ms = extra
        .get("retry_delay_ms")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let seconds = (delay_ms as f64 / 1000.0).round() as u64;
    format!("API error · retrying in {seconds}s (attempt {attempt}/{max})")
}

/// `Rate limit: {status}` plus the reset clock when the frame carries one.
///
/// The SDK nests the payload under `rate_limit_info`; a top-level `status` is
/// accepted too for older emitters.
fn rate_limit_line(extra: &serde_json::Map<String, Value>) -> String {
    let info = extra.get("rate_limit_info");
    let status = info
        .and_then(|info| info.get("status"))
        .or_else(|| extra.get("status"))
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    let mut line = format!("Rate limit: {status}");
    if let Some(clock) = info.and_then(reset_clock) {
        line.push_str(&format!(" · resets at {clock}"));
    }
    line
}

/// `✓ task {id} {status}`. The task panel keeps its own richer state; this is
/// only the transcript breadcrumb.
fn task_notification_line(extra: &serde_json::Map<String, Value>) -> String {
    let id = string_field(extra, "task_id").unwrap_or_else(|| "?".to_string());
    let status = string_field(extra, "status").unwrap_or_else(|| "unknown".to_string());
    format!("✓ task {id} {status}")
}

/// First non-empty line of the hook `output` field.
fn first_output_line(extra: &serde_json::Map<String, Value>) -> Option<String> {
    let output = string_field(extra, "output")?;
    output
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(ToOwned::to_owned)
}

/// Extract the reset clock from `rate_limit_info.resetsAt`, which the SDK
/// emits as epoch seconds but which may also arrive as an ISO string.
fn reset_clock(info: &Value) -> Option<String> {
    match info.get("resetsAt")? {
        Value::Number(number) => {
            let seconds = number
                .as_i64()
                .or_else(|| number.as_f64().map(|value| value as i64))?;
            Some(epoch_hhmm(seconds))
        }
        Value::String(timestamp) => utc_hhmm(timestamp),
        _ => None,
    }
}

/// UTC `HH:MM` for epoch seconds. Days are discarded: the label only shows the
/// time of day.
fn epoch_hhmm(seconds: i64) -> String {
    let seconds = seconds.rem_euclid(24 * 60 * 60);
    format!("{:02}:{:02}", seconds / 3600, (seconds % 3600) / 60)
}

/// The per-message meta header shown in full-screen transcript mode: the
/// local clock followed by the model name (`MessageRow.tsx:229-233`).
///
/// Ink only renders it for assistant messages that contain a text block and
/// carry a model. The SDK's `timestamp` is optional; when it is missing or
/// unparseable we fall back to the frame's arrival time, as the schema's
/// `timestamp` description instructs consumers to do.
fn message_meta_row(
    message: Option<&Value>,
    extra: &serde_json::Map<String, Value>,
) -> Option<Row> {
    let message = message?;
    let model = message.get("model").and_then(Value::as_str)?;
    let has_text = message
        .get("content")
        .and_then(Value::as_array)?
        .iter()
        .any(|block| block.get("type").and_then(Value::as_str) == Some("text"));
    if !has_text {
        return None;
    }
    let clock = extra
        .get("timestamp")
        .and_then(Value::as_str)
        .and_then(meta_clock)
        .unwrap_or_else(now_clock);
    Some(Row::new(RowStyle::MessageMeta, format!("{clock}  {model}")))
}

/// Format an RFC3339 timestamp like Ink's
/// `toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true })`:
/// two-digit hour, minutes, and an uppercase meridiem, in local time.
fn meta_clock(timestamp: &str) -> Option<String> {
    let parsed =
        time::OffsetDateTime::parse(timestamp, &time::format_description::well_known::Rfc3339)
            .ok()?;
    Some(clock_label(localize(parsed)))
}

/// Arrival-time fallback for frames without a usable timestamp.
fn now_clock() -> String {
    clock_label(localize(time::OffsetDateTime::now_utc()))
}

/// Convert to the process's local offset; UTC when the platform cannot report
/// one (`UtcOffset::current_local_offset` is documented to fail in some
/// sandboxes).
fn localize(instant: time::OffsetDateTime) -> time::OffsetDateTime {
    match time::UtcOffset::current_local_offset() {
        Ok(offset) => instant.to_offset(offset),
        Err(_) => instant,
    }
}

fn clock_label(instant: time::OffsetDateTime) -> String {
    let hour = instant.hour();
    let (hour, meridiem) = match hour {
        0 => (12, "AM"),
        1..=11 => (hour, "AM"),
        12 => (12, "PM"),
        _ => (hour - 12, "PM"),
    };
    format!("{hour:02}:{:02} {meridiem}", instant.minute())
}

/// Parse an ISO8601 timestamp into a `HH:MM` clock, converted to UTC.
///
/// Only the date is validated for shape (it is otherwise unused); the time of
/// day may include seconds and fractional seconds. Returns `None` for
/// malformed input so callers can drop the timestamp instead of corrupting
/// the row.
fn utc_hhmm(timestamp: &str) -> Option<String> {
    let (date, time) = timestamp
        .split_once('T')
        .or_else(|| timestamp.split_once(' '))?;
    let mut date_parts = date.split('-');
    let year = date_parts.next()?;
    let month = date_parts.next()?;
    let day = date_parts.next()?;
    if date_parts.next().is_some()
        || year.len() != 4
        || month.len() != 2
        || day.len() != 2
        || !year
            .chars()
            .chain(month.chars())
            .chain(day.chars())
            .all(|ch| ch.is_ascii_digit())
    {
        return None;
    }
    let month: u32 = month.parse().ok()?;
    let day: u32 = day.parse().ok()?;
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }

    let (clock, offset_minutes) = split_offset(time)?;
    // Fractional seconds are irrelevant to an HH:MM label.
    let clock = clock.split('.').next()?;
    let mut parts = clock.split(':');
    let hour = parts.next()?;
    let minute = parts.next()?;
    let seconds = parts.next();
    if parts.next().is_some()
        || hour.len() != 2
        || minute.len() != 2
        || !hour
            .chars()
            .chain(minute.chars())
            .all(|ch| ch.is_ascii_digit())
    {
        return None;
    }
    let hour: i64 = hour.parse().ok()?;
    let minute: i64 = minute.parse().ok()?;
    if hour > 23 || minute > 59 {
        return None;
    }
    if let Some(seconds) = seconds {
        if seconds.len() != 2 || !seconds.chars().all(|ch| ch.is_ascii_digit()) {
            return None;
        }
        if seconds.parse::<i64>().ok()? > 59 {
            return None;
        }
    }
    let total = (hour * 60 + minute - offset_minutes).rem_euclid(24 * 60);
    Some(format!("{:02}:{:02}", total / 60, total % 60))
}

/// Split a time of day from its UTC offset, returning `(clock, offset_minutes)`.
fn split_offset(time: &str) -> Option<(&str, i64)> {
    if let Some(clock) = time.strip_suffix('Z').or_else(|| time.strip_suffix('z')) {
        return Some((clock, 0));
    }
    let Some(index) = time.rfind(['+', '-']) else {
        return Some((time, 0));
    };
    let (clock, zone) = time.split_at(index);
    let sign = if zone.starts_with('-') { -1 } else { 1 };
    let zone = &zone[1..];
    let (hour_part, minute_part) = match zone.find(':') {
        Some(index) => (&zone[..index], &zone[index + 1..]),
        None if zone.len() == 2 => (zone, "00"),
        None if zone.len() == 4 => (&zone[..2], &zone[2..]),
        None => return None,
    };
    if hour_part.len() != 2
        || minute_part.len() != 2
        || !hour_part
            .chars()
            .chain(minute_part.chars())
            .all(|ch| ch.is_ascii_digit())
    {
        return None;
    }
    let hours: i64 = hour_part.parse().ok()?;
    let minutes: i64 = minute_part.parse().ok()?;
    if hours > 23 || minutes > 59 {
        return None;
    }
    Some((clock, sign * (hours * 60 + minutes)))
}

/// Render `tool_use_result.structuredPatch` (Edit/Write results) as diff rows.
///
/// Returns `None` when the tool result has no structured patch, so callers
/// fall back to the plain content rendering.
fn structured_diff_rows(result: Option<&Value>) -> Option<Vec<Row>> {
    let patch = result?.get("structuredPatch")?.as_array()?;
    if patch.is_empty() {
        return None;
    }
    let mut rows = Vec::new();
    for hunk in patch {
        let old_start = hunk.get("oldStart").and_then(Value::as_u64).unwrap_or(0);
        let old_lines = hunk.get("oldLines").and_then(Value::as_u64).unwrap_or(0);
        let new_start = hunk.get("newStart").and_then(Value::as_u64).unwrap_or(0);
        let new_lines = hunk.get("newLines").and_then(Value::as_u64).unwrap_or(0);
        rows.push(Row::new(
            RowStyle::DiffHunk,
            format!("@@ -{old_start},{old_lines} +{new_start},{new_lines} @@"),
        ));
        for line in hunk.get("lines")?.as_array()? {
            let Some(text) = line.as_str() else { continue };
            let style = match text.chars().next() {
                Some('+') => RowStyle::DiffAdded,
                Some('-') => RowStyle::DiffRemoved,
                _ => RowStyle::DiffContext,
            };
            rows.push(Row::new(style, text));
        }
    }
    Some(rows)
}

/// Turn an SDK message payload into transcript rows.
///
/// Text blocks become assistant/user prose; `tool_use` and `tool_result`
/// blocks become compact tool rows so the transcript shows what ran without
/// dumping full payloads.
fn message_rows(message: Option<&Value>, assistant: bool) -> Vec<Row> {
    let Some(message) = message else {
        return Vec::new();
    };
    match message.get("content") {
        Some(Value::String(text)) => text_rows(text, assistant),
        Some(Value::Array(blocks)) => blocks
            .iter()
            .flat_map(|block| block_rows(block, assistant))
            .collect(),
        _ => Vec::new(),
    }
}

fn text_rows(text: &str, assistant: bool) -> Vec<Row> {
    if assistant {
        if text.trim().is_empty() {
            return Vec::new();
        }
        // Kept as raw Markdown: the renderer adds the message bullet after
        // parsing so headings/lists keep their structure.
        return vec![Row::new(RowStyle::Assistant, text)];
    }
    // Ink renders a user prompt as a background block, not with a `>` prefix.
    text.lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| Row::new(RowStyle::User, line.to_string()))
        .collect()
}

fn block_rows(block: &Value, assistant: bool) -> Vec<Row> {
    match block.get("type").and_then(Value::as_str) {
        Some("text") => block
            .get("text")
            .and_then(Value::as_str)
            .map(|text| text_rows(text, assistant))
            .unwrap_or_default(),
        Some("tool_use") => {
            let name = block.get("name").and_then(Value::as_str).unwrap_or("tool");
            let summary = block
                .get("input")
                .map(|input| tool_call_summary(name, input))
                .unwrap_or_default();
            vec![Row::new(
                RowStyle::ToolCallPending,
                format!("{name}({summary})"),
            )]
        }
        Some("tool_result") => {
            let text = block
                .get("content")
                .map(tool_result_text)
                .unwrap_or_default();
            if text.is_empty() {
                vec![Row::new(RowStyle::ToolResult, "(no output)".to_string())]
            } else {
                text.lines()
                    .take(3)
                    .map(|line| Row::new(RowStyle::ToolResult, line.to_string()))
                    .collect()
            }
        }
        // Thinking/redacted blocks are not shown in the transcript.
        _ => Vec::new(),
    }
}

/// One-line description of a tool call's input.
///
/// Mirrors the intent of each tool's `renderToolUseMessage()` in the Ink app:
/// the interesting argument (command, path, pattern, url, ...) rather than the
/// whole JSON. Unknown tools fall back to a truncated compact payload.
fn tool_call_summary(name: &str, input: &Value) -> String {
    let field = |key: &str| input.get(key).and_then(Value::as_str);
    let detail = match name.to_ascii_lowercase().as_str() {
        "bash" | "powershell" | "shell" => field("command").map(ToOwned::to_owned),
        "read" | "write" | "edit" | "notebookedit" => field("file_path")
            .or_else(|| field("notebook_path"))
            .map(ToOwned::to_owned),
        "glob" | "grep" => field("pattern").map(ToOwned::to_owned),
        "webfetch" => field("url").map(ToOwned::to_owned),
        "websearch" => field("query").map(ToOwned::to_owned),
        "task" | "agent" => field("description")
            .or_else(|| field("prompt"))
            .map(ToOwned::to_owned),
        _ => None,
    };
    let raw = detail.unwrap_or_else(|| input.to_string());
    let compact = raw.replace('\n', " ");
    let mut summary: String = compact.chars().take(80).collect();
    if compact.chars().count() > 80 {
        summary.push('…');
    }
    summary
}

fn tool_result_text(content: &Value) -> String {
    match content {
        Value::String(text) => text.clone(),
        Value::Array(blocks) => blocks
            .iter()
            .filter_map(|block| block.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

fn string_field(extra: &serde_json::Map<String, Value>, key: &str) -> Option<String> {
    extra
        .get(key)
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
}

/// Extract a text delta from a raw stream event.
fn delta_text(event: Option<&Value>) -> Option<String> {
    let event = event?;
    match event.get("type")?.as_str()? {
        "content_block_delta" => {
            let delta = event.get("delta")?;
            match delta.get("type")?.as_str()? {
                "text_delta" => delta.get("text")?.as_str().map(ToOwned::to_owned),
                _ => None,
            }
        }
        _ => None,
    }
}

/// Wrap `text` to `width` display columns. Newlines force a break, tabs expand
/// to four spaces, and wide characters never overflow a line.
pub fn wrap_text(text: &str, width: usize) -> Vec<String> {
    if width == 0 {
        return Vec::new();
    }
    let mut rows = Vec::new();
    for logical_line in text.split('\n') {
        let expanded = logical_line.replace('\t', "    ");
        let mut current = String::new();
        let mut used = 0usize;
        for ch in expanded.chars() {
            let ch_width = ch.width().unwrap_or(0);
            if used + ch_width > width && used > 0 {
                rows.push(std::mem::take(&mut current));
                used = 0;
            }
            current.push(ch);
            used += ch_width;
        }
        rows.push(current);
    }
    rows
}

#[cfg(test)]
mod tests {
    use super::*;
    use cch_tui_proto::parse_line;

    #[test]
    fn folds_engine_events_into_the_session_view() {
        let mut view = ChatView::new();
        for line in [
            r#"{"type":"system","subtype":"init","session_id":"s1","model":"m1"}"#,
            r#"{"type":"user","uuid":"u1","message":{"role":"user","content":"hello"}}"#,
            r#"{"type":"assistant","uuid":"a1","message":{"role":"assistant","content":[{"type":"text","text":"hi"}]}}"#,
            r#"{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"more"}}}"#,
            r#"{"type":"control_request","request_id":"r1","request":{"subtype":"can_use_tool","tool_name":"Bash","tool_use_id":"t1"}}"#,
            r#"{"type":"control_response","response":{"subtype":"success","request_id":"r1"}}"#,
            r#"{"type":"result","subtype":"error","error":"boom"}"#,
        ] {
            view.ingest(&parse_line(line).expect("valid frame"));
        }

        assert_eq!(view.session.session_id.as_deref(), Some("s1"));
        assert_eq!(view.session.assistant_messages, 1);
        assert_eq!(view.session.pending_permissions, 0);
        assert_eq!(view.session.last_error.as_deref(), Some("boom"));
        assert!(view.completed.iter().any(|row| row.text == "hi"));
        assert!(view.completed.iter().any(|row| row.text == "hello"));
        // The result frame flushed the streamed text into a frozen row.
        assert!(view.completed.iter().any(|row| row.text == "more"));
        assert!(view.live_text.is_empty());
    }

    #[test]
    fn status_line_shows_spinner_and_queue_depth() {
        let mut view = ChatView::new();
        view.busy = true;
        view.spinner_frame = 0;
        view.queued = 2;
        let line = view.status_line();
        assert!(line.starts_with('·'), "{line}");
        assert!(line.contains("queued 2"), "{line}");
    }

    #[test]
    fn status_line_shows_context_percent() {
        let mut view = ChatView::new();
        view.context_percent = Some(42.4);
        assert!(
            view.status_line().contains("42% ctx"),
            "{}",
            view.status_line()
        );
    }

    #[test]
    fn status_line_includes_panel_summary() {
        let mut view = ChatView::new();
        view.panel_summary = Some("2 running".into());
        let line = view.status_line();
        assert!(line.ends_with("· 2 running"), "{line}");

        // An explicit transient status wins over the summary.
        view.status = Some("search: x (1/2)".into());
        assert_eq!(view.status_line(), "search: x (1/2)");
    }

    #[test]
    fn status_line_shows_the_message_focus() {
        let mut view = ChatView::new();
        view.focus = Some((2, 5));
        assert_eq!(view.status_line(), "unknown model · session - · msg 2/5");

        // A transient status keeps the focus suffix.
        view.status = Some("copied".into());
        assert_eq!(view.status_line(), "copied · msg 2/5");

        view.focus = None;
        assert_eq!(view.status_line(), "copied");
    }

    #[test]
    fn status_line_appends_the_vim_mode_indicator() {
        let mut view = ChatView::new();
        view.session.model = Some("m1".into());
        view.session.session_id = Some("s1".into());
        view.vim_mode = Some("-- INSERT --".into());
        assert_eq!(view.status_line(), "m1 · session s1 · -- INSERT --");

        view.status = Some("sent".into());
        assert_eq!(view.status_line(), "sent · -- INSERT --");

        view.vim_mode = Some("-- NORMAL --".into());
        assert_eq!(view.status_line(), "sent · -- NORMAL --");

        // Non-vim callers are unchanged.
        view.vim_mode = None;
        assert_eq!(view.status_line(), "sent");
    }

    #[test]
    fn tool_bullet_tracks_the_result_status() {
        let mut view = ChatView::new();
        view.ingest(
            &parse_line(
                r#"{"type":"assistant","uuid":"a1","message":{"role":"assistant","content":[{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"ls"}}]}}"#,
            )
            .unwrap(),
        );
        assert_eq!(view.completed[0].style, RowStyle::ToolCallPending);

        view.ingest(
            &parse_line(
                r#"{"type":"user","uuid":"u1","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"ok"}]}}"#,
            )
            .unwrap(),
        );
        assert_eq!(view.completed[0].style, RowStyle::ToolCall);

        view.ingest(
            &parse_line(
                r#"{"type":"assistant","uuid":"a2","message":{"role":"assistant","content":[{"type":"tool_use","id":"t2","name":"Bash","input":{}}]}}"#,
            )
            .unwrap(),
        );
        view.ingest(
            &parse_line(
                r#"{"type":"user","uuid":"u2","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t2","is_error":true,"content":"boom"}]}}"#,
            )
            .unwrap(),
        );
        let failed = view
            .completed
            .iter()
            .find(|row| row.text.starts_with("Bash(") && row.style == RowStyle::ToolCallError);
        assert!(failed.is_some(), "{:?}", view.completed);
    }

    #[test]
    fn tool_calls_and_results_become_compact_rows() {
        let mut view = ChatView::new();
        view.ingest(
            &parse_line(
                r#"{"type":"assistant","uuid":"a1","message":{"role":"assistant","content":[{"type":"text","text":"checking"},{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"ls -la"}}]}}"#,
            )
            .unwrap(),
        );

        let texts: Vec<&str> = view.completed.iter().map(|row| row.text.as_str()).collect();
        assert!(texts.contains(&"checking"), "{texts:?}");
        let call = texts
            .iter()
            .find(|text| text.starts_with("Bash("))
            .expect("tool row");
        assert!(call.contains("ls -la"), "{call}");

        view.ingest(
            &parse_line(
                r#"{"type":"user","uuid":"u1","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"a.txt\nb.txt\nc.txt\nd.txt"}]}}"#,
            )
            .unwrap(),
        );
        let results: Vec<&str> = view
            .completed
            .iter()
            .filter(|row| row.style == RowStyle::ToolResult)
            .map(|row| row.text.as_str())
            .collect();
        assert_eq!(
            results.len(),
            3,
            "results are capped at three lines: {results:?}"
        );
        assert_eq!(results[0], "a.txt");
    }

    #[test]
    fn structured_edit_results_render_as_diff_rows() {
        let mut view = ChatView::new();
        let rows = view.ingest(
            &parse_line(
                r#"{"type":"user","uuid":"u1","tool_use_result":{"structuredPatch":[{"oldStart":1,"oldLines":2,"newStart":1,"newLines":2,"lines":[" context","-old","+new"]}]},"message":{"role":"user","content":[]}}"#,
            )
            .unwrap(),
        );
        let styles: Vec<RowStyle> = rows.iter().map(|row| row.style).collect();
        assert_eq!(
            styles,
            vec![
                RowStyle::DiffHunk,
                RowStyle::DiffContext,
                RowStyle::DiffRemoved,
                RowStyle::DiffAdded,
            ]
        );
        assert!(rows[0].text.contains("@@ -1,2 +1,2 @@"), "{}", rows[0].text);
    }

    #[test]
    fn streamed_deltas_stay_live_until_the_message_or_result() {
        let mut view = ChatView::new();
        view.ingest(
            &parse_line(
                r#"{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"par"}}}"#,
            )
            .unwrap(),
        );
        assert_eq!(view.live_text, "par");
        assert!(view.completed.is_empty());

        view.ingest(
            &parse_line(
                r#"{"type":"assistant","uuid":"a1","message":{"role":"assistant","content":[{"type":"text","text":"partial done"}]}}"#,
            )
            .unwrap(),
        );
        assert!(view.live_text.is_empty());
        assert_eq!(view.completed.len(), 1);
    }

    #[test]
    fn submit_input_ignores_blank_and_freezes_text() {
        let mut view = ChatView::new();
        view.input = "   ".into();
        assert!(view.submit_input().is_none());
        view.input = "run tests".into();
        let row = view.submit_input().expect("row");
        assert_eq!(row.text, "run tests");
        assert!(view.input.is_empty());
    }

    #[test]
    fn wrap_respects_display_width_and_cjk() {
        let rows = wrap_text("abcdef", 4);
        assert_eq!(rows, ["abcd", "ef"]);

        let rows = wrap_text("汉字汉字", 4);
        assert_eq!(rows, ["汉字", "汉字"]);

        let rows = wrap_text("a\tb\nc", 8);
        assert_eq!(rows, ["a    b", "c"]);
    }

    #[test]
    fn markdown_row_styles_are_distinct() {
        assert_ne!(RowStyle::Heading(1), RowStyle::Heading(2));
        assert_ne!(RowStyle::InlineCode, RowStyle::CodeBlock);
        assert_ne!(RowStyle::ListItem, RowStyle::Blockquote);
        assert_ne!(RowStyle::Assistant, RowStyle::Rule);
    }

    #[test]
    fn hook_subtypes_become_dim_system_rows() {
        let mut view = ChatView::new();
        let started = view.ingest(
            &parse_line(
                r#"{"type":"system","subtype":"hook_started","hook_id":"h1","hook_name":"lint","hook_event":"PreToolUse"}"#,
            )
            .unwrap(),
        );
        assert_eq!(started.len(), 1);
        assert_eq!(started[0].style, RowStyle::Hook);
        assert_eq!(started[0].text, "  ⎿  lint started");

        let progress = view.ingest(
            &parse_line(
                r#"{"type":"system","subtype":"hook_progress","hook_id":"h1","hook_name":"lint","hook_event":"PreToolUse","output":"checking files\nmore"}"#,
            )
            .unwrap(),
        );
        assert_eq!(progress[0].style, RowStyle::Hook);
        assert_eq!(progress[0].text, "  ⎿  lint checking files");

        let response = view.ingest(
            &parse_line(
                r#"{"type":"system","subtype":"hook_response","hook_id":"h1","hook_name":"lint","hook_event":"PreToolUse","output":"","outcome":"error"}"#,
            )
            .unwrap(),
        );
        assert_eq!(response[0].text, "  ⎿  lint error");

        // `hook_name` may be absent; `hook_event` and the lifecycle phase fill
        // in. Empty progress output falls back to "running".
        let fallback = view.ingest(
            &parse_line(
                r#"{"type":"system","subtype":"hook_progress","hook_id":"h2","hook_event":"PostToolUse","output":""}"#,
            )
            .unwrap(),
        );
        assert_eq!(fallback[0].text, "  ⎿  PostToolUse running");
    }

    #[test]
    fn api_retry_becomes_a_warning_row() {
        let mut view = ChatView::new();
        let rows = view.ingest(
            &parse_line(
                r#"{"type":"system","subtype":"api_retry","attempt":2,"max_retries":4,"retry_delay_ms":1500,"error_status":529,"error":"server_error"}"#,
            )
            .unwrap(),
        );
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].style, RowStyle::Warning);
        assert_eq!(rows[0].text, "API error · retrying in 2s (attempt 2/4)");
    }

    #[test]
    fn rate_limit_includes_status_and_reset_clock() {
        let mut view = ChatView::new();
        let rows = view.ingest(
            &parse_line(
                r#"{"type":"system","subtype":"rate_limit_event","rate_limit_info":{"status":"rejected","resetsAt":1700000000}}"#,
            )
            .unwrap(),
        );
        assert_eq!(rows[0].style, RowStyle::Hook);
        assert_eq!(rows[0].text, "Rate limit: rejected · resets at 22:13");

        // Reset time is optional.
        let rows = view.ingest(
            &parse_line(
                r#"{"type":"system","subtype":"rate_limit_event","rate_limit_info":{"status":"allowed_warning"}}"#,
            )
            .unwrap(),
        );
        assert_eq!(rows[0].text, "Rate limit: allowed_warning");
    }

    #[test]
    fn task_notification_becomes_a_dim_breadcrumb() {
        let mut view = ChatView::new();
        let rows = view.ingest(
            &parse_line(
                r#"{"type":"system","subtype":"task_notification","task_id":"t42","status":"completed","output_file":"/tmp/o","summary":"done"}"#,
            )
            .unwrap(),
        );
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].style, RowStyle::Hook);
        assert_eq!(rows[0].text, "✓ task t42 completed");
    }

    #[test]
    fn unknown_system_subtypes_are_ignored() {
        let mut view = ChatView::new();
        for line in [
            r#"{"type":"system","subtype":"status","status":"compacting"}"#,
            r#"{"type":"system","subtype":"something_new","content":"nope"}"#,
        ] {
            assert!(view.ingest(&parse_line(line).unwrap()).is_empty());
        }
        assert!(view.completed.is_empty());
    }

    #[test]
    fn assistant_text_messages_get_a_meta_header() {
        let mut view = ChatView::new();
        let rows = view.ingest(
            &parse_line(
                r#"{"type":"assistant","timestamp":"2025-10-23T14:05:06.789Z","message":{"role":"assistant","model":"claude-test","content":[{"type":"text","text":"hello"}]}}"#,
            )
            .unwrap(),
        );
        assert_eq!(rows[0].style, RowStyle::MessageMeta);
        assert!(
            rows[0].text.ends_with("  claude-test"),
            "{:?}",
            rows[0].text
        );
        // `hh:mm AM` / `hh:mm PM`, like Ink's 12-hour en-US clock.
        let clock = &rows[0].text[..8];
        assert!(
            clock.as_bytes()[2] == b':' && (clock.ends_with("AM") || clock.ends_with("PM")),
            "clock should be hh:mm AM/PM: {clock:?}"
        );
        assert_eq!(rows[1].text, "hello");
    }

    #[test]
    fn meta_header_requires_an_assistant_text_block_with_a_model() {
        let mut view = ChatView::new();
        // User frames never get a header.
        let rows = view.ingest(
            &parse_line(
                r#"{"type":"user","timestamp":"2025-10-23T09:30:00Z","message":{"role":"user","content":"hi"}}"#,
            )
            .unwrap(),
        );
        assert!(rows.iter().all(|row| row.style != RowStyle::MessageMeta));

        // Neither do system breadcrumbs, even when they carry a timestamp.
        let rows = view.ingest(
            &parse_line(
                r#"{"type":"system","subtype":"hook_started","hook_name":"lint","hook_event":"PreToolUse","timestamp":"2025-10-23T00:01:00Z"}"#,
            )
            .unwrap(),
        );
        assert_eq!(rows[0].style, RowStyle::Hook);
        assert_eq!(rows[0].text, "  ⎿  lint started");

        // Assistant frames without a model stay bare.
        let rows = view.ingest(
            &parse_line(
                r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"hi"}]}}"#,
            )
            .unwrap(),
        );
        assert!(rows.iter().all(|row| row.style != RowStyle::MessageMeta));

        // Tool-only assistant frames have no text block.
        let rows = view.ingest(
            &parse_line(
                r#"{"type":"assistant","message":{"role":"assistant","model":"m","content":[{"type":"tool_use","id":"t","name":"Bash","input":{}}]}}"#,
            )
            .unwrap(),
        );
        assert!(rows.iter().all(|row| row.style != RowStyle::MessageMeta));
    }

    #[test]
    fn clock_label_uses_twelve_hour_time() {
        use time::{Date, Month, OffsetDateTime, Time};
        let at = |hour: u8, minute: u8| {
            OffsetDateTime::new_utc(
                Date::from_calendar_date(2025, Month::October, 23).unwrap(),
                Time::from_hms(hour, minute, 0).unwrap(),
            )
        };
        assert_eq!(clock_label(at(0, 0)), "12:00 AM");
        assert_eq!(clock_label(at(9, 30)), "09:30 AM");
        assert_eq!(clock_label(at(12, 5)), "12:05 PM");
        assert_eq!(clock_label(at(23, 7)), "11:07 PM");
    }

    #[test]
    fn compact_boundary_becomes_a_system_row() {
        let mut view = ChatView::new();
        let rows = view.ingest(
            &parse_line(
                r#"{"type":"system","subtype":"compact_boundary","pre_compact_token_count":12345}"#,
            )
            .unwrap(),
        );
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].style, RowStyle::System);
        assert_eq!(
            rows[0].text,
            "✻ Conversation compacted (ctrl+o for history)"
        );
    }
}
