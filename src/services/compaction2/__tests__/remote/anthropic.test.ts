import { describe, expect, test } from 'bun:test'
import type { Message } from '../../../../types/message.js'
import {
  ANTHROPIC_BETA_HEADER,
  ANTHROPIC_COMPACTION_BETA,
  ANTHROPIC_COMPACTION_PRESERVE_KEY,
  buildAnthropicCompactionHeaders,
  buildAnthropicCompactionRequest,
  extractAnthropicCompactionBlock,
  getPreservedAnthropicCompactionData,
  isAnthropicCompactionLaneAvailable,
  isKnownAnthropicEndpoint,
  parseAnthropicCompactionEvents,
  resolveAnthropicMessagesEndpoint,
  supportsAnthropicServerCompaction,
  withAnthropicCompactionPreserveData,
} from '../../methods/remote/anthropic.js'

function user(text: string): Message {
  return {
    type: 'user',
    uuid: 'u',
    message: { role: 'user', content: text },
  } as unknown as Message
}

describe('supportsAnthropicServerCompaction', () => {
  test('accepts Opus/Sonnet 4.6+ and Fable/Mythos 5+', () => {
    expect(supportsAnthropicServerCompaction('claude-opus-4-6')).toBe(true)
    expect(supportsAnthropicServerCompaction('claude-sonnet-4-6')).toBe(true)
    expect(supportsAnthropicServerCompaction('claude-opus-4-7-20260101')).toBe(
      true,
    )
    expect(supportsAnthropicServerCompaction('claude-fable-5')).toBe(true)
    expect(supportsAnthropicServerCompaction('claude-mythos-5')).toBe(true)
  })

  test('rejects older and unknown models', () => {
    expect(supportsAnthropicServerCompaction('claude-opus-4-5')).toBe(false)
    expect(supportsAnthropicServerCompaction('claude-sonnet-4-5')).toBe(false)
    expect(supportsAnthropicServerCompaction('claude-haiku-4-5')).toBe(false)
    expect(supportsAnthropicServerCompaction('gpt-5')).toBe(false)
  })
})

describe('endpoint gates', () => {
  test('first-party host is the only known Anthropic endpoint', () => {
    expect(isKnownAnthropicEndpoint(undefined)).toBe(true)
    expect(isKnownAnthropicEndpoint('https://api.anthropic.com')).toBe(true)
    expect(isKnownAnthropicEndpoint('https://gateway.example.com')).toBe(false)
  })

  test('lane availability matches provider capability', () => {
    expect(
      isAnthropicCompactionLaneAvailable({
        provider: 'firstParty',
        model: 'claude-opus-4-6',
      }),
    ).toBe(true)
    expect(
      isAnthropicCompactionLaneAvailable({
        provider: 'firstParty',
        model: 'claude-opus-4-6',
        baseUrl: 'https://gateway.example.com',
      }),
    ).toBe(false)
    expect(
      isAnthropicCompactionLaneAvailable({
        provider: 'vertex',
        model: 'claude-opus-4-6',
        env: { ANTHROPIC_VERTEX_PROJECT_ID: 'p' },
      }),
    ).toBe(true)
    expect(
      isAnthropicCompactionLaneAvailable({
        provider: 'bedrock',
        model: 'claude-opus-4-6',
      }),
    ).toBe(false)
  })

  test('resolves Messages and Vertex rawPredict endpoints', () => {
    expect(
      resolveAnthropicMessagesEndpoint({
        provider: 'firstParty',
        model: 'claude-opus-4-6',
        env: {},
      }),
    ).toBe('https://api.anthropic.com/v1/messages')
    expect(
      resolveAnthropicMessagesEndpoint({
        provider: 'vertex',
        model: 'claude-opus-4-6',
        env: { ANTHROPIC_VERTEX_PROJECT_ID: 'p', CLOUD_ML_REGION: 'us' },
      }),
    ).toContain(':rawPredict')
    expect(
      resolveAnthropicMessagesEndpoint({
        provider: 'vertex',
        model: 'claude-opus-4-6',
        env: {},
      }),
    ).toBeUndefined()
  })
})

describe('request shape', () => {
  test('carries compaction: { type: "summarize", instructions }', () => {
    const built = buildAnthropicCompactionRequest({
      model: 'claude-opus-4-6',
      messages: [user('hello')],
      instructions: 'focus on tests',
    })
    expect(built.unsupported).toBeUndefined()
    expect(built.body.compaction).toEqual({
      type: 'summarize',
      instructions: 'focus on tests',
    })
    expect(built.body.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'hello' }] },
    ])
  })

  test('uses the exact anthropic-beta header name and value', () => {
    const headers = buildAnthropicCompactionHeaders({ apiKey: 'k' })
    expect(headers[ANTHROPIC_BETA_HEADER]).toBe(ANTHROPIC_COMPACTION_BETA)
    expect(headers['x-api-key']).toBe('k')
  })

  test('Vertex moves the beta into the body instead of the header', () => {
    const built = buildAnthropicCompactionRequest({
      model: 'claude-opus-4-6',
      messages: [user('hello')],
      instructions: 'summarize',
      vertex: true,
    })
    expect(built.body.anthropic_beta).toEqual([ANTHROPIC_COMPACTION_BETA])
    const headers = buildAnthropicCompactionHeaders({ vertex: true })
    expect(headers[ANTHROPIC_BETA_HEADER]).toBeUndefined()
  })
})

describe('response parsing and preserve data', () => {
  test('extracts a signed compaction block', () => {
    const block = extractAnthropicCompactionBlock({
      stop_reason: 'compaction',
      content: [
        { type: 'text', text: 'ignored' },
        {
          type: 'compaction',
          content: 'summary',
          signature: 'sig',
          tool_changes: [{ op: 'add' }],
        },
      ],
    })
    expect(block).toEqual({
      content: 'summary',
      signature: 'sig',
      toolChanges: [{ op: 'add' }],
    })
  })

  test('rejects unsigned or legacy-only blocks', () => {
    expect(
      extractAnthropicCompactionBlock({
        stop_reason: 'compaction',
        content: [{ type: 'compaction', content: 'summary' }],
      }),
    ).toBeUndefined()
    expect(
      extractAnthropicCompactionBlock({
        stop_reason: 'end_turn',
        content: [{ type: 'compaction', content: 's', signature: 'sig' }],
      }),
    ).toBeUndefined()
  })

  test('parses streamed content_block_start events', () => {
    const block = parseAnthropicCompactionEvents([
      {
        type: 'content_block_start',
        index: 1,
        content_block: {
          type: 'compaction',
          content: 'streamed',
          signature: 'sig',
        },
      },
      {
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'text_delta', text: ' summary' },
      },
    ])
    expect(block?.content).toBe('streamed summary')
  })

  test('round-trips preserveData and strips the slot', () => {
    const preserved = withAnthropicCompactionPreserveData(undefined, {
      provider: 'firstParty',
      content: 'summary',
      signature: 'sig',
    })
    expect(preserved?.[ANTHROPIC_COMPACTION_PRESERVE_KEY]).toBeDefined()
    expect(getPreservedAnthropicCompactionData(preserved)).toMatchObject({
      provider: 'firstParty',
      content: 'summary',
      signature: 'sig',
    })
    expect(withAnthropicCompactionPreserveData(preserved, undefined)).toBe(
      undefined,
    )
  })
})
