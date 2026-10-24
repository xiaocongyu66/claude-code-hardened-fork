//! Pure `@file` completion model.
//!
//! [`FileToken`] locates the `@`-prefixed word around the cursor and extracts
//! the query the host should resolve. [`FileCompletion`] holds the bounded
//! result list, the selection and the request id that produced it, so a late
//! response for a superseded query can be dropped without touching the UI.
//! [`insert_path`] performs the replacement the prompt applies on Tab/Enter.
//!
//! No terminal, engine or clock I/O happens here: the caller debounces queries
//! and owns the transport. Paths with whitespace are inserted in Ink's quoted
//! mention form (`@"my dir/file.ts" `); ordinary files get a trailing space,
//! directories keep a trailing `/` so completion continues.

use std::collections::HashSet;

/// Maximum results kept from one host response.
pub const MAX_RESULTS: usize = 100;
/// Visible rows in the completion overlay.
pub const MAX_ROWS: usize = 8;

/// The `@` token under the cursor.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileToken {
    /// Byte offset of the leading `@`.
    pub start: usize,
    /// Byte offset just past the token (exclusive).
    pub end: usize,
    /// Text between `@` and the cursor/end (quotes excluded).
    pub query: String,
    /// Whether the token is the quoted `@"..."` form.
    pub quoted: bool,
}

impl FileToken {
    /// Locate the `@` word around `cursor`.
    ///
    /// The token must start at the beginning of the input or right after
    /// whitespace, so `user@example.com` is not treated as a mention. An empty
    /// query (`@` alone) is valid and asks the host for top-level entries.
    /// A quoted token may contain whitespace.
    pub fn find(text: &str, cursor: usize) -> Option<Self> {
        let cursor = clamp_boundary(text, cursor);

        // Quoted mention: the last `@"` at a word boundary, either still open
        // before the cursor or closed right at it.
        if let Some(at) = text[..cursor].rfind("@\"") {
            let boundary = at == 0
                || text[..at]
                    .chars()
                    .next_back()
                    .is_some_and(char::is_whitespace);
            if boundary {
                let rest = &text[at + 2..cursor];
                match rest.find('"') {
                    // A closing quote: only a mention that ends exactly here.
                    Some(close) if close + 1 == rest.len() => {
                        return Some(Self {
                            start: at,
                            end: cursor,
                            query: rest[..close].to_string(),
                            quoted: true,
                        });
                    }
                    // A quote in the middle: not this token (the cursor is
                    // outside the closed mention).
                    Some(_) => {}
                    // Still open: the token runs to the closing quote or the
                    // end of the word.
                    None => {
                        let after = &text[cursor..];
                        let close = after.find('"').map(|index| cursor + index + 1);
                        let end = close.unwrap_or_else(|| {
                            cursor
                                + after
                                    .char_indices()
                                    .find(|(_, ch)| ch.is_whitespace())
                                    .map(|(index, _)| index)
                                    .unwrap_or(after.len())
                        });
                        let inner_end = if close.is_some() { end - 1 } else { end };
                        return Some(Self {
                            start: at,
                            end,
                            query: text[at + 2..inner_end].to_string(),
                            quoted: true,
                        });
                    }
                }
            }
        }

        // Unquoted word: scan back to whitespace, then forward to the end of
        // the word (the cursor may sit in the middle).
        let start = text[..cursor]
            .char_indices()
            .rev()
            .find(|(_, ch)| ch.is_whitespace())
            .map(|(index, ch)| index + ch.len_utf8())
            .unwrap_or(0);
        if !text[start..].starts_with('@') {
            return None;
        }
        let end = start
            + text[start..]
                .char_indices()
                .find(|(_, ch)| ch.is_whitespace())
                .map(|(index, _)| index)
                .unwrap_or(text.len() - start);
        Some(Self {
            start,
            end,
            query: text[start + 1..end].to_string(),
            quoted: false,
        })
    }
}

