//! Rendering backend: inline viewport, scrollback insertion, and the live
//! status/input region.
//!
//! Design: completed transcript rows are pushed into the terminal's own
//! scrollback with `insert_before` and then forgotten. Only the live region
//! (streaming text, input line, status) is redrawn, which keeps memory flat in
//! long sessions.

use std::io::{self, Stdout};

use cch_tui_ui::{ChatView, Row, RowStyle, wrap_text};
use ratatui::backend::CrosstermBackend;
use ratatui::crossterm::cursor::{MoveToColumn, SetCursorStyle, Show};
use ratatui::crossterm::event::{DisableBracketedPaste, EnableBracketedPaste};
use ratatui::crossterm::execute;
use ratatui::crossterm::terminal::{
    EnterAlternateScreen, LeaveAlternateScreen, disable_raw_mode, enable_raw_mode,
};
use ratatui::layout::{Constraint, Layout};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Paragraph, Widget};
use ratatui::{Frame, Terminal, TerminalOptions, Viewport};

/// Cells the inline viewport reserves below frozen scrollback.
pub const DEFAULT_INLINE_HEIGHT: u16 = 12;

/// Live terminal bound to an inline viewport.
pub struct TerminalSession {
    terminal: Terminal<CrosstermBackend<Stdout>>,
    fullscreen: bool,
}

impl TerminalSession {
    /// Enter raw mode and reserve an inline viewport at the cursor position.
    pub fn inline(height: u16) -> io::Result<Self> {
        enable_raw_mode()?;
        let mut stdout = io::stdout();
        execute!(stdout, EnableBracketedPaste, Show)?;
        let backend = CrosstermBackend::new(stdout);
        let terminal = Terminal::with_options(
            backend,
            TerminalOptions {
                viewport: Viewport::Inline(height.max(4)),
            },
        )?;
        Ok(Self {
            terminal,
            fullscreen: false,
        })
    }

    /// Enter the alternate screen (fullscreen mode).
    pub fn fullscreen() -> io::Result<Self> {
        enable_raw_mode()?;
        let mut stdout = io::stdout();
        execute!(stdout, EnterAlternateScreen, EnableBracketedPaste)?;
        let backend = CrosstermBackend::new(stdout);
        let terminal = Terminal::new(backend)?;
        Ok(Self {
            terminal,
            fullscreen: true,
        })
    }

    /// Freeze `rows` into the terminal scrollback.
    ///
    /// Rows are wrapped to the current width first, so the inserted block has
    /// an exact height (the inline viewport would otherwise scroll).
    pub fn insert_rows(&mut self, rows: &[Row]) -> io::Result<()> {
        if rows.is_empty() {
            return Ok(());
        }
        let width = self.terminal.size()?.width.max(1) as usize;
        let lines = rows_to_lines(rows, width);
        if lines.is_empty() {
            return Ok(());
        }
        let height = lines.len() as u16;
        self.terminal.insert_before(height, |buf| {
            Paragraph::new(lines).render(buf.area, buf);
        })?;
        Ok(())
    }

    pub fn draw(&mut self, view: &ChatView) -> io::Result<()> {
        self.terminal.draw(|frame| draw_view(frame, view))?;
        Ok(())
    }

    /// Fullscreen frame: the transcript window above the prompt and status.
    pub fn draw_transcript(
        &mut self,
        view: &ChatView,
        model: &mut cch_tui_fullscreen::TranscriptModel,
    ) -> io::Result<()> {
        let size = self.terminal.size()?;
        let width = size.width.max(1) as usize;
        let reserved = input_height(&view.input) as usize + 1;
        let transcript_height = (size.height as usize).saturating_sub(reserved).max(1);
        let lines = transcript_lines(model, transcript_height, width);
        self.terminal.draw(|frame| {
            let area = frame.area();
            let chunks = Layout::vertical([
                Constraint::Min(1),
                Constraint::Length(input_height(&view.input)),
                Constraint::Length(1),
            ])
            .split(area);
            frame.render_widget(Paragraph::new(lines.clone()), chunks[0]);
            draw_prompt(frame, view, chunks[1]);
            draw_status(frame, view, chunks[2]);
        })?;
        Ok(())
    }

    pub fn is_fullscreen(&self) -> bool {
        self.fullscreen
    }

    pub fn restore(&mut self) -> io::Result<()> {
        disable_raw_mode()?;
        execute!(
            self.terminal.backend_mut(),
            DisableBracketedPaste,
            Show,
            MoveToColumn(0),
            SetCursorStyle::DefaultUserShape
        )?;
        if self.fullscreen {
            execute!(self.terminal.backend_mut(), LeaveAlternateScreen)?;
        }
        self.terminal.show_cursor()?;
        Ok(())
    }
}

