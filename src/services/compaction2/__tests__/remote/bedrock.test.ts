import { describe, expect, test } from 'bun:test'
import type { Message } from '../../../../types/message.js'
import {
  DEFAULT_COMPACTION_SETTINGS,
  type CompactionContext,
} from '../../contracts.js'
import {
  BEDROCK_COMPACTION_DISABLED_REASON,
  BEDROCK_COMPACTION_SKIPPED_REASON,
  buildBedrockConverseCompactionSideRequest,
  extractBedrockConverseSummary,
  isBedrockCompactionEnabled,
  isBedrockCompactionLaneAvailable,
  runBedrockCompactionLane,
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
}) {
  return {
    ctx: ctx(overrides.messages),
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

  test('requires a region and a capable model', () => {
    expect(
      isBedrockCompactionLaneAvailable({
        model: MODEL,
        env: { CCH_BEDROCK_COMPACTION: '1' },
      }),
    ).toBe(false)
    expect(
      isBedrockCompactionLaneAvailable({
        model: 'claude-sonnet-4-5',
        region: 'us-east-1',
        env: { CCH_BEDROCK_COMPACTION: '1' },
      }),
    ).toBe(false)
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
              content: [{ text: '' }],
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

  test('refuses unknown blocks and empty history', () => {
    expect(
      toBedrockConverseMessages([userBlocks('u1', [{ type: 'mystery' }])])
        .unsupported,
    ).toBe('bedrock-unsupported-content-block')
    expect(toBedrockConverseMessages([]).unsupported).toBe(
      'bedrock-no-summarizable-messages',
    )
  })

  test('builds a Converse body without system/tools', () => {
    const built = buildBedrockConverseCompactionSideRequest(
      laneRequest({ messages: [userText('u1', 'hello')] }),
      { maxTokens: 256 },
    )
    expect(built?.modelId).toBe(MODEL)
    expect(built?.contentType).toBe('application/json')
    expect(built?.accept).toBe('application/json')
    expect(built?.body).toEqual({
      messages: [{ role: 'user', content: [{ text: 'hello' }] }],
      inferenceConfig: { maxTokens: 256 },
    })
    expect(built?.body).not.toHaveProperty('system')
    expect(built?.body).not.toHaveProperty('toolConfig')
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
      messages: unknown[]
    }
    expect(body.messages).toHaveLength(1)
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
