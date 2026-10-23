//! Full-screen window render timing guard.
//!
//! Builds a 10k-row transcript (assistant prose with fenced code, tool results
//! and user prompts) and renders windows at evenly spaced scroll positions.
//! The budget is deliberately loose so shared CI runners do not flake; run with
//! `--nocapture` to see the p50/p99 numbers.

use std::time::{Duration, Instant};

use cch_tui_fullscreen::TranscriptModel;
use cch_tui_render::transcript_lines;
use cch_tui_theme::Theme;
use cch_tui_ui::{Row, RowStyle};

const ROWS: usize = 10_000;
const WIDTH: usize = 120;
const HEIGHT: usize = 40;
const SAMPLES: usize = 100;
const FRAME_BUDGET: Duration = Duration::from_millis(50);

fn transcript_rows() -> Vec<Row> {
    (0..ROWS)
        .map(|index| match index % 4 {
            0 => Row::new(
                RowStyle::Assistant,
                format!(
                    "## Result {index}\n\nAll checks pass.\n\n```rust\nfn check_{index}() -> bool {{\n    true\n}}\n```\n"
                ),
            ),
            1 => Row::new(
                RowStyle::ToolResult,
                format!(
                    "result {index}: a fairly long tool payload that wraps across the viewport"
                ),
            ),
            2 => Row::new(RowStyle::User, format!("user prompt number {index}")),
            _ => Row::new(
                RowStyle::Assistant,
                format!("short prose for turn {index} with a [link](https://example.com)"),
            ),
        })
        .collect()
}

fn percentile(sorted: &[Duration], percent: f64) -> Duration {
    let rank = ((percent / 100.0) * sorted.len() as f64).ceil() as usize;
    sorted[rank.saturating_sub(1).min(sorted.len() - 1)]
}

#[test]
fn fullscreen_window_render_stays_under_budget() {
    let mut model = TranscriptModel::new();
    model.set_rows(transcript_rows());
    let theme = Theme::dark();

    // First window builds the height cache; the samples measure steady state.
    let _ = model.window(HEIGHT, WIDTH);
    let total = model.total_height();
    let steps = SAMPLES - 1;
    let mut samples = Vec::with_capacity(SAMPLES);
    for step in 0..SAMPLES {
        let target = step * total.saturating_sub(1) / steps;
        let delta = target as isize - model.offset() as isize;
        model.scroll_by(delta);
        let started = Instant::now();
        let lines = transcript_lines(&mut model, HEIGHT, WIDTH, &theme);
        samples.push(started.elapsed());
        std::hint::black_box(&lines);
    }
    samples.sort_unstable();
    let p50 = percentile(&samples, 50.0);
    let p99 = percentile(&samples, 99.0);

    println!(
        "window-render rows={ROWS} total_lines={total} p50={:.3} ms p99={:.3} ms",
        p50.as_secs_f64() * 1000.0,
        p99.as_secs_f64() * 1000.0,
    );

    assert!(total > 0, "the transcript has no display lines");
    assert!(
        p99 < FRAME_BUDGET,
        "p99 window render took {:.3} ms (budget {} ms)",
        p99.as_secs_f64() * 1000.0,
        FRAME_BUDGET.as_millis(),
    );
}
