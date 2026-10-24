//! Markdown to logical-row rendering.
//!
//! The renderer is pure: it never touches a terminal, ANSI escapes or ratatui.
//! It parses a Markdown subset with `pulldown-cmark` and emits [`Row`] values
//! that a later stage can paint. Fenced code blocks are passed through
//! verbatim (no wrapping) and tagged [`RowStyle::CodeBlock`] so a dedicated
//! highlighter can take them over.
//!
//! Syntax and layout mirror the Ink app (`src/utils/markdown.ts` +
//! `MarkdownTable.tsx`):
//!
//! - Prose is **word-wrapped** at display width (CJK-aware); a word wider than
//!   the line is hard-broken, never dropped. List indentation, list markers
//!   and blockquote bars are prepended after wrapping, so output is stable:
//!   the same input and width always produce the same rows byte for byte.
//! - Blockquotes use the `▎` bar (`figures.BLOCKQUOTE_BAR`) and a space per
//!   nesting level; inline markers are stripped.
//! - Top-level blocks are separated by one empty row, matching the blank line
//!   Ink's token stream produces between blocks.
//! - Tables are the Ink box layout: `┌─┬─┐ / ├─┼─┤ / └─┴─┘` borders, one space
//!   of cell padding, headers centred, per-column alignment, and cells
//!   **wrapped** (not truncated) at column widths derived from the longest
//!   word. When rows would wrap past four lines — or the finished table would
//!   crowd the width margin — the table degrades to Ink's vertical
//!   `Label: value` form. Inline formatting in cells is flattened to text.
//! - Links render as their display text; `mailto:` links render as the bare
//!   email. OSC 8 hyperlinks are not emitted here: escape sequences would
//!   corrupt the display-width accounting used by wrapping and table layout.
//!   A terminal-level painter can add them later without changing these rows.
//! - Images render as their destination URL, exactly like Ink's `image` token
//!   handler, without loading anything.

use cch_tui_ui::{Row, RowStyle};
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

