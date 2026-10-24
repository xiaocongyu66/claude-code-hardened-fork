# Ink → Rust TUI Parity Tracker

Living checklist of Ink behaviours and where the native TUI stands. Update it
when a feature lands; keep the "Ink reference" column so the port can be
verified against the original component.

Legend: ✅ done · 🟡 partial · ⬜ not started · ⛔ intentionally deferred

## Default renderer (M5)

The Rust napi TUI is now the **default** renderer for local interactive
sessions. Selection is `--tui <auto|native|ink>` with precedence
`--tui` > `CCH_TUI` > legacy `CCH_TUI_NATIVE` > `auto`:

- `auto` (default) — runs the native TUI when stdin/stdout are TTYs, the
  session is local (no remote/SSH/direct-connect), and the `cch_tui` addon
  loads; otherwise renders Ink.
- `native` — same gates, but logs a one-line stderr reason when it has to
  fall back.
- `ink` — always renders Ink.

Ink is therefore reachable only explicitly (`--tui=ink`, `CCH_TUI=ink` or
`CCH_TUI_NATIVE=0`). It stays in the tree on purpose: the component deletion
lands in a separate commit after the default flip bakes in CI.

| Area | Ink reference | Rust TUI | Notes |
|---|---|---|---|
| Transcript rendering | `components/Messages.tsx`, `MessageRow.tsx` | ✅ `crates/ui` | text, tool calls/results, errors, compact boundary, system breadcrumbs (hooks, `api_retry`, rate limits, task notifications) |
| Streaming text | `REPL.tsx` (`streamingText`) | ✅ `ChatView::live_text` | deltas never touch frozen rows |
| Inline scrollback freeze | `ScrollBox` + `shouldRenderStatically` | ✅ `TerminalSession::insert_rows` | frozen via `insert_before` |
| Fullscreen virtual list | `useVirtualScroll.ts` | ✅ `crates/fullscreen` | window, follow/unseen |
| Markdown | `Markdown.tsx` | ✅ `crates/markdown` | headings/lists/quotes/code/tables/links |
| Code highlighting | `HighlightedCode.tsx` | ✅ `crates/highlight` | syntect, byte-budget LRU |
| Diffs | `StructuredDiff.tsx`, `FileEditToolDiff.tsx` | ✅ | Edit `structuredPatch` renders as +/-/context rows |
| Permission dialog | `permissions/PermissionRequest.tsx` | ✅ `crates/dialog` + overlay | allow/deny, suggestions, cancel |
| Prompt editing | `PromptInput.tsx` | ✅ `TextBuffer` + `keymap` | multi-line, undo, kill ring, chords |
| Paste folding | `PromptInput.tsx` (~1399) | ✅ `TextBuffer::insert_paste` | >800 chars or >2 newlines |
| History search | `HistorySearchDialog.tsx` | ✅ `crates/core::HistorySearch` + overlay | query line, numbered hits with highlighted matches, reverse-video selection; `Ctrl+R` cycles session → project → global (project/global read from `history.jsonl`, honouring `CLAUDE_CONFIG_DIR`); Enter/Tab inserts, Esc closes, status keeps `search[scope] q (i/n)` |
| Vim mode | `PromptInput.tsx` (~2456) | ✅ `crates/core::vim` | env `CCH_TUI_VIM=1` |
| Message actions | `messageActions.tsx` | ✅ focus/copy/expand | `Alt+Up/Down` focus (`msg i/n`), `Ctrl+Y`/`Alt+C` copy, `Ctrl+O` toggles the focused block, `Esc` clears; rewind awaits an engine op |
| Tool output expand | `CtrlOToExpand.tsx` | ✅ fullscreen | per-message `Ctrl+O`; 3-line collapse; inline is frozen |
| Task / agent panel | `TaskListV2.tsx`, `components/tasks/*` | ✅ `crates/panel` | status line + fullscreen sidebar |
| Spinner / activity | `Spinner.tsx` | ✅ status line | frame advances while a turn runs |
| Plan mode | `ExitPlanModePermissionRequest/*` | ✅ | `Ready to code?` + plan body. Rows map to engine responses: auto-accept edits (`allow` + `setMode/acceptEdits` suggestion), manual approve (plain `allow`), keep planning (`deny` with the plan message). `Esc` sends one deny and restores the phase; engine `control_cancel_request` only closes the matching request, and late confirms are rejected. Ink's `Ctrl+G` ($EDITOR) plan-edit path is not wired: `can_use_tool` only carries allow/deny, so the native dialog offers the three decision rows |
| Queued input display | `REPL.tsx` prompt queue | ✅ status line | `queued N`; prompts flush on `result` |
| Sticky prompt | `VirtualMessageList.tsx` | ✅ fullscreen | `set_sticky_prompt` + `↓ N new` pill |
| Transcript search | `REPL.tsx` (`TranscriptSearchBar`) | ✅ `crates/search` + overlay | `Ctrl+F` opens a centered modal; Enter jumps, `n`/`N` (after Enter) and `Ctrl+N`/`Ctrl+P` cycle, Esc closes; query hits highlighted and the current hit reverse-selected; inline mode keeps `match i/n` on the status line |
| Global workspace search | `GlobalSearchDialog.tsx` | ⬜ | no workspace file-content channel in the native TUI; needs the engine-side `search-napi` exposed as an RPC before a dialog can be wired |
| @file completion | `fileSuggestions.ts` | ⬜ | blocked on protocol: `system/init` carries only `slash_commands` (no file list) and the engine-side `file-index` lives in the TS process. A picker needs an init/control channel that ships indexed paths (or an `@` query RPC); none added |
| Slash palette | slash command menu | ✅ `crates/palette` + overlay | auto-opens for `/`-prefixed input; prefix then substring filter, hidden commands excluded; Up/Down select, Tab/Enter accept (inserts `/name <argumentHint>`), Esc dismisses; init `slash_commands` names (or metadata objects) populate it |
| Copy to clipboard | OSC52 / platform tools | ✅ | `Ctrl+Y`/`Alt+C` copy the focused message, or the newest assistant reply when unfocused. Transports: OSC52 over SSH (then platform programs), otherwise `pbcopy` / `wl-copy` / `xclip` / `xsel` / `clip` first with OSC52 fallback; failures are silent (`crates/render/src/clipboard.rs`) |
| Image paste | `imagePaste.ts`, `useClipboardImageHint` | ⛔ | no terminal image protocol; needs a clipboard image path |
| Diff dialog | `diff/DiffDialog.tsx` | ✅ `/diff` (Edit/Write patches) | Trigger: submit `/diff` (the official command entrypoint; `Ctrl+D` remains exit). Opens a full-screen bordered dialog for the focused message's Edit/Write tool result, or the newest patch when nothing is focused: file header with `+N/-M`, `@@` hunk headers, line-number gutter, `+`/`-`/context rows using the `diffAdded`/`diffRemoved` backgrounds. `↑/↓` scroll one line, `PgUp`/`PgDn` page, `Home`/`End` jump, Esc closes; the viewport is re-clamped on resize. Data comes only from `tool_use_result.structuredPatch` in engine frames — repository/working-tree and multi-file diffs remain out of scope until a host git/command channel exists, and `/diff <arg>` ignores its argument |
| Settings/theme command | `Config.tsx` | 🟡 env `CCH_TUI_THEME` | `/theme` command later |
| Trust / onboarding | `TrustDialog`, onboarding | ⛔ | engine owns trust; TUI starts after it |
| Export / feedback | `ExportDialog`, `Feedback` | ⛔ | out of scope for the native TUI |
| Legacy conhost | `legacyConsole.ts` | ✅ `crates/render/src/legacy.rs` | Windows build < 17763 auto-enables: one column narrower plus a full clear+repaint every 1000 ms. Env parity: `CCH_LEGACY_CONSOLE=0/1/2|always` (and the `CLAUDE_CODE_*` compat names), `..._RESET_MS` clamped to [100, 10000]. Non-Windows auto is off; pure logic has unit tests (`cmd /c ver` build detection is Windows-only) |

