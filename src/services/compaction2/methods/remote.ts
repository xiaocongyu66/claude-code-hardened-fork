import type {
  CompactionContext,
  CompactionMethod,
  CompactionOutcome,
} from '../contracts.js'

/**
 * Provider-native server compaction (OpenAI Responses compact / Anthropic
 * compaction beta). W2 ships the skeleton only: unavailable by default, and a
 * dependency hook for the provider workstream to fill in.
 */
export interface RemoteMethodDeps {
  isAvailable?(ctx: CompactionContext): boolean
  run?(ctx: CompactionContext): Promise<CompactionOutcome>
}

export function createRemoteMethod(
  deps?: RemoteMethodDeps | null,
): CompactionMethod {
  return {
    name: 'remote',
    isAvailable: ctx => deps?.isAvailable?.(ctx) ?? false,
    run: async (ctx): Promise<CompactionOutcome> =>
      deps?.run
        ? deps.run(ctx)
        : {
            kind: 'skipped',
            method: 'remote',
            reason: 'remote-not-available',
          },
  }
}

export const remoteMethod = createRemoteMethod()
