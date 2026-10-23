import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_COMPACTION_SETTINGS,
  type CompactionContext,
} from '../../contracts.js'
import { evaluateIncompleteTrigger } from '../../triggers/incomplete.js'
import { evaluateOverflowTrigger } from '../../triggers/overflow.js'
import {
  applyPromotionDecision,
  collectPromotionCandidates,
  createContextPromotion,
  selectPromotion,
  type PromotionCandidate,
} from '../../triggers/promotion.js'
import { evaluateThresholdTrigger } from '../../triggers/threshold.js'
import type { PromotionResult } from '../../triggers/types.js'

const candidates: PromotionCandidate[] = [
  { model: 'small', windowTokens: 100_000 },
  { model: 'medium', windowTokens: 500_000 },
  { model: 'large', windowTokens: 1_000_000 },
  { model: 'same', windowTokens: 200_000 },
  { model: 'smaller', windowTokens: 50_000 },
]

function ctx(model = 'current'): CompactionContext {
  return {
    model,
    trigger: 'overflow',
    messages: [],
    settings: DEFAULT_COMPACTION_SETTINGS,
    tokenCount: () => 0,
    estimateEntryTokens: () => 0,
    now: () => 0,
  }
}

describe('selectPromotion', () => {
  test('picks the largest strictly larger window', () => {
    expect(selectPromotion('current', 200_000, candidates)).toEqual({
      model: 'large',
      windowTokens: 1_000_000,
    })
  })

  test('ignores candidates with the same or a smaller window', () => {
    const narrow = candidates.filter(c => ['same', 'smaller'].includes(c.model))
    expect(selectPromotion('current', 200_000, narrow)).toBeUndefined()
  })

  test('never selects the current model', () => {
    expect(
      selectPromotion('large', 200_000, [
        { model: 'large', windowTokens: 2_000_000 },
      ]),
    ).toBeUndefined()
  })

  test('returns undefined without candidates or a known window', () => {
    expect(selectPromotion('current', 200_000, [])).toBeUndefined()
    expect(selectPromotion('current', 200_000, undefined)).toBeUndefined()
    expect(selectPromotion('current', 0, candidates)).toBeUndefined()
  })
})

describe('collectPromotionCandidates', () => {
  test('merges overrides and explicit models, keeping max', () => {
    const collected = collectPromotionCandidates({
      windowOverrides: { medium: 600_000, proxy: 2_000_000 },
      candidates: [
        { model: 'medium', windowTokens: 500_000 },
        { model: 'explicit', windowTokens: 300_000 },
      ],
    })
    expect(collected).toEqual(
      expect.arrayContaining([
        { model: 'medium', windowTokens: 600_000 },
        { model: 'proxy', windowTokens: 2_000_000 },
        { model: 'explicit', windowTokens: 300_000 },
      ]),
    )
    expect(collected).toHaveLength(3)
  })

  test('drops invalid entries', () => {
    expect(
      collectPromotionCandidates({
        windowOverrides: { bad: 0, worse: -1 },
        candidates: [{ model: '', windowTokens: 100 }],
      }),
    ).toEqual([])
  })
})

describe('createContextPromotion', () => {
  test('reports a promotion decision for a larger candidate', () => {
    const promotion = createContextPromotion({
      candidates,
      resolveWindow: () => 200_000,
    })
    expect(promotion.isAvailable(ctx())).toBe(true)
    expect(promotion.promote(ctx())).toEqual({
      kind: 'promoted',
      model: 'large',
      reason: 'larger-window:1000000',
    })
  })

  test('skips when no larger candidate exists', () => {
    const promotion = createContextPromotion({
      candidates: [{ model: 'same', windowTokens: 200_000 }],
      resolveWindow: () => 200_000,
    })
    expect(promotion.isAvailable(ctx())).toBe(false)
    expect(promotion.promote(ctx())).toEqual({
      kind: 'skipped',
      reason: 'no-larger-context-candidate',
    })
  })

  test('drives the overflow trigger decision without compacting', async () => {
    const promotion = createContextPromotion({
      candidates,
      resolveWindow: () => 200_000,
    })
    const decision = await evaluateOverflowTrigger({
      windowTokens: 200_000,
      tokenCount: 250_000,
      settings: DEFAULT_COMPACTION_SETTINGS,
      ctx: ctx(),
      overflowDetected: true,
      promotion,
    })
    expect(decision.shouldCompact).toBe(false)
    expect(decision.reason).toBe('context-promoted: large')
    expect(decision.promotion).toEqual({
      kind: 'promoted',
      model: 'large',
      reason: 'larger-window:1000000',
    })
  })
})

describe('applyPromotionDecision', () => {
  const WINDOW = 200_000
  const OVER_THRESHOLD = 180_000
  const promoted: PromotionResult = {
    kind: 'promoted',
    model: 'large',
    reason: 'larger-window:1000000',
  }

  test('threshold: a promoted candidate suppresses compaction', () => {
    const decision = evaluateThresholdTrigger({
      tokenCount: OVER_THRESHOLD,
      windowTokens: WINDOW,
      settings: DEFAULT_COMPACTION_SETTINGS,
    })
    expect(decision.shouldCompact).toBe(true)
    expect(applyPromotionDecision(decision, promoted)).toMatchObject({
      trigger: 'threshold',
      shouldCompact: false,
      reason: 'context-promoted: large',
      promotion: promoted,
    })
  })

  test('incomplete: a promoted candidate suppresses compaction', () => {
    const decision = evaluateIncompleteTrigger({
      tokenCount: OVER_THRESHOLD,
      windowTokens: WINDOW,
      settings: DEFAULT_COMPACTION_SETTINGS,
      stopReason: 'max_tokens',
    })
    expect(decision.shouldCompact).toBe(true)
    expect(applyPromotionDecision(decision, promoted)).toMatchObject({
      trigger: 'incomplete',
      shouldCompact: false,
      reason: 'context-promoted: large',
      promotion: promoted,
    })
  })

  test('a skipped decision keeps compaction and only records the reason', () => {
    const decision = evaluateThresholdTrigger({
      tokenCount: OVER_THRESHOLD,
      windowTokens: WINDOW,
      settings: DEFAULT_COMPACTION_SETTINGS,
    })
    const skipped: PromotionResult = {
      kind: 'skipped',
      reason: 'no-larger-context-candidate',
    }
    expect(applyPromotionDecision(decision, skipped)).toMatchObject({
      shouldCompact: true,
      promotion: skipped,
    })
  })
})
