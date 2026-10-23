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

## Resolved gaps (print / stream-json engine)

- `get_context_usage` is a first-class `control_request` in print mode
  (`src/cli/print.ts`). The success response contains `context_tokens`,
  `window_tokens`, and `percent` alongside the full `/context` breakdown.
  The summary aliases `totalTokens` / `rawMaxTokens` / `percentage`, so no
  extra scan is performed. The TUI may still fall back to the last
  `assistant.usage` if the request errors.
- Task lifecycle frames (`task_started` / `task_progress` /
  `task_notification`) are emitted from the existing task framework through
  `src/utils/sdkEventQueue.ts`. At drain time each frame is enriched
  read-only from the task registry with `task_id`, `task_type`,
  `description`, `status`, optional `output` (output file path), and optional
  `summary`. The Ink REPL continues to use `AppState.tasks`; the wire frames
  are a projection of the same state.
- `compact_boundary` and the task frames bypass the streamlined transformer
  (`isTuiPassthroughSystemMessage` in `src/cli/print.ts`), so they are always
  emitted on the stream-json path. The TUI still tolerates their absence for
  older engines/sessions.

## E2E test

`tests/integration/tui-engine-e2e.test.ts` exercises the process model above
without the real API:

- `scripts/mock-anthropic-server.ts` is a local HTTP server that answers
  `POST /v1/messages` with a minimal SSE stream: `message_start`,
  `content_block_start` (text), text deltas, `content_block_stop`,
  `message_delta` (`stop_reason: "end_turn"` + usage), and `message_stop`.
  Request bodies are drained but not validated. Run it standalone with
  `bun scripts/mock-anthropic-server.ts`; it listens on a random port, prints
  `READY <port>`, and exits on SIGTERM/SIGINT.
- The test imports the server in-process, spawns
  `bun src/entrypoints/cli.tsx --print --input-format stream-json
  --output-format stream-json --include-partial-messages --verbose`, writes one
  user frame to stdin, and asserts the stdout NDJSON contains `system:init`
  (with `session_id`/`model`), `assistant` (whose text contains the mock
  reply), and `result` (`subtype: "success"`), in that order, plus at least one
  `stream_event`. It runs in a temp cwd/config dir and sets
  `ANTHROPIC_BASE_URL=http://127.0.0.1:<port>`, `ANTHROPIC_API_KEY=test`, and
  `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`. `--verbose` is required for
  stream-json output (`src/cli/print.ts`). No trust flag is needed: `-p` skips
  the trust dialog and the mocked turn is text-only, so no tool permission
  prompt can fire.
- Timeout is 30s for the turn; on failure the test dumps every frame read so
  far and the CLI's stderr.

Run locally:

```bash
bun install
bun test tests/integration/tui-engine-e2e.test.ts
```

The CI `quality` job runs the same command as a non-blocking step with
`TUI_E2E=1`. The earlier full-suite sweep runs with `CI=true`, where the test
skips itself so an engine flake cannot gate packaging; the dedicated step is
the only CI place it runs.
