import { describe, expect, test } from 'bun:test'
import type { Message } from '../../../../types/message.js'
import {
  type CompactionMethod,
  type CompactionMethodName,
  type TriggerReason,
} from '../../contracts.js'
import { runCompactionV2 } from '../../orchestrator.js'
import {
  createContextPromotion,
  type PromotionCandidate,
} from '../../triggers/promotion.js'

const message = {
  type: 'user',
  message: { role: 'user', content: 'hello' },
  uuid: 'u1',
} as unknown as Message

const MODEL = 'test-model'
const WINDOW = 200_000
// reserve = max(15% of 200k, 16384) = 30k → threshold = 170k
const OVER_THRESHOLD = 180_000

const largerCandidates: PromotionCandidate[] = [
  { model: 'large', windowTokens: 1_000_000 },
]

/** A promotion source that treats MODEL as having WINDOW tokens. */
function promotion(candidates: PromotionCandidate[]) {
  return createContextPromotion({
    candidates,
    resolveWindow: () => WINDOW,
  })
}

/** A method that always compacts and records that it ran. */
function compactingMethod(
  name: CompactionMethodName,
  calls: string[],
): CompactionMethod {
  return {
    name,
    isAvailable: () => true,
    run: async () => {
      calls.push(name)
      return {
        kind: 'compacted',
        method: name,
        cutPoint: {
          firstKeptEntryId: '',
          tokensBefore: OVER_THRESHOLD,
          boundaryMessage: {} as never,
        },
        tokensSaved: 90_000,
        headroomTokens: 40_000,
      }
    },
  }
}

async function run(
  trigger: TriggerReason,
  input: {
    tokenCount?: number
    stopReason?: string | null
    overflowDetected?: boolean
    promotion?: ReturnType<typeof createContextPromotion> | null
    allowPromotion?: boolean
  } = {},
) {
  const calls: string[] = []
  const result = await runCompactionV2(
    {
      model: MODEL,
      trigger,
      messages: [message],
      windowTokens: WINDOW,
      tokenCount: input.tokenCount ?? OVER_THRESHOLD,
      stopReason:
        input.stopReason ?? (trigger === 'incomplete' ? 'max_tokens' : null),
      overflowDetected: input.overflowDetected,
    },
    {
      methods: [compactingMethod('handoff', calls)],
      promotion: input.promotion ?? null,
      allowPromotion: input.allowPromotion,
    },
  )
  return { result, calls }
}

describe('threshold promotion before compaction', () => {
  test('returns a promotion decision and skips the method chain', async () => {
    const { result, calls } = await run('threshold', {
      promotion: promotion(largerCandidates),
    })
    expect(result.shouldCompact).toBe(false)
    expect(result.outcome).toBeUndefined()
    expect(result.promotion).toEqual({
      kind: 'promoted',
      model: 'large',
      reason: 'larger-window:1000000',
    })
    expect(result.trigger.reason).toBe('context-promoted: large')
    expect(calls).toEqual([])
  })

  test('compacts when no candidate has a strictly larger window', async () => {
    const { result, calls } = await run('threshold', {
      promotion: promotion([{ model: 'same', windowTokens: WINDOW }]),
    })
    expect(result.shouldCompact).toBe(true)
    expect(result.outcome?.kind).toBe('compacted')
    expect(result.promotion?.kind).toBe('skipped')
    expect(calls).toEqual(['handoff'])
  })

  test('compacts when the only candidate is the current model', async () => {
    const { result, calls } = await run('threshold', {
      promotion: promotion([{ model: MODEL, windowTokens: 1_000_000 }]),
    })
    expect(result.shouldCompact).toBe(true)
    expect(result.outcome?.kind).toBe('compacted')
    expect(calls).toEqual(['handoff'])
  })

  test('does not promote when the trigger does not ask for compaction', async () => {
    const { result, calls } = await run('threshold', {
      tokenCount: 100_000,
      promotion: promotion(largerCandidates),
    })
    expect(result.shouldCompact).toBe(false)
    expect(result.promotion).toBeUndefined()
    expect(calls).toEqual([])
  })

  test('allowPromotion:false compacts even with a candidate', async () => {
    const { result, calls } = await run('threshold', {
      promotion: promotion(largerCandidates),
      allowPromotion: false,
    })
    expect(result.shouldCompact).toBe(true)
    expect(result.outcome?.kind).toBe('compacted')
    expect(result.promotion?.kind).toBe('skipped')
    expect(calls).toEqual(['handoff'])
  })
})

describe('incomplete promotion before compaction', () => {
  const stopReason = 'max_tokens'

  test('returns a promotion decision and skips the method chain', async () => {
    const { result, calls } = await run('incomplete', {
      stopReason,
      promotion: promotion(largerCandidates),
    })
    expect(result.shouldCompact).toBe(false)
    expect(result.outcome).toBeUndefined()
    expect(result.promotion?.kind).toBe('promoted')
    expect(calls).toEqual([])
  })

  test('compacts when no larger window is available', async () => {
    const { result, calls } = await run('incomplete', {
      stopReason,
      promotion: promotion([{ model: 'same', windowTokens: WINDOW }]),
    })
    expect(result.shouldCompact).toBe(true)
    expect(result.outcome?.kind).toBe('compacted')
    expect(calls).toEqual(['handoff'])
  })

  test('allowPromotion:false compacts even with a candidate', async () => {
    const { result, calls } = await run('incomplete', {
      stopReason,
      promotion: promotion(largerCandidates),
      allowPromotion: false,
    })
    expect(result.shouldCompact).toBe(true)
    expect(result.outcome?.kind).toBe('compacted')
    expect(result.promotion?.kind).toBe('skipped')
    expect(calls).toEqual(['handoff'])
  })

  test('a non-length stop never promotes', async () => {
    const { result, calls } = await run('incomplete', {
      stopReason: 'end_turn',
      promotion: promotion(largerCandidates),
    })
    expect(result.shouldCompact).toBe(false)
    expect(result.promotion).toBeUndefined()
    expect(calls).toEqual([])
  })
})

describe('trigger ordering consistency', () => {
  test('overflow keeps promoting before compacting', async () => {
    const { result, calls } = await run('overflow', {
      overflowDetected: true,
      promotion: promotion(largerCandidates),
    })
    expect(result.shouldCompact).toBe(false)
    expect(result.promotion?.kind).toBe('promoted')
    expect(calls).toEqual([])
  })
})
