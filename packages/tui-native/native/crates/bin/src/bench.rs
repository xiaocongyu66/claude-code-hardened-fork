//! Synthetic replay benchmark for the transcript pipeline.
//!
//! This drives the same stages the interactive loop runs for every engine
//! frame: `ChatView::ingest` -> `project` -> freeze (blank-line spacing +
//! `TranscriptModel::append`) -> `transcript_lines` for one full-screen
//! window. No terminal is opened, so it runs in CI and on headless machines.
//!
//! The generator is deterministic: the same event count always produces the
//! same transcript, which keeps the reported numbers comparable across runs.

use std::time::{Duration, Instant};

use cch_tui_actions::{ExpandLimits, ExpandState, project};
use cch_tui_fullscreen::TranscriptModel;
use cch_tui_proto::EngineEvent;
use cch_tui_render::transcript_lines;
use cch_tui_theme::Theme;
use cch_tui_ui::ChatView;
use serde_json::{Value, json};

/// Bytes of payload for the large tool results (20% of all tool results).
const LARGE_TOOL_RESULT_BYTES: usize = 32 * 1024;

/// Events per synthetic conversation turn. Each turn contains user and
/// assistant prose, a streaming delta, a tool call with its result, and a
/// result frame.
const CYCLE: usize = 12;

/// How to run the benchmark.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BenchOptions {
    /// Number of synthetic transcript events to replay.
    pub events: usize,
    /// Also measure repeated `transcript_lines` window renders (p50/p99).
    pub rows: bool,
    /// Layout width in terminal columns.
    pub width: usize,
    /// Viewport height in display lines.
    pub height: usize,
    /// Window renders sampled when `rows` is enabled.
    pub window_iterations: usize,
}

impl Default for BenchOptions {
    fn default() -> Self {
        Self {
            events: 10_000,
            rows: false,
            width: 120,
            height: 40,
            window_iterations: 128,
        }
    }
}

/// Timing and memory numbers for one replay.
#[derive(Debug, Clone, PartialEq)]
pub struct BenchReport {
    /// Logical rows retained in the full-screen transcript model.
    pub rows: usize,
    /// Folding every event through `ChatView::ingest`.
    pub ingest_ms: f64,
    /// Projection plus freeze (spacing and `TranscriptModel::append`).
    pub project_ms: f64,
    /// One steady-state `transcript_lines` call at the final scroll position.
    pub render_lines_ms: f64,
    /// Peak resident set size from `/proc/self/status` (`VmHWM`), when available.
    pub peak_rss_kb: Option<u64>,
    /// Median of repeated window renders; requires [`BenchOptions::rows`].
    pub window_p50_ms: Option<f64>,
    /// 99th percentile of repeated window renders; requires [`BenchOptions::rows`].
    pub window_p99_ms: Option<f64>,
}

impl BenchReport {
    /// Render the report as JSON, matching the documented benchmark contract.
    pub fn to_json(&self) -> String {
        let mut map = serde_json::Map::new();
        map.insert("rows".into(), json!(self.rows));
        map.insert("ingest_ms".into(), json!(self.ingest_ms));
        map.insert("project_ms".into(), json!(self.project_ms));
        map.insert("render_lines_ms".into(), json!(self.render_lines_ms));
        map.insert("peak_rss_kb".into(), json!(self.peak_rss_kb));
        if let Some(p50) = self.window_p50_ms {
            map.insert("window_p50_ms".into(), json!(p50));
        }
        if let Some(p99) = self.window_p99_ms {
            map.insert("window_p99_ms".into(), json!(p99));
        }
        serde_json::to_string_pretty(&Value::Object(map))
            .expect("benchmark report is always serializable")
    }
}

