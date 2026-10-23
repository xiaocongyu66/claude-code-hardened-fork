import { describe, expect, test } from 'bun:test'
import type { Message } from '../../../../types/message.js'
import {
  DEFAULT_COMPACTION_SETTINGS,
  type CompactionContext,
} from '../../contracts.js'
import {
  BEDROCK_COMPACTION_DISABLED_REASON,
  BEDROCK_COMPACTION_SKIPPED_REASON,
  BEDROCK_EMPTY_TOOL_RESULT_TEXT,
  buildBedrockConverseCompactionSideRequest,
  extractBedrockConverseSummary,
  isBedrockCompactionEnabled,
  isBedrockCompactionLaneAvailable,
  runBedrockCompactionLane,
  supportsBedrockConverseCompaction,
  toBedrockConverseMessages,
} from '../../methods/remote/bedrock.js'
import {
  type BedrockConverseRuntime,
  buildRemoteTransport,
} from '../../methods/remote/transport.js'
import { createRemoteMethod } from '../../methods/remote/index.js'
import type { RemoteFetch } from '../../methods/remote/index.js'

const MODEL = 'claude-sonnet-4-6'

function userText(uuid: string, text: string): Message {
  return {
    type: 'user',
    uuid,
    message: { role: 'user', content: text },
  } as unknown as Message
}

function assistantBlocks(
  uuid: string,
  content: Array<Record<string, unknown>>,
): Message {
  return {
    type: 'assistant',
    uuid,
    message: { role: 'assistant', content },
  } as unknown as Message
}

function userBlocks(
  uuid: string,
  content: Array<Record<string, unknown>>,
): Message {
  return {
    type: 'user',
    uuid,
    message: { role: 'user', content },
  } as unknown as Message
}

function ctx(
  messages: readonly Message[] = [userText('u1', 'hello')],
): CompactionContext {
  return {
    model: MODEL,
    trigger: 'threshold',
    messages,
    settings: { ...DEFAULT_COMPACTION_SETTINGS, keepRecentTokens: 0 },
    tokenCount: input => input.length * 100,
    estimateEntryTokens: () => 0,
    now: () => 0,
  }
}

function laneRequest(overrides: {
  fetch?: RemoteFetch
  env?: Record<string, string | undefined>
  messages?: readonly Message[]
  cut?: {
    messages: Message[]
    index: number
    kept: Message[]
    tokensAfter: number
    cutPoint: {
      firstKeptEntryId: string
      tokensBefore: number
      boundaryMessage: never
    }
  }
}) {
  return {
    ctx: ctx(overrides.messages),
    ...(overrides.cut ? { cut: overrides.cut } : {}),
    instructions: 'summarize',
    env: overrides.env ?? {
      CCH_BEDROCK_COMPACTION: '1',
      AWS_REGION: 'us-east-1',
    },
    provider: 'bedrock' as const,
    transport: {
      ...(overrides.fetch ? { fetch: overrides.fetch } : {}),
      baseUrl: 'https://bedrock-runtime.us-east-1.amazonaws.com',
      model: MODEL,
    },
  }
}

const converseResponse = JSON.stringify({
  output: {
    message: {
      role: 'assistant',
      content: [{ text: '## Recent goals\nShip it' }],
    },
  },
  stopReason: 'end_turn',
  usage: { inputTokens: 123, outputTokens: 7, totalTokens: 130 },
})

