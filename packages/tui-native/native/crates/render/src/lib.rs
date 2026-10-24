//! Rendering backend: inline viewport, scrollback insertion, and the live
//! status/input region.
//!
//! Design: completed transcript rows are pushed into the terminal's own
//! scrollback with `insert_before` and then forgotten. Only the live region
//! (streaming text, input line, status) is redrawn, which keeps memory flat in
//! long sessions.

use std::io::{self, Stdout};
use std::time::Instant;

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
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Clear, Paragraph, Widget};
use ratatui::{Frame, Terminal, TerminalOptions, Viewport};
use unicode_width::{UnicodeWidthChar, UnicodeWidthStr};

mod legacy;

pub use legacy::{
    LEGACY_BUILD_THRESHOLD, LEGACY_ENV, LEGACY_ENV_COMPAT, LEGACY_RESET_INTERVAL,
    LegacyConsoleMode, LegacyRedraw, detect_build_number, legacy_width, parse_windows_build,
    should_use_legacy,
};

/// Cells the inline viewport reserves below frozen scrollback.
pub const DEFAULT_INLINE_HEIGHT: u16 = 12;

/// Where an overlay is anchored inside the frame.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OverlayPlacement {
    /// Immediately above the prompt and status region (slash-command menu).
    AboveInput,
    /// Centered on the screen (transcript search).
    Centered,
}

/// A list overlay drawn on top of the live view.
///
/// `lines` are plain display rows; `selected` indexes into the visible window
/// and is rendered with emphasis. The overlay is painted with a border and
/// clears the cells underneath, matching the permission dialog.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Overlay {
    pub title: String,
    pub lines: Vec<String>,
    pub selected: Option<usize>,
    pub placement: OverlayPlacement,
}

impl Overlay {
    pub fn new(title: impl Into<String>, lines: Vec<String>, selected: Option<usize>) -> Self {
        Self {
            title: title.into(),
            lines,
            selected,
            placement: OverlayPlacement::AboveInput,
        }
    }

    pub fn centered(mut self) -> Self {
        self.placement = OverlayPlacement::Centered;
        self
    }
}

/// Resolve legacy mode once at session start.
///
/// The first full repaint is deferred by one interval; there is nothing on
/// screen to self-heal yet when the session is created.
fn legacy_state(build_number: Option<u32>) -> (bool, LegacyRedraw) {
    let legacy = should_use_legacy(build_number);
    let mut redraw = LegacyRedraw::new();
    if legacy {
        redraw.mark(Instant::now());
    }
    (legacy, redraw)
}

/// Frame area to paint into, narrowed by one column on legacy consoles.
fn target_area(frame: &Frame, legacy: bool) -> Rect {
    let area = frame.area();
    if legacy {
        Rect {
            width: legacy_width(area.width),
            ..area
        }
    } else {
        area
    }
}

/// Live terminal bound to an inline viewport.
pub struct TerminalSession {
    terminal: Terminal<CrosstermBackend<Stdout>>,
    fullscreen: bool,
    theme: Theme,
    /// Prompt text pinned above the transcript while scrolled up.
    sticky_prompt: Option<String>,
    /// Legacy pre-ConPTY conhost compatibility (Ink's `legacyConsole`).
    legacy: bool,
    /// Periodic full-repaint bookkeeping, used only when `legacy` is set.
    legacy_redraw: LegacyRedraw,
}

impl TerminalSession {
    /// Enter raw mode and reserve an inline viewport at the cursor position.
    pub fn inline(height: u16) -> io::Result<Self> {
        Self::inline_with_build(height, detect_build_number())
    }

    /// [`Self::inline`] with an explicit Windows build number.
    ///
    /// `None` means "unknown" and disables auto-detection; `Some(17_762)`
    /// simulates a pre-ConPTY machine (useful for tests). Environment
    /// overrides still take precedence.
    pub fn inline_with_build(height: u16, build_number: Option<u32>) -> io::Result<Self> {
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
        let (legacy, legacy_redraw) = legacy_state(build_number);
        Ok(Self {
            terminal,
            fullscreen: false,
            theme: Theme::dark(),
            sticky_prompt: None,
            legacy,
            legacy_redraw,
        })
    }

    /// Enter the alternate screen (fullscreen mode).
    pub fn fullscreen() -> io::Result<Self> {
        Self::fullscreen_with_build(detect_build_number())
    }

    /// [`Self::fullscreen`] with an explicit Windows build number.
    pub fn fullscreen_with_build(build_number: Option<u32>) -> io::Result<Self> {
        enable_raw_mode()?;
        let mut stdout = io::stdout();
        execute!(stdout, EnterAlternateScreen, EnableBracketedPaste)?;
        let backend = CrosstermBackend::new(stdout);
        let terminal = Terminal::new(backend)?;
        let (legacy, legacy_redraw) = legacy_state(build_number);
        Ok(Self {
            terminal,
            fullscreen: true,
            theme: Theme::dark(),
            sticky_prompt: None,
            legacy,
            legacy_redraw,
        })
    }

    /// Whether the legacy conhost compatibility layer is active.
    pub fn is_legacy_console(&self) -> bool {
        self.legacy
    }

    /// Content width for a terminal of `terminal_width` columns.
    fn content_width(&self, terminal_width: u16) -> usize {
        let width = terminal_width.max(1);
        if self.legacy {
            legacy_width(width) as usize
        } else {
            width as usize
        }
    }

    /// Full clear + repaint when the legacy interval has elapsed.
    ///
    /// No-op on modern terminals, so their incremental diffs are unchanged.
    fn maybe_full_redraw(&mut self) -> io::Result<()> {
        if !self.legacy {
            return Ok(());
        }
        let now = Instant::now();
        if self.legacy_redraw.due(now) {
            self.terminal.clear()?;
            self.legacy_redraw.mark(now);
        }
        Ok(())
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
        let width = self.content_width(self.terminal.size()?.width);
        let lines = rows_to_lines(rows, width, &self.theme, true);
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
        self.maybe_full_redraw()?;
        let theme = self.theme;
        let legacy = self.legacy;
        self.terminal.draw(|frame| {
            draw_view_in(frame, target_area(frame, legacy), view, &theme);
        })?;
        Ok(())
    }

    /// Inline frame with a list overlay (slash palette or transcript search).
    pub fn draw_with_overlay(&mut self, view: &ChatView, overlay: &Overlay) -> io::Result<()> {
        self.maybe_full_redraw()?;
        let theme = self.theme;
        let legacy = self.legacy;
        self.terminal.draw(|frame| {
            let area = target_area(frame, legacy);
            draw_view_in(frame, area, view, &theme);
            draw_overlay(frame, area, &view.input, overlay, &theme);
        })?;
        Ok(())
    }

