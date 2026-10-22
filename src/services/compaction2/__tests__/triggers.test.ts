import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_COMPACTION_SETTINGS,
  type CompactionContext,
  type CompactionSettings,
} from '../contracts.js'
import { evaluateIdleTrigger } from '../triggers/idle.js'
import { evaluateIncompleteTrigger } from '../triggers/incomplete.js'
import { evaluateManualTrigger } from '../triggers/manual.js'
import { evaluateMidTurnTrigger } from '../triggers/midTurn.js'
import { evaluateOverflowTrigger } from '../triggers/overflow.js'
import {
  evaluateThresholdTrigger,
  resolveThresholdDecision,
} from '../triggers/threshold.js'

const settings = DEFAULT_COMPACTION_SETTINGS
const WINDOW = 200_000

function ctx(): CompactionContext {
  return {
    model: 'test-model',
    trigger: 'overflow',
    messages: [],
    settings,
    tokenCount: () => 0,
    estimateEntryTokens: () => 0,
    now: () => 0,
  }
}

describe('threshold trigger', () => {
  test('reserve is max(15% window, 16384)', () => {
    const decision = resolveThresholdDecision({
      windowTokens: WINDOW,
      tokenCount: 0,
      settings,
    })
    expect(decision.reserveTokens).toBe(30_000)
    expect(decision.thresholdTokens).toBe(170_000)
    expect(decision.progressTargetTokens).toBe(136_000)

    const small = resolveThresholdDecision({
      windowTokens: 50_000,
      tokenCount: 0,
      settings,
    })
    expect(small.reserveTokens).toBe(16_384)
  })

  test('fires only above the threshold', () => {
    expect(
      evaluateThresholdTrigger({
        windowTokens: WINDOW,
        tokenCount: 170_000,
        settings,
      }).shouldCompact,
    ).toBe(false)
    expect(
      evaluateThresholdTrigger({
        windowTokens: WINDOW,
        tokenCount: 170_001,
        settings,
      }).shouldCompact,
    ).toBe(true)
  })

  test('honors explicit threshold settings', () => {
    const fixed = resolveThresholdDecision({
      windowTokens: WINDOW,
      tokenCount: 0,
      settings: { ...settings, thresholdTokens: 120_000 },
    })
    expect(fixed.thresholdTokens).toBe(120_000)

    const percent = resolveThresholdDecision({
      windowTokens: WINDOW,
      tokenCount: 0,
      settings: { ...settings, thresholdPercent: 50 },
    })
    expect(percent.thresholdTokens).toBe(100_000)
  })
})

describe('mid-turn trigger', () => {
  test('requires midTurnEnabled', () => {
    const over = { windowTokens: WINDOW, tokenCount: 180_000, settings }
    expect(evaluateMidTurnTrigger(over).shouldCompact).toBe(true)

    const disabled: CompactionSettings = { ...settings, midTurnEnabled: false }
    const decision = evaluateMidTurnTrigger({ ...over, settings: disabled })
    expect(decision.shouldCompact).toBe(false)
    expect(decision.reason).toBe('mid-turn-disabled')
  })
})

describe('manual trigger', () => {
  test('always runs and carries the threshold', () => {
    const decision = evaluateManualTrigger({
      windowTokens: WINDOW,
      tokenCount: 1_000,
      settings,
    })
    expect(decision.shouldCompact).toBe(true)
    expect(decision.threshold.thresholdTokens).toBe(170_000)
  })
})

describe('incomplete trigger', () => {
  test('fires for a length stop above the threshold', () => {
    const base = { windowTokens: WINDOW, settings }
    expect(
      evaluateIncompleteTrigger({
        ...base,
        tokenCount: 180_000,
        stopReason: 'length',
      }).shouldCompact,
    ).toBe(true)
    expect(
      evaluateIncompleteTrigger({
        ...base,
        tokenCount: 160_000,
        stopReason: 'length',
      }).shouldCompact,
    ).toBe(false)
    expect(
      evaluateIncompleteTrigger({
        ...base,
        tokenCount: 180_000,
        stopReason: 'end_turn',
      }).shouldCompact,
    ).toBe(false)
  })

  test('fires for an unknown window', () => {
    expect(
      evaluateIncompleteTrigger({
        windowTokens: 0,
        tokenCount: 1,
        settings,
        stopReason: 'max_tokens',
      }).shouldCompact,
    ).toBe(true)
  })
})

