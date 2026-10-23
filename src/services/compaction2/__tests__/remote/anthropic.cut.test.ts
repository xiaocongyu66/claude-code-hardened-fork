import { describe, expect, test } from 'bun:test'
import type { Message } from '../../../../types/message.js'
import {
  DEFAULT_COMPACTION_SETTINGS,
  type CompactionContext,
} from '../../contracts.js'
import {
  computeRemoteCut,
  createRemoteMethod,
  type RemoteFetch,
} from '../../methods/remote/index.js'
import { runAnthropicCompactionLane } from '../../methods/remote/anthropic.js'
import { estimateMessageTokens } from '../../reducers/prune.js'
import { estimateTokens } from '../../tokens/index.js'

const MODEL = 'claude-opus-4-6'

function userText(uuid: string, text: string): Message {
  return {
    type: 'user',
    uuid,
    message: { role: 'user', content: text },
  } as unknown as Message
}

function assistantText(uuid: string, text: string): Message {
  return {
    type: 'assistant',
    uuid,
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  } as unknown as Message
}

function assistantToolUse(uuid: string, id: string): Message {
  return {
    type: 'assistant',
    uuid,
    message: {
      role: 'assistant',
      content: [
        { type: 'tool_use', id, name: 'Read', input: { file_path: '/tmp/x' } },
      ],
    },
  } as unknown as Message
}

function userToolResult(uuid: string, id: string, text: string): Message {
  return {
    type: 'user',
    uuid,
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: id, content: text }],
    },
  } as unknown as Message
}

/** Token count for a message using the same estimator as the cut. */
function tokensOf(message: Message): number {
  return estimateMessageTokens(
    message,
    text => estimateTokens(text, MODEL).tokens,
  )
}

function ctx(
  messages: readonly Message[],
  keepRecentTokens: number,
): CompactionContext {
  return {
    model: MODEL,
    trigger: 'threshold',
    messages,
    settings: { ...DEFAULT_COMPACTION_SETTINGS, keepRecentTokens },
    tokenCount: input => input.length * 100,
    estimateEntryTokens: () => 0,
    now: () => 0,
  }
}

const signedResponse = JSON.stringify({
  stop_reason: 'compaction',
  content: [{ type: 'compaction', content: 'summary', signature: 'sig' }],
})

function anthropicMethod(fetch: RemoteFetch) {
  return createRemoteMethod({
    env: { CCH_REMOTE_COMPACTION: '1' },
    provider: 'firstParty',
    apiKey: 'k',
    fetch,
  })
}

function bodyOf(init: { body?: string }): {
  messages: Array<{ role: string; content: Array<{ text?: string }> }>
} {
  return JSON.parse(String(init.body)) as {
    messages: Array<{ role: string; content: Array<{ text?: string }> }>
  }
}

describe('computeRemoteCut', () => {
  test('keeps the newest messages inside keepRecentTokens', () => {
    const messages = [
      userText('u1', 'first'),
      assistantText('a1', 'first answer'),
      userText('u2', 'second'),
      assistantText('a2', 'second answer'),
      userText('u3', 'third'),
    ]
    const keepRecent =
      tokensOf(messages[4]!) + tokensOf(messages[3]!) + tokensOf(messages[2]!)
    const cut = computeRemoteCut(ctx(messages, keepRecent))
    expect(cut.index).toBe(2)
    expect(cut.messages.map(m => m.uuid)).toEqual(['u1', 'a1'])
    expect(cut.kept.map(m => m.uuid)).toEqual(['u2', 'a2', 'u3'])
    expect(cut.cutPoint.firstKeptEntryId).toBe('u2')
  })

  test('never splits an assistant tool call from its tool result', () => {
    const toolText = 'tool output '.repeat(200)
    const messages = [
      userText('u1', 'start'),
      assistantToolUse('a1', 't1'),
      userToolResult('u2', 't1', toolText),
      assistantText('a3', 'after'),
      userText('u4', 'latest'),
    ]
    // The token budget lands exactly on the tool_result message.
    const keepRecent =
      tokensOf(messages[4]!) + tokensOf(messages[3]!) + tokensOf(messages[2]!)
    const cut = computeRemoteCut(ctx(messages, keepRecent))
    expect(cut.index).toBe(1)
    expect(cut.kept.map(m => m.uuid)).toEqual(['a1', 'u2', 'a3', 'u4'])
    expect(cut.messages.map(m => m.uuid)).toEqual(['u1'])
  })

  test('counts CJK with the tokenizer, not JSON length / 4', () => {
    const cjk = userText('u1', '汉'.repeat(400))
    expect(tokensOf(cjk)).toBeGreaterThan(JSON.stringify(cjk).length / 4)

    const messages = [
      userText('c1', '汉'.repeat(400)),
      userText('c2', '汉'.repeat(400)),
      userText('c3', '汉'.repeat(400)),
      userText('c4', '汉'.repeat(400)),
    ]
    // A JSON-length/4 estimate (~115/message) would keep two messages here;
    // the tokenizer-aware estimate keeps only the newest one.
    const cut = computeRemoteCut(ctx(messages, 250))
    expect(cut.index).toBe(3)
    expect(cut.kept.map(m => m.uuid)).toEqual(['c4'])
  })
})

