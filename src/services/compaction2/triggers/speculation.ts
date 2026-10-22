// Ported from oh-my-pi (MIT). See THIRD_PARTY_NOTICES.md in this directory.
import {
  speculationLeadTokens,
  type CompactionMethodName,
  type CompactionSettings,
} from '../contracts.js'

/** Methods that perform an LLM call and are therefore worth speculating. */
export const SPECULATION_METHODS: readonly CompactionMethodName[] = [
  'remote',
  'handoff',
  'soft',
]

export interface SpeculationInput {
  thresholdTokens: number
  tokenCount: number
  settings: CompactionSettings
  /** Methods whose `isAvailable()` currently returns true. */
  availableMethods?: readonly CompactionMethodName[]
}

export interface SpeculationDecision {
  eligible: boolean
  leadTokens: number
  bandLowTokens: number
  bandHighTokens: number
  inBand: boolean
  method?: CompactionMethodName
  reason: string
}

/**
 * Pure speculative-compaction band decision.
 *
 * Fires inside `[threshold - lead, threshold)`, where
 * `lead = clamp(threshold * 0.125, 8192, 32000)` (contract
 * `speculationLeadTokens`).
 *
 * TODO(W3): launch the background summarization off a branch snapshot and
 * arm the result for instant commit at threshold. W2 intentionally ships the
 * pure decision only — no timers, no network, no background tasks.
 */
export function evaluateSpeculation(
  input: SpeculationInput,
): SpeculationDecision {
  const thresholdTokens = Math.max(0, Math.floor(input.thresholdTokens))
  const leadTokens = speculationLeadTokens(thresholdTokens)
  const bandHighTokens = thresholdTokens
  const bandLowTokens = Math.max(0, thresholdTokens - leadTokens)
  const inBand =
    input.tokenCount >= bandLowTokens && input.tokenCount < bandHighTokens

  const available = input.availableMethods ?? SPECULATION_METHODS
  const method = input.settings.methodOrder.find(
    candidate =>
      SPECULATION_METHODS.includes(candidate) && available.includes(candidate),
  )

  if (!input.settings.asyncEnabled) {
    return {
      eligible: false,
      leadTokens,
      bandLowTokens,
      bandHighTokens,
      inBand,
      reason: 'async-disabled',
    }
  }
  if (!inBand) {
    return {
      eligible: false,
      leadTokens,
      bandLowTokens,
      bandHighTokens,
      inBand,
      reason:
        input.tokenCount < bandLowTokens
          ? 'below-band'
          : 'at-or-above-threshold',
    }
  }
  if (!method) {
    return {
      eligible: false,
      leadTokens,
      bandLowTokens,
      bandHighTokens,
      inBand,
      reason: 'no-llm-backed-method-available',
    }
  }
  return {
    eligible: true,
    leadTokens,
    bandLowTokens,
    bandHighTokens,
    inBand,
    method,
    reason: `speculate-${method}`,
  }
}
