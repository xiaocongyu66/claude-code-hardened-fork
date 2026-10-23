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
            EngineEvent::System { subtype, .. } => {
                if subtype == "compact_boundary" {
                    // Matches CompactBoundaryMessage in the Ink app.
                    return vec![Row::new(
                        RowStyle::System,
                        "✻ Conversation compacted (ctrl+o for history)".to_string(),
                    )];
                }
                Vec::new()
            }
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
                let rows = message_rows(extra.get("message"), true);
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
