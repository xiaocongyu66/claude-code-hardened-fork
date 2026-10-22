/**
 * Payload-rejection guard (oh-my-pi parity).
 *
 * HTTP 413 / media-budget rejections are not automatically token overflow.
 * They only count as token overflow when provider-reported input usage proves
 * it; otherwise automatic continuation is blocked (or, with an unknown window,
 * a runnable overflow method may still be attempted) and snapcompact — which
 * *adds* image bytes — is excluded.
 */

/** Payload-shaped 413s share text patterns with overflow; trust the payload
 * classification when local occupancy stays under this ceiling (>=10% headroom)
 * and reported usage stays within the window. */
export const PAYLOAD_REJECTION_OCCUPANCY_CEILING = 0.9

/** Narrow media-limit evidence: the noun must co-occur with a count/limit. */
export const PAYLOAD_MEDIA_LIMIT_EVIDENCE_PATTERN =
  /\btoo many (?:images?|frames?|pixels?)\b|\b(?:images?|frames?|pixels?)\s*(?:count|limit)\b|\blimit of \d+\s*(?:images?|frames?|pixels?)\b|\bmaximum(?: of \d+)? (?:images?|frames?|pixels?)\b|\b(?:number|count) of (?:images?|frames?|pixels?)\b|\b(?:images?|frames?|pixels?)\b.{0,20}\bexceeds?\b.{0,20}\bmaximum\b|\b(?:images?|frames?) (?:is |are )?too large\b|\b(?:images?|frames?) dimensions?\b.{0,30}\bexceeds?\b.{0,30}\b(?:pixels?|\d+)\b/i

export interface PayloadRejectionEvidence {
  status?: number
  message?: string
  /** Provider-reported input tokens for the rejected request, when known. */
  providerInputTokens?: number
  contextWindow?: number
  /** Local estimate for the rejected request. */
  tokenCount?: number
}

export interface PayloadGuardDecision {
  isPayloadRejection: boolean
  mediaEvidence: boolean
  /** True only when provider usage proves the request exceeded the window. */
  tokenOverflowProven: boolean
  /** When true, automatic continuation/compaction must not run. */
  blockCompaction: boolean
  /** Byte/media-shaped rejection: snapcompact must be skipped. */
  excludeMediaMethods: boolean
  reason: string
}

export function hasExplicitMediaRejectionEvidence(
  message: string | undefined,
): boolean {
  return (
    message !== undefined && PAYLOAD_MEDIA_LIMIT_EVIDENCE_PATTERN.test(message)
  )
}

export function isPayloadRejectionError(
  status: number | undefined,
  message: string | undefined,
): boolean {
  if (status === 413) return true
  if (!message) return false
  return /\b413\b|request(?:\s+entity)?\s+too\s+large|payload\s+too\s+large|request_too_large|too\s+many\s+(?:images?|frames?|pixels?)|image\s+count\s+exceeds/i.test(
    message,
  )
}

export function evaluatePayloadGuard(
  evidence: PayloadRejectionEvidence,
): PayloadGuardDecision {
  const isPayloadRejection = isPayloadRejectionError(
    evidence.status,
    evidence.message,
  )
  const mediaEvidence = hasExplicitMediaRejectionEvidence(evidence.message)
  const windowTokens = evidence.contextWindow ?? 0
  const localTokens = evidence.tokenCount ?? 0
  const providerTokens = evidence.providerInputTokens

  const tokenOverflowProven =
    providerTokens !== undefined &&
    windowTokens > 0 &&
    providerTokens > windowTokens

  if (!isPayloadRejection) {
    return {
      isPayloadRejection: false,
      mediaEvidence,
      tokenOverflowProven,
      blockCompaction: false,
      excludeMediaMethods: false,
      reason: 'not-payload-rejection',
    }
  }

  if (tokenOverflowProven) {
    return {
      isPayloadRejection: true,
      mediaEvidence,
      tokenOverflowProven,
      blockCompaction: false,
      excludeMediaMethods: mediaEvidence,
      reason: 'usage-proven-token-overflow',
    }
  }

  if (mediaEvidence) {
    return {
      isPayloadRejection: true,
      mediaEvidence,
      tokenOverflowProven: false,
      blockCompaction: true,
      excludeMediaMethods: true,
      reason: 'media-limit-evidence',
    }
  }

  const occupancy =
    windowTokens > 0 ? localTokens / windowTokens : Number.POSITIVE_INFINITY
  const localHeadroom =
    windowTokens > 0 && occupancy <= PAYLOAD_REJECTION_OCCUPANCY_CEILING
  const usageWithinWindow =
    providerTokens === undefined ||
    windowTokens <= 0 ||
    providerTokens <= windowTokens

  if (windowTokens > 0 && localHeadroom && usageWithinWindow) {
    return {
      isPayloadRejection: true,
      mediaEvidence: false,
      tokenOverflowProven: false,
      blockCompaction: true,
      excludeMediaMethods: true,
      reason: 'payload-budget-with-headroom',
    }
  }

  // Unknown window: maintenance may attempt a runnable overflow method.
  return {
    isPayloadRejection: true,
    mediaEvidence: false,
    tokenOverflowProven: false,
    blockCompaction: false,
    excludeMediaMethods: true,
    reason: 'unknown-window-attempt',
  }
}
