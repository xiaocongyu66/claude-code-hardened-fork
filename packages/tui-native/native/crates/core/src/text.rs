//! Pure multi-line text editing state.
//!
//! [`TextBuffer`] owns the text, the cursor, an optional selection, a kill
//! ring and an undo/redo stack. It deliberately knows nothing about terminals,
//! widgets or keybindings: the keymap crate resolves a key to an action and
//! the caller applies that action to this buffer.
//!
//! Cursor movement is measured in display columns via `unicode-width`, so a
//! CJK character occupies two columns and vertical movement preserves the
//! display column across lines. Offsets are byte offsets and always sit on a
//! `char` boundary (grapheme clusters such as emoji ZWJ sequences still move
//! one scalar at a time, which is enough for the prompt input).

use std::ops::Range;

use unicode_width::UnicodeWidthChar;

/// Width assumed for a tab when mapping offsets to display columns.
const TAB_WIDTH: usize = 4;
/// Number of undo snapshots retained.
const UNDO_LIMIT: usize = 1_000;
/// Number of kill-ring entries retained.
pub const KILL_RING_LIMIT: usize = 10;

/// Which end of the most recent kill a new kill is appended to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KillDirection {
    Prepend,
    Append,
}

/// Bounded ring of killed text with readline-style accumulation.
///
/// Consecutive kills are merged into the newest entry until
/// [`KillRing::break_sequence`] is called (which the buffer does on any
/// non-kill edit or cursor movement).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct KillRing {
    entries: Vec<String>,
    accumulating: bool,
}

impl KillRing {
    pub fn new() -> Self {
        Self::default()
    }

    /// Push a kill. Consecutive kills accumulate into the newest entry.
    pub fn push(&mut self, text: &str, direction: KillDirection) {
        if text.is_empty() {
            return;
        }
        if self.accumulating
            && let Some(front) = self.entries.first_mut()
        {
            match direction {
                KillDirection::Prepend => front.insert_str(0, text),
                KillDirection::Append => front.push_str(text),
            }
            return;
        }
        self.entries.insert(0, text.to_owned());
        self.entries.truncate(KILL_RING_LIMIT);
        self.accumulating = true;
    }

    /// Most recently killed text.
    pub fn current(&self) -> Option<&str> {
        self.entries.first().map(String::as_str)
    }

