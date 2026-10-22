// Ported from oh-my-pi (MIT). See THIRD_PARTY_NOTICES.md in this directory.
import type { CompactionContext, CompactionSettings } from '../contracts.js'
import {
  evaluatePayloadGuard,
  type PayloadGuardDecision,
  type PayloadRejectionEvidence,
} from '../guards/payload.js'
import { resolveThresholdDecision } from './threshold.js'
import type {
  PromotionResult,
  ThresholdInput,
  TriggerDecision,
} from './types.js'

/**
 * Context promotion is tried before overflow compaction: switching to a
 * configured larger model avoids summarizing anything. W2 ships the interface
 * only; the default implementation is absent and reports `skipped`.
 */
export interface ContextPromotion {
  isAvailable(ctx: CompactionContext): boolean
  promote(ctx: CompactionContext): PromotionResult | Promise<PromotionResult>
}

export interface OverflowInput extends ThresholdInput {
  settings: CompactionSettings
  ctx?: CompactionContext
  overflowDetected?: boolean
  payloadRejection?: PayloadRejectionEvidence
  promotion?: ContextPromotion | null
}

export async function tryContextPromotion(
  ctx: CompactionContext | undefined,
  promotion: ContextPromotion | null | undefined,
): Promise<PromotionResult> {
  if (!promotion) {
    return { kind: 'skipped', reason: 'no-promotion-configured' }
  }
  if (!ctx) {
    return { kind: 'skipped', reason: 'no-compaction-context' }
  }
  try {
    if (!promotion.isAvailable(ctx)) {
      return { kind: 'skipped', reason: 'promotion-unavailable' }
    }
    return await promotion.promote(ctx)
  } catch (error) {
    return {
      kind: 'skipped',
      reason: `promotion-failed: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

/**
 * Overflow trigger. Evidence is either an explicit overflow signal (the
 * provider rejected the prompt) or provider usage above the window. Payload
 * rejections that do not prove token overflow block compaction instead of
 * promoting/summarizing.
 */
export async function evaluateOverflowTrigger(
  input: OverflowInput,
): Promise<TriggerDecision> {
  const threshold = resolveThresholdDecision(input)
  const payload: PayloadGuardDecision | undefined = input.payloadRejection
    ? evaluatePayloadGuard({
        ...input.payloadRejection,
        contextWindow: input.windowTokens,
        tokenCount: input.tokenCount,
      })
    : undefined

  const overflowDetected =
    input.overflowDetected === true ||
    (input.windowTokens > 0 && input.tokenCount > input.windowTokens)

  if (!overflowDetected) {
    return {
      trigger: 'overflow',
      shouldCompact: false,
      reason: 'no-overflow-evidence',
      threshold,
      payload,
    }
  }

  if (payload?.blockCompaction) {
    return {
      trigger: 'overflow',
      shouldCompact: false,
      reason: `payload-rejection: ${payload.reason}`,
      threshold,
      payload,
    }
  }

  const promotion = await tryContextPromotion(input.ctx, input.promotion)
  if (promotion.kind === 'promoted') {
    return {
      trigger: 'overflow',
      shouldCompact: false,
      reason: `context-promoted: ${promotion.model}`,
      threshold,
      promotion,
      payload,
    }
  }

  return {
    trigger: 'overflow',
    shouldCompact: true,
    reason: 'overflow',
    threshold,
    promotion,
    payload,
  }
}
