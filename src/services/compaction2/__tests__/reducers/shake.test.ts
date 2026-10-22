import { describe, expect, test } from 'bun:test'
import type { Message } from '../../../../types/message.js'
import {
  AGGRESSIVE_SHAKE_CONFIG,
  applyShakeRegions,
  collectShakeRegions,
  DEFAULT_SHAKE_CONFIG,
  RESCUE_SHAKE_CONFIG,
  shakeMessages,
  type ShakeConfig,
  type ShakeRegion,
} from '../../reducers/shake.js'
import {
  isSkillReadToolResult,
  isToolResultPruned,
} from '../../reducers/toolProtection.js'

const countTokens = (text: string): number => Math.ceil(text.length / 4)

let uuidCounter = 0

function assistantText(text: string): Message {
  uuidCounter++
  return {
    type: 'assistant',
    uuid: `uuid-asst-${uuidCounter}`,
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  } as unknown as Message
}

function userText(text: string): Message {
  uuidCounter++
  return {
    type: 'user',
    uuid: `uuid-user-${uuidCounter}`,
    message: { role: 'user', content: text },
  } as unknown as Message
}

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

function config(overrides: Partial<ShakeConfig> = {}): ShakeConfig {
  return {
    protectTokens: 0,
    minSavings: 0,
    protectedTools: ['skill', isSkillReadToolResult],
    fenceMinTokens: 10,
    ...overrides,
  }
}

function textOfMessage(message: Message): string {
  const content = message.message?.content
  if (typeof content === 'string') return content
  return (content as unknown as Array<Record<string, unknown>>)
    .filter(block => block.type === 'text')
    .map(block => block.text as string)
    .join('\n')
}

describe('collectShakeRegions', () => {
  test('detects fenced code blocks', () => {
    const body = 'x'.repeat(2_000)
    const text = `before\n\`\`\`\n${body}\n\`\`\`\nafter`
    const regions = collectShakeRegions(
      [assistantText(text)],
      countTokens,
      config(),
    )
    expect(regions).toHaveLength(1)
    expect(regions[0].kind).toBe('block')
    expect(regions[0].originalText.startsWith('```')).toBe(true)
    expect(regions[0].originalText.endsWith('```')).toBe(true)
  })

  test('detects top-level XML blocks', () => {
    const text = `<file>\n${'y'.repeat(2_000)}\n</file>`
    const regions = collectShakeRegions([userText(text)], countTokens, config())
    expect(regions).toHaveLength(1)
    expect(regions[0].kind).toBe('block')
    expect(regions[0].originalText).toBe(text)
  })

  test('ignores unterminated fences and blocks below fenceMinTokens', () => {
    const unterminated = `before\n\`\`\`\n${'z'.repeat(2_000)}`
    expect(
      collectShakeRegions([assistantText(unterminated)], countTokens, config()),
    ).toHaveLength(0)

    const small = '```\ntiny\n```'
    expect(
      collectShakeRegions(
        [assistantText(small)],
        countTokens,
        config({ fenceMinTokens: 1_000 }),
      ),
    ).toHaveLength(0)
  })

  test('detects tool-result text regions', () => {
    const messages = [
      assistantToolUse('t1'),
      userToolResult('t1', 'r'.repeat(2_000)),
    ]
    const regions = collectShakeRegions(messages, countTokens, config())
    expect(regions).toHaveLength(1)
    expect(regions[0].kind).toBe('toolResult')
    if (regions[0].kind === 'toolResult') {
      expect(regions[0].label).toBe('Read')
      expect(regions[0].blockIndex).toBe(0)
    }
  })

  test('protects the recent tail', () => {
    const messages = [
      assistantToolUse('t1'),
      userToolResult('t1', 'r'.repeat(2_000)),
    ]
    const regions = collectShakeRegions(
      messages,
      countTokens,
      config({ protectTokens: 1_000_000 }),
    )
    expect(regions).toHaveLength(0)
  })

  test('protects skill reads', () => {
    const messages = [
      assistantToolUse('t1', 'Read', { file_path: 'skill://demo' }),
      userToolResult('t1', 'r'.repeat(2_000)),
    ]
    expect(collectShakeRegions(messages, countTokens, config())).toHaveLength(0)
  })

  test('artifact recovery reads: aggressive shakes, rescue protects', () => {
    const messages = [
      assistantToolUse('t1', 'Read', { file_path: 'artifact://x' }),
      userToolResult('t1', 'r'.repeat(2_000)),
    ]
    expect(
      collectShakeRegions(messages, countTokens, {
        ...AGGRESSIVE_SHAKE_CONFIG,
        protectTokens: 0,
      }),
    ).toHaveLength(1)
    expect(
      collectShakeRegions(messages, countTokens, RESCUE_SHAKE_CONFIG),
    ).toHaveLength(0)
  })

  test('returns no regions below minSavings', () => {
    const messages = [
      assistantToolUse('t1'),
      userToolResult('t1', 'r'.repeat(400)),
    ]
    expect(
      collectShakeRegions(
        messages,
        countTokens,
        config({ minSavings: 100_000 }),
      ),
    ).toHaveLength(0)
  })
})

