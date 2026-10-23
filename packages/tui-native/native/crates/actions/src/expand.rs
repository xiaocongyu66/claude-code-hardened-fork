//! Expansion state and row projection.
//!
//! A row block is a maximal run of consecutive [`RowStyle::Tool`] rows. The
//! block inherits the key of its first row, so a tool call and all of its
//! result lines expand and collapse together. Non-tool rows always pass
//! through untouched.

use std::collections::HashSet;
use std::fmt;

use cch_tui_ui::{Row, RowStyle};

/// Identity of an expandable row.
///
/// Messages that carry a protocol UUID use [`RowKey::Uuid`]; views built from
/// bare [`Row`]s use [`RowKey::Index`]. A tool block is keyed by its first row.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum RowKey {
    Uuid(String),
    Index(usize),
}

impl RowKey {
    /// Convenience constructor for UUID-keyed rows.
    pub fn uuid(uuid: impl Into<String>) -> Self {
        Self::Uuid(uuid.into())
    }
}

impl From<usize> for RowKey {
    fn from(index: usize) -> Self {
        Self::Index(index)
    }
}

impl From<String> for RowKey {
    fn from(uuid: String) -> Self {
        Self::Uuid(uuid)
    }
}

impl From<&str> for RowKey {
    fn from(uuid: &str) -> Self {
        Self::Uuid(uuid.to_owned())
    }
}

impl From<&RowKey> for RowKey {
    fn from(key: &RowKey) -> Self {
        key.clone()
    }
}

impl fmt::Display for RowKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Uuid(uuid) => write!(f, "{uuid}"),
            Self::Index(index) => write!(f, "row {index}"),
        }
    }
}

/// Which rows are expanded.
///
/// The default is collapsed for every key. [`ExpandState::expand_all`] and
/// [`ExpandState::collapse_all`] set the default and clear per-key overrides;
/// [`ExpandState::toggle`] flips a single key relative to the current default.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ExpandState {
    /// Keys whose effective state differs from `default_expanded`.
    overrides: HashSet<RowKey>,
    default_expanded: bool,
}

impl ExpandState {
    pub fn new() -> Self {
        Self::default()
    }

    /// Whether `key` is currently expanded.
    pub fn is_expanded(&self, key: impl Into<RowKey>) -> bool {
        let key = key.into();
        self.default_expanded != self.overrides.contains(&key)
    }

    /// Whether `key` is currently collapsed.
    pub fn is_collapsed(&self, key: impl Into<RowKey>) -> bool {
        !self.is_expanded(key)
    }

    /// Flip the state of one key. Calling it twice restores the prior state.
    pub fn toggle(&mut self, key: impl Into<RowKey>) {
        let key = key.into();
        // Overrides store "differs from the default". Flipping membership
        // therefore always flips the effective state.
        if !self.overrides.remove(&key) {
            self.overrides.insert(key);
        }
    }

    /// Expand everything, including keys not seen yet.
    pub fn expand_all(&mut self) {
        self.default_expanded = true;
        self.overrides.clear();
    }

    /// Collapse everything, including keys not seen yet.
    pub fn collapse_all(&mut self) {
        self.default_expanded = false;
        self.overrides.clear();
    }
}

/// Row caps applied while projecting a transcript.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ExpandLimits {
    /// Maximum tool rows shown for a collapsed block (default 3).
    pub collapsed_lines: usize,
    /// Maximum tool rows shown for an expanded block (default 200).
    pub expanded_lines: usize,
}

impl ExpandLimits {
    pub const DEFAULT: Self = Self {
        collapsed_lines: 3,
        expanded_lines: 200,
    };

    pub const fn new(collapsed_lines: usize, expanded_lines: usize) -> Self {
        Self {
            collapsed_lines,
            expanded_lines,
        }
    }
}

impl Default for ExpandLimits {
    fn default() -> Self {
        Self::DEFAULT
    }
}

/// Project `rows` for display, keying every row by its index.
///
/// The input is never mutated; the result is a fresh vector.
pub fn project(rows: &[Row], state: &ExpandState, limits: ExpandLimits) -> Vec<Row> {
    let keys: Vec<RowKey> = (0..rows.len()).map(RowKey::Index).collect();
    project_keyed(rows, &keys, state, limits)
}

