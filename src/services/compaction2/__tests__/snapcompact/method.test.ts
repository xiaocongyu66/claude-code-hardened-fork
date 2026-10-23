import { describe, expect, test } from 'bun:test'
import type { Message } from '../../../../types/message.js'
import {
  DEFAULT_COMPACTION_SETTINGS,
  type CompactionContext,
} from '../../contracts.js'
import { TEST_FONT_5X7 } from '../../methods/snapcompact/font.js'
import {
  SNAPCOMPACT_PRESERVE_KEY,
  createSnapcompactMethod,
} from '../../methods/snapcompact/index.js'

function userMessage(index: number, text: string): Message {
  return {
    type: 'user',
    uuid: `u${index}`,
    message: { role: 'user', content: text },
  } as unknown as Message
}

function ctx(overrides: Partial<CompactionContext> = {}): CompactionContext {
  return {
    model: 'test-model',
    trigger: 'threshold',
    messages: [userMessage(0, 'hello')],
    settings: DEFAULT_COMPACTION_SETTINGS,
    tokenCount: messages => messages.length * 10_000,
    estimateEntryTokens: () => 0,
    now: () => 0,
    ...overrides,
  }
}

function messages(count: number, size = 600): Message[] {
  return Array.from({ length: count }, (_, index) =>
    userMessage(index, `${index}: ${'w'.repeat(size)}`),
  )
}

const enabledEnv = { CCH_SNAPCOMPACT_ENABLE: '1' }

describe('snapcompact gating', () => {
  test('is unavailable by default', () => {
    const method = createSnapcompactMethod()
    expect(method.isAvailable(ctx())).toBe(false)
  })

  test('requires the enable flag', () => {
    const method = createSnapcompactMethod({
      env: {},
      declaresImageInput: true,
      providerFamily: 'anthropic',
    })
    expect(method.isAvailable(ctx())).toBe(false)
  })

  test('requires an explicit image-input declaration', () => {
    const method = createSnapcompactMethod({
      env: enabledEnv,
      providerFamily: 'anthropic',
    })
    expect(method.isAvailable(ctx())).toBe(false)
  })

  test('requires an explicit provider family', () => {
    const method = createSnapcompactMethod({
      env: enabledEnv,
      declaresImageInput: true,
    })
    expect(method.isAvailable(ctx())).toBe(false)
  })

  test('is available when all three conditions hold', () => {
    const method = createSnapcompactMethod({
      env: enabledEnv,
      declaresImageInput: true,
      providerFamily: 'anthropic',
    })
    expect(method.isAvailable(ctx())).toBe(true)
  })
})

