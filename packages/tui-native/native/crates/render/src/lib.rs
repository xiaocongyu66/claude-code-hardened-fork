//! Rendering backend: inline viewport, scrollback insertion, and the live
//! status/input region.
//!
//! Design: completed transcript rows are pushed into the terminal's own
//! scrollback with `insert_before` and then forgotten. Only the live region
//! (streaming text, input line, status) is redrawn, which keeps memory flat in
//! long sessions.

use std::io::{self, Stdout};

use cch_tui_theme::Theme;
use cch_tui_ui::{ChatView, Row, RowStyle, wrap_text};
use ratatui::backend::CrosstermBackend;
use ratatui::crossterm::cursor::{MoveToColumn, SetCursorStyle, Show};
use ratatui::crossterm::event::{DisableBracketedPaste, EnableBracketedPaste};
use ratatui::crossterm::execute;
use ratatui::crossterm::terminal::{
    EnterAlternateScreen, LeaveAlternateScreen, disable_raw_mode, enable_raw_mode,
};
use ratatui::layout::{Constraint, Layout, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Paragraph, Widget};
use ratatui::{Frame, Terminal, TerminalOptions, Viewport};
use unicode_width::{UnicodeWidthChar, UnicodeWidthStr};

/// Cells the inline viewport reserves below frozen scrollback.
pub const DEFAULT_INLINE_HEIGHT: u16 = 12;

