// Context promotion: switch to a strictly larger-context model instead of
// compacting. W9 ships the decision only; the caller (W8) owns the actual
// model switch and retry.
import type { CompactionContext } from '../contracts.js'
import type { ContextPromotion } from './overflow.js'
import type { PromotionResult } from './types.js'

export interface PromotionCandidate {
  model: string
  windowTokens: number
}

export interface PromotionCandidateSource {
  /** Model → context window map, e.g. `settings.contextWindowOverrides`. */
  windowOverrides?: Record<string, number> | null
  /** Explicitly known available models. */
  candidates?: readonly PromotionCandidate[] | null
}

/**
 * Normalize both candidate sources into one deduplicated list, keeping the
 * larger window when the same model appears twice.
 */
export function collectPromotionCandidates(
  source: PromotionCandidateSource,
): PromotionCandidate[] {
  const byModel = new Map<string, PromotionCandidate>()
  for (const [model, windowTokens] of Object.entries(
    source.windowOverrides ?? {},
  )) {
    if (typeof model !== 'string' || model.length === 0) continue
    if (!Number.isFinite(windowTokens) || windowTokens <= 0) continue
    byModel.set(model, { model, windowTokens })
  }
  for (const candidate of source.candidates ?? []) {
    if (!candidate || typeof candidate.model !== 'string') continue
    if (candidate.model.length === 0) continue
    if (
      !Number.isFinite(candidate.windowTokens) ||
      candidate.windowTokens <= 0
    ) {
      continue
    }
    const existing = byModel.get(candidate.model)
    if (!existing || candidate.windowTokens > existing.windowTokens) {
      byModel.set(candidate.model, {
        model: candidate.model,
        windowTokens: candidate.windowTokens,
      })
    }
  }
  return [...byModel.values()]
}

/**
 * Pick the candidate with the largest window that is strictly larger than the
 * current window. The current model is never a promotion target. Returns
 * `undefined` when no such candidate exists (including an unknown window).
 */
export function selectPromotion(
  currentModel: string,
  currentWindow: number,
  candidates: readonly PromotionCandidate[] | null | undefined,
): PromotionCandidate | undefined {
  if (!Number.isFinite(currentWindow) || currentWindow <= 0) return undefined
  if (!candidates || candidates.length === 0) return undefined

  let best: PromotionCandidate | undefined
  for (const candidate of candidates) {
    if (!candidate || typeof candidate.model !== 'string') continue
    if (candidate.model.length === 0) continue
    if (candidate.model === currentModel) continue
    if (!Number.isFinite(candidate.windowTokens)) continue
    if (candidate.windowTokens <= currentWindow) continue
    if (!best || candidate.windowTokens > best.windowTokens) {
      best = candidate
    }
  }
  return best
}

export interface CreateContextPromotionOptions
  extends PromotionCandidateSource {
  /** Resolve the current model's effective window. */
  resolveWindow?: (model: string) => number
}

/**
 * Adapt {@link selectPromotion} to the overflow trigger's `ContextPromotion`
 * interface. Promotion is a decision only: it reports the target model but
 * does not switch anything.
 */
export function createContextPromotion(
  options: CreateContextPromotionOptions = {},
): ContextPromotion {
  const candidates = collectPromotionCandidates(options)

  const targetFor = (
    ctx: CompactionContext,
  ): PromotionCandidate | undefined => {
    const currentWindow = options.resolveWindow?.(ctx.model) ?? 0
    return selectPromotion(ctx.model, currentWindow, candidates)
  }

  return {
    isAvailable: ctx => targetFor(ctx) !== undefined,
    promote: (ctx): PromotionResult => {
      const target = targetFor(ctx)
      if (!target) {
        return { kind: 'skipped', reason: 'no-larger-context-candidate' }
      }
      return {
        kind: 'promoted',
        model: target.model,
        reason: `larger-window:${target.windowTokens}`,
      }
    },
  }
}
