import { describe, expect, test } from 'bun:test'
import type { Message } from '../../../../types/message.js'
import {
  DEFAULT_PRUNE_CONFIG,
  MIN_PRUNE_TOKENS,
  pruneToolOutputs,
  readToolSupersedeKey,
  SUPERSEDED_NOTICE,
  USELESS_NOTICE,
  type PruneConfig,
} from '../../reducers/prune.js'
import { isSkillReadToolResult } from '../../reducers/toolProtection.js'

// len/4 estimator: deterministic and dependency-free.
const countTokens = (text: string): number => Math.ceil(text.length / 4)

let uuidCounter = 0

function assistantToolUse(
  id: string,
  name = 'Read',
  input: Record<string, unknown> = { file_path: '/tmp/a.ts' },
): Message {
  uuidCounter++
  return {
    type: 'assistant',
    uuid: `uuid-asst-${uuidCounter}`,
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', id, name, input }],
    },
  } as unknown as Message
}

function userToolResult(
  id: string,
  content: string | Array<Record<string, unknown>>,
  extra: Record<string, unknown> = {},
): Message {
  uuidCounter++
  return {
    type: 'user',
    uuid: `uuid-user-${uuidCounter}`,
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: id, content, ...extra }],
    },
  } as unknown as Message
}

function blocks(message: Message): Array<Record<string, unknown>> {
  return message.message?.content as unknown as Array<Record<string, unknown>>
}

function resultBlock(message: Message): Record<string, unknown> {
  return blocks(message)[0]
}

function textOf(block: Record<string, unknown>): string {
  const content = block.content
  if (typeof content === 'string') return content
  const parts = (content as unknown as Array<Record<string, unknown>>)
    .filter(item => item.type === 'text')
    .map(item => item.text as string)
  return parts.join('\n')
}

function config(overrides: Partial<PruneConfig> = {}): PruneConfig {
  return {
    ...DEFAULT_PRUNE_CONFIG,
    minimumSavings: 0,
    ...overrides,
  }
}

