//! Case-insensitive search over transcript rows.
//!
//! The search engine mirrors the Ink transcript search: a query is matched as
//! a literal, case-insensitive substring against every non-blank row. Offsets
//! in [`Match`] are byte offsets into the original row text and always sit on
//! a `char` boundary, so the renderer can slice the row without splitting a
//! CJK character or an emoji.
//!
//! [`TranscriptSearch`] owns navigation state (the current match); pure
//! helpers ([`highlight`]) turn a match into render segments without touching
//! colours or terminal types.

use std::ops::Range;

use cch_tui_ui::Row;

/// One occurrence of the query in a transcript row.
///
/// `start..end` is a half-open byte range into `Row::text`; both ends are
/// `char` boundaries in the original text.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct Match {
    pub row_index: usize,
    pub start: usize,
    pub end: usize,
}

/// Search state over a fixed list of rows.
///
/// Rows are copied once at construction; call [`set_query`](Self::set_query)
/// to rescan. The current match starts at the first hit and [`next`](Self::next)
/// / [`prev`](Self::prev) wrap around.
#[derive(Debug, Clone, Default)]
pub struct TranscriptSearch {
    texts: Vec<String>,
    query: String,
    matches: Vec<Match>,
    current: Option<usize>,
}

impl TranscriptSearch {
    /// Build a search over `rows`, with no active query.
    pub fn new(rows: &[Row]) -> Self {
        Self {
            texts: rows.iter().map(|row| row.text.clone()).collect(),
            query: String::new(),
            matches: Vec::new(),
            current: None,
        }
    }

    /// Replace the query and rescan all rows.
    ///
    /// An empty query clears the match list; blank (whitespace-only) rows are
    /// never searched.
    pub fn set_query(&mut self, query: impl Into<String>) {
        self.query = query.into();
        self.matches = self.scan(&self.query);
        self.current = if self.matches.is_empty() {
            None
        } else {
            Some(0)
        };
    }

    /// The active query (empty before the first call to `set_query`).
    pub fn query(&self) -> &str {
        &self.query
    }

    /// All matches for the active query, in row order then offset order.
    pub fn matches(&self) -> Vec<Match> {
        self.matches.clone()
    }

    /// Number of matches for the active query.
    pub fn count(&self) -> usize {
        self.matches.len()
    }

    /// The currently selected match, if any.
    pub fn current(&self) -> Option<Match> {
        self.current.map(|index| self.matches[index])
    }

    /// Zero-based index of [`current`](Self::current) within [`matches`].
    ///
    /// [`matches`]: Self::matches
    pub fn current_index(&self) -> Option<usize> {
        self.current
    }

    /// Select the next match, wrapping from the last to the first.
    ///
    /// Returns the newly selected match, or `None` when the query has no
    /// matches.
    // The ring cursor is not an iterator: callers need the selected match
    // back, and the cursor lives for the whole search session.
    #[allow(clippy::should_implement_trait)]
    pub fn next(&mut self) -> Option<Match> {
        self.step(1)
    }

    /// Select the previous match, wrapping from the first to the last.
    ///
    /// Returns the newly selected match, or `None` when the query has no
    /// matches.
    pub fn prev(&mut self) -> Option<Match> {
        self.step(self.matches.len().wrapping_sub(1))
    }

    fn step(&mut self, delta: usize) -> Option<Match> {
        let len = self.matches.len();
        if len == 0 {
            self.current = None;
            return None;
        }
        let index = match self.current {
            Some(current) => (current + delta) % len,
            None => 0,
        };
        self.current = Some(index);
        Some(self.matches[index])
    }

    /// Search-result rows for an overlay: `N/M  <matched line summary>`.
    ///
    /// `N` is the 1-based match number, `M` the total match count. At most
    /// `max_visible` rows are produced, each truncated to `width` display
    /// columns (with an ellipsis when clipped). The query is scanned
    /// independently of the navigation cursor, so the list always reflects
    /// `query` even if `set_query` has not been called with it.
    pub fn rows(&self, query: &str, width: usize, max_visible: usize) -> Vec<String> {
        if width == 0 || max_visible == 0 {
            return Vec::new();
        }
        let matches = self.scan(query);
        let total = matches.len();
        matches
            .iter()
            .take(max_visible)
            .enumerate()
            .map(|(index, found)| {
                let prefix = format!("{}/{}  ", index + 1, total);
                let available = width.saturating_sub(display_width(&prefix));
                let summary = truncate_to_width(self.texts[found.row_index].trim(), available);
                truncate_to_width(&format!("{prefix}{summary}"), width)
            })
            .collect()
    }

