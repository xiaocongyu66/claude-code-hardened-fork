//! Virtual transcript list for full-screen mode.
//!
//! [`TranscriptModel`] owns the transcript rows and a small amount of layout
//! metadata (one display-line count per row). It answers the only question the
//! renderer needs: which logical rows intersect the viewport? No terminal or
//! ratatui types are involved, so the scrolling behaviour is testable without
//! a TTY.
//!
//! Scroll positions and viewport sizes are measured in **display lines**, not
//! logical rows. A logical row may wrap to many display lines; the model maps
//! between the two through a prefix-sum table so scrolling a long row works
//! exactly like scrolling several short ones. Wrapped text itself is never
//! retained — only the line count is cached.

use std::ops::Range;

use cch_tui_ui::{Row, wrap_text};

/// Display lines of context rendered above and below the viewport by default.
pub const DEFAULT_OVERSCAN: usize = 3;

/// Windowed, scrollable model of the transcript.
///
/// The model starts in follow-tail mode, so the first [`window`] call pins the
/// view to the newest row. Scrolling up leaves follow mode; returning to the
/// bottom (by scrolling, paging or calling [`follow_tail`]) resumes it.
///
/// [`window`]: TranscriptModel::window
/// [`follow_tail`]: TranscriptModel::follow_tail
#[derive(Debug, Clone)]
pub struct TranscriptModel {
    rows: Vec<Row>,
    /// Display-line height of each row at `layout_width`, parallel to `rows`.
    heights: Vec<usize>,
    /// Prefix sums of `heights`; `prefix[i]` is the first line of row `i`.
    /// Always starts with `0`.
    prefix: Vec<usize>,
    /// Width the heights were computed for; `None` until the first layout.
    layout_width: Option<usize>,
    /// First display line shown in the viewport (before overscan).
    offset: usize,
    viewport_height: usize,
    overscan: usize,
    follow: bool,
    unseen_count: usize,
}

impl Default for TranscriptModel {
    fn default() -> Self {
        Self::new()
    }
}

impl TranscriptModel {
    pub fn new() -> Self {
        Self {
            rows: Vec::new(),
            heights: Vec::new(),
            prefix: vec![0],
            layout_width: None,
            offset: 0,
            viewport_height: 0,
            overscan: DEFAULT_OVERSCAN,
            follow: true,
            unseen_count: 0,
        }
    }

    /// Create an empty model with a custom overscan (in display lines).
    pub fn with_overscan(overscan: usize) -> Self {
        Self {
            overscan,
            ..Self::new()
        }
    }

    pub fn overscan(&self) -> usize {
        self.overscan
    }

    /// Change the number of context lines rendered around the viewport.
    pub fn set_overscan(&mut self, overscan: usize) {
        self.overscan = overscan;
    }

    /// Replace the transcript. Does not copy the row text.
    ///
    /// Resets the view to follow-tail mode and clears the unseen counter. The
    /// height cache survives when the width is unchanged.
    pub fn set_rows(&mut self, rows: Vec<Row>) {
        self.rows = rows;
        self.heights.clear();
        self.prefix.clear();
        self.prefix.push(0);
        if let Some(width) = self.layout_width {
            self.rebuild_heights(width);
        }
        self.follow = true;
        self.unseen_count = 0;
        self.offset = self.max_offset();
    }

    /// Append rows to the transcript.
    ///
    /// While following, the view stays pinned to the bottom. Otherwise the
    /// appended rows increment the unseen counter (used to show a "new
    /// messages" pill).
    pub fn append(&mut self, rows: impl IntoIterator<Item = Row>) {
        let mut added = 0;
        for row in rows {
            added += 1;
            if let Some(width) = self.layout_width {
                let height = wrap_text(&row.text, width).len();
                self.heights.push(height);
                let total = self.prefix.last().copied().unwrap_or(0) + height;
                self.prefix.push(total);
            }
            self.rows.push(row);
        }
        if self.follow {
            self.offset = self.max_offset();
            self.unseen_count = 0;
        } else {
            self.unseen_count = self.unseen_count.saturating_add(added);
        }
    }

    /// Drop all rows and reset scrolling state.
    pub fn clear(&mut self) {
        self.rows.clear();
        self.heights.clear();
        self.prefix.clear();
        self.prefix.push(0);
        self.offset = 0;
        self.follow = true;
        self.unseen_count = 0;
    }

    pub fn len(&self) -> usize {
        self.rows.len()
    }

