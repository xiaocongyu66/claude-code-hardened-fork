//! Full-screen structured-diff dialog state.
//!
//! The dialog is fed one [`FileDiff`] parsed from an Edit/Write tool result
//! (`structuredPatch`). It owns the document rows, the scroll position and the
//! last known viewport height; no terminal types are involved, so the state
//! machine is testable on its own.
//!
//! Rows are laid out once, when the dialog opens:
//!
//! 1. file header (path)
//! 2. `+N/-M` stats
//! 3. a divider
//! 4. per hunk: `@@` header, then line-number gutter + marker + code
//! 5. `No diff content` when the patch carries no lines
//!
//! The footer (`esc close · ↑/↓ scroll`) is chrome drawn by the renderer and
//! is not part of the scrollable document.

use serde_json::Value;

/// Kind of one line inside a `structuredPatch` hunk.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DiffLineKind {
    Context,
    Added,
    Removed,
}

/// One line of an Edit/Write `structuredPatch` hunk.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiffLine {
    pub kind: DiffLineKind,
    /// Raw patch line, unified-diff marker included (`+`, `-` or space).
    pub text: String,
    /// 1-based line number: old-side for removals, new-side otherwise.
    pub line_number: u32,
}

impl DiffLine {
    /// Unified-diff marker for this line.
    pub fn marker(&self) -> char {
        match self.kind {
            DiffLineKind::Added => '+',
            DiffLineKind::Removed => '-',
            DiffLineKind::Context => ' ',
        }
    }

    /// Line content after the unified-diff marker.
    pub fn code(&self) -> &str {
        let mut chars = self.text.char_indices();
        match chars.next() {
            Some((_, '+' | '-' | ' ')) => {
                let offset = chars.next().map_or(self.text.len(), |(index, _)| index);
                &self.text[offset..]
            }
            _ => self.text.as_str(),
        }
    }
}

/// One `@@` hunk of a structured patch.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiffHunk {
    pub old_start: u32,
    pub old_lines: u32,
    pub new_start: u32,
    pub new_lines: u32,
    /// Display width of the largest line number in this hunk.
    pub number_width: usize,
    pub lines: Vec<DiffLine>,
}

impl DiffHunk {
    /// Unified-diff header (`@@ -old,lines +new,lines @@`).
    pub fn header(&self) -> String {
        format!(
            "@@ -{},{} +{},{} @@",
            self.old_start, self.old_lines, self.new_start, self.new_lines
        )
    }
}

/// The `structuredPatch` carried by an Edit/Write tool result.
///
/// This intentionally contains only what the frame provides: no repository or
/// working-tree diff is synthesized.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct FileDiff {
    /// `filePath` from the tool result, when present.
    pub path: Option<String>,
    pub hunks: Vec<DiffHunk>,
    /// Added/removed line counts, matching Ink's hunk counters.
    pub added: usize,
    pub removed: usize,
}

/// Parse `tool_use_result.structuredPatch` (Edit/Write results).
///
/// Returns `None` when the tool result has no structured patch (including the
/// empty patch Write emits for newly created files), so callers can report
/// "no diff" instead of opening an empty dialog.
pub fn parse_file_diff(result: Option<&Value>) -> Option<FileDiff> {
    let result = result?;
    let patch = result.get("structuredPatch")?.as_array()?;
    if patch.is_empty() {
        return None;
    }
    let path = result
        .get("filePath")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let number = |value: &Value, key: &str| {
        value
            .get(key)
            .and_then(Value::as_u64)
            .unwrap_or_default()
            .min(u64::from(u32::MAX)) as u32
    };
    let mut file = FileDiff {
        path,
        ..FileDiff::default()
    };
    for hunk in patch {
        let old_start = number(hunk, "oldStart");
        let old_lines = number(hunk, "oldLines");
        let new_start = number(hunk, "newStart");
        let new_lines = number(hunk, "newLines");
        let highest = old_start
            .saturating_add(old_lines.saturating_sub(1))
            .max(new_start.saturating_add(new_lines.saturating_sub(1)))
            .max(1);
        let number_width = highest.to_string().len();
        let mut old_line = old_start;
        let mut new_line = new_start;
        let mut lines = Vec::new();
        for line in hunk.get("lines")?.as_array()? {
            let Some(text) = line.as_str() else { continue };
            let kind = match text.chars().next() {
                Some('+') => DiffLineKind::Added,
                Some('-') => DiffLineKind::Removed,
                _ => DiffLineKind::Context,
            };
            let line_number = match kind {
                DiffLineKind::Added => {
                    let current = new_line;
                    new_line = new_line.saturating_add(1);
                    current
                }
                DiffLineKind::Removed => {
                    let current = old_line;
                    old_line = old_line.saturating_add(1);
                    current
                }
                DiffLineKind::Context => {
                    let current = new_line;
                    old_line = old_line.saturating_add(1);
                    new_line = new_line.saturating_add(1);
                    current
                }
            };
            match kind {
                DiffLineKind::Added => file.added += 1,
                DiffLineKind::Removed => file.removed += 1,
                DiffLineKind::Context => {}
            }
            lines.push(DiffLine {
                kind,
                text: text.to_string(),
                line_number,
            });
        }
        file.hunks.push(DiffHunk {
            old_start,
            old_lines,
            new_start,
            new_lines,
            number_width,
            lines,
        });
    }
    Some(file)
}