    /// Scan every non-blank row for `query`, case-insensitively.
    fn scan(&self, query: &str) -> Vec<Match> {
        let lowered_query = query.to_lowercase();
        if lowered_query.is_empty() {
            return Vec::new();
        }
        let mut matches = Vec::new();
        for (row_index, text) in self.texts.iter().enumerate() {
            if text.trim().is_empty() {
                continue;
            }
            collect_matches(row_index, text, &lowered_query, &mut matches);
        }
        matches
    }
}

/// Split `row` into alternating `(range, is_hit)` segments.
///
/// The ranges are contiguous, cover the whole row and are guaranteed to fall
/// on `char` boundaries. `is_hit` is true exactly for the matched range. The
/// helper is tolerant of stale or out-of-range matches: an invalid match
/// yields a single non-hit segment. No colours are attached.
pub fn highlight(row: &Row, found: &Match) -> Vec<(Range<usize>, bool)> {
    let text = &row.text;
    let len = text.len();
    let start = floor_boundary(text, found.start);
    let end = floor_boundary(text, found.end);
    if start >= end || end > len {
        return if len == 0 {
            Vec::new()
        } else {
            vec![(0..len, false)]
        };
    }
    let mut segments = Vec::with_capacity(3);
    if start > 0 {
        segments.push((0..start, false));
    }
    segments.push((start..end, true));
    if end < len {
        segments.push((end..len, false));
    }
    segments
}

/// Lowercase `text` while remembering which original `char` produced every
/// lowered byte, plus the lowered byte offsets that are `char` boundaries.
///
/// Unicode lowercasing can expand one scalar (e.g. `İ` becomes `i` plus a
/// combining dot), so lowered byte offsets cannot be used directly as row
/// offsets. The mapping keeps matches on real character boundaries.
struct Lowered {
    text: String,
    /// `(start, end)` of the original `char` for each lowered byte.
    origin: Vec<(usize, usize)>,
    /// `boundary[i]` is true when `i` is a `char` boundary in `text`.
    boundary: Vec<bool>,
}

impl Lowered {
    fn new(original: &str) -> Self {
        let mut text = String::with_capacity(original.len());
        let mut origin = Vec::with_capacity(original.len());
        let mut boundary = vec![true];
        for (start, ch) in original.char_indices() {
            let end = start + ch.len_utf8();
            let lowered: String = ch.to_lowercase().collect();
            let lowered_start = text.len();
            text.push_str(&lowered);
            origin.extend(std::iter::repeat_n((start, end), lowered.len()));
            boundary.resize(text.len() + 1, false);
            boundary[lowered_start] = true;
            boundary[text.len()] = true;
        }
        Self {
            text,
            origin,
            boundary,
        }
    }
}

fn collect_matches(row_index: usize, text: &str, lowered_query: &str, matches: &mut Vec<Match>) {
    debug_assert!(!lowered_query.is_empty());
    let lowered = Lowered::new(text);
    let mut from = 0;
    while from < lowered.text.len() {
        let Some(offset) = lowered.text[from..].find(lowered_query) else {
            break;
        };
        let start = from + offset;
        let end = start + lowered_query.len();
        // Reject partial matches that begin or end inside an expanded
        // lowercase mapping; they would map to a misleading row range.
        if lowered.boundary[start] && lowered.boundary[end] {
            let original_start = lowered.origin[start].0;
            let original_end = lowered.origin[end - 1].1;
            matches.push(Match {
                row_index,
                start: original_start,
                end: original_end,
            });
            from = end;
        } else {
            from = (start..=lowered.text.len())
                .find(|&index| index > start && lowered.boundary[index])
                .unwrap_or(lowered.text.len());
        }
    }
}