impl Drop for TerminalSession {
    fn drop(&mut self) {
        let _ = self.restore();
    }
}

/// Convert domain rows into wrapped, styled terminal lines.
///
/// Assistant prose goes through the Markdown renderer at the target width;
/// everything else (user input, tool output, errors) is wrapped verbatim.
fn rows_to_lines(rows: &[Row], width: usize) -> Vec<Line<'static>> {
    let mut lines = Vec::new();
    let mut index = 0;
    while index < rows.len() {
        let row = &rows[index];
        // Consecutive code-block rows are highlighted as one unit so the
        // language fence applies to the whole block.
        if row.style == RowStyle::CodeBlock {
            let start = index;
            while index < rows.len() && rows[index].style == RowStyle::CodeBlock {
                index += 1;
            }
            lines.extend(code_block_lines(&rows[start..index]));
            continue;
        }
        index += 1;
        let styled_rows = match row.style {
            RowStyle::Assistant => cch_tui_markdown::render_markdown(&row.text, width),
            _ => wrap_text(&row.text, width)
                .into_iter()
                .map(|line| Row::new(row.style, line))
                .collect(),
        };
        for styled in &styled_rows {
            lines.push(Line::from(Span::styled(
                styled.text.clone(),
                row_style(styled.style),
            )));
        }
    }
    lines
}

/// Highlight a fenced (or indented) code block. Fence lines are dropped; the
/// inner code keeps one terminal line per source line so highlighting stays
/// aligned with line numbers.
fn code_block_lines(block: &[Row]) -> Vec<Line<'static>> {
    let mut inner = block;
    let mut language: Option<&str> = None;
    if let Some(first) = block.first() {
        let fence = first.text.trim_start();
        if let Some(rest) = fence.strip_prefix("```") {
            language = Some(rest.trim()).filter(|value| !value.is_empty());
            inner = &block[1..];
            if let Some(last) = inner.last()
                && last.text.trim() == "```"
            {
                inner = &inner[..inner.len() - 1];
            }
        }
    }

    let code = inner
        .iter()
        .map(|row| row.text.as_str())
        .collect::<Vec<_>>()
        .join("\n");
    let highlighted = cch_tui_highlight::highlight_lines(&code, language);
    if highlighted.is_empty() {
        return Vec::new();
    }
    highlighted
        .iter()
        .map(|line| {
            let spans: Vec<Span<'static>> = line
                .spans
                .iter()
                .map(|span| Span::styled(span.text.clone(), token_style(span.kind)))
                .collect();
            Line::from(spans)
        })
        .collect()
}

fn token_style(kind: cch_tui_highlight::TokenKind) -> Style {
    use cch_tui_highlight::TokenKind;
    match kind {
        TokenKind::Keyword => Style::default().fg(Color::Magenta),
        TokenKind::String => Style::default().fg(Color::Green),
        TokenKind::Comment => Style::default().fg(Color::DarkGray),
        TokenKind::Number => Style::default().fg(Color::Cyan),
        TokenKind::Function => Style::default().fg(Color::Blue),
        TokenKind::Type => Style::default().fg(Color::Yellow),
        TokenKind::Variable => Style::default(),
        TokenKind::Punctuation => Style::default().fg(Color::DarkGray),
        TokenKind::Plain => Style::default().fg(Color::Green),
    }
}

/// Render diff rows with `+`/`-` prefixes and the usual colors.
pub fn diff_to_lines(rows: &[cch_tui_diff::DiffRow]) -> Vec<Line<'static>> {
    use cch_tui_diff::DiffKind;
    rows.iter()
        .map(|row| {
            if row.is_marker() {
                return Line::from(Span::styled(
                    row.text.clone(),
                    Style::default().fg(Color::DarkGray),
                ));
            }
            let (prefix, style) = match row.kind {
                DiffKind::Added => ("+ ", Style::default().fg(Color::Green)),
                DiffKind::Removed => ("- ", Style::default().fg(Color::Red)),
                DiffKind::Context => ("  ", Style::default()),
            };
            Line::from(Span::styled(format!("{prefix}{}", row.text), style))
        })
        .collect()
}

