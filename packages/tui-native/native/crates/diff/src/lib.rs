//! Line-oriented diff built on a pure-Rust Myers algorithm.
//!
//! The public entry point is [`diff_lines`]; [`diff_lines_with_options`] adds
//! unified-context control and an output-size cap. No dependencies beyond
//! `std`.

use std::collections::HashSet;

/// Number of unchanged lines shown around a change by default.
pub const DEFAULT_CONTEXT: usize = 3;

/// Role of a [`DiffRow`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum DiffKind {
    /// Unchanged line, present in both sides.
    Context,
    /// Line present only in the new text.
    Added,
    /// Line present only in the old text.
    Removed,
}

/// One row of the rendered diff.
///
/// Line numbers are 1-based. `Removed` rows carry only `old_line`, `Added`
/// rows only `new_line` and context rows carry both. Truncation markers carry
/// neither.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiffRow {
    pub kind: DiffKind,
    pub old_line: Option<u32>,
    pub new_line: Option<u32>,
    pub text: String,
}

impl DiffRow {
    /// True for a synthetic row such as the `max_rows` truncation marker.
    pub fn is_marker(&self) -> bool {
        self.old_line.is_none() && self.new_line.is_none()
    }
}

/// Tuning knobs for [`diff_lines_with_options`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DiffOptions {
    /// Unchanged lines retained on each side of a change.
    pub context: usize,
    /// Hard cap on returned rows. When exceeded the tail is replaced by a
    /// single marker row describing how many rows were dropped.
    pub max_rows: Option<usize>,
}

impl Default for DiffOptions {
    fn default() -> Self {
        Self {
            context: DEFAULT_CONTEXT,
            max_rows: None,
        }
    }
}

/// Diff two texts line by line with the default options (3 context lines, no
/// row cap).
///
/// Input is normalised to `\n`-separated lines; a trailing `\r` is stripped
/// from each line, so CRLF and LF inputs compare equal. A trailing newline is
/// not significant. Identical inputs yield every line as [`DiffKind::Context`].
pub fn diff_lines(before: &str, after: &str) -> Vec<DiffRow> {
    diff_lines_with_options(before, after, DiffOptions::default())
}

/// Diff two texts with explicit context and row-cap options.
pub fn diff_lines_with_options(before: &str, after: &str, options: DiffOptions) -> Vec<DiffRow> {
    let old_lines = split_lines(before);
    let new_lines = split_lines(after);

    let mut ops = Vec::with_capacity(old_lines.len().max(new_lines.len()));
    myers(&old_lines, &new_lines, &mut ops);

    let mut rows = rows_from_ops(&ops);
    normalize_change_blocks(&mut rows);
    let rows = apply_context(rows, options.context);
    apply_max_rows(rows, options.max_rows)
}

/// Split into lines, treating `\r\n` as a terminator (the `\r` is dropped).
fn split_lines(text: &str) -> Vec<&str> {
    text.lines().collect()
}

#[derive(Debug, Clone, Copy)]
enum Op<'a> {
    Equal(&'a str),
    Delete(&'a str),
    Insert(&'a str),
}

/// Recursive linear-space Myers diff, trimming the common prefix/suffix while
/// descending and splitting on the middle snake returned by [`bisect`].
fn myers<'a>(a: &[&'a str], b: &[&'a str], out: &mut Vec<Op<'a>>) {
    let mut prefix = 0;
    while prefix < a.len() && prefix < b.len() && a[prefix] == b[prefix] {
        out.push(Op::Equal(a[prefix]));
        prefix += 1;
    }

    let a = &a[prefix..];
    let b = &b[prefix..];

    let mut suffix = 0;
    while suffix < a.len() && suffix < b.len() && a[a.len() - 1 - suffix] == b[b.len() - 1 - suffix]
    {
        suffix += 1;
    }

    let a_mid = &a[..a.len() - suffix];
    let b_mid = &b[..b.len() - suffix];
    myers_middle(a_mid, b_mid, out);

    for line in &a[a.len() - suffix..] {
        out.push(Op::Equal(line));
    }
}

fn myers_middle<'a>(a: &[&'a str], b: &[&'a str], out: &mut Vec<Op<'a>>) {
    if a.is_empty() {
        out.extend(b.iter().map(|line| Op::Insert(line)));
        return;
    }
    if b.is_empty() {
        out.extend(a.iter().map(|line| Op::Delete(line)));
        return;
    }

    // Cheap disjointness check: without a shared line the minimal script is a
    // full delete followed by a full insert. This keeps pathological inputs
    // (10k unrelated lines) linear instead of quadratic.
    if !share_any_line(a, b) {
        out.extend(a.iter().map(|line| Op::Delete(line)));
        out.extend(b.iter().map(|line| Op::Insert(line)));
        return;
    }

    match bisect(a, b) {
        Some((x, y)) if (x, y) != (0, 0) && (x, y) != (a.len(), b.len()) => {
            myers(&a[..x], &b[..y], out);
            myers(&a[x..], &b[y..], out);
        }
        // The middle-snake search found no overlap: every line is an edit.
        _ => {
            out.extend(a.iter().map(|line| Op::Delete(line)));
            out.extend(b.iter().map(|line| Op::Insert(line)));
        }
    }
}

