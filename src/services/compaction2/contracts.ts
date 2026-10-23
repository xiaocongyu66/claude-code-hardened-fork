// Frozen contracts for the oh-my-pi compaction port (COMPACTION_V2).
//
// Every workstream (reducers, triggers, methods, tokenizers, harness) codes
// against this file. Change it only with an explicit cross-workstream review:
// the legacy compaction path stays untouched behind the feature flag until
// parity verification passes.
import type { Message, SystemMessage } from '../../types/message.js'

export type TriggerReason =
  | 'manual'
  | 'overflow'
  | 'incomplete'
  | 'threshold'
  | 'midTurn'
  | 'idle'

export type CompactionMethodName =
  | 'remote'
  | 'snapcompact'
  | 'handoff'
  | 'shake'
  | 'soft'

export type EntryKind = 'message' | 'compaction' | 'branchSummary'

/**
 * A read-only projection of CCH's message array in oh-my-pi's entry terms.
 * The message array stays the source of truth for the REPL/transcript; this
 * view only carries stable ids for cut points and per-entry token counts.
 */
export interface EntryView {
  id: string
  kind: EntryKind
  message?: Message
  tokens?: number
}

export interface CutPoint {
  firstKeptEntryId: string
  tokensBefore: number
  boundaryMessage: SystemMessage
}

export interface CompactionSettings {
  methodOrder: CompactionMethodName[]
  /** Keep the most recent context tokens intact. */
  keepRecentTokens: number
  /** Explicit reserve; undefined = max(floor(window * 0.15), 16384). */
  reserveTokens?: number
  thresholdTokens?: number
  thresholdPercent?: number
  midTurnEnabled: boolean
  autoContinue: boolean
  asyncEnabled: boolean
  idleEnabled: boolean
  idleThresholdTokens: number
  idleTimeoutSeconds: number
}

export const DEFAULT_COMPACTION_SETTINGS: CompactionSettings = {
  methodOrder: ['remote', 'snapcompact', 'handoff', 'shake', 'soft'],
  keepRecentTokens: 20_000,
  midTurnEnabled: true,
  autoContinue: true,
  asyncEnabled: true,
  idleEnabled: false,
  idleThresholdTokens: 200_000,
  idleTimeoutSeconds: 300,
}

export interface CompactionContext {
  /** Current model id (provider/model-id form when known). */
  model: string
  trigger: TriggerReason
  messages: readonly Message[]
  settings: CompactionSettings
  /** Canonical context-size estimate; the same function the legacy path uses. */
  tokenCount(messages: readonly Message[]): number
  estimateEntryTokens(entry: EntryView): number
  abortSignal?: AbortSignal
  agentId?: string
  now(): number
}

export type CompactionOutcome =
  | {
      kind: 'compacted'
      method: CompactionMethodName
      cutPoint: CutPoint
      tokensSaved: number
      headroomTokens: number
      summary?: string
      preserveData?: Record<string, unknown>
      warning?: string
    }
  | {
      kind: 'reduced'
      method: CompactionMethodName
      messages: Message[]
      tokensSaved: number
      headroomTokens: number
      warning?: string
    }
  | { kind: 'skipped'; method: CompactionMethodName; reason: string }
  | {
      kind: 'failed'
      method: CompactionMethodName
      reason: string
      error?: unknown
    }

export interface CompactionMethod {
  readonly name: CompactionMethodName
  isAvailable(ctx: CompactionContext): boolean
  run(ctx: CompactionContext): Promise<CompactionOutcome>
}

export interface GuardResult {
  ok: boolean
  reason?: string
  headroomTokens?: number
}

/** Post-compaction progress guard threshold (oh-my-pi: ≤80% of threshold). */
export const PROGRESS_HEADROOM_RATIO = 0.8

/** Speculative-compaction band: lead = clamp(threshold × 0.125, 8192, 32000). */
export function speculationLeadTokens(threshold: number): number {
  return Math.min(32_000, Math.max(8_192, Math.floor(threshold * 0.125)))
}

export function resolveReserveTokens(
  contextWindow: number,
  configured?: number,
): number {
  const proportional = Math.floor(contextWindow * 0.15)
  const reserve = Math.max(proportional, configured ?? 16_384)
  // On small windows the *default* floor can consume nearly the whole window,
  // making the threshold tiny and every pass guard-blocked. An explicit
  // reserve is user intent and is never reduced.
  if (configured === undefined && reserve >= contextWindow - proportional) {
    return Math.max(1, proportional)
  }
  return reserve
}
