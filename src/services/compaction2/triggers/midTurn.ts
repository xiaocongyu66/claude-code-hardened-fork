import { evaluateThresholdTrigger } from './threshold.js'
import type { ThresholdInput, TriggerDecision } from './types.js'

/**
 * Mid-turn maintenance: the same threshold check, evaluated before the next
 * provider request inside a tool loop and gated by `midTurnEnabled`.
 */
export function evaluateMidTurnTrigger(input: ThresholdInput): TriggerDecision {
  if (!input.settings.midTurnEnabled) {
    const threshold = evaluateThresholdTrigger(input).threshold
    return {
      trigger: 'midTurn',
      shouldCompact: false,
      reason: 'mid-turn-disabled',
      threshold,
    }
  }
  const decision = evaluateThresholdTrigger(input)
  return {
    ...decision,
    trigger: 'midTurn',
    reason: decision.shouldCompact
      ? `mid-turn context ${decision.threshold.tokenCount} > threshold ${decision.threshold.thresholdTokens}`
      : `mid-turn context ${decision.threshold.tokenCount} <= threshold ${decision.threshold.thresholdTokens}`,
  }
}
