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
| Diffs | `StructuredDiff.tsx`, `FileEditToolDiff.tsx` | 🟡 `crates/diff` + render | renderer ready; Edit-tool wiring pending |
| Permission dialog | `permissions/PermissionRequest.tsx` | ✅ `crates/dialog` + overlay | allow/deny, suggestions, cancel |
| Prompt editing | `PromptInput.tsx` | ✅ `TextBuffer` + `keymap` | multi-line, undo, kill ring, chords |
| Paste folding | `PromptInput.tsx` (~1399) | ✅ `TextBuffer::insert_paste` | >800 chars or >2 newlines |
| History search | `HistorySearchDialog.tsx` | 🟡 wired (Ctrl+R) | UI is a status line; dialog view pending |
| Vim mode | `PromptInput.tsx` (~2456) | ✅ `crates/core::vim` | env `CCH_TUI_VIM=1` |
| Message actions | `messageActions.tsx` | 🟡 model ready | focus/copy/rewind not wired to keys yet |
| Tool output expand | `CtrlOToExpand.tsx` | ✅ fullscreen | collapse 3 lines; inline is frozen |
| Task / agent panel | `TaskListV2.tsx`, `components/tasks/*` | ✅ `crates/panel` | status line + fullscreen sidebar |
| Spinner / activity | `Spinner.tsx` | ✅ status line | frame advances while a turn runs |
| Plan mode | `ExitPlanModePermissionRequest/*` | ⬜ | renderer can reuse the dialog overlay |
| Queued input display | `REPL.tsx` prompt queue | ✅ status line | `queued N`; prompts flush on `result` |
| Sticky prompt | `VirtualMessageList.tsx` | ⬜ | fullscreen-only chrome |
| Global search | `GlobalSearchDialog.tsx` | ⬜ | needs transcript search model |
| @file completion | `fileSuggestions.ts` | ⬜ | engine-side index exists; TUI needs a picker |
| Slash palette | slash command menu | ⬜ | needs command metadata from `init` |
| Copy to clipboard | OSC52 / platform tools | 🟡 OSC52 only | Alt+C copies the last assistant message |
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
