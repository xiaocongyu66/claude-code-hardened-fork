#!/usr/bin/env bun
/**
 * Smoke test: does the packaged `cch_tui` napi module actually load?
 *
 * This goes through the same loader the CLI uses (`src/utils/embeddedNative.ts`
 * via `src/utils/tuiNative.ts`), so it catches ABI / missing-export / bad
 * staging problems that a successful `cargo build` does not.
 *
 * Two tiers:
 *
 *   load-only (CCH_TUI_SMOKE_NO_TTY=1, or stdin is not a TTY)
 *     Load the vendor payload through `loadNativeModule()` (the exact loader
 *     `loadTuiNative()` uses), assert it passes the five-function structural
 *     probe, and assert `is_supported()` is false. Nothing is started.
 *     `loadTuiNative()` is not used here on purpose: it folds
 *     `is_supported()` into availability and returns null without a TTY even
 *     when the payload loaded fine.
 *
 *   tty (stdin is a TTY, e.g. under `script`)
 *     `loadTuiNative()` → assert non-null →
 *     `start({fullscreen:true, theme:'dark'})` →
 *     `send({"type":"system","subtype":"init"})` → poll 20 times → `stop()`.
 *     Any throw fails the run; `stop()` always runs once started.
 *
 * Output: `SMOKE OK mode=load-only|tty`; failures exit 1.
 *
 * Usage:
 *   bun scripts/tui-native-smoke.ts
 *   script -qec "bun scripts/tui-native-smoke.ts" /dev/null
 *   CCH_TUI_SMOKE_NO_TTY=1 bun scripts/tui-native-smoke.ts
 */

import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadNativeModule } from '../src/utils/embeddedNative.js'
import {
  isValidTuiNativeModule,
  loadTuiNative,
  type TuiNativeModule,
  type TuiStartOptions,
} from '../src/utils/tuiNative.js'

const nodeRequire = createRequire(import.meta.url)
const scriptDir = dirname(fileURLToPath(import.meta.url))

const POLL_ATTEMPTS = 20
const POLL_INTERVAL_MS = 10
// Fullscreen avoids the inline viewport's cursor-position query (DSR,
// `ESC[6n`). A bare `script` PTY in CI has no terminal emulator to answer it,
// so inline init would stall for ~2s and then fail the runner thread.
// Fullscreen only needs the TIOCGWINSZ size ioctl (0x0 is tolerated).
const START_OPTIONS: TuiStartOptions = { fullscreen: true, theme: 'dark' }
const INIT_FRAME = JSON.stringify({ type: 'system', subtype: 'init' })

function fail(message: string): never {
  console.error(`SMOKE FAILED: ${message}`)
  process.exit(1)
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** Loader triple, mirrored from `src/utils/embeddedNative.ts`. */
function vendorTriple(): string {
  const arch = process.arch
  if (process.platform === 'linux') {
    return arch === 'arm64'
      ? 'aarch64-unknown-linux-gnu'
      : 'x86_64-unknown-linux-gnu'
  }
  if (process.platform === 'darwin') {
    return arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin'
  }
  if (process.platform === 'win32') return 'x86_64-pc-windows-msvc'
  return `unsupported(${process.platform}/${arch})`
}

/**
 * Explain why `loadTuiNative()` returned null: the loader swallows dlopen and
 * validation errors, so retry the same vendor file directly and surface them.
 */
function diagnoseTuiLoad(): string {
  const candidate = resolve(
    scriptDir,
    '..',
    'vendor',
    'tui',
    vendorTriple(),
    'tui.node',
  )
  if (!existsSync(candidate)) {
    return `vendor payload missing at ${candidate}`
  }
  try {
    const direct = nodeRequire(candidate) as TuiNativeModule
    let supported: unknown
    try {
      supported =
        typeof direct.is_supported === 'function'
          ? direct.is_supported()
          : 'is_supported missing'
    } catch (error) {
      supported = `is_supported threw: ${String(error)}`
    }
    return (
      `vendor payload loaded directly from ${candidate} but the loader ` +
      `rejected it (is_supported=${String(supported)}, ` +
      `exports=${Object.keys(direct).join(',')})`
    )
  } catch (error) {
    return `vendor payload failed to dlopen from ${candidate}: ${String(error)}`
  }
}

/**
 * The frozen TS surface documents `start(options)`, while the current napi
 * binding takes the same fields as a JSON string (`start(options_json)`).
 * Try the object first (future-proof) and fall back to the wire form; rethrow
 * only if both are rejected.
 */
function startTui(mod: TuiNativeModule): void {
  try {
    mod.start(START_OPTIONS)
    return
  } catch (objectError) {
    try {
      mod.start(JSON.stringify(START_OPTIONS) as unknown as TuiStartOptions)
    } catch (stringError) {
      throw new Error(
        `start() rejected both options object and JSON: ${String(
          objectError,
        )} / ${String(stringError)}`,
      )
    }
  }
}

const stdinIsTty = process.stdin.isTTY === true
const loadOnly = process.env.CCH_TUI_SMOKE_NO_TTY === '1' || !stdinIsTty

if (loadOnly) {
  const mod = loadNativeModule<TuiNativeModule>(
    'tui',
    'tui',
    isValidTuiNativeModule,
  )
  if (mod === null) {
    fail(
      'loadNativeModule() returned null — vendor/tui/<triple>/tui.node is ' +
        'missing, fails to dlopen, or does not expose the five v1 functions',
    )
  }

  let supported = false
  try {
    supported = mod.is_supported()
  } catch (error) {
    fail(`is_supported() threw: ${String(error)}`)
  }
  if (!stdinIsTty && supported) {
    fail('is_supported() returned true without a TTY')
  }

  console.log('SMOKE OK mode=load-only')
} else {
  const mod = loadTuiNative()
  if (mod === null) {
    fail(
      `loadTuiNative() returned null even though stdin is a TTY — ${diagnoseTuiLoad()}`,
    )
  }
  if (!mod.is_supported()) {
    fail('is_supported() returned false even though stdin is a TTY')
  }

  let started = false
  let failure: string | null = null
  try {
    startTui(mod)
    started = true
    mod.send(INIT_FRAME)
    for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt++) {
      mod.poll()
      await sleep(POLL_INTERVAL_MS)
    }
  } catch (error) {
    failure = `tty round trip failed: ${String(error)}`
  } finally {
    if (started) {
      try {
        mod.stop()
      } catch (error) {
        failure ??= `stop() failed: ${String(error)}`
      }
    }
  }

  if (failure !== null) {
    fail(failure)
  }
  console.log('SMOKE OK mode=tty')
}
