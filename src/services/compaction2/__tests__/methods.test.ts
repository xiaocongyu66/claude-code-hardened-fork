import { describe, expect, test } from 'bun:test'
import type { CompactionResult } from '../../../services/compact/compact.js'
import type { Message } from '../../../types/message.js'
import {
  DEFAULT_COMPACTION_SETTINGS,
  type CompactionContext,
} from '../contracts.js'
import { createShakeMethod } from '../methods/shake.js'
import { createSoftMethod } from '../methods/soft.js'

const message = {
  type: 'user',
  message: { role: 'user', content: 'hello' },
  uuid: 'u1',
} as unknown as Message

function ctx(overrides: Partial<CompactionContext> = {}): CompactionContext {
  return {
    model: 'test-model',
    trigger: 'threshold',
    messages: [message],
    settings: DEFAULT_COMPACTION_SETTINGS,
    tokenCount: () => 180_000,
    estimateEntryTokens: () => 0,
    now: () => 0,
    ...overrides,
  }
}

const legacyResult: CompactionResult = {
  boundaryMarker: {} as never,
  summaryMessages: [],
  attachments: [],
  hookResults: [],
  messagesToKeep: [message],
  userDisplayMessage: 'summary',
  preCompactTokenCount: 180_000,
  truePostCompactTokenCount: 80_000,
}

describe('soft method', () => {
  test('wraps the injected legacy compactConversation runner', async () => {
    const soft = createSoftMethod({
      run: async () => ({
        result: legacyResult,
        tokensBefore: 180_000,
        tokensAfter: 80_000,
      }),
      resolveThresholdTokens: () => 170_000,
    })

    const outcome = await soft.run(ctx())
    expect(outcome.kind).toBe('compacted')
    if (outcome.kind !== 'compacted') return
    expect(outcome.method).toBe('soft')
    expect(outcome.tokensSaved).toBe(100_000)
    expect(outcome.headroomTokens).toBe(90_000)
    expect(outcome.cutPoint.firstKeptEntryId).toBe('u1')
    expect(outcome.preserveData?.legacyCompactionResult).toBe(legacyResult)
  })

  test('passes /compact instructions and manual semantics through', async () => {
    let seen:
      | { instructions?: string; isAutoCompact: boolean; trigger: string }
      | undefined
    const soft = createSoftMethod({
      instructions: 'focus on tests',
      run: async request => {
        seen = {
          instructions: request.instructions,
          isAutoCompact: request.isAutoCompact,
          trigger: request.trigger,
        }
        return {
          result: legacyResult,
          tokensBefore: 180_000,
          tokensAfter: 80_000,
        }
      },
    })

    await soft.run(ctx({ trigger: 'manual' }))
    expect(seen).toEqual({
      instructions: 'focus on tests',
      isAutoCompact: false,
      trigger: 'manual',
    })
  })

  test('is unavailable without a runner', () => {
    expect(createSoftMethod(null).isAvailable(ctx())).toBe(false)
  })
})

describe('shake method', () => {
  test('delegates to the injected reducer', async () => {
    const shake = createShakeMethod({
      reducer: {
        reduce: () => ({ messages: [message], tokensSaved: 50_000 }),
      },
      resolveThresholdTokens: () => 170_000,
    })

    const outcome = await shake.run(ctx({ tokenCount: () => 100_000 }))
    expect(outcome.kind).toBe('reduced')
    if (outcome.kind !== 'reduced') return
    expect(outcome.method).toBe('shake')
    expect(outcome.tokensSaved).toBe(50_000)
    expect(outcome.headroomTokens).toBe(70_000)
  })

  test('degrades to skipped without a reducer', async () => {
    const shake = createShakeMethod(null)
    expect(shake.isAvailable(ctx())).toBe(false)
    const outcome = await shake.run(ctx())
    expect(outcome).toEqual({
      kind: 'skipped',
      method: 'shake',
      reason: 'no-shake-reducer',
    })
  })

  test('skips when the reducer makes no reduction', async () => {
    const shake = createShakeMethod({ reducer: { reduce: () => null } })
    expect(await shake.run(ctx())).toEqual({
      kind: 'skipped',
      method: 'shake',
      reason: 'shake-noop',
    })
  })
})
