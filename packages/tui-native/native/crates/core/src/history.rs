//! Pure history-search model.
//!
//! [`HistorySearch`] mirrors the reverse incremental search used by the prompt
//! input: a case-insensitive query, the matching history entries (newest
//! first) and a selected index. It deliberately owns no I/O and no input
//! handling; callers feed candidate entries, forward [`HistorySearch::next`] /
//! [`HistorySearch::prev`] and turn [`HistorySearch::accept`] /
//! [`HistorySearch::cancel`] into buffer updates.
//!
//! Scopes select which history list the caller searches:
//! [`HistoryScope::Session`] only prompts from this run,
//! [`HistoryScope::Project`] the current project's on-disk history and
//! [`HistoryScope::Global`] every project. [`HistorySearch::cycle_scope`]
//! walks session → project → global and re-runs the query. The caller supplies
//! all three lists; this module never touches disk.
//!
//! [`HistorySearch::overlay_rows`] shapes the dialog: `N/M  <first line>` rows
//! with byte ranges for the query occurrences and the current row flagged, so
//! the renderer can highlight matches and reverse the selection.

use std::collections::HashSet;
use std::ops::Range;

use unicode_width::UnicodeWidthChar;

/// Which history list a search reads.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash)]
pub enum HistoryScope {
    /// Prompts submitted in this session.
    #[default]
    Session,
    /// The current project's persisted history.
    Project,
    /// Persisted history across every project.
    Global,
}

impl HistoryScope {
    /// The next scope in the Ctrl+R cycle (session → project → global).
    pub const fn cycle(self) -> Self {
        match self {
            Self::Session => Self::Project,
            Self::Project => Self::Global,
            Self::Global => Self::Session,
        }
    }

    /// Lowercase scope name used in titles and status lines.
    pub const fn label(self) -> &'static str {
        match self {
            Self::Session => "session",
            Self::Project => "project",
            Self::Global => "global",
        }
    }
}

/// One row of the history-search overlay.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HistoryRow {
    /// `N/M  <first line>` text, already cut to the requested width.
    pub text: String,
    /// Byte ranges of the query inside [`text`](Self::text), for emphasis.
    pub highlights: Vec<Range<usize>>,
    /// Whether this is the selected match.
    pub current: bool,
}

/// Reverse incremental history search state.
///
/// All fields are public so a UI can render the query, the match list and the
/// highlight without accessor boilerplate. `index` points into `matches`; when
/// `matches` is empty it is `0` and [`HistorySearch::current`] returns `None`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct HistorySearch {
    pub query: String,
    /// Matching entries, newest first, de-duplicated.
    pub matches: Vec<String>,
    /// Selected position within `matches`.
    pub index: usize,
    pub scope: HistoryScope,
}

impl HistorySearch {
    /// Start an idle search in `scope`.
    pub fn new(scope: HistoryScope) -> Self {
        Self {
            scope,
            ..Self::default()
        }
    }

    /// Start a search over already-collected matches.
    pub fn with_matches(scope: HistoryScope, matches: Vec<String>) -> Self {
        let mut search = Self::new(scope);
        search.matches = matches;
        search
    }

    /// Whether the session has candidates at all.
    pub fn is_active(&self) -> bool {
        !self.matches.is_empty()
    }

    pub fn current(&self) -> Option<&str> {
        self.matches.get(self.index).map(String::as_str)
    }

    /// Update the query and recompute [`HistorySearch::matches`] from the
    /// candidates for the current scope.
    ///
    /// Matching is a case-insensitive substring test (the same rule as the
    /// official `lastIndexOf(historyQuery.toLowerCase())`). An empty query
    /// lists every candidate so opening the picker shows recent prompts;
    /// [`HistorySearch::cancel`] restores the idle state. Candidates are
    /// assumed to be newest first and are de-duplicated.
    pub fn set_query(&mut self, query: impl Into<String>, candidates: &[String]) {
        self.query = query.into();
        self.matches = filter_matches(candidates, &self.query);
        self.index = 0;
    }