fn share_any_line(a: &[&str], b: &[&str]) -> bool {
    if a.len() <= b.len() {
        let set: HashSet<&str> = a.iter().copied().collect();
        b.iter().any(|line| set.contains(line))
    } else {
        let set: HashSet<&str> = b.iter().copied().collect();
        a.iter().any(|line| set.contains(line))
    }
}

/// Port of the Myers middle-snake search (the same formulation used by
/// diff-match-patch): forward and reverse paths are expanded in lock-step and
/// the first overlap gives a split point. Returns `None` when the paths never
/// meet, which means the two slices share no line.
fn bisect(a: &[&str], b: &[&str]) -> Option<(usize, usize)> {
    let n = a.len() as i64;
    let m = b.len() as i64;
    let max_d = (n + m + 1) / 2;
    let v_offset = max_d;
    let v_length = (2 * max_d + 2) as usize;
    let mut v1 = vec![-1i64; v_length];
    let mut v2 = vec![-1i64; v_length];
    let start = (v_offset + 1) as usize;
    v1[start] = 0;
    v2[start] = 0;

    let delta = n - m;
    let front = delta % 2 != 0;
    let (mut k1start, mut k1end, mut k2start, mut k2end) = (0i64, 0i64, 0i64, 0i64);

    for d in 0..max_d {
        let mut k1 = -d + k1start;
        while k1 <= d - k1end {
            let k1_offset = v_offset + k1;
            let idx = k1_offset as usize;
            let mut x1 = if k1 == -d || (k1 != d && v1[idx - 1] < v1[idx + 1]) {
                v1[idx + 1]
            } else {
                v1[idx - 1] + 1
            };
            let mut y1 = x1 - k1;
            while x1 < n && y1 < m && a[x1 as usize] == b[y1 as usize] {
                x1 += 1;
                y1 += 1;
            }
            v1[idx] = x1;

            if x1 > n {
                k1end += 2;
            } else if y1 > m {
                k1start += 2;
            } else if front {
                let k2_offset = v_offset + delta - k1;
                if k2_offset >= 0 && (k2_offset as usize) < v_length && v2[k2_offset as usize] != -1
                {
                    let x2 = n - v2[k2_offset as usize];
                    if x1 >= x2 {
                        return Some((x1 as usize, y1 as usize));
                    }
                }
            }
            k1 += 2;
        }

        let mut k2 = -d + k2start;
        while k2 <= d - k2end {
            let k2_offset = v_offset + k2;
            let idx = k2_offset as usize;
            let mut x2 = if k2 == -d || (k2 != d && v2[idx - 1] < v2[idx + 1]) {
                v2[idx + 1]
            } else {
                v2[idx - 1] + 1
            };
            let mut y2 = x2 - k2;
            while x2 < n
                && y2 < m
                && a[n as usize - x2 as usize - 1] == b[m as usize - y2 as usize - 1]
            {
                x2 += 1;
                y2 += 1;
            }
            v2[idx] = x2;

            if x2 > n {
                k2end += 2;
            } else if y2 > m {
                k2start += 2;
            } else if !front {
                let k1_offset = v_offset + delta - k2;
                if k1_offset >= 0 && (k1_offset as usize) < v_length && v1[k1_offset as usize] != -1
                {
                    let x1 = v1[k1_offset as usize];
                    let y1 = v_offset + x1 - k1_offset;
                    let x2_rev = n - x2;
                    if x1 >= x2_rev {
                        return Some((x1 as usize, y1 as usize));
                    }
                }
            }
            k2 += 2;
        }
    }
    None
}

