import { describe, expect, test } from 'bun:test'
import {
  evaluatePayloadGuard,
  hasExplicitMediaRejectionEvidence,
  isPayloadRejectionError,
} from '../guards/payload.js'
import { evaluateProgressGuard } from '../guards/progress.js'

describe('progress guard', () => {
  test('requires residual context at or below 80% of the threshold', () => {
    expect(evaluateProgressGuard(170_000, 136_000).ok).toBe(true)
    expect(evaluateProgressGuard(170_000, 136_001).ok).toBe(false)
  })

  test('reports signed headroom', () => {
    expect(evaluateProgressGuard(170_000, 80_000).headroomTokens).toBe(90_000)
    expect(evaluateProgressGuard(170_000, 180_000).headroomTokens).toBe(-10_000)
  })
})

describe('payload rejection guard', () => {
  test('recognizes 413 and payload-shaped messages', () => {
    expect(isPayloadRejectionError(413, undefined)).toBe(true)
    expect(isPayloadRejectionError(undefined, 'request too large')).toBe(true)
    expect(isPayloadRejectionError(400, 'bad request')).toBe(false)
  })

  test('a 413 with local headroom is not token overflow', () => {
    const decision = evaluatePayloadGuard({
      status: 413,
      message: 'request too large',
      contextWindow: 200_000,
      tokenCount: 100_000,
    })
    expect(decision.isPayloadRejection).toBe(true)
    expect(decision.tokenOverflowProven).toBe(false)
    expect(decision.blockCompaction).toBe(true)
    expect(decision.excludeMediaMethods).toBe(true)
  })

  test('provider usage above the window proves token overflow', () => {
    const decision = evaluatePayloadGuard({
      status: 413,
      message: 'request too large',
      contextWindow: 200_000,
      tokenCount: 100_000,
      providerInputTokens: 250_000,
    })
    expect(decision.tokenOverflowProven).toBe(true)
    expect(decision.blockCompaction).toBe(false)
    // No media evidence → snapcompact is allowed again.
    expect(decision.excludeMediaMethods).toBe(false)
  })

  test('media-limit evidence blocks even without usage', () => {
    expect(
      hasExplicitMediaRejectionEvidence('too many images in request'),
    ).toBe(true)
    const decision = evaluatePayloadGuard({
      status: 400,
      message: 'request_too_large: too many images',
      contextWindow: 200_000,
      tokenCount: 100_000,
    })
    expect(decision.mediaEvidence).toBe(true)
    expect(decision.blockCompaction).toBe(true)
  })

  test('an unknown window may still attempt a runnable method', () => {
    const decision = evaluatePayloadGuard({
      status: 413,
      message: 'payload too large',
    })
    expect(decision.blockCompaction).toBe(false)
    expect(decision.excludeMediaMethods).toBe(true)
    expect(decision.reason).toBe('unknown-window-attempt')
  })
})