    /// [`Self::set_query`] with one list per scope. Only the active scope is
    /// scanned.
    pub fn set_query_scoped(
        &mut self,
        query: impl Into<String>,
        session: &[String],
        project: &[String],
        global: &[String],
    ) {
        self.query = query.into();
        self.matches = filter_matches(self.candidates(session, project, global), &self.query);
        self.index = 0;
    }

    /// Re-run the current query against the current scope.
    pub fn refresh_scoped(&mut self, session: &[String], project: &[String], global: &[String]) {
        self.matches = filter_matches(self.candidates(session, project, global), &self.query);
        self.index = 0;
    }

    /// Switch to the next scope (session → project → global), re-run the query
    /// and return the new scope.
    pub fn cycle_scope(
        &mut self,
        session: &[String],
        project: &[String],
        global: &[String],
    ) -> HistoryScope {
        self.scope = self.scope.cycle();
        self.refresh_scoped(session, project, global);
        self.scope
    }

    /// Select the next (older) match, wrapping at the end.
    ///
    /// This is a cursor move, not an [`Iterator`], so the name intentionally
    /// mirrors the input command rather than `Iterator::next`.
    #[allow(clippy::should_implement_trait)]
    pub fn next(&mut self) -> Option<&str> {
        if self.matches.is_empty() {
            return None;
        }
        self.index = (self.index + 1) % self.matches.len();
        self.current()
    }

    /// Select the previous (newer) match, wrapping at the start.
    pub fn prev(&mut self) -> Option<&str> {
        if self.matches.is_empty() {
            return None;
        }
        self.index = (self.index + self.matches.len() - 1) % self.matches.len();
        self.current()
    }

    /// Accept the selected match: return it and reset the search state.
    pub fn accept(&mut self) -> Option<String> {
        let selected = self.current().map(str::to_owned);
        self.reset();
        selected
    }

    /// Abandon the search and reset the state.
    pub fn cancel(&mut self) {
        self.reset();
    }

    /// Overlay rows for the dialog: up to `max_visible` matches in a window
    /// that keeps the selection visible, each `N/M  <first line>` and cut to
    /// `width` display columns. `highlights` holds byte ranges of the query
    /// inside the row text; `current` flags the selected row.
    pub fn overlay_rows(&self, width: usize, max_visible: usize) -> Vec<HistoryRow> {
        if width == 0 || max_visible == 0 || self.matches.is_empty() {
            return Vec::new();
        }
        let total = self.matches.len();
        let selected = self.index.min(total - 1);
        let start = if total <= max_visible {
            0
        } else {
            selected
                .saturating_sub(max_visible / 2)
                .min(total - max_visible)
        };
        let end = (start + max_visible).min(total);
        self.matches[start..end]
            .iter()
            .enumerate()
            .map(|(offset, entry)| {
                let index = start + offset;
                let prefix = format!("{}/{}  ", index + 1, total);
                let available = width.saturating_sub(display_width(&prefix));
                let first_line = entry.split('\n').next().unwrap_or("");
                let shown = truncate_display(first_line, available);
                let prefix_bytes = prefix.len();
                let highlights = find_ranges(&shown, &self.query)
                    .into_iter()
                    .map(|range| prefix_bytes + range.start..prefix_bytes + range.end)
                    .collect();
                HistoryRow {
                    text: truncate_display(&format!("{prefix}{shown}"), width),
                    highlights,
                    current: index == selected,
                }
            })
            .collect()
    }

    fn reset(&mut self) {
        self.query.clear();
        self.matches.clear();
        self.index = 0;
    }

    fn candidates<'a>(
        &self,
        session: &'a [String],
        project: &'a [String],
        global: &'a [String],
    ) -> &'a [String] {
        match self.scope {
            HistoryScope::Session => session,
            HistoryScope::Project => project,
            HistoryScope::Global => global,
        }
    }
}

