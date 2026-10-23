import { describe, expect, test } from 'bun:test'
import {
  consumeMidTurnSkip,
  createLoopCompactionState,
  markMidTurnConsumed,
} from '../../triggers/loop.js'
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

type TriggerKind = 'threshold' | 'incomplete' | 'overflow'
type RequestOutcome = 'ok' | 'overflow' | 'incomplete'

interface TriggerLoopInput {
  trigger: TriggerKind
  /** One entry per provider request, in order. */
  outcomes: readonly RequestOutcome[]
  promotion: PromotionResult | undefined
  /** Models whose context is still over the threshold. */
  overThresholdModels?: readonly string[]
  /** A mid-turn pass already covered the first iteration. */
  midTurnConsumedFirst?: boolean
}

/**
 * Simulation of the three promotion sites in query.ts. Threshold promotion
 * happens before a request is sent; incomplete promotion replaces a truncated
 * request with a retry; overflow promotion follows a 413. All three share the
 * same single-shot attempt: a retry that fails reverts to the original model.
 */
function runTriggerLoop(input: TriggerLoopInput) {
  const overThreshold = new Set(input.overThresholdModels ?? ['current'])
  const loopState = createLoopCompactionState()
  if (input.midTurnConsumedFirst) markMidTurnConsumed(loopState)

  let model = 'current'
  let attempt: PromotionAttempt | undefined
  let retryInFlight = false
  let index = 0
  const models = [model]
  const events: string[] = []
  let compacted = false
  let reverted = false
  let surfaced: string | undefined

  const promote = (): boolean => {
    const decision = decidePromotionRetry({
      currentModel: model,
      promotion: input.promotion,
      attempt,
    })
    if (decision.kind !== 'retry') return false
    model = decision.targetModel
    models.push(model)
    attempt = {
      originalModel: decision.originalModel,
      targetModel: decision.targetModel,
    }
    retryInFlight = true
    return true
  }

  const revert = (): boolean => {
    const decision = decidePromotionRetry({
      currentModel: model,
      attempt,
      retryFailed: true,
    })
    if (decision.kind !== 'revert') return false
    model = decision.originalModel
    models.push(model)
    reverted = true
    return true
  }

  // Each iteration normally consumes one request outcome; a threshold
  // promotion adds one iteration that sends no request (the retry iteration
  // consumes the next outcome), hence the small guard.
  const maxIterations = input.outcomes.length + 3
  for (let iteration = 0; iteration < maxIterations; iteration++) {
    if (compacted || reverted) break
    const midTurnSkip = consumeMidTurnSkip(loopState)

    if (input.trigger === 'threshold') {
      if (midTurnSkip) {
        events.push('threshold-skipped')
      } else if (overThreshold.has(model)) {
        if (promote()) {
          events.push('threshold-promote')
          continue
        }
        compacted = true
        events.push('threshold-compact')
        break
      }
    }

    if (index >= input.outcomes.length) break
    const outcome = input.outcomes[index++]!
    if (outcome === 'ok') {
      retryInFlight = false
      events.push('ok')
      break
    }

    if (outcome === 'overflow' && retryInFlight && attempt) {
      if (revert()) {
        events.push('revert-overflow')
        surfaced = 'error'
        break
      }
    }
    if (outcome === 'incomplete' && retryInFlight && attempt) {
      if (revert()) {
        events.push('revert-incomplete')
        surfaced = 'truncated'
        break
      }
    }

    // Every trigger consults promotion before compaction. A 413 on an
    // iteration whose threshold pass was deduplicated goes through the
    // overflow site, not the threshold site.
    if (promote()) {
      const site =
        input.trigger === 'threshold' && midTurnSkip
          ? 'overflow'
          : input.trigger
      events.push(`${site}-promote`)
      continue
    }
    compacted = true
    events.push(`${input.trigger}-compact`)
    break
  }

  return { models, events, compacted, reverted, surfaced }
}

