import { describe, expect, test } from 'bun:test'
import type { Message } from '../../../../types/message.js'
import {
  DEFAULT_COMPACTION_SETTINGS,
  type CompactionContext,
} from '../../contracts.js'
import { createRemoteMethod } from '../../methods/remote/index.js'

function userMessage(uuid: string, text: string): Message {
  return {
    type: 'user',
    uuid,
    message: { role: 'user', content: text },
  } as unknown as Message
}

function assistantMessage(uuid: string, text: string): Message {
  return {
    type: 'assistant',
    uuid,
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  } as unknown as Message
}

function ctx(overrides: Partial<CompactionContext> = {}): CompactionContext {
  const messages = overrides.messages ?? [
    userMessage('u1', 'hello'),
    assistantMessage('a1', 'hi there'),
    userMessage('u2', 'continue'),
  ]
  return {
    model: 'claude-opus-4-6',
    trigger: 'threshold',
    messages,
    settings: { ...DEFAULT_COMPACTION_SETTINGS, keepRecentTokens: 0 },
    tokenCount: input => input.length * 100,
    estimateEntryTokens: () => 0,
    now: () => 0,
    ...overrides,
  }
}

const v1Body = JSON.stringify({
  output: [
    {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'keep me' }],
    },
    { type: 'compaction', encrypted_content: 'enc' },
  ],
})

describe('remote method availability', () => {
  test('is off unless CCH_REMOTE_COMPACTION=1', () => {
    const method = createRemoteMethod({
      env: { OPENAI_API_KEY: 'k' },
      provider: 'openai',
      apiKey: 'k',
    })
    expect(method.isAvailable(ctx())).toBe(false)
  })

  test('unknown gateways are never available', () => {
    const method = createRemoteMethod({
      env: { CCH_REMOTE_COMPACTION: '1' },
      provider: 'openai',
      apiKey: 'k',
      baseUrl: 'http://localhost:11434/v1',
    })
    expect(method.isAvailable(ctx())).toBe(false)
  })

  test('known OpenAI endpoint with a key is available', () => {
    const method = createRemoteMethod({
      env: { CCH_REMOTE_COMPACTION: '1' },
      provider: 'openai',
      apiKey: 'k',
      baseUrl: 'https://api.openai.com/v1',
    })
    expect(method.isAvailable(ctx())).toBe(true)
  })

  test('firstParty needs a supported model and known endpoint', () => {
    const supported = createRemoteMethod({
      env: { CCH_REMOTE_COMPACTION: '1' },
      provider: 'firstParty',
    })
    expect(supported.isAvailable(ctx())).toBe(true)

    const unknownGateway = createRemoteMethod({
      env: {
        CCH_REMOTE_COMPACTION: '1',
        ANTHROPIC_BASE_URL: 'https://gateway.example.com',
      },
      provider: 'firstParty',
    })
    expect(unknownGateway.isAvailable(ctx())).toBe(false)

    const oldModel = createRemoteMethod({
      env: { CCH_REMOTE_COMPACTION: '1' },
      provider: 'firstParty',
    })
    expect(oldModel.isAvailable(ctx({ model: 'claude-sonnet-4-5' }))).toBe(
      false,
    )
  })

  test('Vertex requires a resolvable project', () => {
    const base = {
      env: { CCH_REMOTE_COMPACTION: '1' },
      provider: 'vertex' as const,
    }
    expect(
      createRemoteMethod(base).isAvailable(ctx({ model: 'claude-opus-4-6' })),
    ).toBe(false)
    expect(
      createRemoteMethod({
        env: {
          CCH_REMOTE_COMPACTION: '1',
          ANTHROPIC_VERTEX_PROJECT_ID: 'p',
          CLOUD_ML_REGION: 'us-east5',
        },
        provider: 'vertex',
      }).isAvailable(ctx({ model: 'claude-opus-4-6' })),
    ).toBe(true)
  })

  test('Bedrock is available only with a region and capable model', () => {
    const method = createRemoteMethod({
      env: { CCH_REMOTE_COMPACTION: '1', AWS_REGION: 'us-east-1' },
      provider: 'bedrock',
    })
    expect(method.isAvailable(ctx({ model: 'claude-sonnet-4-6' }))).toBe(true)
    expect(method.isAvailable(ctx({ model: 'claude-sonnet-4-5' }))).toBe(false)
  })

  test('unsupported providers are unavailable', () => {
    for (const provider of ['gemini', 'grok', 'foundry'] as const) {
      const method = createRemoteMethod({
        env: { CCH_REMOTE_COMPACTION: '1' },
        provider,
      })
      expect(method.isAvailable(ctx())).toBe(false)
    }
  })
})

