//! Row-based message focus.
//!
//! [`MessageActions`] navigates a purpose-built list of messages. This module
//! derives that list from the transcript rows the view already owns, so the
//! binary can wire keys without re-deriving block boundaries itself:
//!
//! - [`block_starts`] lists the row index where each navigable message begins.
//!   Empty spacing rows and tool-result/diff continuation rows are skipped; a
//!   multi-row user prompt is one block (only its first row starts it).
//! - [`message_metas`] turns those starts into [`MessageMeta`] descriptors with
//!   the text [`MessageActions::perform`] copies and a key [`ExpandState`] can
//!   toggle.
//! - [`copy_target`] answers "what should Ctrl+Y copy": the focused block, or
//!   the newest assistant prose when nothing is focused.
//! - [`toggle_focused`] flips only the focused block's expansion key.

use cch_tui_ui::{Row, RowStyle};

use crate::{ActionOutcome, ExpandState, MessageAction, MessageActions, MessageMeta, RowKey};

/// Styles that always continue the message opened by an earlier row.
fn is_continuation(style: RowStyle) -> bool {
    matches!(
        style,
        RowStyle::ToolResult
            | RowStyle::DiffHunk
            | RowStyle::DiffAdded
            | RowStyle::DiffRemoved
            | RowStyle::DiffContext
    )
}

/// Whether the block contains collapsible tool output.
fn is_tool_content(style: RowStyle) -> bool {
    matches!(
        style,
        RowStyle::Tool
            | RowStyle::ToolCall
            | RowStyle::ToolCallPending
            | RowStyle::ToolCallError
            | RowStyle::ToolResult
            | RowStyle::DiffHunk
            | RowStyle::DiffAdded
            | RowStyle::DiffRemoved
            | RowStyle::DiffContext
    )
}

/// Indexes in `rows` where navigable message blocks start.
///
/// Blank rows (the fullscreen spacing separators) and continuation rows are
/// skipped. Consecutive [`RowStyle::User`] rows are one prompt and consecutive
/// [`RowStyle::Tool`] rows are one output block, so only the first row of each
/// run is a start. Tool calls open their own block; their result rows are
/// continuations.
pub fn block_starts(rows: &[Row]) -> Vec<usize> {
    let mut starts = Vec::new();
    for (index, row) in rows.iter().enumerate() {
        if row.text.trim().is_empty() || is_continuation(row.style) {
            continue;
        }
        let continues_run = matches!(row.style, RowStyle::User | RowStyle::Tool)
            && index > 0
            && rows[index - 1].style == row.style;
        if !continues_run {
            starts.push(index);
        }
    }
    starts
}

