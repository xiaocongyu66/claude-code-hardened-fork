# TUI ↔ Engine Protocol

The Rust TUI speaks the engine's existing SDK stream-json protocol. This
document records the exact shapes the TUI relies on, where they are produced,
and the few extensions we add.

## Process model

```
cch-tui (Rust, parent)
  └─ spawn: <bun|node> <cli entry> --print
             --input-format stream-json
             --output-format stream-json
             --include-partial-messages
             [--replay-user-messages]
```

- Transport: stdin/stdout, one JSON object per line (NDJSON). stderr is
  inherited for diagnostics.
- The engine process owns session state, tools, transcripts, MCP, and
  permissions. The TUI owns rendering, scroll position, input editing, and
  dialog focus.
- Closing the TUI's stdin is the shutdown signal; the TUI also kills the child
  on exit so a wedged engine cannot outlive it.

Reference implementation of the same pattern: `src/bridge/sessionRunner.ts`
(spawns the CLI with these flags and forwards `can_use_tool`).

## Frames (engine → TUI)

Shapes come from `src/entrypoints/sdk/coreSchemas.ts` and
`src/entrypoints/sdk/controlSchemas.ts`.

| `type` | Key fields | Notes |
|---|---|---|
| `system` | `subtype` (`init`, `status`, `compact_boundary`, `api_retry`, `task_started`, …) | `init` carries `session_id`, `model`, `tools`, `cwd` |
| `user` | `uuid`, `message` | Replayed or synthetic user turns |
| `assistant` | `uuid`, `message` | Complete message after streaming |
| `stream_event` | `uuid`, `event` | Raw `BetaRawMessageStreamEvent`; `content_block_delta` carries `text_delta` / `input_json_delta` |
| `result` | `subtype` (`success`/`error…`), `usage`, `total_cost_usd` | Ends a turn |
| `control_request` | `request_id`, `request` | See below |
| `control_response` | `response` | Engine acknowledging a TUI request |
| `control_cancel_request` | `request_id` | Withdraws a pending request |
| `keep_alive` | — | Ignored by the TUI |

Unknown `type` values must be ignored, never fatal — the engine ships faster
than the TUI.

## Control requests

### `can_use_tool` (engine → TUI)

```json
{"type":"control_request","request_id":"r1","request":{
  "subtype":"can_use_tool","tool_name":"Bash","tool_use_id":"toolu_1",
  "input":{"command":"ls"},"description":"Run ls",
  "permission_suggestions":[…],"blocked_path":"…","decision_reason":"…"}}
```

The TUI replies with a `control_response`:

```json
{"type":"control_response","response":{
  "subtype":"success","request_id":"r1",
  "response":{"behavior":"allow","updatedInput":{"command":"ls"}}}}
```
```json
{"type":"control_response","response":{
  "subtype":"success","request_id":"r1",
  "response":{"behavior":"deny","message":"Denied by user"}}}}
```

Rules:
- Exactly one terminal response per `request_id`, even if the user presses Esc
  and the engine cancels concurrently. First terminal wins; a late
  `control_cancel_request` is acknowledged and ignored.
- Unknown subtypes are answered with
  `{"subtype":"error","request_id":…,"error":"unsupported subtype"}`.

### Other subtypes implemented by the engine

`interrupt`, `set_permission_mode`, `get_context_usage`,
`set_model`, `end_session`, `get_settings`, `elicitation`.

## Commands (TUI → engine)

- Prompt: a stream-json user frame
  `{"type":"user","message":{"role":"user","content":[{"type":"text","text":"…"}]}}`.
- Permission decisions: `control_response` as above.
- Interrupt: `{"type":"control_request","request_id":"…","request":{"subtype":"interrupt"}}`.

## Backpressure and pacing

- `stream_event` is the highest-frequency frame (10–100/s). The engine should
  coalesce adjacent text deltas to ~16–33 ms buckets; the TUI must still accept
  unbatched deltas.
- The TUI never blocks the engine reader thread on rendering: frames go through
  an `mpsc` channel and are drained once per frame.
- Existing engine `stream.ts` buffers are unbounded; the engine host must add a
  bounded queue before this ships (tracked in the plan, M1).

## Deliberate gaps

- `get_context_usage` exists only in print mode today; if the interactive
  engine does not answer it, the TUI falls back to `assistant.usage` from the
  last message.
- Task lifecycle (`task_started`/`task_progress`/`task_notification`) is
  currently assembled from `AppState.tasks` in the Ink REPL; the engine host
  must emit these frames for the TUI task panel.
- Compaction boundaries are partially filtered by `QueryEngine`; the TUI shows
  what it receives and tolerates their absence.
