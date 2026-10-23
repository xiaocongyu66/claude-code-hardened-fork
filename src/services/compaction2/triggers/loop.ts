// Loop-level trigger selection for the COMPACTION_V2 wiring.
//
// query.ts has one provider request per loop iteration. The threshold pass
// runs at the top of an iteration (before the request); the mid-turn pass runs
// at the end of a tool iteration (after the tool results are known). Both would
// otherwise fire for the same request, so a one-shot skip flag carries the
// mid-turn decision into the next threshold check. These helpers are pure so
// the selection/dedup rules can be tested without a query loop.
import {
  DEFAULT_COMPACTION_SETTINGS,
  type CompactionSettings,
} from '../contracts.js'
import { evaluateIncompleteTrigger } from './incomplete.js'
import { evaluateMidTurnTrigger } from './midTurn.js'

export { isIncompleteStop } from './incomplete.js'

export interface LoopCompactionState {
  /** A mid-turn pass already covered the next provider request. */
  midTurnSkipPending: boolean
  /** Incomplete-output recovery already ran in this turn. */
  incompleteAttempted: boolean
}

export function createLoopCompactionState(): LoopCompactionState {
  return { midTurnSkipPending: false, incompleteAttempted: false }
}

/**
 * Consume the one-shot mid-turn flag at the top-of-loop threshold site.
 * Returns true exactly once per {@link markMidTurnConsumed} call.
 */
export function consumeMidTurnSkip(state: LoopCompactionState): boolean {
  const skip = state.midTurnSkipPending
  state.midTurnSkipPending = false
  return skip
}

/** Record that mid-turn maintenance ran before the next provider request. */
export function markMidTurnConsumed(state: LoopCompactionState): void {
  state.midTurnSkipPending = true
}

export interface MidTurnAttemptInput {
  /** False when COMPACTION_V2 is compiled out. */
  enabled: boolean
  /** The threshold pass already ran (and compacted) in this iteration. */
  thresholdAttemptedThisIteration: boolean
  tokenCount: number
  windowTokens: number
  settings?: CompactionSettings
}

/**
 * Mid-turn maintenance fires only when the threshold pass did not already
 * handle this iteration and the context is above the threshold. The
 * `midTurnEnabled` switch is evaluated by the trigger itself.
 */
export function shouldAttemptMidTurn(input: MidTurnAttemptInput): boolean {
  if (!input.enabled) return false
  if (input.thresholdAttemptedThisIteration) return false
  return evaluateMidTurnTrigger({
    tokenCount: input.tokenCount,
    windowTokens: input.windowTokens,
    settings: input.settings ?? DEFAULT_COMPACTION_SETTINGS,
  }).shouldCompact
}

export type OverflowRecovery = 'v2' | 'reactive' | 'surface'

export interface OverflowRecoveryInput {
  /** False when COMPACTION_V2 is compiled out. */
  v2Enabled: boolean
  promptTooLong: boolean
  reactiveAvailable: boolean
  /** A recovery pass (V2 or reactive) already ran for this error. */
  alreadyAttempted: boolean
}

/**
 * Prompt-too-long recovery selection. V2 and reactive compact are mutually
 * exclusive: when V2 is enabled it owns the 413 path, and a failed/already-run
 * V2 pass surfaces the error instead of double-running reactive compact.
 * Flag-off selection is exactly the legacy reactive path.
 */
export function selectOverflowRecovery(
  input: OverflowRecoveryInput,
): OverflowRecovery {
  if (!input.promptTooLong) return 'surface'
  if (input.v2Enabled) {
    return input.alreadyAttempted ? 'surface' : 'v2'
  }
  return input.reactiveAvailable ? 'reactive' : 'surface'
}

export interface IncompleteRecoveryInput {
  /** False when COMPACTION_V2 is compiled out. */
  v2Enabled: boolean
  stopReason?: string | null
  tokenCount: number
  windowTokens: number
  settings?: CompactionSettings
  /** Incomplete-output recovery already ran in this turn. */
  alreadyAttempted: boolean
}

/**
 * Incomplete-output recovery fires for a length/max-tokens stop only when the
 * context is over the threshold (or the window is unknown) and no recovery has
 * run yet this turn.
 */
export function shouldAttemptIncompleteRecovery(
  input: IncompleteRecoveryInput,
): boolean {
  if (!input.v2Enabled || input.alreadyAttempted) return false
  return evaluateIncompleteTrigger({
    stopReason: input.stopReason,
    tokenCount: input.tokenCount,
    windowTokens: input.windowTokens,
    settings: input.settings ?? DEFAULT_COMPACTION_SETTINGS,
  }).shouldCompact
}