describe('remote method run', () => {
  test('skips when no transport is injected', async () => {
    const method = createRemoteMethod({
      env: { CCH_REMOTE_COMPACTION: '1' },
      provider: 'openai',
      apiKey: 'k',
      baseUrl: 'https://api.openai.com/v1',
    })
    expect(await method.run(ctx())).toEqual({
      kind: 'skipped',
      method: 'remote',
      reason: 'remote-transport-missing',
    })
  })

  test('runs the OpenAI V1 lane through the injected fetch', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const method = createRemoteMethod({
      env: { CCH_REMOTE_COMPACTION: '1' },
      provider: 'openai',
      apiKey: 'k',
      baseUrl: 'https://api.openai.com/v1',
      openAiVersion: 'v1',
      fetch: async (url, init) => {
        calls.push({ url, init })
        return new Response(v1Body, {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      },
    })
    const outcome = await method.run(ctx())
    expect(outcome.kind).toBe('compacted')
    if (outcome.kind !== 'compacted') return
    expect(outcome.method).toBe('remote')
    expect(outcome.cutPoint.tokensBefore).toBe(300)
    expect(outcome.preserveData?.openaiRemoteCompaction).toBeDefined()
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe(
      'https://api.openai.com/v1/responses/compact',
    )
  })

  test('runs the Anthropic lane and persists the signed block', async () => {
    const method = createRemoteMethod({
      env: { CCH_REMOTE_COMPACTION: '1' },
      provider: 'firstParty',
      apiKey: 'k',
      fetch: async () =>
        new Response(
          JSON.stringify({
            stop_reason: 'compaction',
            content: [
              {
                type: 'compaction',
                content: 'signed summary',
                signature: 'sig',
              },
            ],
            usage: { input_tokens: 42 },
          }),
          { status: 200 },
        ),
    })
    const outcome = await method.run(ctx())
    expect(outcome.kind).toBe('compacted')
    if (outcome.kind !== 'compacted') return
    expect(outcome.summary).toBe('signed summary')
    expect(outcome.preserveData?.anthropicCompaction).toMatchObject({
      content: 'signed summary',
      signature: 'sig',
    })
  })

  test('the Bedrock lane reports its skeleton skip', async () => {
    const method = createRemoteMethod({
      env: { CCH_REMOTE_COMPACTION: '1', AWS_REGION: 'us-east-1' },
      provider: 'bedrock',
      fetch: async () => new Response('{}', { status: 200 }),
    })
    expect(await method.run(ctx({ model: 'claude-sonnet-4-6' }))).toEqual({
      kind: 'skipped',
      method: 'remote',
      reason: 'bedrock-converse-transport-unavailable',
    })
  })

  test('a lane failure becomes a failed outcome', async () => {
    const method = createRemoteMethod({
      env: { CCH_REMOTE_COMPACTION: '1' },
      provider: 'firstParty',
      apiKey: 'k',
      fetch: async () => new Response('nope', { status: 500 }),
    })
    const outcome = await method.run(ctx())
    expect(outcome.kind).toBe('failed')
  })
})
