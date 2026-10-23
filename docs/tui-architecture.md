# cch-tui Architecture

The TUI is a Rust binary that renders the transcript and drives the TypeScript
engine over NDJSON. This document maps the crates, the data flow, and the rules
that keep the layers replaceable.

## Crate graph

```
                  proto        (wire types, no deps but serde)
                    ▲
        ┌───────────┼───────────────┐
        │           │               │
      ui        fullscreen       dialog ── keymap ── core
        │           │               │               │
        └──────► render ◄───────────┘               │
                    ▲                               │
                markdown / highlight / diff ────────┘
                    ▲
                   bin   (process, event loop, input)
```

Dependency rules:

- `core` has no terminal or protocol dependency: component identity, event
  router, `TextBuffer`.
- `proto` is data only; every message keeps a flattened `extra` map and unknown
  frames decode to `Unknown` so the engine can ship ahead of the TUI.
- `ui` turns events into logical rows; it never imports ratatui.
- `markdown`, `highlight`, `diff`, `dialog`, `fullscreen`, `keymap` are pure
  logic crates with their own tests.
- `render` is the only crate that depends on ratatui/crossterm.
- `bin` owns the process, the clock, and the event loop; it holds no rendering
  logic beyond choosing which `render` entry point to call.

## Data flow

```
engine (TS) --NDJSON stdout--> bin reader thread --mpsc--> event loop
                                                           │
                                     ui::ChatView::ingest ◄┘
                                                           │
             completed rows ──► inline: Terminal::insert_before (frozen)
                            └──► fullscreen: TranscriptModel (windowed)
                                                           │
                                          render::draw_view / draw_transcript
```

- Completed messages are frozen into terminal scrollback (inline mode) or kept
  in the windowed transcript model (fullscreen); only the live region is
  repainted.
- Stream deltas accumulate in `ChatView::live_text` and never touch the frozen
  transcript until the message completes.
- Permission requests become a `dialog::PermissionDialog`; the answer is sent
  back as a `control_response` keyed by `request_id`.

## State ownership

| Owner | State |
|---|---|
| Engine | messages, tool lifecycle, permissions, compaction, session, usage |
| `ChatView` | live text, prompt buffer mirror, status line |
| `TextBuffer` | prompt text, cursor, selection, undo, kill ring |
| `keymap` | context stack, pending chord, binding tables |
| `TranscriptModel` | row heights, scroll offset, follow/unseen |
| `dialog` | pending permission, queued prompts, interaction phase |

## Threading

- The engine reader runs on its own thread and only parses + forwards frames.
- The main loop polls crossterm with a 33 ms timeout, drains the channel, then
  redraws. Rendering never blocks the reader.
- Key resolution uses a logical clock (`clock_ms`) so chord timeouts are
  deterministic in tests.

## Testing

- Pure crates: unit tests (`cargo test --locked`).
- `render`: ratatui `TestBackend` snapshots for live region, transcript window,
  permission overlay, code blocks and diffs.
- `bin`: engine pipe tests with `cat`/`sh` (unix), PTY smoke tests under
  `crates/bin/tests/`.
- CI runs `cargo fmt --check`, `cargo clippy --locked --all-targets -D warnings`
  and `cargo test --locked` in the `rust` job, plus cross-builds in `native`.

## Extension points

- New engine frames: add a variant to `proto::EngineEvent` (or rely on
  `Unknown`) and fold it in `ChatView::ingest`.
- New key contexts: add a `BindingSpec` table in `keymap` and push the context;
  do not special-case keys in `bin`.
- New panes (tasks, agents): implement them as row producers feeding either
  `insert_rows` (inline) or a second `TranscriptModel` (fullscreen).


## In-process napi host (shipping)

The TUI ships **inside** the main package as a napi addon (`cch_tui`); there is
no separate executable or platform package to install.

```
Bun process (engine)
  └─ loadNativeModule('tui','tui')  →  cch_tui.node (memfd dlopen / vendor)
        ├─ start({fullscreen, theme, vim})
        ├─ send(<engine event JSON>)      every query/stream/system/result frame
        ├─ poll() -> TuiCommand JSON      prompt / permission / interrupt / exit
        └─ stop()
```

- `cch-tui-runner` owns the interactive loop and the terminal; `cch-tui-napi`
  only exposes channels (no terminal IO inside the FFI functions).
- The render thread is a plain `std::thread`; the host polls every ~20 ms.
- `cch-tui` remains a development binary (`--replay`, `--bench-replay`,
  `--check-tui`) and is not distributed.
- Missing/invalid addon or `is_supported() === false` (no TTY) falls back to the
  Ink UI behind `CCH_TUI_NATIVE=1`.
