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
import type { CompactionMethodName } from '../contracts.js'

export const COMPACTION_SESSION_ENTRY_TYPE = 'compaction' as const

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

export interface CreateCompactionSessionEntryInput {
  summary: string
  firstKeptEntryId: string
  tokensBefore: number
  method: CompactionMethodName
  shortSummary?: string
  preserveData?: Record<string, unknown>
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
