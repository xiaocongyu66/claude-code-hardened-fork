# cch-tui Performance & Memory Replay

This document covers the synthetic replay benchmark for the Rust TUI
(`packages/tui-native/native`). It covers the acceptance measurements for the
M1/M4 milestones: ingest/freeze cost, full-screen frame cost, and peak RSS.

The benchmark does not open a terminal. It feeds `ChatView` / `TranscriptModel`
the same way the interactive event loop does, so it runs on CI and headless
machines.

## How to run

```bash
cd packages/tui-native/native
export CARGO_TARGET_DIR=/root/cch-tui-target   # repo convention

# 10k synthetic events, core numbers only
cargo run --release --locked -p cch-tui-bin -- --bench-replay

# custom event count, plus per-window render percentiles
cargo run --release --locked -p cch-tui-bin -- --bench-replay 10000 --bench-rows

# custom viewport
cargo run --release --locked -p cch-tui-bin -- --bench-replay 10000 --bench-rows --width 120 --height 40

# the same budget checks as CI (debug profile, no TTY needed)
cargo test --locked -p cch-tui-bin   --test bench_replay   -- --nocapture
cargo test --locked -p cch-tui-render --test window_bench  -- --nocapture
```

The command prints one JSON object:

```json
{
  "ingest_ms": 63.179153,
  "peak_rss_kb": 33044,
  "project_ms": 4.347692,
  "render_lines_ms": 0.202846,
  "rows": 13329,
  "window_p50_ms": 0.018846,
  "window_p99_ms": 0.019615
}
```

`window_p50_ms` / `window_p99_ms` are present only with `--bench-rows`.

## Synthetic workload

`--bench-replay [n]` (default `n = 10000`) builds a deterministic stream that
starts with `system/init` and then repeats a 12-event turn:

| Events | Kind |
|---|---|
| 1–2 | `stream_event` text deltas |
| 3 | assistant prose |
| 4 | assistant text + `tool_use` |
| 5 | user `tool_result` — every 5th result is a ~32 KiB payload (20%) |
| 6 | `stream_event` delta |
| 7 | assistant prose |
| 8 | `result` |
| 9 | user follow-up |
| 10 | assistant Markdown with a fenced Rust code block |
| 0 / 11 | user prompt / delta, wrapping to the next turn |

Each returned batch follows the interactive path exactly:

```
ChatView::ingest -> actions::project -> freeze_fullscreen
                 -> TranscriptModel::append (with blank separator rows)
```

Projection and freeze are reported together as `project_ms`. Inline mode freezes
straight into terminal scrollback (`insert_before`), which requires a TTY, so
the benchmark measures the full-screen `TranscriptModel` path instead.

## Metrics

| Field | Meaning |
|---|---|
| `rows` | Logical rows retained in the transcript after freeze (includes inserted blank separators). |
| `ingest_ms` | Folding all events through `ChatView::ingest` (row construction, tool-call tracking, delta accumulation). Wall clock. |
| `project_ms` | `actions::project` plus `freeze_fullscreen` (spacing + `TranscriptModel::append`) for every batch. |
| `render_lines_ms` | One steady-state `transcript_lines` call at the final scroll offset (height cache already warm). |
| `peak_rss_kb` | `VmHWM` from `/proc/self/status`, in KiB. `null` on platforms without `/proc` (e.g. macOS/Windows). |
| `window_p50_ms` | Median `transcript_lines` call over 128 window renders at evenly spaced scroll offsets. |
| `window_p99_ms` | 99th percentile of the same samples. |

Percentiles use nearest-rank over sorted samples. The height cache is built by
a warm-up `window` call, so the sampled frames reflect steady-state scrolling,
not the one-off relayout after a width change.

## Baseline

Measured once on this workspace's development machine:

- Linux aarch64, 8 cores, rustc 1.99.1
- `--release`, `--bench-replay 10000 --bench-rows` (120×40)

| Metric | Value |
|---|---|
| rows | 13329 |
| ingest_ms | 63.2 ms |
| project_ms | 4.35 ms |
| render_lines_ms | 0.203 ms |
| window_p50_ms | 0.019 ms |
| window_p99_ms | 0.020 ms |
| peak_rss_kb | 33044 KiB (~32 MiB) |

Debug-profile guard run (`cargo test -- --nocapture`): ingest 32 ms,
single-frame render 0.63 ms, p99 window 0.19 ms, peak RSS ~32 MiB. Debug code is
faster here than the release baseline above only because of run-to-run and
allocator variance; treat the release numbers as the reference.

Peak RSS covers the whole process: the synthetic event buffer (including the
32 KiB payloads), `ChatView`'s retained rows, and the frozen transcript. The
benchmark drops the event buffer and `ChatView` before measuring render cost,
but `VmHWM` is a high-water mark and still includes them.

## CI budgets

The integration tests assert loose ceilings so shared CI runners do not flake:

- `crates/bin/tests/bench_replay.rs`: 10k-event ingest < 5 s; one window render
  < 50 ms; p99 window render < 50 ms; `VmHWM` readable on Linux.
- `crates/render/tests/window_bench.rs`: 10k-row transcript; p99
  `transcript_lines` < 50 ms.

Both tests print their measurements, so run them with `--nocapture` when
investigating a regression.