describe('Anthropic remote lane cut', () => {
  test('sends only the summarized prefix and reuses the cut point', async () => {
    const messages = [
      userText('u1', 'first user message'),
      assistantText('a1', 'first answer'),
      userText('u2', 'second user message'),
      assistantText('a2', 'second answer'),
      userText('u3', 'third user message'),
    ]
    const keepRecent =
      tokensOf(messages[4]!) + tokensOf(messages[3]!) + tokensOf(messages[2]!)
    const bodies: ReturnType<typeof bodyOf>[] = []
    const method = anthropicMethod(async (_url, init) => {
      bodies.push(bodyOf(init))
      return new Response(signedResponse, { status: 200 })
    })
    const outcome = await method.run(ctx(messages, keepRecent))
    expect(outcome.kind).toBe('compacted')
    if (outcome.kind !== 'compacted') return
    expect(bodies).toHaveLength(1)
    expect(bodies[0]!.messages).toHaveLength(2)
    const sent = bodies[0]!.messages.map(m => m.content[0]?.text)
    expect(sent).toEqual(['first user message', 'first answer'])
    // The retained tail never reaches the provider.
    expect(JSON.stringify(bodies[0])).not.toContain('third user message')
    expect(JSON.stringify(bodies[0])).not.toContain('second answer')
    // The outcome reuses the precomputed boundary instead of recomputing it.
    expect(outcome.cutPoint.firstKeptEntryId).toBe('u2')
  })

  test('keeps tool pairs out of the request', async () => {
    const toolText = 'tool output '.repeat(200)
    const messages = [
      userText('u1', 'start'),
      assistantToolUse('a1', 't1'),
      userToolResult('u2', 't1', toolText),
      assistantText('a3', 'after'),
      userText('u4', 'latest'),
    ]
    const keepRecent =
      tokensOf(messages[4]!) + tokensOf(messages[3]!) + tokensOf(messages[2]!)
    const bodies: ReturnType<typeof bodyOf>[] = []
    const method = anthropicMethod(async (_url, init) => {
      bodies.push(bodyOf(init))
      return new Response(signedResponse, { status: 200 })
    })
    const outcome = await method.run(ctx(messages, keepRecent))
    expect(outcome.kind).toBe('compacted')
    if (outcome.kind !== 'compacted') return
    expect(bodies[0]!.messages).toHaveLength(1)
    expect(JSON.stringify(bodies[0])).not.toContain('tool output')
    expect(outcome.cutPoint.firstKeptEntryId).toBe('a1')
  })

  test('a direct lane call without a precomputed cut still sends only the prefix', async () => {
    const messages = [
      userText('u1', 'old context'),
      assistantText('a1', 'old answer'),
      userText('u2', 'recent question'),
    ]
    const keepRecent = tokensOf(messages[2]!)
    const bodies: ReturnType<typeof bodyOf>[] = []
    const result = await runAnthropicCompactionLane({
      ctx: ctx(messages, keepRecent),
      instructions: 'summarize',
      env: {},
      provider: 'firstParty',
      transport: {
        fetch: async (_url, init) => {
          bodies.push(bodyOf(init))
          return new Response(signedResponse, { status: 200 })
        },
        apiKey: 'k',
        model: MODEL,
      },
    })
    expect('skipped' in result).toBe(false)
    expect(bodies[0]!.messages).toHaveLength(2)
    expect(JSON.stringify(bodies[0])).not.toContain('recent question')
  })

  test('skips when the cut summarizes nothing', async () => {
    const messages = [userText('u1', 'only message')]
    const method = anthropicMethod(async () => {
      throw new Error('request should not be sent')
    })
    const outcome = await method.run(ctx(messages, 1_000))
    expect(outcome).toEqual({
      kind: 'skipped',
      method: 'remote',
      reason: 'anthropic-empty-prefix',
    })
  })
})
