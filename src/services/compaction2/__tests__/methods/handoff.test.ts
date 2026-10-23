import { describe, expect, test } from 'bun:test'
import type { Message } from '../../../../types/message.js'
import {
  DEFAULT_COMPACTION_SETTINGS,
  type CompactionContext,
  type CompactionMethod,
} from '../../contracts.js'
import {
  buildHandoffInstructions,
  createHandoffMethod,
  DEFAULT_HANDOFF_INSTRUCTIONS,
  HANDOFF_DOCUMENT_VERSION,
} from '../../methods/handoff.js'
import { runCompactionV2 } from '../../orchestrator.js'

function userText(uuid: string, text: string): Message {
  return {
    type: 'user',
    uuid,
    message: { role: 'user', content: text },
  } as unknown as Message
}

function ctx(overrides: Partial<CompactionContext> = {}): CompactionContext {
  const messages = overrides.messages ?? [
    userText('u1', 'goal: ship the lane'),
    userText('u2', 'todo: add tests'),
    userText('u3', 'constraint: no new deps'),
  ]
  return {
    model: 'test-model',
    trigger: 'threshold',
    messages,
    settings: {
      ...DEFAULT_COMPACTION_SETTINGS,
      keepRecentTokens: 0,
      thresholdTokens: 1_000,
    },
    tokenCount: input => input.length * 100,
    estimateEntryTokens: () => 0,
    now: () => 0,
    ...overrides,
  }
}

describe('handoff instructions', () => {
  test('defaults to a structured document prompt', () => {
    expect(buildHandoffInstructions()).toBe(DEFAULT_HANDOFF_INSTRUCTIONS)
    expect(DEFAULT_HANDOFF_INSTRUCTIONS).toContain('## Recent goals')
    expect(DEFAULT_HANDOFF_INSTRUCTIONS).toContain('## Key files')
    expect(DEFAULT_HANDOFF_INSTRUCTIONS).toContain('## Todo')
    expect(DEFAULT_HANDOFF_INSTRUCTIONS).toContain('## Constraints')
  })

  test('appends /compact focus text', () => {
    const instructions = buildHandoffInstructions('focus on tests')
    expect(instructions).toStartWith(DEFAULT_HANDOFF_INSTRUCTIONS)
    expect(instructions).toContain('focus on tests')
  })
})

describe('handoff availability', () => {
  test('requires injected deps', () => {
    expect(createHandoffMethod(null).isAvailable(ctx())).toBe(false)
    expect(createHandoffMethod({}).isAvailable(ctx())).toBe(false)
  })

  test('is available when a summarizer is injected', () => {
    const method = createHandoffMethod({
      summarize: async () => 'doc',
    })
    expect(method.isAvailable(ctx())).toBe(true)
    expect(method.isAvailable(ctx({ trigger: 'manual' }))).toBe(true)
  })

  test('never runs on overflow', () => {
    const method = createHandoffMethod({
      summarize: async () => 'doc',
    })
    expect(method.isAvailable(ctx({ trigger: 'overflow' }))).toBe(false)
  })

  test('honors an extra availability check', () => {
    const method = createHandoffMethod({
      summarize: async () => 'doc',
      isAvailable: () => false,
    })
    expect(method.isAvailable(ctx())).toBe(false)
  })

  test('accepts a full run override', () => {
    const method = createHandoffMethod({
      run: async () => ({
        kind: 'skipped',
        method: 'handoff',
        reason: 'stubbed',
      }),
    })
    expect(method.isAvailable(ctx())).toBe(true)
  })
})

