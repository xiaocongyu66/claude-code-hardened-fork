import type {
  CompactionContext,
  CompactionMethod,
  CompactionOutcome,
} from '../contracts.js'

/**
 * Snapcompact: archive discarded history onto bitmap frames the vision model
 * reads back (no LLM call). W2 ships the skeleton only.
 */
export interface SnapcompactMethodDeps {
  isAvailable?(ctx: CompactionContext): boolean
  run?(ctx: CompactionContext): Promise<CompactionOutcome>
}

export function createSnapcompactMethod(
  deps?: SnapcompactMethodDeps | null,
): CompactionMethod {
  return {
    name: 'snapcompact',
    isAvailable: ctx => deps?.isAvailable?.(ctx) ?? false,
    run: async (ctx): Promise<CompactionOutcome> =>
      deps?.run
        ? deps.run(ctx)
        : {
            kind: 'skipped',
            method: 'snapcompact',
            reason: 'snapcompact-not-available',
          },
  }
}

export const snapcompactMethod = createSnapcompactMethod()