/// Visual role of a dialog document line.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DialogLineKind {
    FileHeader,
    Stats,
    Divider,
    Hunk,
    Context,
    Added,
    Removed,
    Empty,
}

/// One rendered row of the diff document.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DialogLine {
    pub kind: DialogLineKind,
    pub text: String,
}

/// Open/closed state plus scroll position of the diff dialog.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiffDialog {
    file: FileDiff,
    lines: Vec<DialogLine>,
    scroll: usize,
    viewport: usize,
}

impl DiffDialog {
    /// Build the document for `file`. The scroll position starts at the top.
    pub fn new(file: FileDiff) -> Self {
        let mut lines = Vec::new();
        let path = file.path.clone().unwrap_or_else(|| "(unknown file)".into());
        lines.push(DialogLine {
            kind: DialogLineKind::FileHeader,
            text: path,
        });
        lines.push(DialogLine {
            kind: DialogLineKind::Stats,
            text: format!("+{} -{}", file.added, file.removed),
        });
        lines.push(DialogLine {
            kind: DialogLineKind::Divider,
            text: String::new(),
        });
        let mut has_lines = false;
        for hunk in &file.hunks {
            lines.push(DialogLine {
                kind: DialogLineKind::Hunk,
                text: hunk.header(),
            });
            for line in &hunk.lines {
                has_lines = true;
                lines.push(DialogLine {
                    kind: match line.kind {
                        DiffLineKind::Added => DialogLineKind::Added,
                        DiffLineKind::Removed => DialogLineKind::Removed,
                        DiffLineKind::Context => DialogLineKind::Context,
                    },
                    // Mirrors the color-diff gutter: right-aligned line number,
                    // then the `+`/`-`/space marker, then the code.
                    text: format!(
                        " {:>width$} {}{}",
                        line.line_number,
                        line.marker(),
                        line.code(),
                        width = hunk.number_width,
                    ),
                });
            }
        }
        if !has_lines {
            lines.push(DialogLine {
                kind: DialogLineKind::Empty,
                text: "No diff content".into(),
            });
        }
        Self {
            file,
            lines,
            scroll: 0,
            viewport: 0,
        }
    }

    /// The patch backing this dialog.
    pub fn file(&self) -> &FileDiff {
        &self.file
    }

    /// Document rows (header, hunks and lines), before scrolling.
    pub fn lines(&self) -> &[DialogLine] {
        &self.lines
    }

    /// First visible document row.
    pub fn scroll(&self) -> usize {
        self.scroll.min(self.max_scroll())
    }

    /// Last viewport height passed to [`Self::set_viewport`].
    pub fn viewport(&self) -> usize {
        self.viewport
    }

    /// Update the viewport height (called each draw, so resize stays correct)
    /// and clamp the scroll position into range.
    pub fn set_viewport(&mut self, height: usize) {
        self.viewport = height;
        self.clamp();
    }

    /// Maximum useful scroll offset for the current viewport.
    pub fn max_scroll(&self) -> usize {
        self.lines.len().saturating_sub(self.viewport.max(1))
    }

