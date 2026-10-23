//! Timing guard for the synthetic replay benchmark.
//!
//! These numbers are intentionally loose: they catch pathological regressions
//! (quadratic ingests, a frame that suddenly takes seconds) without making CI
//! flaky on shared runners. Run with `--nocapture` to see the measurements.

use cch_tui_bin::bench::{BenchOptions, run};

/// A 10k-event replay must fold through ingest well under five seconds even in
/// an unoptimised `cargo test` build.
const INGEST_BUDGET_MS: f64 = 5_000.0;
/// A full-screen frame is a few dozen wrapped rows; 50 ms is a generous ceiling.
const FRAME_BUDGET_MS: f64 = 50.0;

#[test]
fn synthetic_replay_10k_stays_within_budget() {
    let options = BenchOptions {
        events: 10_000,
        rows: true,
        ..BenchOptions::default()
    };
    let report = run(&options);

    println!(
        "bench-replay rows={} ingest_ms={:.2} project_ms={:.2} render_lines_ms={:.3} \
         window_p50_ms={:.3} window_p99_ms={:.3} peak_rss_kb={:?}",
        report.rows,
        report.ingest_ms,
        report.project_ms,
        report.render_lines_ms,
        report.window_p50_ms.unwrap_or_default(),
        report.window_p99_ms.unwrap_or_default(),
        report.peak_rss_kb,
    );

    assert!(report.rows > 0, "the replay produced no transcript rows");
    assert!(
        report.ingest_ms < INGEST_BUDGET_MS,
        "10k-event ingest took {:.1} ms (budget {INGEST_BUDGET_MS} ms)",
        report.ingest_ms,
    );
    assert!(
        report.render_lines_ms < FRAME_BUDGET_MS,
        "a single window render took {:.3} ms (budget {FRAME_BUDGET_MS} ms)",
        report.render_lines_ms,
    );
    let p99 = report
        .window_p99_ms
        .expect("rows mode records window percentiles");
    assert!(
        p99 < FRAME_BUDGET_MS,
        "p99 window render took {p99:.3} ms (budget {FRAME_BUDGET_MS} ms)",
    );

    #[cfg(target_os = "linux")]
    assert!(
        report.peak_rss_kb.is_some(),
        "VmHWM should be readable on Linux"
    );
}
