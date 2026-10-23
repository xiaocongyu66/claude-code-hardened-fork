// Adapter from the pure shake reducer (W1) to the injected ShakeReducer
// interface used by the compaction method chain (W2).
//
// Offloaded text is persisted through CCH's existing tool-result storage and
// replaced with a short recoverable path reference, so a shaken region can be
// read back with the normal Read tool. Nothing here calls a model.
import type { CompactionContext } from '../contracts.js'
import type { ShakeReducer, ShakeReduction } from '../methods/shake.js'
import { estimateTokens } from '../tokens/index.js'
import { DEFAULT_PRUNE_CONFIG, pruneToolOutputs } from './prune.js'
import {
  DEFAULT_SHAKE_CONFIG,
  shakeMessages,
  type ShakeConfig,
  type ShakeRegion,
} from './shake.js'

export interface ShakeReducerOptions {
  config?: ShakeConfig
  /** Override the default tool-result storage offload (tests use this). */
  offload?: (region: ShakeRegion, ctx: CompactionContext) => Promise<string>
}

export function createShakeReducer(
  options: ShakeReducerOptions = {},
): ShakeReducer {
  const config = options.config ?? DEFAULT_SHAKE_CONFIG
  const offload = options.offload ?? defaultOffload
  return {
    async reduce(ctx: CompactionContext): Promise<ShakeReduction | null> {
      const countTokens = (text: string) =>
        estimateTokens(text, ctx.model).tokens
      // Cheap deterministic pre-pass: age-based pruning and useless-result
      // elision before the more aggressive shake. Upstream's
      // pruneToolOutputs does not enable supersede reads by default.
      const pruned = pruneToolOutputs(ctx.messages, countTokens, {
        ...DEFAULT_PRUNE_CONFIG,
        supersedeKey: undefined,
      })
      const result = await shakeMessages(
        pruned.messages,
        countTokens,
        config,
        region => offload(region, ctx),
      )
      const tokensSaved = pruned.tokensSaved + result.tokensSaved
      if (tokensSaved <= 0) return null
      return {
        messages: result.messages,
        tokensSaved,
      }
    },
  }
}

async function defaultOffload(
  region: ShakeRegion,
  ctx: CompactionContext,
): Promise<string> {
  // Lazy require keeps the storage/config chain out of the orchestrator's
  // init path (same pattern as the legacy compact loaders).
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { persistToolResult } =
    require('../../../utils/toolResultStorage.js') as typeof import('../../../utils/toolResultStorage.js')
  /* eslint-enable @typescript-eslint/no-require-imports */

  const id = `shake-${ctx.agentId ?? 'main'}-${region.messageIndex}-${region.blockIndex}-${ctx.now()}`
  const persisted = await persistToolResult(region.originalText, id)
  if ('error' in persisted) {
    // Let shakeMessages skip this region: never replace recoverable content
    // with a marker that has no target.
    throw new Error(`shake offload failed: ${persisted.error}`)
  }
  return `[Shaken: ${region.label} content moved to ${persisted.filepath}]`
}
