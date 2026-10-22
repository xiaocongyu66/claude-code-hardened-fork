import { describe, expect, test } from 'bun:test'
import type { Message } from '../../../../types/message.js'
import {
  buildOpenAiCompactionInput,
  buildOpenAiV2ReplacementHistory,
  classifyOpenAiEndpoint,
  collectOpenAiCompactionV2Body,
  collectOpenAiCompactionV2Events,
  getPreservedOpenAiRemoteCompactionData,
  isOpenAiCompactionLaneAvailable,
  OPENAI_REMOTE_COMPACTION_PRESERVE_KEY,
  parseOpenAiCompactionSse,
  resolveOpenAiCompactEndpoint,
  resolveOpenAiResponsesEndpoint,
  runOpenAiCompactionLane,
  V2_RETAINED_MESSAGE_TOKEN_BUDGET,
} from '../../methods/remote/openai.js'
import { DEFAULT_COMPACTION_SETTINGS } from '../../contracts.js'
import type { CompactionContext } from '../../contracts.js'

function user(uuid: string, text: string): Message {
  return {
    type: 'user',
    uuid,
    message: { role: 'user', content: text },
  } as unknown as Message
}

function assistant(uuid: string, blocks: unknown[]): Message {
  return {
    type: 'assistant',
    uuid,
    message: { role: 'assistant', content: blocks },
  } as unknown as Message
}

function ctx(messages: Message[]): CompactionContext {
  return {
    model: 'gpt-5',
    trigger: 'threshold',
    messages,
    settings: { ...DEFAULT_COMPACTION_SETTINGS, keepRecentTokens: 0 },
    tokenCount: input => input.length * 100,
    estimateEntryTokens: () => 0,
    now: () => 0,
  }
}

type FetchLike = (
  url: string,
  init: {
    method?: string
    headers?: Record<string, string>
    body?: string
    signal?: AbortSignal
  },
) => Promise<Response>

const laneRequest = (
  messages: Message[],
  fetchImpl: FetchLike,
  version: 'v1' | 'v2' | 'auto' = 'auto',
) => ({
  ctx: ctx(messages),
  instructions: 'summarize',
  env: {},
  transport: {
    fetch: fetchImpl,
    apiKey: 'k',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-5',
  },
  options: { openAiVersion: version },
})

const v1Response = JSON.stringify({
  output: [
    {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'retained' }],
    },
    { type: 'compaction', encrypted_content: 'enc' },
  ],
})

const v2Sse = [
  'event: response.output_item.done',
  'data: {"type":"response.output_item.done","item":{"type":"compaction","encrypted_content":"enc"}}',
  '',
  'event: response.completed',
  'data: {"type":"response.completed","response":{"usage":{"input_tokens":12,"output_tokens":4,"total_tokens":16}}}',
  '',
  '',
].join('\n')

describe('endpoint classification', () => {
  test('known vs unknown gateways', () => {
    expect(classifyOpenAiEndpoint(undefined)).toBe('official')
    expect(classifyOpenAiEndpoint('https://api.openai.com/v1')).toBe('official')
    expect(
      classifyOpenAiEndpoint('https://chatgpt.com/backend-api/codex'),
    ).toBe('codex')
    expect(
      classifyOpenAiEndpoint(
        'https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1',
      ),
    ).toBe('bedrock-openai')
    expect(classifyOpenAiEndpoint('http://localhost:11434/v1')).toBe('unknown')
  })

  test('availability requires a known endpoint and a key', () => {
    expect(
      isOpenAiCompactionLaneAvailable({
        model: 'gpt-5',
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'k',
      }),
    ).toBe(true)
    expect(
      isOpenAiCompactionLaneAvailable({
        model: 'gpt-5',
        baseUrl: 'https://api.openai.com/v1',
      }),
    ).toBe(false)
    expect(
      isOpenAiCompactionLaneAvailable({
        model: 'gpt-5',
        baseUrl: 'http://localhost:11434/v1',
        apiKey: 'k',
      }),
    ).toBe(false)
  })

  test('endpoint builders', () => {
    expect(resolveOpenAiCompactEndpoint(undefined)).toBe(
      'https://api.openai.com/v1/responses/compact',
    )
    expect(resolveOpenAiResponsesEndpoint('https://api.openai.com/v1')).toBe(
      'https://api.openai.com/v1/responses',
    )
  })
})

describe('input mapping', () => {
  test('maps text, tool calls and tool results', () => {
    const built = buildOpenAiCompactionInput([
      user('u1', 'read the file'),
      assistant('a1', [
        { type: 'tool_use', id: 't1', name: 'Read', input: { path: 'a' } },
      ]),
      {
        type: 'user',
        uuid: 'u2',
        message: {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 't1', content: 'contents' },
          ],
        },
      } as unknown as Message,
    ])
    expect(built.unsupported).toBeUndefined()
    expect(built.input).toContainEqual({
      type: 'function_call',
      call_id: 't1',
      name: 'Read',
      arguments: '{"path":"a"}',
    })
    expect(built.input).toContainEqual({
      type: 'function_call_output',
      call_id: 't1',
      output: 'contents',
    })
  })

  test('unmappable content skips with a reason', () => {
    const built = buildOpenAiCompactionInput([
      assistant('a1', [{ type: 'thinking', thinking: 'hmm' }]),
    ])
    expect(built.unsupported).toBe('openai-unsupported-thinking-block')
  })
})

