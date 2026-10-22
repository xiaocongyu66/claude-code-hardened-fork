import { PROGRESS_HEADROOM_RATIO, resolveReserveTokens } from '../contracts.js'
import type {
  ThresholdDecision,
  ThresholdInput,
  TriggerDecision,
} from './types.js'

/**
 * Resolve the compaction threshold from the effective context window.
 *
 * The default policy is `window - reserve`, where the reserve is
 * `max(floor(window * 0.15), configuredReserve ?? 16384)` (contract
 * `resolveReserveTokens`). Explicit `thresholdTokens` / `thresholdPercent`
 * settings win when set, mirroring oh-my-pi's threshold policy.
 */
export function resolveThresholdDecision(
  input: ThresholdInput,
): ThresholdDecision {
  const windowTokens = Math.max(0, Math.floor(input.windowTokens))
  const tokenCount = Math.max(0, input.tokenCount)

  if (windowTokens <= 0) {
    return {
      windowTokens,
      reserveTokens: 0,
      thresholdTokens: 0,
      tokenCount,
      headroomTokens: 0,
      progressTargetTokens: 0,
      overThreshold: false,
    }
  }

  const reserveTokens = resolveReserveTokens(
    windowTokens,
    input.settings.reserveTokens,
  )
  const fixed = input.settings.thresholdTokens
  const percent = input.settings.thresholdPercent

  let thresholdTokens: number
  if (typeof fixed === 'number' && Number.isFinite(fixed) && fixed > 0) {
    thresholdTokens = Math.min(windowTokens - 1, Math.max(1, fixed))
  } else if (
    typeof percent === 'number' &&
    Number.isFinite(percent) &&
    percent > 0
  ) {
    const clamped = Math.min(99, Math.max(1, percent))
    thresholdTokens = Math.max(1, Math.floor(windowTokens * (clamped / 100)))
  } else {
    thresholdTokens = Math.max(1, windowTokens - reserveTokens)
  }

  return {
    windowTokens,
    reserveTokens,
    thresholdTokens,
    tokenCount,
    headroomTokens: thresholdTokens - tokenCount,
    progressTargetTokens: Math.floor(
      thresholdTokens * PROGRESS_HEADROOM_RATIO,
    ),
    // oh-my-pi's shouldCompact() uses a strict `>`: exactly at the threshold
    // the next request still fits, so no maintenance pass is needed.
    overThreshold: tokenCount > thresholdTokens,
  }
}

/** Post-turn threshold maintenance trigger. */
export function evaluateThresholdTrigger(
  input: ThresholdInput,
): TriggerDecision {
  const threshold = resolveThresholdDecision(input)
  return {
    trigger: 'threshold',
    shouldCompact: threshold.overThreshold,
    reason: threshold.overThreshold
      ? `context ${threshold.tokenCount} > threshold ${threshold.thresholdTokens}`
      : `context ${threshold.tokenCount} <= threshold ${threshold.thresholdTokens}`,
    threshold,
  }
}
