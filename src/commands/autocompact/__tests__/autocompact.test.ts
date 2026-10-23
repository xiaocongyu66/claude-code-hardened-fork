import { describe, expect, test } from 'bun:test'
import {
  AUTOCOMPACT_METHOD_NAMES,
  AUTOCOMPACT_USAGE,
  parseAutocompactArgs,
} from '../args.js'
import {
  type AutocompactDeps,
  buildCompactionPatch,
  buildConfirmation,
  formatStatus,
  resolveDisplayMethodOrder,
  runAutocompact,
} from '../autocompact.js'
import type { SettingsJson } from '../../../utils/settings/types.js'

type Compaction = SettingsJson['compaction']

function makeDeps(compaction?: Compaction): {
  deps: AutocompactDeps
  updates: Array<{ source: string; patch: SettingsJson }>
  failWith: (error: Error) => void
} {
  const updates: Array<{ source: string; patch: SettingsJson }> = []
  let error: Error | null = null
  return {
    deps: {
      getCompactionSettings: () => compaction,
      updateSettingsForSource: (source, patch) => {
        updates.push({ source, patch })
        return { error }
      },
    },
    updates,
    failWith: next => {
      error = next
    },
  }
}

async function run(args: string, deps?: AutocompactDeps): Promise<string> {
  const result = await runAutocompact(args, deps ?? makeDeps().deps)
  if (result.type !== 'text')
    throw new Error(`unexpected result: ${result.type}`)
  return result.value
}

// ── Argument parsing ─────────────────────────────────────────────────────────

describe('parseAutocompactArgs — grammar', () => {
  test('bare invocation means status', () => {
    expect(parseAutocompactArgs('')).toEqual({ kind: 'status' })
    expect(parseAutocompactArgs('   ')).toEqual({ kind: 'status' })
  })

  test('on/off are case-insensitive', () => {
    expect(parseAutocompactArgs('on')).toEqual({
      kind: 'setEnabled',
      enabled: true,
    })
    expect(parseAutocompactArgs(' OFF ')).toEqual({
      kind: 'setEnabled',
      enabled: false,
    })
  })

  test('numeric subcommands parse integers', () => {
    expect(parseAutocompactArgs('threshold 50000')).toEqual({
      kind: 'setThresholdTokens',
      tokens: 50000,
    })
    expect(parseAutocompactArgs('percent 80')).toEqual({
      kind: 'setThresholdPercent',
      percent: 80,
    })
    expect(parseAutocompactArgs('reserve 16000')).toEqual({
      kind: 'setReserveTokens',
      tokens: 16000,
    })
    expect(parseAutocompactArgs('keep 0')).toEqual({
      kind: 'setKeepRecentTokens',
      tokens: 0,
    })
  })

  test('percent bounds are inclusive 1..99', () => {
    expect(parseAutocompactArgs('percent 1').kind).toBe('setThresholdPercent')
    expect(parseAutocompactArgs('percent 99').kind).toBe('setThresholdPercent')
  })

  test('methods accepts comma-separated names with optional spaces', () => {
    expect(parseAutocompactArgs('methods remote, snapcompact,soft')).toEqual({
      kind: 'setMethodOrder',
      methods: ['remote', 'snapcompact', 'soft'],
    })
  })

  test('methods dedupes repeated names', () => {
    expect(parseAutocompactArgs('methods soft,soft,remote')).toEqual({
      kind: 'setMethodOrder',
      methods: ['soft', 'remote'],
    })
  })

  test('malformed invocations are rejected', () => {
    const bad = [
      'threshold',
      'threshold abc',
      'threshold 0',
      'threshold -5',
      'threshold 1.5',
      'threshold 1 2',
      'percent',
      'percent 0',
      'percent 100',
      'percent 50.5',
      'reserve 0',
      'keep -1',
      'methods',
      'methods foo',
      'methods remote,foo',
      'on now',
      'bogus',
    ]
    for (const input of bad) {
      const action = parseAutocompactArgs(input)
      expect(action.kind).toBe('invalid')
      if (action.kind === 'invalid') {
        expect(action.error).toContain(AUTOCOMPACT_USAGE)
      }
    }
  })
})

// ── Patch construction ───────────────────────────────────────────────────────

describe('buildCompactionPatch — write values', () => {
  test('threshold sets thresholdTokens and clears thresholdPercent', () => {
    expect(
      buildCompactionPatch({ kind: 'setThresholdTokens', tokens: 50000 }),
    ).toStrictEqual({
      thresholdTokens: 50000,
      thresholdPercent: undefined,
    })
  })

  test('percent sets thresholdPercent and clears thresholdTokens', () => {
    expect(
      buildCompactionPatch({ kind: 'setThresholdPercent', percent: 80 }),
    ).toStrictEqual({
      thresholdPercent: 80,
      thresholdTokens: undefined,
    })
  })

  test('other actions map to their settings fields', () => {
    expect(
      buildCompactionPatch({ kind: 'setEnabled', enabled: false }),
    ).toStrictEqual({ enabled: false })
    expect(
      buildCompactionPatch({ kind: 'setReserveTokens', tokens: 16000 }),
    ).toStrictEqual({ reserveTokens: 16000 })
    expect(
      buildCompactionPatch({ kind: 'setKeepRecentTokens', tokens: 10000 }),
    ).toStrictEqual({ keepRecentTokens: 10000 })
    expect(
      buildCompactionPatch({
        kind: 'setMethodOrder',
        methods: ['soft', 'remote'],
      }),
    ).toStrictEqual({ methodOrder: ['soft', 'remote'] })
  })
})

// ── Persistence ──────────────────────────────────────────────────────────────