    /// Rows visible at `viewport`, clamped to the document.
    pub fn visible_for(&self, viewport: usize) -> &[DialogLine] {
        let max = self.lines.len().saturating_sub(viewport.max(1));
        let start = self.scroll.min(max);
        let end = start.saturating_add(viewport).min(self.lines.len());
        &self.lines[start..end]
    }

    /// Rows visible in the last reported viewport.
    pub fn visible(&self) -> &[DialogLine] {
        self.visible_for(self.viewport)
    }

    pub fn scroll_up(&mut self) {
        self.scroll = self.scroll.saturating_sub(1);
    }

    pub fn scroll_down(&mut self) {
        self.scroll = self.scroll.saturating_add(1).min(self.max_scroll());
    }

    pub fn page_up(&mut self) {
        self.scroll = self.scroll.saturating_sub(self.page());
    }

    pub fn page_down(&mut self) {
        self.scroll = self
            .scroll
            .saturating_add(self.page())
            .min(self.max_scroll());
    }

    pub fn home(&mut self) {
        self.scroll = 0;
    }

    pub fn end(&mut self) {
        self.scroll = self.max_scroll();
    }

    /// Page step: one viewport, at least one line.
    pub fn page(&self) -> usize {
        self.viewport.max(1)
    }

    fn clamp(&mut self) {
        self.scroll = self.scroll.min(self.max_scroll());
    }
}

/// The dialog slot: closed until a patch is opened, cleared by Esc.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct DiffDialogState {
    open: Option<DiffDialog>,
}

impl DiffDialogState {
    pub fn new() -> Self {
        Self::default()
    }

    /// Open `file`. Returns `false` (and stays closed) when the patch has no
    /// hunks, so callers can report "no diff" instead of showing an empty
    /// frame.
    pub fn open(&mut self, file: FileDiff) -> bool {
        if file.hunks.is_empty() {
            return false;
        }
        self.open = Some(DiffDialog::new(file));
        true
    }

    /// Close the dialog (Esc). Safe to call when already closed.
    pub fn close(&mut self) {
        self.open = None;
    }

    pub fn is_open(&self) -> bool {
        self.open.is_some()
    }

    pub fn as_ref(&self) -> Option<&DiffDialog> {
        self.open.as_ref()
    }