    /// Fullscreen frame: the transcript window above the prompt and status.
    pub fn draw_transcript(
        &mut self,
        view: &ChatView,
        model: &mut cch_tui_fullscreen::TranscriptModel,
    ) -> io::Result<()> {
        self.maybe_full_redraw()?;
        let theme = self.theme;
        let sticky = self.sticky_prompt.clone();
        let legacy = self.legacy;
        let size = self.terminal.size()?;
        let width = self.content_width(size.width);
        let reserved = input_height(&view.input) as usize + 1;
        let sticky_height = usize::from(sticky.is_some());
        let transcript_height = (size.height as usize)
            .saturating_sub(reserved + sticky_height)
            .max(1);
        let lines = transcript_lines(model, transcript_height, width, &theme);
        let unseen = model.unseen_count();
        self.terminal.draw(|frame| {
            let area = target_area(frame, legacy);
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
        self.maybe_full_redraw()?;
        let theme = self.theme;
        let sticky = self.sticky_prompt.clone();
        let legacy = self.legacy;
        let size = self.terminal.size()?;
        let width = self.content_width(size.width);
        let reserved = input_height(&view.input) as usize + 1;
        let sticky_height = usize::from(sticky.is_some());
        let transcript_height = (size.height as usize)
            .saturating_sub(reserved + sticky_height)
            .max(1);
        // The sidebar takes ~30% and is only drawn when it has content.
        let sidebar_width = (width / 3).clamp(18, 44);
        let main_width = width.saturating_sub(sidebar_width + 1).max(1);
        let mut lines = transcript_lines(model, transcript_height, main_width, &theme);
        lines.extend(live_lines(view, main_width, &theme));
        let lines = tail(lines, transcript_height);
        let unseen = model.unseen_count();
        let panel_lines = panel_lines(panel, sidebar_width.saturating_sub(2), &theme);
        self.terminal.draw(|frame| {
            let area = target_area(frame, legacy);
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

    /// Fullscreen frame with an optional task panel and a list overlay.
    ///
    /// The overlay is painted last so it sits on top of the transcript, prompt
    /// and sidebar without changing their layout.
    pub fn draw_transcript_with_overlay(
        &mut self,
        view: &ChatView,
        model: &mut cch_tui_fullscreen::TranscriptModel,
        panel: Option<&cch_tui_panel::TaskPanel>,
        overlay: &Overlay,
    ) -> io::Result<()> {
        self.maybe_full_redraw()?;
        let theme = self.theme;
        let sticky = self.sticky_prompt.clone();
        let legacy = self.legacy;
        let size = self.terminal.size()?;
        let width = self.content_width(size.width);
        let reserved = input_height(&view.input) as usize + 1;
        let sticky_height = usize::from(sticky.is_some());
        let transcript_height = (size.height as usize)
            .saturating_sub(reserved + sticky_height)
            .max(1);
        let sidebar_width = (width / 3).clamp(18, 44);
        let main_width = if panel.is_some() {
            width.saturating_sub(sidebar_width + 1).max(1)
        } else {
            width
        };
        let mut lines = transcript_lines(model, transcript_height, main_width, &theme);
        lines.extend(live_lines(view, main_width, &theme));
        let lines = tail(lines, transcript_height);
        let unseen = model.unseen_count();
        let panel_lines =
            panel.map(|panel| panel_lines(panel, sidebar_width.saturating_sub(2), &theme));
        self.terminal.draw(|frame| {
            let area = target_area(frame, legacy);
            let chunks = Layout::vertical([
                Constraint::Min(1),
                Constraint::Length(input_height(&view.input)),
                Constraint::Length(1),
            ])
            .split(area);
            if let Some(panel_lines) = panel_lines {
                let content = Layout::horizontal([
                    Constraint::Min(1),
                    Constraint::Length(sidebar_width as u16),
                ])
                .split(chunks[0]);
                draw_transcript_region(frame, content[0], lines, &theme, sticky.as_deref(), unseen);
                let block = Block::bordered()
                    .title(" Tasks ")
                    .border_style(Style::default().fg(theme.palette.border));
                frame.render_widget(Paragraph::new(panel_lines).block(block), content[1]);
            } else {
                draw_transcript_region(frame, chunks[0], lines, &theme, sticky.as_deref(), unseen);
            }
            draw_prompt(frame, view, chunks[1]);
            draw_status(frame, view, chunks[2], &theme);
            draw_overlay(frame, area, &view.input, overlay, &theme);
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
        self.maybe_full_redraw()?;
        let theme = self.theme;
        let legacy = self.legacy;
        self.terminal.draw(|frame| {
            let area = target_area(frame, legacy);
            draw_view_in(frame, area, view, &theme);
            draw_permission_in(frame, area, dialog, &theme);
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
        self.maybe_full_redraw()?;
        let theme = self.theme;
        let sticky = self.sticky_prompt.clone();
        let legacy = self.legacy;
        let size = self.terminal.size()?;
        let width = self.content_width(size.width);
        let reserved = input_height(&view.input) as usize + 1;
        let sticky_height = usize::from(sticky.is_some());
        let transcript_height = (size.height as usize)
            .saturating_sub(reserved + sticky_height)
            .max(1);
        let lines = transcript_lines(model, transcript_height, width, &theme);
        let unseen = model.unseen_count();
        self.terminal.draw(|frame| {
            let area = target_area(frame, legacy);
            let chunks = Layout::vertical([
                Constraint::Min(1),
                Constraint::Length(input_height(&view.input)),
                Constraint::Length(1),
            ])
            .split(area);
            draw_transcript_region(frame, chunks[0], lines, &theme, sticky.as_deref(), unseen);
            draw_prompt(frame, view, chunks[1]);
            draw_status(frame, view, chunks[2], &theme);
            draw_permission_in(frame, area, dialog, &theme);
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

/// Load the syntax-highlight grammars before the first frame is painted.
///
/// Grammar deserialisation is a one-time cost (tens of ms release, hundreds
/// in debug). Call this from the render thread's start-up so the first code
/// block does not stall a frame.
pub fn warm_up() {
    cch_tui_highlight::warm_up();
}

/// Message bullet used by the Ink app (`figures.BLACK_CIRCLE`).
pub fn message_bullet() -> &'static str {
    if cfg!(target_os = "macos") {
        "⏺"
    } else {
        "●"
    }
}

/// Streaming assistant text: bullet + incremental Markdown, with Ink's
/// marginTop=1 before the block (`Messages.tsx:921-933`).
pub fn live_lines(view: &ChatView, width: usize, theme: &Theme) -> Vec<Line<'static>> {
    if view.live_text.trim().is_empty() {
        return Vec::new();
    }
    let mut lines = vec![Line::from("")];
    let body = cch_tui_markdown::render_markdown(&view.live_text, width.saturating_sub(2));
    let mut emitted = 0usize;
    let mut index = 0usize;
    while index < body.len() {
        let row = &body[index];
        // Fenced code streams through the highlighter with the fence lines
        // dropped, exactly like the frozen path.
        if row.style == RowStyle::CodeBlock {
            let start = index;
            while index < body.len() && body[index].style == RowStyle::CodeBlock {
                index += 1;
            }
            for line in code_block_lines(&body[start..index], theme) {
                let lead = if emitted == 0 {
                    format!("{} ", message_bullet())
                } else {
                    "  ".to_string()
                };
                let mut spans = Vec::with_capacity(line.spans.len() + 1);
                spans.push(Span::raw(lead));
                spans.extend(line.spans);
                lines.push(Line::from(spans));
                emitted += 1;
            }
            continue;
        }
        index += 1;
        // Markdown block separators stay empty: no bullet, no gutter.
        if row.text.is_empty() {
            lines.push(Line::from(""));
            continue;
        }
        let lead = if emitted == 0 {
            format!("{} ", message_bullet())
        } else {
            "  ".to_string()
        };
        lines.push(Line::from(Span::styled(
            format!("{lead}{}", row.text),
            row_style(row.style, theme),
        )));
        emitted += 1;
    }
    lines
}

/// Keep only the last `height` lines so streaming always shows its tail.
fn tail(lines: Vec<Line<'static>>, height: usize) -> Vec<Line<'static>> {
    let len = lines.len();
    if len <= height {
        return lines;
    }
    lines.into_iter().skip(len - height).collect()
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
fn rows_to_lines(rows: &[Row], width: usize, theme: &Theme, spacing: bool) -> Vec<Line<'static>> {
    let mut lines = Vec::new();
    let mut previous: Option<RowStyle> = None;
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
            previous = Some(RowStyle::CodeBlock);
            continue;
        }
        index += 1;
        // Rows with a gutter (assistant prose, tool calls, tool results) are
        // wrapped to the remaining width so the prefix never overflows. User
        // prompts lose one column to Ink's `paddingRight={1}`.
        let (prefix, cont, available) = match row.style {
            RowStyle::Assistant => (message_bullet(), "  ", width.saturating_sub(2)),
            RowStyle::ToolCall | RowStyle::ToolCallPending | RowStyle::ToolCallError => {
                (message_bullet(), "  ", width.saturating_sub(2))
            }
            RowStyle::ToolResult => ("  ⎿  ", "     ", width.saturating_sub(5)),
            RowStyle::User => ("", "", width.saturating_sub(1).max(1)),
            _ => ("", "", width),
        };
        let styled_rows = match row.style {
            RowStyle::Assistant => cch_tui_markdown::render_markdown(&row.text, available),
            _ => wrap_text(&row.text, available)
                .into_iter()
                .map(|line| Row::new(row.style, line))
                .collect(),
        };
        if styled_rows.is_empty() {
            continue;
        }
        // Ink's MessageRow adds `marginTop={1}` to assistant, tool-call and
        // user blocks (but not to tool results). Each top-level assistant or
        // tool-call row is its own block, while a user prompt arrives split
        // into one row per line: only its first row opens a new block.
        let starts_block = match row.style {
            RowStyle::Assistant
            | RowStyle::ToolCall
            | RowStyle::ToolCallPending
            | RowStyle::ToolCallError => true,
            RowStyle::User => previous != Some(RowStyle::User),
            _ => false,
        };
        if spacing
            && starts_block
            && !lines.is_empty()
            && !lines.last().is_some_and(|line| line.width() == 0)
        {
            lines.push(Line::from(""));
        }
        previous = Some(row.style);
        let mut tool_call_offset = 0usize;
        // Lines actually emitted for this row; blank separator rows do not
        // consume the message gutter.
        let mut emitted = 0usize;
        let mut line_index = 0usize;
        while line_index < styled_rows.len() {
            let styled = &styled_rows[line_index];
            // Markdown block separators stay empty: no bullet, no gutter.
            if styled.text.is_empty() {
                lines.push(Line::from(""));
                line_index += 1;
                continue;
            }
            // Assistant Markdown code fences are highlighted as one unit; the
            // fence lines disappear, exactly like Ink's `code` token.
            if styled.style == RowStyle::CodeBlock {
                let start = line_index;
                while line_index < styled_rows.len()
                    && styled_rows[line_index].style == RowStyle::CodeBlock
                {
                    line_index += 1;
                }
                for line in code_block_lines(&styled_rows[start..line_index], theme) {
                    let lead = if emitted == 0 {
                        format!("{prefix} ")
                    } else {
                        cont.to_string()
                    };
                    let mut spans = Vec::with_capacity(line.spans.len() + 1);
                    if !lead.is_empty() {
                        spans.push(Span::raw(lead));
                    }
                    spans.extend(line.spans);
                    lines.push(Line::from(spans));
                    emitted += 1;
                }
                continue;
            }
            if matches!(
                row.style,
                RowStyle::ToolCall | RowStyle::ToolCallPending | RowStyle::ToolCallError
            ) {
                lines.push(tool_call_line(
                    row,
                    styled,
                    emitted,
                    tool_call_offset,
                    prefix,
                    cont,
                    theme,
                ));
                tool_call_offset += styled.text.chars().count();
                emitted += 1;
                line_index += 1;
                continue;
            }
            let lead = if emitted == 0 { prefix } else { cont };
            let mut text = if lead.is_empty() {
                styled.text.clone()
            } else if emitted == 0 && row.style == RowStyle::Assistant {
                // Ink reserves a 2-column gutter: bullet + one space.
                format!("{lead} {}", styled.text)
            } else {
                format!("{lead}{}", styled.text)
            };
            let style = if row.style == RowStyle::ToolResult {
                Style::default().fg(theme.palette.dim)
            } else if row.style == RowStyle::User {
                // Ink paints the prompt as a background block with one column
                // of right padding: the background stops before the last cell.
                let target = width.saturating_sub(1);
                let used = UnicodeWidthStr::width(text.as_str());
                if used < target {
                    text.push_str(&" ".repeat(target - used));
                }
                Style::default()
                    .bg(theme.palette.user_message_bg)
                    .fg(theme.palette.foreground)
            } else {
                row_style(styled.style, theme)
            };
            lines.push(Line::from(Span::styled(text, style)));
            emitted += 1;
            line_index += 1;
        }
    }
    lines
}

/// One wrapped line of a tool call: `"⏺ "` in the normal tool color, the tool
/// name (text before the first `(`) in bold, and the `(input)` suffix plain.
fn tool_call_line(
    row: &Row,
    styled: &Row,
    line_index: usize,
    line_start: usize,
    prefix: &str,
    cont: &str,
    theme: &Theme,
) -> Line<'static> {
    let palette = theme.palette;
    let normal = Style::default().fg(palette.foreground);
    let name_style = normal.add_modifier(Modifier::BOLD);
    // ToolUseLoader: dim while unresolved, success when it returned, error
    // when the result was an error.
    let bullet_style = match row.style {
        RowStyle::ToolCallPending => Style::default().fg(palette.dim),
        RowStyle::ToolCallError => Style::default().fg(palette.error),
        _ => Style::default().fg(palette.success),
    };
    let text = styled.text.as_str();
    let line_chars = text.chars().count();
    // Char offset of the first `(`; everything before it is the tool name.
    let boundary = row
        .text
        .find('(')
        .map(|byte| row.text[..byte].chars().count());
    // Chars of the tool name on this wrapped line.
    let name_chars = boundary.map_or(line_chars, |end| {
        end.min(line_start + line_chars).saturating_sub(line_start)
    });

    let mut spans: Vec<Span<'static>> = Vec::new();
    if line_index == 0 {
        spans.push(Span::styled(format!("{prefix} "), bullet_style));
    } else {
        spans.push(Span::styled(cont.to_string(), normal));
    }
    let byte_split = text
        .char_indices()
        .nth(name_chars)
        .map(|(index, _)| index)
        .unwrap_or(text.len());
    if byte_split > 0 {
        spans.push(Span::styled(text[..byte_split].to_string(), name_style));
    }
    if byte_split < text.len() {
        spans.push(Span::styled(text[byte_split..].to_string(), normal));
    }
    Line::from(spans)
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

/// Render diff rows with `+`/`-` prefixes and theme backgrounds.
pub fn diff_to_lines(rows: &[cch_tui_diff::DiffRow], theme: &Theme) -> Vec<Line<'static>> {
    use cch_tui_diff::DiffKind;
    let palette = theme.palette;
    rows.iter()
        .map(|row| {
            if row.is_marker() {
                return Line::from(Span::styled(
                    row.text.clone(),
                    Style::default().fg(palette.accent),
                ));
            }
            let (prefix, style) = match row.kind {
                DiffKind::Added => ("+ ", Style::default().bg(palette.diff_added_bg)),
                DiffKind::Removed => ("- ", Style::default().bg(palette.diff_removed_bg)),
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
    rows_to_lines(&rows, width, theme, false)
}

fn row_style(style: RowStyle, theme: &Theme) -> Style {
    let palette = theme.palette;
    match style {
        RowStyle::User => Style::default().fg(palette.user),
        RowStyle::Assistant => Style::default().fg(palette.assistant),
        RowStyle::System => Style::default().fg(palette.system),
        RowStyle::Error => Style::default().fg(palette.error),
        RowStyle::Tool => Style::default().fg(palette.tool),
        RowStyle::ToolCall => Style::default().fg(palette.foreground),
        RowStyle::ToolCallPending => Style::default().fg(palette.dim),
        RowStyle::ToolCallError => Style::default().fg(palette.error),
        RowStyle::ToolResult => Style::default().fg(palette.dim),
        // System breadcrumbs (hooks, rate limits, task notifications) stay
        // de-emphasized; API retries use the error color at normal intensity.
        RowStyle::Hook => Style::default().fg(palette.dim),
        RowStyle::Warning => Style::default().fg(palette.error),
        // Markdown row roles. The markdown crate emits the text (markers,
        // prefixes and indentation included); these only pick a palette token.
        // Ink's heading styles: h1 bold+italic+underline, h2+ bold
        // (`utils/markdown.ts` heading case).
        RowStyle::Heading(1) => Style::default()
            .fg(palette.heading)
            .add_modifier(Modifier::BOLD | Modifier::ITALIC | Modifier::UNDERLINED),
        RowStyle::Heading(_) => Style::default()
            .fg(palette.heading)
            .add_modifier(Modifier::BOLD),
        RowStyle::InlineCode => Style::default().fg(palette.inline_code),
        RowStyle::CodeBlock => Style::default().fg(palette.code_block),
        RowStyle::ListItem => Style::default().fg(palette.foreground),
        // Ink keeps quote text italic at normal brightness (its dim bar is
        // nearly invisible on dark themes).
        RowStyle::Blockquote => Style::default()
            .fg(palette.foreground)
            .add_modifier(Modifier::ITALIC),
        RowStyle::Rule => Style::default().fg(palette.dim),
        RowStyle::DiffHunk => Style::default()
            .fg(palette.accent)
            .add_modifier(Modifier::BOLD),
        RowStyle::DiffAdded => Style::default().bg(palette.diff_added_bg),
        RowStyle::DiffRemoved => Style::default().bg(palette.diff_removed_bg),
        RowStyle::DiffContext => Style::default().fg(palette.dim),
        RowStyle::TableHeader => Style::default()
            .fg(palette.foreground)
            .add_modifier(Modifier::BOLD),
        RowStyle::TableRow => Style::default().fg(palette.foreground),
    }
}

/// Paint the live region: streaming text, input line, status line.
pub fn draw_view(frame: &mut Frame, view: &ChatView, theme: &Theme) {
    draw_view_in(frame, frame.area(), view, theme);
}

/// [`draw_view`] constrained to `area` (legacy consoles drop the last column).
fn draw_view_in(frame: &mut Frame, area: Rect, view: &ChatView, theme: &Theme) {
    let chunks = Layout::vertical([
        Constraint::Min(1),
        Constraint::Length(input_height(&view.input)),
        Constraint::Length(1),
    ])
    .split(area);

    let live = tail(
        live_lines(view, chunks[0].width as usize, theme),
        chunks[0].height as usize,
    );
    frame.render_widget(Paragraph::new(live), chunks[0]);

    draw_prompt(frame, view, chunks[1]);
    draw_status(frame, view, chunks[2], theme);
}

fn draw_prompt(frame: &mut Frame, view: &ChatView, area: ratatui::layout::Rect) {
    let raw_lines: Vec<&str> = view.input.split('\n').collect();
    let input_text = raw_lines
        .iter()
        .enumerate()
        .map(|(index, line)| {
            // Ink renders `figures.pointer` (❯) plus a non-breaking space and
            // dims it while a turn is in flight.
            if index == 0 {
                format!("❯ {line}")
            } else {
                format!("  {line}")
            }
        })
        .collect::<Vec<_>>()
        .join("\n");
    let input_style = if view.busy {
        Style::default().add_modifier(Modifier::DIM)
    } else {
        Style::default()
    };
    let input = Paragraph::new(input_text).style(input_style);
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

/// Draw a bordered, cleared list overlay.
///
/// `lines` are fitted horizontally; the row at `selected` is emphasised. The
/// widget matches the permission dialog's frame (border + [`Clear`]) so both
/// overlays look alike. Theme-independent; the session methods use the active
/// theme's border and accent colours.
pub fn draw_overlay_list(
    frame: &mut Frame,
    rect: Rect,
    title: &str,
    lines: &[String],
    selected: Option<usize>,
) {
    draw_overlay_list_styled(
        frame,
        rect,
        title,
        lines,
        selected,
        Style::default(),
        Style::default().add_modifier(Modifier::BOLD),
    );
}

fn draw_overlay_list_styled(
    frame: &mut Frame,
    rect: Rect,
    title: &str,
    lines: &[String],
    selected: Option<usize>,
    border: Style,
    selected_style: Style,
) {
    if rect.width < 2 || rect.height < 2 {
        return;
    }
    let inner_width = rect.width.saturating_sub(2) as usize;
    let visible = rect.height.saturating_sub(2) as usize;
    let rows: Vec<Line<'static>> = lines
        .iter()
        .take(visible)
        .enumerate()
        .map(|(index, text)| {
            let style = if Some(index) == selected {
                selected_style
            } else {
                Style::default()
            };
            Line::from(Span::styled(truncate_to_width(text, inner_width), style))
        })
        .collect();
    frame.render_widget(Clear, rect);
    let block = Block::bordered().title(title).border_style(border);
    frame.render_widget(Paragraph::new(rows).block(block), rect);
}

/// Paint `overlay` on top of the current frame.
fn draw_overlay(frame: &mut Frame, area: Rect, input: &str, overlay: &Overlay, theme: &Theme) {
    let rect = overlay_rect(area, input, overlay);
    draw_overlay_list_styled(
        frame,
        rect,
        &overlay.title,
        &overlay.lines,
        overlay.selected,
        Style::default().fg(theme.palette.border),
        Style::default()
            .fg(theme.palette.accent)
            .add_modifier(Modifier::BOLD),
    );
}

/// Place an overlay inside `area`.
///
/// `AboveInput` sits immediately above the prompt (and status) region, which
/// is how the slash palette hangs off the input line. `Centered` is used for
/// the transcript search box.
fn overlay_rect(area: Rect, input: &str, overlay: &Overlay) -> Rect {
    let width = area
        .width
        .saturating_mul(7)
        .saturating_div(10)
        .clamp(20, 78)
        .min(area.width);
    let height = (overlay.lines.len() as u16 + 2).min(area.height);
    let x = area.x + area.width.saturating_sub(width) / 2;
    let y = match overlay.placement {
        OverlayPlacement::Centered => area.y + area.height.saturating_sub(height) / 2,
        OverlayPlacement::AboveInput => {
            let bottom = area
                .bottom()
                .saturating_sub(input_height(input).saturating_add(1));
            bottom.saturating_sub(height).max(area.y)
        }
    };
    Rect::new(x, y, width, height)
}

/// Plan-approval options, verbatim from the official Ink component
/// (`ExitPlanModePermissionRequest.tsx` lines 852, 858 and 871 in the
/// reference tree).
const PLAN_APPROVAL_OPTIONS: [&str; 3] = [
    "Yes, auto-accept edits",
    "Yes, manually approve edits",
    "No, keep planning",
];

/// Most plan body lines rendered before truncating with an ellipsis.
const MAX_PLAN_LINES: usize = 20;

/// Draw the permission dialog as a centered overlay.
pub fn draw_permission(
    frame: &mut Frame,
    dialog: &cch_tui_dialog::PermissionDialog,
    theme: &Theme,
) {
    draw_permission_in(frame, frame.area(), dialog, theme);
}

/// [`draw_permission`] centered inside `area`.
fn draw_permission_in(
    frame: &mut Frame,
    area: Rect,
    dialog: &cch_tui_dialog::PermissionDialog,
    theme: &Theme,
) {
    let width = area
        .width
        .saturating_mul(7)
        .saturating_div(10)
        .clamp(24, 78);
    let is_plan = dialog.kind() == cch_tui_dialog::PermissionKind::ExitPlanMode;
    let mut lines: Vec<Line<'static>> = Vec::new();
    if is_plan {
        lines.push(Line::from(Span::styled(
            "Here is Claude's plan:",
            Style::default().add_modifier(Modifier::BOLD),
        )));
        if let Some(plan) = dialog.plan_text() {
            let mut plan_lines = wrap_text(plan, width.saturating_sub(4) as usize);
            if plan_lines.len() > MAX_PLAN_LINES {
                plan_lines.truncate(MAX_PLAN_LINES);
                plan_lines.push("…".into());
            }
            for line in plan_lines {
                lines.push(Line::from(line));
            }
        }
    } else {
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
    }
    lines.push(Line::from(""));
    if is_plan {
        push_option_lines(&mut lines, dialog, theme, PLAN_APPROVAL_OPTIONS);
    } else {
        push_option_lines(
            &mut lines,
            dialog,
            theme,
            dialog.options().iter().map(|option| option.label()),
        );
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
    let title = if is_plan {
        " Ready to code? "
    } else {
        " Permission required "
    };
    let block = ratatui::widgets::Block::bordered()
        .title(title)
        .border_style(Style::default().fg(theme.palette.border));
    let paragraph = Paragraph::new(lines)
        .block(block)
        .wrap(ratatui::widgets::Wrap { trim: false });
    frame.render_widget(paragraph, rect);
}

/// Append one selectable row per label, highlighting the dialog selection.
fn push_option_lines(
    lines: &mut Vec<Line<'static>>,
    dialog: &cch_tui_dialog::PermissionDialog,
    theme: &Theme,
    labels: impl IntoIterator<Item = &'static str>,
) {
    for (index, label) in labels.into_iter().enumerate() {
        let marker = if index == dialog.selected() { ">" } else { " " };
        let style = if index == dialog.selected() {
            Style::default()
                .fg(theme.palette.accent)
                .add_modifier(Modifier::BOLD)
        } else {
            Style::default()
        };
        lines.push(Line::from(Span::styled(format!("{marker} {label}"), style)));
    }
}

/// Convert the visible window of a transcript model into terminal lines.
pub fn transcript_lines(
    model: &mut cch_tui_fullscreen::TranscriptModel,
    height: usize,
    width: usize,
    theme: &Theme,
) -> Vec<Line<'static>> {
    let range = model.window(height, width);
    // The model already contains the blank separator rows, so no extra
    // spacing is applied here (heights and offsets stay in sync).
    rows_to_lines(&model.rows()[range], width, theme, false)
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

    #[test]
    fn legacy_target_area_drops_last_column() {
        let backend = ratatui::backend::TestBackend::new(80, 24);
        let mut terminal = Terminal::new(backend).expect("terminal");
        let mut areas = Vec::new();
        terminal
            .draw(|frame| {
                areas.push(target_area(frame, false));
                areas.push(target_area(frame, true));
            })
            .expect("draw");
        assert_eq!(areas[0].width, 80);
        assert_eq!(areas[1].width, 79);
        assert_eq!(areas[0].x, areas[1].x);
        assert_eq!(areas[0].height, areas[1].height);
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
        assert!(screen.contains("❯ hi"), "screen: {screen}");
        assert!(screen.contains("m1 · session s1"), "screen: {screen}");
    }

    #[test]
    fn assistant_markdown_fences_are_highlighted_with_the_message_gutter() {
        let rows = vec![Row::new(
            RowStyle::Assistant,
            "text\n\n```rust\nlet x = 1;\n```",
        )];
        let theme = Theme::dark();
        let lines = rows_to_lines(&rows, 40, &theme, true);
        let texts: Vec<String> = lines.iter().map(|line| line.to_string()).collect();
        // The markdown block separator survives as a truly empty line.
        assert!(texts.iter().any(String::is_empty), "{texts:?}");
        assert!(
            !texts.iter().any(|text| text.contains("```")),
            "fences must not be painted: {texts:?}"
        );
        let code = lines
            .iter()
            .find(|line| line.to_string().contains("let x"))
            .expect("code line");
        // Code keeps the assistant column gutter (bullet column, two cells).
        assert!(code.to_string().starts_with("  "), "{code:?}");
        assert!(
            code.spans
                .iter()
                .any(|span| span.content.contains("let")
                    && span.style.fg == Some(theme.palette.keyword)),
            "keyword should use the theme keyword color: {code:?}"
        );
        // The first rendered line of the message opens with the bullet.
        assert!(texts[0].starts_with(&format!("{} ", message_bullet())));
    }

    #[test]
    fn heading_and_blockquote_styles_match_ink() {
        let theme = Theme::dark();
        let h1 = row_style(RowStyle::Heading(1), &theme);
        assert!(
            h1.add_modifier
                .contains(Modifier::BOLD | Modifier::ITALIC | Modifier::UNDERLINED)
        );
        let h2 = row_style(RowStyle::Heading(2), &theme);
        assert!(h2.add_modifier.contains(Modifier::BOLD));
        assert!(!h2.add_modifier.contains(Modifier::ITALIC));
        let quote = row_style(RowStyle::Blockquote, &theme);
        assert!(quote.add_modifier.contains(Modifier::ITALIC));
        assert_eq!(quote.fg, Some(theme.palette.foreground));
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
        let lines = rows_to_lines(&rows, 40, &Theme::dark(), true);
        let texts: Vec<String> = lines.iter().map(|line| line.to_string()).collect();
        assert!(texts.iter().any(|text| text.contains("Title")), "{texts:?}");
        assert!(
            !texts.iter().any(|text| text.contains("# Title")),
            "{texts:?}"
        );
        assert!(texts.iter().any(|text| text.contains("item")), "{texts:?}");
    }

    #[test]
    fn tool_bullet_colors_follow_status() {
        let theme = Theme::dark();
        for (style, color) in [
            (RowStyle::ToolCallPending, theme.palette.dim),
            (RowStyle::ToolCall, theme.palette.success),
            (RowStyle::ToolCallError, theme.palette.error),
        ] {
            let rows = vec![Row::new(style, "Bash(ls)")];
            let lines = rows_to_lines(&rows, 40, &theme, true);
            assert_eq!(lines[0].spans[0].style.fg, Some(color), "{style:?}");
        }
    }

    #[test]
    fn system_breadcrumb_styles_use_dim_and_error() {
        let theme = Theme::dark();
        for (style, color, text) in [
            (RowStyle::Hook, theme.palette.dim, "  ⎿  lint started"),
            (RowStyle::Warning, theme.palette.error, "API error"),
        ] {
            let rows = vec![Row::new(style, text)];
            let lines = rows_to_lines(&rows, 40, &theme, true);
            assert_eq!(lines[0].spans[0].style.fg, Some(color), "{style:?}");
        }
    }

    #[test]
    fn tool_call_name_is_bold_and_args_are_plain() {
        let rows = vec![Row::new(RowStyle::ToolCall, "Bash(ls -la)")];
        let theme = Theme::dark();
        let lines = rows_to_lines(&rows, 40, &theme, true);

        assert_eq!(lines.len(), 1, "{lines:?}");
        let spans = &lines[0].spans;
        assert_eq!(spans.len(), 3, "{spans:?}");
        assert_eq!(
            spans[0].content.as_ref(),
            format!("{} ", message_bullet()),
            "dot keeps its own normal span"
        );
        assert!(!spans[0].style.add_modifier.contains(Modifier::BOLD));
        assert_eq!(spans[1].content.as_ref(), "Bash");
        assert!(
            spans[1].style.add_modifier.contains(Modifier::BOLD),
            "tool name is bold: {spans:?}"
        );
        assert_eq!(spans[2].content.as_ref(), "(ls -la)");
        assert!(
            !spans[2].style.add_modifier.contains(Modifier::BOLD),
            "arguments are not bold: {spans:?}"
        );
    }

    #[test]
    fn assistant_block_starts_with_a_blank_line() {
        let rows = vec![
            Row::new(RowStyle::User, "hi"),
            Row::new(RowStyle::Assistant, "hello"),
        ];
        let lines = rows_to_lines(&rows, 40, &Theme::dark(), true);
        assert!(lines.len() >= 3, "{lines:?}");
        assert_eq!(lines[1].width(), 0, "blank separator: {lines:?}");
        assert!(
            lines[2..]
                .iter()
                .any(|line| line.to_string().contains("hello")),
            "{lines:?}"
        );
    }

    #[test]
    fn multi_line_message_rows_do_not_add_blank_lines() {
        let rows = vec![
            Row::new(RowStyle::User, "one"),
            Row::new(RowStyle::User, "two"),
        ];
        let lines = rows_to_lines(&rows, 20, &Theme::dark(), true);
        assert_eq!(lines.len(), 2, "continuation rows stay compact: {lines:?}");
        assert!(lines.iter().all(|line| line.width() > 0), "{lines:?}");
    }

    #[test]
    fn consecutive_tool_calls_each_start_a_block() {
        let rows = vec![
            Row::new(RowStyle::ToolCall, "Bash(ls)"),
            Row::new(RowStyle::ToolCall, "Read(a.rs)"),
        ];
        let lines = rows_to_lines(&rows, 40, &Theme::dark(), true);
        assert_eq!(lines.len(), 3, "{lines:?}");
        assert_eq!(lines[1].width(), 0, "blank separator: {lines:?}");
    }

    #[test]
    fn consecutive_tool_results_have_no_blank_lines() {
        let rows = vec![
            Row::new(RowStyle::ToolCall, "Bash(ls)"),
            Row::new(RowStyle::ToolResult, "a.txt"),
            Row::new(RowStyle::ToolResult, "b.txt"),
        ];
        let lines = rows_to_lines(&rows, 40, &Theme::dark(), true);
        assert_eq!(lines.len(), 3, "{lines:?}");
        assert!(lines.iter().all(|line| line.width() > 0), "{lines:?}");
    }

    #[test]
    fn user_block_keeps_one_column_of_right_padding() {
        let theme = Theme::dark();
        let rows = vec![Row::new(RowStyle::User, "hi")];
        let lines = rows_to_lines(&rows, 10, &theme, true);
        assert_eq!(lines.len(), 1, "{lines:?}");
        // `paddingRight={1}` in Ink: the background stops before the last
        // column, so the painted line is one column narrower than the area.
        assert_eq!(lines[0].width(), 9, "{lines:?}");
        assert_eq!(lines[0].to_string(), "hi       ");
        assert_eq!(
            lines[0].spans[0].style.bg,
            Some(theme.palette.user_message_bg)
        );
    }

    #[test]
    fn multi_line_input_grows_and_keeps_prompt_prefix() {
        let mut view = ChatView::new();
        view.input = "first\nsecond".into();
        let screen = render(&view, 40, 8);
        assert!(screen.contains("❯ first"), "screen: {screen}");
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
        let lines = rows_to_lines(&rows, 40, &theme, true);
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
    fn diff_rows_get_prefixes_and_backgrounds() {
        let theme = Theme::dark();
        let rows = cch_tui_diff::diff_lines("a\nb", "a\nc");
        let lines = diff_to_lines(&rows, &theme);
        let texts: Vec<String> = lines.iter().map(|l| l.to_string()).collect();
        assert!(texts.iter().any(|t| t == "  a"), "{texts:?}");
        assert!(texts.iter().any(|t| t == "- b"), "{texts:?}");
        assert!(texts.iter().any(|t| t == "+ c"), "{texts:?}");
        let removed = lines
            .iter()
            .find(|l| l.to_string().starts_with("- "))
            .expect("removed line");
        assert_eq!(
            removed.spans[0].style.bg,
            Some(theme.palette.diff_removed_bg)
        );
        let added = lines
            .iter()
            .find(|l| l.to_string().starts_with("+ "))
            .expect("added line");
        assert_eq!(added.spans[0].style.bg, Some(theme.palette.diff_added_bg));
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

    fn render_permission_screen(
        dialog: &cch_tui_dialog::PermissionDialog,
        width: u16,
        height: u16,
    ) -> String {
        let backend = ratatui::backend::TestBackend::new(width, height);
        let mut terminal = Terminal::new(backend).expect("terminal");
        terminal
            .draw(|frame| draw_permission(frame, dialog, &Theme::dark()))
            .expect("draw");
        let buffer = terminal.backend().buffer().clone();
        let mut screen = String::new();
        for y in 0..buffer.area.height {
            for x in 0..buffer.area.width {
                screen.push_str(buffer[(x, y)].symbol());
            }
            screen.push('\n');
        }
        screen
    }

    fn plan_dialog(plan: &str) -> cch_tui_dialog::PermissionDialog {
        let request = cch_tui_proto::CanUseToolRequest {
            tool_name: "ExitPlanMode".into(),
            input: serde_json::Map::from_iter([(
                "plan".into(),
                serde_json::Value::String(plan.into()),
            )]),
            tool_use_id: "t1".into(),
            permission_suggestions: None,
            blocked_path: None,
            decision_reason: None,
            title: None,
            display_name: None,
            agent_id: None,
            description: None,
        };
        cch_tui_dialog::PermissionDialog::new("r1", request)
    }

    #[test]
    fn exit_plan_mode_renders_plan_title_and_fixed_options() {
        let dialog = plan_dialog("# Plan\n\n1. Add the widget\n2. Run the tests");
        let screen = render_permission_screen(&dialog, 80, 24);

        assert!(screen.contains("Ready to code?"), "{screen}");
        assert!(screen.contains("Here is Claude's plan:"), "{screen}");
        assert!(screen.contains("Add the widget"), "{screen}");
        assert!(screen.contains("Run the tests"), "{screen}");
        assert!(screen.contains("> Yes, auto-accept edits"), "{screen}");
        assert!(screen.contains("Yes, manually approve edits"), "{screen}");
        assert!(screen.contains("No, keep planning"), "{screen}");
        assert!(
            !screen.contains("Permission required"),
            "plan dialogs use the plan title: {screen}"
        );
        assert!(!screen.contains("Allow once"), "{screen}");
    }

    #[test]
    fn exit_plan_mode_truncates_long_plans_at_twenty_lines() {
        let plan = (0..30)
            .map(|i| format!("step {i}"))
            .collect::<Vec<_>>()
            .join("\n");
        let dialog = plan_dialog(&plan);
        let screen = render_permission_screen(&dialog, 100, 40);

        assert!(screen.contains("step 19"), "{screen}");
        assert!(!screen.contains("step 20"), "{screen}");
        assert!(screen.contains('…'), "{screen}");
    }

    #[test]
    fn generic_permission_dialog_keeps_its_layout() {
        let request = cch_tui_proto::CanUseToolRequest {
            tool_name: "Bash".into(),
            input: serde_json::Map::from_iter([(
                "command".into(),
                serde_json::Value::String("ls".into()),
            )]),
            tool_use_id: "t1".into(),
            permission_suggestions: None,
            blocked_path: None,
            decision_reason: None,
            title: None,
            display_name: None,
            agent_id: None,
            description: None,
        };
        let dialog = cch_tui_dialog::PermissionDialog::new("r1", request);
        let screen = render_permission_screen(&dialog, 70, 20);

        assert!(screen.contains("Permission required"), "{screen}");
        assert!(screen.contains("Tool: Bash"), "{screen}");
        assert!(screen.contains("> Allow once"), "{screen}");
        assert!(!screen.contains("Yes, auto-accept edits"), "{screen}");
    }

    #[test]
    fn transcript_window_follows_tail_and_scrolls() {
        let mut model = cch_tui_fullscreen::TranscriptModel::new();
        model.append((0..50).map(|i| Row::new(RowStyle::User, format!("line {i}"))));

        let theme = Theme::dark();
        let lines = transcript_lines(&mut model, 6, 40, &theme);
        let texts: Vec<String> = lines.iter().map(|line| line.to_string()).collect();
        assert!(
            texts.iter().any(|text| text.trim_end() == "line 49"),
            "tail not visible: {texts:?}"
        );

        model.scroll_to_top();
        let lines = transcript_lines(&mut model, 6, 40, &theme);
        let texts: Vec<String> = lines.iter().map(|line| line.to_string()).collect();
        assert!(
            texts.iter().any(|text| text.trim_end() == "line 0"),
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
    fn frozen_assistant_rows_keep_the_gutter_space() {
        let rows = vec![Row::new(RowStyle::Assistant, "hello")];
        let lines = rows_to_lines(&rows, 40, &Theme::dark(), true);
        let bullet = message_bullet();
        assert_eq!(lines[0].to_string(), format!("{bullet} hello"));
    }

    #[test]
    fn streaming_text_gets_a_bullet_and_markdown() {
        let mut view = ChatView::new();
        view.live_text = "# hello".into();
        let lines = live_lines(&view, 40, &Theme::dark());
        assert_eq!(lines.len(), 2, "blank margin + one line");
        assert_eq!(lines[0].width(), 0);
        assert!(
            lines[1]
                .to_string()
                .starts_with(&format!("{} ", message_bullet())),
            "{}",
            lines[1]
        );
        assert!(!lines[1].to_string().contains('#'), "{}", lines[1]);
    }

    #[test]
    fn tail_keeps_the_last_lines() {
        let lines = vec![Line::from("a"), Line::from("b"), Line::from("c")];
        let kept = tail(lines, 2);
        let text: Vec<String> = kept.iter().map(|line| line.to_string()).collect();
        assert_eq!(text, ["b", "c"]);
    }

    #[test]
    fn user_rows_are_verbatim() {
        let rows = vec![Row::new(RowStyle::User, "# not a heading")];
        let lines = rows_to_lines(&rows, 40, &Theme::dark(), true);
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0].to_string().trim_end(), "# not a heading");
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
        let lines = rows_to_lines(&rows, 40, &theme, true);
        // User prompts are painted as a background block (Ink
        // `userMessageBackground`); the rest keep their foreground token.
        assert_eq!(
            lines[0].spans[0].style.bg,
            Some(theme.palette.user_message_bg)
        );
        let expected = [
            theme.palette.error,
            theme.palette.tool,
            theme.palette.system,
        ];
        assert_eq!(lines.len(), expected.len() + 1);
        for (line, color) in lines[1..].iter().zip(expected) {
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
        assert_eq!(
            row_style(RowStyle::DiffAdded, &theme).bg,
            Some(palette.diff_added_bg)
        );
        assert_eq!(
            row_style(RowStyle::DiffRemoved, &theme).bg,
            Some(palette.diff_removed_bg)
        );
        assert_eq!(
            row_style(RowStyle::DiffHunk, &theme).fg,
            Some(palette.accent)
        );

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

    #[test]
    fn overlay_list_renders_a_cleared_bordered_window() {
        let backend = ratatui::backend::TestBackend::new(24, 6);
        let mut terminal = Terminal::new(backend).expect("terminal");
        let lines = vec!["alpha".to_string(), "beta".to_string(), "gamma".to_string()];
        terminal
            .draw(|frame| {
                draw_overlay_list(frame, Rect::new(2, 1, 20, 5), " Commands ", &lines, Some(1));
            })
            .expect("draw");

        let buffer = terminal.backend().buffer();
        assert_eq!(buffer[(2, 1)].symbol(), "┌");
        assert_eq!(buffer[(21, 1)].symbol(), "┐");
        assert_eq!(buffer[(2, 5)].symbol(), "└");
        assert_eq!(buffer[(21, 5)].symbol(), "┘");
        // The selected row (beta) is bold; the rows around it are not.
        assert!(buffer[(3, 3)].modifier.contains(Modifier::BOLD));
        assert!(!buffer[(3, 2)].modifier.contains(Modifier::BOLD));
        assert!(!buffer[(3, 4)].modifier.contains(Modifier::BOLD));
        let screen = buffer_screen(&terminal);
        assert!(screen.contains("Commands"), "screen: {screen}");
        for line in ["alpha", "beta", "gamma"] {
            assert!(screen.contains(line), "missing {line}: {screen}");
        }
        // Cells outside the overlay keep the cleared background.
        assert_eq!(buffer[(0, 0)].symbol(), " ");
    }

    #[test]
    fn above_input_overlay_sits_above_prompt_and_status() {
        let area = Rect::new(0, 0, 40, 12);
        let overlay = Overlay::new("title", vec!["a".into(), "b".into()], None);
        let rect = overlay_rect(area, "input", &overlay);
        assert_eq!(rect.height, 4);
        // 12 rows - 1 status - 1 input = row 10.
        assert_eq!(rect.bottom(), 10);
        assert_eq!(rect.y, 6);

        let centered = overlay_rect(area, "input", &overlay.clone().centered());
        assert_eq!(centered.y, 4);
    }

    #[test]
    fn overlay_lines_are_clipped_to_the_inner_width() {
        let backend = ratatui::backend::TestBackend::new(12, 5);
        let mut terminal = Terminal::new(backend).expect("terminal");
        terminal
            .draw(|frame| {
                draw_overlay_list(
                    frame,
                    Rect::new(0, 0, 12, 3),
                    " T ",
                    &["x".repeat(40)],
                    None,
                );
            })
            .expect("draw");
        let screen = buffer_screen(&terminal);
        for line in screen.lines() {
            assert!(line.chars().count() <= 12, "line too wide: {line:?}");
        }
        assert!(!screen.contains(&"x".repeat(11)), "screen: {screen}");
    }
}
