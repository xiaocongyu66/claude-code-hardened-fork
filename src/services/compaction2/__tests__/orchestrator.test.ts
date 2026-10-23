import { describe, expect, test } from 'bun:test'
import type { Message } from '../../../types/message.js'
import {
  DEFAULT_COMPACTION_SETTINGS,
  type CompactionMethod,
  type CompactionMethodName,
  type CompactionOutcome,
} from '../contracts.js'
import { runCompactionV2, type DecisionTraceEntry } from '../orchestrator.js'

const message = {
  type: 'user',
  message: { role: 'user', content: 'hello' },
  uuid: 'u1',
} as unknown as Message

const WINDOW = 200_000
// reserve = max(15% of 200k, 16384) = 30k → threshold = 170k
const OVER_THRESHOLD = 180_000

function method(
  name: CompactionMethodName,
  available: boolean,
  outcome: CompactionOutcome | (() => Promise<CompactionOutcome>),
  calls: string[],
): CompactionMethod {
  return {
    name,
    isAvailable: () => available,
    run: async () => {
      calls.push(name)
      return typeof outcome === 'function' ? outcome() : outcome
    },
  }
}

describe('runCompactionV2 method chain', () => {
  test('walks the default order and falls back on unavailable/failed methods', async () => {
    const calls: string[] = []
    const methods: CompactionMethod[] = [
      method(
        'remote',
        false,
        { kind: 'skipped', method: 'remote', reason: 'no' },
        calls,
      ),
      method(
        'snapcompact',
        true,
        { kind: 'failed', method: 'snapcompact', reason: 'boom' },
        calls,
      ),
      method(
        'handoff',
        true,
        {
          kind: 'compacted',
          method: 'handoff',
          cutPoint: {
            firstKeptEntryId: 'u1',
            tokensBefore: OVER_THRESHOLD,
            boundaryMessage: {} as never,
          },
          tokensSaved: 100_000,
          headroomTokens: 0,
        },
        calls,
      ),
      method(
        'shake',
        false,
        { kind: 'skipped', method: 'shake', reason: 'no reducer' },
        calls,
      ),
      method(
        'soft',
        true,
        {
          kind: 'compacted',
          method: 'soft',
          cutPoint: {
            firstKeptEntryId: '',
            tokensBefore: OVER_THRESHOLD,
            boundaryMessage: {} as never,
          },
          tokensSaved: 100_000,
          headroomTokens: 0,
        },
        calls,
      ),
    ]

    const result = await runCompactionV2(
      {
        model: 'test-model',
        trigger: 'threshold',
        messages: [message],
        windowTokens: WINDOW,
        tokenCount: OVER_THRESHOLD,
      },
      { methods },
    )

    expect(result.shouldCompact).toBe(true)
    expect(result.outcome?.kind).toBe('compacted')
    expect(result.outcome?.method).toBe('handoff')
    // Unavailable methods never run.
    expect(calls).toEqual(['snapcompact', 'handoff'])
    expect(result.trace.map(entry => entry.outcome)).toEqual([
      'skipped',
      'failed',
      'compacted',
    ])
    const handoff = result.trace[2]!
    expect(handoff.tokensSaved).toBe(100_000)
    expect(handoff.headroomTokens).toBe(170_000 - 80_000)
  })

  test('advances past a method that fails the 80% progress guard', async () => {
    const calls: string[] = []
    const methods: CompactionMethod[] = [
      method(
        'handoff',
        true,
        {
          kind: 'compacted',
          method: 'handoff',
          cutPoint: {
            firstKeptEntryId: 'u1',
            tokensBefore: OVER_THRESHOLD,
            boundaryMessage: {} as never,
          },
          // 180k - 10k = 170k > 136k (80% of 170k)
          tokensSaved: 10_000,
          headroomTokens: 0,
        },
        calls,
      ),
      method(
        'soft',
        true,
        {
          kind: 'compacted',
          method: 'soft',
          cutPoint: {
            firstKeptEntryId: '',
            tokensBefore: OVER_THRESHOLD,
            boundaryMessage: {} as never,
          },
          tokensSaved: 100_000,
          headroomTokens: 0,
        },
        calls,
      ),
    ]

    const result = await runCompactionV2(
      {
        model: 'test-model',
        trigger: 'threshold',
        messages: [message],
        windowTokens: WINDOW,
        tokenCount: OVER_THRESHOLD,
        settings: { methodOrder: ['handoff', 'soft'] },
      },
      { methods },
    )

    expect(result.outcome?.method).toBe('soft')
    expect(calls).toEqual(['handoff', 'soft'])
    const blocked = result.trace.find(e => e.outcome === 'guard-blocked')
    expect(blocked?.method).toBe('handoff')
    expect(blocked?.reason).toContain('80%')
  })

  test('reports a final skip when every method is unavailable', async () => {
    const calls: string[] = []
    const methods = DEFAULT_COMPACTION_SETTINGS.methodOrder.map(name =>
      method(
        name,
        false,
        { kind: 'skipped', method: name, reason: 'no' },
        calls,
      ),
    )

    const result = await runCompactionV2(
      {
        model: 'test-model',
        trigger: 'threshold',
        messages: [message],
        windowTokens: WINDOW,
        tokenCount: OVER_THRESHOLD,
      },
      { methods },
    )

    expect(result.shouldCompact).toBe(true)
    expect(result.outcome).toBeUndefined()
    expect(calls).toEqual([])
    expect(result.trace).toHaveLength(6)
    expect(result.trace.at(-1)?.reason).toBe(
      'all-methods-unavailable-or-failed',
    )
  })

  test('does not walk the chain when the trigger does not fire', async () => {
    const calls: string[] = []
    const methods: CompactionMethod[] = [
      method(
        'soft',
        true,
        { kind: 'skipped', method: 'soft', reason: 'unused' },
        calls,
      ),
    ]

    const result = await runCompactionV2(
      {
        model: 'test-model',
        trigger: 'threshold',
        messages: [message],
        windowTokens: WINDOW,
        tokenCount: 100_000,
      },
      { methods },
    )

    expect(result.shouldCompact).toBe(false)
    expect(calls).toEqual([])
    expect(result.trace).toHaveLength(1)
    expect(result.trace[0]?.outcome).toBe('skipped')
  })

  test('emits every decision through onTrace', async () => {
    const seen: DecisionTraceEntry[] = []
    const methods: CompactionMethod[] = [
      method(
        'soft',
        true,
        {
          kind: 'compacted',
          method: 'soft',
          cutPoint: {
            firstKeptEntryId: '',
            tokensBefore: OVER_THRESHOLD,
            boundaryMessage: {} as never,
          },
          tokensSaved: 100_000,
          headroomTokens: 0,
        },
        [],
      ),
    ]

    await runCompactionV2(
      {
        model: 'test-model',
        trigger: 'manual',
        messages: [message],
        windowTokens: WINDOW,
        tokenCount: OVER_THRESHOLD,
        settings: { methodOrder: ['soft'] },
      },
      { methods, onTrace: entry => seen.push(entry) },
    )

    expect(seen).toHaveLength(1)
    expect(seen[0]?.method).toBe('soft')
    expect(seen[0]?.trigger).toBe('manual')
  })

  test('circuit-open skips API methods but keeps local reducers', async () => {
    const calls: string[] = []
    const methods: CompactionMethod[] = [
      method(
        'soft',
        true,
        {
          kind: 'compacted',
          method: 'soft',
          cutPoint: {
            firstKeptEntryId: 'u1',
            tokensBefore: OVER_THRESHOLD,
            boundaryMessage: {} as never,
          },
          tokensSaved: 100_000,
          headroomTokens: 0,
        },
        calls,
      ),
      method(
        'shake',
        true,
        {
          kind: 'reduced',
          method: 'shake',
          messages: [message],
          tokensSaved: 50_000,
          headroomTokens: 0,
        },
        calls,
      ),
    ]

    const result = await runCompactionV2(
      {
        model: 'test-model',
        trigger: 'threshold',
        messages: [message],
        windowTokens: WINDOW,
        tokenCount: OVER_THRESHOLD,
        settings: { methodOrder: ['soft', 'shake'] },
      },
      { methods, canRunMethod: name => name === 'shake' },
    )

    expect(calls).toEqual(['shake'])
    expect(result.outcome?.kind).toBe('reduced')
    expect(result.trace.some(entry => entry.reason === 'circuit-open')).toBe(
      true,
    )
  })
})