    /// All entries, newest first.
    pub fn entries(&self) -> &[String] {
        &self.entries
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    pub fn is_accumulating(&self) -> bool {
        self.accumulating
    }

    /// Stop merging the next kill into the newest entry.
    pub fn break_sequence(&mut self) {
        self.accumulating = false;
    }

    /// Rotate to the next kill (yank-pop) and return it.
    pub fn rotate(&mut self) -> Option<&str> {
        if self.entries.len() < 2 {
            return None;
        }
        self.entries.rotate_left(1);
        self.accumulating = false;
        self.current()
    }

    pub fn clear(&mut self) {
        self.entries.clear();
        self.accumulating = false;
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Snapshot {
    text: String,
    cursor: usize,
    anchor: Option<usize>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Yank {
    range: Range<usize>,
}

/// Editable prompt buffer: text, cursor, selection, kill ring, undo/redo.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TextBuffer {
    text: String,
    /// Byte offset, always on a char boundary.
    cursor: usize,
    /// Selection anchor; the selection spans anchor..cursor when they differ.
    anchor: Option<usize>,
    kill_ring: KillRing,
    undo: Vec<Snapshot>,
    redo: Vec<Snapshot>,
    undo_limit: usize,
    last_yank: Option<Yank>,
}

impl Default for TextBuffer {
    fn default() -> Self {
        Self::new()
    }
}

impl TextBuffer {
    pub fn new() -> Self {
        Self {
            text: String::new(),
            cursor: 0,
            anchor: None,
            kill_ring: KillRing::new(),
            undo: Vec::new(),
            redo: Vec::new(),
            undo_limit: UNDO_LIMIT,
            last_yank: None,
        }
    }

    pub fn from_text(text: impl Into<String>) -> Self {
        let mut buffer = Self::new();
        buffer.text = text.into();
        buffer.cursor = buffer.text.len();
        buffer
    }

    pub fn text(&self) -> &str {
        &self.text
    }

    pub fn len(&self) -> usize {
        self.text.len()
    }

    pub fn is_empty(&self) -> bool {
        self.text.is_empty()
    }

    pub fn cursor(&self) -> usize {
        self.cursor
    }

    pub fn kill_ring(&self) -> &KillRing {
        &self.kill_ring
    }

    pub fn can_undo(&self) -> bool {
        !self.undo.is_empty()
    }

    pub fn can_redo(&self) -> bool {
        !self.redo.is_empty()
    }

    /// Replace the whole buffer from the outside (history recall, clear, ...).
    /// This resets the cursor to the end and drops undo/redo history.
    pub fn set_text(&mut self, text: impl Into<String>) {
        self.text = text.into();
        self.cursor = self.text.len();
        self.anchor = None;
        self.undo.clear();
        self.redo.clear();
        self.last_yank = None;
        self.kill_ring.break_sequence();
    }

    /// Move the cursor to a byte offset. Not undoable; clears the selection.
    pub fn set_cursor(&mut self, offset: usize) {
        self.cursor = self.clamp_offset(offset);
        self.anchor = None;
        self.last_yank = None;
        self.kill_ring.break_sequence();
    }

    /// Select `anchor..cursor`; offsets are clamped to char boundaries.
    pub fn select(&mut self, anchor: usize, cursor: usize) {
        let anchor = self.clamp_offset(anchor);
        let cursor = self.clamp_offset(cursor);
        self.anchor = Some(anchor);
        self.cursor = cursor;
        self.last_yank = None;
        self.kill_ring.break_sequence();
    }

    pub fn select_all(&mut self) {
        self.anchor = Some(0);
        self.cursor = self.text.len();
        self.last_yank = None;
        self.kill_ring.break_sequence();
    }

    pub fn clear_selection(&mut self) {
        self.anchor = None;
    }

    pub fn selection_anchor(&self) -> Option<usize> {
        self.anchor
    }

    /// Normalised selection range, if a non-empty range is selected.
    pub fn selection(&self) -> Option<Range<usize>> {
        let anchor = self.anchor?;
        if anchor == self.cursor {
            return None;
        }
        Some(if anchor < self.cursor {
            anchor..self.cursor
        } else {
            self.cursor..anchor
        })
    }

    pub fn selected_text(&self) -> Option<&str> {
        self.selection().map(|range| &self.text[range])
    }

    /// Line index and display column of a byte offset.
    pub fn line_column(&self, offset: usize) -> (usize, usize) {
        let offset = self.clamp_offset(offset);
        let mut line = 0;
        let mut column = 0;
        for (index, ch) in self.text.char_indices() {
            if index >= offset {
                break;
            }
            if ch == '\n' {
                line += 1;
                column = 0;
            } else {
                column += char_width(ch);
            }
        }
        (line, column)
    }

    /// Cursor position in display coordinates.
    pub fn cursor_position(&self) -> (usize, usize) {
        self.line_column(self.cursor)
    }

    /// Number of logical lines (always at least one).
    pub fn line_count(&self) -> usize {
        self.text.bytes().filter(|byte| *byte == b'\n').count() + 1
    }

    /// Byte bounds of a logical line, excluding the trailing newline.
    pub fn line_bounds(&self, line: usize) -> Option<(usize, usize)> {
        if line >= self.line_count() {
            return None;
        }
        let mut start = 0;
        for _ in 0..line {
            start = self.text[start..].find('\n')? + start + 1;
        }
        let end = self.text[start..]
            .find('\n')
            .map_or(self.text.len(), |index| start + index);
        Some((start, end))
    }

    /// Byte offset on `line` closest to `column` without exceeding it.
    /// Columns that fall inside a wide character snap to that character's
    /// start.
    pub fn offset_for_line_column(&self, line: usize, column: usize) -> Option<usize> {
        let (start, end) = self.line_bounds(line)?;
        let mut used = 0;
        let mut best = start;
        for (index, ch) in self.text[start..end].char_indices() {
            let width = char_width(ch);
            if used + width > column {
                break;
            }
            used += width;
            best = start + index + ch.len_utf8();
            if used == column {
                break;
            }
        }
        Some(best)
    }

    // ---- movement -----------------------------------------------------

    /// Move one character left, collapsing a selection to its start.
    pub fn move_left(&mut self) -> bool {
        if let Some(selection) = self.selection() {
            self.cursor = selection.start;
            return self.movement_succeeded();
        }
        self.step_left()
    }

    /// Move one character right, collapsing a selection to its end.
    pub fn move_right(&mut self) -> bool {
        if let Some(selection) = self.selection() {
            self.cursor = selection.end;
            return self.movement_succeeded();
        }
        self.step_right()
    }

    /// Move up one display line. Returns `false` on the first line so callers
    /// can fall back to history navigation (mirrors the Ink input behavior).
    pub fn move_up(&mut self) -> bool {
        self.move_vertical(-1)
    }

    /// Move down one display line. Returns `false` on the last line.
    pub fn move_down(&mut self) -> bool {
        self.move_vertical(1)
    }

    /// Move up by `rows` logical lines, clamped to the first line.
    pub fn move_page_up(&mut self, rows: usize) -> bool {
        let rows = rows.min(self.line_count());
        self.move_vertical(-(rows as isize))
    }

    /// Move down by `rows` logical lines, clamped to the last line.
    pub fn move_page_down(&mut self, rows: usize) -> bool {
        let rows = rows.min(self.line_count());
        self.move_vertical(rows as isize)
    }

    /// Move to the start of the current logical line.
    pub fn move_home(&mut self) -> bool {
        let target = self.line_start(self.cursor);
        self.jump_to(target)
    }

    /// Move to the end of the current logical line.
    pub fn move_end(&mut self) -> bool {
        let target = self.line_end(self.cursor);
        self.jump_to(target)
    }

    // ---- selection-aware movement -------------------------------------

    pub fn extend_left(&mut self) -> bool {
        self.begin_extension();
        let moved = self.step_left_raw();
        self.extension_moved(moved)
    }

    pub fn extend_right(&mut self) -> bool {
        self.begin_extension();
        let moved = self.step_right_raw();
        self.extension_moved(moved)
    }

    pub fn extend_up(&mut self) -> bool {
        self.begin_extension();
        let moved = self.move_vertical_raw(-1);
        self.extension_moved(moved)
    }

    pub fn extend_down(&mut self) -> bool {
        self.begin_extension();
        let moved = self.move_vertical_raw(1);
        self.extension_moved(moved)
    }

    pub fn extend_home(&mut self) -> bool {
        self.begin_extension();
        let target = self.line_start(self.cursor);
        let moved = self.cursor != target;
        self.cursor = target;
        self.extension_moved(moved)
    }

    pub fn extend_end(&mut self) -> bool {
        self.begin_extension();
        let target = self.line_end(self.cursor);
        let moved = self.cursor != target;
        self.cursor = target;
        self.extension_moved(moved)
    }

    // ---- editing ------------------------------------------------------

    /// Insert text at the cursor, replacing the selection.
    pub fn insert_str(&mut self, text: &str) -> bool {
        if text.is_empty() {
            return false;
        }
        self.checkpoint();
        self.replace_selection_with(text);
        self.after_non_kill_edit();
        true
    }

    pub fn insert_char(&mut self, ch: char) -> bool {
        let mut encoded = [0_u8; 4];
        self.insert_str(ch.encode_utf8(&mut encoded))
    }

    /// Delete the selection, or the character before the cursor.
    pub fn backspace(&mut self) -> bool {
        if let Some(selection) = self.selection() {
            self.checkpoint();
            self.replace_range(selection, "");
            self.after_non_kill_edit();
            return true;
        }
        if self.cursor == 0 {
            return false;
        }
        let start = prev_boundary(&self.text, self.cursor);
        self.checkpoint();
        self.replace_range(start..self.cursor, "");
        self.after_non_kill_edit();
        true
    }

    /// Delete the selection, or the character after the cursor.
    pub fn delete_forward(&mut self) -> bool {
        if let Some(selection) = self.selection() {
            self.checkpoint();
            self.replace_range(selection, "");
            self.after_non_kill_edit();
            return true;
        }
        if self.cursor >= self.text.len() {
            return false;
        }
        let end = next_boundary(&self.text, self.cursor);
        self.checkpoint();
        self.replace_range(self.cursor..end, "");
        self.after_non_kill_edit();
        true
    }

    /// Ctrl+K: kill to the end of the line (or the newline at the line end).
    pub fn kill_to_line_end(&mut self) -> bool {
        if let Some(selection) = self.selection() {
            return self.kill_range(selection, KillDirection::Append);
        }
        let start = self.cursor;
        let end = self.line_end(start);
        let range = if start < end {
            start..end
        } else if self.text[start..].starts_with('\n') {
            start..start + 1
        } else {
            return false;
        };
        self.kill_range(range, KillDirection::Append)
    }

    /// Ctrl+U: kill from the start of the line (or the preceding newline).
    pub fn kill_to_line_start(&mut self) -> bool {
        if let Some(selection) = self.selection() {
            return self.kill_range(selection, KillDirection::Prepend);
        }
        let start = self.cursor;
        let range = if start > 0 && self.text[..start].ends_with('\n') {
            start - 1..start
        } else {
            let line_start = self.line_start(start);
            line_start..start
        };
        if range.is_empty() {
            return false;
        }
        self.kill_range(range, KillDirection::Prepend)
    }

    /// Ctrl+W: kill the whitespace-delimited word before the cursor.
    pub fn kill_word_before(&mut self) -> bool {
        if let Some(selection) = self.selection() {
            return self.kill_range(selection, KillDirection::Prepend);
        }
        let start = self.word_start_before(self.cursor);
        if start == self.cursor {
            return false;
        }
        self.kill_range(start..self.cursor, KillDirection::Prepend)
    }

    /// Ctrl+Y: insert the most recent kill at the cursor.
    pub fn yank(&mut self) -> bool {
        let Some(text) = self.kill_ring.current().map(str::to_owned) else {
            return false;
        };
        self.checkpoint();
        let start = self.selection().map_or(self.cursor, |range| range.start);
        self.replace_selection_with(&text);
        let end = start + text.len();
        self.cursor = end;
        self.anchor = None;
        self.last_yank = Some(Yank { range: start..end });
        // A yank ends the kill accumulation; the next kill starts fresh.
        self.kill_ring.break_sequence();
        true
    }

    /// Alt+Y: replace the last yank with the previous kill-ring entry.
    pub fn yank_pop(&mut self) -> bool {
        let Some(yank) = self.last_yank.clone() else {
            return false;
        };
        let Some(next) = self.kill_ring.rotate().map(str::to_owned) else {
            return false;
        };
        self.checkpoint();
        let start = yank.range.start;
        self.text.replace_range(yank.range, &next);
        self.cursor = start + next.len();
        self.anchor = None;
        self.last_yank = Some(Yank {
            range: start..self.cursor,
        });
        true
    }

    // ---- history ------------------------------------------------------

    /// Undo the last edit. Cursor movement does not create undo entries.
    pub fn undo(&mut self) -> bool {
        let Some(previous) = self.undo.pop() else {
            return false;
        };
        let current = self.snapshot();
        self.redo.push(current);
        self.restore(previous);
        true
    }

    pub fn redo(&mut self) -> bool {
        let Some(next) = self.redo.pop() else {
            return false;
        };
        let current = self.snapshot();
        self.undo.push(current);
        self.restore(next);
        true
    }

    // ---- internals ----------------------------------------------------

    fn snapshot(&self) -> Snapshot {
        Snapshot {
            text: self.text.clone(),
            cursor: self.cursor,
            anchor: self.anchor,
        }
    }

    fn restore(&mut self, snapshot: Snapshot) {
        self.text = snapshot.text;
        self.cursor = clamp_boundary(&self.text, snapshot.cursor);
        self.anchor = snapshot.anchor.map(|a| clamp_boundary(&self.text, a));
        self.last_yank = None;
        self.kill_ring.break_sequence();
    }

    fn checkpoint(&mut self) {
        self.undo.push(self.snapshot());
        if self.undo.len() > self.undo_limit {
            self.undo.remove(0);
        }
        self.redo.clear();
    }

    fn after_non_kill_edit(&mut self) {
        self.anchor = None;
        self.last_yank = None;
        self.kill_ring.break_sequence();
    }

    /// Replace the selection (if any) with `text` and place the cursor after
    /// the inserted text. Assumes a checkpoint was already taken.
    fn replace_selection_with(&mut self, text: &str) {
        let range = self.selection().unwrap_or(self.cursor..self.cursor);
        let start = range.start;
        self.replace_range(range, text);
        self.cursor = start + text.len();
        self.anchor = None;
    }

    fn replace_range(&mut self, range: Range<usize>, text: &str) {
        self.text.replace_range(range.clone(), text);
        self.cursor = clamp_boundary(&self.text, range.start + text.len());
    }

    fn kill_range(&mut self, range: Range<usize>, direction: KillDirection) -> bool {
        if range.is_empty() {
            return false;
        }
        let killed = self.text[range.clone()].to_owned();
        self.checkpoint();
        self.replace_range(range, "");
        self.anchor = None;
        self.last_yank = None;
        self.kill_ring.push(&killed, direction);
        true
    }

    fn begin_extension(&mut self) {
        if self.anchor.is_none() {
            self.anchor = Some(self.cursor);
        }
        self.last_yank = None;
        self.kill_ring.break_sequence();
    }

    fn extension_moved(&mut self, moved: bool) -> bool {
        if moved {
            self.last_yank = None;
            self.kill_ring.break_sequence();
        }
        moved
    }

    fn jump_to(&mut self, target: usize) -> bool {
        if self.cursor == target {
            return false;
        }
        self.cursor = target;
        self.movement_succeeded()
    }

    fn step_left(&mut self) -> bool {
        if self.step_left_raw() {
            self.movement_succeeded()
        } else {
            false
        }
    }

    fn step_right(&mut self) -> bool {
        if self.step_right_raw() {
            self.movement_succeeded()
        } else {
            false
        }
    }

    fn step_left_raw(&mut self) -> bool {
        if self.cursor == 0 {
            return false;
        }
        self.cursor = prev_boundary(&self.text, self.cursor);
        true
    }

    fn step_right_raw(&mut self) -> bool {
        if self.cursor >= self.text.len() {
            return false;
        }
        self.cursor = next_boundary(&self.text, self.cursor);
        true
    }

    fn movement_succeeded(&mut self) -> bool {
        self.anchor = None;
        self.last_yank = None;
        self.kill_ring.break_sequence();
        true
    }

    fn move_vertical(&mut self, delta: isize) -> bool {
        if self.move_vertical_raw(delta) {
            self.movement_succeeded()
        } else {
            false
        }
    }

    /// Move by `delta` logical lines, preserving the display column.
    fn move_vertical_raw(&mut self, delta: isize) -> bool {
        let (line, column) = self.cursor_position();
        let last_line = self.line_count() - 1;
        let target_line = if delta < 0 {
            line.saturating_sub(delta.unsigned_abs())
        } else {
            (line + delta as usize).min(last_line)
        };
        if target_line == line {
            return false;
        }
        let target = self
            .offset_for_line_column(target_line, column)
            .unwrap_or(self.cursor);
        self.cursor = target;
        true
    }

    fn line_start(&self, offset: usize) -> usize {
        self.text[..offset].rfind('\n').map_or(0, |index| index + 1)
    }

    fn line_end(&self, offset: usize) -> usize {
        self.text[offset..]
            .find('\n')
            .map_or(self.text.len(), |index| offset + index)
    }

    fn word_start_before(&self, offset: usize) -> usize {
        let mut start = offset;
        let mut chars = self.text[..offset].char_indices().rev().peekable();
        while let Some(&(index, ch)) = chars.peek() {
            if !ch.is_whitespace() {
                break;
            }
            start = index;
            chars.next();
        }
        while let Some(&(index, ch)) = chars.peek() {
            if ch.is_whitespace() {
                break;
            }
            start = index;
            chars.next();
        }
        start
    }

    fn clamp_offset(&self, offset: usize) -> usize {
        clamp_boundary(&self.text, offset)
    }
}

fn char_width(ch: char) -> usize {
    if ch == '\t' {
        return TAB_WIDTH;
    }
    ch.width().unwrap_or(0)
}

fn clamp_boundary(text: &str, offset: usize) -> usize {
    let mut offset = offset.min(text.len());
    while !text.is_char_boundary(offset) {
        offset -= 1;
    }
    offset
}

fn prev_boundary(text: &str, offset: usize) -> usize {
    text[..offset]
        .char_indices()
        .next_back()
        .map_or(0, |(index, _)| index)
}

fn next_boundary(text: &str, offset: usize) -> usize {
    text[offset..]
        .chars()
        .next()
        .map_or(text.len(), |ch| offset + ch.len_utf8())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn inserts_and_edits_multiple_lines() {
        let mut buffer = TextBuffer::new();
        assert!(buffer.insert_str("hello\nworld"));
        assert_eq!(buffer.text(), "hello\nworld");
        assert_eq!(buffer.cursor(), 11);
        assert_eq!(buffer.line_count(), 2);
        assert_eq!(buffer.cursor_position(), (1, 5));

        assert!(buffer.move_home());
        assert_eq!(buffer.cursor(), 6);
        assert_eq!(buffer.cursor_position(), (1, 0));

        assert!(buffer.insert_str("big "));
        assert_eq!(buffer.text(), "hello\nbig world");

        assert!(buffer.move_end());
        assert!(buffer.backspace());
        assert_eq!(buffer.text(), "hello\nbig worl");

        assert!(buffer.move_up());
        assert_eq!(buffer.cursor_position(), (0, 5));
        assert!(buffer.move_down());
        assert_eq!(buffer.cursor_position(), (1, 5));
        assert!(!buffer.move_down());
    }

    #[test]
    fn undo_and_redo_walk_the_edit_history() {
        let mut buffer = TextBuffer::new();
        buffer.insert_str("a");
        buffer.insert_str("b");
        buffer.insert_str("c");
        assert_eq!(buffer.text(), "abc");

        assert!(buffer.undo());
        assert_eq!(buffer.text(), "ab");
        assert!(buffer.undo());
        assert_eq!(buffer.text(), "a");
        assert!(buffer.undo());
        assert_eq!(buffer.text(), "");
        assert!(!buffer.undo());

        assert!(buffer.redo());
        assert_eq!(buffer.text(), "a");
        assert!(buffer.redo());
        assert_eq!(buffer.text(), "ab");
        assert!(buffer.redo());
        assert_eq!(buffer.text(), "abc");
        assert!(!buffer.redo());

        // A fresh edit truncates the redo branch.
        buffer.undo();
        buffer.insert_str("d");
        assert!(!buffer.can_redo());
        assert_eq!(buffer.text(), "abd");
    }

    #[test]
    fn kill_ring_accumulates_and_yanks() {
        let mut buffer = TextBuffer::from_text("one two");
        assert!(buffer.kill_word_before());
        assert_eq!(buffer.text(), "one ");
        assert_eq!(buffer.kill_ring().current(), Some("two"));

        // Consecutive kill accumulates with prepend.
        assert!(buffer.kill_word_before());
        assert_eq!(buffer.text(), "");
        assert_eq!(buffer.kill_ring().current(), Some("one two"));

        assert!(buffer.yank());
        assert_eq!(buffer.text(), "one two");
        assert_eq!(buffer.cursor(), 7);

        // A non-kill edit breaks accumulation.
        buffer.insert_str("!");
        let mut ring = KillRing::new();
        ring.push("a", KillDirection::Append);
        ring.push("b", KillDirection::Append);
        assert_eq!(ring.current(), Some("ab"));
        ring.break_sequence();
        ring.push("c", KillDirection::Append);
        assert_eq!(ring.entries(), ["c", "ab"]);

        assert_eq!(ring.rotate(), Some("ab"));
        assert_eq!(ring.current(), Some("ab"));
    }

    #[test]
    fn yank_pop_replaces_the_previous_yank() {
        let mut buffer = TextBuffer::from_text("one two");
        buffer.set_cursor(buffer.len());
        assert!(buffer.kill_word_before()); // ring: ["two"]
        assert_eq!(buffer.text(), "one ");

        assert!(buffer.insert_str("!")); // a non-kill edit breaks accumulation
        assert!(buffer.kill_word_before()); // ring: ["!", "two"]
        assert_eq!(buffer.text(), "one ");

        assert!(buffer.yank());
        assert_eq!(buffer.text(), "one !");
        assert!(buffer.yank_pop());
        assert_eq!(buffer.text(), "one two");
        assert_eq!(buffer.cursor(), 7);
        assert_eq!(buffer.kill_ring().current(), Some("two"));
    }

    #[test]
    fn kill_ring_rotates_through_entries() {
        let mut ring = KillRing::new();
        ring.push("one", KillDirection::Append);
        ring.break_sequence();
        ring.push("two", KillDirection::Append);
        ring.break_sequence();
        ring.push("three", KillDirection::Append);
        assert_eq!(ring.entries(), ["three", "two", "one"]);
        assert_eq!(ring.rotate(), Some("two"));
        assert_eq!(ring.rotate(), Some("one"));
        assert_eq!(ring.rotate(), Some("three"));
    }

    #[test]
    fn cjk_cursor_moves_by_display_width() {
        let mut buffer = TextBuffer::from_text("a汉b");
        assert_eq!(buffer.cursor_position(), (0, 4));

        buffer.set_cursor(0);
        assert!(buffer.move_right());
        assert_eq!(buffer.cursor(), 1);
        assert_eq!(buffer.cursor_position(), (0, 1));

        assert!(buffer.move_right());
        assert_eq!(
            buffer.cursor(),
            4,
            "steps over all three bytes of the CJK char"
        );
        assert_eq!(buffer.cursor_position(), (0, 3));

        assert!(buffer.move_right());
        assert_eq!(buffer.cursor(), 5);
        assert!(!buffer.move_right());
    }

    #[test]
    fn cjk_vertical_movement_preserves_display_column() {
        let mut buffer = TextBuffer::from_text("ab\n汉字");
        buffer.set_cursor(1); // column 1 on line 0
        assert_eq!(buffer.cursor_position(), (0, 1));

        assert!(buffer.move_down());
        // Column 1 falls inside the wide character; snap to its start.
        assert_eq!(buffer.cursor_position(), (1, 0));
        assert_eq!(buffer.cursor(), 3);

        assert!(buffer.move_up());
        assert_eq!(buffer.cursor_position(), (0, 0));

        // Moving between lines at the same display column.
        buffer.set_cursor(2); // end of "ab", column 2
        assert!(buffer.move_down());
        assert_eq!(buffer.cursor_position(), (1, 2));
        assert_eq!(buffer.cursor(), 6, "after the first CJK char");
    }

    #[test]
    fn selection_replaces_and_extend_tracks_anchor() {
        let mut buffer = TextBuffer::from_text("hello");
        buffer.select(1, 4);
        assert_eq!(buffer.selected_text(), Some("ell"));
        assert!(buffer.insert_str("i"));
        assert_eq!(buffer.text(), "hio");
        assert_eq!(buffer.cursor(), 2);
        assert_eq!(buffer.selection(), None);

        buffer.select_all();
        assert_eq!(buffer.selected_text(), Some("hio"));
        assert!(buffer.backspace());
        assert_eq!(buffer.text(), "");
        assert!(buffer.undo());
        assert_eq!(buffer.text(), "hio");

        buffer.set_cursor(0);
        assert!(buffer.extend_right());
        assert!(buffer.extend_right());
        assert_eq!(buffer.selection(), Some(0..2));
        assert!(buffer.move_left());
        assert_eq!(buffer.cursor(), 0);
        assert_eq!(buffer.selection(), None);
    }

    #[test]
    fn kill_to_line_bounds_and_word_kill() {
        let mut buffer = TextBuffer::from_text("abc def\nghi");
        buffer.set_cursor(3);
        assert!(buffer.kill_to_line_end());
        assert_eq!(buffer.text(), "abc\nghi");
        assert_eq!(buffer.kill_ring().current(), Some(" def"));

        buffer.set_cursor(6); // after "gh", line start + 2
        assert!(buffer.kill_to_line_start());
        assert_eq!(buffer.text(), "abc\ni");
        assert_eq!(buffer.kill_ring().current(), Some("gh"));

        buffer.set_cursor(4); // right after the newline
        assert!(buffer.kill_to_line_start());
        assert_eq!(buffer.text(), "abci");
        assert_eq!(buffer.kill_ring().current(), Some("\n"));
        assert_eq!(buffer.kill_ring().entries(), ["\n", "gh", " def"]);
    }

    #[test]
    fn kill_word_respects_surrounding_whitespace() {
        let mut buffer = TextBuffer::from_text("foo  bar");
        buffer.kill_word_before();
        assert_eq!(buffer.text(), "foo  ");
        assert_eq!(buffer.kill_ring().current(), Some("bar"));

        buffer.move_left(); // breaks the kill sequence
        buffer.kill_word_before();
        assert_eq!(buffer.text(), " ");
        assert_eq!(buffer.kill_ring().entries(), ["foo ", "bar"]);
    }

    #[test]
    fn home_end_and_move_vertical_return_false_at_bounds() {
        let mut buffer = TextBuffer::from_text("one\ntwo");
        assert!(buffer.move_home());
        assert_eq!(buffer.cursor(), 4);
        assert!(!buffer.move_home());
        assert!(buffer.move_end());
        assert_eq!(buffer.cursor(), 7);
        assert!(!buffer.move_end());
        assert!(!buffer.move_down());
        assert!(buffer.move_up());
        assert_eq!((buffer.cursor_position()), (0, 3));
        assert!(!buffer.move_up());
    }

    #[test]
    fn page_movement_clamps_to_buffer() {
        let mut buffer = TextBuffer::from_text("0\n1\n2\n3\n4");
        buffer.set_cursor(0);
        assert!(buffer.move_page_down(10));
        assert_eq!(buffer.cursor_position().0, 4);
        assert!(!buffer.move_page_down(1));
        assert!(buffer.move_page_up(2));
        assert_eq!(buffer.cursor_position().0, 2);
    }
}
