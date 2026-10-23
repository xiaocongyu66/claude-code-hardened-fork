import { describe, expect, test } from 'bun:test'
import {
  decidePromotionRetry,
  type PromotionAttempt,
} from '../../triggers/promotion.js'
import type { PromotionResult } from '../../triggers/types.js'

const promoted: PromotionResult = {
  kind: 'promoted',
  model: 'large',
  reason: 'larger-window:1000000',
}

const noCandidate: PromotionResult = {
  kind: 'skipped',
  reason: 'no-larger-context-candidate',
}

describe('decidePromotionRetry', () => {
  test('switches to a strictly larger candidate', () => {
    expect(
      decidePromotionRetry({
        currentModel: 'current',
        promotion: promoted,
      }),
    ).toEqual({
      kind: 'retry',
      originalModel: 'current',
      targetModel: 'large',
    })
  })

  test('skips when the overflow trigger found no candidate', () => {
    expect(
      decidePromotionRetry({
        currentModel: 'current',
        promotion: noCandidate,
      }),
    ).toEqual({ kind: 'skip', reason: 'no-larger-context-candidate' })
  })

  test('skips without a promotion decision at all', () => {
    expect(
      decidePromotionRetry({ currentModel: 'current', promotion: undefined }),
    ).toEqual({ kind: 'skip', reason: 'no-promotion-candidate' })
  })

  test('skips a target that is the current model (same window)', () => {
    expect(
      decidePromotionRetry({
        currentModel: 'large',
        promotion: { kind: 'promoted', model: 'large' },
      }),
    ).toEqual({ kind: 'skip', reason: 'promotion-target-is-current-model' })
  })

  test('never promotes twice while an attempt is in flight', () => {
    const attempt: PromotionAttempt = {
      originalModel: 'current',
      targetModel: 'large',
    }
    expect(
      decidePromotionRetry({
        currentModel: 'large',
        promotion: promoted,
        attempt,
      }),
    ).toEqual({ kind: 'skip', reason: 'promotion-already-attempted' })
  })

  test('reverts to the original model when the retry overflows again', () => {
    const attempt: PromotionAttempt = {
      originalModel: 'current',
      targetModel: 'large',
    }
    expect(
      decidePromotionRetry({
        currentModel: 'large',
        attempt,
        retryFailed: true,
      }),
    ).toEqual({
      kind: 'revert',
      originalModel: 'current',
      targetModel: 'large',
      reason: 'promotion-retry-failed',
    })
  })
})

type StepOutcome = 'overflow' | 'ok'

/**
 * Minimal simulation of the query overflow branch: each `overflow` step asks
 * for a promotion decision, a retry re-runs the same request on the new
 * model, and a skip falls through to compaction. Mirrors the retry-once /
 * revert-on-failure rules in query.ts without touching the API.
 */
function runOverflowLoop(
  outcomes: readonly StepOutcome[],
  promotion: PromotionResult | undefined,
) {
  let model = 'current'
  let attempt: PromotionAttempt | undefined
  const models = [model]
  let reverted = false
  let compacted = false
  let surfaced: string | undefined

  for (const outcome of outcomes) {
    if (outcome === 'ok') break
    const decision = decidePromotionRetry({
      currentModel: model,
      promotion,
      attempt,
      retryFailed: attempt !== undefined,
    })
    if (decision.kind === 'retry') {
      model = decision.targetModel
      attempt = {
        originalModel: decision.originalModel,
        targetModel: decision.targetModel,
      }
      models.push(model)
      continue
    }
    if (decision.kind === 'revert') {
      model = decision.originalModel
      models.push(model)
      reverted = true
      surfaced = 'original-error'
      break
    }
    compacted = true
    break
  }

  return { models, reverted, compacted, surfaced }
}

describe('overflow promotion retry loop', () => {
  test('retries exactly once and succeeds on the larger model', () => {
    expect(runOverflowLoop(['overflow', 'ok'], promoted)).toEqual({
      models: ['current', 'large'],
      reverted: false,
      compacted: false,
      surfaced: undefined,
    })
  })

  test('reverts to the original model and surfaces the original error', () => {
    expect(runOverflowLoop(['overflow', 'overflow'], promoted)).toEqual({
      models: ['current', 'large', 'current'],
      reverted: true,
      compacted: false,
      surfaced: 'original-error',
    })
  })

  test('does not retry a third time after a failed retry', () => {
    expect(
      runOverflowLoop(['overflow', 'overflow', 'overflow'], promoted).models,
    ).toEqual(['current', 'large', 'current'])
  })

  test('falls through to compaction when promotion is unavailable', () => {
    expect(runOverflowLoop(['overflow'], noCandidate)).toEqual({
      models: ['current'],
      reverted: false,
      compacted: true,
      surfaced: undefined,
    })
  })
})
