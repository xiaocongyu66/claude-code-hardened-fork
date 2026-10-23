import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Message } from '../../../../types/message.js'
import type { CompactionOutcome } from '../../contracts.js'
import {
  appendCompactionEntry,
  createCompactionSessionEntry,
  isCompactionSessionEntry,
} from '../../session/entries.js'
import { persistCompactionEntry } from '../../orchestrator.js'
import {
  flushSessionStorage,
  loadTranscriptFile,
  resetProjectForTesting,
  setSessionFileForTesting,
} from '../../../../utils/sessionStorage.js'

const message = {
  type: 'user',
  uuid: 'm1',
  message: { role: 'user', content: 'hello' },
} as unknown as Message

function softOutcome(
  overrides: Partial<Extract<CompactionOutcome, { kind: 'compacted' }>> = {},
): Extract<CompactionOutcome, { kind: 'compacted' }> {
  return {
    kind: 'compacted',
    method: 'soft',
    cutPoint: {
      firstKeptEntryId: 'm2',
      tokensBefore: 1000,
      boundaryMessage: {} as never,
    },
    tokensSaved: 500,
    headroomTokens: 100,
    summary: 'display summary',
    ...overrides,
  }
}

describe('appendCompactionEntry JSONL round-trip', () => {
  let tempDir: string
  let originalConfigDir: string | undefined
  let persistenceEnv: string | undefined

  beforeEach(() => {
    tempDir = join(
      tmpdir(),
      `cch-compaction-entry-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    )
    mkdirSync(tempDir, { recursive: true })
    originalConfigDir = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = tempDir
    persistenceEnv = process.env.TEST_ENABLE_SESSION_PERSISTENCE
    process.env.TEST_ENABLE_SESSION_PERSISTENCE = '1'
    resetProjectForTesting()
  })

  afterEach(() => {
    if (originalConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR
    } else {
      process.env.CLAUDE_CONFIG_DIR = originalConfigDir
    }
    if (persistenceEnv === undefined) {
      delete process.env.TEST_ENABLE_SESSION_PERSISTENCE
    } else {
      process.env.TEST_ENABLE_SESSION_PERSISTENCE = persistenceEnv
    }
    resetProjectForTesting()
    if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true })
  })

  test('writes exactly one compaction row through the session write queue', async () => {
    const file = join(tempDir, 'session.jsonl')
    writeFileSync(file, '')
    setSessionFileForTesting(file)

    const entry = createCompactionSessionEntry({
      uuid: 'entry-1' as never,
      summary: 'summary text',
      firstKeptEntryId: 'm2',
      tokensBefore: 1000,
      method: 'soft',
      preserveData: { archive: { frames: 1 } },
      timestamp: '2026-01-01T00:00:00.000Z',
    })
    await appendCompactionEntry(entry)
    await flushSessionStorage()

    const lines = readFileSync(file, 'utf8')
      .split('\n')
      .filter(line => line.trim().length > 0)
    expect(lines).toHaveLength(1)

    const parsed: unknown = JSON.parse(lines[0]!)
    expect(isCompactionSessionEntry(parsed)).toBe(true)
    expect(parsed).toMatchObject({
      type: 'compaction',
      uuid: 'entry-1',
      summary: 'summary text',
      firstKeptEntryId: 'm2',
      tokensBefore: 1000,
      method: 'soft',
      timestamp: '2026-01-01T00:00:00.000Z',
    })
  })

  test('new reader collects the row without treating it as a message', async () => {
    const file = join(tempDir, 'session.jsonl')
    writeFileSync(
      file,
      [
        JSON.stringify({
          type: 'user',
          uuid: 'u1',
          message: { role: 'user', content: 'hi' },
        }),
        JSON.stringify({
          type: 'compaction',
          uuid: 'c1',
          summary: 's',
          firstKeptEntryId: 'u1',
          tokensBefore: 10,
          method: 'soft',
          timestamp: '2026-01-01T00:00:00.000Z',
        }),
      ].join('\n') + '\n',
    )

    const loaded = await loadTranscriptFile(file)
    expect(loaded.messages.size).toBe(1)
    expect(loaded.messages.has('u1' as never)).toBe(true)
    expect(loaded.compactionEntries).toHaveLength(1)
    expect(String(loaded.compactionEntries[0]!.uuid)).toBe('c1')
  })
})

describe('persistCompactionEntry', () => {
  test('flag off writes nothing', async () => {
    const appended: unknown[] = []
    const result = await persistCompactionEntry(softOutcome(), [message], {
      enabled: false,
      append: async entry => {
        appended.push(entry)
      },
    })
    expect(result).toBeNull()
    expect(appended).toHaveLength(0)
  })

  test('soft journals the legacy summary text and strips the legacy result', async () => {
    const appended: unknown[] = []
    const outcome = softOutcome({
      preserveData: {
        legacyCompactionResult: {
          boundaryMarker: {},
          summaryMessages: [{ message: { content: 'wrapped legacy summary' } }],
          messagesToKeep: [message],
        },
        archive: { frames: 2 },
      },
    })

    const entry = await persistCompactionEntry(outcome, [message], {
      append: async e => {
        appended.push(e)
      },
      uuid: () => 'fixed-entry' as never,
      now: () => Date.parse('2026-02-02T00:00:00.000Z'),
    })

    expect(appended).toHaveLength(1)
    expect(entry).toMatchObject({
      type: 'compaction',
      uuid: 'fixed-entry',
      summary: 'wrapped legacy summary',
      firstKeptEntryId: 'm2',
      tokensBefore: 1000,
      method: 'soft',
      timestamp: '2026-02-02T00:00:00.000Z',
    })
    expect(entry!.preserveData).toEqual({ archive: { frames: 2 } })
  })

  test('remote without a summary is not journaled', async () => {
    const appended: unknown[] = []
    const result = await persistCompactionEntry(
      softOutcome({ method: 'remote', summary: undefined }),
      [message],
      { append: async e => void appended.push(e) },
    )
    expect(result).toBeNull()
    expect(appended).toHaveLength(0)
  })

  test('remote with a summary is journaled', async () => {
    const appended: unknown[] = []
    const result = await persistCompactionEntry(
      softOutcome({ method: 'remote', summary: 'remote summary' }),
      [message],
      { append: async e => void appended.push(e) },
    )
    expect(result?.method).toBe('remote')
    expect(result?.summary).toBe('remote summary')
  })

  test('non-compacted outcomes are ignored', async () => {
    const result = await persistCompactionEntry(
      { kind: 'skipped', method: 'soft', reason: 'nope' },
      [message],
      { append: async () => {} },
    )
    expect(result).toBeNull()
  })

  test('journals bounded attachment metadata and strips snapcompact frames', async () => {
    const fileAttachment = {
      type: 'attachment',
      uuid: 'att-1',
      attachment: {
        type: 'file',
        filename: '/repo/src/a.ts',
        content: {
          type: 'text',
          file: { content: 'x'.repeat(20_000) },
        },
      },
    } as unknown as Message
    const hookResult = {
      type: 'attachment',
      uuid: 'hook-1',
      attachment: {
        type: 'hook_additional_context',
        content: ['remember this'],
        hookName: 'SessionStart',
        toolUseID: 'SessionStart',
      },
    } as unknown as Message
    const frames = [
      {
        data: 'A'.repeat(200_000),
        mimeType: 'image/png',
        cols: 1,
        rows: 1,
        chars: 1,
      },
    ]
    const outcome = softOutcome({
      preserveData: {
        legacyCompactionResult: {
          boundaryMarker: {},
          summaryMessages: [{ message: { content: 'summary text' } }],
          attachments: [fileAttachment],
          hookResults: [hookResult],
        },
        snapcompact: {
          mode: 'image',
          text: 'archived text',
          summary: 'snap summary',
          frames,
        },
      },
    })

    const entry = await persistCompactionEntry(outcome, [message], {
      append: async () => {},
    })

    expect(entry).not.toBeNull()
    expect(entry!.attachments).toEqual([
      { type: 'file', path: '/repo/src/a.ts' },
    ])
    expect(entry!.hookResults).toEqual([
      {
        type: 'hook_additional_context',
        name: 'SessionStart',
        text: 'remember this',
        toolUseId: 'SessionStart',
      },
    ])

    const archive = entry!.preserveData!.snapcompact as Record<string, unknown>
    expect(archive.frames).toBeUndefined()
    expect(archive.frameCount).toBe(1)
    expect(archive.text).toBe('archived text')
    expect(archive.mode).toBe('image')

    // The journal row must not carry the frame base64 or the legacy result.
    const serialized = JSON.stringify(entry)
    expect(serialized).not.toContain('AAAA')
    expect(serialized).not.toContain('legacyCompactionResult')
    expect(Buffer.byteLength(serialized, 'utf8')).toBeLessThan(64 * 1024)
  })

  test('truncates oversized text and caps the combined attachment budget', async () => {
    const hugeHook = {
      type: 'attachment',
      uuid: 'huge',
      attachment: {
        type: 'hook_additional_context',
        content: ['x'.repeat(20_000)],
        hookName: 'Huge',
      },
    } as unknown as Message
    const many = Array.from(
      { length: 20 },
      (_, index) =>
        ({
          type: 'attachment',
          uuid: `att-${index}`,
          attachment: {
            type: 'critical_system_reminder',
            content: 'y'.repeat(4_000),
          },
        }) as unknown as Message,
    )

    const entry = await persistCompactionEntry(
      softOutcome({
        preserveData: {
          legacyCompactionResult: {
            boundaryMarker: {},
            summaryMessages: [{ message: { content: 'summary' } }],
            attachments: many,
            hookResults: [hugeHook],
          },
        },
      }),
      [message],
      { append: async () => {} },
    )

    expect(entry).not.toBeNull()
    const first = entry!.attachments![0]!
    expect(Buffer.byteLength(first.text ?? '', 'utf8')).toBeLessThanOrEqual(
      4 * 1024,
    )

    const combined = JSON.stringify([
      ...(entry!.attachments ?? []),
      ...(entry!.hookResults ?? []),
    ])
    expect(Buffer.byteLength(combined, 'utf8')).toBeLessThanOrEqual(32 * 1024)
  })
})

describe('legacy transcript compatibility', () => {
  test('files without compaction rows load with an empty entry list', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cch-legacy-transcript-'))
    try {
      const file = join(dir, 'legacy.jsonl')
      writeFileSync(
        file,
        [
          JSON.stringify({
            type: 'user',
            uuid: 'u1',
            message: { role: 'user', content: 'hi' },
          }),
          JSON.stringify({ type: 'future-unknown', uuid: 'x1', payload: 42 }),
          JSON.stringify({
            type: 'assistant',
            uuid: 'a1',
            message: { role: 'assistant', content: 'yo' },
          }),
        ].join('\n') + '\n',
      )
      const loaded = await loadTranscriptFile(file)
      expect(loaded.messages.size).toBe(2)
      expect(loaded.compactionEntries).toHaveLength(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
