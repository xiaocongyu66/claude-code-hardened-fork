// COMPACTION_V2 resume rebuild.
//
// Given the journaled session entries (compaction rows + transcript messages),
// reconstruct the model context at the latest compaction:
//
//   compact boundary → summary → restored archive/attachments/hook results →
//   messages after firstKeptEntryId
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
  sanitizeAttachmentMetaPair,
  type CompactionEntryAttachmentMeta,
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
 * Rebuild a bounded attachment message. Only shapes the API normalizer can
 * consume are reconstructed; everything else degrades to a text reminder so a
 * damaged journal row can never crash message normalization.
 */
function restoreAttachment(
  meta: CompactionEntryAttachmentMeta,
  timestamp: string,
): Message | null {
  const attachment = restoredAttachmentBody(meta)
  if (!attachment) return null
  return {
    type: 'attachment',
    uuid: randomUUID(),
    timestamp,
    attachment,
  } as unknown as Message
}

function restoredAttachmentBody(
  meta: CompactionEntryAttachmentMeta,
): Record<string, unknown> | null {
  const text = meta.text ?? ''
  const hookName = meta.name ?? 'SessionStart'
  const hookEvent = 'SessionStart'
  const toolUseId =
    meta.toolUseId !== undefined ? { toolUseID: meta.toolUseId } : {}
  switch (meta.type) {
    case 'file':
    case 'image':
    case 'pdf':
    case 'notebook':
    case 'pdf_reference':
    case 'compact_file_reference':
      // File bytes are deliberately not journaled; point at the path instead
      // (the same text the legacy `compact_file_reference` fallback emits).
      return meta.path
        ? { type: 'compact_file_reference', filename: meta.path }
        : null
    case 'plan_file_reference':
      return {
        type: 'plan_file_reference',
        planFilePath: meta.path ?? '',
        planContent: text,
      }
    case 'invoked_skills':
      return {
        type: 'invoked_skills',
        skills: [
          {
            name: meta.name ?? 'restored-skill',
            path: meta.path ?? '',
            content: text,
          },
        ],
      }
    case 'hook_additional_context':
      return {
        type: 'hook_additional_context',
        content: text ? [text] : [],
        hookName,
        hookEvent,
        ...toolUseId,
      }
    case 'hook_success':
      return {
        type: 'hook_success',
        content: text,
        hookName,
        hookEvent,
        ...toolUseId,
      }
    case 'hook_stopped_continuation':
      return {
        type: 'hook_stopped_continuation',
        message: text,
        hookName,
        hookEvent,
        ...toolUseId,
      }
    case 'critical_system_reminder':
      return { type: 'critical_system_reminder', content: text }
    default:
      return { type: 'critical_system_reminder', content: restoreNotice(meta) }
  }
}

function restoreNotice(meta: CompactionEntryAttachmentMeta): string {
  const header = `[restored ${meta.type}${meta.path ? `: ${meta.path}` : ''}]`
  return meta.text ? `${header}\n${meta.text}` : header
}

/**
 * Snapcompact archives keep their bounded source text even after `frames` are
 * stripped from the journal, so resume can re-inject the archived history in
 * text mode (image archives fall back to the same text).
 */
function snapcompactArchiveText(
  preserveData: Record<string, unknown> | undefined,
): string | undefined {
  const archive = preserveData?.snapcompact
  if (!archive || typeof archive !== 'object' || Array.isArray(archive)) {
    return undefined
  }
  const record = archive as Record<string, unknown>
  if (typeof record.text === 'string' && record.text.length > 0) {
    return record.text
  }
  const head = typeof record.textHead === 'string' ? record.textHead : ''
  const tail = typeof record.textTail === 'string' ? record.textTail : ''
  const text = head + tail
  return text.length > 0 ? text : undefined
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

  // Restore order matches the legacy post-compact layout: summary, archived
  // snapcompact text, attachments, hook results, then the kept tail.
  const restored: Message[] = []
  const archiveText = snapcompactArchiveText(latest.entry.preserveData)
  if (archiveText) {
    restored.push({
      type: 'user',
      message: {
        role: 'user',
        content: `<snapcompact-archive>\n${archiveText}\n</snapcompact-archive>`,
      },
      isMeta: true,
      uuid: randomUUID(),
      timestamp,
    })
  }
  const meta = sanitizeAttachmentMetaPair(
    latest.entry.attachments,
    latest.entry.hookResults,
  )
  for (const attachment of meta.attachments ?? []) {
    const message = restoreAttachment(attachment, timestamp)
    if (message) restored.push(message)
  }
  for (const hook of meta.hookResults ?? []) {
    const message = restoreAttachment(hook, timestamp)
    if (message) restored.push(message)
  }

  // Restored messages are `attachment`/meta-user rows with no tool_result
  // blocks, and `alignToolPairing` already ran on the kept tail, so inserting
  // them here cannot orphan a tool_use/tool_result pair.
  return [boundary, summary, ...restored, ...kept]
}