describe('Bedrock compaction gate', () => {
  test('requires CCH_BEDROCK_COMPACTION=1 independently of remote', () => {
    expect(isBedrockCompactionEnabled({ CCH_BEDROCK_COMPACTION: '1' })).toBe(
      true,
    )
    expect(isBedrockCompactionEnabled({})).toBe(false)
    expect(isBedrockCompactionEnabled({ CCH_REMOTE_COMPACTION: '1' })).toBe(
      false,
    )
    expect(
      isBedrockCompactionLaneAvailable({
        model: MODEL,
        region: 'us-east-1',
        env: { CCH_REMOTE_COMPACTION: '1' },
      }),
    ).toBe(false)
    expect(
      isBedrockCompactionLaneAvailable({
        model: MODEL,
        region: 'us-east-1',
        env: { CCH_BEDROCK_COMPACTION: '1' },
      }),
    ).toBe(true)
  })

  test('requires a region and a Claude model', () => {
    expect(
      isBedrockCompactionLaneAvailable({
        model: MODEL,
        env: { CCH_BEDROCK_COMPACTION: '1' },
      }),
    ).toBe(false)
    expect(
      isBedrockCompactionLaneAvailable({
        model: 'meta.llama3-70b-instruct-v1:0',
        region: 'us-east-1',
        env: { CCH_BEDROCK_COMPACTION: '1' },
      }),
    ).toBe(false)
  })

  test('does not exclude Bedrock models the Anthropic beta catalog lacks', () => {
    // The Converse lane summarizes, it does not use the Anthropic server
    // compaction beta, so its version gate must not apply here.
    expect(supportsBedrockConverseCompaction('claude-sonnet-4-5')).toBe(true)
    expect(
      supportsBedrockConverseCompaction(
        'anthropic.claude-3-5-sonnet-20241022-v2:0',
      ),
    ).toBe(true)
    expect(
      supportsBedrockConverseCompaction(
        'arn:aws:bedrock:us-east-1:1:inference-profile/us.anthropic.claude-sonnet-4-6-v1:0',
      ),
    ).toBe(true)
    expect(supportsBedrockConverseCompaction('gpt-5')).toBe(false)
    expect(
      isBedrockCompactionLaneAvailable({
        model: 'claude-sonnet-4-5',
        region: 'us-east-1',
        env: { CCH_BEDROCK_COMPACTION: '1' },
      }),
    ).toBe(true)
  })
})

