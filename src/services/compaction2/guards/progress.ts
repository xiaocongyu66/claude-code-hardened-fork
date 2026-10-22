import { PROGRESS_HEADROOM_RATIO, type GuardResult } from '../contracts.js'

/**
 * Post-compaction progress guard: a pass only counts as having resolved
 * threshold pressure when residual context lands at or below
 * `PROGRESS_HEADROOM_RATIO` (80%) of the resolved threshold.
 */
export function evaluateProgressGuard(
  thresholdTokens: number,
  afterTokens: number,
): GuardResult {
  const threshold = Math.max(0, Math.floor(thresholdTokens))
  const after = Math.max(0, Math.floor(afterTokens))
  const target = Math.floor(threshold * PROGRESS_HEADROOM_RATIO)
  const headroomTokens = threshold - after
  const ok = after <= target
  return {
    ok,
    headroomTokens,
    reason: ok
      ? undefined
      : `post-compaction context ${after} exceeds ${target} (80% of ${threshold})`,
  }
}