/// Live terminal bound to an inline viewport.
pub struct TerminalSession {
    terminal: Terminal<CrosstermBackend<Stdout>>,
    fullscreen: bool,
    theme: Theme,
    /// Prompt text pinned above the transcript while scrolled up.
    sticky_prompt: Option<String>,
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
            theme: Theme::dark(),
            sticky_prompt: None,
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
            theme: Theme::dark(),
            sticky_prompt: None,
        })
    }

    /// Replace the palette used for subsequent draws. Defaults to
    /// [`Theme::dark`].
    pub fn set_theme(&mut self, theme: Theme) {
        self.theme = theme;
    }

    /// Select a built-in theme by name (`dark`/`light`); unknown names keep
    /// the current theme.
    pub fn set_theme_name(&mut self, name: &str) {
        if name.eq_ignore_ascii_case("dark") || name.eq_ignore_ascii_case("light") {
            self.theme = Theme::from_name(name);
        }
    }

    /// Pin `prompt` above the fullscreen transcript (sticky header).
    ///
    /// The header occupies one row at the top of the transcript region and is
    /// truncated to the terminal width. `None` (the default) hides it and
    /// gives the row back to the transcript.
    pub fn set_sticky_prompt(&mut self, prompt: Option<String>) {
        self.sticky_prompt = prompt;
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
        let lines = rows_to_lines(rows, width, &self.theme);
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
        let theme = self.theme;
        self.terminal.draw(|frame| draw_view(frame, view, &theme))?;
        Ok(())
    }

    /// Fullscreen frame: the transcript window above the prompt and status.
    pub fn draw_transcript(
        &mut self,
        view: &ChatView,
        model: &mut cch_tui_fullscreen::TranscriptModel,
    ) -> io::Result<()> {
        let theme = self.theme;
        let sticky = self.sticky_prompt.clone();
        let size = self.terminal.size()?;
        let width = size.width.max(1) as usize;
        let reserved = input_height(&view.input) as usize + 1;
        let sticky_height = usize::from(sticky.is_some());
        let transcript_height = (size.height as usize)
            .saturating_sub(reserved + sticky_height)
            .max(1);
        let lines = transcript_lines(model, transcript_height, width, &theme);
        let unseen = model.unseen_count();
        self.terminal.draw(|frame| {
            let area = frame.area();
            let chunks = Layout::vertical([
                Constraint::Min(1),
                Constraint::Length(input_height(&view.input)),
                Constraint::Length(1),
            ])
            .split(area);
            draw_transcript_region(frame, chunks[0], lines, &theme, sticky.as_deref(), unseen);
            draw_prompt(frame, view, chunks[1]);
            draw_status(frame, view, chunks[2], &theme);
        })?;
        Ok(())
    }

    /// Fullscreen frame with a task/agent sidebar on the right.
    pub fn draw_transcript_with_panel(
        &mut self,
        view: &ChatView,
        model: &mut cch_tui_fullscreen::TranscriptModel,
        panel: &cch_tui_panel::TaskPanel,
    ) -> io::Result<()> {
        let theme = self.theme;
        let sticky = self.sticky_prompt.clone();
        let size = self.terminal.size()?;
        let width = size.width.max(1) as usize;
        let reserved = input_height(&view.input) as usize + 1;
        let sticky_height = usize::from(sticky.is_some());
        let transcript_height = (size.height as usize)
            .saturating_sub(reserved + sticky_height)
            .max(1);
        // The sidebar takes ~30% and is only drawn when it has content.
        let sidebar_width = (width / 3).clamp(18, 44);
        let main_width = width.saturating_sub(sidebar_width + 1).max(1);
        let lines = transcript_lines(model, transcript_height, main_width, &theme);
        let unseen = model.unseen_count();
        let panel_lines = panel_lines(panel, sidebar_width.saturating_sub(2), &theme);
        self.terminal.draw(|frame| {
            let area = frame.area();
            let chunks = Layout::vertical([
                Constraint::Min(1),
                Constraint::Length(input_height(&view.input)),
                Constraint::Length(1),
            ])
            .split(area);
            let content =
                Layout::horizontal([Constraint::Min(1), Constraint::Length(sidebar_width as u16)])
                    .split(chunks[0]);
            draw_transcript_region(frame, content[0], lines, &theme, sticky.as_deref(), unseen);
            let block = ratatui::widgets::Block::bordered()
                .title(" Tasks ")
                .border_style(Style::default().fg(theme.palette.border));
            frame.render_widget(Paragraph::new(panel_lines).block(block), content[1]);
            draw_prompt(frame, view, chunks[1]);
            draw_status(frame, view, chunks[2], &theme);
        })?;
        Ok(())
    }

    /// Copy text through the terminal (OSC52). Works over SSH and tmux
    /// (with `set-clipboard on`); no platform clipboard binary required.
    pub fn copy_to_clipboard(&mut self, text: &str) -> io::Result<()> {
        use std::io::Write as _;
        let mut stdout = io::stdout();
        stdout.write_all(osc52_sequence(text).as_bytes())?;
        stdout.flush()
    }

    pub fn is_fullscreen(&self) -> bool {
        self.fullscreen
    }

    /// Draw the live view with the permission dialog on top.
    pub fn draw_with_permission(
        &mut self,
        view: &ChatView,
        dialog: &cch_tui_dialog::PermissionDialog,
    ) -> io::Result<()> {
        let theme = self.theme;
        self.terminal.draw(|frame| {
            draw_view(frame, view, &theme);
            draw_permission(frame, dialog, &theme);
        })?;
        Ok(())
    }

    /// Fullscreen variant of [`Self::draw_with_permission`].
    pub fn draw_transcript_with_permission(
        &mut self,
        view: &ChatView,
        model: &mut cch_tui_fullscreen::TranscriptModel,
        dialog: &cch_tui_dialog::PermissionDialog,
    ) -> io::Result<()> {
        let theme = self.theme;
        let sticky = self.sticky_prompt.clone();
        let size = self.terminal.size()?;
        let width = size.width.max(1) as usize;
        let reserved = input_height(&view.input) as usize + 1;
        let sticky_height = usize::from(sticky.is_some());
        let transcript_height = (size.height as usize)
            .saturating_sub(reserved + sticky_height)
            .max(1);
        let lines = transcript_lines(model, transcript_height, width, &theme);
        let unseen = model.unseen_count();
        self.terminal.draw(|frame| {
            let area = frame.area();
            let chunks = Layout::vertical([
                Constraint::Min(1),
                Constraint::Length(input_height(&view.input)),
                Constraint::Length(1),
            ])
            .split(area);
            draw_transcript_region(frame, chunks[0], lines, &theme, sticky.as_deref(), unseen);
            draw_prompt(frame, view, chunks[1]);
            draw_status(frame, view, chunks[2], &theme);
            draw_permission(frame, dialog, &theme);
        })?;
        Ok(())
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

/// OSC52 clipboard sequence: `ESC ] 52 ; c ; <base64> BEL`.
pub fn osc52_sequence(text: &str) -> String {
    use base64::Engine as _;
    let encoded = base64::engine::general_purpose::STANDARD.encode(text.as_bytes());
    format!("\x1b]52;c;{encoded}\x07")
}

/// Convert domain rows into wrapped, styled terminal lines.
///
/// Assistant prose goes through the Markdown renderer at the target width;
/// everything else (user input, tool output, errors) is wrapped verbatim.
fn rows_to_lines(rows: &[Row], width: usize, theme: &Theme) -> Vec<Line<'static>> {
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
            lines.extend(code_block_lines(&rows[start..index], theme));
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
                row_style(styled.style, theme),
            )));
        }
    }
    lines
}

