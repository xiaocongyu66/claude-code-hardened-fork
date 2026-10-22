// Ported from oh-my-pi (MIT). See THIRD_PARTY_NOTICES.md in this directory.
import { resolveThresholdDecision } from './threshold.js'
import type { ThresholdInput, TriggerDecision } from './types.js'

export interface IdleInput extends ThresholdInput {
  lastActivityAt?: number
  /** Injected clock; no timers are armed by this module. */
  now?: number
}

/**
 * Idle maintenance decision. Pure: the caller owns the clock and the
 * "not streaming / not compacting" preconditions.
 */
export function evaluateIdleTrigger(input: IdleInput): TriggerDecision {
  const threshold = resolveThresholdDecision(input)
  if (!input.settings.idleEnabled) {
    return {
      trigger: 'idle',
      shouldCompact: false,
      reason: 'idle-disabled',
      threshold,
    }
  }
  if (input.tokenCount < input.settings.idleThresholdTokens) {
    return {
      trigger: 'idle',
      shouldCompact: false,
      reason: 'below-idle-threshold',
      threshold,
    }
  }
  const now = input.now ?? Date.now()
  const lastActivityAt = input.lastActivityAt ?? now
  const elapsedSeconds = Math.max(0, now - lastActivityAt) / 1000
  if (elapsedSeconds < input.settings.idleTimeoutSeconds) {
    return {
      trigger: 'idle',
      shouldCompact: false,
      reason: 'idle-timeout-not-elapsed',
      threshold,
    }
  }
  return {
    trigger: 'idle',
    shouldCompact: true,
    reason: 'idle',
    threshold,
  }
}
