import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_COMPACTION_SETTINGS,
  type CompactionSettings,
} from '../../contracts.js'
import {
  consumeMidTurnSkip,
  createLoopCompactionState,
  markMidTurnConsumed,
  selectOverflowRecovery,
  shouldAttemptIncompleteRecovery,
  shouldAttemptMidTurn,
} from '../../triggers/loop.js'

const WINDOW = 200_000
// reserve = max(15% of 200k, 16384) = 30k → threshold = 170k
const OVER = 180_000
const UNDER = 160_000

describe('mid-turn trigger selection', () => {
  test('fires only above the threshold', () => {
    expect(
      shouldAttemptMidTurn({
        enabled: true,
        thresholdAttemptedThisIteration: false,
        tokenCount: OVER,
        windowTokens: WINDOW,
      }),
    ).toBe(true)
    expect(
      shouldAttemptMidTurn({
        enabled: true,
        thresholdAttemptedThisIteration: false,
        tokenCount: UNDER,
        windowTokens: WINDOW,
      }),
    ).toBe(false)
  })

  test('honors midTurnEnabled', () => {
    const settings: CompactionSettings = {
      ...DEFAULT_COMPACTION_SETTINGS,
      midTurnEnabled: false,
    }
    expect(
      shouldAttemptMidTurn({
        enabled: true,
        thresholdAttemptedThisIteration: false,
        tokenCount: OVER,
        windowTokens: WINDOW,
        settings,
      }),
    ).toBe(false)
  })

  test('does not repeat a threshold pass from the same iteration', () => {
    expect(
      shouldAttemptMidTurn({
        enabled: true,
        thresholdAttemptedThisIteration: true,
        tokenCount: OVER,
        windowTokens: WINDOW,
      }),
    ).toBe(false)
  })

  test('flag off never selects mid-turn', () => {
    expect(
      shouldAttemptMidTurn({
        enabled: false,
        thresholdAttemptedThisIteration: false,
        tokenCount: OVER,
        windowTokens: WINDOW,
      }),
    ).toBe(false)
  })
})

describe('mid-turn one-shot dedup', () => {
  test('the skip flag is consumed exactly once', () => {
    const state = createLoopCompactionState()
    expect(consumeMidTurnSkip(state)).toBe(false)
    markMidTurnConsumed(state)
    expect(consumeMidTurnSkip(state)).toBe(true)
    expect(consumeMidTurnSkip(state)).toBe(false)
  })
})

describe('overflow recovery selection', () => {
  test('V2 owns prompt-too-long when enabled', () => {
    expect(
      selectOverflowRecovery({
        v2Enabled: true,
        promptTooLong: true,
        reactiveAvailable: true,
        alreadyAttempted: false,
      }),
    ).toBe('v2')
  })

  test('an already-attempted V2 pass surfaces instead of running reactive', () => {
    expect(
      selectOverflowRecovery({
        v2Enabled: true,
        promptTooLong: true,
        reactiveAvailable: true,
        alreadyAttempted: true,
      }),
    ).toBe('surface')
  })

  test('flag off preserves the legacy reactive path', () => {
    expect(
      selectOverflowRecovery({
        v2Enabled: false,
        promptTooLong: true,
        reactiveAvailable: true,
        alreadyAttempted: false,
      }),
    ).toBe('reactive')
    expect(
      selectOverflowRecovery({
        v2Enabled: false,
        promptTooLong: true,
        reactiveAvailable: false,
        alreadyAttempted: false,
      }),
    ).toBe('surface')
  })

  test('non-413 errors are never routed to recovery', () => {
    expect(
      selectOverflowRecovery({
        v2Enabled: true,
        promptTooLong: false,
        reactiveAvailable: true,
        alreadyAttempted: false,
      }),
    ).toBe('surface')
  })
})

describe('incomplete recovery selection', () => {
  test('fires for a length stop above the threshold', () => {
    expect(
      shouldAttemptIncompleteRecovery({
        v2Enabled: true,
        stopReason: 'length',
        tokenCount: OVER,
        windowTokens: WINDOW,
        alreadyAttempted: false,
      }),
    ).toBe(true)
    expect(
      shouldAttemptIncompleteRecovery({
        v2Enabled: true,
        stopReason: 'length',
        tokenCount: UNDER,
        windowTokens: WINDOW,
        alreadyAttempted: false,
      }),
    ).toBe(false)
  })

  test('accepts provider max-tokens stops', () => {
    expect(
      shouldAttemptIncompleteRecovery({
        v2Enabled: true,
        stopReason: 'max_tokens',
        tokenCount: OVER,
        windowTokens: WINDOW,
        alreadyAttempted: false,
      }),
    ).toBe(true)
  })

  test('ignores normal stops and prior attempts', () => {
    expect(
      shouldAttemptIncompleteRecovery({
        v2Enabled: true,
        stopReason: 'end_turn',
        tokenCount: OVER,
        windowTokens: WINDOW,
        alreadyAttempted: false,
      }),
    ).toBe(false)
    expect(
      shouldAttemptIncompleteRecovery({
        v2Enabled: true,
        stopReason: 'length',
        tokenCount: OVER,
        windowTokens: WINDOW,
        alreadyAttempted: true,
      }),
    ).toBe(false)
  })

  test('flag off never selects incomplete recovery', () => {
    expect(
      shouldAttemptIncompleteRecovery({
        v2Enabled: false,
        stopReason: 'length',
        tokenCount: OVER,
        windowTokens: WINDOW,
        alreadyAttempted: false,
      }),
    ).toBe(false)
  })
})
