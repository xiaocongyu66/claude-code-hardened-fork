//! Pure global-workspace-search model.
//!
//! [`WorkspaceSearch`] owns the query, the bounded hit list and the selection.
//! The caller dispatches `search_workspace` requests, remembers the request id
//! with [`WorkspaceSearch::mark_sent`] and feeds responses through
//! [`WorkspaceSearch::set_results`], which drops stale ids and caps the list at
//! [`MAX_RESULTS`]. [`WorkspaceSearch::accept`] returns the `@path:line ` text
//! the prompt can insert (the native TUI has no external editor).
//!
//! All I/O lives in the host; this module is terminal- and engine-free.

use std::collections::HashSet;

/// Maximum hits kept from one host response.
pub const MAX_RESULTS: usize = 200;
/// Visible rows in the search overlay.
pub const MAX_ROWS: usize = 10;

/// One workspace hit.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkspaceMatch {
    pub path: String,
    pub line: u64,
    pub text: String,
}

/// Query, hits and selection for the global search overlay.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct WorkspaceSearch {
    query: String,
    matches: Vec<WorkspaceMatch>,
    selected: usize,
    request_id: Option<String>,
    sent_query: Option<String>,
    truncated: bool,
}

impl WorkspaceSearch {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn query(&self) -> &str {
        &self.query
    }

    pub fn matches(&self) -> &[WorkspaceMatch] {
        &self.matches
    }

    pub fn is_empty(&self) -> bool {
        self.matches.is_empty()
    }

    pub fn truncated(&self) -> bool {
        self.truncated
    }

    pub fn sent_query(&self) -> Option<&str> {
        self.sent_query.as_deref()
    }

    /// Update the query. Existing hits are narrowed client-side (matching
    /// Ink's behaviour while the debounced request is in flight); an empty
    /// query clears the list.
    pub fn set_query(&mut self, query: impl Into<String>) {
        let query = query.into();
        if query == self.query {
            return;
        }
        if query.trim().is_empty() {
            self.matches.clear();
        } else {
            let needle = query.to_lowercase();
            self.matches
                .retain(|entry| entry.text.to_lowercase().contains(&needle));
        }
        self.query = query;
        self.selected = 0;
        self.truncated = false;
    }

    /// Remember the request id and query just dispatched.
    pub fn mark_sent(&mut self, request_id: impl Into<String>, query: impl Into<String>) {
        self.request_id = Some(request_id.into());
        self.sent_query = Some(query.into());
    }

    /// Whether a response belongs to the latest dispatched request.
    pub fn accepts(&self, request_id: &str) -> bool {
        self.request_id.as_deref() == Some(request_id)
    }

    /// Apply a response; returns `false` (and changes nothing) for a stale id.
    /// Hits are de-duplicated by `(path, line)` and capped at [`MAX_RESULTS`].
    pub fn set_results<I>(&mut self, request_id: &str, matches: I, truncated: bool) -> bool
    where
        I: IntoIterator<Item = WorkspaceMatch>,
    {
        if !self.accepts(request_id) {
            return false;
        }
        let mut seen = HashSet::new();
        self.matches = matches
            .into_iter()
            .filter(|entry| seen.insert((entry.path.clone(), entry.line)))
            .take(MAX_RESULTS)
            .collect();
        self.selected = 0;
        self.truncated = truncated;
        true
    }

    pub fn selected_index(&self) -> Option<usize> {
        (!self.matches.is_empty()).then(|| self.selected.min(self.matches.len() - 1))
    }

    pub fn selected_match(&self) -> Option<&WorkspaceMatch> {
        self.selected_index()
            .and_then(|index| self.matches.get(index))
    }

    pub fn next(&mut self) {
        if self.matches.is_empty() {
            self.selected = 0;
        } else {
            self.selected = (self.selected + 1) % self.matches.len();
        }
    }

    pub fn prev(&mut self) {
        if self.matches.is_empty() {
            self.selected = 0;
        } else {
            self.selected = (self.selected + self.matches.len() - 1) % self.matches.len();
        }
    }

    /// Text to insert into the prompt for the selected hit: `@path:line `.
    pub fn accept(&self) -> Option<String> {
        let hit = self.selected_match()?;
        Some(format!("@{}:{} ", hit.path, hit.line))
    }

    /// Visible rows (at most `max_rows`, scrolled to the selection) and the
    /// selection's index within that window.
    pub fn visible(&self, max_rows: usize) -> (Vec<&WorkspaceMatch>, Option<usize>) {
        let (start, end) = window(self.matches.len(), self.selected, max_rows);
        let rows = self.matches[start..end].iter().collect();
        let selected = self.selected_index().map(|index| index - start);
        (rows, selected)
    }
}

fn window(len: usize, selected: usize, max_rows: usize) -> (usize, usize) {
    if max_rows == 0 {
        return (0, 0);
    }
    if len <= max_rows {
        return (0, len);
    }
    let start = selected.saturating_sub(max_rows / 2).min(len - max_rows);
    (start, start + max_rows)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hit(path: &str, line: u64, text: &str) -> WorkspaceMatch {
        WorkspaceMatch {
            path: path.into(),
            line,
            text: text.into(),
        }
    }

    #[test]
    fn narrows_existing_hits_while_a_request_is_in_flight() {
        let mut search = WorkspaceSearch::new();
        search.mark_sent("r1", "needle");
        assert!(search.set_results(
            "r1",
            [hit("a.ts", 1, "needle here"), hit("b.ts", 2, "other")],
            false,
        ));
        assert_eq!(search.matches().len(), 2);

        search.set_query("needle h");
        assert_eq!(search.matches().len(), 1);
        assert_eq!(search.matches()[0].path, "a.ts");

        search.set_query("");
        assert!(search.matches().is_empty());
    }

    #[test]
    fn stale_responses_are_dropped_and_results_are_bounded() {
        let mut search = WorkspaceSearch::new();
        search.mark_sent("r2", "q");
        assert!(!search.set_results("r1", [hit("old.ts", 1, "q")], false));
        assert!(search.is_empty());

        let many: Vec<_> = (0..MAX_RESULTS + 25)
            .map(|index| hit("f.ts", index as u64, "q"))
            .collect();
        assert!(search.set_results("r2", many, true));
        assert_eq!(search.matches().len(), MAX_RESULTS);
        assert!(search.truncated());

        // Duplicate (path, line) pairs collapse.
        let mut search = WorkspaceSearch::new();
        search.mark_sent("r3", "q");
        assert!(search.set_results(
            "r3",
            [
                hit("a.ts", 1, "q"),
                hit("a.ts", 1, "q"),
                hit("a.ts", 2, "q")
            ],
            false,
        ));
        assert_eq!(search.matches().len(), 2);
    }

    #[test]
    fn navigation_wraps_and_accept_shapes_a_mention() {
        let mut search = WorkspaceSearch::new();
        search.mark_sent("r1", "q");
        assert!(search.set_results(
            "r1",
            [hit("src/a.ts", 3, "q"), hit("src/b.ts", 9, "q")],
            false,
        ));
        assert_eq!(search.accept().as_deref(), Some("@src/a.ts:3 "));
        search.prev();
        assert_eq!(search.accept().as_deref(), Some("@src/b.ts:9 "));
        search.next();
        assert_eq!(search.accept().as_deref(), Some("@src/a.ts:3 "));
    }
}
