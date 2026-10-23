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
