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
      frames: { data: string }[]
      text: string
      family: string
      summary: string
    }
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
})
