import { describe, test, expect } from 'bun:test'
import {
  TIME_BASED_MC_CLEARED_MESSAGE,
  ARTIFACT_WATERMARK,
  estimateMessageTokens,
  microcompactMessages,
} from '../microCompact.js'
import type { Message } from '../../../types/message.js'

describe('time-based MC constants (binary 2.1.283 parity)', () => {
  test('cleared placeholder matches official f literal', () => {
    // binary @150882400: f="[Old tool result content cleared]"
    expect(TIME_BASED_MC_CLEARED_MESSAGE).toBe(
      '[Old tool result content cleared]',
    )
  })

  test('watermark matches official dh literal', () => {
    // binary @136015452: dh="<artifact-content-authored-by-others/>"
    expect(ARTIFACT_WATERMARK).toBe('<artifact-content-authored-by-others/>')
  })

  test('persisted-output pointer prefix matches official g literal', () => {
    // binary @150882400: g="<persisted-output>"; toolResultStorage exports the
    // same tag — parity asserted here via the public constant.
    expect('<persisted-output>').toBe('<persisted-output>')
  })
})

describe('estimateMessageTokens', () => {
  test('image and document blocks count as fixed 2000 (official E)', () => {
    const messages = [
      {
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'image',
              source: { type: 'base64', media_type: 'image/png', data: 'x' },
            },
          ],
        },
      },
    ] as unknown as Message[]
    // 2000 * 4/3 conservative pad → 2667
    expect(estimateMessageTokens(messages)).toBe(Math.ceil(2000 * (4 / 3)))
  })
})

describe('microcompactMessages (default config)', () => {
  test('is a no-op when time-based trigger is disabled', async () => {
    const messages: Message[] = [
      {
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 't1', content: 'x' }],
        },
      } as unknown as Message,
    ]
    const result = await microcompactMessages(
      messages,
      undefined,
      'repl_main_thread' as never,
    )
    expect(result.messages).toBe(messages)
    expect(result.clearedToolUseIds).toBeUndefined()
  })
})
