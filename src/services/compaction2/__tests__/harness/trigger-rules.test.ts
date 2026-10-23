// Pure-function coverage for the trigger selection / dedup rules that sit
// between the query loop and the replay fixtures. These are the loop-level
// gates the orchestrator fixtures cannot reach (they run one trigger per
// call), so they are pinned directly against `loop.ts` and `promotion.ts`.
import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_COMPACTION_SETTINGS,
  type CompactionSettings,
} from '../../contracts.js'
import { evaluateProgressGuard } from '../../guards/progress.js'
import {
  consumeMidTurnSkip,
  createLoopCompactionState,
  isIncompleteStop,
  markMidTurnConsumed,
  shouldAttemptIncompleteRecovery,
  shouldAttemptMidTurn,
} from '../../triggers/loop.js'
import {
  collectPromotionCandidates,
  createContextPromotion,
  selectPromotion,
  type PromotionCandidate,
} from '../../triggers/promotion.js'

const WINDOW = 200_000
// reserve = max(15% of 200k, 16384) = 30k → threshold = 170k
const OVER = 180_000
const UNDER = 160_000

const midTurnOff: CompactionSettings = {
  ...DEFAULT_COMPACTION_SETTINGS,
  midTurnEnabled: false,
}

describe('incomplete-output selection and dedup', () => {
  test('recognizes every incomplete stop reason', () => {
    expect(isIncompleteStop('length')).toBe(true)
    expect(isIncompleteStop('max_tokens')).toBe(true)
    expect(isIncompleteStop('model_context_window_exceeded')).toBe(true)
    expect(isIncompleteStop('end_turn')).toBe(false)
    expect(isIncompleteStop(null)).toBe(false)
    expect(isIncompleteStop(undefined)).toBe(false)
  })

  test('length and max_tokens recover only above the threshold', () => {
    for (const stopReason of ['length', 'max_tokens'] as const) {
      expect(
        shouldAttemptIncompleteRecovery({
          v2Enabled: true,
          stopReason,
          tokenCount: OVER,
          windowTokens: WINDOW,
          alreadyAttempted: false,
        }),
      ).toBe(true)
      expect(
        shouldAttemptIncompleteRecovery({
          v2Enabled: true,
          stopReason,
          tokenCount: UNDER,
          windowTokens: WINDOW,
          alreadyAttempted: false,
        }),
      ).toBe(false)
    }
  })

  test('a model-context-window stop recovers with an unknown window', () => {
    expect(
      shouldAttemptIncompleteRecovery({
        v2Enabled: true,
        stopReason: 'model_context_window_exceeded',
        tokenCount: 1,
        windowTokens: 0,
        alreadyAttempted: false,
      }),
    ).toBe(true)
  })

  test('normal stops never recover', () => {
    expect(
      shouldAttemptIncompleteRecovery({
        v2Enabled: true,
        stopReason: 'end_turn',
        tokenCount: OVER,
        windowTokens: WINDOW,
        alreadyAttempted: false,
      }),
    ).toBe(false)
  })

  test('the per-turn attempt flag dedups even for a recoverable stop', () => {
    expect(
      shouldAttemptIncompleteRecovery({
        v2Enabled: true,
        stopReason: 'length',
        tokenCount: OVER,
        windowTokens: WINDOW,
        alreadyAttempted: true,
      }),
    ).toBe(false)
  })

  test('flag off never selects incomplete recovery', () => {
    expect(
      shouldAttemptIncompleteRecovery({
        v2Enabled: false,
        stopReason: 'max_tokens',
        tokenCount: OVER,
        windowTokens: WINDOW,
        alreadyAttempted: false,
      }),
    ).toBe(false)
  })
})