fn row_style(style: RowStyle) -> Style {
    match style {
        RowStyle::User => Style::default().fg(Color::Cyan),
        RowStyle::Assistant => Style::default(),
        RowStyle::System => Style::default().fg(Color::DarkGray),
        RowStyle::Error => Style::default().fg(Color::Red),
        RowStyle::Tool => Style::default().fg(Color::Yellow),
        // Markdown row roles. The markdown crate emits the text (markers,
        // prefixes and indentation included); these only pick a palette token.
        RowStyle::Heading(_) => Style::default().add_modifier(Modifier::BOLD),
        RowStyle::InlineCode => Style::default().fg(Color::Magenta),
        RowStyle::CodeBlock => Style::default().fg(Color::Green),
        RowStyle::ListItem => Style::default(),
        RowStyle::Blockquote => Style::default().fg(Color::DarkGray),
        RowStyle::Rule => Style::default().fg(Color::DarkGray),
    }
}

/// Paint the live region: streaming text, input line, status line.
pub fn draw_view(frame: &mut Frame, view: &ChatView) {
    let area = frame.area();
    let chunks = Layout::vertical([
        Constraint::Min(1),
        Constraint::Length(input_height(&view.input)),
        Constraint::Length(1),
    ])
    .split(area);

    let live = Paragraph::new(view.live_text.as_str()).style(Style::default());
    frame.render_widget(live, chunks[0]);

    draw_prompt(frame, view, chunks[1]);
    draw_status(frame, view, chunks[2]);
}

fn draw_prompt(frame: &mut Frame, view: &ChatView, area: ratatui::layout::Rect) {
    let raw_lines: Vec<&str> = view.input.split('\n').collect();
    let input_text = raw_lines
        .iter()
        .enumerate()
        .map(|(index, line)| {
            if index == 0 {
                format!("> {line}")
            } else {
                format!("  {line}")
            }
        })
        .collect::<Vec<_>>()
        .join("\n");
    let input = Paragraph::new(input_text).style(Style::default().add_modifier(Modifier::BOLD));
    frame.render_widget(input, area);

    // Cursor at the end of the last input line, clamped to the viewport.
    let last_visible = raw_lines
        .len()
        .min(MAX_INPUT_LINES as usize)
        .saturating_sub(1);
    let last_line = raw_lines.get(last_visible).copied().unwrap_or("");
    let cursor_x = 2 + unicode_width::UnicodeWidthStr::width(last_line);
    let x = area.x as usize + cursor_x.min(area.width.saturating_sub(1) as usize);
    let y = area.y + last_visible as u16;
    frame.set_cursor_position((x as u16, y.min(area.bottom().saturating_sub(1))));
}

fn draw_status(frame: &mut Frame, view: &ChatView, area: ratatui::layout::Rect) {
    let status = Paragraph::new(view.status_line()).style(Style::default().fg(Color::DarkGray));
    frame.render_widget(status, area);
}

/// Convert the visible window of a transcript model into terminal lines.
pub fn transcript_lines(
    model: &mut cch_tui_fullscreen::TranscriptModel,
    height: usize,
    width: usize,
) -> Vec<Line<'static>> {
    let range = model.window(height, width);
    rows_to_lines(&model.rows()[range], width)
}

/// Rows reserved for the prompt: one per input line, capped so the live area
/// never collapses.
const MAX_INPUT_LINES: u16 = 6;

fn input_height(input: &str) -> u16 {
    let lines = input.split('\n').count() as u16;
    lines.clamp(1, MAX_INPUT_LINES)
}

#[cfg(test)]
mod tests {
    use super::*;
    use cch_tui_proto::parse_line;
    use ratatui::Terminal;

    fn render(view: &ChatView, width: u16, height: u16) -> String {
        let backend = ratatui::backend::TestBackend::new(width, height);
        let mut terminal = Terminal::new(backend).expect("terminal");
        terminal.draw(|frame| draw_view(frame, view)).expect("draw");
        let buffer = terminal.backend().buffer().clone();
        let mut out = String::new();
        for y in 0..buffer.area.height {
            for x in 0..buffer.area.width {
                out.push_str(buffer[(x, y)].symbol());
            }
            out.push('\n');
        }
        out
    }