/// Replay `options.events` synthetic frames through the production pipeline.
pub fn run(options: &BenchOptions) -> BenchReport {
    let events = synthetic_events(options.events);
    let mut view = ChatView::new();

    // The interactive loop ingests one event and freezes the rows it returns.
    // Keep the batches so projection and freeze can be timed separately.
    let mut batches: Vec<Vec<cch_tui_ui::Row>> = Vec::with_capacity(events.len());
    let started = Instant::now();
    for event in &events {
        batches.push(view.ingest(event));
    }
    let ingest = started.elapsed();
    // `ChatView` keeps its own copy of every row; drop both before rendering so
    // the memory footprint measured afterwards reflects the transcript only.
    drop(view);
    drop(events);

    let mut transcript = TranscriptModel::new();
    let expand = ExpandState::default();
    let limits = ExpandLimits::default();
    let started = Instant::now();
    for batch in &batches {
        let projected = project(batch, &expand, limits);
        crate::freeze_fullscreen(&mut transcript, &projected);
    }
    let project_time = started.elapsed();
    drop(batches);

    let width = options.width.max(1);
    let height = options.height.max(1);
    let theme = Theme::dark();

    // The first window builds the height cache and the highlighter loads its
    // grammars; both are one-time start-up costs, so warm them outside the
    // timed region and report the steady-state frame cost.
    cch_tui_render::warm_up();
    let _ = transcript.window(height, width);
    // Paint the window once to populate the height layout and the highlight
    // span cache; the reported number is the steady-state frame cost.
    let _ = transcript_lines(&mut transcript, height, width, &theme);
    let started = Instant::now();
    let lines = transcript_lines(&mut transcript, height, width, &theme);
    let render = started.elapsed();
    std::hint::black_box(&lines);

    let (window_p50_ms, window_p99_ms) = if options.rows {
        let samples = window_samples(
            &mut transcript,
            height,
            width,
            &theme,
            options.window_iterations.max(1),
        );
        let p50 = percentile(&samples, 50.0);
        let p99 = percentile(&samples, 99.0);
        (Some(millis(p50)), Some(millis(p99)))
    } else {
        (None, None)
    };

    BenchReport {
        rows: transcript.len(),
        ingest_ms: millis(ingest),
        project_ms: millis(project_time),
        render_lines_ms: millis(render),
        peak_rss_kb: peak_rss_kb(),
        window_p50_ms,
        window_p99_ms,
    }
}

/// Render a series of windows at evenly spaced scroll offsets and return the
/// time each `transcript_lines` call took.
fn window_samples(
    transcript: &mut TranscriptModel,
    height: usize,
    width: usize,
    theme: &Theme,
    iterations: usize,
) -> Vec<Duration> {
    let total = transcript.total_height();
    let span = total.saturating_sub(1);
    let steps = iterations.saturating_sub(1).max(1);
    // Walk from the oldest to the newest line, like a user paging through the
    // transcript. Scrolling happens outside the timed region.
    let targets: Vec<usize> = (0..iterations).map(|step| step * span / steps).collect();
    // Warm pass: parse and highlight every window once so the samples measure
    // the steady-state frame cost (cold syntax grammars are unhurried).
    for &target in &targets {
        let delta = target as isize - transcript.offset() as isize;
        transcript.scroll_by(delta);
        let _ = transcript_lines(transcript, height, width, theme);
    }
    let mut samples = Vec::with_capacity(iterations);
    for &target in &targets {
        let delta = target as isize - transcript.offset() as isize;
        transcript.scroll_by(delta);
        let started = Instant::now();
        let lines = transcript_lines(transcript, height, width, theme);
        samples.push(started.elapsed());
        std::hint::black_box(&lines);
    }
    transcript.follow_tail();
    samples
}

/// Nearest-rank percentile over sorted samples (`percent` in `0..=100`).
fn percentile(sorted: &[Duration], percent: f64) -> Duration {
    if sorted.is_empty() {
        return Duration::ZERO;
    }
    let rank = ((percent / 100.0) * sorted.len() as f64).ceil() as usize;
    let index = rank.saturating_sub(1).min(sorted.len() - 1);
    sorted[index]
}

fn millis(duration: Duration) -> f64 {
    duration.as_secs_f64() * 1000.0
}

/// Peak resident set size (`VmHWM`) in KiB. `/proc` only exists on Linux; all
/// other platforms report `null` in the JSON output.
pub fn peak_rss_kb() -> Option<u64> {
    let status = std::fs::read_to_string("/proc/self/status").ok()?;
    status.lines().find_map(|line| {
        line.strip_prefix("VmHWM:")
            .and_then(|rest| rest.split_whitespace().next())
            .and_then(|value| value.parse().ok())
    })
}

/// Build `count` deterministic transcript frames covering every event kind the
/// TUI renders. The first frame is the `system/init` the engine always sends.
fn synthetic_events(count: usize) -> Vec<EngineEvent> {
    let mut events = Vec::with_capacity(count);
    if count == 0 {
        return events;
    }
    events.push(frame(json!({
        "type": "system",
        "subtype": "init",
        "session_id": "bench-session",
        "model": "bench-model",
    })));

    for index in 1..count {
        let step = index % CYCLE;
        let cycle = index / CYCLE;
        let value = match step {
            0 => json!({
                "type": "user",
                "uuid": format!("user-{index}"),
                "message": {
                    "role": "user",
                    "content": format!(
                        "request {index}: analyze the failing test in module {cycle} and fix it"
                    ),
                },
            }),
            1 | 2 | 11 => delta(index),
            3 => assistant_text(
                index,
                format!("Found the failing assertion in module {cycle}."),
            ),
            4 => json!({
                "type": "assistant",
                "uuid": format!("assistant-{index}"),
                "message": {
                    "role": "assistant",
                    "content": [
                        {"type": "text", "text": format!("Running the checks for module {cycle}.")},
                        {
                            "type": "tool_use",
                            "id": format!("tool-{index}"),
                            "name": "Bash",
                            "input": {"command": format!("cargo test -p module{cycle}")},
                        },
                    ],
                },
            }),
            5 => {
                // Every fifth tool result is a 32 KiB payload (20% of them).
                let large = cycle.is_multiple_of(5);
                json!({
                    "type": "user",
                    "uuid": format!("result-{index}"),
                    "message": {
                        "role": "user",
                        "content": [{
                            "type": "tool_result",
                            "tool_use_id": format!("tool-{}", index - 1),
                            "content": tool_result_content(large, cycle),
                        }],
                    },
                })
            }
            6 => delta(index),
            7 => assistant_text(index, format!("All checks pass for module {cycle}.")),
            8 => json!({
                "type": "result",
                "subtype": "success",
                "duration_ms": 12,
                "num_turns": 1,
            }),
            9 => json!({
                "type": "user",
                "uuid": format!("user-{index}"),
                "message": {
                    "role": "user",
                    "content": format!("thanks, continue with the next item after {index}"),
                },
            }),
            10 => assistant_text(
                index,
                format!(
                    "## Result {cycle}\n\nAll checks pass.\n\n```rust\nfn check_{cycle}() -> bool {{\n    true\n}}\n```\n"
                ),
            ),
            _ => unreachable!("step {step} is outside the cycle"),
        };
        events.push(frame(value));
    }
    events
}