/// Copy text for one block slice.
fn block_text(rows: &[Row]) -> String {
    rows.iter()
        .filter(|row| !row.text.trim().is_empty())
        .map(|row| match row.style {
            // The frozen prompt row is stored with the `> ` prefix; copy the
            // raw prompt like Ink's `copyTextOf`.
            RowStyle::User => row.text.strip_prefix("> ").unwrap_or(row.text.as_str()),
            _ => row.text.as_str(),
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// Build the action cursor entries for `rows`, in display order.
pub fn message_metas(rows: &[Row]) -> Vec<MessageMeta> {
    let starts = block_starts(rows);
    starts
        .iter()
        .enumerate()
        .map(|(position, &start)| {
            let end = starts.get(position + 1).copied().unwrap_or(rows.len());
            let block = &rows[start..end];
            let mut meta = MessageMeta::new(start, block_text(block));
            if block.iter().any(|row| is_tool_content(row.style)) {
                meta = meta.expandable();
            }
            if rows[start].style == RowStyle::User {
                meta = meta.rewindable();
            }
            meta
        })
        .collect()
}

/// Newest assistant prose, used when no message is focused.
pub fn latest_assistant_text(rows: &[Row]) -> Option<String> {
    rows.iter()
        .rev()
        .find(|row| row.style == RowStyle::Assistant && !row.text.trim().is_empty())
        .map(|row| row.text.clone())
}

/// Text for the copy action: the focused message, or the newest assistant
/// message when the focus is cleared (or the focused block is empty).
pub fn copy_target(actions: &MessageActions, rows: &[Row]) -> Option<String> {
    match actions.perform(MessageAction::CopyText) {
        ActionOutcome::Copied(text) if !text.trim().is_empty() => Some(text),
        _ => latest_assistant_text(rows),
    }
}

/// Toggle the focused block's expansion key and return it.
///
/// Other keys are untouched, so a full transcript rebuild can expand or
/// collapse exactly one message.
pub fn toggle_focused(actions: &MessageActions, expand: &mut ExpandState) -> Option<RowKey> {
    let key = actions.focused()?.key.clone();
    expand.toggle(key.clone());
    Some(key)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{ExpandLimits, project};

    fn row(style: RowStyle, text: &str) -> Row {
        Row::new(style, text)
    }

    /// Assistant, blank, a two-row user prompt, a tool call with a result,
    /// blanks, then an assistant reply.
    fn sample() -> Vec<Row> {
        vec![
            row(RowStyle::Assistant, "hello"),
            row(RowStyle::System, ""),
            row(RowStyle::User, "> first"),
            row(RowStyle::User, "second line"),
            row(RowStyle::ToolCall, "Bash(ls)"),
            row(RowStyle::ToolResult, "a.txt"),
            row(RowStyle::ToolResult, ""),
            row(RowStyle::System, ""),
            row(RowStyle::Assistant, "bye"),
        ]
    }

    #[test]
    fn block_starts_skip_blanks_and_tool_results() {
        assert_eq!(block_starts(&sample()), vec![0, 2, 4, 8]);
        // A single multi-line user prompt is one block.
        assert_eq!(
            block_starts(&[
                row(RowStyle::User, "> a"),
                row(RowStyle::User, "b"),
                row(RowStyle::User, "c"),
            ]),
            vec![0]
        );
        // Blank transcripts have nothing to focus.
        assert!(block_starts(&[]).is_empty());
        assert!(block_starts(&[row(RowStyle::System, "   ")]).is_empty());
    }

    #[test]
    fn focus_walks_blocks_and_stops_at_the_edges() {
        let mut actions = MessageActions::new(message_metas(&sample()));
        actions.clear();
        assert_eq!(actions.focus(), None);

        // Entering from an unfocused state lands on the newest block.
        assert_eq!(actions.previous_or_last(), Some(3));
        assert_eq!(actions.focused().unwrap().key, RowKey::Index(8));

        // Older skips the blank and continues at the tool block (not its
        // result rows), then the user prompt, then the first assistant row.
        assert_eq!(actions.previous(), Some(2));
        assert_eq!(actions.focused().unwrap().key, RowKey::Index(4));
        assert_eq!(actions.previous(), Some(1));
        assert_eq!(actions.focused().unwrap().key, RowKey::Index(2));
        assert_eq!(actions.previous(), Some(0));
        assert_eq!(actions.previous(), None);
        assert_eq!(actions.focus(), Some(0));

        // Newer walks back; the end is clamped rather than wrapping.
        assert_eq!(actions.next(), Some(1));
        assert_eq!(actions.next(), Some(2));
        assert_eq!(actions.next(), Some(3));
        assert_eq!(actions.next(), None);
        assert_eq!(actions.focus(), Some(3));
    }

    #[test]
    fn copy_target_prefers_the_focus_and_falls_back_to_the_newest_reply() {
        let rows = sample();
        let mut actions = MessageActions::new(message_metas(&rows));

        // No explicit focus still copies the newest assistant prose.
        actions.clear();
        assert_eq!(copy_target(&actions, &rows).as_deref(), Some("bye"));

        // The tool block copies its call plus result continuation rows.
        actions.set_focus(Some(2));
        assert_eq!(
            copy_target(&actions, &rows).as_deref(),
            Some("Bash(ls)\na.txt")
        );

        // The user block joins its rows and drops the stored prompt prefix.
        actions.set_focus(Some(1));
        assert_eq!(
            copy_target(&actions, &rows).as_deref(),
            Some("first\nsecond line")
        );

        // An empty transcript copies nothing.
        assert_eq!(copy_target(&MessageActions::new(Vec::new()), &[]), None);
    }

    fn tool_block(prefix: &str) -> Vec<Row> {
        (0..4)
            .map(|index| row(RowStyle::Tool, &format!("{prefix}{index}")))
            .collect()
    }

    #[test]
    fn toggle_focused_only_changes_the_focused_block() {
        let mut rows = tool_block("a");
        rows.push(row(RowStyle::Assistant, "between"));
        rows.extend(tool_block("b"));

        let mut actions = MessageActions::new(message_metas(&rows));
        // Message 0 is the first tool block (rows 0..4); message 2 is the
        // second (rows 5..9).
        actions.set_focus(Some(0));
        assert_eq!(actions.focused().unwrap().key, RowKey::Index(0));

        let mut expand = ExpandState::new();
        let key = toggle_focused(&actions, &mut expand).expect("focused block");
        assert_eq!(key, RowKey::Index(0));
        assert!(expand.is_expanded(0usize));
        assert!(!expand.is_expanded(5usize));

        let out = project(&rows, &expand, ExpandLimits::default());
        assert!(out.iter().any(|row| row.text == "a3"), "{out:?}");
        assert!(!out.iter().any(|row| row.text == "b3"), "{out:?}");
        assert!(
            out.iter().any(|row| row.text.contains("+1 lines")),
            "{out:?}"
        );

        // Toggling back hides only the first block's tail again.
        toggle_focused(&actions, &mut expand);
        let out = project(&rows, &expand, ExpandLimits::default());
        assert!(!out.iter().any(|row| row.text == "a3"), "{out:?}");
        assert!(!out.iter().any(|row| row.text == "b3"), "{out:?}");
    }

    #[test]
    fn toggle_focused_without_a_focus_is_a_no_op() {
        let mut actions = MessageActions::new(message_metas(&sample()));
        actions.clear();
        let mut expand = ExpandState::new();
        assert_eq!(toggle_focused(&actions, &mut expand), None);
        assert_eq!(expand, ExpandState::new());
    }
}
