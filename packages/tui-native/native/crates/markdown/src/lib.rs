//! Markdown to logical-row rendering.
//!
//! The renderer is pure: it never touches a terminal, ANSI escapes or ratatui.
//! It parses a Markdown subset with `pulldown-cmark` and emits [`Row`] values
//! that a later stage can paint. Fenced code blocks are passed through
//! verbatim (no wrapping) and tagged [`RowStyle::CodeBlock`] so a dedicated
//! highlighter can take them over.
//!
//! Wrapping is delegated to [`cch_tui_ui::wrap_text`], which is display-width
//! aware (CJK and other wide characters). List indentation, list markers and
//! blockquote prefixes are prepended after wrapping, so the output is stable:
//! the same input and width always produce the same rows byte for byte.

use cch_tui_ui::{Row, RowStyle, wrap_text};
use pulldown_cmark::{CodeBlockKind, Event, HeadingLevel, Options, Parser, Tag, TagEnd};

/// Render `text` as logical rows wrapped to `width` display columns.
///
/// A width of zero, and empty input, both produce no rows.
pub fn render_markdown(text: &str, width: usize) -> Vec<Row> {
    if width == 0 {
        return Vec::new();
    }
    let mut renderer = Renderer::new(width);
    for event in Parser::new_ext(text, Options::empty()) {
        renderer.event(event);
    }
    renderer.rows
}

/// Inline text collected for the block currently being rendered.
#[derive(Default)]
struct BlockBuf {
    text: String,
    /// Inline code spans were seen.
    saw_code: bool,
    /// Ordinary text (including emphasis/link content) was seen.
    saw_non_code: bool,
    /// A soft or hard line break was seen.
    saw_break: bool,
}

struct ListCtx {
    ordered: bool,
    next: u64,
    marker: String,
    /// Whether this item's marker has already been emitted.
    item_emitted: bool,
}

struct CodeState {
    fenced: bool,
    lang: String,
    text: String,
}

struct Renderer {
    width: usize,
    rows: Vec<Row>,
    quote_depth: usize,
    lists: Vec<ListCtx>,
    buf: BlockBuf,
    code: Option<CodeState>,
}

impl Renderer {
    fn new(width: usize) -> Self {
        Self {
            width,
            rows: Vec::new(),
            quote_depth: 0,
            lists: Vec::new(),
            buf: BlockBuf::default(),
            code: None,
        }
    }

    fn event(&mut self, event: Event<'_>) {
        match event {
            Event::Start(tag) => self.start(tag),
            Event::End(tag) => self.end(tag),
            Event::Text(text) => {
                if let Some(code) = self.code.as_mut() {
                    code.text.push_str(&text);
                } else {
                    self.buf.text.push_str(&text);
                    self.buf.saw_non_code = true;
                }
            }
            Event::Code(text) => {
                self.buf.text.push_str(&text);
                self.buf.saw_code = true;
            }
            Event::SoftBreak => {
                if let Some(code) = self.code.as_mut() {
                    code.text.push('\n');
                } else {
                    self.buf.text.push(' ');
                    self.buf.saw_break = true;
                }
            }
            Event::HardBreak => {
                if let Some(code) = self.code.as_mut() {
                    code.text.push('\n');
                } else {
                    self.buf.text.push('\n');
                    self.buf.saw_break = true;
                }
            }
            Event::Rule => {
                self.flush_pending();
                self.emit_rule();
            }
            // Raw HTML is not rendered (no terminal markup in this layer).
            Event::Html(_) | Event::InlineHtml(_) | Event::FootnoteReference(_) => {}
            Event::InlineMath(text) | Event::DisplayMath(text) => {
                self.buf.text.push_str(&text);
                self.buf.saw_code = true;
            }
            Event::TaskListMarker(checked) => {
                self.buf
                    .text
                    .push_str(if checked { "[x] " } else { "[ ] " });
                self.buf.saw_non_code = true;
            }
        }
    }

    fn start(&mut self, tag: Tag<'_>) {
        match tag {
            Tag::Paragraph => {}
            Tag::Heading { .. } => self.flush_pending(),
            Tag::BlockQuote(_kind) => {
                self.flush_pending();
                self.quote_depth += 1;
            }
            Tag::CodeBlock(kind) => {
                self.flush_pending();
                let (fenced, lang) = match kind {
                    CodeBlockKind::Indented => (false, String::new()),
                    CodeBlockKind::Fenced(info) => (true, info.to_string()),
                };
                self.code = Some(CodeState {
                    fenced,
                    lang,
                    text: String::new(),
                });
            }
            Tag::List(start) => {
                self.flush_pending();
                self.lists.push(ListCtx {
                    ordered: start.is_some(),
                    next: start.unwrap_or(1),
                    marker: String::new(),
                    item_emitted: false,
                });
            }
            Tag::Item => {
                if let Some(ctx) = self.lists.last_mut() {
                    ctx.item_emitted = false;
                    ctx.marker = if ctx.ordered {
                        let number = ctx.next;
                        ctx.next += 1;
                        format!("{number}. ")
                    } else {
                        "- ".to_string()
                    };
                }
            }
            // Inline emphasis markers are stripped; `Row` has a single style.
            Tag::Emphasis
            | Tag::Strong
            | Tag::Strikethrough
            | Tag::Superscript
            | Tag::Subscript
            | Tag::Link { .. }
            | Tag::Image { .. } => {}
            _ => {}
        }
    }

