import { describe, expect, test } from 'bun:test'
import { resolveTuiMode, type TuiModeInput } from '../tuiMode.js'

/** Local interactive session with a loadable native module. */
const localTty: TuiModeInput = {
  stdinIsTTY: true,
  stdoutIsTTY: true,
  remoteSession: false,
  nativeAvailable: true,
}

describe('resolveTuiMode', () => {
  test('auto prefers native in a local interactive session', () => {
    expect(resolveTuiMode({ ...localTty })).toEqual({
      requested: 'auto',
      mode: 'native',
    })
  })

  test('auto falls back to ink when the native module is missing', () => {
    expect(
      resolveTuiMode({ ...localTty, env: 'auto', nativeAvailable: false }),
    ).toEqual({
      requested: 'auto',
      mode: 'ink',
      fallbackReason: 'native TUI module unavailable',
    })
  })

  test('auto falls back to ink without a TTY', () => {
    expect(resolveTuiMode({ ...localTty, stdinIsTTY: false })).toMatchObject({
      requested: 'auto',
      mode: 'ink',
      fallbackReason: 'stdin/stdout must be a TTY',
    })
    expect(resolveTuiMode({ ...localTty, stdoutIsTTY: false })).toMatchObject({
      mode: 'ink',
    })
  })

  test('auto suppresses native for remote/SSH/direct-connect sessions', () => {
    expect(resolveTuiMode({ ...localTty, remoteSession: true })).toEqual({
      requested: 'auto',
      mode: 'ink',
      fallbackReason: 'remote/SSH/direct-connect sessions are not supported',
    })
  })

  test('native runs the native renderer when available', () => {
    expect(resolveTuiMode({ ...localTty, flag: 'native' })).toEqual({
      requested: 'native',
      mode: 'native',
    })
  })

  test('native falls back to ink with a reason when unavailable', () => {
    expect(
      resolveTuiMode({ ...localTty, flag: 'native', nativeAvailable: false }),
    ).toEqual({
      requested: 'native',
      mode: 'ink',
      fallbackReason: 'native TUI module unavailable',
    })
  })

  test('native still respects the remote-session gate', () => {
    expect(
      resolveTuiMode({ ...localTty, flag: 'native', remoteSession: true }),
    ).toMatchObject({
      requested: 'native',
      mode: 'ink',
      fallbackReason: 'remote/SSH/direct-connect sessions are not supported',
    })
  })

  test('ink forces the Ink renderer even when native is available', () => {
    expect(resolveTuiMode({ ...localTty, flag: 'ink' })).toEqual({
      requested: 'ink',
      mode: 'ink',
    })
    expect(resolveTuiMode({ ...localTty, env: 'ink' })).toEqual({
      requested: 'ink',
      mode: 'ink',
    })
  })

  test('legacy CCH_TUI_NATIVE=1 behaves like --tui=native', () => {
    expect(resolveTuiMode({ ...localTty, legacyEnv: '1' })).toEqual({
      requested: 'native',
      mode: 'native',
    })
    expect(
      resolveTuiMode({ ...localTty, legacyEnv: '1', nativeAvailable: false }),
    ).toMatchObject({ requested: 'native', mode: 'ink' })
  })

  test('legacy CCH_TUI_NATIVE=0 behaves like --tui=ink', () => {
    expect(resolveTuiMode({ ...localTty, legacyEnv: '0' })).toEqual({
      requested: 'ink',
      mode: 'ink',
    })
    // Boolean spellings keep working, matching isEnvTruthy/isEnvDefinedFalsy.
    expect(resolveTuiMode({ ...localTty, legacyEnv: 'false' }).requested).toBe(
      'ink',
    )
  })

  test('precedence: flag > CCH_TUI > CCH_TUI_NATIVE > auto', () => {
    expect(
      resolveTuiMode({
        ...localTty,
        flag: 'ink',
        env: 'native',
        legacyEnv: '1',
      }).requested,
    ).toBe('ink')
    expect(
      resolveTuiMode({ ...localTty, env: 'ink', legacyEnv: '1' }).requested,
    ).toBe('ink')
    expect(
      resolveTuiMode({ ...localTty, env: 'native', legacyEnv: '0' }).requested,
    ).toBe('native')
    expect(
      resolveTuiMode({ ...localTty, flag: 'native', env: 'ink' }).requested,
    ).toBe('native')
  })

  test('invalid values are ignored and fall through to auto', () => {
    expect(
      resolveTuiMode({
        ...localTty,
        flag: 'rust',
        env: 'gpu',
        legacyEnv: '2',
      }),
    ).toEqual({ requested: 'auto', mode: 'native' })
  })
})