/// Insert `path` in place of `token`.
///
/// Returns the new input and the cursor offset (just past the inserted text).
pub fn insert_path(text: &str, token: &FileToken, path: &str) -> (String, usize) {
    let replacement = replacement_text(path);
    let mut next = String::with_capacity(text.len() + replacement.len());
    next.push_str(&text[..token.start]);
    next.push_str(&replacement);
    next.push_str(&text[token.end..]);
    let cursor = token.start + replacement.len();
    (next, cursor)
}

/// The text a selected path contributes: quoted when it contains whitespace,
/// with a trailing space for files (and `/` for directories so the picker
/// stays open for the next segment).
pub fn replacement_text(path: &str) -> String {
    let quoted = path.chars().any(char::is_whitespace);
    let suffix = if path.ends_with('/') || path.ends_with(std::path::MAIN_SEPARATOR) {
        ""
    } else {
        " "
    };
    let mention = if quoted {
        format!("@\"{path}\"")
    } else {
        format!("@{path}")
    };
    format!("{mention}{suffix}")
}

/// Bounded completion list plus selection and request provenance.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct FileCompletion {
    items: Vec<String>,
    selected: usize,
    request_id: Option<String>,
    sent_query: Option<String>,
}

impl FileCompletion {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn items(&self) -> &[String] {
        &self.items
    }

    pub fn is_empty(&self) -> bool {
        self.items.is_empty()
    }

    pub fn selected_index(&self) -> Option<usize> {
        (!self.items.is_empty()).then(|| self.selected.min(self.items.len() - 1))
    }

    pub fn selected_path(&self) -> Option<&str> {
        self.selected_index()
            .and_then(|index| self.items.get(index))
            .map(String::as_str)
    }

    /// Query of the most recent dispatched request, for "searching" hints.
    pub fn sent_query(&self) -> Option<&str> {
        self.sent_query.as_deref()
    }