describe('handoff method run', () => {
  test('returns skipped without deps', async () => {
    expect(await createHandoffMethod(null).run(ctx())).toEqual({
      kind: 'skipped',
      method: 'handoff',
      reason: 'handoff-not-available',
    })
  })

  test('builds a versioned handoff document and reuses the cut point', async () => {
    const seen: Array<{ instructions: string; messages: number }> = []
    const method = createHandoffMethod({
      summarize: async (context, request) => {
        seen.push({
          instructions: request.instructions,
          messages: context.messages.length,
        })
        return [
          '## Recent goals',
          '- ship the lane',
          '## Key files',
          '- src/services/compaction2/methods/remote/bedrock.ts',
          '## Todo',
          '- add tests',
          '## Constraints',
          '- no new dependencies',
        ].join('\n')
      },
    })
    const outcome = await method.run(ctx())
    expect(outcome.kind).toBe('compacted')
    if (outcome.kind !== 'compacted') return
    expect(seen).toEqual([
      {
        instructions: DEFAULT_HANDOFF_INSTRUCTIONS,
        messages: 3,
      },
    ])
    expect(outcome.method).toBe('handoff')
    expect(outcome.summary).toContain('## Key files')
    const preserved = outcome.preserveData?.handoff as {
      version: number
      document: string
    }
    expect(preserved.version).toBe(HANDOFF_DOCUMENT_VERSION)
    expect(preserved.document).toBe(outcome.summary)
    expect(outcome.cutPoint.tokensBefore).toBe(300)
    expect(outcome.tokensSaved).toBe(300)
    expect(outcome.headroomTokens).toBe(1_000)
  })

  test('formats the summarized prefix as the cut point', async () => {
    // keepRecentTokens=0 summarizes everything; the retained tail is empty.
    const outcome = await createHandoffMethod({
      summarize: async () => 'doc',
    }).run(ctx())
    expect(outcome.kind).toBe('compacted')
    if (outcome.kind !== 'compacted') return
    expect(outcome.cutPoint.firstKeptEntryId).toBe('')
  })

  test('passes /compact focus text through', async () => {
    let instructions = ''
    await createHandoffMethod({
      instructions: 'focus on tests',
      summarize: async (_context, request) => {
        instructions = request.instructions
        return 'doc'
      },
    }).run(ctx())
    expect(instructions).toContain('focus on tests')
  })

  test('skips when nothing would be replaced', async () => {
    const method = createHandoffMethod({
      summarize: async () => {
        throw new Error('should not summarize')
      },
    })
    const outcome = await method.run(
      ctx({
        messages: [userText('u1', 'tiny')],
        settings: {
          ...DEFAULT_COMPACTION_SETTINGS,
          keepRecentTokens: 1_000_000,
        },
      }),
    )
    expect(outcome).toEqual({
      kind: 'skipped',
      method: 'handoff',
      reason: 'handoff-empty-prefix',
    })
  })

  test('turns summarizer errors into a failed outcome', async () => {
    const method = createHandoffMethod({
      summarize: async () => {
        throw new Error('provider down')
      },
    })
    expect(await method.run(ctx())).toEqual({
      kind: 'failed',
      method: 'handoff',
      reason: 'provider down',
      error: expect.any(Error),
    })
  })

  test('fails when the document is empty', async () => {
    const method = createHandoffMethod({ summarize: async () => '   ' })
    expect(await method.run(ctx())).toEqual({
      kind: 'failed',
      method: 'handoff',
      reason: 'handoff-empty-document',
    })
  })
})

describe('handoff chain degradation', () => {
  test('falls through to soft when handoff has no deps', async () => {
    const calls: string[] = []
    const soft: CompactionMethod = {
      name: 'soft',
      isAvailable: () => true,
      run: async () => {
        calls.push('soft')
        return {
          kind: 'compacted',
          method: 'soft',
          cutPoint: {
            firstKeptEntryId: 'u1',
            tokensBefore: 180_000,
            boundaryMessage: {} as never,
          },
          tokensSaved: 100_000,
          headroomTokens: 0,
          summary: 'soft summary',
        }
      },
    }
    const handoff = createHandoffMethod(null)
    expect(handoff.isAvailable(ctx())).toBe(false)
    const result = await runCompactionV2(
      {
        model: 'test-model',
        trigger: 'threshold',
        messages: [userText('u1', 'hello')],
        windowTokens: 200_000,
        tokenCount: 180_000,
        settings: { methodOrder: ['handoff', 'soft'] },
      },
      { methods: [handoff, soft] },
    )
    expect(calls).toEqual(['soft'])
    expect(result.outcome?.method).toBe('soft')
    expect(result.trace[0]).toMatchObject({
      method: 'handoff',
      outcome: 'skipped',
      reason: 'unavailable',
    })
  })
})