    #[test]
    fn paints_live_text_input_and_status() {
        let mut view = ChatView::new();
        view.ingest(
            &parse_line(r#"{"type":"system","subtype":"init","session_id":"s1","model":"m1"}"#)
                .unwrap(),
        );
        view.live_text = "streaming".into();
        view.input = "hi".into();

        let screen = render(&view, 40, 6);
        assert!(screen.contains("streaming"), "screen: {screen}");
        assert!(screen.contains("> hi"), "screen: {screen}");
        assert!(screen.contains("m1 · session s1"), "screen: {screen}");
    }

    #[test]
    fn wraps_long_live_text_within_the_viewport() {
        let mut view = ChatView::new();
        view.live_text = "x".repeat(100);
        let screen = render(&view, 20, 8);
        // Every displayed line must respect the 20-column viewport.
        for line in screen.lines() {
            assert!(line.chars().count() <= 20, "line too wide: {line:?}");
        }
    }

    #[test]
    fn assistant_rows_are_markdown_rendered() {
        let rows = vec![Row::new(RowStyle::Assistant, "# Title\n- item")];
        let lines = rows_to_lines(&rows, 40);
        let texts: Vec<String> = lines.iter().map(|line| line.to_string()).collect();
        assert!(texts.iter().any(|text| text.contains("Title")), "{texts:?}");
        assert!(
            !texts.iter().any(|text| text.contains("# Title")),
            "{texts:?}"
        );
        assert!(texts.iter().any(|text| text.contains("item")), "{texts:?}");
    }

    #[test]
    fn multi_line_input_grows_and_keeps_prompt_prefix() {
        let mut view = ChatView::new();
        view.input = "first\nsecond".into();
        let screen = render(&view, 40, 8);
        assert!(screen.contains("> first"), "screen: {screen}");
        assert!(screen.contains("  second"), "screen: {screen}");
    }

    #[test]
    fn input_height_is_capped() {
        assert_eq!(input_height(""), 1);
        assert_eq!(input_height("a\nb\nc"), 3);
        assert_eq!(input_height(&"x\n".repeat(20)), MAX_INPUT_LINES);
    }

    #[test]
    fn fenced_code_blocks_are_highlighted_without_fence_lines() {
        let rows = vec![
            Row::new(RowStyle::CodeBlock, "```rust"),
            Row::new(RowStyle::CodeBlock, "let x = 1;"),
            Row::new(RowStyle::CodeBlock, "```"),
        ];
        let lines = rows_to_lines(&rows, 40);
        assert_eq!(lines.len(), 1);
        let text: String = lines[0].spans.iter().map(|s| s.content.as_ref()).collect();
        assert_eq!(text, "let x = 1;");
        assert!(lines[0].spans.len() > 1, "expected highlighted spans");
        assert!(
            lines[0]
                .spans
                .iter()
                .any(|s| s.content.contains("let") && s.style.fg == Some(Color::Magenta)),
            "keyword should be magenta"
        );
    }

    #[test]
    fn diff_rows_get_prefixes_and_colors() {
        let rows = cch_tui_diff::diff_lines("a\nb", "a\nc");
        let lines = diff_to_lines(&rows);
        let texts: Vec<String> = lines.iter().map(|l| l.to_string()).collect();
        assert!(texts.iter().any(|t| t == "  a"), "{texts:?}");
        assert!(texts.iter().any(|t| t == "- b"), "{texts:?}");
        assert!(texts.iter().any(|t| t == "+ c"), "{texts:?}");
        let removed = lines
            .iter()
            .find(|l| l.to_string().starts_with("- "))
            .expect("removed line");
        assert_eq!(removed.spans[0].style.fg, Some(Color::Red));
    }

    #[test]
    fn transcript_window_follows_tail_and_scrolls() {
        let mut model = cch_tui_fullscreen::TranscriptModel::new();
        model.append((0..50).map(|i| Row::new(RowStyle::User, format!("line {i}"))));

        let lines = transcript_lines(&mut model, 6, 40);
        let texts: Vec<String> = lines.iter().map(|line| line.to_string()).collect();
        assert!(
            texts.iter().any(|text| text == "line 49"),
            "tail not visible: {texts:?}"
        );

        model.scroll_to_top();
        let lines = transcript_lines(&mut model, 6, 40);
        let texts: Vec<String> = lines.iter().map(|line| line.to_string()).collect();
        assert!(
            texts.iter().any(|text| text == "line 0"),
            "top not visible: {texts:?}"
        );
        assert!(!model.is_following());
    }

    #[test]
    fn user_rows_are_verbatim() {
        let rows = vec![Row::new(RowStyle::User, "# not a heading")];
        let lines = rows_to_lines(&rows, 40);
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0].to_string(), "# not a heading");
    }

    #[test]
    fn status_line_shows_pending_permission() {
        let mut view = ChatView::new();
        view.ingest(
            &parse_line(
                r#"{"type":"control_request","request_id":"r1","request":{"subtype":"can_use_tool","tool_name":"Bash","tool_use_id":"t1"}}"#,
            )
            .unwrap(),
        );
        let screen = render(&view, 60, 6);
        assert!(screen.contains("permission"), "screen: {screen}");
    }
}