describe('shakeMessages', () => {
  test('offloads a fence and splices the replacement', async () => {
    const body = 'x'.repeat(2_000)
    const text = `before\n\`\`\`\n${body}\n\`\`\`\nafter`
    const calls: ShakeRegion[] = []
    const result = await shakeMessages(
      [assistantText(text)],
      countTokens,
      config(),
      async region => {
        calls.push(region)
        return 'artifact://fence'
      },
    )
    expect(calls).toHaveLength(1)
    expect(result.regions).toHaveLength(1)
    const rewritten = textOfMessage(result.messages[0])
    expect(rewritten).toBe('before\nartifact://fence\nafter')
    expect(result.tokensSaved).toBe(
      calls[0].tokens - countTokens('artifact://fence'),
    )
  })

  test('replaces tool-result text and preserves images', async () => {
    const image = {
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'AAAA' },
    }
    const messages = [
      assistantToolUse('t1'),
      userToolResult('t1', [{ type: 'text', text: 'r'.repeat(2_000) }, image]),
    ]
    const result = await shakeMessages(
      messages,
      countTokens,
      config(),
      async () => 'artifact://tool',
    )
    const content = result.messages[1].message?.content as unknown as Array<
      Record<string, unknown>
    >
    const block = content[0]
    expect(block.type).toBe('tool_result')
    expect(isToolResultPruned(block)).toBe(true)
    // The marker must stay out of the wire payload.
    expect('pruned' in block).toBe(false)
    const inner = block.content as unknown as Array<Record<string, unknown>>
    expect(inner.some(item => item.type === 'image')).toBe(true)
    const text = inner.find(item => item.type === 'text')
    expect(text?.text).toBe('artifact://tool')
  })

  test('does not call offload when nothing is eligible', async () => {
    let called = 0
    const message = assistantText('short text')
    const result = await shakeMessages(
      [message],
      countTokens,
      DEFAULT_SHAKE_CONFIG,
      async () => {
        called++
        return 'artifact://never'
      },
    )
    expect(called).toBe(0)
    expect(result.regions).toHaveLength(0)
    expect(result.tokensSaved).toBe(0)
    expect(result.messages).toEqual([message])
  })

  test('is pure: inputs are not mutated', async () => {
    const text = `before\n\`\`\`\n${'x'.repeat(2_000)}\n\`\`\`\nafter`
    const messages = [assistantText(text)]
    await shakeMessages(
      messages,
      countTokens,
      config(),
      async () => 'artifact://x',
    )
    expect(textOfMessage(messages[0])).toBe(text)
  })

  test('applyShakeRegions handles multiple regions in one block', () => {
    const first = `\`\`\`\n${'a'.repeat(2_000)}\n\`\`\``
    const second = `\`\`\`\n${'b'.repeat(2_000)}\n\`\`\``
    const text = `${first}\nmiddle\n${second}`
    const messages = [assistantText(text)]
    const regions = collectShakeRegions(messages, countTokens, config())
    expect(regions).toHaveLength(2)
    const applied = applyShakeRegions(
      messages,
      regions.map((region, index) => ({
        region,
        replacement: `artifact://${index}`,
        replacementTokens: 3,
      })),
    )
    const rewritten = textOfMessage(applied[0])
    expect(rewritten).toBe('artifact://0\nmiddle\nartifact://1')
  })
})

describe('presets', () => {
  test('match the oh-my-pi policy values', () => {
    expect(DEFAULT_SHAKE_CONFIG.protectTokens).toBe(16_000)
    expect(DEFAULT_SHAKE_CONFIG.minSavings).toBe(4_000)
    expect(DEFAULT_SHAKE_CONFIG.fenceMinTokens).toBe(400)
    expect(AGGRESSIVE_SHAKE_CONFIG.protectTokens).toBe(4_000)
    expect(AGGRESSIVE_SHAKE_CONFIG.minSavings).toBe(0)
    expect(RESCUE_SHAKE_CONFIG.protectTokens).toBe(0)
    expect(RESCUE_SHAKE_CONFIG.protectedTools).toContain(
      DEFAULT_SHAKE_CONFIG.protectedTools[2],
    )
  })
})