fn filter_matches(candidates: &[String], query: &str) -> Vec<String> {
    let needle = query.to_lowercase();
    let mut seen = HashSet::new();
    candidates
        .iter()
        .filter(|entry| needle.is_empty() || entry.to_lowercase().contains(&needle))
        .filter(|entry| seen.insert((*entry).clone()))
        .cloned()
        .collect()
}

/// Case-insensitive byte ranges of `query` in `text`.
///
/// Only offset-preserving lowercasings are highlighted: when Unicode
/// lowercasing changes the byte length (`İ` → `i̇`), the row is left
/// unhighlighted rather than reporting a misleading range.
fn find_ranges(text: &str, query: &str) -> Vec<Range<usize>> {
    if query.is_empty() {
        return Vec::new();
    }
    let lowered = text.to_lowercase();
    if lowered.len() != text.len() {
        return Vec::new();
    }
    let needle = query.to_lowercase();
    let mut ranges = Vec::new();
    let mut from = 0;
    while from < lowered.len() {
        let Some(offset) = lowered[from..].find(&needle) else {
            break;
        };
        let start = from + offset;
        let end = start + needle.len();
        if text.is_char_boundary(start) && text.is_char_boundary(end) {
            ranges.push(start..end);
        }
        from = end.max(start + 1);
    }
    ranges
}

/// Cut `text` to `width` display columns, appending `…` when clipped.
fn truncate_display(text: &str, width: usize) -> String {
    if width == 0 {
        return String::new();
    }
    if display_width(text) <= width {
        return text.to_owned();
    }
    let budget = width - 1;
    let mut out = String::new();
    let mut used = 0;
    for ch in text.chars() {
        let char_width = display_char_width(ch);
        if used + char_width > budget {
            break;
        }
        out.push(ch);
        used += char_width;
    }
    out.push('…');
    out
}

fn display_width(text: &str) -> usize {
    text.chars().map(display_char_width).sum()
}

