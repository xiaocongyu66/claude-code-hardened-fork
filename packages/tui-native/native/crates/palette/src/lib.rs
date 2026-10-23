//! Slash-command palette: filtering, navigation and row shaping.
//!
//! Pure logic only. The caller feeds the current input line to
//! [`CommandPalette::set_query`], routes up/down/enter/escape keys to
//! [`CommandPalette::next`], [`CommandPalette::prev`],
//! [`CommandPalette::accept`] and [`CommandPalette::dismiss`], and paints
//! [`CommandPalette::rows`]. No terminal, engine or clock I/O happens here.
//!
//! The palette is active only while the input starts with `/`. The leading
//! slash is not part of the filter text: `"/co"` matches command names with
//! the needle `"co"`. Prefix matches are listed first, then substring matches;
//! both groups keep the original command order and hidden commands never
//! appear.

#![forbid(unsafe_code)]

use cch_tui_ui::{Row, RowStyle};

/// Maximum number of rows the palette renders at once.
pub const MAX_ROWS: usize = 8;

/// One command shown (or hidden) by the palette.
///
/// Mirrors the interactive engine metadata (`name`, `description`,
/// `argumentHint`) plus the `isHidden` flag. Names are stored without the
/// leading slash; a stray slash is tolerated when filtering and accepting.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommandSpec {
    pub name: String,
    pub description: Option<String>,
    pub argument_hint: Option<String>,
    pub hidden: bool,
}

impl CommandSpec {
    pub fn new(name: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            description: None,
            argument_hint: None,
            hidden: false,
        }
    }

    pub fn with_description(mut self, description: impl Into<String>) -> Self {
        self.description = Some(description.into());
        self
    }

    pub fn with_argument_hint(mut self, hint: impl Into<String>) -> Self {
        self.argument_hint = Some(hint.into());
        self
    }

    /// Mark this command as hidden from the palette.
    pub fn hide(mut self) -> Self {
        self.hidden = true;
        self
    }
}

/// Filtering and selection state for the slash-command menu.
#[derive(Debug, Clone)]
pub struct CommandPalette {
    specs: Vec<CommandSpec>,
    query: String,
    active: bool,
    /// Index into the current filtered list, not into `specs`.
    selected: usize,
}

impl CommandPalette {
    /// Create an inactive palette over `specs`.
    pub fn new(specs: Vec<CommandSpec>) -> Self {
        Self {
            specs,
            query: String::new(),
            active: false,
            selected: 0,
        }
    }

    /// Update the input line. The palette only becomes (and stays) active when
    /// the input starts with `/`; any other input deactivates it. Changing the
    /// input resets the selection to the first match.
    pub fn set_query(&mut self, input: impl AsRef<str>) {
        let input = input.as_ref();
        self.query.clear();
        self.query.push_str(input);
        self.active = input.starts_with('/');
        self.selected = 0;
    }

    /// The raw input line most recently passed to [`Self::set_query`].
    pub fn query(&self) -> &str {
        &self.query
    }

    pub fn is_active(&self) -> bool {
        self.active
    }

    /// Suggestions in display order: prefix matches first, then substring
    /// matches, both case-insensitive and in original command order. Hidden
    /// commands are skipped. Returns an empty list while inactive.
    pub fn matching(&self) -> Vec<&CommandSpec> {
        if !self.active {
            return Vec::new();
        }
        let needle = self.needle();
        let mut prefix = Vec::new();
        let mut substring = Vec::new();
        for spec in &self.specs {
            if spec.hidden {
                continue;
            }
            let name = spec.name.trim_start_matches('/').to_lowercase();
            if needle.is_empty() || name.starts_with(&needle) {
                prefix.push(spec);
            } else if name.contains(&needle) {
                substring.push(spec);
            }
        }
        prefix.extend(substring);
        prefix
    }

    /// Selected index within [`Self::matching`], if there is a match.
    pub fn selected_index(&self) -> Option<usize> {
        let len = self.matching().len();
        (len > 0).then(|| self.selected.min(len - 1))
    }

    /// The currently selected command, if any.
    pub fn selected_spec(&self) -> Option<&CommandSpec> {
        let matches = self.matching();
        matches
            .get(self.selected.min(matches.len().saturating_sub(1)))
            .copied()
    }

    /// Move the selection down, wrapping past the last match.
    pub fn next(&mut self) {
        let len = self.matching().len();
        if len == 0 {
            self.selected = 0;
        } else {
            self.selected = (self.selected + 1) % len;
        }
    }

    /// Move the selection up, wrapping past the first match.
    pub fn prev(&mut self) {
        let len = self.matching().len();
        if len == 0 {
            self.selected = 0;
        } else {
            self.selected = (self.selected + len - 1) % len;
        }
    }