describe('mid-turn selection and dedup', () => {
  test('fires above the threshold and skips below it', () => {
    expect(
      shouldAttemptMidTurn({
        enabled: true,
        thresholdAttemptedThisIteration: false,
        tokenCount: OVER,
        windowTokens: WINDOW,
      }),
    ).toBe(true)
    expect(
      shouldAttemptMidTurn({
        enabled: true,
        thresholdAttemptedThisIteration: false,
        tokenCount: UNDER,
        windowTokens: WINDOW,
      }),
    ).toBe(false)
  })

  test('midTurnEnabled=false disables the pass', () => {
    expect(
      shouldAttemptMidTurn({
        enabled: true,
        thresholdAttemptedThisIteration: false,
        tokenCount: OVER,
        windowTokens: WINDOW,
        settings: midTurnOff,
      }),
    ).toBe(false)
  })

  test('a threshold pass in the same iteration dedups mid-turn', () => {
    expect(
      shouldAttemptMidTurn({
        enabled: true,
        thresholdAttemptedThisIteration: true,
        tokenCount: OVER,
        windowTokens: WINDOW,
      }),
    ).toBe(false)
  })

  test('the one-shot skip flag is consumed exactly once', () => {
    const state = createLoopCompactionState()
    expect(consumeMidTurnSkip(state)).toBe(false)
    markMidTurnConsumed(state)
    expect(consumeMidTurnSkip(state)).toBe(true)
    // A second top-of-loop check must not skip again.
    expect(consumeMidTurnSkip(state)).toBe(false)
  })

  test('flag off never selects mid-turn', () => {
    expect(
      shouldAttemptMidTurn({
        enabled: false,
        thresholdAttemptedThisIteration: false,
        tokenCount: OVER,
        windowTokens: WINDOW,
      }),
    ).toBe(false)
  })
})

describe('progress guard boundary', () => {
  test('exactly 80% passes; one token over fails', () => {
    expect(evaluateProgressGuard(170_000, 136_000).ok).toBe(true)
    expect(evaluateProgressGuard(170_000, 136_001).ok).toBe(false)
    expect(evaluateProgressGuard(170_000, 136_001).reason).toBe(
      'post-compaction context 136001 exceeds 136000 (80% of 170000)',
    )
  })

  test('the target floors fractional 80% values', () => {
    // floor(170_001 * 0.8) = 136_000
    expect(evaluateProgressGuard(170_001, 136_000).ok).toBe(true)
    expect(evaluateProgressGuard(170_001, 136_001).ok).toBe(false)
  })

  test('headroom is signed', () => {
    expect(evaluateProgressGuard(170_000, 136_000).headroomTokens).toBe(34_000)
    expect(evaluateProgressGuard(170_000, 180_000).headroomTokens).toBe(-10_000)
  })
})

describe('promotion decision', () => {
  const candidates: PromotionCandidate[] = [
    { model: 'medium', windowTokens: 500_000 },
    { model: 'large', windowTokens: 1_000_000 },
    { model: 'same', windowTokens: 200_000 },
    { model: 'smaller', windowTokens: 50_000 },
  ]

  test('picks the largest strictly larger window', () => {
    expect(selectPromotion('current', WINDOW, candidates)).toEqual({
      model: 'large',
      windowTokens: 1_000_000,
    })
  })

  test('no candidate or same/smaller windows skip promotion', () => {
    expect(selectPromotion('current', WINDOW, [])).toBeUndefined()
    expect(selectPromotion('current', WINDOW, undefined)).toBeUndefined()
    expect(
      selectPromotion('current', WINDOW, [
        { model: 'same', windowTokens: WINDOW },
        { model: 'smaller', windowTokens: 50_000 },
      ]),
    ).toBeUndefined()
  })

  test('the current model is never a promotion target', () => {
    expect(
      selectPromotion('current', WINDOW, [
        { model: 'current', windowTokens: 2_000_000 },
      ]),
    ).toBeUndefined()
  })

  test('an unknown current window cannot promote', () => {
    expect(selectPromotion('current', 0, candidates)).toBeUndefined()
  })

  test('collectPromotionCandidates keeps the larger duplicate window', () => {
    expect(
      collectPromotionCandidates({
        windowOverrides: { medium: 600_000 },
        candidates: [{ model: 'medium', windowTokens: 500_000 }],
      }),
    ).toEqual([{ model: 'medium', windowTokens: 600_000 }])
  })

  test('createContextPromotion reports the same-window skip', () => {
    const promotion = createContextPromotion({
      candidates: [{ model: 'same', windowTokens: WINDOW }],
      resolveWindow: () => WINDOW,
    })
    expect(promotion.isAvailable({} as never)).toBe(false)
    expect(promotion.promote({} as never)).toEqual({
      kind: 'skipped',
      reason: 'no-larger-context-candidate',
    })
  })
})
