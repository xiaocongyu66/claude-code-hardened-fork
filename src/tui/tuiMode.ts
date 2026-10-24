/**
 * Renderer mode resolution for the REPL: `auto` | `native` | `ink`.
 *
 * Priority: `--tui` flag > `CCH_TUI` > legacy `CCH_TUI_NATIVE` > `auto`.
 * `auto` prefers the in-process Rust napi TUI for a local interactive session
 * and falls back to Ink everywhere else. `native` does the same but reports a
 * fallback reason when it cannot run. `ink` always keeps the Ink renderer.
 *
 * Pure: the caller supplies the environment, TTY state, session kind and
 * native-module availability, so the matrix is unit-testable without FFI.
 */

export type TuiMode = 'auto' | 'native' | 'ink'

/** Renderer that will actually run. */
export type ResolvedTuiMode = 'native' | 'ink'

export interface TuiModeInput {
  /** Raw `--tui` value; wins over both environment variables. */
  flag?: string
  /** Raw `CCH_TUI` value (`auto` | `native` | `ink`). */
  env?: string
  /** Raw legacy `CCH_TUI_NATIVE` value: `1` = native, `0` = ink. */
  legacyEnv?: string
  stdinIsTTY: boolean
  stdoutIsTTY: boolean
  /**
   * Remote REPL mode the native host cannot drive yet (the KAIROS `--remote`
   * viewer). SSH and direct-connect are supported and must pass `false`.
   */
  remoteSession: boolean
  /** `loadTuiNative() !== null`: module present and `is_supported()`. */
  nativeAvailable: boolean
}

export interface TuiModeResolution {
  /** Mode selected by flag/env (before availability checks). */
  requested: TuiMode
  /** Renderer to run. */
  mode: ResolvedTuiMode
  /** Why a `native` request fell back; present only when it could not run. */
  fallbackReason?: string
}

function parseMode(value: string | undefined): TuiMode | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value.toLowerCase().trim()
  if (
    normalized === 'auto' ||
    normalized === 'native' ||
    normalized === 'ink'
  ) {
    return normalized
  }
  return undefined
}

/**
 * Legacy boolean switch. Mirrors `isEnvTruthy`/`isEnvDefinedFalsy` so values
 * like `true`/`yes`/`on` and `false`/`no`/`off` keep working; anything else
 * (including an empty string) is ignored.
 */
function parseLegacySwitch(value: string | undefined): TuiMode | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value.toLowerCase().trim()
  if (
    normalized === '1' ||
    normalized === 'true' ||
    normalized === 'yes' ||
    normalized === 'on'
  ) {
    return 'native'
  }
  if (
    normalized === '0' ||
    normalized === 'false' ||
    normalized === 'no' ||
    normalized === 'off'
  ) {
    return 'ink'
  }
  return undefined
}

/** Pick the requested mode from flag/env, ignoring invalid values. */
export function resolveRequestedTuiMode(
  input: Pick<TuiModeInput, 'flag' | 'env' | 'legacyEnv'>,
): TuiMode {
  return (
    parseMode(input.flag) ??
    parseMode(input.env) ??
    parseLegacySwitch(input.legacyEnv) ??
    'auto'
  )
}

/**
 * Resolve the renderer. `auto` and `native` both require a TTY, a local
 * session and a loadable native module; when any gate fails the result is
 * `ink`. A `fallbackReason` is always populated when `native` was requested
 * but could not run, so the caller can log it once to stderr.
 */
export function resolveTuiMode(input: TuiModeInput): TuiModeResolution {
  const requested = resolveRequestedTuiMode(input)

  if (requested === 'ink') {
    return { requested, mode: 'ink' }
  }

  const fallbackReason =
    !input.stdinIsTTY || !input.stdoutIsTTY
      ? 'stdin/stdout must be a TTY'
      : input.remoteSession
        ? 'remote (KAIROS) sessions are not supported yet'
        : !input.nativeAvailable
          ? 'native TUI module unavailable'
          : undefined

  if (fallbackReason) {
    return { requested, mode: 'ink', fallbackReason }
  }
  return { requested, mode: 'native' }
}
