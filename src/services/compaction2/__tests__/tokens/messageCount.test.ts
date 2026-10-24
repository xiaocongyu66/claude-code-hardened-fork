import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import type { Message } from '../../../../types/message.js'
import { TOKENIZER_DIR_ENV, resetTokenizerCache } from '../../tokens/index.js'
import {
  countMessagesForThreshold,
  countMessagesWithTokenizer,
} from '../../tokens/messageCount.js'

const FIXTURES = join(import.meta.dir, '..', 'fixtures')
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

function user(content: unknown): Message {
  return {
    type: 'user',
    message: { role: 'user', content },
    uuid: 'u1',
  } as unknown as Message
}

function assistant(content: unknown): Message {
  return {
    type: 'assistant',
    message: { role: 'assistant', content },
    uuid: 'a1',
  } as unknown as Message
}

describe('countMessagesWithTokenizer', () => {
  test('counts ASCII and CJK exactly with the HF vocabulary', () => {
    expect(
      countMessagesWithTokenizer([user('abc hello')], 'mini/hf-basic-large'),
    ).toBe(2)
    // 中文 = 6 byte-level symbols; "abc" merges into one token.
    expect(
      countMessagesWithTokenizer([user('中文abc')], 'mini/hf-basic-large'),
    ).toBe(7)
  })

  test('uses a tiktoken vocabulary when the manifest selects it', () => {
    // mini-cl100k merges 中文 (rank 272) and abc (rank 257).
    expect(
      countMessagesWithTokenizer([user('中文abc')], 'mini/cl100k-v1'),
    ).toBe(2)
  })

  test('covers text, tool_result, tool_use, thinking, and image blocks', () => {
    const messages: Message[] = [
      user('abc hello'),
      assistant([{ type: 'text', text: 'abc' }]),
      user([
        {
          type: 'tool_result',
          tool_use_id: 't1',
          content: 'abc hello',
        },
      ]),
      assistant([
        { type: 'tool_use', id: 't1', name: 'x', input: { a: 1 } },
      ]),
      assistant([{ type: 'thinking', thinking: 'hello' }]),
      user([
        {
          type: 'image',
          source: { type: 'base64', media_type: 'image/png', data: 'xx' },
        },
      ]),
    ]
    // 2 (abc hello) + 1 (abc) + 2 (abc hello) + 8 (x + {"a":1})
    // + 3 (hello) + 2000 (image charge).
    expect(countMessagesWithTokenizer(messages, 'mini/hf-basic-large')).toBe(
      2016,
    )
  })

  test('treats documents like images and falls back to JSON for unknown blocks', () => {
    const document = {
      type: 'document',
      source: { type: 'base64', media_type: 'application/pdf', data: 'xx' },
    }
    expect(
      countMessagesWithTokenizer([user([document])], 'mini/hf-basic-large'),
    ).toBe(2000)

    const unknown = { type: 'server_tool_use', id: 's1', name: 'search' }
    // Unknown block types use the same JSON catch-all as the rough estimator.
    expect(
      countMessagesWithTokenizer([user([unknown])], 'mini/hf-basic-large'),
    ).toBe(
      countMessagesWithTokenizer(
        [user(JSON.stringify(unknown))],
        'mini/hf-basic-large',
      ),
    )
  })

  test('returns null without tokenizer data or without a matching model', () => {
    const messages = [user('hello')]
    expect(
      countMessagesWithTokenizer(messages, 'not-in-the-manifest'),
    ).toBeNull()

    const saved = process.env[TOKENIZER_DIR_ENV]
    try {
      delete process.env[TOKENIZER_DIR_ENV]
      resetTokenizerCache()
      expect(
        countMessagesWithTokenizer(messages, 'mini/hf-basic-large'),
      ).toBeNull()
    } finally {
      process.env[TOKENIZER_DIR_ENV] = saved
      resetTokenizerCache()
    }
  })
})

describe('countMessagesForThreshold', () => {
  test('prefers the exact count and never invokes the fallback', () => {
    let called = false
    const count = countMessagesForThreshold(
      [user('abc hello')],
      'mini/hf-basic-large',
      () => {
        called = true
        return 999
      },
    )
    expect(count).toBe(2)
    expect(called).toBe(false)
  })

  test('uses a numeric fallback when no tokenizer resolves', () => {
    expect(
      countMessagesForThreshold([user('hello')], 'not-in-the-manifest', 123),
    ).toBe(123)
  })

  test('evaluates a thunk fallback only when no tokenizer resolves', () => {
    let calls = 0
    const fallback = () => {
      calls += 1
      return 42
    }
    expect(
      countMessagesForThreshold(
        [user('hello')],
        'not-in-the-manifest',
        fallback,
      ),
    ).toBe(42)
    expect(calls).toBe(1)
  })

  test('empty message lists count as zero with a tokenizer', () => {
    expect(
      countMessagesForThreshold([], 'mini/hf-basic-large', 50),
    ).toBe(0)
  })
})