describe('runAutocompact — persists through updateSettingsForSource', () => {
  test('off writes settings.compaction.enabled = false', async () => {
    const { deps, updates } = makeDeps()
    const text = await run('off', deps)
    expect(updates).toHaveLength(1)
    expect(updates[0]!.source).toBe('userSettings')
    expect(updates[0]!.patch).toStrictEqual({
      compaction: { enabled: false },
    })
    expect(text).toContain('Automatic compaction disabled.')
    expect(text).toContain('Only applies when COMPACTION_V2 is enabled.')
  })

  test('threshold write clears the percent form', async () => {
    const { deps, updates } = makeDeps()
    await run('threshold 50000', deps)
    expect(updates[0]!.patch).toStrictEqual({
      compaction: { thresholdTokens: 50000, thresholdPercent: undefined },
    })
  })

  test('percent write clears the tokens form', async () => {
    const { deps, updates } = makeDeps()
    await run('percent 80', deps)
    expect(updates[0]!.patch).toStrictEqual({
      compaction: { thresholdPercent: 80, thresholdTokens: undefined },
    })
  })

  test('reserve, keep, and methods write their fields', async () => {
    const { deps, updates } = makeDeps()

    await run('reserve 16000', deps)
    expect(updates[0]!.patch).toStrictEqual({
      compaction: { reserveTokens: 16000 },
    })

    updates.length = 0
    await run('keep 10000', deps)
    expect(updates[0]!.patch).toStrictEqual({
      compaction: { keepRecentTokens: 10000 },
    })

    updates.length = 0
    await run('methods remote,soft', deps)
    expect(updates[0]!.patch).toStrictEqual({
      compaction: { methodOrder: ['remote', 'soft'] },
    })
  })

  test('invalid values are rejected without writing settings', async () => {
    const { deps, updates } = makeDeps()
    for (const input of [
      'threshold abc',
      'percent 100',
      'reserve 0',
      'keep -1',
      'methods foo',
      'bogus',
    ]) {
      const text = await run(input, deps)
      expect(text).toContain('Usage: /autocompact')
    }
    expect(updates).toHaveLength(0)
  })

  test('a persistence error is surfaced and not reported as success', async () => {
    const { deps, failWith } = makeDeps()
    failWith(new Error('disk full'))
    const text = await run('on', deps)
    expect(text).toContain('Failed to update compaction settings: disk full')
    expect(text).not.toContain('Automatic compaction enabled.')
  })
})

// ── Status rendering ─────────────────────────────────────────────────────────

describe('formatStatus — display content', () => {
  test('shows built-in defaults when settings are absent', () => {
    const text = formatStatus(undefined)
    expect(text).toContain('enabled:     on (default)')
    expect(text).toContain('threshold:   default (context window - reserve)')
    expect(text).toContain('reserve:     default (max(15% of window, 16384))')
    expect(text).toContain('keepRecent:  20000 tokens (default)')
    expect(text).toContain(
      'methodOrder: remote, snapcompact, handoff, shake, soft',
    )
    expect(text).toContain('midTurn:     on (default)')
    expect(text).toContain('async:       on (default)')
    expect(text).toContain('idle:        off (default)')
    expect(text).toContain('Only applies when COMPACTION_V2 is enabled.')
  })

  test('shows configured values and token threshold precedence', () => {
    const text = formatStatus({
      enabled: false,
      thresholdTokens: 120000,
      thresholdPercent: 80,
      reserveTokens: 16000,
      keepRecentTokens: 10000,
      methodOrder: ['soft', 'remote'],
      midTurnEnabled: false,
      asyncEnabled: false,
      idleEnabled: true,
    })
    expect(text).toContain('enabled:     off')
    expect(text).toContain(
      'threshold:   120000 tokens (thresholdPercent 80% ignored)',
    )
    expect(text).toContain('reserve:     16000 tokens')
    expect(text).toContain('keepRecent:  10000 tokens')
    expect(text).toContain('methodOrder: soft, remote')
    expect(text).toContain('midTurn:     off')
    expect(text).toContain('async:       off')
    expect(text).toContain('idle:        on')
  })

  test('shows a percent-only threshold', () => {
    const text = formatStatus({ thresholdPercent: 80 })
    expect(text).toContain('threshold:   80% of the context window')
  })

  test('run without args reads settings and renders status', async () => {
    const { deps, updates } = makeDeps({
      enabled: false,
      idleEnabled: true,
    })
    const text = await run('', deps)
    expect(text).toContain('enabled:     off')
    expect(text).toContain('idle:        on')
    expect(updates).toHaveLength(0)
  })
})

describe('resolveDisplayMethodOrder — filtering', () => {
  test('drops unknown method names', () => {
    expect(resolveDisplayMethodOrder(['remote', 'bogus', 'soft'])).toEqual([
      'remote',
      'soft',
    ])
  })

  test('falls back to the default order when nothing valid remains', () => {
    const fallback = [...AUTOCOMPACT_METHOD_NAMES]
    expect(resolveDisplayMethodOrder(['bogus'])).toEqual(fallback)
    expect(resolveDisplayMethodOrder([])).toEqual(fallback)
    expect(resolveDisplayMethodOrder(undefined)).toEqual(fallback)
  })
})

describe('buildConfirmation — copy', () => {
  test('names the field being changed', () => {
    expect(buildConfirmation({ kind: 'setEnabled', enabled: true })).toBe(
      'Automatic compaction enabled.',
    )
    expect(
      buildConfirmation({ kind: 'setThresholdPercent', percent: 80 }),
    ).toContain('thresholdTokens cleared')
    expect(
      buildConfirmation({ kind: 'setMethodOrder', methods: ['soft'] }),
    ).toContain('soft')
  })
})
