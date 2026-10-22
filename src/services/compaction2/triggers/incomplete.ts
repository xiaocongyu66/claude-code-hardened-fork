import { resolveThresholdDecision } from './threshold.js'
import type { ThresholdInput, TriggerDecision } from './types.js'

export interface IncompleteInput extends ThresholdInput {
  /** Assistant stop reason, e.g. Anthropic `length` / OpenAI `max_tokens`. */
  stopReason?: string | null
}

export function isIncompleteStop(
  stopReason: string | null | undefined,
): boolean {
  return (
    stopReason === 'length' ||
    stopReason === 'max_tokens' ||
    stopReason === 'model_context_window_exceeded'
  )
}

/**
 * Incomplete-output recovery. Compaction cannot raise the output cap, so the
 * trigger only fires when the window is unknown or the context is above the
 * threshold (oh-my-pi's "above threshold (or unknown window)" rule).
 */
export function evaluateIncompleteTrigger(
  input: IncompleteInput,
): TriggerDecision {
  const threshold = resolveThresholdDecision(input)
  const incomplete = isIncompleteStop(input.stopReason)
  const windowUnknown = input.windowTokens <= 0
  const shouldCompact =
    incomplete &&
    (windowUnknown || input.tokenCount > threshold.thresholdTokens)

  return {
    trigger: 'incomplete',
    shouldCompact,
    reason: !incomplete
      ? 'not-incomplete-stop'
      : shouldCompact
        ? 'incomplete-output-over-threshold'
        : 'incomplete-output-below-threshold',
    threshold,
  }
}