fn rows_from_ops(ops: &[Op<'_>]) -> Vec<DiffRow> {
    let mut rows = Vec::with_capacity(ops.len());
    let mut old_line = 0u32;
    let mut new_line = 0u32;

    for op in ops {
        match *op {
            Op::Equal(text) => {
                old_line = old_line.saturating_add(1);
                new_line = new_line.saturating_add(1);
                rows.push(DiffRow {
                    kind: DiffKind::Context,
                    old_line: Some(old_line),
                    new_line: Some(new_line),
                    text: text.to_owned(),
                });
            }
            Op::Delete(text) => {
                old_line = old_line.saturating_add(1);
                rows.push(DiffRow {
                    kind: DiffKind::Removed,
                    old_line: Some(old_line),
                    new_line: None,
                    text: text.to_owned(),
                });
            }
            Op::Insert(text) => {
                new_line = new_line.saturating_add(1);
                rows.push(DiffRow {
                    kind: DiffKind::Added,
                    old_line: None,
                    new_line: Some(new_line),
                    text: text.to_owned(),
                });
            }
        }
    }
    rows
}

/// Keep the conventional display order inside a change block: removals before
/// additions. Line numbers were assigned per side already, so reordering does
/// not disturb them.
fn normalize_change_blocks(rows: &mut [DiffRow]) {
    let mut i = 0;
    while i < rows.len() {
        if rows[i].kind == DiffKind::Context {
            i += 1;
            continue;
        }
        let start = i;
        while i < rows.len() && rows[i].kind != DiffKind::Context {
            i += 1;
        }
        rows[start..i].sort_by_key(|row| match row.kind {
            DiffKind::Removed => 0,
            DiffKind::Added => 1,
            DiffKind::Context => 2,
        });
    }
}

/// Drop unchanged lines farther than `context` rows from a change. Multiple
/// changes merge into one window when the gap is at most `2 * context`, which
/// keeps every retained context row contiguous.
fn apply_context(rows: Vec<DiffRow>, context: usize) -> Vec<DiffRow> {
    if context == usize::MAX {
        return rows;
    }
    let changed: Vec<usize> = rows
        .iter()
        .enumerate()
        .filter_map(|(idx, row)| (row.kind != DiffKind::Context).then_some(idx))
        .collect();
    if changed.is_empty() {
        return rows;
    }

    let mut keep = vec![false; rows.len()];
    let merge_gap = context.saturating_mul(2);
    let mut i = 0;
    while i < changed.len() {
        let first = changed[i];
        let mut last = first;
        let mut j = i + 1;
        while j < changed.len() && changed[j].saturating_sub(last + 1) <= merge_gap {
            last = changed[j];
            j += 1;
        }
        let start = first.saturating_sub(context);
        let end = (last + 1 + context).min(rows.len());
        for flag in &mut keep[start..end] {
            *flag = true;
        }
        i = j;
    }

    rows.into_iter()
        .enumerate()
        .filter_map(|(idx, row)| keep[idx].then_some(row))
        .collect()
}

fn apply_max_rows(mut rows: Vec<DiffRow>, max_rows: Option<usize>) -> Vec<DiffRow> {
    let Some(max_rows) = max_rows else {
        return rows;
    };
    if rows.len() <= max_rows {
        return rows;
    }
    if max_rows == 0 {
        return Vec::new();
    }

    let kept = max_rows - 1;
    let omitted = rows.len() - kept;
    rows.truncate(kept);
    rows.push(DiffRow {
        kind: DiffKind::Context,
        old_line: None,
        new_line: None,
        text: format!("... ({omitted} rows omitted) ..."),
    });
    rows
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};

    fn reconstruct(rows: &[DiffRow]) -> (String, String) {
        let old: Vec<&str> = rows
            .iter()
            .filter(|row| row.kind != DiffKind::Added && !row.is_marker())
            .map(|row| row.text.as_str())
            .collect();
        let new: Vec<&str> = rows
            .iter()
            .filter(|row| row.kind != DiffKind::Removed && !row.is_marker())
            .map(|row| row.text.as_str())
            .collect();
        (old.join("\n"), new.join("\n"))
    }

    fn kinds(rows: &[DiffRow]) -> Vec<DiffKind> {
        rows.iter().map(|row| row.kind).collect()
    }

    #[test]
    fn identical_text_is_all_context() {
        let rows = diff_lines("a\nb\nc\n", "a\nb\nc");
        assert_eq!(rows.len(), 3);
        assert!(rows.iter().all(|row| row.kind == DiffKind::Context));
        assert_eq!(
            rows.iter().map(|row| row.old_line).collect::<Vec<_>>(),
            vec![Some(1), Some(2), Some(3)]
        );
        assert_eq!(
            rows.iter().map(|row| row.new_line).collect::<Vec<_>>(),
            vec![Some(1), Some(2), Some(3)]
        );
    }

    #[test]
    fn added_lines_get_new_numbers_only() {
        let rows = diff_lines("a\nc", "a\nb\nc");
        assert_eq!(
            kinds(&rows),
            vec![DiffKind::Context, DiffKind::Added, DiffKind::Context]
        );
        assert_eq!(rows[1].old_line, None);
        assert_eq!(rows[1].new_line, Some(2));
        assert_eq!(rows[1].text, "b");
        assert_eq!(rows[2].old_line, Some(2));
        assert_eq!(rows[2].new_line, Some(3));
        assert_eq!(reconstruct(&rows), ("a\nc".into(), "a\nb\nc".into()));
    }

    #[test]
    fn removed_lines_get_old_numbers_only() {
        let rows = diff_lines("a\nb\nc", "a\nc");
        assert_eq!(
            kinds(&rows),
            vec![DiffKind::Context, DiffKind::Removed, DiffKind::Context]
        );
        assert_eq!(rows[1].old_line, Some(2));
        assert_eq!(rows[1].new_line, None);
        assert_eq!(reconstruct(&rows), ("a\nb\nc".into(), "a\nc".into()));
    }

    #[test]
    fn modification_is_removal_then_addition() {
        let rows = diff_lines("let x = 1;\nlet y = 2;\n", "let x = 1;\nlet y = 3;\n");
        assert_eq!(
            kinds(&rows),
            vec![DiffKind::Context, DiffKind::Removed, DiffKind::Added]
        );
        assert_eq!(rows[1].text, "let y = 2;");
        assert_eq!(rows[2].text, "let y = 3;");
        assert_eq!(rows[1].old_line, Some(2));
        assert_eq!(rows[2].new_line, Some(2));
        assert_eq!(
            reconstruct(&rows),
            (
                "let x = 1;\nlet y = 2;".into(),
                "let x = 1;\nlet y = 3;".into()
            )
        );
    }

    #[test]
    fn reorder_produces_minimal_edits_and_round_trips() {
        let before = "a\nb\nc";
        let after = "c\nb\na";
        let rows = diff_lines(before, after);
        let (old, new) = reconstruct(&rows);
        assert_eq!(old, before);
        assert_eq!(new, after);
        let removed = rows.iter().filter(|r| r.kind == DiffKind::Removed).count();
        let added = rows.iter().filter(|r| r.kind == DiffKind::Added).count();
        // LCS is one line, so Myers needs 2 removals and 2 insertions.
        assert_eq!(removed, 2);
        assert_eq!(added, 2);
        assert!(rows.iter().any(|r| r.kind == DiffKind::Context));
    }

    #[test]
    fn crlf_and_lf_are_equivalent() {
        let rows = diff_lines("a\r\nb\r\nc\r\n", "a\nb\nc\n");
        assert_eq!(rows.len(), 3);
        assert!(rows.iter().all(|row| row.kind == DiffKind::Context));
        assert!(rows.iter().all(|row| !row.text.contains('\r')));
        assert_eq!(rows[2].text, "c");
    }

    #[test]
    fn empty_inputs() {
        assert!(diff_lines("", "").is_empty());

        let rows = diff_lines("", "a\nb");
        assert_eq!(kinds(&rows), vec![DiffKind::Added, DiffKind::Added]);
        assert_eq!(rows[0].new_line, Some(1));
        assert_eq!(rows[1].new_line, Some(2));

        let rows = diff_lines("a\nb", "");
        assert_eq!(kinds(&rows), vec![DiffKind::Removed, DiffKind::Removed]);
        assert_eq!(rows[0].old_line, Some(1));
        assert_eq!(rows[1].old_line, Some(2));
    }

    #[test]
    fn empty_lines_inside_the_file_are_preserved() {
        let rows = diff_lines("a\n\nb\n", "a\n\nc\n");
        let (old, new) = reconstruct(&rows);
        assert_eq!(old, "a\n\nb");
        assert_eq!(new, "a\n\nc");
        assert_eq!(rows[1].text, "");
        assert_eq!(rows[1].kind, DiffKind::Context);
    }

    #[test]
    fn distant_changes_use_context_windows() {
        let before: Vec<String> = (1..=20).map(|n| format!("line {n}")).collect();
        let mut after = before.clone();
        after[0] = "changed 1".into();
        after[19] = "changed 20".into();
        let rows = diff_lines(&before.join("\n"), &after.join("\n"));

        // Two hunks: 1..=4 and 17..=20 (each replacement contributes two rows).
        assert_eq!(rows.len(), 10);
        assert_eq!(rows.first().unwrap().old_line, Some(1));
        assert_eq!(rows.last().unwrap().new_line, Some(20));
        assert_eq!(rows.last().unwrap().text, "changed 20");
        assert!(!rows.iter().any(|row| row.text == "line 8"));
        assert!(rows.iter().any(|row| row.text == "line 4"));
        assert!(rows.iter().any(|row| row.text == "line 17"));
        let (old, new) = reconstruct(&rows);
        assert!(old.contains("line 1") && old.contains("line 20"));
        assert!(new.contains("changed 1") && new.contains("changed 20"));
    }

    #[test]
    fn near_changes_merge_into_one_window() {
        let before: Vec<String> = (1..=12).map(|n| format!("line {n}")).collect();
        let mut after = before.clone();
        after[4] = "changed 5".into();
        after[7] = "changed 8".into();
        let rows = diff_lines(&before.join("\n"), &after.join("\n"));
        // Gap between changes is 2 rows <= 2 * context, so one window 2..=11.
        assert_eq!(rows.len(), 12);
        assert_eq!(rows[0].old_line, Some(2));
        assert_eq!(rows.last().unwrap().old_line, Some(11));
    }

    #[test]
    fn context_zero_only_returns_changes() {
        let rows = diff_lines_with_options(
            "a\nb\nc",
            "a\nx\nc",
            DiffOptions {
                context: 0,
                max_rows: None,
            },
        );
        assert_eq!(kinds(&rows), vec![DiffKind::Removed, DiffKind::Added]);
    }

    #[test]
    fn max_rows_truncates_with_marker() {
        let before: Vec<String> = (1..=100).map(|n| format!("line {n}")).collect();
        let text = before.join("\n");
        let rows = diff_lines_with_options(
            &text,
            &text,
            DiffOptions {
                context: DEFAULT_CONTEXT,
                max_rows: Some(5),
            },
        );
        assert_eq!(rows.len(), 5);
        assert_eq!(
            kinds(&rows),
            vec![
                DiffKind::Context,
                DiffKind::Context,
                DiffKind::Context,
                DiffKind::Context,
                DiffKind::Context,
            ]
        );
        let marker = rows.last().unwrap();
        assert!(marker.is_marker());
        assert_eq!(marker.old_line, None);
        assert_eq!(marker.new_line, None);
        assert!(marker.text.contains("96 rows omitted"), "{}", marker.text);

        assert!(
            diff_lines_with_options(
                "a",
                "b",
                DiffOptions {
                    context: DEFAULT_CONTEXT,
                    max_rows: Some(0),
                },
            )
            .is_empty()
        );
    }

    #[test]
    fn max_rows_larger_than_output_is_a_noop() {
        let rows = diff_lines_with_options(
            "a\nb",
            "a\nc",
            DiffOptions {
                context: DEFAULT_CONTEXT,
                max_rows: Some(10),
            },
        );
        assert!(rows.iter().all(|row| !row.is_marker()));
    }

    #[test]
    fn repeated_lines_do_not_loop() {
        let before = "x\nx\nx\ny\nx\nx";
        let after = "x\nx\ny\nx\nx\nx";
        let rows = diff_lines(before, after);
        let (old, new) = reconstruct(&rows);
        assert_eq!(old, before);
        assert_eq!(new, after);
    }

    #[test]
    fn random_diffs_match_the_dp_minimal_edit_distance() {
        // Deterministic LCG so failures are reproducible.
        let mut state = 0x5eed_1234_abcd_9876u64;
        let mut next = || {
            state = state
                .wrapping_mul(6_364_136_223_846_793_005)
                .wrapping_add(1_442_695_040_888_963_407);
            (state >> 33) as usize
        };
        let alphabet = ["a", "b", "c", "d"];

        for case in 0..400 {
            let n = next() % 13;
            let m = next() % 13;
            let old: Vec<&str> = (0..n).map(|_| alphabet[next() % alphabet.len()]).collect();
            let new: Vec<&str> = (0..m).map(|_| alphabet[next() % alphabet.len()]).collect();
            let rows = diff_lines_with_options(
                &old.join("\n"),
                &new.join("\n"),
                DiffOptions {
                    context: usize::MAX,
                    max_rows: None,
                },
            );

            let (rebuilt_old, rebuilt_new) = reconstruct(&rows);
            if n == 0 {
                assert!(rebuilt_old.is_empty());
            } else {
                assert_eq!(
                    rebuilt_old,
                    old.join("\n"),
                    "case {case}: {old:?} -> {new:?}"
                );
            }
            if m == 0 {
                assert!(rebuilt_new.is_empty());
            } else {
                assert_eq!(
                    rebuilt_new,
                    new.join("\n"),
                    "case {case}: {old:?} -> {new:?}"
                );
            }

            // LCS dynamic program: the shortest edit script has
            // n + m - 2 * lcs rows.
            let mut lcs = vec![vec![0usize; m + 1]; n + 1];
            for i in (0..n).rev() {
                for j in (0..m).rev() {
                    lcs[i][j] = if old[i] == new[j] {
                        lcs[i + 1][j + 1] + 1
                    } else {
                        lcs[i + 1][j].max(lcs[i][j + 1])
                    };
                }
            }
            let expected = n + m - 2 * lcs[0][0];
            let actual = rows
                .iter()
                .filter(|row| row.kind != DiffKind::Context)
                .count();
            assert_eq!(actual, expected, "case {case}: {old:?} -> {new:?}");
        }
    }

    #[test]
    fn ten_thousand_line_diff_is_fast() {
        let before: Vec<String> = (0..10_000).map(|n| format!("row {n}")).collect();
        let mut after = before.clone();
        for idx in [10usize, 4_000, 9_000] {
            after[idx] = format!("edited {idx}");
        }
        after.insert(5_000, "inserted".into());

        let started = Instant::now();
        let rows = diff_lines_with_options(
            &before.join("\n"),
            &after.join("\n"),
            DiffOptions {
                context: usize::MAX,
                max_rows: None,
            },
        );
        let elapsed = started.elapsed();

        assert!(
            elapsed < Duration::from_secs(5),
            "10k-line diff took {elapsed:?}"
        );
        let (old, new) = reconstruct(&rows);
        assert_eq!(old, before.join("\n"));
        assert_eq!(new, after.join("\n"));

        // Oversized outputs are capped with a marker row (the unified view is
        // already narrowed to ~31 rows, so cap below that).
        let capped = diff_lines_with_options(
            &before.join("\n"),
            &after.join("\n"),
            DiffOptions {
                context: DEFAULT_CONTEXT,
                max_rows: Some(20),
            },
        );
        assert_eq!(capped.len(), 20);
        assert!(capped.last().unwrap().is_marker());
        assert!(capped.last().unwrap().text.contains("rows omitted"));

        // Unrelated 10k-line inputs must also stay linear-ish.
        let other: Vec<String> = (0..10_000).map(|n| format!("other {n}")).collect();
        let started = Instant::now();
        let disjoint = diff_lines(&before.join("\n"), &other.join("\n"));
        let elapsed = started.elapsed();
        assert!(
            elapsed < Duration::from_secs(5),
            "disjoint 10k-line diff took {elapsed:?}"
        );
        assert_eq!(
            disjoint
                .iter()
                .filter(|row| row.kind == DiffKind::Removed)
                .count(),
            10_000
        );
    }
}