    fn end(&mut self, tag: TagEnd) {
        match tag {
            TagEnd::Paragraph => self.flush_pending(),
            TagEnd::Heading(level) => self.flush_with(RowStyle::Heading(heading_level(level))),
            TagEnd::BlockQuote(_kind) => {
                self.flush_pending();
                self.quote_depth = self.quote_depth.saturating_sub(1);
            }
            TagEnd::CodeBlock => {
                if let Some(state) = self.code.take() {
                    self.emit_code(state);
                }
            }
            TagEnd::List(_ordered) => {
                self.flush_pending();
                self.lists.pop();
            }
            TagEnd::Item => self.flush_pending(),
            _ => {}
        }
    }

    /// Style for the current inline buffer based on its block context.
    fn pending_style(&self) -> RowStyle {
        if !self.lists.is_empty() {
            RowStyle::ListItem
        } else if self.quote_depth > 0 {
            RowStyle::Blockquote
        } else if self.buf.saw_code && !self.buf.saw_non_code && !self.buf.saw_break {
            RowStyle::InlineCode
        } else {
            RowStyle::Assistant
        }
    }

    fn take_block_text(&mut self) -> String {
        let mut text = std::mem::take(&mut self.buf.text);
        while text.ends_with('\n') {
            text.pop();
        }
        self.buf = BlockBuf::default();
        text
    }

    fn flush_pending(&mut self) {
        if self.buf.text.trim().is_empty() {
            self.buf = BlockBuf::default();
            return;
        }
        let style = self.pending_style();
        let text = self.take_block_text();
        self.emit_wrapped(style, &text);
    }

    fn flush_with(&mut self, style: RowStyle) {
        if self.buf.text.trim().is_empty() {
            self.buf = BlockBuf::default();
            return;
        }
        let text = self.take_block_text();
        self.emit_wrapped(style, &text);
    }

    /// Prefixes for the first and continuation line of a block.
    ///
    /// Both have the same display width (all prefixes are ASCII), so a single
    /// content width can be used for both.
    fn prefixes(&mut self) -> (String, String) {
        let quote = "> ".repeat(self.quote_depth);
        let depth = self.lists.len();
        if depth == 0 {
            return (quote.clone(), quote);
        }
        let indent = "  ".repeat(depth - 1);
        let ctx = self.lists.last_mut().expect("list depth > 0");
        let marker_width = ctx.marker.chars().count();
        if ctx.item_emitted {
            let pad = " ".repeat(marker_width);
            let prefix = format!("{quote}{indent}{pad}");
            (prefix.clone(), prefix)
        } else {
            ctx.item_emitted = true;
            let first = format!("{quote}{indent}{}", ctx.marker);
            let continuation = format!("{quote}{indent}{}", " ".repeat(marker_width));
            (first, continuation)
        }
    }

    fn emit_wrapped(&mut self, style: RowStyle, text: &str) {
        let (first_prefix, continuation) = self.prefixes();
        let prefix_width = first_prefix.chars().count();
        let available = self.width.saturating_sub(prefix_width).max(1);
        for (index, line) in wrap_text(text, available).into_iter().enumerate() {
            let prefix = if index == 0 {
                &first_prefix
            } else {
                &continuation
            };
            self.rows.push(Row::new(style, format!("{prefix}{line}")));
        }
    }

    /// Emit already-split lines without wrapping (code fences stay intact).
    fn emit_prefixed(&mut self, style: RowStyle, lines: Vec<String>) {
        let (first_prefix, continuation) = self.prefixes();
        for (index, line) in lines.into_iter().enumerate() {
            let prefix = if index == 0 {
                &first_prefix
            } else {
                &continuation
            };
            self.rows.push(Row::new(style, format!("{prefix}{line}")));
        }
    }

    fn emit_rule(&mut self) {
        let (prefix, _) = self.prefixes();
        self.rows
            .push(Row::new(RowStyle::Rule, format!("{prefix}---")));
    }

    fn emit_code(&mut self, state: CodeState) {
        let mut lines: Vec<String> = Vec::new();
        if state.fenced {
            lines.push(format!("```{}", state.lang));
        }
        let body = state.text.strip_suffix('\n').unwrap_or(&state.text);
        if !body.is_empty() {
            lines.extend(body.split('\n').map(ToOwned::to_owned));
        }
        if state.fenced {
            lines.push("```".to_string());
        }
        if !lines.is_empty() {
            self.emit_prefixed(RowStyle::CodeBlock, lines);
        }
    }
}

