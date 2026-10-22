import { describe, expect, test } from 'bun:test'
import type { Message } from '../../../../types/message.js'
import {
  DIM_OFF,
  DIM_ON,
  normalizeForFrame,
  serializeConversation,
  stripDimMarkers,
  truncateForSummary,
} from '../../methods/snapcompact/serializer.js'

function userMessage(content: unknown, uuid = 'u1'): Message {
  return {
    type: 'user',
    uuid,
    message: { role: 'user', content },
  } as unknown as Message
}

function assistantMessage(content: unknown, uuid = 'a1'): Message {
  return {
    type: 'assistant',
    uuid,
    message: { role: 'assistant', content },
  } as unknown as Message
}

describe('truncateForSummary', () => {
  test('keeps a 0.6 head and the tail', () => {
    const text = '0123456789'
    const out = truncateForSummary(text, 4, 0.6)
    expect(out).toContain('[…6ch elided…]')
    expect(out.startsWith('01')).toBe(true)
    expect(out.endsWith('9')).toBe(true)
  })

  test('leaves short text untouched', () => {
    expect(truncateForSummary('abc', 2000, 0.6)).toBe('abc')
  })
})

describe('serializeConversation', () => {
  test('merges a tool result into its call and truncates 2000/0.6', () => {
    const body = `${'H'.repeat(3000)}TAIL`
    const messages = [
      assistantMessage([
        {
          type: 'tool_use',
          id: 't1',
          name: 'Bash',
          input: { command: 'echo hi' },
        },
      ]),
      userMessage([{ type: 'tool_result', tool_use_id: 't1', content: body }]),
    ]

    const out = serializeConversation(messages)
    expect(out).toContain('¶call:')
    expect(out).toContain('Bash(')
    expect(out).toContain('command="echo hi"')
    expect(out).toContain('<out>')
    expect(out).toContain(DIM_ON)
    expect(out).toContain(DIM_OFF)
    expect(out).toContain('[…1004ch elided…]')
    expect(out).toContain('TAIL')
  })

  test('caps each argument value at 500 chars', () => {
    const messages = [
      assistantMessage([
        {
          type: 'tool_use',
          id: 't2',
          name: 'Write',
          input: { blob: 'x'.repeat(3000) },
        },
      ]),
    ]
    const out = serializeConversation(messages)
    expect(out).toContain('blob="')
    expect(out).toContain('[…2502ch elided…]')
  })

  test('caps the whole argument list at 2000 chars', () => {
    const messages = [
      assistantMessage([
        {
          type: 'tool_use',
          id: 't3',
          name: 'Multi',
          input: {
            a: 'a'.repeat(400),
            b: 'b'.repeat(400),
            c: 'c'.repeat(400),
            d: 'd'.repeat(400),
            e: 'e'.repeat(400),
          },
        },
      ]),
    ]
    const out = serializeConversation(messages)
    const line = out.slice(out.indexOf('Multi(') + 'Multi('.length)
    expect(line).toContain('ch elided')
  })

  test('renders orphan tool results standalone', () => {
    const messages = [
      userMessage([
        { type: 'tool_result', tool_use_id: 'orphan', content: 'lost call' },
      ]),
    ]
    const out = serializeConversation(messages)
    expect(out).toContain('¶call:')
    expect(out).toContain('lost call')
  })

  test('strips forged dim markers and renders images as text', () => {
    const messages = [
      userMessage([
        { type: 'text', text: `before${DIM_ON}forged${DIM_OFF}after` },
        { type: 'image', source: {} },
      ]),
    ]
    const out = serializeConversation(messages, { dimToolResults: false })
    expect(out).not.toContain(DIM_ON)
    expect(out).not.toContain(DIM_OFF)
    expect(out).toContain('[image]')
  })

  test('includes thinking unless disabled', () => {
    const messages = [
      assistantMessage([
        { type: 'thinking', thinking: 'secret plan' },
        { type: 'text', text: 'visible' },
      ]),
    ]
    expect(serializeConversation(messages)).toContain('¶think:')
    expect(
      serializeConversation(messages, { includeThinking: false }),
    ).not.toContain('secret plan')
  })
})

describe('normalizeForFrame', () => {
  test('folds newlines, whitespace and punctuation', () => {
    const out = normalizeForFrame('a\r\nb\tc  —  d ¶ 中文')
    expect(out).toContain('\u2588')
    expect(out).toContain('a\u2588b c - d #')
    expect(out).toContain('??')
  })

  test('keeps dim markers', () => {
    expect(normalizeForFrame(`${DIM_ON}x${DIM_OFF}`)).toBe(
      `${DIM_ON}x${DIM_OFF}`,
    )
  })

  test('stripDimMarkers removes both toggles', () => {
    expect(stripDimMarkers(`a${DIM_ON}b${DIM_OFF}`)).toBe('ab')
  })
})