/// Project `rows` with explicit keys (e.g. protocol UUIDs).
///
/// `keys` should be the same length as `rows`; a missing key falls back to the
/// row index. As with [`project`], the input vectors are not modified.
pub fn project_keyed(
    rows: &[Row],
    keys: &[RowKey],
    state: &ExpandState,
    limits: ExpandLimits,
) -> Vec<Row> {
    let mut out = Vec::with_capacity(rows.len());
    let mut index = 0;
    while index < rows.len() {
        if rows[index].style != RowStyle::Tool {
            out.push(rows[index].clone());
            index += 1;
            continue;
        }

        let start = index;
        while index < rows.len() && rows[index].style == RowStyle::Tool {
            index += 1;
        }
        let block = &rows[start..index];
        let key = keys.get(start).cloned().unwrap_or(RowKey::Index(start));
        let expanded = state.is_expanded(key);
        let limit = if expanded {
            limits.expanded_lines
        } else {
            limits.collapsed_lines
        };

        if block.len() <= limit {
            out.extend_from_slice(block);
            continue;
        }

        out.extend_from_slice(&block[..limit]);
        if !expanded {
            let hidden = block.len() - limit;
            out.push(Row::new(
                RowStyle::Tool,
                format!("… +{hidden} lines (Ctrl+O to expand)"),
            ));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tool(text: impl Into<String>) -> Row {
        Row::new(RowStyle::Tool, text)
    }

    fn assistant(text: impl Into<String>) -> Row {
        Row::new(RowStyle::Assistant, text)
    }

    #[test]
    fn default_limits_are_three_and_two_hundred() {
        let limits = ExpandLimits::default();
        assert_eq!(limits.collapsed_lines, 3);
        assert_eq!(limits.expanded_lines, 200);
        assert_eq!(limits, ExpandLimits::DEFAULT);
    }

    #[test]
    fn default_limits_apply_at_their_boundaries() {
        // Exactly the collapsed cap: no hint row.
        let at_collapsed_cap: Vec<Row> = (0..3).map(|i| tool(format!("line {i}"))).collect();
        let out = project(
            &at_collapsed_cap,
            &ExpandState::new(),
            ExpandLimits::default(),
        );
        assert_eq!(out, at_collapsed_cap);

        // One row past the collapsed cap: truncated with a hint.
        let past_collapsed_cap: Vec<Row> = (0..4).map(|i| tool(format!("line {i}"))).collect();
        let out = project(
            &past_collapsed_cap,
            &ExpandState::new(),
            ExpandLimits::default(),
        );
        assert_eq!(out.len(), 4);
        assert_eq!(out[3].text, "… +1 lines (Ctrl+O to expand)");

        // Exactly the expanded cap: the whole block passes through.
        let at_expanded_cap: Vec<Row> = (0..200).map(|i| tool(format!("line {i}"))).collect();
        let mut state = ExpandState::new();
        state.toggle(0usize);
        let out = project(&at_expanded_cap, &state, ExpandLimits::default());
        assert_eq!(out, at_expanded_cap);

        // One row past the expanded cap: hard-truncated, no hint row.
        let past_expanded_cap: Vec<Row> = (0..201).map(|i| tool(format!("line {i}"))).collect();
        let out = project(&past_expanded_cap, &state, ExpandLimits::default());
        assert_eq!(out.len(), 200);
        assert_eq!(out, past_expanded_cap[..200]);
    }

    #[test]
    fn long_tool_block_collapses_to_the_limit_with_a_hint() {
        let rows: Vec<Row> = (0..10).map(|i| tool(format!("output {i}"))).collect();
        let out = project(&rows, &ExpandState::new(), ExpandLimits::default());

        assert_eq!(out.len(), 4, "{out:?}");
        assert_eq!(out[..3], rows[..3]);
        assert_eq!(out[3].text, "… +7 lines (Ctrl+O to expand)");
        assert_eq!(out[3].style, RowStyle::Tool);
    }

    #[test]
    fn collapsed_limit_zero_shows_only_the_hint() {
        let rows: Vec<Row> = (0..5).map(|i| tool(format!("line {i}"))).collect();
        let limits = ExpandLimits::new(0, 10);
        let out = project(&rows, &ExpandState::new(), limits);

        assert_eq!(out.len(), 1);
        assert_eq!(out[0].text, "… +5 lines (Ctrl+O to expand)");
    }

    #[test]
    fn expanded_blocks_honour_the_expanded_limit_without_a_hint() {
        let rows: Vec<Row> = (0..10).map(|i| tool(format!("line {i}"))).collect();
        let mut state = ExpandState::new();
        state.toggle(0usize);
        let limits = ExpandLimits::new(2, 5);
        let out = project(&rows, &state, limits);

        assert_eq!(out.len(), 5);
        assert_eq!(out, rows[..5]);
    }

    #[test]
    fn blocks_below_the_limit_pass_through_unchanged() {
        let rows = vec![tool("● Bash ls"), tool("  ⎿ a"), tool("  ⎿ b")];
        let out = project(&rows, &ExpandState::new(), ExpandLimits::default());
        assert_eq!(out, rows);
    }

    #[test]
    fn text_rows_are_never_truncated() {
        let long = "a multi-line prose row\nwith a second line";
        let mut rows = vec![assistant(long)];
        rows.extend((0..6).map(|i| tool(format!("line {i}"))));
        rows.push(assistant("after"));
        rows.push(Row::new(RowStyle::User, "> hello"));

        let out = project(&rows, &ExpandState::new(), ExpandLimits::default());
        assert_eq!(out[0], rows[0]);
        assert!(out.iter().any(|row| row.text == "after"));
        assert!(out.iter().any(|row| row.text == "> hello"));
        assert!(out.iter().any(|row| row.text.contains("Ctrl+O to expand")));
    }

    #[test]
    fn toggle_is_reversible_and_idempotent() {
        let mut state = ExpandState::new();
        assert!(state.is_collapsed(7usize));

        state.toggle(7usize);
        assert!(state.is_expanded(7usize));
        state.toggle(7usize);
        assert!(state.is_collapsed(7usize));

        // Calling toggle through an equivalent key does not duplicate state.
        state.toggle(RowKey::Index(7));
        assert!(state.is_expanded(7usize));
        state.toggle(7usize);
        assert!(state.is_collapsed(7usize));
    }

    #[test]
    fn expand_all_and_collapse_all_cover_unknown_keys() {
        let mut state = ExpandState::new();
        state.toggle(2usize);

        state.expand_all();
        assert!(state.is_expanded(0usize));
        assert!(state.is_expanded(2usize));
        assert!(state.is_expanded("uuid-none"));

        // A single toggle wins over the default set by expand_all.
        state.toggle(2usize);
        assert!(state.is_collapsed(2usize));
        assert!(state.is_expanded(1usize));

        state.collapse_all();
        assert!(state.is_collapsed(0usize));
        assert!(state.is_collapsed(2usize));
        assert!(state.is_collapsed("uuid-none"));
    }

    #[test]
    fn project_does_not_mutate_the_input_rows() {
        let rows: Vec<Row> = (0..8).map(|i| tool(format!("line {i}"))).collect();
        let before = rows.clone();
        let _ = project(&rows, &ExpandState::new(), ExpandLimits::default());
        assert_eq!(rows, before);
    }

    #[test]
    fn tool_blocks_are_keyed_by_their_first_row() {
        let mut rows = vec![assistant("start")];
        rows.extend((0..6).map(|i| tool(format!("line {i}"))));
        let mut state = ExpandState::new();
        // The block starts at row 1; row 2 must not control it.
        state.toggle(2usize);

        let collapsed = project(&rows, &state, ExpandLimits::default());
        assert_eq!(collapsed.len(), 1 + 3 + 1);

        state.toggle(1usize);
        let expanded = project(&rows, &state, ExpandLimits::default());
        assert_eq!(expanded.len(), 7);
        assert_eq!(expanded, rows);
    }

    #[test]
    fn uuid_keys_drive_projection() {
        let rows: Vec<Row> = (0..5).map(|i| tool(format!("line {i}"))).collect();
        let keys: Vec<RowKey> = (0..5).map(|i| RowKey::uuid(format!("u{i}"))).collect();
        let mut state = ExpandState::new();
        state.toggle("u0");

        let expanded = project_keyed(&rows, &keys, &state, ExpandLimits::default());
        assert_eq!(expanded, rows);

        state.toggle(RowKey::uuid("u0"));
        let collapsed = project_keyed(&rows, &keys, &state, ExpandLimits::default());
        assert_eq!(collapsed.len(), 4);
        assert_eq!(collapsed[3].text, "… +2 lines (Ctrl+O to expand)");
    }

    #[test]
    fn separate_tool_blocks_are_collapsed_independently() {
        let mut rows: Vec<Row> = (0..5).map(|i| tool(format!("a{i}"))).collect();
        rows.push(assistant("between"));
        rows.extend((0..5).map(|i| tool(format!("b{i}"))));

        let out = project(&rows, &ExpandState::new(), ExpandLimits::default());
        assert_eq!(out.len(), (3 + 1) + 1 + (3 + 1));
        assert_eq!(out[3].text, "… +2 lines (Ctrl+O to expand)");
        assert_eq!(out[4].text, "between");
        assert_eq!(out[8].text, "… +2 lines (Ctrl+O to expand)");
    }
}
