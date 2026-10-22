import type { CompactionResult } from '../../compact/compact.js'
import type { Message } from '../../../types/message.js'
import type {
  CompactionContext,
  CompactionMethod,
  CompactionOutcome,
  CutPoint,
  TriggerReason,
} from '../contracts.js'

export interface SoftCompactRequest {
  messages: Message[]
  instructions?: string
  trigger: TriggerReason
  isAutoCompact: boolean
}

export interface SoftCompactRun {
  result: CompactionResult
  tokensBefore: number
  tokensAfter: number
}

/**
 * Injected legacy runner. W2 keeps `compactConversation` out of this module so
 * the method-chain decision tests stay pure; production wiring passes a runner
 * that calls the existing legacy implementation.
 */
export type SoftCompactRunner = (
  request: SoftCompactRequest,
) => Promise<SoftCompactRun>

export interface SoftMethodDeps {
  run: SoftCompactRunner
  /** `/compact [instructions]` focus text for this invocation. */
  instructions?: string
  resolveThresholdTokens?(ctx: CompactionContext): number | undefined
}

/**
 * Soft compaction: summarize in place through the legacy `compactConversation`
 * path. Preserves `/compact [instructions]` semantics: manual runs keep the
 * follow-up question flow and pass the focus text through.
 */
export function createSoftMethod(
  deps?: SoftMethodDeps | null,
): CompactionMethod {
  return {
    name: 'soft',
    isAvailable: ctx => Boolean(deps) && ctx.messages.length > 0,
    run: async (ctx: CompactionContext): Promise<CompactionOutcome> => {
      if (!deps) {
        return {
          kind: 'skipped',
          method: 'soft',
          reason: 'soft-runner-not-configured',
        }
      }
      try {
        const run = await deps.run({
          messages: [...ctx.messages],
          instructions: deps.instructions,
          trigger: ctx.trigger,
          isAutoCompact: ctx.trigger !== 'manual',
        })
        const tokensSaved = Math.max(0, run.tokensBefore - run.tokensAfter)
        const threshold = deps.resolveThresholdTokens?.(ctx)
        const headroomTokens =
          threshold === undefined ? 0 : threshold - run.tokensAfter
        const cutPoint: CutPoint = {
          firstKeptEntryId:
            (run.result.messagesToKeep?.[0] as { uuid?: string } | undefined)
              ?.uuid ?? '',
          tokensBefore: run.tokensBefore,
          boundaryMessage: run.result.boundaryMarker,
        }
        return {
          kind: 'compacted',
          method: 'soft',
          cutPoint,
          tokensSaved,
          headroomTokens,
          summary: run.result.userDisplayMessage,
          preserveData: { legacyCompactionResult: run.result },
        }
      } catch (error) {
        return {
          kind: 'failed',
          method: 'soft',
          reason: error instanceof Error ? error.message : String(error),
          error,
        }
      }
    },
  }
}
