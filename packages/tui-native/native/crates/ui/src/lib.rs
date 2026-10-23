//! Domain view model: turns engine events into logical rows.
//!
//! No terminal or ratatui types here. The renderer wraps and paints these
//! rows; the binary decides which rows are frozen into scrollback.

use cch_tui_proto::EngineEvent;
use serde_json::Value;
use unicode_width::UnicodeWidthChar;

/// Visual role of a logical row; the renderer maps it to a palette token.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RowStyle {
    User,
    Assistant,
    System,
    Error,
    Tool,
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
            EngineEvent::System { subtype, extra } => {
                if subtype == "compact_boundary" {
                    let before = number_field(extra, "pre_compact_token_count");
                    return vec![Row::new(
                        RowStyle::System,
                        format!(
                            "[context compacted{}]",
                            before
                                .map(|n| format!(" — {n} tokens before"))
                                .unwrap_or_default()
                        ),
                    )];
                }
                Vec::new()
            }
            EngineEvent::User { extra } => {
                let rows = message_rows(extra.get("message"), false);
                self.completed.extend(rows.clone());
                rows
            }
            EngineEvent::Assistant { extra } => {
                self.live_text.clear();
                let rows = message_rows(extra.get("message"), true);
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

    /// Submit the current input buffer as a frozen user row.
    pub fn submit_input(&mut self) -> Option<Row> {
        let text = std::mem::take(&mut self.input);
        if text.trim().is_empty() {
            return None;
        }
        let row = Row::new(RowStyle::User, format!("> {text}"));
        self.completed.push(row.clone());
        Some(row)
    }

    /// Status line content.
    ///
    /// A transient status, when present, replaces the model/session summary.
    /// The vim mode indicator is appended in both cases.
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
        if let Some(vim) = &self.vim_mode {
            line.push_str(" · ");
            line.push_str(vim);
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
        return vec![Row::new(RowStyle::Assistant, text)];
    }
    text.lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| Row::new(RowStyle::User, format!("> {line}")))
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
                .map(summarize_tool_input)
                .unwrap_or_default();
            vec![Row::new(RowStyle::Tool, format!("● {name} {summary}"))]
        }
        Some("tool_result") => {
            let text = block
                .get("content")
                .map(tool_result_text)
                .unwrap_or_default();
            if text.is_empty() {
                vec![Row::new(RowStyle::Tool, "  ⎿ (no output)".to_string())]
            } else {
                text.lines()
                    .take(3)
                    .map(|line| Row::new(RowStyle::Tool, format!("  ⎿ {line}")))
                    .collect()
            }
        }
        // Thinking/redacted blocks are not shown in the transcript.
        _ => Vec::new(),
    }
}

/// One-line description of a tool call's input.
fn summarize_tool_input(input: &Value) -> String {
    let compact = input.to_string();
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

fn number_field(extra: &serde_json::Map<String, Value>, key: &str) -> Option<u64> {
    extra.get(key).and_then(Value::as_u64)
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
        assert!(view.completed.iter().any(|row| row.text == "> hello"));
        // The result frame flushed the streamed text into a frozen row.
        assert!(view.completed.iter().any(|row| row.text == "more"));
        assert!(view.live_text.is_empty());
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
            .find(|text| text.contains("Bash"))
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
            .map(|row| row.text.as_str())
            .filter(|text| text.contains('⎿'))
            .collect();
        assert_eq!(
            results.len(),
            3,
            "results are capped at three lines: {results:?}"
        );
        assert!(results[0].contains("a.txt"));
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
        assert_eq!(row.text, "> run tests");
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
        assert!(rows[0].text.contains("12345"));
    }
}