    /// Install a result set: blanks and duplicates are dropped and the list is
    /// capped at [`MAX_RESULTS`]. The selection resets to the first row.
    pub fn set_items<I, S>(&mut self, items: I)
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        let mut seen = HashSet::new();
        self.items = items
            .into_iter()
            .map(Into::into)
            .filter(|item| !item.is_empty())
            .filter(|item| seen.insert(item.clone()))
            .take(MAX_RESULTS)
            .collect();
        self.selected = 0;
    }

    /// Narrow the visible rows to entries containing `query` (case-insensitive
    /// substring), mirroring Ink's client-side filter while a new request is
    /// in flight. An empty query keeps the current list.
    pub fn narrow(&mut self, query: &str) {
        if query.is_empty() {
            return;
        }
        let needle = query.to_lowercase();
        self.items
            .retain(|item| item.to_lowercase().contains(&needle));
        self.selected = 0;
    }

    pub fn clear(&mut self) {
        self.items.clear();
        self.selected = 0;
        self.request_id = None;
        self.sent_query = None;
    }

    pub fn next(&mut self) {
        if self.items.is_empty() {
            self.selected = 0;
        } else {
            self.selected = (self.selected + 1) % self.items.len();
        }
    }

    pub fn prev(&mut self) {
        if self.items.is_empty() {
            self.selected = 0;
        } else {
            self.selected = (self.selected + self.items.len() - 1) % self.items.len();
        }
    }

    /// Remember the request id and query just sent to the host.
    pub fn mark_sent(&mut self, request_id: impl Into<String>, query: impl Into<String>) {
        self.request_id = Some(request_id.into());
        self.sent_query = Some(query.into());
    }

    /// Whether a response belongs to the latest dispatched request.
    pub fn accepts(&self, request_id: &str) -> bool {
        self.request_id.as_deref() == Some(request_id)
    }

    /// Apply a host response; returns `false` (and changes nothing) when the
    /// request id is stale.
    pub fn set_results<I, S>(&mut self, request_id: &str, items: I) -> bool
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        if !self.accepts(request_id) {
            return false;
        }
        self.set_items(items);
        true
    }

    /// Visible rows (`max_rows` at most, scrolled to the selection) and the
    /// selection's index within that window.
    pub fn visible(&self, max_rows: usize) -> (Vec<&str>, Option<usize>) {
        let (start, end) = window(self.items.len(), self.selected, max_rows);
        let rows = self.items[start..end].iter().map(String::as_str).collect();
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

fn clamp_boundary(text: &str, offset: usize) -> usize {
    let mut offset = offset.min(text.len());
    while offset > 0 && !text.is_char_boundary(offset) {
        offset -= 1;
    }
    offset
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_an_at_token_around_the_cursor() {
        let text = "look at @src/ma";
        let token = FileToken::find(text, text.len()).expect("token");
        assert_eq!(token.start, 8);
        assert_eq!(token.end, text.len());
        assert_eq!(token.query, "src/ma");
        assert!(!token.quoted);

        // Cursor in the middle still yields the whole word.
        let token = FileToken::find(text, 10).expect("token");
        assert_eq!(token.query, "src/ma");

        // A bare `@` asks for top-level entries.
        let token = FileToken::find("@", 1).expect("token");
        assert_eq!(token.query, "");
    }

    #[test]
    fn ignores_email_like_words_and_plain_text() {
        assert_eq!(FileToken::find("mail me@example.com", 18), None);
        assert_eq!(FileToken::find("no mention", 10), None);
        assert_eq!(FileToken::find("", 0), None);
    }

    #[test]
    fn supports_quoted_tokens_with_spaces() {
        let text = "open @\"my dir/fi";
        let token = FileToken::find(text, text.len()).expect("quoted token");
        assert!(token.quoted);
        assert_eq!(token.query, "my dir/fi");

        let text = "open @\"my dir/file.ts\"";
        let token = FileToken::find(text, text.len()).expect("closed token");
        assert!(token.quoted);
        assert_eq!(token.query, "my dir/file.ts");
    }

    #[test]
    fn inserts_plain_and_quoted_paths() {
        let text = "see @src/ma and more";
        let token = FileToken::find(text, 11).expect("token");
        let (next, cursor) = insert_path(text, &token, "src/main.rs");
        assert_eq!(next, "see @src/main.rs  and more");
        assert_eq!(cursor, "see @src/main.rs ".len());

        let text = "see @\"my dir/fi\"";
        let token = FileToken::find(text, text.len()).expect("token");
        let (next, _) = insert_path(text, &token, "my dir/file.ts");
        assert_eq!(next, "see @\"my dir/file.ts\" ");

        // Directories keep the picker open (no trailing space).
        let text = "@sr";
        let token = FileToken::find(text, text.len()).expect("token");
        let (next, _) = insert_path(text, &token, "src/");
        assert_eq!(next, "@src/");
    }

    #[test]
    fn bounds_dedupes_and_narrows_results() {
        let mut completion = FileCompletion::new();
        completion.set_items(["src/a.ts", "", "src/a.ts", "src/b.ts", "README.md"]);
        assert_eq!(completion.items(), ["src/a.ts", "src/b.ts", "README.md"]);

        completion.narrow("SRC/");
        assert_eq!(completion.items(), ["src/a.ts", "src/b.ts"]);
    }

    #[test]
    fn selection_wraps_and_windows() {
        let mut completion = FileCompletion::new();
        completion.set_items(["a", "b", "c"]);
        assert_eq!(completion.selected_path(), Some("a"));
        completion.prev();
        assert_eq!(completion.selected_path(), Some("c"));
        completion.next();
        assert_eq!(completion.selected_path(), Some("a"));

        // Select the last row: the window scrolls to keep it visible.
        completion.prev();
        let (rows, selected) = completion.visible(2);
        assert_eq!(rows, ["b", "c"]);
        assert_eq!(selected, Some(1));
    }

    #[test]
    fn stale_request_ids_are_dropped() {
        let mut completion = FileCompletion::new();
        completion.mark_sent("r2", "src/m");
        assert!(completion.accepts("r2"));
        assert!(!completion.set_results("r1", ["old"]));
        assert!(completion.items().is_empty());
        assert!(completion.set_results("r2", ["src/main.rs"]));
        assert_eq!(completion.items(), ["src/main.rs"]);
    }
}