fn frame(value: Value) -> EngineEvent {
    serde_json::from_value(value).expect("synthetic frame matches EngineEvent")
}

fn delta(index: usize) -> Value {
    json!({
        "type": "stream_event",
        "uuid": format!("delta-{index}"),
        "event": {
            "type": "content_block_delta",
            "delta": {"type": "text_delta", "text": format!("working {index} ")},
        },
    })
}

fn assistant_text(index: usize, text: String) -> Value {
    json!({
        "type": "assistant",
        "uuid": format!("assistant-{index}"),
        "message": {
            "role": "assistant",
            "content": [{"type": "text", "text": text}],
        },
    })
}

fn tool_result_content(large: bool, cycle: usize) -> String {
    if !large {
        return format!("ok {cycle}\nline two\nline three");
    }
    let mut text = String::with_capacity(LARGE_TOOL_RESULT_BYTES + 64);
    let mut line = 0usize;
    while text.len() < LARGE_TOOL_RESULT_BYTES {
        text.push_str(&format!(
            "{line:06} lorem ipsum dolor sit amet, consectetur adipiscing elit\n"
        ));
        line += 1;
    }
    text
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn synthetic_replay_covers_every_event_kind() {
        let events = synthetic_events(64);
        assert_eq!(events.len(), 64);
        assert!(matches!(&events[0], EngineEvent::System { subtype, .. } if subtype == "init"));

        let kinds: Vec<&str> = events.iter().map(EngineEvent::kind).collect();
        for kind in ["system", "user", "assistant", "stream_event", "result"] {
            assert!(kinds.contains(&kind), "missing {kind} in {kinds:?}");
        }
    }

    #[test]
    fn a_fifth_of_tool_results_are_large() {
        let events = synthetic_events(120);
        let mut results = 0usize;
        let mut large = 0usize;
        for event in &events {
            let EngineEvent::User { extra } = event else {
                continue;
            };
            let Some(blocks) = extra
                .get("message")
                .and_then(|message| message.get("content"))
                .and_then(Value::as_array)
            else {
                continue;
            };
            let Some(content) = blocks
                .first()
                .filter(|block| block.get("type").and_then(Value::as_str) == Some("tool_result"))
                .and_then(|block| block.get("content"))
                .and_then(Value::as_str)
            else {
                continue;
            };
            results += 1;
            if content.len() >= LARGE_TOOL_RESULT_BYTES {
                large += 1;
            }
        }
        assert!(results > 0);
        assert_eq!(
            large,
            results.div_ceil(5),
            "{large} of {results} were large"
        );
    }

    #[test]
    fn benchmark_is_deterministic() {
        let options = BenchOptions {
            events: 240,
            rows: true,
            window_iterations: 8,
            ..BenchOptions::default()
        };
        let first = run(&options);
        let second = run(&options);
        assert_eq!(first.rows, second.rows);
        assert!(first.rows > 0);
        assert!(first.window_p50_ms.is_some());
        assert!(first.window_p99_ms.is_some());
    }

    #[test]
    fn report_serializes_the_documented_fields() {
        let report = BenchReport {
            rows: 7,
            ingest_ms: 1.5,
            project_ms: 0.5,
            render_lines_ms: 0.25,
            peak_rss_kb: None,
            window_p50_ms: Some(0.1),
            window_p99_ms: Some(0.2),
        };
        let value: Value = serde_json::from_str(&report.to_json()).expect("valid JSON");
        assert_eq!(value["rows"], 7);
        assert_eq!(value["peak_rss_kb"], Value::Null);
        assert_eq!(value["window_p50_ms"], 0.1);
    }
}