describe('threshold/incomplete promotion loop', () => {
  test('threshold promotes before sending the request, then succeeds', () => {
    expect(
      runTriggerLoop({
        trigger: 'threshold',
        outcomes: ['ok'],
        promotion: promoted,
      }),
    ).toEqual({
      models: ['current', 'large'],
      events: ['threshold-promote', 'ok'],
      compacted: false,
      reverted: false,
      surfaced: undefined,
    })
  })

  test('threshold compacts when there is no larger candidate', () => {
    expect(
      runTriggerLoop({
        trigger: 'threshold',
        outcomes: [],
        promotion: noCandidate,
      }),
    ).toEqual({
      models: ['current'],
      events: ['threshold-compact'],
      compacted: true,
      reverted: false,
      surfaced: undefined,
    })
  })

  test('threshold promotion is single-shot: a second pass compacts', () => {
    // The candidate window is only just larger, so the promoted model is
    // still over its threshold on the next iteration.
    expect(
      runTriggerLoop({
        trigger: 'threshold',
        outcomes: [],
        promotion: promoted,
        overThresholdModels: ['current', 'large'],
      }),
    ).toEqual({
      models: ['current', 'large'],
      events: ['threshold-promote', 'threshold-compact'],
      compacted: true,
      reverted: false,
      surfaced: undefined,
    })
  })

  test('incomplete promotes instead of compacting the truncated turn', () => {
    expect(
      runTriggerLoop({
        trigger: 'incomplete',
        outcomes: ['incomplete', 'ok'],
        promotion: promoted,
      }),
    ).toEqual({
      models: ['current', 'large'],
      events: ['incomplete-promote', 'ok'],
      compacted: false,
      reverted: false,
      surfaced: undefined,
    })
  })

  test('incomplete compacts when promotion is unavailable', () => {
    expect(
      runTriggerLoop({
        trigger: 'incomplete',
        outcomes: ['incomplete'],
        promotion: noCandidate,
      }),
    ).toEqual({
      models: ['current'],
      events: ['incomplete-compact'],
      compacted: true,
      reverted: false,
      surfaced: undefined,
    })
  })

  test('a threshold promotion retry that overflows reverts to the original model', () => {
    expect(
      runTriggerLoop({
        trigger: 'threshold',
        outcomes: ['overflow'],
        promotion: promoted,
      }),
    ).toEqual({
      models: ['current', 'large', 'current'],
      events: ['threshold-promote', 'revert-overflow'],
      compacted: false,
      reverted: true,
      surfaced: 'error',
    })
  })

  test('an incomplete promotion retry that is truncated again reverts', () => {
    expect(
      runTriggerLoop({
        trigger: 'incomplete',
        outcomes: ['incomplete', 'incomplete'],
        promotion: promoted,
      }),
    ).toEqual({
      models: ['current', 'large', 'current'],
      events: ['incomplete-promote', 'revert-incomplete'],
      compacted: false,
      reverted: true,
      surfaced: 'truncated',
    })
  })

  test('mid-turn dedupe covers one iteration only and still allows overflow promotion', () => {
    // Iteration 1: the mid-turn pass already ran, so the threshold pass is
    // skipped. The request overflows and promotes. Iteration 2: the skip is
    // gone, so the threshold pass re-runs (on the larger model) instead of
    // being wrongly deduplicated.
    expect(
      runTriggerLoop({
        trigger: 'threshold',
        outcomes: ['overflow', 'ok'],
        promotion: promoted,
        midTurnConsumedFirst: true,
      }),
    ).toEqual({
      models: ['current', 'large'],
      events: ['threshold-skipped', 'overflow-promote', 'ok'],
      compacted: false,
      reverted: false,
      surfaced: undefined,
    })
  })

  test('consumeMidTurnSkip is one-shot, so a promotion retry is not skipped', () => {
    const state = createLoopCompactionState()
    markMidTurnConsumed(state)
    expect(consumeMidTurnSkip(state)).toBe(true)
    expect(consumeMidTurnSkip(state)).toBe(false)
  })
})
