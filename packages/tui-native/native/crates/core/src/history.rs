//! Pure history-search model.
//!
//! [`HistorySearch`] mirrors the reverse incremental search used by the prompt
//! input: a case-insensitive query, the matching history entries (newest
//! first) and a selected index. It deliberately owns no I/O and no input
//! handling; callers feed candidate entries, forward [`HistorySearch::next`] /
//! [`HistorySearch::prev`] and turn [`HistorySearch::accept`] /
//! [`HistorySearch::cancel`] into buffer updates.
//!
//! Scopes select which history file the caller searches: [`HistoryScope::Global`]
//! spans every project, [`HistoryScope::Project`] only the current one.
//! [`HistorySearch::cycle_scope`] toggles between them and re-runs the query.

use std::collections::HashSet;

/// Which history file a search reads.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash)]
pub enum HistoryScope {
    /// Every project's history.
    #[default]
    Global,
    /// Only the current project's history.
    Project,
}

impl HistoryScope {
    /// The other scope.
    pub const fn cycle(self) -> Self {
        match self {
            Self::Global => Self::Project,
            Self::Project => Self::Global,
        }
    }
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

    /// Update the query and recompute [`HistorySearch::matches`].
    ///
    /// Matching is a case-insensitive substring test (the same rule as the
    /// official `lastIndexOf(historyQuery.toLowerCase())`). An empty query
    /// yields no matches so the caller can restore the original input.
    /// Candidates are assumed to be newest first and are de-duplicated.
    pub fn set_query(&mut self, query: impl Into<String>, candidates: &[String]) {
        self.query = query.into();
        self.matches = filter_matches(candidates, &self.query);
        self.index = 0;
    }

    /// Re-run the current query against the current scope.
    pub fn refresh(&mut self, global: &[String], project: &[String]) {
        let candidates = self.candidates(global, project);
        self.matches = filter_matches(candidates, &self.query);
        self.index = 0;
    }

    /// Switch to the other scope, re-run the query and return the new scope.
    pub fn cycle_scope(&mut self, global: &[String], project: &[String]) -> HistoryScope {
        self.scope = self.scope.cycle();
        self.refresh(global, project);
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

    fn reset(&mut self) {
        self.query.clear();
        self.matches.clear();
        self.index = 0;
    }

    fn candidates<'a>(&self, global: &'a [String], project: &'a [String]) -> &'a [String] {
        match self.scope {
            HistoryScope::Global => global,
            HistoryScope::Project => project,
        }
    }
}

fn filter_matches(candidates: &[String], query: &str) -> Vec<String> {
    if query.is_empty() {
        return Vec::new();
    }
    let needle = query.to_lowercase();
    let mut seen = HashSet::new();
    candidates
        .iter()
        .filter(|entry| entry.to_lowercase().contains(&needle))
        .filter(|entry| seen.insert((*entry).clone()))
        .cloned()
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn histories() -> (Vec<String>, Vec<String>) {
        (
            vec![
                "Fix the parser bug".to_owned(),
                "write docs".to_owned(),
                "fix tests for parser".to_owned(),
            ],
            vec!["project-only fix".to_owned(), "unrelated".to_owned()],
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
    fn empty_query_matches_nothing() {
        let mut search = HistorySearch::new(HistoryScope::Global);
        search.set_query("", &["one".to_owned()]);
        assert!(search.matches.is_empty());
        assert!(!search.is_active());
        assert_eq!(search.current(), None);
        assert_eq!(search.next(), None);
        assert_eq!(search.prev(), None);
    }

    #[test]
    fn next_and_prev_cycle_through_matches() {
        let mut search = HistorySearch::new(HistoryScope::Global);
        search.set_query("fix", &histories().0);
        assert_eq!(search.current(), Some("Fix the parser bug"));

        assert_eq!(search.next(), Some("fix tests for parser"));
        assert_eq!(search.next(), Some("Fix the parser bug"));
        assert_eq!(search.prev(), Some("fix tests for parser"));
        assert_eq!(search.prev(), Some("Fix the parser bug"));
    }

    #[test]
    fn cycle_scope_refilters_between_global_and_project() {
        let (global, project) = histories();
        let mut search = HistorySearch::new(HistoryScope::Global);
        search.set_query("fix", &global);
        assert_eq!(search.matches.len(), 2);

        assert_eq!(search.cycle_scope(&global, &project), HistoryScope::Project);
        assert_eq!(search.scope, HistoryScope::Project);
        assert_eq!(search.matches, ["project-only fix"]);
        assert_eq!(search.current(), Some("project-only fix"));

        assert_eq!(search.cycle_scope(&global, &project), HistoryScope::Global);
        assert_eq!(search.matches.len(), 2);
    }

    #[test]
    fn accept_returns_the_selection_and_cancel_restores_idle_state() {
        let mut search = HistorySearch::new(HistoryScope::Global);
        search.set_query("fix", &histories().0);
        search.next();
        assert_eq!(search.accept(), Some("fix tests for parser".to_owned()));
        assert!(!search.is_active());
        assert!(search.query.is_empty());

        let mut search = HistorySearch::new(HistoryScope::Global);
        search.set_query("fix", &histories().0);
        search.cancel();
        assert!(!search.is_active());
        assert!(search.query.is_empty());
        assert_eq!(search.accept(), None);
    }
}
