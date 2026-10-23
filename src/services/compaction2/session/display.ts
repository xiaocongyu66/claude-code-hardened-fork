// COMPACTION_V2 display messages.
//
// The query loop already yields the legacy compact boundary embedded in a
// `CompactionResult`, so V2 only needs to (a) stamp the method that produced
// it onto that boundary and (b) surface a one-shot notice for mechanical
// reductions (shake). Both are plain message shapes so the existing
// `compact_boundary` / `informational` renderers are reused unchanged.
//
// Boundary messages are system messages: `normalizeMessagesForAPI` drops every
// system message except local-command output, so neither the boundary nor the
// reduced notice ever enters the model request.
import { randomUUID } from 'crypto'
import type { UUID } from 'crypto'
import type { CompactionResult } from '../../compact/compact.js'
import type {
  Message,
  SystemCompactBoundaryMessage,
  SystemInformationalMessage,
} from '../../../types/message.js'
import type { CompactionMethodName, TriggerReason } from '../contracts.js'

export interface CompactionBoundaryInput {
  method: CompactionMethodName
  /** Trigger reasons collapse to the legacy `auto` / `manual` pair. */
  trigger: TriggerReason | 'auto' | 'manual'
  /** Context size at the cut point. */
  preTokens: number
  /** Tokens removed by the method, when known. */
  tokensSaved?: number
  /** Progress-guard warning carried through from the method. */
  warning?: string
  uuid?: UUID
  timestamp?: string
}

/**
 * Build the boundary V2 emits after a compacted outcome. The shape matches the
 * legacy marker (`subtype: 'compact_boundary'`) plus `compactMetadata.method`.
 */
export function createCompactionBoundaryMessage(
  input: CompactionBoundaryInput,
): SystemCompactBoundaryMessage {
  return {
    type: 'system',
    subtype: 'compact_boundary',
    content: 'Conversation compacted',
    isMeta: false,
    timestamp: input.timestamp ?? new Date().toISOString(),
    uuid: input.uuid ?? randomUUID(),
    level: 'info',
    compactMetadata: {
      trigger: input.trigger === 'manual' ? 'manual' : 'auto',
      preTokens: input.preTokens,
      method: input.method,
      ...(input.tokensSaved !== undefined && {
        tokensSaved: input.tokensSaved,
      }),
      ...(input.warning !== undefined && { warning: input.warning }),
    },
  }
}

export interface CompactionMethodMetadata {
  tokensSaved?: number
  warning?: string
}

/**
 * Stamp `method` onto an existing boundary without dropping any metadata it
 * already carries (trigger, preTokens, preservedSegment, discovered tools).
 * Used for soft, whose boundary comes from the legacy compaction result.
 */
export function withCompactionMethod(
  boundary: SystemCompactBoundaryMessage,
  method: CompactionMethodName,
  extra: CompactionMethodMetadata = {},
): SystemCompactBoundaryMessage {
  return {
    ...boundary,
    compactMetadata: {
      ...boundary.compactMetadata,
      method,
      ...(extra.tokensSaved !== undefined && {
        tokensSaved: extra.tokensSaved,
      }),
      ...(extra.warning !== undefined && { warning: extra.warning }),
    },
  }
}

/**
 * Clone a legacy result with its boundary annotated. A non-boundary marker is
 * returned untouched so callers never have to branch on the result shape.
 */
export function annotateCompactionResult(
  result: CompactionResult,
  method: CompactionMethodName,
  extra?: CompactionMethodMetadata,
): CompactionResult {
  const boundary = result.boundaryMarker as Message
  if (boundary.type !== 'system' || boundary.subtype !== 'compact_boundary') {
    return result
  }
  return {
    ...result,
    boundaryMarker: withCompactionMethod(
      result.boundaryMarker as SystemCompactBoundaryMessage,
      method,
      extra,
    ),
  }
}

export interface ReducedNoticeInput {
  method: CompactionMethodName
  tokensSaved: number
  uuid?: UUID
  timestamp?: string
}

/** One-shot UI notice for a mechanical reduction (shake). */
export function createReducedNoticeMessage(
  input: ReducedNoticeInput,
): SystemInformationalMessage {
  return {
    type: 'system',
    subtype: 'informational',
    content: `Context reduced by ${input.tokensSaved} tokens (${input.method})`,
    isMeta: false,
    timestamp: input.timestamp ?? new Date().toISOString(),
    uuid: input.uuid ?? randomUUID(),
    // 'notice' (not 'info') so SystemTextMessage renders it outside verbose
    // mode, matching the grace UI notice convention.
    level: 'notice',
  }
}

export interface ReducedNoticeState {
  emitted: boolean
}

export function createReducedNoticeState(): ReducedNoticeState {
  return { emitted: false }
}

/**
 * Return a notice at most once per state (one query turn). Later reductions in
 * the same turn — threshold, mid-turn, overflow — stay silent.
 */
export function takeReducedNotice(
  state: ReducedNoticeState,
  input: ReducedNoticeInput,
): SystemInformationalMessage | undefined {
  if (state.emitted) return undefined
  state.emitted = true
  return createReducedNoticeMessage(input)
}