fn heading_level(level: HeadingLevel) -> u8 {
    level as u8
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};

    fn texts(rows: &[Row]) -> Vec<&str> {
        rows.iter().map(|row| row.text.as_str()).collect()
    }

    #[test]
    fn renders_each_heading_level_with_its_style() {
        let rows = render_markdown("# One\n\n## Two\n\n###### Six", 80);
        assert_eq!(texts(&rows), ["One", "Two", "Six"]);
        assert_eq!(rows[0].style, RowStyle::Heading(1));
        assert_eq!(rows[1].style, RowStyle::Heading(2));
        assert_eq!(rows[2].style, RowStyle::Heading(6));
    }

    #[test]
    fn indents_nested_unordered_lists_and_numbers_ordered_ones() {
        let rows = render_markdown("- alpha\n  - beta\n- gamma", 80);
        assert_eq!(texts(&rows), ["- alpha", "  - beta", "- gamma"]);
        assert!(rows.iter().all(|row| row.style == RowStyle::ListItem));

        let rows = render_markdown("3. three\n4. four", 80);
        assert_eq!(texts(&rows), ["3. three", "4. four"]);
    }

    #[test]
    fn keeps_fenced_code_verbatim_and_unwrapped() {
        let code = "let long_line = \"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\";";
        let input = format!("```rust\n{code}\n```\n");
        let rows = render_markdown(&input, 10);
        assert_eq!(texts(&rows), ["```rust", code, "```"]);
        assert!(rows.iter().all(|row| row.style == RowStyle::CodeBlock));
        assert_eq!(rows[1].text, code, "code must not be wrapped or altered");
    }

    #[test]
    fn strips_bold_italic_and_inline_code_markers() {
        let rows = render_markdown("**bold** and *italic* and `code`", 80);
        assert_eq!(texts(&rows), ["bold and italic and code"]);
        assert!(!rows[0].text.contains('*'));
        assert!(!rows[0].text.contains('`'));

        let rows = render_markdown("`only code`", 80);
        assert_eq!(texts(&rows), ["only code"]);
        assert_eq!(rows[0].style, RowStyle::InlineCode);
    }

    #[test]
    fn wraps_cjk_by_display_width() {
        let rows = render_markdown("汉字汉字汉字", 4);
        assert_eq!(texts(&rows), ["汉字", "汉字", "汉字"]);
    }

    #[test]
    fn wraps_overlong_words_without_dropping_characters() {
        let rows = render_markdown("abcdefghij", 4);
        assert_eq!(texts(&rows), ["abcd", "efgh", "ij"]);
    }

    #[test]
    fn empty_and_whitespace_only_input_render_no_rows() {
        assert!(render_markdown("", 80).is_empty());
        assert!(render_markdown("   \n\n\t\n", 80).is_empty());
        assert!(render_markdown("# hi", 0).is_empty());
    }

    #[test]
    fn prefixes_blockquotes_and_renders_rules() {
        let rows = render_markdown("> quoted text\n\n---", 40);
        assert_eq!(texts(&rows), ["> quoted text", "---"]);
        assert_eq!(rows[0].style, RowStyle::Blockquote);
        assert_eq!(rows[1].style, RowStyle::Rule);
    }

    #[test]
    fn same_input_and_width_are_byte_identical() {
        let input = "# Title\n\n- one\n  - two\n\n> quote\n\n```rs\nfn x() {}\n```\n";
        let first = render_markdown(input, 24);
        let second = render_markdown(input, 24);
        assert_eq!(first, second);
        assert_eq!(
            first.iter().map(|row| row.text.clone()).collect::<Vec<_>>(),
            second
                .iter()
                .map(|row| row.text.clone())
                .collect::<Vec<_>>()
        );
    }

    #[test]
    fn renders_100kb_within_bounds() {
        let unit = "# Heading\n\n\
                    - item with **bold** and `code`\n\
                    - second item\n\n\
                    paragraph text that is reasonably short.\n\n\
                    > quoted line\n\n\
                    ```rust\nfn main() { println!(\"hi\"); }\n```\n\n";
        let mut input = String::with_capacity(101_000);
        while input.len() < 100_000 {
            input.push_str(unit);
        }
        let line_count = input.matches('\n').count();

        let started = Instant::now();
        let rows = render_markdown(&input, 200);
        let elapsed = started.elapsed();

        assert!(!rows.is_empty());
        assert!(
            rows.len() <= line_count,
            "rows {} exceeded source lines {}",
            rows.len(),
            line_count
        );
        assert!(
            elapsed < Duration::from_secs(2),
            "100KB render took {elapsed:?}"
        );
    }
}
