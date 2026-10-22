import type {
  CompactionContext,
  CompactionMethod,
  CompactionOutcome,
} from '../contracts.js'

/**
 * Handoff: generate a handoff document and continue from it. W2 ships the
 * skeleton only; overflow reason skips this method by construction (the
 * request would reuse the overflowing input).
 */
export interface HandoffMethodDeps {
  isAvailable?(ctx: CompactionContext): boolean
  run?(ctx: CompactionContext): Promise<CompactionOutcome>
}

export function createHandoffMethod(
  deps?: HandoffMethodDeps | null,
): CompactionMethod {
  return {
    name: 'handoff',
    isAvailable: ctx =>
      ctx.trigger !== 'overflow' && (deps?.isAvailable?.(ctx) ?? false),
    run: async (ctx): Promise<CompactionOutcome> =>
      deps?.run
        ? deps.run(ctx)
        : {
            kind: 'skipped',
            method: 'handoff',
            reason: 'handoff-not-available',
          },
  }
}

export const handoffMethod = createHandoffMethod()
