// COMPACTION_V2 session entries.
//
// A compaction is journaled as its own JSONL row (`type: 'compaction'`) next to
// the ordinary transcript messages. The row is intentionally *not* a chain
// participant: `parentUuid` is provenance only, and readers that predate V2
// simply skip the unknown `type` (see loadTranscriptFile's else-if chain).
//
// On resume `rebuild.ts` consumes the latest row to reconstruct the model
// context (boundary + summary + kept tail). If the row is missing or corrupt
// the caller falls back to the legacy `compact_boundary` message, so writing
// this row never changes the legacy resume path.
import { randomUUID } from 'crypto'
import type { UUID } from 'crypto'
import type { Message } from '../../../types/message.js'
import type { CompactionMethodName } from '../contracts.js'

export const COMPACTION_SESSION_ENTRY_TYPE = 'compaction' as const

/**
 * Bounded metadata for the post-compaction attachments / hook results that
 * legacy `buildPostCompactMessages` appends after the summary. The journal
 * must never carry full file contents or base64 images: on resume these are
 * restored as degraded, text-only messages (see `rebuild.ts`).
 */
export interface CompactionEntryAttachmentMeta {
  /** `attachment.type` (or the message type for non-attachment hooks). */
  type: string
  /** File path / filename / plan path, when the attachment has one. */
  path?: string
  /** Hook or skill name, when the attachment has one. */
  name?: string
  /** Bounded short text (content / message / stdout / skill text). */
  text?: string
  /** Tool use id the attachment is tied to, when any. */
  toolUseId?: string
}

/** Per-item journal budget for one attachment/hook metadata entry. */
export const MAX_ATTACHMENT_META_ITEM_BYTES = 4 * 1024
/** Total journal budget for `attachments` + `hookResults` combined. */
export const MAX_ATTACHMENT_META_TOTAL_BYTES = 32 * 1024

export interface CompactionSessionEntry {
  type: typeof COMPACTION_SESSION_ENTRY_TYPE
  uuid: UUID
  /** Provenance link to the last transcript message before compaction. */
  parentUuid?: UUID | null
  /** Summary injected as the compact summary user message on resume. */
  summary: string
  shortSummary?: string
  /** First transcript message kept after the cut point. */
  firstKeptEntryId: string
  tokensBefore: number
  method: CompactionMethodName
  preserveData?: Record<string, unknown>
  /** Bounded post-compaction attachments (see CompactionEntryAttachmentMeta). */
  attachments?: CompactionEntryAttachmentMeta[]
  /** Bounded post-compaction hook results. */
  hookResults?: CompactionEntryAttachmentMeta[]
  timestamp: string
}

const COMPACTION_METHODS = new Set<CompactionMethodName>([
  'remote',
  'snapcompact',
  'handoff',
  'shake',
  'soft',
])

/**
 * Structural validator used by the reader and by `rebuildMessagesFromEntries`.
 * Kept dependency-free (no imports from the rest of compaction2) so it can be
 * used while parsing raw JSONL.
 */
export function isCompactionSessionEntry(
  value: unknown,
): value is CompactionSessionEntry {
  if (typeof value !== 'object' || value === null) return false
  const entry = value as Record<string, unknown>
  return (
    entry.type === COMPACTION_SESSION_ENTRY_TYPE &&
    typeof entry.uuid === 'string' &&
    typeof entry.summary === 'string' &&
    typeof entry.firstKeptEntryId === 'string' &&
    typeof entry.tokensBefore === 'number' &&
    Number.isFinite(entry.tokensBefore) &&
    typeof entry.method === 'string' &&
    COMPACTION_METHODS.has(entry.method as CompactionMethodName) &&
    typeof entry.timestamp === 'string' &&
    Number.isFinite(Date.parse(entry.timestamp))
  )
}

function serializedBytes(value: unknown): number {
  const json = JSON.stringify(value)
  return json === undefined ? 0 : Buffer.byteLength(json, 'utf8')
}

/** Truncate to a UTF-8 byte budget without splitting a code point. */
function truncateUtf8(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return ''
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text
  let used = 0
  let out = ''
  for (const char of text) {
    const bytes = Buffer.byteLength(char, 'utf8')
    if (used + bytes > maxBytes) break
    used += bytes
    out += char
  }
  return out
}

function firstString(
  record: Record<string, unknown>,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return undefined
}

function textFromContent(value: unknown): string | undefined {
  if (typeof value === 'string') return value.length > 0 ? value : undefined
  if (!Array.isArray(value)) return undefined
  const parts: string[] = []
  for (const item of value) {
    if (typeof item === 'string') {
      parts.push(item)
    } else if (item && typeof item === 'object') {
      const text = (item as Record<string, unknown>).text
      if (typeof text === 'string') parts.push(text)
    }
  }
  return parts.length > 0 ? parts.join('\n') : undefined
}

