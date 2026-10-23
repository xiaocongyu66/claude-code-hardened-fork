// COMPACTION_V2 resume rebuild.
//
// Given the journaled session entries (compaction rows + transcript messages),
// reconstruct the model context at the latest compaction:
//
//   compact boundary → summary user message → messages after firstKeptEntryId
//
// Returns `null` when there is no usable compaction row (missing, corrupt, or
// its cut point no longer resolves). Callers then keep the legacy transcript
// chain, which already starts at the legacy `compact_boundary` message.
import { randomUUID } from 'crypto'
import type {
  Message,
  SystemCompactBoundaryMessage,
  UserMessage,
} from '../../../types/message.js'
import { createCompactionBoundaryMessage } from './display.js'
import {
  isCompactionSessionEntry,
  type CompactionSessionEntry,
} from './entries.js'

export type RebuildEntry = Message | CompactionSessionEntry

/** Transcript message discriminants — everything else is journal metadata. */
const MESSAGE_ENTRY_TYPES = new Set([
  'user',
  'assistant',
  'system',
  'attachment',
])

function isMessageEntry(entry: RebuildEntry): entry is Message {
  return MESSAGE_ENTRY_TYPES.has(entry.type)
}

/**
 * Latest compaction row wins. A corrupt latest row returns `null` rather than
 * silently resurrecting an older compaction (which could drop newer turns).
 */
function findLatestCompaction(
  entries: readonly RebuildEntry[],
): { entry: CompactionSessionEntry; index: number } | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const candidate = entries[i]!
    if (candidate.type !== 'compaction') continue
    return isCompactionSessionEntry(candidate)
      ? { entry: candidate, index: i }
      : null
  }
  return null
}

/**
 * A legacy compaction preamble (boundary + summary) can sit between the
 * journal row and the kept tail when the caller concatenates journal rows
 * with an already-boundary-truncated chain. Skip it so an empty cut point
 * doesn't duplicate the marker on rebuild.
 */
function isLegacyCompactionPreamble(entry: RebuildEntry): boolean {
  if (entry.type === 'system') {
    return (entry as { subtype?: unknown }).subtype === 'compact_boundary'
  }
  return entry.type === 'user' && entry.isCompactSummary === true
}

/**
 * Resolve where the kept tail starts.
 *
 * `''` means "nothing was kept before the compaction row", so the tail starts
 * at the first non-preamble entry after it. A non-empty id must still resolve
 * to a transcript message; otherwise the row is stale/corrupt → null.
 */
function findFirstKeptIndex(
  entries: readonly RebuildEntry[],
  firstKeptEntryId: string,
  compactionIndex: number,
): number | null {
  if (firstKeptEntryId === '') {
    let index = compactionIndex + 1
    while (
      index < entries.length &&
      isLegacyCompactionPreamble(entries[index]!)
    ) {
      index++
    }
    return index
  }
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!
    if (isMessageEntry(entry) && entry.uuid === firstKeptEntryId) return i
  }
  return null
}

function contentBlocks(message: Message): Array<Record<string, unknown>> {
  const content = message.message?.content
  if (!Array.isArray(content)) return []
  return content as unknown as Array<Record<string, unknown>>
}

/**
 * A cut that lands on a tool_result orphans the matching tool_use (which lives
 * before the boundary). Drop those leading user messages so the rebuilt
 * context never opens with a dangling tool_result. The reverse case — an
 * assistant tool_use whose result is later in the tail — is already paired and
 * is left alone.
 */
function alignToolPairing(messages: Message[]): Message[] {
  const keptToolUseIds = new Set<string>()
  for (const message of messages) {
    for (const block of contentBlocks(message)) {
      if (block.type === 'tool_use' && typeof block.id === 'string') {
        keptToolUseIds.add(block.id)
      }
    }
  }

  let start = 0
  while (start < messages.length) {
    const message = messages[start]!
    if (message.type !== 'user') break
    const orphaned = contentBlocks(message).some(
      block =>
        block.type === 'tool_result' &&
        typeof block.tool_use_id === 'string' &&
        !keptToolUseIds.has(block.tool_use_id),
    )
    if (!orphaned) break
    start++
  }
  return start === 0 ? messages : messages.slice(start)
}

/**
 * Rebuild the post-compaction context from journaled entries. `entries` may be
 * in any order as long as the latest compaction row is present and its
 * `firstKeptEntryId` resolves to a message in the same collection.
 */
export function rebuildMessagesFromEntries(
  entries: readonly RebuildEntry[],
): Message[] | null {
  const latest = findLatestCompaction(entries)
  if (!latest) return null

  const startIndex = findFirstKeptIndex(
    entries,
    latest.entry.firstKeptEntryId,
    latest.index,
  )
  if (startIndex === null) return null

  const kept = alignToolPairing(
    entries.slice(startIndex).filter(isMessageEntry),
  )

  const lastSummarized = entries
    .slice(0, startIndex)
    .filter(isMessageEntry)
    .at(-1)

  // Built through the display constructor (crypto-only, no transcript chain)
  // so resume renders the same marker as the live turn — including the method
  // that survives only in the journal row.
  const timestamp = new Date().toISOString()
  const boundary: SystemCompactBoundaryMessage = {
    ...createCompactionBoundaryMessage({
      method: latest.entry.method,
      trigger: 'auto',
      preTokens: latest.entry.tokensBefore,
      timestamp,
    }),
    ...(lastSummarized?.uuid && { logicalParentUuid: lastSummarized.uuid }),
  }
  const summary: UserMessage = {
    type: 'user',
    message: { role: 'user', content: latest.entry.summary },
    isCompactSummary: true,
    isVisibleInTranscriptOnly: true,
    uuid: randomUUID(),
    timestamp,
  }

  return [boundary, summary, ...kept]
}