describe('V1 lane', () => {
  test('posts /responses/compact and keeps replacement history', async () => {
    const calls: Array<{ url: string; body: unknown }> = []
    const result = await runOpenAiCompactionLane(
      laneRequest(
        [user('u1', 'hello')],
        async (url, init) => {
          calls.push({
            url,
            body: init.body ? JSON.parse(init.body as string) : undefined,
          })
          return new Response(v1Response, { status: 200 })
        },
        'v1',
      ),
    )
    expect('summary' in result).toBe(true)
    expect(calls[0]?.url).toBe('https://api.openai.com/v1/responses/compact')
    expect((calls[0]?.body as { input: unknown[] }).input).toHaveLength(1)
    if (!('preserveData' in result)) return
    const preserved = getPreservedOpenAiRemoteCompactionData(
      result.preserveData,
    )
    expect(preserved?.compactionItem.type).toBe('compaction')
    expect(preserved?.replacementHistory).toHaveLength(2)
  })
})

describe('V2 streaming lane', () => {
  test('parses SSE and requires exactly one compaction item', () => {
    const events = parseOpenAiCompactionSse(v2Sse)
    const collection = collectOpenAiCompactionV2Events(events)
    expect(collection.completed).toBe(true)
    expect(collection.usedTokens).toBe(12)
    expect(collection.compactionItem?.type).toBe('compaction')
  })

  test('rejects a stream with no compaction item', () => {
    expect(() =>
      collectOpenAiCompactionV2Events([
        { type: 'response.completed', response: {} },
      ]),
    ).toThrow()
  })

  test('accepts a non-streamed Responses body', () => {
    const collection = collectOpenAiCompactionV2Body(
      JSON.stringify({
        output: [{ type: 'compaction', encrypted_content: 'enc' }],
        usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
      }),
    )
    expect(collection.compactionItem?.type).toBe('compaction')
  })

  test('posts the trailing compaction_trigger and stores v2 history', async () => {
    let seen: Record<string, unknown> | undefined
    const result = await runOpenAiCompactionLane(
      laneRequest(
        [user('u1', 'hello')],
        async (_url, init) => {
          seen = JSON.parse(init.body as string) as Record<string, unknown>
          return new Response(v2Sse, { status: 200 })
        },
        'v2',
      ),
    )
    expect(seen?.stream).toBe(true)
    expect(seen?.store).toBe(false)
    expect(seen?.input).toContainEqual({ type: 'compaction_trigger' })
    if (!('preserveData' in result)) return
    const preserved = result.preserveData?.[
      OPENAI_REMOTE_COMPACTION_PRESERVE_KEY
    ] as Record<string, unknown>
    expect(preserved.version).toBe('v2')
    expect(preserved.retainedImageCount).toBe(0)
  })

  test('retains newest user messages within the budget', () => {
    const longText = 'x'.repeat(100)
    const input = [
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: longText }],
      },
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: longText }],
      },
      { type: 'function_call', call_id: 'c1', name: 'Read', arguments: '{}' },
    ]
    const { replacementHistory } = buildOpenAiV2ReplacementHistory(
      input,
      { type: 'compaction', encrypted_content: 'enc' },
      30,
    )
    expect(replacementHistory).toHaveLength(3)
    expect(replacementHistory.at(-1)?.type).toBe('compaction')
    expect(replacementHistory.every(item => item.role !== 'assistant')).toBe(
      true,
    )
  })

  test('the default retained budget is the 64K ceiling', () => {
    expect(V2_RETAINED_MESSAGE_TOKEN_BUDGET).toBe(64_000)
  })
})

describe('lane selection', () => {
  test('Codex endpoints skip with a reason', async () => {
    const result = await runOpenAiCompactionLane({
      ...laneRequest([user('u1', 'hello')], async () => {
        throw new Error('should not fetch')
      }),
      transport: {
        fetch: async () => {
          throw new Error('should not fetch')
        },
        apiKey: 'k',
        baseUrl: 'https://chatgpt.com/backend-api/codex',
        model: 'gpt-5',
      },
    })
    expect(result).toEqual({ skipped: 'openai-codex-compact-unsupported' })
  })

  test('auto falls back to V1 when V2 fails', async () => {
    const urls: string[] = []
    const result = await runOpenAiCompactionLane(
      laneRequest([user('u1', 'hello')], async url => {
        urls.push(url)
        if (url.endsWith('/responses/compact')) {
          return new Response(v1Response, { status: 200 })
        }
        return new Response('no', { status: 500 })
      }),
    )
    expect(urls).toHaveLength(2)
    expect(urls[1]).toContain('/responses/compact')
    expect('summary' in result).toBe(true)
  })
})