describe('Converse request mapping', () => {
  test('maps text, tool_use and tool_result blocks', () => {
    const messages = [
      userText('u1', 'find the file'),
      assistantBlocks('a1', [
        { type: 'text', text: 'reading' },
        {
          type: 'tool_use',
          id: 't1',
          name: 'Read',
          input: { file_path: '/tmp/x' },
        },
      ]),
      userBlocks('u2', [
        { type: 'tool_result', tool_use_id: 't1', content: 'file body' },
      ]),
    ]
    const mapped = toBedrockConverseMessages(messages)
    expect(mapped.unsupported).toBeUndefined()
    expect(mapped.messages).toEqual([
      { role: 'user', content: [{ text: 'find the file' }] },
      {
        role: 'assistant',
        content: [
          { text: 'reading' },
          {
            toolUse: {
              toolUseId: 't1',
              name: 'Read',
              input: { file_path: '/tmp/x' },
            },
          },
        ],
      },
      {
        role: 'user',
        content: [
          {
            toolResult: {
              toolUseId: 't1',
              content: [{ text: 'file body' }],
              status: 'success',
            },
          },
        ],
      },
    ])
  })

  test('marks failed tool results and skips reasoning/image blocks', () => {
    const mapped = toBedrockConverseMessages([
      userBlocks('u1', [
        { type: 'thinking', thinking: 'secret' },
        { type: 'image', source: { type: 'base64', data: 'x' } },
        { type: 'tool_result', tool_use_id: 't1', content: '', is_error: true },
      ]),
    ])
    expect(mapped.messages).toEqual([
      {
        role: 'user',
        content: [
          {
            toolResult: {
              toolUseId: 't1',
              // Converse rejects empty text blocks.
              content: [{ text: BEDROCK_EMPTY_TOOL_RESULT_TEXT }],
              status: 'error',
            },
          },
        ],
      },
    ])
  })

  test('merges consecutive same-role messages', () => {
    const mapped = toBedrockConverseMessages([
      userText('u1', 'one'),
      userText('u2', 'two'),
    ])
    expect(mapped.messages).toEqual([
      { role: 'user', content: [{ text: 'one' }, { text: 'two' }] },
    ])
  })

  test('skips and counts unknown blocks instead of failing', () => {
    const mapped = toBedrockConverseMessages([
      userBlocks('u1', [
        { type: 'web_search_tool_result', content: [] },
        { type: 'text', text: 'kept' },
        { type: 'document', source: { type: 'base64' } },
      ]),
    ])
    expect(mapped.unsupported).toBeUndefined()
    expect(mapped.skippedBlocks).toBe(2)
    expect(mapped.messages).toEqual([
      { role: 'user', content: [{ text: 'kept' }] },
    ])
    expect(toBedrockConverseMessages([]).unsupported).toBe(
      'bedrock-no-summarizable-messages',
    )
  })

  test('builds a Converse body that requests a summary via system', () => {
    const built = buildBedrockConverseCompactionSideRequest(
      laneRequest({ messages: [userText('u1', 'hello')] }),
      { maxTokens: 256 },
    )
    expect(built?.modelId).toBe(MODEL)
    expect(built?.contentType).toBe('application/json')
    expect(built?.accept).toBe('application/json')
    expect(built?.body).toEqual({
      system: [{ text: 'summarize' }],
      messages: [{ role: 'user', content: [{ text: 'hello' }] }],
      inferenceConfig: { maxTokens: 256 },
    })
    expect(built?.body).not.toHaveProperty('toolConfig')
  })

  test('summarizes the cut prefix rather than the full history', () => {
    const full = [
      userText('u1', 'old one'),
      userText('u2', 'old two'),
      userText('u3', 'recent tail'),
    ]
    const built = buildBedrockConverseCompactionSideRequest({
      ...laneRequest({ messages: full }),
      cut: {
        messages: [full[0]!, full[1]!],
        index: 2,
        kept: [full[2]!],
        tokensAfter: 10,
        cutPoint: {
          firstKeptEntryId: 'u3',
          tokensBefore: 30,
          boundaryMessage: {} as never,
        },
      },
    })
    expect(built?.body.messages).toEqual([
      { role: 'user', content: [{ text: 'old one' }, { text: 'old two' }] },
    ])
  })
})

describe('Converse response parsing', () => {
  test('joins output.message.content text blocks', () => {
    expect(
      extractBedrockConverseSummary({
        output: {
          message: {
            role: 'assistant',
            content: [{ text: 'first' }, { text: 'second' }],
          },
        },
      }),
    ).toBe('first\nsecond')
  })

  test('returns undefined without text', () => {
    expect(extractBedrockConverseSummary({ output: {} })).toBeUndefined()
    expect(extractBedrockConverseSummary(null)).toBeUndefined()
  })
})

