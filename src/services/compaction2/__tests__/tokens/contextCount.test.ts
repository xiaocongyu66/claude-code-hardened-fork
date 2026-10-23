import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import type { Message } from '../../../../types/message.js'
import { countTokensPreciseForMessages } from '../../../tokenEstimation.js'
import { TOKENIZER_DIR_ENV, resetTokenizerCache } from '../../tokens/index.js'
import { countContextTokens } from '../../tokens/contextCount.js'

const FIXTURES = join(import.meta.dir, '..', 'fixtures')
const MODEL = 'mini/cl100k-v1'
const originalDir = process.env[TOKENIZER_DIR_ENV]

beforeAll(() => {
  process.env[TOKENIZER_DIR_ENV] = FIXTURES
  resetTokenizerCache()
})

afterAll(() => {
  if (originalDir === undefined) {
    delete process.env[TOKENIZER_DIR_ENV]
  } else {
    process.env[TOKENIZER_DIR_ENV] = originalDir
  }
  resetTokenizerCache()
})

let uuidCounter = 0

function nextUuid(): Message['uuid'] {
  uuidCounter += 1
  return `00000000-0000-4000-8000-${String(uuidCounter).padStart(12, '0')}` as Message['uuid']
}

function userMessage(content: unknown): Message {
  return {
    type: 'user',
    uuid: nextUuid(),
    message: { role: 'user', content } as unknown as Message['message'],
  } as unknown as Message
}

function assistantMessage(
  options: {
    id?: string
    text?: string
    model?: string
    usage?: Record<string, number>
  } = {},
): Message {
  return {
    type: 'assistant',
    uuid: nextUuid(),
    message: {
      id: options.id ?? 'msg_1',
      model: options.model ?? MODEL,
      role: 'assistant',
      content: [{ type: 'text', text: options.text ?? 'answer' }],
      ...(options.usage ? { usage: options.usage } : {}),
    },
  } as unknown as Message
}

function usage(overrides: Record<string, number> = {}): Record<string, number> {
  return {
    input_tokens: 100,
    output_tokens: 20,
    cache_read_input_tokens: 10,
    cache_creation_input_tokens: 5,
    ...overrides,
  }
}

/** Minimal PNG header: signature + IHDR with the given dimensions. */
function pngBase64(width: number, height: number): string {
  const buffer = Buffer.alloc(24)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0)
  buffer.writeUInt32BE(13, 8)
  buffer.write('IHDR', 12, 'ascii')
  buffer.writeUInt32BE(width, 16)
  buffer.writeUInt32BE(height, 20)
  return buffer.toString('base64')
}

function imageBlock(data: string): Record<string, unknown> {
  return {
    type: 'image',
    source: { type: 'base64', media_type: 'image/png', data },
  }
}

describe('countContextTokens anchor and tail', () => {
  test('uses the last usage block as an anchor and tokenizes the tail', () => {
    const result = countContextTokens(
      [
        userMessage('hello'),
        assistantMessage({ usage: usage() }),
        userMessage('hello world'),
      ],
      MODEL,
    )

    expect(result.source).toBe('usage-anchor')
    expect(result.anchorIndex).toBe(1)
    expect(result.tailTokens).toBe(2)
    // 100 + 20 + 10 + 5 = 135 anchor tokens, plus 2 tail tokens.
    expect(result.tokens).toBe(137)
  })

  test('walks back to the first sibling split of the same API response', () => {
    const result = countContextTokens(
      [
        userMessage('start'),
        assistantMessage({ id: 'msg_A', text: 'first', usage: usage() }),
        userMessage('hello world'),
        assistantMessage({ id: 'msg_A', text: 'second', usage: usage() }),
        userMessage('hello world'),
      ],
      MODEL,
    )

    // Anchor at the first msg_A record so both interleaved tool_results are
    // counted in the tail.
    expect(result.anchorIndex).toBe(1)
    expect(result.tailTokens).toBeGreaterThan(0)
    expect(result.tokens).toBe(135 + (result.tailTokens ?? 0))
  })

  test('stops the sibling walk at a different message id', () => {
    const result = countContextTokens(
      [
        userMessage('start'),
        assistantMessage({ id: 'msg_A', usage: usage() }),
        userMessage('hello world'),
        assistantMessage({ id: 'msg_B', usage: usage() }),
        userMessage('hello world'),
      ],
      MODEL,
    )

    expect(result.anchorIndex).toBe(3)
  })

  test('skips all-zero and synthetic usage blocks', () => {
    const result = countContextTokens(
      [
        assistantMessage({ id: 'msg_real', usage: usage() }),
        assistantMessage({
          id: 'msg_zero',
          usage: usage({
            input_tokens: 0,
            output_tokens: 0,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          }),
        }),
        assistantMessage({
          id: 'msg_synth',
          model: '<synthetic>',
          usage: usage(),
        }),
      ],
      MODEL,
    )

    expect(result.anchorIndex).toBe(0)
    expect(result.source).toBe('usage-anchor')
  })

  test('deducts provider orchestration tokens from the anchor only', () => {
    const result = countContextTokens(
      [assistantMessage({ usage: usage() }), userMessage('hello world')],
      MODEL,
      { orchestrationTokens: 35 },
    )

    expect(result.tokens).toBe(102)
    expect(result.tailTokens).toBe(2)
  })

  test('clamps orchestration tokens at zero', () => {
    const result = countContextTokens(
      [assistantMessage({ usage: usage() })],
      MODEL,
      { orchestrationTokens: 10_000 },
    )

    expect(result.tokens).toBe(0)
  })
})

