import { describe, expect, test } from 'bun:test'
import { DEFAULT_COMPACTION_SETTINGS } from '../contracts.js'
import { evaluateSpeculation } from '../triggers/speculation.js'

const settings = DEFAULT_COMPACTION_SETTINGS

describe('speculative compaction band', () => {
  test('lead is clamp(threshold × 0.125, 8192, 32000)', () => {
    const decision = evaluateSpeculation({
      thresholdTokens: 200_000,
      tokenCount: 180_000,
      settings,
    })
    expect(decision.leadTokens).toBe(25_000)
    expect(decision.bandLowTokens).toBe(175_000)
    expect(decision.bandHighTokens).toBe(200_000)
    expect(decision.inBand).toBe(true)
    expect(decision.eligible).toBe(true)
    expect(decision.method).toBe('remote')
  })

  test('outside the band is not eligible', () => {
    expect(
      evaluateSpeculation({
        thresholdTokens: 200_000,
        tokenCount: 174_999,
        settings,
      }).eligible,
    ).toBe(false)
    // Band is half-open: exactly at the threshold is too late.
    expect(
      evaluateSpeculation({
        thresholdTokens: 200_000,
        tokenCount: 200_000,
        settings,
      }).eligible,
    ).toBe(false)
  })

  test('respects asyncEnabled', () => {
    const decision = evaluateSpeculation({
      thresholdTokens: 200_000,
      tokenCount: 180_000,
      settings: { ...settings, asyncEnabled: false },
    })
    expect(decision.inBand).toBe(true)
    expect(decision.eligible).toBe(false)
    expect(decision.reason).toBe('async-disabled')
  })

  test('picks the first available LLM-backed method', () => {
    const decision = evaluateSpeculation({
      thresholdTokens: 200_000,
      tokenCount: 180_000,
      settings,
      availableMethods: ['handoff', 'soft'],
    })
    expect(decision.eligible).toBe(true)
    expect(decision.method).toBe('handoff')
  })

  test('local-only methods are never speculated', () => {
    const decision = evaluateSpeculation({
      thresholdTokens: 200_000,
      tokenCount: 180_000,
      settings,
      availableMethods: ['snapcompact', 'shake'],
    })
    expect(decision.eligible).toBe(false)
    expect(decision.reason).toBe('no-llm-backed-method-available')
  })
})
