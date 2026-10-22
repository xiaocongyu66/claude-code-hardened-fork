// Ported from oh-my-pi (MIT). See THIRD_PARTY_NOTICES.md in this directory.
import { resolveThresholdDecision } from './threshold.js'
import type { ThresholdInput, TriggerDecision } from './types.js'

/**
 * Manual `/compact [instructions]` always runs; the threshold is only carried
 * along for the progress guard and decision trace.
 */
export function evaluateManualTrigger(input: ThresholdInput): TriggerDecision {
  return {
    trigger: 'manual',
    shouldCompact: true,
    reason: 'manual-compact',
    threshold: resolveThresholdDecision(input),
  }
}
