# TUI Packaging

The native TUI (`cch_tui`, a napi-rs cdylib) ships **inside the main package**.
There is no separate `@claude-code-best/tui-*` platform package, no postinstall
download, and no `bun install` step for end users.

## Distribution model

The module follows the same pipeline as the other five napi modules
(token-counter, transcript-parser, color-diff, file-index, search):

| Artifact | Where it comes from | Where it lives |
|---|---|---|
| `libcch_tui.so` / `libcch_tui.dylib` / `cch_tui.dll` | `cargo build --release --target <triple> -p cch-tui-napi` in `packages/tui-native/native` | CI stages it as `tui.node` under `stage/tui/<triple>/` |
| npm vendor tree | CI artifact unpacked into `vendor/tui/<triple>/tui.node` | shipped in the npm tarball |
| single-file binary payload | `scripts/compile.ts` reads `vendor/tui/<triple>/tui.node`, base64-encodes it and injects it as `EMBEDDED_NATIVES['tui']` | `bun --compile` output (`dist/ccb-*`) |

Both `build.ts` (Bun bundle) and `scripts/post-build.ts` (Vite) copy
`vendor/tui/` into `dist/vendor/tui/` when it exists locally.

## Load path

`src/utils/tuiNative.ts` calls
`loadNativeModule('tui', 'tui', isValidTuiNativeModule)`:

1. **Compiled binary**: `EMBEDDED_NATIVES['tui']` is decoded and `dlopen`ed from
   an anonymous memfd (`/dev/fd/<n>` on Linux), zero disk writes.
2. **Dev / regular build**: `require('vendor/tui/<triple>/tui.node')` relative
   to `dist/` (or the repo root).
3. **Missing / invalid payload**: returns `null` and logs once at debug level.
   Nothing throws.

The structural probe requires all five exported functions:
`start`, `send`, `poll`, `stop`, `is_supported`. A payload that fails
`is_supported()` is treated as unavailable.

The host loop in `src/tui/nativeHost.ts` is dependency-injected; the native
module is only resolved lazily, so unit tests use a fake module and never touch
FFI. If the upstream Rust branch renames a `#[napi]` export, update the probe
and host frame handling together.

## Runtime flow

```
QueryEngine.submitMessage(event generator)
        │ JSON.stringify(frame)
        ▼
   tui.send(frame)  ──►  native TUI (rendering / input / dialogs)
        ▲                        │
        │  poll() every 20 ms    │
        └── prompt / permission / interrupt / exit
```

- `prompt` → injected `submitPrompt(text, canUseTool)`; each yielded engine
  event is sent as one JSON frame.
- `permission` → the injected `answerPermission(event)` (or the frame's own
  `decision` promise) resolves the pending `canUseTool` promise. The request
  itself is emitted as a `control_request` `can_use_tool` frame keyed by
  `request_id`.
- `interrupt` → injected `abort()` (QueryEngine interrupt).
- `exit` → `stop()` and the host returns.

Permission decisions made by existing rules (allow/deny) short-circuit before a
frame is sent when a base `canUseTool` is injected.

## CLI switch

The native path is **off by default**:

```bash
CCH_TUI_NATIVE=1 cch
```

`src/replLauncher.tsx` checks the flag, requires a local interactive session
(no remote/SSH/direct-connect), loads the module, and runs the host. If the
module is missing or unsupported, the normal Ink REPL renders unchanged.
The environment variable is the only switch — there is no config-file setting.

## Build and CI

- `scripts/compile.ts` `CRATES` entry:
  `{ pkg: 'tui-napi', crate: 'cch_tui', vendorDir: 'tui', moduleName: 'tui' }`.
- `build.ts` and `scripts/post-build.ts` include `tui` in the vendor copy list.
- `.github/workflows/ci.yml` native matrix adds a `Build (tui-napi)` step
  (`-p cch-tui-napi`) and stages `stage/tui/<triple>/tui.node`; the existing
  `stage/tui/<triple>/cch-tui[.exe]` standalone binary remains for the
  process-spawning path and is not required by the napi host.

## Smoke test

`scripts/tui-native-smoke.ts` verifies that the packaged payload actually
loads through the main-package loader — a green `cargo build` alone does not
prove the `.node` is stageable, loadable, and structurally valid.

Two tiers:

1. **load-only** — used when `CCH_TUI_SMOKE_NO_TTY=1` or stdin is not a TTY.
   Loads `vendor/tui/<triple>/tui.node` through `loadNativeModule()` (the
   exact loader behind `loadTuiNative()`), asserts the payload is non-null and
   passes the five-function structural probe, then asserts `is_supported()`
   is false. Nothing is started. (`loadTuiNative()` itself returns `null`
   without a TTY because availability folds in `is_supported()`.)
2. **tty** — stdin is a TTY (CI runs it under `script`). Calls
   `loadTuiNative()`, asserts non-null, then
   `start({fullscreen:true, theme:'dark'})` →
   `send({"type":"system","subtype":"init"})` → `poll()` ×20 → `stop()`.
   `stop()` runs even when the round trip throws.

   Fullscreen is used because the inline viewport anchors itself with a
   cursor-position query (`ESC[6n`), and a bare `script` PTY has no terminal
   emulator behind it to answer. Fullscreen only needs the terminal-size
   ioctl, so the same `start/send/poll/stop` surface is exercised without
   depending on a DSR reply.

Output is a single line, `SMOKE OK mode=load-only|tty`; failures exit 1.

The `package` CI job runs this after dependencies are installed and the
native artifacts are synced into `vendor/tui/`:

```bash
script -qec "bun scripts/tui-native-smoke.ts" /dev/null
```

`script(1)` provides the PTY. If it is unavailable, CI falls back to
`CCH_TUI_SMOKE_NO_TTY=1 bun scripts/tui-native-smoke.ts` and logs a warning.
The step is blocking, so a payload that cannot be loaded stops the release.

Locally (requires a staged `vendor/tui/<triple>/tui.node`):

```bash
bun scripts/tui-native-smoke.ts                          # PTY round trip
CCH_TUI_SMOKE_NO_TTY=1 bun scripts/tui-native-smoke.ts   # load-only
```

Limits: this covers the vendor path on the runner's platform only. The
base64-embedded path inside `bun --compile` binaries is a different artifact
and is not exercised here; rendering and frame semantics are also out of
scope (the TUI is started, polled and stopped, with no screen assertions).

## Fallback

Any of the following keeps the Ink REPL:

- `vendor/tui/<triple>/tui.node` absent from the npm tarball and no embedded
  payload in the compiled binary;
- the loaded object lacks one of the five functions;
- `is_supported()` returns false or throws;
- the user runs with `CCH_TUI_NATIVE` unset (the default).