/// An image being collected. Ink's `image` token renders the destination, so
/// the alt text is skipped rather than buffered.
struct ImageState {
    dest: String,
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
    /// A top-level block ended; the next one is preceded by a blank row.
    pending_blank: bool,
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
            pending_blank: false,
        }
    }

    fn event(&mut self, event: Event<'_>) {
        match event {
            Event::Start(tag) => self.start(tag),
            Event::End(tag) => self.end(tag),
            // Image alt text never reaches the output: Ink renders the URL.
            Event::Text(text) => {
                if let Some(code) = self.code.as_mut() {
                    code.text.push_str(&text);
                } else if self.image.is_none() {
                    self.buf.text.push_str(&text);
                    self.buf.saw_non_code = true;
                }
            }
            Event::Code(text) => {
                if self.image.is_none() {
                    self.buf.text.push_str(&text);
                    self.buf.saw_code = true;
                }
            }
            Event::SoftBreak => {
                if let Some(code) = self.code.as_mut() {
                    code.text.push('\n');
                } else if self.image.is_none() {
                    self.buf.text.push(' ');
                    self.buf.saw_break = true;
                }
            }
            Event::HardBreak => {
                if let Some(code) = self.code.as_mut() {
                    code.text.push('\n');
                } else if self.image.is_none() {
                    self.buf.text.push('\n');
                    self.buf.saw_break = true;
                }
            }
            Event::Rule => {
                self.flush_pending();
                self.begin_block();
                self.emit_rule();
                self.pending_blank = self.lists.is_empty();
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

    /// Insert the blank separator before a new top-level block.
    fn begin_block(&mut self) {
        if self.pending_blank && !self.rows.is_empty() {
            self.rows.push(Row::new(RowStyle::Assistant, String::new()));
        }
        self.pending_blank = false;
    }

    /// Whether blank-line separation applies at the current nesting level.
    /// Inside lists and blockquotes blocks stay adjacent, exactly like Ink's
    /// token walk (a quoted blank line arrives as its own `space` token there,
    /// not as a block boundary).
    fn separates_blocks(&self) -> bool {
        self.lists.is_empty() && self.quote_depth == 0
    }

    fn start(&mut self, tag: Tag<'_>) {
        match tag {
            Tag::Paragraph => {
                if self.separates_blocks() && self.table.is_none() {
                    self.begin_block();
                }
            }
            Tag::Heading { .. } => {
                self.flush_pending();
                if self.separates_blocks() {
                    self.begin_block();
                }
            }
            Tag::BlockQuote(_kind) => {
                self.flush_pending();
                if self.separates_blocks() {
                    self.begin_block();
                }
                self.quote_depth += 1;
            }
            Tag::CodeBlock(kind) => {
                self.flush_pending();
                if self.separates_blocks() {
                    self.begin_block();
                }
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
                if self.separates_blocks() {
                    self.begin_block();
                }
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
            Tag::Image { dest_url, .. } => {
                self.image = Some(ImageState {
                    dest: dest_url.to_string(),
                });
            }
            Tag::Table(align) => {
                self.flush_pending();
                if self.separates_blocks() {
                    self.begin_block();
                }
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
            TagEnd::Paragraph => {
                self.flush_pending();
                self.pending_blank = self.separates_blocks();
            }
            TagEnd::Heading(level) => {
                self.flush_with(RowStyle::Heading(heading_level(level)));
                self.pending_blank = self.separates_blocks();
            }
            TagEnd::BlockQuote(_kind) => {
                self.flush_pending();
                self.quote_depth = self.quote_depth.saturating_sub(1);
                self.pending_blank = self.separates_blocks();
            }
            TagEnd::CodeBlock => {
                if let Some(state) = self.code.take() {
                    self.emit_code(state);
                }
                self.pending_blank = self.separates_blocks();
            }
            TagEnd::List(_ordered) => {
                self.flush_pending();
                self.lists.pop();
                self.pending_blank = self.separates_blocks();
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
                self.pending_blank = self.separates_blocks();
            }
            _ => {}
        }
    }

    /// Links keep their display text; `mailto:` links collapse to the bare
    /// email address (Ink's `link` token handler). The hyperlink itself is a
    /// painter concern, so no OSC 8 sequence is emitted here.
    fn finish_link(&mut self) {
        let Some(link) = self.link.take() else {
            return;
        };
        if let Some(email) = link.dest.strip_prefix("mailto:") {
            self.buf.text.truncate(link.start);
            self.buf.text.push_str(email);
            self.buf.saw_non_code = true;
        }
    }

    /// Render an image as its destination URL; nothing is loaded.
    fn finish_image(&mut self) {
        let Some(image) = self.image.take() else {
            return;
        };
        self.buf.text.push_str(&image.dest);
        self.buf.saw_non_code = true;
    }

    /// Lay the collected table out and emit logical rows.
    ///
    /// Mirrors `MarkdownTable.tsx`: box-drawing borders, centred headers,
    /// per-column alignment, cells wrapped at widths derived from the longest
    /// word, and a vertical `Label: value` fallback when a row would need more
    /// than four lines (or the grid would crowd the width margin).
    fn render_table(&mut self, table: TableState) {
        let columns = table
            .align
            .len()
            .max(table.header.len())
            .max(table.rows.iter().map(Vec::len).max().unwrap_or(0));
        if columns == 0 {
            return;
        }
        // Normalise ragged rows to the reported column count.
        let header: Vec<String> = (0..columns)
            .map(|index| table.header.get(index).cloned().unwrap_or_default())
            .collect();
        let rows: Vec<Vec<String>> = table
            .rows
            .iter()
            .map(|row| {
                (0..columns)
                    .map(|index| row.get(index).cloned().unwrap_or_default())
                    .collect()
            })
            .collect();

        let (first_prefix, continuation) = self.prefixes();
        let prefix_width = display_width(&first_prefix);
        let content_width = self.width.saturating_sub(prefix_width).max(1);
        // One border cell plus two padding cells and one border per column,
        // then Ink's four-column safety margin.
        let border_overhead = 1 + columns * 3;
        let available = content_width
            .saturating_sub(border_overhead + TABLE_SAFETY_MARGIN)
            .max(columns * MIN_COLUMN_WIDTH);

        let mut min_widths = vec![MIN_COLUMN_WIDTH; columns];
        let mut ideal_widths = vec![MIN_COLUMN_WIDTH; columns];
        for (index, ideal) in ideal_widths.iter_mut().enumerate() {
            let cells = std::iter::once(&header[index]).chain(rows.iter().map(|row| &row[index]));
            for cell in cells {
                min_widths[index] = min_widths[index].max(longest_word_width(cell));
                *ideal = (*ideal).max(display_width(cell));
            }
        }

        let total_ideal: usize = ideal_widths.iter().sum();
        let total_min: usize = min_widths.iter().sum();
        let widths = if total_ideal <= available {
            ideal_widths
        } else if total_min <= available {
            let extra = available - total_min;
            let overflows: Vec<usize> = ideal_widths
                .iter()
                .zip(&min_widths)
                .map(|(ideal, min)| ideal.saturating_sub(*min))
                .collect();
            let total_overflow: usize = overflows.iter().sum();
            if total_overflow == 0 {
                min_widths
            } else {
                min_widths
                    .iter()
                    .zip(&overflows)
                    .map(|(min, overflow)| min + extra * overflow / total_overflow)
                    .collect()
            }
        } else {
            // Not even the longest words fit: shrink proportionally; the cell
            // wrapper breaks words that still exceed their column.
            let scale = available as f64 / total_min as f64;
            min_widths
                .iter()
                .map(|min| ((*min as f64 * scale).floor() as usize).max(MIN_COLUMN_WIDTH))
                .collect()
        };

        let header_lines: Vec<Vec<String>> = header
            .iter()
            .zip(&widths)
            .map(|(cell, width)| wrap_cell(cell, *width))
            .collect();
        let body_lines: Vec<Vec<Vec<String>>> = rows
            .iter()
            .map(|row| {
                row.iter()
                    .zip(&widths)
                    .map(|(cell, width)| wrap_cell(cell, *width))
                    .collect()
            })
            .collect();
        let max_row_lines = header_lines
            .iter()
            .map(Vec::len)
            .chain(body_lines.iter().flatten().map(Vec::len))
            .max()
            .unwrap_or(1);

        let grid_width = 1 + columns * 3 + widths.iter().sum::<usize>();
        if max_row_lines > MAX_ROW_LINES
            || prefix_width + grid_width > self.width.saturating_sub(TABLE_SAFETY_MARGIN)
        {
            self.render_table_vertical(&header, &rows, &first_prefix, &continuation, content_width);
            return;
        }

        let mut lines: Vec<String> = Vec::new();
        lines.push(border_line(&widths, ['┌', '─', '┬', '┐']));
        push_row_lines(&mut lines, &header_lines, &widths, true, &table.align);
        lines.push(border_line(&widths, ['├', '─', '┼', '┤']));
        for (index, row) in body_lines.iter().enumerate() {
            push_row_lines(&mut lines, row, &widths, false, &table.align);
            if index + 1 < body_lines.len() {
                lines.push(border_line(&widths, ['├', '─', '┼', '┤']));
            }
        }
        lines.push(border_line(&widths, ['└', '─', '┴', '┘']));

        for (index, line) in lines.into_iter().enumerate() {
            let prefix = if index == 0 {
                &first_prefix
            } else {
                &continuation
            };
            // The row after the top border is the header.
            let style = if index == 1 {
                RowStyle::TableHeader
            } else {
                RowStyle::TableRow
            };
            self.rows.push(Row::new(style, format!("{prefix}{line}")));
        }
    }

    /// Ink's narrow-terminal table form: one `Label: value` block per row,
    /// separated by a horizontal rule, values wrapped under a two-space indent.
    fn render_table_vertical(
        &mut self,
        header: &[String],
        rows: &[Vec<String>],
        first_prefix: &str,
        continuation: &str,
        content_width: usize,
    ) {
        let mut lines: Vec<String> = Vec::new();
        for (row_index, row) in rows.iter().enumerate() {
            if row_index > 0 {
                lines.push("─".repeat(content_width.saturating_sub(1).min(40)));
            }
            for (column, cell) in row.iter().enumerate() {
                let label = header
                    .get(column)
                    .map(|label| label.trim())
                    .filter(|label| !label.is_empty())
                    .map(ToOwned::to_owned)
                    .unwrap_or_else(|| format!("Column {}", column + 1));
                let value = cell.split_whitespace().collect::<Vec<_>>().join(" ");
                let label_width = display_width(&label);
                let first_width = content_width.saturating_sub(label_width + 3).max(10);
                let next_width = content_width.saturating_sub(3).max(10);
                let mut wrapped = wrap_words(&value, first_width);
                let first = wrapped.first().cloned().unwrap_or_default();
                lines.push(format!("{label}: {first}"));
                let rest = wrapped.drain(1..).collect::<Vec<_>>().join(" ");
                for line in wrap_words(&rest, next_width) {
                    let line = line.trim_start();
                    if line.is_empty() {
                        continue;
                    }
                    lines.push(format!("  {line}"));
                }
            }
        }
        for (index, line) in lines.into_iter().enumerate() {
            let prefix = if index == 0 {
                first_prefix
            } else {
                continuation
            };
            self.rows
                .push(Row::new(RowStyle::TableRow, format!("{prefix}{line}")));
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
        // `figures.BLOCKQUOTE_BAR` plus a space per nesting level.
        let quote = format!("{BLOCKQUOTE_BAR} ").repeat(self.quote_depth);
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
        for (index, line) in wrap_words(text, available).into_iter().enumerate() {
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

/// Blockquote prefix (`figures.BLOCKQUOTE_BAR` plus one space).
const BLOCKQUOTE_BAR: &str = "▎";

/// Ink's `MIN_COLUMN_WIDTH` for table columns.
const MIN_COLUMN_WIDTH: usize = 3;

/// Ink's `MAX_ROW_LINES`: taller rows switch the table to vertical form.
const MAX_ROW_LINES: usize = 4;

/// Ink's `SAFETY_MARGIN` when sizing tables against the terminal width.
const TABLE_SAFETY_MARGIN: usize = 4;

fn display_width(text: &str) -> usize {
    UnicodeWidthStr::width(text)
}

/// One border line of the box table, e.g. `┌───┬───┐`.
fn border_line(widths: &[usize], [left, mid, cross, right]: [char; 4]) -> String {
    let mut line = String::new();
    line.push(left);
    for (index, width) in widths.iter().enumerate() {
        line.push_str(&mid.to_string().repeat(width + 2));
        line.push(if index + 1 < widths.len() {
            cross
        } else {
            right
        });
    }
    line
}

/// Append the wrapped lines of one table row, padding and aligning each cell.
/// Cells are centred vertically, exactly like `MarkdownTable.tsx`.
fn push_row_lines(
    out: &mut Vec<String>,
    cells: &[Vec<String>],
    widths: &[usize],
    header: bool,
    align: &[Alignment],
) {
    let height = cells.iter().map(Vec::len).max().unwrap_or(1).max(1);
    for line_index in 0..height {
        let mut line = String::from("│");
        for (column, cell) in cells.iter().enumerate() {
            let offset = (height - cell.len()) / 2;
            let text = line_index
                .checked_sub(offset)
                .and_then(|index| cell.get(index))
                .map(String::as_str)
                .unwrap_or("");
            let width = widths[column];
            // Headers are always centred; data rows use the column alignment.
            let alignment = if header {
                Alignment::Center
            } else {
                align.get(column).copied().unwrap_or(Alignment::None)
            };
            line.push(' ');
            line.push_str(&align_cell(text, width, alignment));
            line.push_str(" │");
        }
        out.push(line);
    }
}

/// Width of the longest word in `text`, at least [`MIN_COLUMN_WIDTH`].
fn longest_word_width(text: &str) -> usize {
    text.split_whitespace()
        .map(display_width)
        .max()
        .unwrap_or(0)
        .max(MIN_COLUMN_WIDTH)
}

/// Wrap one table cell and drop the empty lines a trailing break may leave.
fn wrap_cell(text: &str, width: usize) -> Vec<String> {
    let lines: Vec<String> = wrap_words(text, width)
        .into_iter()
        .map(|line| line.trim().to_string())
        .filter(|line| !line.is_empty())
        .collect();
    if lines.is_empty() {
        vec![String::new()]
    } else {
        lines
    }
}

/// Word-wrap `text` to `width` display columns, preserving explicit newlines.
///
/// Breaks prefer spaces (Ink's `wordWrap: true`); a word wider than the line —
/// or a run without spaces, like CJK — is hard-broken so nothing is dropped.
fn wrap_words(text: &str, width: usize) -> Vec<String> {
    if width == 0 {
        return Vec::new();
    }
    let mut rows = Vec::new();
    for line in text.split('\n') {
        let expanded = line.replace('\t', "    ");
        wrap_line(&expanded, width, &mut rows);
    }
    rows
}

fn wrap_line(line: &str, width: usize, rows: &mut Vec<String>) {
    let mut current = String::new();
    let mut used = 0usize;
    for (is_space, chunk) in chunks(line) {
        let chunk_width = display_width(chunk);
        if is_space {
            // Leading spaces of a continuation line are dropped; a space that
            // would end the line is dropped too (the word starts a new row).
            if !current.is_empty() && used + chunk_width <= width {
                current.push_str(chunk);
                used += chunk_width;
            }
            continue;
        }
        if !current.is_empty() && used + chunk_width > width {
            rows.push(std::mem::take(&mut current).trim_end().to_string());
            used = 0;
        }
        if chunk_width <= width {
            current.push_str(chunk);
            used += chunk_width;
            continue;
        }
        // Overlong word: hard-break it at the display-width boundary.
        for ch in chunk.chars() {
            let char_width = ch.width().unwrap_or(0);
            if used + char_width > width && used > 0 {
                rows.push(std::mem::take(&mut current));
                used = 0;
            }
            current.push(ch);
            used += char_width;
        }
    }
    rows.push(current.trim_end().to_string());
}

/// Split a line into alternating word / whitespace chunks (space runs only).
fn chunks(line: &str) -> Vec<(bool, &str)> {
    let mut out: Vec<(bool, &str)> = Vec::new();
    let mut start = 0usize;
    let mut state: Option<bool> = None;
    for (index, ch) in line.char_indices() {
        let is_space = ch == ' ';
        match state {
            None => {
                state = Some(is_space);
                start = index;
            }
            Some(previous) if previous != is_space => {
                out.push((previous, &line[start..index]));
                state = Some(is_space);
                start = index;
            }
            _ => {}
        }
    }
    if let Some(is_space) = state {
        out.push((is_space, &line[start..]));
    }
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
        assert_eq!(texts(&rows), ["One", "", "Two", "", "Six"]);
        assert_eq!(rows[0].style, RowStyle::Heading(1));
        assert_eq!(rows[2].style, RowStyle::Heading(2));
        assert_eq!(rows[4].style, RowStyle::Heading(6));
        assert!(rows[1].text.is_empty() && rows[3].text.is_empty());
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
    fn wraps_prose_between_words_like_ink() {
        let rows = render_markdown("hello world foo", 8);
        assert_eq!(texts(&rows), ["hello", "world", "foo"]);

        let rows = render_markdown("aaaaa bbbbb", 6);
        assert_eq!(texts(&rows), ["aaaaa", "bbbbb"]);
    }

    #[test]
    fn separates_paragraphs_but_not_list_items() {
        let rows = render_markdown("one\n\ntwo", 80);
        assert_eq!(texts(&rows), ["one", "", "two"]);

        let rows = render_markdown("- one\n- two", 80);
        assert_eq!(texts(&rows), ["- one", "- two"]);
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
        // `figures.BLOCKQUOTE_BAR` plus a space, then a blank separator.
        assert_eq!(texts(&rows), ["▎ quoted text", "", "---"]);
        assert_eq!(rows[0].style, RowStyle::Blockquote);
        assert_eq!(rows[2].style, RowStyle::Rule);
    }

    #[test]
    fn nests_blockquote_bars() {
        let rows = render_markdown("> outer\n>> inner", 40);
        assert_eq!(texts(&rows), ["▎ outer", "▎ ▎ inner"]);
        assert_eq!(rows[0].style, RowStyle::Blockquote);
        assert_eq!(rows[1].style, RowStyle::Blockquote);
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
    fn renders_box_tables_with_aligned_columns() {
        let input = "| Name | Qty |\n| :--- | ---: |\n| apple | 3 |\n| banana | 12 |\n";
        let rows = render_markdown(input, 40);
        assert_eq!(
            texts(&rows),
            [
                "┌────────┬─────┐",
                "│  Name  │ Qty │",
                "├────────┼─────┤",
                "│ apple  │   3 │",
                "├────────┼─────┤",
                "│ banana │  12 │",
                "└────────┴─────┘",
            ]
        );
        assert_eq!(rows[1].style, RowStyle::TableHeader);
        assert!(
            rows.iter()
                .filter(|row| row.style != RowStyle::TableHeader)
                .all(|row| row.style == RowStyle::TableRow)
        );
        assert!(rows.iter().all(|row| display_width(&row.text) <= 40));
    }

    #[test]
    fn flattens_inline_formatting_inside_table_cells() {
        let input = "| **bold** | `code` |\n| --- | ---: |\n| plain | *em* |\n";
        let rows = render_markdown(input, 40);
        assert_eq!(
            texts(&rows),
            [
                "┌───────┬──────┐",
                "│ bold  │ code │",
                "├───────┼──────┤",
                "│ plain │   em │",
                "└───────┴──────┘",
            ]
        );
    }

    #[test]
    fn sizes_cjk_table_cells_by_display_width() {
        let input = "| 名 | 数量 |\n| --- | --- |\n| 汉字 | 很多 |\n";
        let rows = render_markdown(input, 40);
        assert_eq!(
            texts(&rows),
            [
                "┌──────┬──────┐",
                "│  名  │ 数量 │",
                "├──────┼──────┤",
                "│ 汉字 │ 很多 │",
                "└──────┴──────┘",
            ]
        );
        let widths: Vec<usize> = rows.iter().map(|row| display_width(&row.text)).collect();
        assert_eq!(widths, [15, 15, 15, 15, 15]);
    }

    #[test]
    fn narrow_tables_degrade_to_the_vertical_form() {
        let input = "| alpha | beta |\n| --- | ---: |\n| gamma | delta |\n";
        let rows = render_markdown(input, 12);
        assert_eq!(texts(&rows), ["alpha: gamma", "beta: delta"]);
        assert!(rows.iter().all(|row| row.style == RowStyle::TableRow));
        assert!(
            rows.iter().all(|row| display_width(&row.text) <= 12),
            "row wider than 12: {:?}",
            texts(&rows)
        );
    }

    #[test]
    fn tall_rows_degrade_to_the_vertical_form() {
        // This cell wraps to five lines at the column width the grid can
        // afford, past Ink's `MAX_ROW_LINES`.
        let input = "| key | value |\n| --- | --- |\n| a | one two three four five six |\n";
        let rows = render_markdown(input, 20);
        assert!(rows.iter().any(|row| row.text.starts_with("key: ")));
        assert!(rows.iter().any(|row| row.text.starts_with("value: ")));
        assert!(rows.iter().all(|row| !row.text.starts_with('│')));
    }

    #[test]
    fn links_render_their_text_and_mailto_shows_the_address() {
        let rows = render_markdown("[docs](https://example.com/docs)", 80);
        assert_eq!(texts(&rows), ["docs"]);

        let rows = render_markdown("[email me](mailto:me@example.com)", 80);
        assert_eq!(texts(&rows), ["me@example.com"]);

        let rows = render_markdown("[a **bold** link](https://x.y)", 80);
        assert_eq!(texts(&rows), ["a bold link"]);
    }

    #[test]
    fn images_render_as_their_destination() {
        let rows = render_markdown("![a diagram](diagram.png)", 80);
        assert_eq!(texts(&rows), ["diagram.png"]);

        let rows = render_markdown("before ![alt **text**](x.png) after", 80);
        assert_eq!(texts(&rows), ["before x.png after"]);
    }

    #[test]
    fn tables_and_paragraphs_keep_their_order_and_styles() {
        let input = "Intro paragraph.\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\nAfter the table.\n";
        let rows = render_markdown(input, 40);
        assert_eq!(
            texts(&rows),
            [
                "Intro paragraph.",
                "",
                "┌─────┬─────┐",
                "│  A  │  B  │",
                "├─────┼─────┤",
                "│ 1   │ 2   │",
                "└─────┴─────┘",
                "",
                "After the table.",
            ]
        );
        let styles: Vec<RowStyle> = rows.iter().map(|row| row.style).collect();
        assert_eq!(
            styles,
            [
                RowStyle::Assistant,
                RowStyle::Assistant,
                RowStyle::TableRow,
                RowStyle::TableHeader,
                RowStyle::TableRow,
                RowStyle::TableRow,
                RowStyle::TableRow,
                RowStyle::Assistant,
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