    /// Close the palette without changing the input line.
    pub fn dismiss(&mut self) {
        self.active = false;
        self.selected = 0;
    }

    /// Accept the selected command and close the palette.
    ///
    /// Returns the text to insert into the input box: `/name ` when the
    /// command takes no argument hint, or `/name <hint>` when it does.
    /// Returns `None` while inactive or when nothing matches.
    pub fn accept(&mut self) -> Option<String> {
        let spec = self.selected_spec().cloned()?;
        let mut text = format!("/{}", spec.name.trim_start_matches('/'));
        match spec
            .argument_hint
            .as_deref()
            .map(str::trim)
            .filter(|hint| !hint.is_empty())
        {
            Some(hint) => {
                text.push(' ');
                text.push_str(hint);
            }
            None => text.push(' '),
        }
        self.active = false;
        Some(text)
    }

    /// Render the visible window: `/name  description`, with `> ` prefixed to
    /// the selected row. At most [`MAX_ROWS`] rows are returned; when there are
    /// more matches the window scrolls to keep the selection visible. Every
    /// row is cut to `width` display columns.
    pub fn rows(&self, width: usize) -> Vec<Row> {
        let matches = self.matching();
        if matches.is_empty() {
            return Vec::new();
        }
        let selected = self.selected.min(matches.len() - 1);
        let (start, end) = window(matches.len(), selected);
        matches[start..end]
            .iter()
            .enumerate()
            .map(|(offset, spec)| {
                let mut text = String::new();
                if start + offset == selected {
                    text.push_str("> ");
                }
                text.push('/');
                text.push_str(spec.name.trim_start_matches('/'));
                if let Some(description) = spec
                    .description
                    .as_deref()
                    .map(str::trim)
                    .filter(|description| !description.is_empty())
                {
                    text.push_str("  ");
                    text.push_str(description);
                }
                Row::new(RowStyle::System, fit(&text, width))
            })
            .collect()
    }

    fn needle(&self) -> String {
        self.query
            .strip_prefix('/')
            .unwrap_or_default()
            .to_lowercase()
    }
}

/// Window bounds for a filtered list of `len` entries with `selected` active.
fn window(len: usize, selected: usize) -> (usize, usize) {
    if len <= MAX_ROWS {
        return (0, len);
    }
    // Center the selection when possible, then clamp so the window never
    // runs past the end (or before the start) of the list.
    let start = selected.saturating_sub(MAX_ROWS / 2).min(len - MAX_ROWS);
    (start, start + MAX_ROWS)
}

