# Ink → Rust TUI Parity Tracker

Living checklist of Ink behaviours and where the native TUI stands. Update it
when a feature lands; keep the "Ink reference" column so the port can be
verified against the original component.

Legend: ✅ done · 🟡 partial · ⬜ not started · ⛔ intentionally deferred

| Area | Ink reference | Rust TUI | Notes |
|---|---|---|---|
| Transcript rendering | `components/Messages.tsx`, `MessageRow.tsx` | ✅ `crates/ui` | text, tool calls/results, errors, compact boundary |
| Streaming text | `REPL.tsx` (`streamingText`) | ✅ `ChatView::live_text` | deltas never touch frozen rows |
| Inline scrollback freeze | `ScrollBox` + `shouldRenderStatically` | ✅ `TerminalSession::insert_rows` | frozen via `insert_before` |
| Fullscreen virtual list | `useVirtualScroll.ts` | ✅ `crates/fullscreen` | window, follow/unseen |
| Markdown | `Markdown.tsx` | ✅ `crates/markdown` | headings/lists/quotes/code/tables/links |
| Code highlighting | `HighlightedCode.tsx` | ✅ `crates/highlight` | syntect, byte-budget LRU |
| Diffs | `StructuredDiff.tsx`, `FileEditToolDiff.tsx` | ✅ | Edit `structuredPatch` renders as +/-/context rows |
| Permission dialog | `permissions/PermissionRequest.tsx` | ✅ `crates/dialog` + overlay | allow/deny, suggestions, cancel |
| Prompt editing | `PromptInput.tsx` | ✅ `TextBuffer` + `keymap` | multi-line, undo, kill ring, chords |
| Paste folding | `PromptInput.tsx` (~1399) | ✅ `TextBuffer::insert_paste` | >800 chars or >2 newlines |
| History search | `HistorySearchDialog.tsx` | 🟡 wired (Ctrl+R) | UI is a status line; dialog view pending |
| Vim mode | `PromptInput.tsx` (~2456) | ✅ `crates/core::vim` | env `CCH_TUI_VIM=1` |
| Message actions | `messageActions.tsx` | ✅ focus/copy/expand | `Alt+Up/Down` focus (`msg i/n`), `Ctrl+Y`/`Alt+C` copy, `Ctrl+O` toggles the focused block, `Esc` clears; rewind awaits an engine op |
| Tool output expand | `CtrlOToExpand.tsx` | ✅ fullscreen | per-message `Ctrl+O`; 3-line collapse; inline is frozen |
| Task / agent panel | `TaskListV2.tsx`, `components/tasks/*` | ✅ `crates/panel` | status line + fullscreen sidebar |
| Spinner / activity | `Spinner.tsx` | ✅ status line | frame advances while a turn runs |
| Plan mode | `ExitPlanModePermissionRequest/*` | 🟡 view ready | `Ready to code?` + plan body; decision semantics in flight |
| Queued input display | `REPL.tsx` prompt queue | ✅ status line | `queued N`; prompts flush on `result` |
| Sticky prompt | `VirtualMessageList.tsx` | ✅ fullscreen | `set_sticky_prompt` + `↓ N new` pill |
| Global search | `GlobalSearchDialog.tsx` | 🟡 model ready (`crates/search`) | wiring in flight (Ctrl+F) |
| @file completion | `fileSuggestions.ts` | ⬜ | engine-side index exists; TUI needs a picker |
| Slash palette | slash command menu | 🟡 model ready (`crates/palette`) | wiring in flight |
| Copy to clipboard | OSC52 / platform tools | 🟡 OSC52 only | `Ctrl+Y`/`Alt+C` copy the focused message, or the newest assistant reply when unfocused |
| Image paste | `imagePaste.ts`, `useClipboardImageHint` | ⛔ | no terminal image protocol; needs a clipboard image path |
| Diff dialog | `diff/DiffDialog.tsx` | ⬜ | after Edit-tool diff wiring |
| Settings/theme command | `Config.tsx` | 🟡 env `CCH_TUI_THEME` | `/theme` command later |
| Trust / onboarding | `TrustDialog`, onboarding | ⛔ | engine owns trust; TUI starts after it |
| Export / feedback | `ExportDialog`, `Feedback` | ⛔ | out of scope for the native TUI |
| Legacy conhost | `legacyConsole.ts` | ⬜ | periodic full redraw on old Windows builds |

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
| Tool call label | `AssistantToolUseMessage.tsx:137-160` (`⏺ ` + bold name + `(input)`) | `⏺ ` + bold name + `(args)` spans | 🟡 args are a JSON summary, not `renderToolUseMessage()` |
| Tool bullet colour | `ToolUseLoader.tsx:16` (success / error / dim while unresolved) | `ToolCallPending/ToolCall/ToolCallError` | ✅ |
| Tool result gutter | `MessageResponse.tsx:20-25` (`  ⎿  ` dim, 5-col) | `  ⎿  ` + 5-space continuation | ✅ |
| User prompt block | `UserPromptMessage.tsx:72-84`, `userMessageBackground` | full-width bg, 1 col right padding | ✅ |
| Streaming text | `Messages.tsx:921-933` (bullet + StreamingMarkdown, marginTop 1) | bullet + markdown + tail window | ✅ |
| Spinner | `Spinner.tsx:42-44,537` (`·✢✱✶✻✽` + reverse, 120ms) | same frames, 120ms | ✅ |
| Compact boundary | `CompactBoundaryMessage.tsx:11-13` | `✻ Conversation compacted (ctrl+o for history)` | ✅ |
| Diff colours | `theme.ts` `diffAdded`/`diffRemoved` used as **background** | `bg(diff_added_bg/diff_removed_bg)` | ✅ |
| Palette values | `theme.ts` dark/light tables | exact RGB, line references in `crates/theme` | ✅ |
| Message spacing | `marginTop={addMargin ? 1 : 0}` (`AssistantTextMessage.tsx:186`) | blank separator rows in both modes | ✅ |
| Prose wrapping | `wrapAnsi` word wrap (`@anthropic/ink`) | `markdown::wrap_words` (space-first, hard-break overlong words/CJK) | ✅ |
| Blockquote | `figures.BLOCKQUOTE_BAR` = `▎`, `utils/markdown.ts:64-71` (dim bar + italic text) | `▎ ` per level, italic body | 🟡 the bar shares the body style (Ink dims only the bar); needs a two-span row |
| Table layout | `MarkdownTable.tsx` (box grid, wrapped cells, centred headers, vertical fallback) | `markdown::render_table`: `┌─┬┐/├─┼┤/└─┴┘`, `MIN_COLUMN_WIDTH=3`, `MAX_ROW_LINES=4`, `SAFETY_MARGIN=4` | ✅ |
| Link / image | `utils/markdown.ts:112-142` (`link` → text, `mailto:` → email, `image` → href) | same visible text; OSC 8 hyperlinks left to the painter | ✅ |
| Block spacing | `markdown.ts` token stream (blank line between blocks) | one empty row between top-level blocks, painted as an empty line | ✅ |
| Status line | `StatusLine.tsx` | model · session · ctx% · tasks · queue · spinner | 🟡 subset: Ink also shows cache hit rate, rate-limit windows and token budget, which the stream-json engine does not expose (Ink is settings-gated too) |