    pub fn as_mut(&mut self) -> Option<&mut DiffDialog> {
        self.open.as_mut()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn line(kind: DiffLineKind, text: &str, number: u32) -> DiffLine {
        DiffLine {
            kind,
            text: text.into(),
            line_number: number,
        }
    }

    fn file() -> FileDiff {
        FileDiff {
            path: Some("src/main.rs".into()),
            hunks: vec![DiffHunk {
                old_start: 1,
                old_lines: 2,
                new_start: 1,
                new_lines: 3,
                number_width: 1,
                lines: vec![
                    line(DiffLineKind::Context, " fn main() {", 1),
                    line(DiffLineKind::Removed, "-    old();", 2),
                    line(DiffLineKind::Added, "+    new();", 2),
                    line(DiffLineKind::Added, "+    extra();", 3),
                ],
            }],
            added: 2,
            removed: 1,
        }
    }

    #[test]
    fn parse_tracks_path_line_numbers_and_counts() {
        let value = json!({
            "filePath": "src/lib.rs",
            "structuredPatch": [{
                "oldStart": 10,
                "oldLines": 3,
                "newStart": 10,
                "newLines": 3,
                "lines": [" context", "-old", "+new", " tail"],
            }],
        });
        let diff = parse_file_diff(Some(&value)).expect("patch");
        assert_eq!(diff.path.as_deref(), Some("src/lib.rs"));
        assert_eq!((diff.added, diff.removed), (1, 1));
        let hunk = &diff.hunks[0];
        assert_eq!(hunk.header(), "@@ -10,3 +10,3 @@");
        assert_eq!(hunk.number_width, 2);
        let lines: Vec<_> = hunk
            .lines
            .iter()
            .map(|line| (line.kind, line.line_number, line.code()))
            .collect();
        assert_eq!(
            lines,
            vec![
                (DiffLineKind::Context, 10, "context"),
                (DiffLineKind::Removed, 11, "old"),
                (DiffLineKind::Added, 11, "new"),
                (DiffLineKind::Context, 12, "tail"),
            ]
        );
    }

    #[test]
    fn empty_or_missing_patches_are_ignored() {
        let empty = json!({ "filePath": "x", "structuredPatch": [] });
        assert!(parse_file_diff(Some(&empty)).is_none());
        assert!(parse_file_diff(None).is_none());
        let missing = json!({ "filePath": "x" });
        assert!(parse_file_diff(Some(&missing)).is_none());
    }

    #[test]
    fn opening_builds_header_hunks_and_gutter() {
        let dialog = DiffDialog::new(file());
        let texts: Vec<&str> = dialog.lines().iter().map(|l| l.text.as_str()).collect();
        assert_eq!(texts[0], "src/main.rs");
        assert_eq!(texts[1], "+2 -1");
        assert_eq!(texts[3], "@@ -1,2 +1,3 @@");
        assert_eq!(texts[4], " 1  fn main() {");
        assert_eq!(texts[5], " 2 -    old();");
        assert_eq!(texts[6], " 2 +    new();");
        assert_eq!(texts[7], " 3 +    extra();");
        assert_eq!(dialog.scroll(), 0);
    }

    #[test]
    fn open_close_state_transitions() {
        let mut state = DiffDialogState::new();
        assert!(!state.is_open());
        assert!(!state.open(FileDiff::default()));
        assert!(!state.is_open());

        assert!(state.open(file()));
        assert!(state.is_open());
        state.as_mut().expect("open").set_viewport(2);
        state.as_mut().expect("open").page_down();
        assert_eq!(state.as_ref().expect("open").scroll(), 2);

        state.close();
        assert!(!state.is_open());
        state.close();
        assert!(!state.is_open());
    }

    #[test]
    fn scrolling_clamps_at_both_ends() {
        let mut dialog = DiffDialog::new(file());
        dialog.set_viewport(3);
        // 8 document rows, viewport 3 -> max scroll 5.
        assert_eq!(dialog.max_scroll(), 5);
        dialog.scroll_up();
        assert_eq!(dialog.scroll(), 0);
        for _ in 0..20 {
            dialog.scroll_down();
        }
        assert_eq!(dialog.scroll(), 5);
        assert_eq!(
            dialog.visible_for(3).first().unwrap().text,
            " 2 -    old();"
        );

        dialog.home();
        assert_eq!(dialog.scroll(), 0);
        dialog.page_down();
        assert_eq!(dialog.scroll(), 3);
        dialog.page_down();
        assert_eq!(dialog.scroll(), 5);
        dialog.page_up();
        assert_eq!(dialog.scroll(), 2);
        dialog.end();
        assert_eq!(dialog.scroll(), 5);
        dialog.scroll_down();
        assert_eq!(dialog.scroll(), 5);
    }

    #[test]
    fn resize_reclamps_the_visible_window() {
        let mut dialog = DiffDialog::new(file());
        dialog.set_viewport(3);
        dialog.end();
        assert_eq!(dialog.scroll(), 5);

        // A shorter viewport still holds the offset, and scrolling can reach
        // the new maximum.
        dialog.set_viewport(2);
        assert_eq!(dialog.scroll(), 5);
        dialog.scroll_down();
        assert_eq!(dialog.scroll(), 6);
        assert_eq!(dialog.visible_for(2).len(), 2);

        // A taller viewport shrinks the max offset and re-clamps in place.
        dialog.set_viewport(8);
        assert_eq!(dialog.scroll(), 0);
        assert_eq!(dialog.visible_for(8).len(), 8);
    }

    #[test]
    fn empty_patch_renders_a_placeholder_and_cannot_overflow() {
        let file = FileDiff {
            path: Some("empty.rs".into()),
            hunks: Vec::new(),
            added: 0,
            removed: 0,
        };
        let mut dialog = DiffDialog::new(file);
        assert_eq!(
            dialog.lines().last().map(|line| line.kind),
            Some(DialogLineKind::Empty)
        );
        assert_eq!(dialog.lines().last().unwrap().text, "No diff content");
        dialog.set_viewport(4);
        dialog.scroll_down();
        assert_eq!(dialog.scroll(), 0);
    }
}
