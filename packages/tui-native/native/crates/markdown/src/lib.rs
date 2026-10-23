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
//!
//! Tables are laid out from display widths, with ` │ ` between columns and a
//! `─┼─` separator under the header. When the table does not fit they shrink
//! proportionally and cells are truncated with `…` so no row exceeds `width`.
//! Inline formatting inside cells (code spans, emphasis) is flattened to text.
//!
//! Links render as their text, followed by ` (url)` when the destination
//! differs from the text; URLs are capped at 60 characters. Images render as
//! `[image: alt]` without loading anything. OSC 8 hyperlinks are deliberately
//! not emitted: escape sequences would corrupt the display-width accounting
//! used by wrapping and table layout. A terminal-level painter can add them
//! later without changing these logical rows.

use cch_tui_ui::{Row, RowStyle, wrap_text};
use pulldown_cmark::{Alignment, CodeBlockKind, Event, HeadingLevel, Options, Parser, Tag, TagEnd};
use unicode_width::{UnicodeWidthChar, UnicodeWidthStr};

/// Render `text` as logical rows wrapped to `width` display columns.
///
/// A width of zero, and empty input, both produce no rows.
pub fn render_markdown(text: &str, width: usize) -> Vec<Row> {
    if width == 0 {
        return Vec::new();
    }
    let mut renderer = Renderer::new(width);
    for event in Parser::new_ext(text, Options::ENABLE_TABLES) {
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

/// A link being collected. `start` is the byte offset of the link text in the
/// active inline buffer, so it can be replaced with the rendered form once the
/// closing tag arrives.
struct LinkState {
    dest: String,
    start: usize,
}

/// Alt text of an image being collected; the destination is ignored.
#[derive(Default)]
struct ImageState {
    alt: String,
}

/// A table being collected. Cells go through the normal inline buffer (so
/// formatting is flattened) and are laid out when the table ends.
struct TableState {
    align: Vec<Alignment>,
    header: Vec<String>,
    rows: Vec<Vec<String>>,
    current: Vec<String>,
}

struct Renderer {
    width: usize,
    rows: Vec<Row>,
    quote_depth: usize,
    lists: Vec<ListCtx>,
    buf: BlockBuf,
    code: Option<CodeState>,
    link: Option<LinkState>,
    image: Option<ImageState>,
    table: Option<TableState>,
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
            link: None,
            image: None,
            table: None,
        }
    }

    fn event(&mut self, event: Event<'_>) {
        match event {
            Event::Start(tag) => self.start(tag),
            Event::End(tag) => self.end(tag),
            Event::Text(text) => {
                if let Some(code) = self.code.as_mut() {
                    code.text.push_str(&text);
                } else if let Some(image) = self.image.as_mut() {
                    image.alt.push_str(&text);
                } else {
                    self.buf.text.push_str(&text);
                    self.buf.saw_non_code = true;
                }
            }
            Event::Code(text) => {
                if let Some(image) = self.image.as_mut() {
                    image.alt.push_str(&text);
                } else {
                    self.buf.text.push_str(&text);
                    self.buf.saw_code = true;
                }
            }
            Event::SoftBreak => {
                if let Some(code) = self.code.as_mut() {
                    code.text.push('\n');
                } else if let Some(image) = self.image.as_mut() {
                    image.alt.push(' ');
                } else {
                    self.buf.text.push(' ');
                    self.buf.saw_break = true;
                }
            }
            Event::HardBreak => {
                if let Some(code) = self.code.as_mut() {
                    code.text.push('\n');
                } else if let Some(image) = self.image.as_mut() {
                    image.alt.push(' ');
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
            Tag::Link { dest_url, .. } => {
                if self.image.is_none() {
                    self.link = Some(LinkState {
                        dest: dest_url.to_string(),
                        start: self.buf.text.len(),
                    });
                }
            }
            Tag::Image { .. } => {
                self.image = Some(ImageState::default());
            }
            Tag::Table(align) => {
                self.flush_pending();
                self.table = Some(TableState {
                    align,
                    header: Vec::new(),
                    rows: Vec::new(),
                    current: Vec::new(),
                });
            }
            Tag::TableHead | Tag::TableRow => {
                if let Some(table) = self.table.as_mut() {
                    table.current.clear();
                }
            }
            Tag::TableCell => self.buf = BlockBuf::default(),
            // Inline emphasis markers are stripped; `Row` has a single style.
            Tag::Emphasis
            | Tag::Strong
            | Tag::Strikethrough
            | Tag::Superscript
            | Tag::Subscript => {}
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
            TagEnd::Link => self.finish_link(),
            TagEnd::Image => self.finish_image(),
            TagEnd::TableCell => {
                if let Some(table) = self.table.as_mut() {
                    let text = std::mem::take(&mut self.buf.text);
                    self.buf = BlockBuf::default();
                    table.current.push(text.trim().to_string());
                }
            }
            TagEnd::TableHead => {
                if let Some(table) = self.table.as_mut() {
                    table.header = std::mem::take(&mut table.current);
                }
            }
            TagEnd::TableRow => {
                if let Some(table) = self.table.as_mut() {
                    let row = std::mem::take(&mut table.current);
                    table.rows.push(row);
                }
            }
            TagEnd::Table => {
                if let Some(table) = self.table.take() {
                    self.render_table(table);
                }
            }
            _ => {}
        }
    }

    /// Append ` (url)` when a link's destination differs from its text.
    fn finish_link(&mut self) {
        let Some(link) = self.link.take() else {
            return;
        };
        let text = self.buf.text.get(link.start..).unwrap_or_default();
        if link.dest == text {
            return;
        }
        let url: String = link.dest.chars().take(MAX_URL_CHARS).collect();
        self.buf.text.push_str(" (");
        self.buf.text.push_str(&url);
        self.buf.text.push(')');
        self.buf.saw_non_code = true;
    }

    /// Replace an image with its textual placeholder; nothing is loaded.
    fn finish_image(&mut self) {
        let Some(image) = self.image.take() else {
            return;
        };
        self.buf.text.push_str("[image: ");
        self.buf.text.push_str(image.alt.trim());
        self.buf.text.push(']');
        self.buf.saw_non_code = true;
    }

    /// Lay the collected table out and emit one row per logical line.
    fn render_table(&mut self, table: TableState) {
        let mut columns = table
            .align
            .len()
            .max(table.header.len())
            .max(table.rows.iter().map(Vec::len).max().unwrap_or(0));
        if columns == 0 {
            return;
        }
        let (first_prefix, continuation) = self.prefixes();
        let total_width = self
            .width
            .saturating_sub(display_width(&first_prefix))
            .max(1);
        // A column needs at least one glyph and, except for the first, ` │ `
        // (three cells), so drop columns that cannot fit at all.
        columns = columns.min(total_width.div_ceil(4).max(1));

        let mut natural = vec![0usize; columns];
        for (index, cell) in table.header.iter().take(columns).enumerate() {
            natural[index] = natural[index].max(display_width(cell));
        }
        for row in &table.rows {
            for (index, cell) in row.iter().take(columns).enumerate() {
                natural[index] = natural[index].max(display_width(cell));
            }
        }

        let gaps = display_width(COLUMN_GAP) * (columns - 1);
        let budget = total_width.saturating_sub(gaps);
        let widths = if natural.iter().sum::<usize>() <= budget {
            natural
        } else {
            shrink_columns(&natural, budget)
        };

        let header = table_line(&table.header, &widths, &table.align);
        let separator = widths
            .iter()
            .map(|width| "─".repeat(*width))
            .collect::<Vec<_>>()
            .join("─┼─");
        self.rows.push(Row::new(
            RowStyle::TableHeader,
            format!("{first_prefix}{header}"),
        ));
        self.rows.push(Row::new(
            RowStyle::TableRow,
            format!("{continuation}{separator}"),
        ));
        for row in &table.rows {
            let line = table_line(row, &widths, &table.align);
            self.rows.push(Row::new(
                RowStyle::TableRow,
                format!("{continuation}{line}"),
            ));
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

/// Gap inserted between table columns.
const COLUMN_GAP: &str = " │ ";

/// Maximum number of characters of a link destination shown in ` (url)`.
const MAX_URL_CHARS: usize = 60;

fn display_width(text: &str) -> usize {
    UnicodeWidthStr::width(text)
}

/// Truncate `text` to at most `width` display cells, ending in `…` when cut.
fn truncate_to_width(text: &str, width: usize) -> String {
    if display_width(text) <= width {
        return text.to_string();
    }
    if width == 0 {
        return String::new();
    }
    // Reserve one cell for the ellipsis.
    let budget = width - 1;
    let mut out = String::new();
    let mut used = 0;
    for ch in text.chars() {
        let char_width = ch.width().unwrap_or(0);
        if used + char_width > budget {
            break;
        }
        out.push(ch);
        used += char_width;
    }
    out.push('…');
    out
}

/// Pad `text` within `width` display cells according to `align`.
fn align_cell(text: &str, width: usize, align: Alignment) -> String {
    let used = display_width(text);
    if used >= width {
        return text.to_string();
    }
    let pad = width - used;
    match align {
        Alignment::Right => format!("{}{text}", " ".repeat(pad)),
        Alignment::Center => {
            let left = pad / 2;
            format!("{}{text}{}", " ".repeat(left), " ".repeat(pad - left))
        }
        Alignment::None | Alignment::Left => format!("{text}{}", " ".repeat(pad)),
    }
}

/// Render one logical table line (truncating and padding every cell).
fn table_line(cells: &[String], widths: &[usize], align: &[Alignment]) -> String {
    let mut line = String::new();
    for (index, width) in widths.iter().enumerate() {
        if index > 0 {
            line.push_str(COLUMN_GAP);
        }
        let cell = cells.get(index).map(String::as_str).unwrap_or("");
        let text = truncate_to_width(cell, *width);
        let alignment = align.get(index).copied().unwrap_or(Alignment::None);
        line.push_str(&align_cell(&text, *width, alignment));
    }
    line
}

/// Scale natural column widths down to `budget`, proportionally, keeping at
/// least one cell per non-empty column and never exceeding the natural width.
fn shrink_columns(natural: &[usize], budget: usize) -> Vec<usize> {
    let mut widths = vec![0usize; natural.len()];
    let filled = natural.iter().filter(|width| **width > 0).count();
    if filled == 0 {
        return widths;
    }
    // Reserve one cell per non-empty column, then split the remainder in
    // proportion to each column's extra width above that reservation.
    let reserved = filled.min(budget);
    let mut reserved_left = reserved;
    for (index, width) in natural.iter().enumerate() {
        if *width > 0 && reserved_left > 0 {
            widths[index] = 1;
            reserved_left -= 1;
        }
    }
    let remaining = budget - reserved;
    if remaining == 0 {
        return widths;
    }
    let extra: Vec<usize> = natural
        .iter()
        .map(|width| width.saturating_sub(1))
        .collect();
    let extra_total: usize = extra.iter().sum();
    if extra_total == 0 {
        return widths;
    }
    let mut share: Vec<usize> = extra
        .iter()
        .map(|value| remaining * value / extra_total)
        .collect();
    let assigned: usize = share.iter().sum();
    let leftover = remaining - assigned;
    let mut order: Vec<(usize, usize)> = (0..natural.len())
        .filter(|&index| extra[index] > 0)
        .map(|index| (index, remaining * extra[index] % extra_total))
        .collect();
    // Largest remainder first; ties go to the leftmost column.
    order.sort_by(|left, right| right.1.cmp(&left.1).then(left.0.cmp(&right.0)));
    for &(index, _) in order.iter().take(leftover) {
        share[index] += 1;
    }
    for (index, width) in widths.iter_mut().enumerate() {
        *width += share[index];
    }
    widths
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
    fn renders_tables_with_aligned_columns() {
        let input = "| Name | Qty |\n| :--- | ---: |\n| apple | 3 |\n| banana | 12 |\n";
        let rows = render_markdown(input, 40);
        assert_eq!(
            texts(&rows),
            [
                "Name   │ Qty",
                "───────┼────",
                "apple  │   3",
                "banana │  12",
            ]
        );
        assert_eq!(rows[0].style, RowStyle::TableHeader);
        assert!(rows[1..].iter().all(|row| row.style == RowStyle::TableRow));
        assert!(rows.iter().all(|row| display_width(&row.text) <= 40));
    }

    #[test]
    fn flattens_inline_formatting_inside_table_cells() {
        let input = "| **bold** | `code` |\n| --- | ---: |\n| plain | *em* |\n";
        let rows = render_markdown(input, 40);
        assert_eq!(
            texts(&rows),
            ["bold  │ code", "──────┼─────", "plain │   em"]
        );
    }

    #[test]
    fn sizes_cjk_table_cells_by_display_width() {
        let input = "| 名 | 数量 |\n| --- | --- |\n| 汉字 | 很多 |\n";
        let rows = render_markdown(input, 40);
        assert_eq!(texts(&rows), ["名   │ 数量", "─────┼─────", "汉字 │ 很多"]);
        let widths: Vec<usize> = rows.iter().map(|row| display_width(&row.text)).collect();
        assert_eq!(widths, [11, 11, 11]);
    }

    #[test]
    fn shrinks_and_truncates_tables_that_exceed_the_width() {
        let input = "| alpha | beta |\n| --- | ---: |\n| gamma | delta |\n";
        let rows = render_markdown(input, 12);
        assert_eq!(
            texts(&rows),
            ["alpha │ beta", "──────┼─────", "gamma │ del…"]
        );
        assert!(rows.iter().any(|row| row.text.contains('…')));
        assert!(
            rows.iter().all(|row| display_width(&row.text) <= 12),
            "row wider than 12: {:?}",
            texts(&rows)
        );
    }

    #[test]
    fn links_show_url_suffix_only_when_it_differs_from_text() {
        let rows = render_markdown("[docs](https://example.com/docs)", 80);
        assert_eq!(texts(&rows), ["docs (https://example.com/docs)"]);

        let rows = render_markdown("[https://example.com](https://example.com)", 80);
        assert_eq!(texts(&rows), ["https://example.com"]);

        let long = format!("https://example.com/{}", "a".repeat(60));
        let rows = render_markdown(&format!("[link]({long})"), 200);
        let shown: String = long.chars().take(MAX_URL_CHARS).collect();
        assert_eq!(rows[0].text, format!("link ({shown})"));
        assert!(!rows[0].text.contains(&"a".repeat(MAX_URL_CHARS)));
    }

    #[test]
    fn images_render_as_text_placeholders() {
        let rows = render_markdown("![a diagram](diagram.png)", 80);
        assert_eq!(texts(&rows), ["[image: a diagram]"]);

        let rows = render_markdown("before ![alt **text**](x.png) after", 80);
        assert_eq!(texts(&rows), ["before [image: alt text] after"]);
    }

    #[test]
    fn tables_and_paragraphs_keep_their_order_and_styles() {
        let input = "Intro paragraph.\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\nAfter the table.\n";
        let rows = render_markdown(input, 40);
        assert_eq!(
            texts(&rows),
            [
                "Intro paragraph.",
                "A │ B",
                "──┼──",
                "1 │ 2",
                "After the table."
            ]
        );
        let styles: Vec<RowStyle> = rows.iter().map(|row| row.style).collect();
        assert_eq!(
            styles,
            [
                RowStyle::Assistant,
                RowStyle::TableHeader,
                RowStyle::TableRow,
                RowStyle::TableRow,
                RowStyle::Assistant,
            ]
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