    pub fn is_empty(&self) -> bool {
        self.rows.is_empty()
    }

    pub fn rows(&self) -> &[Row] {
        &self.rows
    }

    /// Width of the cached layout, if [`window`] has been called.
    ///
    /// [`window`]: TranscriptModel::window
    pub fn width(&self) -> Option<usize> {
        self.layout_width
    }

    /// Cached display-line height of one row, if a layout exists.
    pub fn row_height(&self, index: usize) -> Option<usize> {
        self.heights.get(index).copied()
    }

    /// Total display lines of all rows at the cached width.
    pub fn total_height(&self) -> usize {
        self.prefix.last().copied().unwrap_or(0)
    }

    /// First display line shown in the viewport, ignoring overscan.
    pub fn offset(&self) -> usize {
        self.offset
    }

    pub fn viewport_height(&self) -> usize {
        self.viewport_height
    }

    /// Largest valid [`offset`](Self::offset) for the current viewport.
    pub fn max_offset(&self) -> usize {
        self.total_height().saturating_sub(self.viewport_height)
    }

    pub fn is_following(&self) -> bool {
        self.follow
    }

    /// Number of rows appended while not following the tail.
    pub fn unseen_count(&self) -> usize {
        self.unseen_count
    }

    /// Whether the "new messages" pill should be shown.
    pub fn has_unseen(&self) -> bool {
        self.unseen_count > 0
    }

    /// Lay out at `width`, set the viewport to `height` display lines and
    /// return the row range to render, including overscan.
    ///
    /// The range is half-open and clamped to the rows that actually exist.
    /// Returns `0..0` for an empty transcript, a zero-height viewport or a
    /// zero-width layout.
    pub fn window(&mut self, height: usize, width: usize) -> Range<usize> {
        self.ensure_layout(width);
        if height == 0 {
            return 0..0;
        }
        self.viewport_height = height;
        let max = self.max_offset();
        if self.follow {
            self.offset = max;
        } else {
            self.offset = self.offset.min(max);
            self.sync_follow();
        }
        if width == 0 || self.rows.is_empty() {
            return 0..0;
        }

        let total = self.total_height();
        let top = self.offset.saturating_sub(self.overscan);
        let bottom = self
            .offset
            .saturating_add(height)
            .saturating_add(self.overscan)
            .min(total);
        if bottom <= top {
            return 0..0;
        }

        let start = self
            .prefix
            .partition_point(|&line| line <= top)
            .saturating_sub(1)
            .min(self.rows.len());
        let end = self
            .prefix
            .partition_point(|&line| line < bottom)
            .min(self.rows.len());
        start..end.max(start)
    }

    /// Scroll by `delta` display lines (positive scrolls down).
    ///
    /// The offset is clamped to `0..=max_offset`. Reaching the bottom resumes
    /// follow-tail mode and clears the unseen counter.
    pub fn scroll_by(&mut self, delta: isize) {
        let target = self.offset.saturating_add_signed(delta);
        self.offset = target.min(self.max_offset());
        self.sync_follow();
    }

    /// Scroll to the newest line and resume following.
    pub fn scroll_to_bottom(&mut self) {
        self.offset = self.max_offset();
        self.follow = true;
        self.unseen_count = 0;
    }

    /// Scroll to the oldest line. Clears follow mode unless all content fits
    /// in the viewport.
    pub fn scroll_to_top(&mut self) {
        self.offset = 0;
        self.sync_follow();
    }

    /// Move up by one viewport height.
    pub fn page_up(&mut self) {
        let page = self.viewport_height.max(1);
        self.offset = self.offset.saturating_sub(page);
        self.sync_follow();
    }

    /// Move down by one viewport height.
    pub fn page_down(&mut self) {
        let page = self.viewport_height.max(1);
        self.offset = self.offset.saturating_add(page).min(self.max_offset());
        self.sync_follow();
    }

    /// Jump to the bottom and keep following new rows.
    pub fn follow_tail(&mut self) {
        self.scroll_to_bottom();
    }

    /// Recompute every cached height for `width`. Called on width changes;
    /// wrapped strings are dropped immediately, leaving only the counts.
    fn ensure_layout(&mut self, width: usize) {
        if self.layout_width == Some(width) {
            return;
        }
        self.layout_width = Some(width);
        self.rebuild_heights(width);
    }