## Rules for porting

1. Model first (`crates/*`, pure logic + tests), rendering second, key wiring
   last. Wiring without a model turns into untestable `bin` code.
2. Every ported behaviour gets a test in its crate; `bin` keeps only glue.
3. If Ink's behaviour depends on React/Yoga (measured heights, memoization),
   implement the intent, not the mechanism, and note the difference here.
4. Update this table in the same commit that lands the feature.

## Fidelity audit (visual constants)

Verified against the Ink app; each row names the source of truth.

| Element | Source | Rust | Status |
|---|---|---|---|
| Prompt glyph | `figures.pointer` (`PromptInputModeIndicator.tsx:57`) | `❯ ` in `draw_prompt` | ✅ |
| Message bullet | `BLACK_CIRCLE` = `⏺` (darwin) / `●` (`figures.ts:12`) | `message_bullet()` | ✅ |
| Assistant prefix | `AssistantTextMessage.tsx:190-196` (bullet column, width 2) | first line `⏺ `, rest 2 spaces | ✅ |
| Tool call label | `AssistantToolUseMessage.tsx:137-160` (`⏺ ` + bold name + `(input)`) | `⏺ ` + bold name + `(summary)` spans | ✅ per-tool summaries (`ui::tool_call_summary`): Bash/PowerShell command, Read/Edit/Write path, Glob/Grep `pattern: "..."` (+ path), WebFetch/WebSearch URL/query, Agent description; unknown tools fall back to the compact JSON, truncated to 80 chars |
| Tool bullet colour | `ToolUseLoader.tsx:16` (success / error / dim while unresolved) | `ToolCallPending/ToolCall/ToolCallError` | ✅ |
| Tool result gutter | `MessageResponse.tsx:20-25` (`  ⎿  ` dim, 5-col) | `  ⎿  ` + 5-space continuation | ✅ |
| User prompt block | `UserPromptMessage.tsx:72-84`, `userMessageBackground` | full-width bg, 1 col right padding | ✅ |
| Streaming text | `Messages.tsx:921-933` (bullet + StreamingMarkdown, marginTop 1) | bullet + markdown + tail window | ✅ |
| Spinner | `Spinner.tsx:42-44,537` (`·✢✱✶✻✽` + reverse, 120ms) | same frames, 120ms | ✅ |
| Compact boundary | `CompactBoundaryMessage.tsx:11-13` | `✻ Conversation compacted (ctrl+o for history)` | ✅ |
| Diff colours | `theme.ts` `diffAdded`/`diffRemoved` used as **background** | `bg(diff_added_bg/diff_removed_bg)` | ✅ |
| Palette values | `theme.ts` dark/light tables | exact RGB, line references in `crates/theme` | ✅ |
| Message spacing | `marginTop={addMargin ? 1 : 0}` (`AssistantTextMessage.tsx:186`) | blank separator rows in both modes | ✅ |
| Message meta header | `MessageRow.tsx:229-233`, `MessageTimestamp.tsx`, `MessageModel.tsx` (transcript mode only; assistant messages with a text block; 12-hour en-US clock; right-aligned, dim) | `RowStyle::MessageMeta` + right-aligned render; inline freeze drops it | ✅ OS local offset via `time` (UTC fallback); arrival time when the frame carries no timestamp |
| Prompt send-now / queue-front | keymap table (`ctrl+enter` sendNow, `ctrl+x enter` queueSubmit) | `Ctrl+Enter` interrupts and sends; `Ctrl+X Enter` jumps the queue | ✅ |
| Prose wrapping | `wrapAnsi` word wrap (`@anthropic/ink`) | `markdown::wrap_words` (space-first, hard-break overlong words/CJK) | ✅ |
| Blockquote | `figures.BLOCKQUOTE_BAR` = `▎`, `utils/markdown.ts:64-71` (dim bar + italic text) | `▎ ` per level: dim bar span + italic body span (both frozen and streaming paths) | ✅ |
| Table layout | `MarkdownTable.tsx` (box grid, wrapped cells, centred headers, vertical fallback) | `markdown::render_table`: `┌─┬┐/├─┼┤/└─┴┘`, `MIN_COLUMN_WIDTH=3`, `MAX_ROW_LINES=4`, `SAFETY_MARGIN=4` | ✅ |
| Link / image | `utils/markdown.ts:112-142` (`link` → text, `mailto:` → email, `image` → href) | same visible text; OSC 8 hyperlinks left to the painter | ✅ |
| Block spacing | `markdown.ts` token stream (blank line between blocks) | one empty row between top-level blocks, painted as an empty line | ✅ |
| Status line | `StatusLine.tsx`, `BuiltinStatusLine.tsx` | model · session · ctx% · cache% · session% · weekly% · tasks · queue · spinner | ✅ for the data the engine frames expose: cache hit rate from assistant `usage` (`cache_read` / all prompt tokens) and five-hour/seven-day utilization from `rate_limit_event`. Token budget and cost remain unshown; Ink shows those settings-gated and the TUI status line stays one row |
