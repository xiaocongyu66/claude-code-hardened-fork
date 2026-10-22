import type { CompactionSettings, TriggerReason } from '../contracts.js'
import type { PayloadGuardDecision } from '../guards/payload.js'

/**
 * Threshold arithmetic shared by every trigger. `headroomTokens` is signed:
 * a negative value means the context is already past the threshold.
 */
export interface ThresholdDecision {
  windowTokens: number
  reserveTokens: number
  thresholdTokens: number
  tokenCount: number
  headroomTokens: number
  progressTargetTokens: number
  overThreshold: boolean
}

export type PromotionResult =
  | { kind: 'promoted'; model: string; reason?: string }
  | { kind: 'skipped'; reason: string }

export interface TriggerDecision {
  trigger: TriggerReason
  shouldCompact: boolean
  reason: string
  threshold: ThresholdDecision
  promotion?: PromotionResult
  payload?: PayloadGuardDecision
}

export interface ThresholdInput {
  tokenCount: number
  windowTokens: number
  settings: CompactionSettings
}
