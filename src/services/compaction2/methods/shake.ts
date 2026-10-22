import type { Message } from '../../../types/message.js'
import type {
  CompactionContext,
  CompactionMethod,
  CompactionOutcome,
} from '../contracts.js'

export interface ShakeReduction {
  messages: Message[]
  tokensSaved: number
  warning?: string
}

/**
 * Injected reducer interface (W1). W2 defines the contract and the null
 * degradation path; the actual mechanical elision lands with the reducer
 * workstream.
 */
export interface ShakeReducer {
  reduce(
    ctx: CompactionContext,
  ): ShakeReduction | null | Promise<ShakeReduction | null>
}

export interface ShakeMethodDeps {
  reducer?: ShakeReducer | null
  resolveThresholdTokens?(ctx: CompactionContext): number | undefined
}

export function createShakeMethod(
  deps?: ShakeMethodDeps | null,
): CompactionMethod {
  const reducer = deps?.reducer ?? null
  return {
    name: 'shake',
    isAvailable: () => reducer !== null,
    run: async (ctx: CompactionContext): Promise<CompactionOutcome> => {
      if (!reducer) {
        return {
          kind: 'skipped',
          method: 'shake',
          reason: 'no-shake-reducer',
        }
      }
      try {
        const reduction = await reducer.reduce(ctx)
        if (!reduction) {
          return {
            kind: 'skipped',
            method: 'shake',
            reason: 'shake-noop',
          }
        }
        const afterTokens = ctx.tokenCount(reduction.messages)
        const threshold = deps?.resolveThresholdTokens?.(ctx)
        return {
          kind: 'reduced',
          method: 'shake',
          messages: reduction.messages,
          tokensSaved: Math.max(0, reduction.tokensSaved),
          headroomTokens:
            threshold === undefined ? 0 : threshold - afterTokens,
          warning: reduction.warning,
        }
      } catch (error) {
        return {
          kind: 'failed',
          method: 'shake',
          reason: error instanceof Error ? error.message : String(error),
          error,
        }
      }
    },
  }
}