/// Round `offset` down to the nearest `char` boundary (clamped to the text).
fn floor_boundary(text: &str, mut offset: usize) -> usize {
    offset = offset.min(text.len());
    while !text.is_char_boundary(offset) {
        offset -= 1;
    }
    offset
}

/// Truncate `text` to `width` display columns, appending `…` when clipped.
fn truncate_to_width(text: &str, width: usize) -> String {
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
    let code = ch as u32;
    if is_zero_width(code) {
        return 0;
    }
    if is_wide(code) { 2 } else { 1 }
}

/// Combining marks and format characters occupy no columns.
fn is_zero_width(code: u32) -> bool {
    matches!(
        code,
        0x0300..=0x036F
            | 0x1AB0..=0x1AFF
            | 0x1DC0..=0x1DFF
            | 0x200B..=0x200F
            | 0x20D0..=0x20FF
            | 0xFE20..=0xFE2F
            | 0xFEFF
    )
}

/// East Asian wide/fullwidth ranges, sufficient for transcript summaries.
fn is_wide(code: u32) -> bool {
    matches!(
        code,
        0x1100..=0x115F
            | 0x2E80..=0x303E
            | 0x3041..=0x33FF
            | 0x3400..=0x4DBF
            | 0x4E00..=0x9FFF
            | 0xA000..=0xA4CF
            | 0xA960..=0xA97F
            | 0xAC00..=0xD7A3
            | 0xF900..=0xFAFF
            | 0xFE10..=0xFE19
            | 0xFE30..=0xFE6F
            | 0xFF00..=0xFF60
            | 0xFFE0..=0xFFE6
            | 0x1F300..=0x1FAFF
            | 0x20000..=0x3FFFD
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use cch_tui_ui::RowStyle;

    fn row(text: &str) -> Row {
        Row::new(RowStyle::Assistant, text)
    }

    fn offsets(found: &Match) -> (usize, usize) {
        (found.start, found.end)
    }

    #[test]
    fn matches_are_case_insensitive() {
        let rows = [row("Hello World"), row("say hello")];
        let mut search = TranscriptSearch::new(&rows);
        search.set_query("HELLO");

        assert_eq!(
            search.matches(),
            vec![
                Match {
                    row_index: 0,
                    start: 0,
                    end: 5,
                },
                Match {
                    row_index: 1,
                    start: 4,
                    end: 9,
                },
            ]
        );
        assert_eq!(search.count(), 2);
        assert_eq!(search.current().map(|m| offsets(&m)), Some((0, 5)));
    }

    #[test]
    fn cjk_matches_stay_on_char_boundaries() {
        let rows = [row("你好世界，你好"), row("Rust你好RUST")];
        let mut search = TranscriptSearch::new(&rows);

        search.set_query("你好");
        assert_eq!(
            search
                .matches()
                .iter()
                .map(|m| (m.row_index, m.start, m.end))
                .collect::<Vec<_>>(),
            vec![(0, 0, 6), (0, 15, 21), (1, 4, 10)]
        );

        search.set_query("rust");
        let found = search.matches();
        assert_eq!(
            found
                .iter()
                .map(|m| (m.row_index, m.start, m.end))
                .collect::<Vec<_>>(),
            vec![(1, 0, 4), (1, 10, 14)]
        );
        for hit in &found {
            let text = &rows[hit.row_index].text;
            assert!(text.is_char_boundary(hit.start));
            assert!(text.is_char_boundary(hit.end));
        }
    }

    #[test]
    fn navigation_cycles_in_both_directions() {
        let rows = [row("foo foo foo")];
        let mut search = TranscriptSearch::new(&rows);
        search.set_query("foo");

        assert_eq!(search.count(), 3);
        assert_eq!(search.current().map(|m| offsets(&m)), Some((0, 3)));
        assert_eq!(search.next().map(|m| offsets(&m)), Some((4, 7)));
        assert_eq!(search.next().map(|m| offsets(&m)), Some((8, 11)));
        assert_eq!(search.current().map(|m| offsets(&m)), Some((8, 11)));
        // Wrap forward, then backward.
        assert_eq!(search.next().map(|m| offsets(&m)), Some((0, 3)));
        assert_eq!(search.prev().map(|m| offsets(&m)), Some((8, 11)));
        assert_eq!(search.prev().map(|m| offsets(&m)), Some((4, 7)));
    }

    #[test]
    fn current_index_tracks_navigation() {
        let rows = [row("foo"), row("foo foo")];
        let mut search = TranscriptSearch::new(&rows);
        search.set_query("foo");
        assert_eq!(search.current_index(), Some(0));

        search.next();
        assert_eq!(search.current_index(), Some(1));
        search.prev();
        assert_eq!(search.current_index(), Some(0));
        search.prev();
        assert_eq!(search.current_index(), Some(2));

        search.set_query("missing");
        assert_eq!(search.current_index(), None);
    }

    #[test]
    fn empty_query_clears_everything() {
        let rows = [row("something")];
        let mut search = TranscriptSearch::new(&rows);
        search.set_query("some");
        assert_eq!(search.count(), 1);

        search.set_query("");
        assert!(search.matches().is_empty());
        assert_eq!(search.count(), 0);
        assert_eq!(search.current(), None);
        assert_eq!(search.next(), None);
        assert_eq!(search.prev(), None);
    }

    #[test]
    fn blank_rows_are_skipped() {
        let rows = [row(""), row("   "), row("hello"), row("\t")];
        let mut search = TranscriptSearch::new(&rows);
        search.set_query("hello");
        assert_eq!(search.count(), 1);
        assert_eq!(search.matches()[0].row_index, 2);

        search.set_query(" ");
        // Only the row with a literal space matches; blank rows never do.
        assert_eq!(search.count(), 0);
    }

    #[test]
    fn result_rows_carry_index_and_summary() {
        let rows = [row("alpha"), row("beta alpha"), row("gamma")];
        let search = TranscriptSearch::new(&rows);
        assert_eq!(
            search.rows("alpha", 40, 10),
            vec!["1/2  alpha", "2/2  beta alpha"]
        );
        assert_eq!(search.rows("alpha", 40, 1), vec!["1/2  alpha"]);
        assert!(search.rows("", 40, 10).is_empty());
        assert!(search.rows("alpha", 0, 10).is_empty());
        assert!(search.rows("alpha", 40, 0).is_empty());
    }

    #[test]
    fn result_rows_are_truncated_to_width() {
        let rows = [row("abcdefghijklmnopqrstuvwxyz")];
        let search = TranscriptSearch::new(&rows);
        let lines = search.rows("abc", 10, 10);
        assert_eq!(lines, vec!["1/1  abcd…"]);
        assert!(display_width(&lines[0]) <= 10);

        // Wide characters count as two columns and are never split.
        let rows = [row("你好世界你好世界")];
        let search = TranscriptSearch::new(&rows);
        let lines = search.rows("世界", 12, 10);
        assert_eq!(lines, vec!["1/2  你好世…", "2/2  你好世…"]);
        for line in &lines {
            assert!(display_width(line) <= 12);
            assert!(line.is_char_boundary(line.len()));
        }
    }

    #[test]
    fn highlight_splits_row_around_the_match() {
        let line = row("abcABCabc");
        let found = Match {
            row_index: 0,
            start: 3,
            end: 6,
        };
        assert_eq!(
            highlight(&line, &found),
            vec![(0..3, false), (3..6, true), (6..9, false)]
        );
    }

    #[test]
    fn highlight_handles_cjk_and_invalid_ranges() {
        let line = row("你好abc你好");
        let found = Match {
            row_index: 0,
            start: 6,
            end: 9,
        };
        assert_eq!(
            highlight(&line, &found),
            vec![(0..6, false), (6..9, true), (9..15, false)]
        );

        let stale = Match {
            row_index: 0,
            start: 1,
            end: 2,
        };
        assert_eq!(highlight(&line, &stale), vec![(0..15, false)]);
        assert!(highlight(&row(""), &stale).is_empty());
    }

    #[test]
    fn overlapping_occurrences_are_not_reported() {
        let rows = [row("aaaa")];
        let mut search = TranscriptSearch::new(&rows);
        search.set_query("aa");
        assert_eq!(
            search
                .matches()
                .iter()
                .map(|m| (m.start, m.end))
                .collect::<Vec<_>>(),
            vec![(0, 2), (2, 4)]
        );
    }
}