/// Highlight a fenced (or indented) code block. Fence lines are dropped; the
/// inner code keeps one terminal line per source line so highlighting stays
/// aligned with line numbers.
fn code_block_lines(block: &[Row], theme: &Theme) -> Vec<Line<'static>> {
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
                .map(|span| Span::styled(span.text.clone(), token_style(span.kind, theme)))
                .collect();
            Line::from(spans)
        })
        .collect()
}

fn token_style(kind: cch_tui_highlight::TokenKind, theme: &Theme) -> Style {
    use cch_tui_highlight::TokenKind;
    let palette = theme.palette;
    match kind {
        TokenKind::Keyword => Style::default().fg(palette.keyword),
        TokenKind::String => Style::default().fg(palette.string),
        TokenKind::Comment => Style::default().fg(palette.comment),
        TokenKind::Number => Style::default().fg(palette.number),
        TokenKind::Function => Style::default().fg(palette.function),
        TokenKind::Type => Style::default().fg(palette.r#type),
        TokenKind::Variable => Style::default(),
        TokenKind::Punctuation => Style::default().fg(palette.punctuation),
        TokenKind::Plain => Style::default().fg(palette.code_block),
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

/// Rows for the task sidebar.
pub fn panel_lines(
    panel: &cch_tui_panel::TaskPanel,
    width: usize,
    theme: &Theme,
) -> Vec<Line<'static>> {
    let rows = panel.rows(width);
    rows_to_lines(&rows, width, theme)
}

fn row_style(style: RowStyle, theme: &Theme) -> Style {
    let palette = theme.palette;
    match style {
        RowStyle::User => Style::default().fg(palette.user),
        RowStyle::Assistant => Style::default().fg(palette.assistant),
        RowStyle::System => Style::default().fg(palette.system),
        RowStyle::Error => Style::default().fg(palette.error),
        RowStyle::Tool => Style::default().fg(palette.tool),
        // Markdown row roles. The markdown crate emits the text (markers,
        // prefixes and indentation included); these only pick a palette token.
        RowStyle::Heading(_) => Style::default()
            .fg(palette.heading)
            .add_modifier(Modifier::BOLD),
        RowStyle::InlineCode => Style::default().fg(palette.inline_code),
        RowStyle::CodeBlock => Style::default().fg(palette.code_block),
        RowStyle::ListItem => Style::default().fg(palette.foreground),
        RowStyle::Blockquote => Style::default().fg(palette.dim),
        RowStyle::Rule => Style::default().fg(palette.dim),
        RowStyle::DiffHunk => Style::default()
            .fg(palette.accent)
            .add_modifier(Modifier::BOLD),
        RowStyle::DiffAdded => Style::default().fg(palette.string),
        RowStyle::DiffRemoved => Style::default().fg(palette.error),
        RowStyle::DiffContext => Style::default().fg(palette.dim),
        // Tables have no palette token yet; keep them legible with terminal
        // defaults until the theme grows table colors.
        RowStyle::TableHeader => Style::default()
            .fg(Color::DarkGray)
            .add_modifier(Modifier::BOLD),
        RowStyle::TableRow => Style::default(),
    }
}

/// Paint the live region: streaming text, input line, status line.
pub fn draw_view(frame: &mut Frame, view: &ChatView, theme: &Theme) {
    let area = frame.area();
    let chunks = Layout::vertical([
        Constraint::Min(1),
        Constraint::Length(input_height(&view.input)),
        Constraint::Length(1),
    ])
    .split(area);

    let live = Paragraph::new(view.live_text.as_str())
        .style(Style::default().fg(theme.palette.foreground));
    frame.render_widget(live, chunks[0]);

    draw_prompt(frame, view, chunks[1]);
    draw_status(frame, view, chunks[2], theme);
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

fn draw_status(frame: &mut Frame, view: &ChatView, area: ratatui::layout::Rect, theme: &Theme) {
    let status = Paragraph::new(view.status_line()).style(Style::default().fg(theme.palette.dim));
    frame.render_widget(status, area);
}

/// Draw the permission dialog as a centered overlay.
pub fn draw_permission(
    frame: &mut Frame,
    dialog: &cch_tui_dialog::PermissionDialog,
    theme: &Theme,
) {
    let area = frame.area();
    let width = area
        .width
        .saturating_mul(7)
        .saturating_div(10)
        .clamp(24, 78);
    let mut lines: Vec<Line<'static>> = Vec::new();
    lines.push(Line::from(Span::styled(
        format!("Tool: {}", dialog.tool_name()),
        Style::default().add_modifier(Modifier::BOLD),
    )));
    if let Some(description) = dialog.description() {
        for line in wrap_text(description, width.saturating_sub(4) as usize) {
            lines.push(Line::from(line));
        }
    }
    let input = serde_json::to_string_pretty(dialog.input()).unwrap_or_default();
    let mut input_lines = wrap_text(&input, width.saturating_sub(4) as usize);
    if input_lines.len() > 6 {
        input_lines.truncate(6);
        input_lines.push("…".into());
    }
    for line in input_lines {
        lines.push(Line::from(Span::styled(
            line,
            Style::default().fg(theme.palette.dim),
        )));
    }
    lines.push(Line::from(""));
    for (index, option) in dialog.options().iter().enumerate() {
        let marker = if index == dialog.selected() { ">" } else { " " };
        let style = if index == dialog.selected() {
            Style::default()
                .fg(theme.palette.accent)
                .add_modifier(Modifier::BOLD)
        } else {
            Style::default()
        };
        lines.push(Line::from(Span::styled(
            format!("{marker} {}", option.label()),
            style,
        )));
    }
    lines.push(Line::from(Span::styled(
        "↑/↓ select · Enter confirm · Esc cancel",
        Style::default().fg(theme.palette.dim),
    )));

    let height = (lines.len() as u16 + 2).min(area.height);
    let x = area.x + area.width.saturating_sub(width) / 2;
    let y = area.y + area.height.saturating_sub(height) / 2;
    let rect = ratatui::layout::Rect::new(x, y, width, height);
    frame.render_widget(ratatui::widgets::Clear, rect);
    let block = ratatui::widgets::Block::bordered()
        .title(" Permission required ")
        .border_style(Style::default().fg(theme.palette.border));
    let paragraph = Paragraph::new(lines)
        .block(block)
        .wrap(ratatui::widgets::Wrap { trim: false });
    frame.render_widget(paragraph, rect);
}

/// Convert the visible window of a transcript model into terminal lines.
pub fn transcript_lines(
    model: &mut cch_tui_fullscreen::TranscriptModel,
    height: usize,
    width: usize,
    theme: &Theme,
) -> Vec<Line<'static>> {
    let range = model.window(height, width);
    rows_to_lines(&model.rows()[range], width, theme)
}

/// Paint the transcript and its scroll chrome inside `area`.
///
/// When a sticky prompt is set it occupies the first row of `area` and the
/// transcript starts one row lower; otherwise the transcript gets the whole
/// area. The "new messages" pill floats over the bottom-right row without
/// changing the layout.
fn draw_transcript_region(
    frame: &mut Frame,
    area: Rect,
    lines: Vec<Line<'static>>,
    theme: &Theme,
    sticky: Option<&str>,
    unseen: usize,
) {
    let body = match sticky {
        Some(_) => Rect {
            y: area.y.saturating_add(1),
            height: area.height.saturating_sub(1),
            ..area
        },
        None => area,
    };
    frame.render_widget(Paragraph::new(lines), body);
    draw_transcript_chrome(frame, area, theme, sticky, unseen);
}

/// Draw sticky-prompt and new-message chrome for the transcript region.
///
/// The sticky header is a single dim row prefixed with `▸ `, truncated to the
/// region width. The pill is a dim `↓ N new` label aligned to the bottom-right
/// corner and is omitted when `unseen` is zero.
pub fn draw_transcript_chrome(
    frame: &mut Frame,
    area: Rect,
    theme: &Theme,
    sticky: Option<&str>,
    unseen: usize,
) {
    if area.width == 0 || area.height == 0 {
        return;
    }
    let style = Style::default().fg(theme.palette.dim);
    if let Some(text) = sticky {
        let flattened = text.replace(['\n', '\r'], " ");
        let line = truncate_to_width(&format!("▸ {flattened}"), area.width as usize);
        let rect = Rect::new(area.x, area.y, area.width, 1);
        frame.render_widget(Paragraph::new(Line::from(Span::styled(line, style))), rect);
    }
    if unseen > 0 {
        let label = truncate_to_width(&format!("↓ {unseen} new"), area.width as usize);
        let width = UnicodeWidthStr::width(label.as_str()) as u16;
        if width > 0 {
            let rect = Rect::new(
                area.right().saturating_sub(width),
                area.bottom().saturating_sub(1),
                width,
                1,
            );
            frame.render_widget(Paragraph::new(Line::from(Span::styled(label, style))), rect);
        }
    }
}

/// Truncate `text` to at most `width` display columns, never splitting a
/// double-width character in half.
fn truncate_to_width(text: &str, width: usize) -> String {
    let mut out = String::new();
    let mut used = 0;
    for ch in text.chars() {
        let char_width = UnicodeWidthChar::width(ch).unwrap_or(0);
        if used + char_width > width {
            break;
        }
        out.push(ch);
        used += char_width;
    }
    out
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

    fn buffer_screen(terminal: &Terminal<ratatui::backend::TestBackend>) -> String {
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

    fn render(view: &ChatView, width: u16, height: u16) -> String {
        let backend = ratatui::backend::TestBackend::new(width, height);
        let mut terminal = Terminal::new(backend).expect("terminal");
        terminal
            .draw(|frame| draw_view(frame, view, &Theme::dark()))
            .expect("draw");
        buffer_screen(&terminal)
    }

    fn chrome_screen(width: u16, height: u16, sticky: Option<&str>, unseen: usize) -> String {
        let backend = ratatui::backend::TestBackend::new(width, height);
        let mut terminal = Terminal::new(backend).expect("terminal");
        terminal
            .draw(|frame| {
                let area = frame.area();
                draw_transcript_chrome(frame, area, &Theme::dark(), sticky, unseen);
            })
            .expect("draw");
        buffer_screen(&terminal)
    }

    fn region_screen(width: u16, height: u16, sticky: Option<&str>, unseen: usize) -> String {
        let backend = ratatui::backend::TestBackend::new(width, height);
        let mut terminal = Terminal::new(backend).expect("terminal");
        terminal
            .draw(|frame| {
                let lines = ["row 0", "row 1", "row 2"]
                    .into_iter()
                    .map(Line::from)
                    .collect();
                draw_transcript_region(frame, frame.area(), lines, &Theme::dark(), sticky, unseen);
            })
            .expect("draw");
        buffer_screen(&terminal)
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
        let lines = rows_to_lines(&rows, 40, &Theme::dark());
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
        let theme = Theme::dark();
        let lines = rows_to_lines(&rows, 40, &theme);
        assert_eq!(lines.len(), 1);
        let text: String = lines[0].spans.iter().map(|s| s.content.as_ref()).collect();
        assert_eq!(text, "let x = 1;");
        assert!(lines[0].spans.len() > 1, "expected highlighted spans");
        assert!(
            lines[0]
                .spans
                .iter()
                .any(|s| s.content.contains("let") && s.style.fg == Some(theme.palette.keyword)),
            "keyword should use the theme keyword color"
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
    fn permission_dialog_renders_tool_options_and_selection() {
        let request = cch_tui_proto::CanUseToolRequest {
            tool_name: "Bash".into(),
            input: serde_json::Map::from_iter([(
                "command".into(),
                serde_json::Value::String("rm -rf /tmp/x".into()),
            )]),
            tool_use_id: "t1".into(),
            permission_suggestions: None,
            blocked_path: None,
            decision_reason: None,
            title: None,
            display_name: None,
            agent_id: None,
            description: Some("Run a shell command".into()),
        };
        let dialog = cch_tui_dialog::PermissionDialog::new("r1", request);

        let backend = ratatui::backend::TestBackend::new(70, 20);
        let mut terminal = Terminal::new(backend).expect("terminal");
        terminal
            .draw(|frame| draw_permission(frame, &dialog, &Theme::dark()))
            .expect("draw");
        let buffer = terminal.backend().buffer().clone();
        let mut screen = String::new();
        for y in 0..buffer.area.height {
            for x in 0..buffer.area.width {
                screen.push_str(buffer[(x, y)].symbol());
            }
            screen.push('\n');
        }

        assert!(screen.contains("Permission required"), "{screen}");
        assert!(screen.contains("Tool: Bash"), "{screen}");
        assert!(screen.contains("rm -rf /tmp/x"), "{screen}");
        assert!(screen.contains("> Allow once"), "{screen}");
        assert!(screen.contains("Deny"), "{screen}");
    }

    #[test]
    fn transcript_window_follows_tail_and_scrolls() {
        let mut model = cch_tui_fullscreen::TranscriptModel::new();
        model.append((0..50).map(|i| Row::new(RowStyle::User, format!("line {i}"))));

        let theme = Theme::dark();
        let lines = transcript_lines(&mut model, 6, 40, &theme);
        let texts: Vec<String> = lines.iter().map(|line| line.to_string()).collect();
        assert!(
            texts.iter().any(|text| text == "line 49"),
            "tail not visible: {texts:?}"
        );

        model.scroll_to_top();
        let lines = transcript_lines(&mut model, 6, 40, &theme);
        let texts: Vec<String> = lines.iter().map(|line| line.to_string()).collect();
        assert!(
            texts.iter().any(|text| text == "line 0"),
            "top not visible: {texts:?}"
        );
        assert!(!model.is_following());
    }

    #[test]
    fn task_panel_lines_show_titles() {
        let mut panel = cch_tui_panel::TaskPanel::new();
        panel.apply_engine_event(
            &parse_line(
                r#"{"type":"system","subtype":"task_started","task_id":"t1","task_type":"local_bash","description":"run tests","status":"running"}"#,
            )
            .unwrap(),
        );
        let lines = panel_lines(&panel, 30, &Theme::dark());
        assert!(
            lines
                .iter()
                .any(|line| line.to_string().contains("run tests")),
            "{lines:?}"
        );
    }

    #[test]
    fn osc52_sequence_encodes_text() {
        let sequence = osc52_sequence("hello");
        assert!(sequence.starts_with("\x1b]52;c;"), "{sequence:?}");
        assert!(sequence.ends_with('\x07'), "{sequence:?}");
        let payload = sequence
            .trim_start_matches("\x1b]52;c;")
            .trim_end_matches('\x07');
        use base64::Engine as _;
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(payload)
            .expect("base64");
        assert_eq!(String::from_utf8(decoded).expect("utf8"), "hello");
    }

    #[test]
    fn user_rows_are_verbatim() {
        let rows = vec![Row::new(RowStyle::User, "# not a heading")];
        let lines = rows_to_lines(&rows, 40, &Theme::dark());
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0].to_string(), "# not a heading");
    }

    #[test]
    fn rows_to_lines_use_theme_colors() {
        let theme = Theme::light();
        let rows = vec![
            Row::new(RowStyle::User, "hello"),
            Row::new(RowStyle::Error, "boom"),
            Row::new(RowStyle::Tool, "tool"),
            Row::new(RowStyle::System, "sys"),
        ];
        let lines = rows_to_lines(&rows, 40, &theme);
        let expected = [
            theme.palette.user,
            theme.palette.error,
            theme.palette.tool,
            theme.palette.system,
        ];
        assert_eq!(lines.len(), expected.len());
        for (line, color) in lines.iter().zip(expected) {
            assert_eq!(line.spans[0].style.fg, Some(color), "line: {line:?}");
        }
    }

    #[test]
    fn row_style_reads_palette_tokens() {
        let theme = Theme::light();
        let palette = theme.palette;
        assert_eq!(row_style(RowStyle::User, &theme).fg, Some(palette.user));
        assert_eq!(
            row_style(RowStyle::Assistant, &theme).fg,
            Some(palette.assistant)
        );
        assert_eq!(row_style(RowStyle::Error, &theme).fg, Some(palette.error));
        assert_eq!(row_style(RowStyle::Tool, &theme).fg, Some(palette.tool));
        assert_eq!(
            row_style(RowStyle::InlineCode, &theme).fg,
            Some(palette.inline_code)
        );
        assert_eq!(
            row_style(RowStyle::CodeBlock, &theme).fg,
            Some(palette.code_block)
        );
        assert_eq!(
            row_style(RowStyle::Heading(2), &theme).fg,
            Some(palette.heading)
        );
        assert_eq!(row_style(RowStyle::Rule, &theme).fg, Some(palette.dim));

        let dark = Theme::dark();
        assert_eq!(row_style(RowStyle::User, &dark).fg, Some(dark.palette.user));
        assert_ne!(dark.palette.user, palette.user);
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

    #[test]
    fn sticky_chrome_truncates_prompt_to_the_region_width() {
        let screen = chrome_screen(20, 4, Some(&"x".repeat(100)), 0);
        let first = screen.lines().next().expect("first row");
        assert_eq!(first.trim_end(), format!("▸ {}", "x".repeat(18)));
        assert!(!screen.contains("new"), "screen: {screen}");
    }

    #[test]
    fn pill_is_absent_when_nothing_is_unseen() {
        let screen = chrome_screen(20, 4, None, 0);
        assert!(!screen.contains('↓'), "screen: {screen}");
        assert!(!screen.contains("new"), "screen: {screen}");
    }

    #[test]
    fn pill_shows_unseen_count_at_the_bottom_right() {
        let screen = chrome_screen(20, 4, None, 3);
        let lines: Vec<&str> = screen.lines().collect();
        assert!(lines[0].trim().is_empty(), "screen: {screen}");
        let last = lines.get(3).copied().expect("bottom row");
        assert_eq!(last.trim_start(), "↓ 3 new");
        assert_eq!(last.chars().count(), 20, "screen: {screen}");
    }

    #[test]
    fn sticky_none_does_not_consume_a_transcript_row() {
        let without = region_screen(20, 4, None, 0);
        assert!(without.lines().next().unwrap().starts_with("row 0"));

        let with = region_screen(20, 4, Some("prompt"), 0);
        let lines: Vec<&str> = with.lines().collect();
        assert!(lines[0].starts_with("▸ prompt"), "screen: {with}");
        assert!(lines[1].starts_with("row 0"), "screen: {with}");
        assert!(lines[2].starts_with("row 1"), "screen: {with}");
        assert!(lines[3].starts_with("row 2"), "screen: {with}");
    }

    #[test]
    fn truncate_to_width_keeps_wide_chars_whole() {
        assert_eq!(truncate_to_width("abcdef", 4), "abcd");
        assert_eq!(truncate_to_width("你好", 3), "你");
        assert_eq!(truncate_to_width("你好", 4), "你好");
        assert_eq!(truncate_to_width("abc", 10), "abc");
    }
}