function textFromSkills(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined
  const parts: string[] = []
  for (const item of value) {
    if (!item || typeof item !== 'object') continue
    const skill = item as Record<string, unknown>
    const name = typeof skill.name === 'string' ? skill.name : undefined
    const path = typeof skill.path === 'string' ? skill.path : undefined
    const content =
      typeof skill.content === 'string' ? skill.content : undefined
    if (!name && !path && !content) continue
    parts.push(
      [`### ${name ?? 'skill'}${path ? ` (${path})` : ''}`, content ?? ''].join(
        '\n',
      ),
    )
  }
  return parts.length > 0 ? parts.join('\n\n') : undefined
}

/**
 * Reduce one post-compaction message to bounded metadata: type, path, name and
 * short text only. Nested payloads (file contents, image base64, tool results)
 * are never copied.
 */
export function projectAttachmentMeta(
  message: Message,
): CompactionEntryAttachmentMeta | null {
  if (message.type === 'attachment') {
    const attachment = message.attachment as unknown
    if (!attachment || typeof attachment !== 'object') return null
    const record = attachment as Record<string, unknown>
    const type = typeof record.type === 'string' ? record.type : undefined
    if (!type) return null
    const skills = Array.isArray(record.skills) ? record.skills : undefined
    const firstSkill =
      skills && skills[0] && typeof skills[0] === 'object'
        ? (skills[0] as Record<string, unknown>)
        : undefined
    const path =
      firstString(record, [
        'path',
        'filename',
        'filePath',
        'planFilePath',
        'uri',
      ]) ??
      (firstSkill && typeof firstSkill.path === 'string'
        ? firstSkill.path
        : undefined)
    const name =
      firstString(record, ['hookName', 'name', 'agentType']) ??
      (firstSkill && typeof firstSkill.name === 'string'
        ? firstSkill.name
        : undefined)
    const text =
      textFromContent(record.content) ??
      textFromSkills(record.skills) ??
      firstString(record, ['planContent', 'message', 'stdout', 'stderr'])
    const toolUseId =
      typeof record.toolUseID === 'string' && record.toolUseID.length > 0
        ? record.toolUseID
        : undefined
    return {
      type,
      ...(path !== undefined && { path }),
      ...(name !== undefined && { name }),
      ...(text !== undefined && { text }),
      ...(toolUseId !== undefined && { toolUseId }),
    }
  }

  // Hook results are usually attachment messages, but keep a text projection
  // for any other message type instead of dropping the hook output entirely.
  const text =
    textFromContent(message.message?.content) ??
    firstString(message as unknown as Record<string, unknown>, [
      'content',
      'message',
    ])
  if (!text) return null
  return { type: message.type, text }
}

/** Enforce the per-item budget, dropping unrepresentable fields. */
export function boundAttachmentMeta(
  meta: CompactionEntryAttachmentMeta,
): CompactionEntryAttachmentMeta | null {
  const type = typeof meta.type === 'string' ? meta.type.trim() : ''
  if (type.length === 0) return null

  const bounded: CompactionEntryAttachmentMeta = { type }
  for (const key of ['path', 'name', 'toolUseId'] as const) {
    const value = meta[key]
    if (typeof value === 'string' && value.length > 0) bounded[key] = value
  }
  if (typeof meta.text === 'string' && meta.text.length > 0) {
    // Reserve room for the JSON key/quotes around `text`.
    const room = MAX_ATTACHMENT_META_ITEM_BYTES - serializedBytes(bounded) - 16
    if (room > 0) bounded.text = truncateUtf8(meta.text, room)
  }
  if (serializedBytes(bounded) <= MAX_ATTACHMENT_META_ITEM_BYTES) {
    return bounded
  }
  // A pathologically long path/name leaves no room; keep the type alone.
  return serializedBytes({ type }) <= MAX_ATTACHMENT_META_ITEM_BYTES
    ? { type }
    : null
}

/** Bound a list in order, stopping at the total budget. */
export function boundAttachmentMetaList(
  list: readonly CompactionEntryAttachmentMeta[],
): CompactionEntryAttachmentMeta[] | undefined {
  const out: CompactionEntryAttachmentMeta[] = []
  let used = 0
  appendBounded(list, out, () => used, bytes => {
    used += bytes
  })
  return out.length > 0 ? out : undefined
}

function appendBounded(
  list: readonly CompactionEntryAttachmentMeta[],
  out: CompactionEntryAttachmentMeta[],
  getUsed: () => number,
  addUsed: (bytes: number) => void,
): void {
  for (const item of list) {
    const bounded = boundAttachmentMeta(item)
    if (!bounded) continue
    // +2 reserves the JSON array bracket/comma overhead around each item.
    const size = serializedBytes(bounded) + 2
    if (getUsed() + size > MAX_ATTACHMENT_META_TOTAL_BYTES) break
    out.push(bounded)
    addUsed(size)
  }
}