    fn rebuild_heights(&mut self, width: usize) {
        self.heights.clear();
        self.prefix.clear();
        self.prefix.reserve(self.rows.len() + 1);
        self.prefix.push(0);
        let mut total = 0;
        for row in &self.rows {
            let height = wrap_text(&row.text, width).len();
            self.heights.push(height);
            total += height;
            self.prefix.push(total);
        }
    }

    /// Update follow mode from the current offset: at the bottom means
    /// following (and clears the pill), anywhere else stops following.
    fn sync_follow(&mut self) {
        if self.offset >= self.max_offset() {
            self.follow = true;
            self.unseen_count = 0;
        } else {
            self.follow = false;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use cch_tui_ui::RowStyle;

    fn rows(count: usize) -> Vec<Row> {
        (0..count)
            .map(|index| Row::new(RowStyle::System, format!("row {index}")))
            .collect()
    }

    /// Rows exactly ten columns wide: two lines at width 5, one at width 20.
    fn wide_rows(count: usize) -> Vec<Row> {
        (0..count)
            .map(|index| Row::new(RowStyle::System, format!("{index:010}")))
            .collect()
    }

    #[test]
    fn window_follows_the_tail_with_overscan() {
        let mut model = TranscriptModel::with_overscan(2);
        model.set_rows(rows(100));

        assert_eq!(model.window(10, 20), 88..100);
        assert_eq!(model.offset(), 90);
        assert_eq!(model.total_height(), 100);
        assert_eq!(model.overscan(), 2);
        assert!(model.is_following());
    }

    #[test]
    fn window_handles_empty_single_and_long_rows() {
        let mut model = TranscriptModel::with_overscan(0);
        assert_eq!(model.window(10, 20), 0..0);
        assert_eq!(model.total_height(), 0);

        model.append(vec![Row::new(RowStyle::Assistant, "hello")]);
        assert_eq!(model.window(10, 20), 0..1);

        // One row taller than the viewport still occupies a single row index.
        // `set_rows` keeps the previous layout width (20), so the height is not
        // recomputed until the next `window` call with width 10.
        model.set_rows(vec![Row::new(RowStyle::Assistant, "a".repeat(100))]);
        assert_eq!(model.total_height(), 5);
        assert_eq!(model.window(4, 10), 0..1);
        assert_eq!(model.total_height(), 10);
        assert_eq!(model.offset(), 6);

        model.scroll_to_top();
        assert_eq!(model.window(4, 10), 0..1);
        assert!(!model.is_following());
    }

    #[test]
    fn zero_height_and_zero_width_windows_are_empty() {
        let mut model = TranscriptModel::with_overscan(0);
        model.set_rows(rows(5));
        assert_eq!(model.window(0, 10), 0..0);
        assert_eq!(model.window(10, 0), 0..0);
        assert_eq!(model.total_height(), 0);
        // A later valid layout recovers without stale metadata.
        assert_eq!(model.window(2, 10), 3..5);
    }

    #[test]
    fn overscan_is_clamped_at_both_edges() {
        let mut model = TranscriptModel::with_overscan(10);
        model.set_rows(rows(3));
        assert_eq!(model.window(2, 10), 0..3);

        model.set_overscan(0);
        model.scroll_to_top();
        assert_eq!(model.window(2, 10), 0..2);
    }

    #[test]
    fn appending_while_following_stays_at_the_bottom() {
        let mut model = TranscriptModel::with_overscan(1);
        model.set_rows(rows(5));
        assert_eq!(model.window(3, 10), 1..5);

        model.append(rows(2));
        assert_eq!(model.window(3, 10), 3..7);
        assert_eq!(model.offset(), 4);
        assert_eq!(model.unseen_count(), 0);
        assert!(model.is_following());
    }

    #[test]
    fn scrolling_up_stops_following_and_counts_unseen_rows() {
        let mut model = TranscriptModel::with_overscan(0);
        model.set_rows(rows(10));
        assert_eq!(model.window(4, 10), 6..10);

        model.scroll_by(-3);
        assert_eq!(model.offset(), 3);
        assert!(!model.is_following());

        model.append(rows(3));
        assert_eq!(model.unseen_count(), 3);
        assert!(model.has_unseen());
        assert_eq!(model.offset(), 3);
        assert_eq!(model.window(4, 10), 3..7);

        model.scroll_by(100);
        assert_eq!(model.offset(), 9);
        assert_eq!(model.unseen_count(), 0);
        assert!(!model.has_unseen());
        assert!(model.is_following());
        assert_eq!(model.window(4, 10), 9..13);
    }

    #[test]
    fn unseen_only_clears_on_reaching_the_bottom() {
        let mut model = TranscriptModel::with_overscan(0);
        model.set_rows(rows(20));
        model.window(5, 10);
        assert_eq!(model.offset(), 15);

        model.scroll_by(-5);
        assert_eq!(model.offset(), 10);
        model.append(rows(1));
        assert_eq!(model.unseen_count(), 1);

        model.scroll_by(1);
        assert_eq!(model.offset(), 11);
        assert_eq!(model.unseen_count(), 1);
        assert!(!model.is_following());

        model.scroll_to_bottom();
        assert_eq!(model.offset(), 16);
        assert_eq!(model.unseen_count(), 0);
        assert!(model.is_following());
    }

    #[test]
    fn page_up_and_down_stay_in_bounds() {
        let mut model = TranscriptModel::with_overscan(0);
        model.set_rows(rows(100));
        assert_eq!(model.window(10, 10), 90..100);

        model.page_up();
        assert_eq!(model.offset(), 80);
        assert!(!model.is_following());

        for _ in 0..100 {
            model.page_up();
        }
        assert_eq!(model.offset(), 0);
        assert_eq!(model.window(10, 10), 0..10);

        model.page_down();
        assert_eq!(model.offset(), 10);

        for _ in 0..100 {
            model.page_down();
        }
        assert_eq!(model.offset(), 90);
        assert!(model.is_following());
        assert_eq!(model.window(10, 10), 90..100);
    }

    #[test]
    fn scroll_by_clamps_extreme_deltas() {
        let mut model = TranscriptModel::with_overscan(0);
        model.set_rows(rows(100));
        model.window(10, 10);

        model.scroll_by(isize::MIN);
        assert_eq!(model.offset(), 0);
        assert!(!model.is_following());

        model.scroll_by(isize::MAX);
        assert_eq!(model.offset(), 90);
        assert!(model.is_following());

        model.scroll_by(0);
        assert_eq!(model.offset(), 90);
    }

    #[test]
    fn width_change_invalidates_the_height_cache() {
        let mut model = TranscriptModel::with_overscan(0);
        model.set_rows(vec![Row::new(RowStyle::Assistant, "abcdefghij")]);

        model.window(10, 4);
        assert_eq!(model.row_height(0), Some(3));
        assert_eq!(model.total_height(), 3);
        assert_eq!(model.width(), Some(4));

        model.window(10, 20);
        assert_eq!(model.row_height(0), Some(1));
        assert_eq!(model.total_height(), 1);
        assert_eq!(model.width(), Some(20));

        // Appends use the new width without a relayout pass.
        model.append(vec![Row::new(RowStyle::Assistant, "abcdefghijklmnop")]);
        assert_eq!(model.row_height(1), Some(1));
        assert_eq!(model.total_height(), 2);
        assert_eq!(model.window(10, 20), 0..2);
    }

    #[test]
    fn width_change_reclamps_the_offset() {
        let mut model = TranscriptModel::with_overscan(0);
        model.set_rows(wide_rows(100));
        assert_eq!(model.window(10, 5), 95..100);
        assert_eq!(model.total_height(), 200);

        model.scroll_to_top();
        model.scroll_by(150);
        assert_eq!(model.offset(), 150);
        assert!(!model.is_following());

        // Re-laying out at the same width preserves the scroll position.
        model.window(10, 5);
        assert_eq!(model.offset(), 150);
        assert_eq!(model.total_height(), 200);

        // Wider rows halve the height: 150 is clamped to the new maximum.
        model.window(10, 20);
        assert_eq!(model.offset(), 90);
        assert!(model.is_following());

        // Narrowing again re-invalidates the cache and re-pins to the tail.
        model.window(10, 5);
        assert_eq!(model.total_height(), 200);
        assert_eq!(model.offset(), 190);
    }

    #[test]
    fn clear_and_set_rows_reset_follow_state() {
        let mut model = TranscriptModel::with_overscan(0);
        model.set_rows(rows(30));
        model.window(5, 10);
        model.scroll_to_top();
        model.append(rows(2));
        assert_eq!(model.unseen_count(), 2);

        model.clear();
        assert!(model.is_empty());
        assert_eq!(model.offset(), 0);
        assert_eq!(model.unseen_count(), 0);
        assert!(model.is_following());
        assert_eq!(model.window(5, 10), 0..0);

        model.set_rows(rows(20));
        assert!(model.is_following());
        assert_eq!(model.unseen_count(), 0);
        assert_eq!(model.window(5, 10), 15..20);
    }
}