describe('Bedrock compaction lane', () => {
  test('skips when the gate is off', async () => {
    expect(
      await runBedrockCompactionLane(
        laneRequest({
          env: { CCH_REMOTE_COMPACTION: '1', AWS_REGION: 'us-east-1' },
          fetch: async () => {
            throw new Error('request should not be sent')
          },
        }),
      ),
    ).toEqual({ skipped: BEDROCK_COMPACTION_DISABLED_REASON })
  })

  test('skips without a transport client', async () => {
    expect(await runBedrockCompactionLane(laneRequest({}))).toEqual({
      skipped: BEDROCK_COMPACTION_SKIPPED_REASON,
    })
  })

  test('sends a Converse request and parses the summary', async () => {
    const calls: Array<{ url: string; init: Record<string, unknown> }> = []
    const result = await runBedrockCompactionLane(
      laneRequest({
        fetch: async (url, init) => {
          calls.push({ url, init: init as Record<string, unknown> })
          return new Response(converseResponse, { status: 200 })
        },
      }),
    )
    expect('skipped' in result).toBe(false)
    if ('skipped' in result) return
    expect(result.summary).toBe('## Recent goals\nShip it')
    expect(result.preserveData?.bedrock).toMatchObject({
      version: 1,
      provider: 'bedrock',
      model: MODEL,
      modelId: MODEL,
      stopReason: 'end_turn',
      usedTokens: 123,
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe(
      `https://bedrock-runtime.us-east-1.amazonaws.com/model/${encodeURIComponent(MODEL)}/converse`,
    )
    const body = JSON.parse(String(calls[0]?.init.body)) as {
      system?: Array<{ text: string }>
      messages: unknown[]
    }
    expect(body.messages).toHaveLength(1)
    // The summary instruction must reach the model; without it Converse only
    // continues the conversation.
    expect(body.system).toEqual([{ text: 'summarize' }])
  })

  test('sends the cut prefix, not the full history', async () => {
    const full = [
      userText('u1', 'old one'),
      userText('u2', 'old two'),
      userText('u3', 'recent tail'),
    ]
    const bodies: Array<{ messages: Array<{ content: unknown[] }> }> = []
    await runBedrockCompactionLane(
      laneRequest({
        messages: full,
        cut: {
          messages: [full[0]!, full[1]!],
          index: 2,
          kept: [full[2]!],
          tokensAfter: 10,
          cutPoint: {
            firstKeptEntryId: 'u3',
            tokensBefore: 30,
            boundaryMessage: {} as never,
          },
        },
        fetch: async (_url, init) => {
          bodies.push(JSON.parse(String(init.body)))
          return new Response(converseResponse, { status: 200 })
        },
      }),
    )
    // Converse requires alternating roles, so two consecutive user messages
    // in the prefix are merged into one message with two text blocks.
    const sent = JSON.stringify(bodies[0]?.messages)
    expect(sent).toContain('old one')
    expect(sent).toContain('old two')
    expect(sent).not.toContain('recent tail')
  })

  test('throws when the completion stopped abnormally', async () => {
    await expect(
      runBedrockCompactionLane(
        laneRequest({
          fetch: async () =>
            new Response(
              JSON.stringify({
                output: {
                  message: {
                    role: 'assistant',
                    content: [{ text: 'cut off' }],
                  },
                },
                stopReason: 'max_tokens',
              }),
              { status: 200 },
            ),
        }),
      ),
    ).rejects.toThrow('stopped with reason "max_tokens"')
  })

  test('reports skipped unknown content blocks as a warning', async () => {
    const result = await runBedrockCompactionLane(
      laneRequest({
        messages: [
          userBlocks('u1', [
            { type: 'web_search_tool_result', content: [] },
            { type: 'text', text: 'kept' },
          ]),
        ],
        fetch: async () => new Response(converseResponse, { status: 200 }),
      }),
    )
    expect('skipped' in result).toBe(false)
    if ('skipped' in result) return
    expect(result.warning).toBe('bedrock-skipped-unsupported-blocks:1')
  })

  test('throws on a non-2xx response', async () => {
    await expect(
      runBedrockCompactionLane(
        laneRequest({
          fetch: async () => new Response('bad model', { status: 400 }),
        }),
      ),
    ).rejects.toThrow('Bedrock compaction failed (400')
  })

  test('throws on timeout', async () => {
    await expect(
      runBedrockCompactionLane(
        laneRequest({
          env: {
            CCH_BEDROCK_COMPACTION: '1',
            AWS_REGION: 'us-east-1',
            CCH_BEDROCK_COMPACTION_TIMEOUT_MS: '10',
          },
          fetch: (_url, init) =>
            new Promise((_resolve, reject) => {
              init.signal?.addEventListener('abort', () =>
                reject(new Error('aborted')),
              )
            }),
        }),
      ),
    ).rejects.toThrow('timed out')
  })

  test('fails the method chain when no Converse transport is injected', async () => {
    const method = createRemoteMethod({
      env: {
        CCH_REMOTE_COMPACTION: '1',
        CCH_BEDROCK_COMPACTION: '1',
        AWS_REGION: 'us-east-1',
      },
      provider: 'bedrock',
    })
    expect(method.isAvailable(ctx())).toBe(true)
    expect(await method.run(ctx())).toEqual({
      kind: 'skipped',
      method: 'remote',
      reason: 'remote-transport-missing',
    })
  })

  test('the method is unavailable without the Bedrock gate', async () => {
    const method = createRemoteMethod({
      env: { CCH_REMOTE_COMPACTION: '1', AWS_REGION: 'us-east-1' },
      provider: 'bedrock',
    })
    expect(method.isAvailable(ctx())).toBe(false)
    await expect(method.run(ctx())).resolves.toEqual({
      kind: 'skipped',
      method: 'remote',
      reason: 'remote-lane-unavailable',
    })
  })
})

describe('Bedrock transport', () => {
  function stubRuntime(): {
    runtime: BedrockConverseRuntime
    inputs: Array<Record<string, unknown>>
  } {
    const inputs: Array<Record<string, unknown>> = []
    return {
      inputs,
      runtime: {
        sendConverse: async input => {
          inputs.push(input)
          return JSON.parse(converseResponse) as unknown
        },
      },
    }
  }

  test('forwards Converse calls through the injected runtime', async () => {
    const { runtime, inputs } = stubRuntime()
    const transport = buildRemoteTransport({
      provider: 'bedrock',
      env: { AWS_REGION: 'us-east-1' },
      getBedrockConverseRuntime: () => runtime,
    })
    expect(transport).toBeDefined()
    expect(transport?.baseUrl).toBe(
      'https://bedrock-runtime.us-east-1.amazonaws.com',
    )
    const response = await transport?.fetch(
      `${transport.baseUrl}/model/${encodeURIComponent(MODEL)}/converse`,
      {
        method: 'POST',
        body: JSON.stringify({
          messages: [{ role: 'user', content: [{ text: 'hi' }] }],
          inferenceConfig: { maxTokens: 10 },
        }),
      },
    )
    expect(response?.ok).toBe(true)
    expect(inputs[0]).toMatchObject({
      modelId: MODEL,
      inferenceConfig: { maxTokens: 10 },
    })
    const payload = (await response?.json()) as {
      output: { message: { content: Array<{ text: string }> } }
    }
    expect(payload.output.message.content[0]?.text).toContain('Recent goals')
  })

  test('returns undefined when the injected runtime is missing', () => {
    expect(
      buildRemoteTransport({
        provider: 'bedrock',
        env: { AWS_REGION: 'us-east-1' },
        getBedrockConverseRuntime: () => undefined,
      }),
    ).toBeUndefined()
  })

  test('retries runtime resolution after a failed attempt', async () => {
    let attempts = 0
    const { runtime } = stubRuntime()
    const transport = buildRemoteTransport({
      provider: 'bedrock',
      env: { AWS_REGION: 'us-east-1' },
      getBedrockConverseRuntime: () => {
        attempts++
        return attempts === 1
          ? Promise.reject(new Error('credentials unavailable'))
          : runtime
      },
    })
    expect(transport).toBeDefined()
    const url = `${transport?.baseUrl}/model/${encodeURIComponent(MODEL)}/converse`
    await expect(transport?.fetch(url, { method: 'POST' })).rejects.toThrow(
      'credentials unavailable',
    )
    // The failed promise must not be cached: fixing credentials retries.
    const response = await transport?.fetch(url, { method: 'POST' })
    expect(response?.ok).toBe(true)
    expect(attempts).toBe(2)
  })

  test('honors a Bedrock base URL override', () => {
    const transport = buildRemoteTransport({
      provider: 'bedrock',
      env: {
        AWS_REGION: 'us-east-1',
        ANTHROPIC_BEDROCK_BASE_URL: 'https://proxy.example.com/bedrock/',
      },
      getBedrockConverseRuntime: () => stubRuntime().runtime,
    })
    expect(transport?.baseUrl).toBe('https://proxy.example.com/bedrock')
  })
})
