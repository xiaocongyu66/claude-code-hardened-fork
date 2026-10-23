//! Visual-fidelity regression tests against the Ink original.
//!
//! Every assertion names the Ink source of truth in `docs/tui-parity.md`
//! ("Fidelity audit"). These tests deliberately pin literal glyphs, frame
//! order and palette tokens so refactors cannot silently drift away from the
//! reference UI.

use cch_tui_fullscreen::TranscriptModel;
use cch_tui_render::{diff_to_lines, draw_view, live_lines, message_bullet, transcript_lines};
use cch_tui_theme::Theme;
use cch_tui_ui::{ChatView, Row, RowStyle};
use ratatui::Terminal;
use ratatui::backend::TestBackend;
use ratatui::style::{Color, Modifier};
use ratatui::text::Line;
use ratatui::widgets::Paragraph;

/// One screen row per line, trailing padding preserved.
fn screen(terminal: &Terminal<TestBackend>) -> Vec<String> {
    let buffer = terminal.backend().buffer();
    (0..buffer.area.height)
        .map(|y| {
            (0..buffer.area.width)
                .map(|x| buffer[(x, y)].symbol())
                .collect()
        })
        .collect()
}

fn draw_lines(lines: Vec<Line<'static>>, width: u16, height: u16) -> Terminal<TestBackend> {
    let backend = TestBackend::new(width, height);
    let mut terminal = Terminal::new(backend).expect("terminal");
    terminal
        .draw(|frame| frame.render_widget(Paragraph::new(lines), frame.area()))
        .expect("draw");
    terminal
}

fn render_view(view: &ChatView, width: u16, height: u16) -> Terminal<TestBackend> {
    let backend = TestBackend::new(width, height);
    let mut terminal = Terminal::new(backend).expect("terminal");
    let theme = Theme::dark();
    terminal
        .draw(|frame| draw_view(frame, view, &theme))
        .expect("draw");
    terminal
}

fn render_transcript(
    rows: &[Row],
    width: usize,
    height: usize,
    theme: &Theme,
) -> Terminal<TestBackend> {
    let mut model = TranscriptModel::new();
    model.append(rows.iter().cloned());
    let lines = transcript_lines(&mut model, height, width, theme);
    draw_lines(lines, width as u16, height as u16)
}

/// `figures.pointer` (`PromptInputModeIndicator.tsx:57`): `❯ ` directly before
/// the first input line, dimmed while a turn is in flight.
#[test]
fn input_line_starts_with_the_pointer_and_dims_while_busy() {
    let mut view = ChatView::new();
    view.input = "hello".into();

    let idle = render_view(&view, 40, 8);
    let lines = screen(&idle);
    let prompt_row = lines
        .iter()
        .position(|line| line.starts_with("❯ hello"))
        .unwrap_or_else(|| panic!("prompt missing: {lines:?}"));
    let idle_buffer = idle.backend().buffer();
    assert!(
        !idle_buffer[(0, prompt_row as u16)]
            .modifier
            .contains(Modifier::DIM),
        "idle prompt must not be dim"
    );

    view.busy = true;
    let busy = render_view(&view, 40, 8);
    let busy_lines = screen(&busy);
    let busy_row = busy_lines
        .iter()
        .position(|line| line.starts_with("❯ hello"))
        .unwrap_or_else(|| panic!("busy prompt missing: {busy_lines:?}"));
    let busy_buffer = busy.backend().buffer();
    for x in 0..busy_buffer.area.width {
        assert!(
            busy_buffer[(x, busy_row as u16)]
                .modifier
                .contains(Modifier::DIM),
            "busy prompt cell ({x}, {busy_row}) is not dim"
        );
    }
}

/// `AssistantTextMessage.tsx:190-196` bullet column + `MessageResponse.tsx:20-25`
/// (`  ⎿  ` dim, five-column gutter).
#[test]
fn assistant_and_tool_lines_use_the_message_bullet_and_result_gutter() {
    let theme = Theme::dark();

    // Streaming assistant text: `MessageRow` reserves a two-column bullet
    // column, so the prose starts after `⏺ `/`● `.
    let mut view = ChatView::new();
    view.live_text = "hello".into();
    let live = live_lines(&view, 40, &theme);
    let live = live.last().expect("live line").to_string();
    assert!(
        live.starts_with("⏺ ") || live.starts_with("● "),
        "assistant bullet: {live:?}"
    );

    // Frozen transcript: assistant first line keeps the bullet, tool calls
    // add the bullet plus a space, tool results use the 5-column gutter.
    let rows = [
        Row::new(RowStyle::Assistant, "hello"),
        Row::new(RowStyle::ToolCall, "Bash(ls)"),
        Row::new(RowStyle::ToolResult, "a.txt"),
    ];
    let terminal = render_transcript(&rows, 40, 6, &theme);
    let lines = screen(&terminal);

    let bullet = format!("{} ", message_bullet());
    assert!(
        lines[0].starts_with(message_bullet()),
        "transcript assistant bullet: {:?}",
        lines[0]
    );
    assert!(
        lines[1].starts_with(&bullet),
        "tool call bullet: {:?}",
        lines[1]
    );
    assert!(
        lines[2].starts_with("  ⎿  "),
        "tool result gutter: {:?}",
        lines[2]
    );

    let buffer = terminal.backend().buffer();
    // The gutter (two spaces + `⎿` + two spaces) is painted dim.
    for x in 0..5 {
        assert_eq!(
            buffer[(x, 2)].fg,
            theme.palette.dim,
            "gutter cell {x} is not dim"
        );
    }
}

