/**
 * Native TUI loader (`cch_tui` napi module).
 *
 * Mirrors `packages/search-napi/src/index.ts`: a narrow structural probe over
 * the frozen v1 surface (start / send / poll / stop / is_supported) routed
 * through the shared embedded/vendor loader. Distribution is identical to the
 * other napi modules — base64-embedded in `bun --compile` binaries and
 * `vendor/tui/<triple>/tui.node` for regular builds. Nothing is installed
 * separately and no platform package is required.
 *
 * A missing or structurally invalid payload is not an error: callers keep the
 * Ink REPL path. Availability is logged once at debug level.
 */

import { logForDebugging } from './debug.js'
import { loadNativeModule } from './embeddedNative.js'

/** Options accepted by `start()` (napi camelCase args). */
export interface TuiStartOptions {
  fullscreen?: boolean
  theme?: string
  vim?: boolean
}

/**
 * Engine → host frames. The native side emits these from `poll()`; unknown
 * shapes are tolerated by the host (ahead-of-host engine changes must not be
 * fatal).
 */
export interface TuiNativeEvent {
  type: string
  [key: string]: unknown
}

/**
 * Frozen v1 native surface exported by `crates/napi` (`cch_tui` cdylib).
 * `poll()` may return a frame, an array of frames, a JSON string, or null.
 */
export interface TuiNativeModule {
  start(options: TuiStartOptions): void
  send(frame: string): void
  poll(): TuiNativeEvent | TuiNativeEvent[] | string | null
  stop(): void
  is_supported(): boolean
}

const REQUIRED_FUNCTIONS = [
  'start',
  'send',
  'poll',
  'stop',
  'is_supported',
] as const

/** Structural validate probe for `loadNativeModule`. */
export function isValidTuiNativeModule(mod: unknown): boolean {
  if (mod === null || typeof mod !== 'object') {
    return false
  }
  const m = mod as Record<string, unknown>
  return REQUIRED_FUNCTIONS.every(name => typeof m[name] === 'function')
}

let cachedModule: TuiNativeModule | null = null
let loadAttempted = false
let loggedUnavailable = false

function logUnavailableOnce(reason: string): void {
  if (loggedUnavailable) return
  loggedUnavailable = true
  logForDebugging(`[tui-native] unavailable: ${reason} — falling back to Ink`)
}

/**
 * Load the native TUI module. Returns null when the payload is absent, fails
 * structural validation, or reports itself unsupported. Never throws.
 */
export function loadTuiNative(): TuiNativeModule | null {
  if (loadAttempted) {
    return cachedModule
  }
  loadAttempted = true

  // Loader key, vendor dir and on-disk file name must coincide
  // (vendor/tui/<triple>/tui.node + EMBEDDED_NATIVES['tui']).
  const mod = loadNativeModule<TuiNativeModule>(
    'tui',
    'tui',
    isValidTuiNativeModule,
  )
  if (!mod) {
    logUnavailableOnce('native module not found or invalid')
    cachedModule = null
    return null
  }

  let supported = true
  try {
    supported = mod.is_supported()
  } catch (e) {
    logUnavailableOnce(`is_supported() threw: ${String(e).slice(0, 120)}`)
    cachedModule = null
    return null
  }
  if (!supported) {
    logUnavailableOnce('is_supported() returned false')
    cachedModule = null
    return null
  }

  cachedModule = mod
  return cachedModule
}

/** Test hook: clear the process-level load attempt/cache. */
export function resetTuiNativeCacheForTesting(): void {
  cachedModule = null
  loadAttempted = false
  loggedUnavailable = false
}
