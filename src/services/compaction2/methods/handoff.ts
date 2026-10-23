import type {
  CompactionContext,
  CompactionMethod,
  CompactionOutcome,
} from '../contracts.js'
import { computeRemoteCut } from './remote/index.js'

/**
 * Handoff: summarize the session into a structured handoff document and
 * continue from it. The document replaces the cut prefix, so a later session
 * can pick up goals, files, todos and constraints without the full history.
 *
 * The model call is injected through `summarize(ctx, { instructions })`; the
 * orchestrator reuses the legacy soft-compaction runner for it so there is no
 * second API client. Overflow skips this method by construction: the request
 * would summarize the same input that already failed to fit.
 */

export const HANDOFF_PRESERVE_KEY = 'handoff'
export const HANDOFF_DOCUMENT_VERSION = 1

export const DEFAULT_HANDOFF_INSTRUCTIONS = [
  'Write a handoff document for a fresh session that must continue this work.',
  'Return Markdown with these sections:',
  '## Recent goals',
  '## Key files',
  '## Todo',
  '## Constraints',
  'Preserve concrete file paths, commands, decisions and anything the user',
  'explicitly required. Be concise and do not invent facts.',
].join(' ')

export interface HandoffSummaryRequest {
  instructions: string
}

/**
 * Result of a handoff summarization. Custom/`run`-less embedders may return a
 * bare string; the orchestrator's legacy runner also returns the full
 * `CompactionResult` so the committed outcome keeps `messagesToKeep`,
 * attachments and hook results instead of rebuilding a summary-only result.
 */
export interface HandoffSummary {
  document: string
  /** Full legacy CompactionResult (type-erased to keep contracts independent). */
  legacyCompactionResult?: unknown
}

export type HandoffSummaryValue = string | HandoffSummary

export interface HandoffMethodDeps {
  /** Produce the handoff document. Injected by the orchestrator (soft path). */
  summarize?(
    ctx: CompactionContext,
    request: HandoffSummaryRequest,
  ): Promise<HandoffSummaryValue>
  /** `/compact [instructions]` focus text appended to the base prompt. */
  instructions?: string
  isAvailable?(ctx: CompactionContext): boolean
  /** Full override, kept for tests and embedders. */
  run?(ctx: CompactionContext): Promise<CompactionOutcome>
}

export function buildHandoffInstructions(custom?: string): string {
  const focus = custom?.trim()
  if (!focus) return DEFAULT_HANDOFF_INSTRUCTIONS
  return `${DEFAULT_HANDOFF_INSTRUCTIONS}\n\nAdditional focus:\n${focus}`
}

export interface HandoffDocument {
  version: typeof HANDOFF_DOCUMENT_VERSION
  document: string
}

export function createHandoffMethod(
  deps?: HandoffMethodDeps | null,
): CompactionMethod {
  const summarize = deps?.summarize
  const runOverride = deps?.run
  const isConfigured =
    typeof summarize === 'function' || typeof runOverride === 'function'
  return {
    name: 'handoff',
    isAvailable: ctx => {
      if (ctx.trigger === 'overflow') return false
      if (!deps || !isConfigured) return false
      return deps.isAvailable?.(ctx) ?? true
    },
    run: async (ctx): Promise<CompactionOutcome> => {
      if (runOverride) return runOverride(ctx)
      if (!summarize) {
        return {
          kind: 'skipped',
          method: 'handoff',
          reason: 'handoff-not-available',
        }
      }
      try {
        // Reuse the remote cut so the retained tail never drifts from the
        // other summary methods and tool pairs stay together.
        const cut = computeRemoteCut(ctx)
        if (cut.messages.length === 0) {
          return {
            kind: 'skipped',
            method: 'handoff',
            reason: 'handoff-empty-prefix',
          }
        }
        const summarized = await summarize(ctx, {
          instructions: buildHandoffInstructions(deps?.instructions),
        })
        const document = (
          typeof summarized === 'string' ? summarized : summarized.document
        ).trim()
        if (document.length === 0) {
          return {
            kind: 'failed',
            method: 'handoff',
            reason: 'handoff-empty-document',
          }
        }
        const threshold = ctx.settings.thresholdTokens ?? 0
        const preserve: HandoffDocument = {
          version: HANDOFF_DOCUMENT_VERSION,
          document,
        }
        const legacyCompactionResult =
          typeof summarized === 'string'
            ? undefined
            : summarized.legacyCompactionResult
        return {
          kind: 'compacted',
          method: 'handoff',
          cutPoint: cut.cutPoint,
          tokensSaved: Math.max(0, cut.cutPoint.tokensBefore - cut.tokensAfter),
          headroomTokens: threshold > 0 ? threshold - cut.tokensAfter : 0,
          summary: document,
          preserveData: {
            [HANDOFF_PRESERVE_KEY]: preserve,
            // The legacy runner's full result carries messagesToKeep,
            // attachments and hookResults. Keeping it lets
            // `getLegacyCompactionResult` return it directly rather than
            // synthesizing a summary-only result that drops the retained tail.
            ...(legacyCompactionResult !== undefined
              ? { legacyCompactionResult }
              : {}),
          },
        }
      } catch (error) {
        return {
          kind: 'failed',
          method: 'handoff',
          reason: error instanceof Error ? error.message : String(error),
          error,
        }
      }
    },
  }
}

export const handoffMethod = createHandoffMethod()