fn display_char_width(ch: char) -> usize {
    if ch == '\t' {
        return 4;
    }
    if ch.is_control() {
        return 0;
    }
    ch.width().unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn histories() -> (Vec<String>, Vec<String>, Vec<String>) {
        (
            vec!["session fix".to_owned(), "session other".to_owned()],
            vec!["project-only fix".to_owned(), "unrelated".to_owned()],
            vec![
                "Fix the parser bug".to_owned(),
                "write docs".to_owned(),
                "fix tests for parser".to_owned(),
            ],
        )
    }

    #[test]
    fn matching_is_case_insensitive_and_deduplicated() {
        let mut search = HistorySearch::new(HistoryScope::Global);
        let candidates = vec![
            "Fix Bug".to_owned(),
            "other".to_owned(),
            "fix bug".to_owned(),
            "FIX TESTS".to_owned(),
        ];
        search.set_query("fix", &candidates);
        assert_eq!(search.matches, ["Fix Bug", "fix bug", "FIX TESTS"]);
        assert_eq!(search.index, 0);
        assert_eq!(search.current(), Some("Fix Bug"));

        search.set_query("FIX", &candidates);
        assert_eq!(search.matches.len(), 3);
        assert_eq!(search.current(), Some("Fix Bug"));
    }

    #[test]
    fn empty_query_lists_all_candidates_deduplicated() {
        let mut search = HistorySearch::new(HistoryScope::Global);
        search.set_query("", &["one".to_owned(), "two".to_owned(), "one".to_owned()]);
        assert_eq!(search.matches, ["one", "two"]);
        assert!(search.is_active());
        assert_eq!(search.current(), Some("one"));

        search.cancel();
        assert!(search.matches.is_empty());
        assert!(!search.is_active());
        assert_eq!(search.current(), None);
        assert_eq!(search.next(), None);
        assert_eq!(search.prev(), None);

        // No candidates at all stays empty.
        search.set_query("", &[]);
        assert!(search.matches.is_empty());
    }

    #[test]
    fn next_and_prev_cycle_through_matches() {
        let mut search = HistorySearch::new(HistoryScope::Global);
        search.set_query("fix", &histories().2);
        assert_eq!(search.current(), Some("Fix the parser bug"));

        assert_eq!(search.next(), Some("fix tests for parser"));
        assert_eq!(search.next(), Some("Fix the parser bug"));
        assert_eq!(search.prev(), Some("fix tests for parser"));
        assert_eq!(search.prev(), Some("Fix the parser bug"));
    }

    #[test]
    fn cycle_scope_walks_session_project_global() {
        let (session, project, global) = histories();
        let mut search = HistorySearch::new(HistoryScope::Session);
        search.set_query_scoped("fix", &session, &project, &global);
        assert_eq!(search.matches, ["session fix"]);

        assert_eq!(
            search.cycle_scope(&session, &project, &global),
            HistoryScope::Project
        );
        assert_eq!(search.scope, HistoryScope::Project);
        assert_eq!(search.matches, ["project-only fix"]);

        assert_eq!(
            search.cycle_scope(&session, &project, &global),
            HistoryScope::Global
        );
        assert_eq!(search.matches.len(), 2);
        assert_eq!(search.current(), Some("Fix the parser bug"));

        assert_eq!(
            search.cycle_scope(&session, &project, &global),
            HistoryScope::Session
        );
        assert_eq!(search.matches, ["session fix"]);
        assert_eq!(HistoryScope::Session.cycle(), HistoryScope::Project);
        assert_eq!(HistoryScope::Global.cycle(), HistoryScope::Session);
        assert_eq!(HistoryScope::Session.label(), "session");
    }

    #[test]
    fn accept_returns_the_selection_and_cancel_restores_idle_state() {
        let mut search = HistorySearch::new(HistoryScope::Global);
        search.set_query("fix", &histories().2);
        search.next();
        assert_eq!(search.accept(), Some("fix tests for parser".to_owned()));
        assert!(!search.is_active());
        assert!(search.query.is_empty());

        let mut search = HistorySearch::new(HistoryScope::Global);
        search.set_query("fix", &histories().2);
        search.cancel();
        assert!(!search.is_active());
        assert!(search.query.is_empty());
        assert_eq!(search.accept(), None);
    }

    #[test]
    fn overlay_rows_number_and_mark_the_current_match() {
        let mut search = HistorySearch::new(HistoryScope::Global);
        search.set_query("fix", &histories().2);
        let rows = search.overlay_rows(40, 10);
        assert_eq!(
            rows.iter().map(|row| row.text.as_str()).collect::<Vec<_>>(),
            ["1/2  Fix the parser bug", "2/2  fix tests for parser"]
        );
        assert_eq!(rows[0].highlights, vec![5..8]);
        assert_eq!(rows[1].highlights, vec![5..8]);
        assert!(rows[0].current);
        assert!(!rows[1].current);

        search.next();
        let rows = search.overlay_rows(40, 10);
        assert!(!rows[0].current);
        assert!(rows[1].current);
    }

    #[test]
    fn overlay_rows_use_the_first_line_and_clip_by_display_width() {
        let mut search = HistorySearch::new(HistoryScope::Global);
        search.set_query("你好", &["你好世界\nsecond line".to_owned()]);
        let rows = search.overlay_rows(12, 10);
        assert_eq!(rows[0].text, "1/1  你好世…");
        assert_eq!(rows[0].highlights, vec![5..11]);
        assert_eq!(display_width(&rows[0].text), 12);

        // Zero width / zero rows produce nothing.
        assert!(search.overlay_rows(0, 10).is_empty());
        assert!(search.overlay_rows(12, 0).is_empty());
    }

    #[test]
    fn overlay_rows_window_keeps_the_selection_visible() {
        let candidates: Vec<String> = (0..20).map(|index| format!("entry {index}")).collect();
        let mut search = HistorySearch::new(HistoryScope::Global);
        search.set_query("", &candidates);
        for _ in 0..15 {
            search.next();
        }
        let rows = search.overlay_rows(20, 8);
        assert_eq!(rows.len(), 8);
        assert!(rows.iter().any(|row| row.current));
        assert!(rows.iter().any(|row| row.text == "16/20  entry 15"));
    }
}
