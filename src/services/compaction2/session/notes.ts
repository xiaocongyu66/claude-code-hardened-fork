// Ported from oh-my-pi (MIT). See THIRD_PARTY_NOTICES.md in this directory.
/**
 * Persistent context notes (`context_notes`) and rollover requests
 * (`new_context`) — storage and injection interfaces only.
 *
 * Rules from the reference implementation:
 * - A notebook replacement is capped at 16,384 UTF-8 bytes; an oversized write
 *   fails without replacing the notes.
 * - Notebook revisions are journal entries; only the latest revision is
 *   injected into model context, including after resume/fork.
 * - `text: ""` clears the visible notebook.
 * - Rollover (`new_context`) retains the notebook and is applied by the caller
 *   at the next safe tool-loop boundary.
 *
 * Tool registration is deliberately out of scope.
 */

export const CONTEXT_NOTES_MAX_BYTES = 16_384
export const CONTEXT_NOTES_OPEN_TAG = '<context_notes>'
export const CONTEXT_NOTES_CLOSE_TAG = '</context_notes>'

export type ContextNotesWriteFailure =
  | 'context-notes-too-large'
  | 'context-notes-invalid'

export type ContextNotesWriteResult =
  | { ok: true; revision: number; bytes: number }
  | { ok: false; reason: ContextNotesWriteFailure; bytes: number }

export interface ContextNoteRevision {
  revision: number
  text: string
  bytes: number
  createdAt: number
}

export interface ContextNotesStore {
  readonly maxBytes: number
  write(text: string, now?: number): ContextNotesWriteResult
  latest(): ContextNoteRevision | undefined
  /** Latest revision text, or undefined when the notebook is empty/cleared. */
  visibleText(): string | undefined
  revisions(): readonly ContextNoteRevision[]
}

export interface ContextNotesStoreOptions {
  maxBytes?: number
  now?: () => number
  initialText?: string
}

const encoder = new TextEncoder()

export function utf8ByteLength(text: string): number {
  return encoder.encode(text).length
}

export function createContextNotesStore(
  options: ContextNotesStoreOptions = {},
): ContextNotesStore {
  const maxBytes = options.maxBytes ?? CONTEXT_NOTES_MAX_BYTES
  const now = options.now ?? (() => Date.now())
  const journal: ContextNoteRevision[] = []
  let nextRevision = 1

  const store: ContextNotesStore = {
    maxBytes,
    write(text, at) {
      if (typeof text !== 'string') {
        return { ok: false, reason: 'context-notes-invalid', bytes: 0 }
      }
      const bytes = utf8ByteLength(text)
      if (bytes > maxBytes) {
        return { ok: false, reason: 'context-notes-too-large', bytes }
      }
      const revision = nextRevision++
      journal.push({ revision, text, bytes, createdAt: at ?? now() })
      return { ok: true, revision, bytes }
    },
    latest() {
      return journal.length > 0 ? journal[journal.length - 1] : undefined
    },
    visibleText() {
      const latest = journal[journal.length - 1]
      if (!latest || latest.text.length === 0) return undefined
      return latest.text
    },
    revisions() {
      return journal
    },
  }

  if (options.initialText !== undefined) {
    store.write(options.initialText)
  }
  return store
}

/** Wrap notes for injection; empty notes produce no block. */
export function renderContextNotesInjection(text: string | undefined): string {
  if (!text || text.length === 0) return ''
  return `${CONTEXT_NOTES_OPEN_TAG}\n${text}\n${CONTEXT_NOTES_CLOSE_TAG}`
}

export interface ContextNotesInjection {
  kind: 'context_notes'
  text: string
  block: string
  visibleRevision: number
}

/** Injection descriptor for the latest visible revision, if any. */
export function buildContextNotesInjection(
  store: ContextNotesStore,
): ContextNotesInjection | undefined {
  const text = store.visibleText()
  if (!text) return undefined
  const latest = store.latest()
  if (!latest) return undefined
  return {
    kind: 'context_notes',
    text,
    block: renderContextNotesInjection(text),
    visibleRevision: latest.revision,
  }
}

export interface NewContextRequest {
  requestedAt: number
  reason?: string
}

export interface NewContextController {
  request(reason?: string): NewContextRequest
  pending(): NewContextRequest | undefined
  /** Take the pending request at a safe boundary; the notebook is retained. */
  consume(): NewContextRequest | undefined
}

export function createNewContextController(
  now: () => number = () => Date.now(),
): NewContextController {
  let pending: NewContextRequest | undefined
  return {
    request(reason) {
      const request: NewContextRequest = {
        requestedAt: now(),
        ...(reason ? { reason } : {}),
      }
      pending = request
      return request
    },
    pending() {
      return pending
    },
    consume() {
      const request = pending
      pending = undefined
      return request
    },
  }
}