describe('idle trigger', () => {
  const idleSettings: CompactionSettings = {
    ...settings,
    idleEnabled: true,
    idleThresholdTokens: 100,
    idleTimeoutSeconds: 300,
  }

  test('is off by default', () => {
    expect(
      evaluateIdleTrigger({
        windowTokens: WINDOW,
        tokenCount: 200_000,
        settings,
        lastActivityAt: 0,
        now: 10_000_000,
      }).shouldCompact,
    ).toBe(false)
  })

  test('fires after the timeout at or above the idle threshold', () => {
    expect(
      evaluateIdleTrigger({
        windowTokens: WINDOW,
        tokenCount: 200,
        settings: idleSettings,
        lastActivityAt: 0,
        now: 300_000,
      }).shouldCompact,
    ).toBe(true)
    expect(
      evaluateIdleTrigger({
        windowTokens: WINDOW,
        tokenCount: 200,
        settings: idleSettings,
        lastActivityAt: 0,
        now: 299_999,
      }).shouldCompact,
    ).toBe(false)
  })
})

describe('overflow trigger', () => {
  test('promotes context before compacting', async () => {
    const promotion = {
      isAvailable: () => true,
      promote: () => ({ kind: 'promoted' as const, model: 'bigger-model' }),
    }
    const decision = await evaluateOverflowTrigger({
      windowTokens: WINDOW,
      tokenCount: 250_000,
      settings,
      ctx: ctx(),
      overflowDetected: true,
      promotion,
    })
    expect(decision.shouldCompact).toBe(false)
    expect(decision.promotion).toEqual({
      kind: 'promoted',
      model: 'bigger-model',
    })
    expect(decision.reason).toContain('context-promoted')
  })

  test('falls through to compaction when promotion is skipped', async () => {
    const decision = await evaluateOverflowTrigger({
      windowTokens: WINDOW,
      tokenCount: 250_000,
      settings,
      ctx: ctx(),
      overflowDetected: true,
    })
    expect(decision.shouldCompact).toBe(true)
    expect(decision.promotion).toEqual({
      kind: 'skipped',
      reason: 'no-promotion-configured',
    })
  })

  test('treats usage above the window as overflow evidence', async () => {
    const decision = await evaluateOverflowTrigger({
      windowTokens: WINDOW,
      tokenCount: 250_000,
      settings,
      ctx: ctx(),
    })
    expect(decision.shouldCompact).toBe(true)
  })

  test('blocks on a payload rejection that does not prove token overflow', async () => {
    const decision = await evaluateOverflowTrigger({
      windowTokens: WINDOW,
      tokenCount: 100_000,
      settings,
      ctx: ctx(),
      overflowDetected: true,
      payloadRejection: { status: 413, message: 'request too large' },
    })
    expect(decision.shouldCompact).toBe(false)
    expect(decision.reason).toContain('payload-rejection')
    expect(decision.payload?.tokenOverflowProven).toBe(false)
  })

  test('allows compaction when provider usage proves token overflow', async () => {
    const decision = await evaluateOverflowTrigger({
      windowTokens: WINDOW,
      tokenCount: 100_000,
      settings,
      ctx: ctx(),
      overflowDetected: true,
      payloadRejection: {
        status: 413,
        message: 'request too large',
        providerInputTokens: 250_000,
      },
    })
    expect(decision.shouldCompact).toBe(true)
    expect(decision.payload?.tokenOverflowProven).toBe(true)
    expect(decision.payload?.blockCompaction).toBe(false)
  })
})