describe('countContextTokens without an anchor', () => {
  test('tokenizes the whole transcript', () => {
    const result = countContextTokens(
      [userMessage('hello world'), assistantMessage({ text: 'hello world' })],
      MODEL,
    )

    expect(result.source).toBe('tokenizer')
    expect(result.anchorIndex).toBeUndefined()
    expect(result.tokens).toBe(4)
  })

  test('CJK text goes through the real tokenizer', () => {
    const result = countContextTokens([userMessage('中文abc')], 'mini/kimi-k2')

    expect(result.source).toBe('tokenizer')
    expect(result.tokens).toBe(2)
  })
})

describe('countContextTokens image pricing', () => {
  test('Anthropic bills 28px patches', () => {
    const result = countContextTokens(
      [userMessage([imageBlock(pngBase64(100, 100))])],
      MODEL,
      { provider: 'firstParty' },
    )

    // ceil(100/28) * ceil(100/28) = 16 patches.
    expect(result.tokens).toBe(16)
  })

  test('Gemini bills a fixed 1,120 tokens per image', () => {
    const result = countContextTokens(
      [userMessage([imageBlock(pngBase64(100, 100))])],
      MODEL,
      { provider: 'gemini' },
    )

    expect(result.tokens).toBe(1120)
  })

  test('OpenAI estimates by 32px patch area', () => {
    const result = countContextTokens(
      [userMessage([imageBlock(pngBase64(100, 100))])],
      MODEL,
      { provider: 'openai' },
    )

    // 4 * 4 patches * 1.2 = 19.2 -> 20.
    expect(result.tokens).toBe(20)
  })

  test('unknown image sizes fall back per provider', () => {
    const block = imageBlock('')
    expect(
      countContextTokens([userMessage([block])], MODEL, {
        provider: 'firstParty',
      }).tokens,
    ).toBe(4784)
    expect(
      countContextTokens([userMessage([block])], MODEL, {
        provider: 'gemini',
      }).tokens,
    ).toBe(1120)
    expect(
      countContextTokens([userMessage([block])], MODEL, {
        provider: 'openai',
      }).tokens,
    ).toBe(5024)
  })

  test('imageTokens can be injected for pure-function tests', () => {
    const result = countContextTokens([userMessage([imageBlock('')])], MODEL, {
      provider: 'gemini',
      imageTokens: (_block, provider) => (provider === 'gemini' ? 7 : 3),
    })

    expect(result.tokens).toBe(7)
  })
})

describe('countContextTokens fallback chain', () => {
  test('falls back to cl100k when no tokenizer data is configured', () => {
    const saved = process.env[TOKENIZER_DIR_ENV]
    try {
      delete process.env[TOKENIZER_DIR_ENV]
      resetTokenizerCache()
      const messages = [userMessage('hello world')]
      const result = countContextTokens(messages, MODEL)
      expect(result.source).toBe('fallback')
      // Text-only fallback matches the legacy cl100k/rough message walk.
      expect(result.tokens).toBe(
        countTokensPreciseForMessages(
          messages as Parameters<typeof countTokensPreciseForMessages>[0],
        ),
      )
    } finally {
      process.env[TOKENIZER_DIR_ENV] = saved
      resetTokenizerCache()
    }
  })

  test('falls back when the model has no manifest entry', () => {
    const result = countContextTokens(
      [userMessage('hello world')],
      'other/model',
    )

    expect(result.source).toBe('fallback')
    expect(result.tokens).toBeGreaterThan(0)
  })
})