/**
 * Bound attachments and hook results against one shared 32KB budget, in the
 * legacy post-compact order (attachments first). Overflow in one list leaves
 * no budget for the other, matching "truncate at the journal limit".
 */
export function boundAttachmentMetaPair(
  attachments: readonly CompactionEntryAttachmentMeta[],
  hookResults: readonly CompactionEntryAttachmentMeta[],
): {
  attachments?: CompactionEntryAttachmentMeta[]
  hookResults?: CompactionEntryAttachmentMeta[]
} {
  const boundedAttachments: CompactionEntryAttachmentMeta[] = []
  const boundedHookResults: CompactionEntryAttachmentMeta[] = []
  let used = 0
  appendBounded(attachments, boundedAttachments, () => used, bytes => {
    used += bytes
  })
  appendBounded(hookResults, boundedHookResults, () => used, bytes => {
    used += bytes
  })
  return {
    ...(boundedAttachments.length > 0 && {
      attachments: boundedAttachments,
    }),
    ...(boundedHookResults.length > 0 && {
      hookResults: boundedHookResults,
    }),
  }
}

function toAttachmentMeta(
  value: unknown,
): CompactionEntryAttachmentMeta | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  if (typeof record.type !== 'string' || record.type.length === 0) return null
  return {
    type: record.type,
    ...(typeof record.path === 'string' && { path: record.path }),
    ...(typeof record.name === 'string' && { name: record.name }),
    ...(typeof record.text === 'string' && { text: record.text }),
    ...(typeof record.toolUseId === 'string' && {
      toolUseId: record.toolUseId,
    }),
  }
}

/**
 * Read-side guard: drop corrupt items and re-apply the budgets so a hand-edited
 * or truncated journal row can never inject an oversized payload. `undefined`
 * means "nothing usable" and callers keep the legacy no-attachment behavior.
 */
export function sanitizeAttachmentMetaList(
  value: unknown,
): CompactionEntryAttachmentMeta[] | undefined {
  const items = toAttachmentMetaArray(value)
  return items.length > 0 ? boundAttachmentMetaList(items) : undefined
}

/** Read-side guard for both lists against one shared budget. */
export function sanitizeAttachmentMetaPair(
  attachments: unknown,
  hookResults: unknown,
): {
  attachments?: CompactionEntryAttachmentMeta[]
  hookResults?: CompactionEntryAttachmentMeta[]
} {
  return boundAttachmentMetaPair(
    toAttachmentMetaArray(attachments),
    toAttachmentMetaArray(hookResults),
  )
}

function toAttachmentMetaArray(
  value: unknown,
): CompactionEntryAttachmentMeta[] {
  if (!Array.isArray(value)) return []
  const items: CompactionEntryAttachmentMeta[] = []
  for (const item of value) {
    const meta = toAttachmentMeta(item)
    if (meta) items.push(meta)
  }
  return items
}

export interface CreateCompactionSessionEntryInput {
  summary: string
  firstKeptEntryId: string
  tokensBefore: number
  method: CompactionMethodName
  shortSummary?: string
  preserveData?: Record<string, unknown>
  attachments?: CompactionEntryAttachmentMeta[]
  hookResults?: CompactionEntryAttachmentMeta[]
  parentUuid?: UUID | null
  uuid?: UUID
  timestamp?: string
}

export function createCompactionSessionEntry(
  input: CreateCompactionSessionEntryInput,
): CompactionSessionEntry {
  return {
    type: COMPACTION_SESSION_ENTRY_TYPE,
    uuid: input.uuid ?? (randomUUID() as UUID),
    ...(input.parentUuid !== undefined && { parentUuid: input.parentUuid }),
    summary: input.summary,
    ...(input.shortSummary !== undefined && {
      shortSummary: input.shortSummary,
    }),
    firstKeptEntryId: input.firstKeptEntryId,
    tokensBefore: input.tokensBefore,
    method: input.method,
    ...(input.preserveData !== undefined && {
      preserveData: input.preserveData,
    }),
    ...(input.attachments !== undefined && {
      attachments: input.attachments,
    }),
    ...(input.hookResults !== undefined && {
      hookResults: input.hookResults,
    }),
    timestamp: input.timestamp ?? new Date().toISOString(),
  }
}

/**
 * Append a compaction entry through sessionStorage's existing write queue so
 * it shares the same atomic append/flush/shutdown-seal semantics as every
 * other transcript row.
 *
 * Loaded lazily: sessionStorage pulls the full transcript dependency chain
 * (lodash, settings, napi parsers), and the entry type/validator must stay
 * usable from pure decision-graph code and tests.
 */
export async function appendCompactionEntry(
  entry: CompactionSessionEntry,
): Promise<void> {
  const { appendSessionEntry } = await import(
    '../../../utils/sessionStorage.js'
  )
  await appendSessionEntry(entry)
}