describe('snapcompact run', () => {
  const method = createSnapcompactMethod({
    env: enabledEnv,
    declaresImageInput: true,
    providerFamily: 'anthropic',
    shape: '5x8-bw',
    frameSize: 100,
    maxFrames: 2,
    dataBudgetBytes: 1_000_000_000,
    font: TEST_FONT_5X7,
    summary: 'resume from archive',
  })

  test('archives the discarded prefix and keeps the recent suffix', async () => {
    const all = messages(12)
    const context = ctx({
      messages: all,
      settings: { ...DEFAULT_COMPACTION_SETTINGS, keepRecentTokens: 20_000 },
    })
    const outcome = await method.run(context)
    expect(outcome.kind).toBe('compacted')
    if (outcome.kind !== 'compacted') return
    expect(outcome.method).toBe('snapcompact')
    expect(outcome.tokensSaved).toBeGreaterThan(0)
    expect(outcome.cutPoint.firstKeptEntryId).toBe('u10')
    const archive = outcome.preserveData?.[SNAPCOMPACT_PRESERVE_KEY] as {
      mode: string
      frames: { data: string }[]
      text: string
      family: string
      summary: string
    }
    expect(archive.mode).toBe('image')
    expect(archive.family).toBe('anthropic')
    expect(archive.summary).toBe('resume from archive')
    expect(archive.frames.length).toBeGreaterThan(0)
    expect(archive.frames.length).toBeLessThanOrEqual(2)
    expect(archive.text.length).toBeGreaterThan(0)
    for (const frame of archive.frames) {
      expect(frame.data.length).toBeGreaterThan(0)
    }
  })

  test('skips when disabled', async () => {
    const disabled = createSnapcompactMethod({
      env: {},
      declaresImageInput: true,
      providerFamily: 'anthropic',
    })
    const outcome = await disabled.run(ctx({ messages: messages(4) }))
    expect(outcome).toEqual({
      kind: 'skipped',
      method: 'snapcompact',
      reason: 'snapcompact-disabled',
    })
  })

  test('skips when there is nothing to archive', async () => {
    const context = ctx({
      messages: messages(2),
      settings: { ...DEFAULT_COMPACTION_SETTINGS, keepRecentTokens: 1_000_000 },
    })
    const outcome = await method.run(context)
    expect(outcome.kind).toBe('skipped')
    if (outcome.kind !== 'skipped') return
    expect(outcome.reason).toBe('snapcompact-nothing-to-archive')
  })

  test('falls back to a text archive for mostly non-ASCII history', async () => {
    const cjk = Array.from({ length: 4 }, (_, index) =>
      userMessage(index, `${index}: ${'汉'.repeat(600)}`),
    )
    const outcome = await method.run(ctx({ messages: cjk }))
    expect(outcome.kind).toBe('compacted')
    if (outcome.kind !== 'compacted') return
    expect(outcome.method).toBe('snapcompact')
    expect(outcome.tokensSaved).toBeGreaterThan(0)
    expect(outcome.cutPoint.firstKeptEntryId).toBe('u2')
    expect(outcome.summary).toContain('text mode')

    const archive = outcome.preserveData?.[SNAPCOMPACT_PRESERVE_KEY] as {
      mode: string
      text: string
      textHead: string
      textTail: string
      summary: string
      totalChars: number
      truncatedChars: number
      frames?: unknown
    }
    expect(archive.mode).toBe('text')
    expect('frames' in archive).toBe(false)
    expect(archive.summary).toContain('text mode')
    expect(archive.text).toContain('汉')
    expect(archive.textHead.length).toBeGreaterThan(0)
    expect(archive.textTail.length).toBeGreaterThan(0)
    expect(archive.text).toBe(archive.textHead + archive.textTail)
    expect(archive.totalChars).toBe(archive.text.length)
    expect(archive.truncatedChars).toBeGreaterThan(0)
  })

  test('elides the middle of a text archive under a token budget', async () => {
    const budgeted = createSnapcompactMethod({
      env: enabledEnv,
      declaresImageInput: true,
      providerFamily: 'anthropic',
      tokenBudget: 500,
    })
    const cjk = Array.from({ length: 10 }, (_, index) =>
      userMessage(index, `${index}: ${'汉'.repeat(600)}`),
    )
    const outcome = await budgeted.run(ctx({ messages: cjk }))
    expect(outcome.kind).toBe('compacted')
    if (outcome.kind !== 'compacted') return
    expect(outcome.tokensSaved).toBeGreaterThan(0)

    const archive = outcome.preserveData?.[SNAPCOMPACT_PRESERVE_KEY] as {
      mode: string
      text: string
      textHead: string
      textTail: string
      truncatedChars: number
    }
    expect(archive.mode).toBe('text')
    expect(archive.truncatedChars).toBeGreaterThan(0)
    expect(archive.textHead.length).toBeGreaterThan(0)
    expect(archive.textTail.length).toBeGreaterThan(0)
    expect(archive.text).toBe(archive.textHead + archive.textTail)
    expect(archive.text.length).toBeLessThanOrEqual(2_000)
  })

  // Three archived user messages merge into one `¶user:` scope, so a body of
  // A ASCII chars + 3 CJK chars serializes as 10 non-ASCII chars in 8 + 3B.
  function mixedMessages(body: string): Message[] {
    return [
      userMessage(0, body),
      userMessage(1, body),
      userMessage(2, body),
      userMessage(3, 'kept'),
      userMessage(4, 'kept'),
    ]
  }

  test('keeps the image path at exactly 5% non-ASCII', async () => {
    const body = `${'a'.repeat(61)}${'汉'.repeat(3)}`
    const outcome = await method.run(ctx({ messages: mixedMessages(body) }))
    expect(outcome.kind).toBe('compacted')
    if (outcome.kind !== 'compacted') return
    const archive = outcome.preserveData?.[SNAPCOMPACT_PRESERVE_KEY] as {
      mode: string
    }
    expect(archive.mode).toBe('image')
  })

  test('switches to text mode just above 5% non-ASCII', async () => {
    const body = `${'a'.repeat(60)}${'汉'.repeat(3)}`
    const outcome = await method.run(ctx({ messages: mixedMessages(body) }))
    expect(outcome.kind).toBe('compacted')
    if (outcome.kind !== 'compacted') return
    const archive = outcome.preserveData?.[SNAPCOMPACT_PRESERVE_KEY] as {
      mode: string
    }
    expect(archive.mode).toBe('text')
  })

  test('keeps the image path just below 5% non-ASCII', async () => {
    const body = `${'a'.repeat(62)}${'汉'.repeat(3)}`
    const outcome = await method.run(ctx({ messages: mixedMessages(body) }))
    expect(outcome.kind).toBe('compacted')
    if (outcome.kind !== 'compacted') return
    const archive = outcome.preserveData?.[SNAPCOMPACT_PRESERVE_KEY] as {
      mode: string
    }
    expect(archive.mode).toBe('image')
  })

  test('skips an empty archive', async () => {
    const empty = Array.from({ length: 4 }, (_, index) =>
      userMessage(index, ''),
    )
    const outcome = await method.run(ctx({ messages: empty }))
    expect(outcome.kind).toBe('skipped')
    if (outcome.kind !== 'skipped') return
    expect(outcome.reason).toBe('snapcompact-empty-archive')
  })

  test('skips a non-ASCII archive that saves no tokens', async () => {
    const cjk = Array.from({ length: 4 }, (_, index) =>
      userMessage(index, `${index}: ${'汉'.repeat(600)}`),
    )
    const outcome = await method.run(
      ctx({
        messages: cjk,
        settings: { ...DEFAULT_COMPACTION_SETTINGS, keepRecentTokens: 0 },
        tokenCount: entries => entries.length * 10,
      }),
    )
    expect(outcome.kind).toBe('skipped')
    if (outcome.kind !== 'skipped') return
    expect(outcome.reason).toBe('snapcompact-no-savings')
  })
})
