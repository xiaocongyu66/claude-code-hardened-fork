import { describe, expect, test } from 'bun:test'
import { SettingsSchema } from '../../../../utils/settings/types.js'

describe('SettingsSchema compaction', () => {
  test('accepts settings without a compaction object', () => {
    const result = SettingsSchema().safeParse({ model: 'sonnet' })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.compaction).toBeUndefined()
    }
  })

  test('accepts a valid compaction policy', () => {
    const result = SettingsSchema().safeParse({
      compaction: {
        enabled: false,
        methodOrder: ['handoff', 'soft'],
        thresholdTokens: 120_000,
        thresholdPercent: 80,
        reserveTokens: 20_000,
        keepRecentTokens: 12_000,
        midTurnEnabled: false,
        autoContinue: false,
        asyncEnabled: false,
        idleEnabled: true,
        idleThresholdTokens: 250_000,
        idleTimeoutSeconds: 120,
      },
    })
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data.compaction).toEqual({
      enabled: false,
      methodOrder: ['handoff', 'soft'],
      thresholdTokens: 120_000,
      thresholdPercent: 80,
      reserveTokens: 20_000,
      keepRecentTokens: 12_000,
      midTurnEnabled: false,
      autoContinue: false,
      asyncEnabled: false,
      idleEnabled: true,
      idleThresholdTokens: 250_000,
      idleTimeoutSeconds: 120,
    })
  })

  test('drops invalid fields instead of rejecting the settings file', () => {
    const result = SettingsSchema().safeParse({
      compaction: {
        enabled: 'yes',
        thresholdTokens: 0,
        thresholdPercent: 100,
        reserveTokens: -1,
        keepRecentTokens: -5,
        midTurnEnabled: 'sometimes',
        idleTimeoutSeconds: 30,
      },
    })
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data.compaction).toEqual({})
  })

  test('filters unknown method names and keeps known ones', () => {
    const result = SettingsSchema().safeParse({
      compaction: {
        methodOrder: ['soft', 'bogus', 'shake', 42, 'remote'],
      },
    })
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data.compaction?.methodOrder).toEqual([
      'soft',
      'shake',
      'remote',
    ])
  })

  test('returns an empty method order when every name is unknown', () => {
    const result = SettingsSchema().safeParse({
      compaction: { methodOrder: ['nope', 'also-nope'] },
    })
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data.compaction?.methodOrder).toEqual([])
  })

  test('rejects a non-array method order by dropping the field', () => {
    const result = SettingsSchema().safeParse({
      compaction: { methodOrder: 'soft' },
    })
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data.compaction?.methodOrder).toBeUndefined()
  })

  test('drops a non-object compaction value without rejecting the file', () => {
    const result = SettingsSchema().safeParse({ compaction: 'nope' })
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data.compaction).toBeUndefined()
  })

  test('enforces numeric boundaries', () => {
    const atBounds = SettingsSchema().safeParse({
      compaction: {
        thresholdPercent: 1,
        idleTimeoutSeconds: 60,
        keepRecentTokens: 0,
      },
    })
    expect(atBounds.success).toBe(true)

    const outOfBounds = SettingsSchema().safeParse({
      compaction: {
        thresholdPercent: 0,
        idleTimeoutSeconds: 59,
        keepRecentTokens: -1,
      },
    })
    expect(outOfBounds.success).toBe(true)
    if (!outOfBounds.success) return
    expect(outOfBounds.data.compaction).toEqual({})
  })
})