describe('pruneToolOutputs', () => {
  test('protects the newest tool-output tokens', () => {
    const text = 'a'.repeat(4_000) // ~1000 tokens, inside the 40k window
    const messages = [assistantToolUse('t1'), userToolResult('t1', text)]
    const result = pruneToolOutputs(messages, countTokens)
    expect(result.prunedCount).toBe(0)
    expect(result.tokensSaved).toBe(0)
    expect(textOf(resultBlock(result.messages[1]))).toBe(text)
  })

  test('requires minimum total savings', () => {
    const text = 'a'.repeat(4_000) // ~1000 tokens < 20k minimum
    const messages = [assistantToolUse('t1'), userToolResult('t1', text)]
    const result = pruneToolOutputs(
      messages,
      countTokens,
      config({ protectTokens: 0, minimumSavings: 20_000 }),
    )
    expect(result.prunedCount).toBe(0)
    expect(textOf(resultBlock(result.messages[1]))).toBe(text)
  })

  test('writes the exact truncated placeholder', () => {
    const text = 'a'.repeat(4_000)
    const tokens = countTokens(text)
    const messages = [assistantToolUse('t1'), userToolResult('t1', text)]
    const result = pruneToolOutputs(
      messages,
      countTokens,
      config({ protectTokens: 0 }),
    )
    expect(result.prunedCount).toBe(1)
    expect(textOf(resultBlock(result.messages[1]))).toBe(
      `[Output truncated - ${tokens} tokens]`,
    )
    expect(result.tokensSaved).toBe(
      tokens - countTokens(`[Output truncated - ${tokens} tokens]`),
    )
  })

  test('does not prune sub-floor results', () => {
    const text = 'a'.repeat((MIN_PRUNE_TOKENS - 1) * 4)
    const messages = [assistantToolUse('t1'), userToolResult('t1', text)]
    const result = pruneToolOutputs(
      messages,
      countTokens,
      config({ protectTokens: 0 }),
    )
    expect(result.prunedCount).toBe(0)
  })

  test('superseded reads are replaced by the superseded notice', () => {
    const oldText = 'o'.repeat(4_000)
    const newText = 'n'.repeat(4_000)
    const messages = [
      assistantToolUse('t1', 'Read', { file_path: '/tmp/a.ts' }),
      userToolResult('t1', oldText),
      assistantToolUse('t2', 'Read', { file_path: '/tmp/a.ts' }),
      userToolResult('t2', newText),
    ]
    const result = pruneToolOutputs(
      messages,
      countTokens,
      config({
        // Huge protect window: only supersession can prune.
        protectTokens: 1_000_000,
        supersedeKey: readToolSupersedeKey,
      }),
    )
    expect(result.prunedCount).toBe(1)
    expect(textOf(resultBlock(result.messages[1]))).toBe(SUPERSEDED_NOTICE)
    expect(textOf(resultBlock(result.messages[3]))).toBe(newText)
  })

  test('a later read of a different path does not supersede', () => {
    const oldText = 'o'.repeat(4_000)
    const messages = [
      assistantToolUse('t1', 'Read', { file_path: '/tmp/a.ts' }),
      userToolResult('t1', oldText),
      assistantToolUse('t2', 'Read', { file_path: '/tmp/b.ts' }),
      userToolResult('t2', 'n'.repeat(4_000)),
    ]
    const result = pruneToolOutputs(
      messages,
      countTokens,
      config({
        protectTokens: 1_000_000,
        supersedeKey: readToolSupersedeKey,
      }),
    )
    expect(result.prunedCount).toBe(0)
    expect(textOf(resultBlock(result.messages[1]))).toBe(oldText)
  })

  test('useless-flagged results bypass the protect window', () => {
    const text = 'u'.repeat(4_000)
    const messages = [
      assistantToolUse('t1', 'Grep'),
      userToolResult('t1', text, { useless: true }),
    ]
    const result = pruneToolOutputs(
      messages,
      countTokens,
      config({ protectTokens: 1_000_000 }),
    )
    expect(result.prunedCount).toBe(1)
    expect(textOf(resultBlock(result.messages[1]))).toBe(USELESS_NOTICE)
  })

  test('preserves non-text blocks such as images', () => {
    const image = {
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'AAAA' },
    }
    const messages = [
      assistantToolUse('t1'),
      userToolResult('t1', [{ type: 'text', text: 'a'.repeat(4_000) }, image]),
    ]
    const result = pruneToolOutputs(
      messages,
      countTokens,
      config({ protectTokens: 0 }),
    )
    const content = resultBlock(result.messages[1]).content as unknown as Array<
      Record<string, unknown>
    >
    expect(content.some(block => block.type === 'image')).toBe(true)
    expect(
      content.some(
        block =>
          block.type === 'text' &&
          typeof block.text === 'string' &&
          block.text.startsWith('[Output truncated - '),
      ),
    ).toBe(true)
  })

  test('never changes uuids or message order', () => {
    const messages = [
      assistantToolUse('t1'),
      userToolResult('t1', 'a'.repeat(4_000)),
      {
        type: 'system',
        uuid: 'sys-1',
        message: { content: 'x' },
      } as unknown as Message,
    ]
    const before = messages.map(message => message.uuid)
    const result = pruneToolOutputs(
      messages,
      countTokens,
      config({ protectTokens: 0 }),
    )
    expect(result.messages.map(message => message.uuid)).toEqual(before)
    expect(result.messages).toHaveLength(messages.length)
  })

  test('warm-cache suffix guard leaves deeper results alone', () => {
    const messages = [
      assistantToolUse('t1'),
      userToolResult('t1', 'a'.repeat(4_000)),
      assistantToolUse('t2'),
      userToolResult('t2', 'b'.repeat(4_000)),
    ]
    const result = pruneToolOutputs(
      messages,
      countTokens,
      config({ protectTokens: 0, cacheWarmSuffixTokens: 10 }),
    )
    // Only the newest result sits inside the warm tail.
    expect(result.prunedCount).toBe(1)
    expect(result.pruned[0].toolUseId).toBe('t2')
    expect(textOf(resultBlock(result.messages[1]))).toBe('a'.repeat(4_000))
  })

  test('is a pure function (inputs untouched)', () => {
    const text = 'a'.repeat(4_000)
    const messages = [assistantToolUse('t1'), userToolResult('t1', text)]
    pruneToolOutputs(messages, countTokens, config({ protectTokens: 0 }))
    expect(textOf(resultBlock(messages[1]))).toBe(text)
  })
})

describe('readToolSupersedeKey', () => {
  test('keys reads by path and accepts both path spellings', () => {
    expect(readToolSupersedeKey('Read', { file_path: '/tmp/a.ts' })).toBe(
      '/tmp/a.ts',
    )
    expect(readToolSupersedeKey('read', { path: '/tmp/a.ts' })).toBe(
      '/tmp/a.ts',
    )
  })

  test('exempts non-read tools and URL-scheme paths', () => {
    expect(readToolSupersedeKey('Bash', { file_path: '/tmp/a.ts' })).toBe(
      undefined,
    )
    expect(readToolSupersedeKey('Read', { file_path: 'skill://x' })).toBe(
      undefined,
    )
  })
})

describe('default config', () => {
  test('matches the oh-my-pi policy values', () => {
    expect(DEFAULT_PRUNE_CONFIG.protectTokens).toBe(40_000)
    expect(DEFAULT_PRUNE_CONFIG.minimumSavings).toBe(20_000)
    expect(DEFAULT_PRUNE_CONFIG.protectedTools).toContain('skill')
    expect(DEFAULT_PRUNE_CONFIG.protectedTools).toContain(isSkillReadToolResult)
    expect(DEFAULT_PRUNE_CONFIG.supersedeKey).toBe(readToolSupersedeKey)
  })
})
