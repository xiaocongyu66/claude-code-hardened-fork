import { describe, expect, test } from 'bun:test'
import { DEFAULT_COMPACTION_SETTINGS } from '../../contracts.js'
import { resolveSettings } from '../../orchestrator.js'

describe('resolveSettings', () => {
  test('returns the default policy when nothing is configured', () => {
    const settings = resolveSettings(undefined, { env: {} })
    expect(settings.methodOrder).toEqual(
      DEFAULT_COMPACTION_SETTINGS.methodOrder,
    )
    expect(settings.keepRecentTokens).toBe(20_000)
    expect(settings.reserveTokens).toBeUndefined()
    expect(settings.thresholdTokens).toBeUndefined()
    expect(settings.thresholdPercent).toBeUndefined()
    expect(settings.midTurnEnabled).toBe(true)
    expect(settings.autoContinue).toBe(true)
    expect(settings.asyncEnabled).toBe(true)
    expect(settings.idleEnabled).toBe(false)
    expect(settings.idleThresholdTokens).toBe(200_000)
    expect(settings.idleTimeoutSeconds).toBe(300)
  })

  test('applies settings.compaction when the request has no override', () => {
    const settings = resolveSettings(undefined, {
      compaction: {
        methodOrder: ['handoff', 'soft'],
        keepRecentTokens: 8_000,
        thresholdPercent: 75,
        midTurnEnabled: false,
        idleEnabled: true,
        idleTimeoutSeconds: 600,
      },
      env: {},
    })
    expect(settings.methodOrder).toEqual(['handoff', 'soft'])
    expect(settings.keepRecentTokens).toBe(8_000)
    expect(settings.thresholdPercent).toBe(75)
    expect(settings.midTurnEnabled).toBe(false)
    expect(settings.idleEnabled).toBe(true)
    expect(settings.idleTimeoutSeconds).toBe(600)
  })

  test('explicit request settings beat settings.compaction', () => {
    const settings = resolveSettings(
      {
        methodOrder: ['soft'],
        keepRecentTokens: 1_000,
        midTurnEnabled: true,
      },
      {
        compaction: {
          methodOrder: ['handoff'],
          keepRecentTokens: 9_000,
          midTurnEnabled: false,
        },
        env: {},
      },
    )
    expect(settings.methodOrder).toEqual(['soft'])
    expect(settings.keepRecentTokens).toBe(1_000)
    expect(settings.midTurnEnabled).toBe(true)
  })

  test('invalid request values fall through to settings.compaction', () => {
    const settings = resolveSettings(
      {
        keepRecentTokens: -5,
        thresholdPercent: 150,
        idleTimeoutSeconds: 30,
      },
      {
        compaction: {
          keepRecentTokens: 7_000,
          thresholdPercent: 60,
          idleTimeoutSeconds: 120,
        },
        env: {},
      },
    )
    expect(settings.keepRecentTokens).toBe(7_000)
    expect(settings.thresholdPercent).toBe(60)
    expect(settings.idleTimeoutSeconds).toBe(120)
  })

  test('invalid values with no other source fall back to defaults', () => {
    const settings = resolveSettings(
      {
        keepRecentTokens: -1,
        thresholdTokens: 0,
        midTurnEnabled: 'yes' as unknown as boolean,
        idleThresholdTokens: -10,
      },
      { env: {} },
    )
    expect(settings.keepRecentTokens).toBe(20_000)
    expect(settings.thresholdTokens).toBeUndefined()
    expect(settings.midTurnEnabled).toBe(true)
    expect(settings.idleThresholdTokens).toBe(200_000)
  })

  test('filters unknown method names and rejects an all-invalid order', () => {
    const filtered = resolveSettings(
      { methodOrder: ['soft', 'bogus' as never, 'shake'] },
      { env: {} },
    )
    expect(filtered.methodOrder).toEqual(['soft', 'shake'])

    const allInvalid = resolveSettings(
      { methodOrder: ['bogus' as never] },
      { env: {} },
    )
    expect(allInvalid.methodOrder).toEqual(
      DEFAULT_COMPACTION_SETTINGS.methodOrder,
    )
  })

  test('environment variables override settings.compaction', () => {
    const settings = resolveSettings(undefined, {
      compaction: { keepRecentTokens: 9_000, midTurnEnabled: false },
      env: {
        CLAUDE_CODE_COMPACTION_KEEP_RECENT_TOKENS: '4000',
        CLAUDE_CODE_COMPACTION_MID_TURN_ENABLED: 'true',
        CLAUDE_CODE_COMPACTION_METHOD_ORDER: 'shake, soft',
      },
    })
    expect(settings.keepRecentTokens).toBe(4_000)
    expect(settings.midTurnEnabled).toBe(true)
    expect(settings.methodOrder).toEqual(['shake', 'soft'])
  })

  test('explicit request settings beat environment variables', () => {
    const settings = resolveSettings(
      { keepRecentTokens: 1_234 },
      {
        env: { CLAUDE_CODE_COMPACTION_KEEP_RECENT_TOKENS: '4000' },
      },
    )
    expect(settings.keepRecentTokens).toBe(1_234)
  })

  test('unset or invalid environment variables are ignored', () => {
    const settings = resolveSettings(undefined, {
      compaction: { keepRecentTokens: 6_000 },
      env: {
        CLAUDE_CODE_COMPACTION_KEEP_RECENT_TOKENS: 'not-a-number',
        CLAUDE_CODE_COMPACTION_THRESHOLD_TOKENS: '',
        CLAUDE_CODE_COMPACTION_MID_TURN_ENABLED: 'maybe',
      },
    })
    expect(settings.keepRecentTokens).toBe(6_000)
    expect(settings.thresholdTokens).toBeUndefined()
    expect(settings.midTurnEnabled).toBe(true)
  })

  test('validates environment numeric bounds', () => {
    const settings = resolveSettings(undefined, {
      env: {
        CLAUDE_CODE_COMPACTION_THRESHOLD_PERCENT: '100',
        CLAUDE_CODE_COMPACTION_IDLE_TIMEOUT_SECONDS: '59',
      },
    })
    expect(settings.thresholdPercent).toBeUndefined()
    expect(settings.idleTimeoutSeconds).toBe(300)
  })
})