/// `UserPromptMessage.tsx:72-84`: full-width `userMessageBackground` block with
/// one column of right padding, so the final column never carries the bg.
#[test]
fn user_prompt_is_a_background_block_without_the_last_column() {
    let theme = Theme::dark();
    let rows = [Row::new(RowStyle::User, "hello")];
    let terminal = render_transcript(&rows, 20, 2, &theme);
    let buffer = terminal.backend().buffer();

    let last = buffer.area.width - 1;
    for x in 0..last {
        assert_eq!(
            buffer[(x, 0)].bg,
            theme.palette.user_message_bg,
            "column {x} lost the prompt background"
        );
    }
    assert_eq!(
        buffer[(last, 0)].bg,
        Color::Reset,
        "Ink's paddingRight={{1}}: the last column must stay unpainted"
    );
    assert_eq!(screen(&terminal)[0].trim_end(), "hello");
}

/// `Spinner.tsx:42-44,537`: `getDefaultCharacters()` + reverse sweep, 12 frames.
#[test]
fn spinner_frames_match_the_ink_sequence() {
    let expected: Vec<char> = "·✢✱✶✻✽✽✻✶✱✢·".chars().collect();
    assert_eq!(expected.len(), 12);

    let mut view = ChatView::new();
    view.busy = true;
    for (frame, glyph) in expected.iter().enumerate() {
        view.spinner_frame = frame;
        let line = view.status_line();
        assert!(
            line.starts_with(&format!("{glyph} ")),
            "frame {frame}: expected {glyph:?}, got {line:?}"
        );
    }
    // The sweep loops back to the first frame.
    view.spinner_frame = expected.len();
    assert!(view.status_line().starts_with("· "));
}

/// `CompactBoundaryMessage.tsx:11-13`, character for character.
#[test]
fn compact_boundary_matches_ink_character_for_character() {
    let event = cch_tui_proto::parse_line(r#"{"type":"system","subtype":"compact_boundary"}"#)
        .expect("frame");
    let mut view = ChatView::new();
    let rows = view.ingest(&event);
    assert_eq!(rows.len(), 1, "{rows:?}");
    assert_eq!(rows[0].style, RowStyle::System);

    let expected = "✻ Conversation compacted (ctrl+o for history)";
    assert_eq!(rows[0].text, expected);
    assert!(
        rows[0].text.chars().eq(expected.chars()),
        "text differs from the Ink literal: {:?}",
        rows[0].text
    );
}

/// `theme.ts` `diffAdded`/`diffRemoved` are used as **backgrounds**
/// (`StructuredDiff.tsx`, `FileEditToolDiff.tsx`).
#[test]
fn diff_rows_paint_the_theme_backgrounds() {
    let theme = Theme::dark();
    let rows = cch_tui_diff::diff_lines("alpha\nbeta\ngamma", "alpha\nBETA\ngamma");
    let lines = diff_to_lines(&rows, &theme);
    let height = lines.len() as u16;

    let added = lines
        .iter()
        .position(|line| line.to_string().starts_with("+ BETA"))
        .expect("added line missing");
    let removed = lines
        .iter()
        .position(|line| line.to_string().starts_with("- beta"))
        .expect("removed line missing");
    assert_eq!(
        lines[added].spans[0].style.bg,
        Some(theme.palette.diff_added_bg)
    );
    assert_eq!(
        lines[removed].spans[0].style.bg,
        Some(theme.palette.diff_removed_bg)
    );

    let terminal = draw_lines(lines, 20, height);
    let buffer = terminal.backend().buffer();
    assert_eq!(
        buffer[(0, added as u16)].bg,
        theme.palette.diff_added_bg,
        "added row background"
    );
    assert_eq!(
        buffer[(0, removed as u16)].bg,
        theme.palette.diff_removed_bg,
        "removed row background"
    );
}

/// `ToolUseLoader.tsx:16`: dim while unresolved, green on success, red on error.
/// The RGB values are the Ink `darkTheme` tokens (`theme.ts:457-462`).
#[test]
fn tool_bullet_colours_follow_pending_success_error() {
    let theme = Theme::dark();
    assert_eq!(theme.palette.dim, Color::Rgb(80, 80, 80));
    assert_eq!(theme.palette.success, Color::Rgb(78, 186, 101));
    assert_eq!(theme.palette.error, Color::Rgb(255, 107, 128));

    let rows = [
        Row::new(RowStyle::ToolCallPending, "Bash(ls)"),
        Row::new(RowStyle::ToolCall, "Read(f)"),
        Row::new(RowStyle::ToolCallError, "Edit(x)"),
    ];
    let terminal = render_transcript(&rows, 40, 4, &theme);
    let buffer = terminal.backend().buffer();

    for (y, expected) in [
        (0u16, theme.palette.dim),
        (1, theme.palette.success),
        (2, theme.palette.error),
    ] {
        assert!(
            buffer[(0, y)].symbol() == "⏺" || buffer[(0, y)].symbol() == "●",
            "row {y} lacks the message bullet: {:?}",
            buffer[(0, y)].symbol()
        );
        assert_eq!(
            buffer[(0, y)].fg,
            expected,
            "row {y} bullet colour must match the Ink loader state"
        );
    }
}