/// First display line of `text`, cut to at most `width` columns.
fn fit(text: &str, width: usize) -> String {
    if width == 0 {
        return String::new();
    }
    cch_tui_ui::wrap_text(text, width)
        .into_iter()
        .next()
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(name: &str, description: &str) -> CommandSpec {
        CommandSpec::new(name).with_description(description)
    }

    fn names(palette: &CommandPalette) -> Vec<&str> {
        palette
            .matching()
            .iter()
            .map(|spec| spec.name.as_str())
            .collect()
    }

    #[test]
    fn activates_only_for_slash_prefixed_input() {
        let mut palette = CommandPalette::new(vec![spec("compact", "Compress")]);
        assert!(!palette.is_active());
        assert!(palette.matching().is_empty());

        palette.set_query("compact");
        assert!(!palette.is_active());
        assert!(palette.matching().is_empty());

        palette.set_query("/");
        assert!(palette.is_active());
        palette.set_query("/com");
        assert!(palette.is_active());

        palette.dismiss();
        assert!(!palette.is_active());
        assert!(palette.matching().is_empty());

        // The next slash-prefixed input reactivates a dismissed palette.
        palette.set_query("/co");
        assert!(palette.is_active());
        assert_eq!(names(&palette), ["compact"]);
    }

    #[test]
    fn prefix_matches_sort_before_substring_matches() {
        let mut palette = CommandPalette::new(vec![
            spec("decompact", "Substring"),
            spec("compact", "Prefix"),
            spec("color", "Prefix"),
            spec("status", "Unrelated"),
        ]);
        palette.set_query("/co");
        assert_eq!(names(&palette), ["compact", "color", "decompact"]);

        // Filtering is case-insensitive.
        palette.set_query("/CO");
        assert_eq!(names(&palette), ["compact", "color", "decompact"]);
        assert_eq!(palette.selected_index(), Some(0));
    }

    #[test]
    fn empty_query_lists_all_visible_commands_in_order() {
        let mut palette = CommandPalette::new(vec![
            spec("alpha", "First"),
            spec("beta", "Second"),
            spec("gamma", "Third"),
        ]);
        palette.set_query("/");
        assert_eq!(names(&palette), ["alpha", "beta", "gamma"]);
    }

    #[test]
    fn navigation_wraps_in_both_directions() {
        let mut palette = CommandPalette::new(vec![
            spec("alpha", "First"),
            spec("beta", "Second"),
            spec("gamma", "Third"),
        ]);
        palette.set_query("/");
        assert_eq!(palette.selected_index(), Some(0));

        palette.prev();
        assert_eq!(palette.selected_index(), Some(2));
        palette.next();
        assert_eq!(palette.selected_index(), Some(0));
        palette.next();
        assert_eq!(palette.selected_index(), Some(1));
        assert_eq!(
            palette.selected_spec().map(|s| s.name.as_str()),
            Some("beta")
        );
    }

    #[test]
    fn navigation_without_matches_is_a_noop() {
        let mut palette = CommandPalette::new(vec![spec("compact", "Compress")]);
        palette.set_query("/zzz");
        palette.next();
        palette.prev();
        assert!(palette.matching().is_empty());
        assert_eq!(palette.selected_index(), None);
        assert_eq!(palette.accept(), None);
    }

    #[test]
    fn accept_returns_command_plus_hint() {
        let mut palette = CommandPalette::new(vec![
            CommandSpec::new("compact").with_description("Compress"),
            CommandSpec::new("diff").with_argument_hint("<file>"),
        ]);

        palette.set_query("/");
        assert_eq!(palette.accept(), Some("/compact ".to_string()));
        assert!(!palette.is_active());

        palette.set_query("/diff");
        assert_eq!(palette.accept(), Some("/diff <file>".to_string()));
        assert!(!palette.is_active());
    }

    #[test]
    fn accept_ignores_blank_argument_hint() {
        let mut palette =
            CommandPalette::new(vec![CommandSpec::new("compact").with_argument_hint("   ")]);
        palette.set_query("/com");
        assert_eq!(palette.accept(), Some("/compact ".to_string()));
    }

    #[test]
    fn hidden_commands_never_appear() {
        let mut palette = CommandPalette::new(vec![
            spec("secret", "Hidden").hide(),
            spec("status", "Visible"),
        ]);

        palette.set_query("/");
        assert_eq!(names(&palette), ["status"]);
        assert!(
            palette
                .rows(80)
                .iter()
                .all(|row| !row.text.contains("secret"))
        );

        palette.set_query("/sec");
        assert!(palette.matching().is_empty());
        assert!(palette.rows(80).is_empty());
    }

    #[test]
    fn rows_mark_selection_and_join_description_with_two_spaces() {
        let mut palette = CommandPalette::new(vec![
            spec("compact", "Compress the conversation"),
            spec("diff", "Show changes"),
            CommandSpec::new("help"),
        ]);
        palette.set_query("/");

        let rows = palette.rows(80);
        assert_eq!(rows.len(), 3);
        assert_eq!(rows[0].text, "> /compact  Compress the conversation");
        assert_eq!(rows[1].text, "/diff  Show changes");
        assert_eq!(rows[2].text, "/help");
        assert!(rows.iter().all(|row| row.style == RowStyle::System));

        palette.next();
        let rows = palette.rows(80);
        assert_eq!(rows[0].text, "/compact  Compress the conversation");
        assert_eq!(rows[1].text, "> /diff  Show changes");
    }

    #[test]
    fn rows_truncate_to_width() {
        let mut palette = CommandPalette::new(vec![
            spec("compact", "Compress the conversation"),
            spec("diff", "Show changes"),
        ]);
        palette.set_query("/");

        for row in palette.rows(12) {
            assert!(row.text.chars().count() <= 12, "row too wide: {row:?}");
        }
        assert_eq!(palette.rows(6)[0].text, "> /com");

        // Zero width yields empty (but present) rows.
        let rows = palette.rows(0);
        assert_eq!(rows.len(), 2);
        assert!(rows.iter().all(|row| row.text.is_empty()));
    }

    #[test]
    fn rows_window_keeps_selection_visible() {
        let specs = (0..12)
            .map(|index| spec(&format!("cmd{index:02}"), "Description"))
            .collect();
        let mut palette = CommandPalette::new(specs);
        palette.set_query("/");
        assert_eq!(palette.rows(80).len(), MAX_ROWS);

        for _ in 0..11 {
            palette.next();
        }
        let rows = palette.rows(80);
        assert_eq!(rows.len(), MAX_ROWS);
        assert!(
            rows.iter().any(|row| row.text.starts_with("> /cmd11")),
            "selected row must be in the window: {rows:?}"
        );
    }
}
