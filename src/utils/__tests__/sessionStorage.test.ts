import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import * as fsPromises from 'node:fs/promises'
import { getFsImplementation } from '../fsOperations.js'
import { getSessionId } from '../../bootstrap/state.js'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { open } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const MAX_CACHED_ENTRIES = 200 // mirrors MAX_CACHED_SESSION_FILES in sessionStorage.ts

const {
  getSessionMessages,
  getSessionMessagesCache,
  clearSessionMessagesCache,
  setSessionFileForTesting,
  removeTranscriptMessage,
  recordTranscript,
  flushSessionStorage,
  resetProjectForTesting,
} = await import('../sessionStorage.js')

function asUuid(s: string): any {
  return s as unknown as any
}

let tempDir: string
let originalConfigDir: string | undefined

beforeEach(() => {
  tempDir = join(
    tmpdir(),
    `claude-session-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  )
  mkdirSync(tempDir, { recursive: true })
  // `getProjectsDir()` returns `${CLAUDE_CONFIG_DIR}/projects`, and
  // loadSessionFile reads from `${getProjectsDir()}/${sessionId}.jsonl`.
  // Pre-create the projects subdir so writeFileSync doesn't fail.
  mkdirSync(join(tempDir, 'projects'), { recursive: true })
  // Pin session-file lookups to a temp dir via CLAUDE_CONFIG_DIR.
  // Restoring in afterEach keeps tests hermetic.
  originalConfigDir = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = tempDir
})

afterEach(() => {
  clearSessionMessagesCache()
  if (originalConfigDir === undefined) {
    delete process.env.CLAUDE_CONFIG_DIR
  } else {
    process.env.CLAUDE_CONFIG_DIR = originalConfigDir
  }
  if (tempDir && existsSync(tempDir)) {
    rmSync(tempDir, { recursive: true, force: true })
  }
})

function sessionFilePath(sessionId: string): string {
  // Mirror sessionStorage.ts's path computation:
  //   getSessionProjectDir() ?? getProjectDir(getOriginalCwd())
  // With CLAUDE_CONFIG_DIR=tempDir and getSessionProjectDir() returning
  // null in tests, files live at `${tempDir}/projects/${sessionId}.jsonl`.
  return join(tempDir, 'projects', `${sessionId}.jsonl`)
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(r => {
    resolve = r
  })
  return { promise, resolve }
}

describe('writer lifecycle', () => {
  let writer: any
  let file: string
  beforeEach(() => {
    resetProjectForTesting()
    file = sessionFilePath('writer')
    writeFileSync(file, '')
    writer = setSessionFileForTesting(file)
    writer.FLUSH_INTERVAL_MS = 1
  })
  afterEach(() => {
    writer._resetFlushState()
    resetProjectForTesting()
  })

  test('a second timer and flush cannot overtake a blocked append', async () => {
    const entered = deferred()
    const release = deferred()
    let calls = 0
    writer.appendToFile = async () => {
      calls++
      if (calls === 1) {
        entered.resolve()
        await release.promise
      }
    }
    const first = writer.enqueueWrite(file, { type: 'summary', summary: 'one' })
    await entered.promise
    const second = writer.enqueueWrite(file, {
      type: 'summary',
      summary: 'two',
    })
    await new Promise(r => setTimeout(r, 15))
    let flushed = false
    const flushing = writer.flush().then(() => {
      flushed = true
    })
    await new Promise(r => setTimeout(r, 15))
    const observed = { calls, flushed }
    release.resolve()
    await Promise.all([first, second, flushing])
    expect(observed).toEqual({ calls: 1, flushed: false })
  })

  test('failed append rejects every waiter and remains sticky without retry', async () => {
    const error = new Error('ENOSPC: partial append')
    let calls = 0
    writer.appendToFile = async (_: string, data: string) => {
      calls++
      // Model appendFile failing after the OS has accepted a prefix.
      writeFileSync(file, data.slice(0, 5))
      throw error
    }
    const a = writer
      .enqueueWrite(file, { type: 'summary' })
      .catch((e: unknown) => e)
    const b = writer
      .enqueueWrite(file, { type: 'summary' })
      .catch((e: unknown) => e)
    await expect(writer.flush()).rejects.toThrow('ENOSPC')
    const settled = await Promise.race([
      Promise.all([a, b]),
      new Promise(r => setTimeout(() => r('unsettled'), 30)),
    ])
    expect(settled).toEqual([error, error])
    await expect(writer.flush()).rejects.toThrow('ENOSPC')
    await expect(
      writer.enqueueWrite(file, { type: 'summary' }),
    ).rejects.toThrow('ENOSPC')
    expect(calls).toBe(1)
    expect(readFileSync(file, 'utf8')).toBe('{"typ')
    expect(writer.getWriteBufferStats()).toEqual({
      queuedBytes: 0,
      inflightBytes: 0,
    })
  })

  test('real appendToFile never retries a partially written ENOSPC batch', async () => {
    const error = Object.assign(new Error('partial ENOSPC'), { code: 'ENOSPC' })
    const original = fsPromises.appendFile
    let calls = 0
    const append = spyOn(fsPromises, 'appendFile').mockImplementation(
      async (path, data, options) => {
        calls++
        if (calls === 1) {
          await original(path, String(data).slice(0, 4), options)
          throw error
        }
        return original(path, data, options)
      },
    )
    try {
      const write = writer
        .enqueueWrite(file, { uuid: 'partial' })
        .catch((e: unknown) => e)
      await expect(writer.flush()).rejects.toBe(error)
      expect(await write).toBe(error)
      await expect(writer.flush()).rejects.toBe(error)
      expect(calls).toBe(1)
      expect(readFileSync(file, 'utf8')).toBe('{"uu')
    } finally {
      append.mockRestore()
    }
  })

  test('shutdown seals and retains a partial metadata append failure', async () => {
    const fs = getFsImplementation()
    const original = fs.appendFileSync.bind(fs)
    const error = Object.assign(new Error('metadata ENOSPC'), {
      code: 'ENOSPC',
    })
    let calls = 0
    writer.currentSessionTitle = 'metadata'
    const append = spyOn(fs, 'appendFileSync').mockImplementation(
      (path, data, options) => {
        calls++
        if (calls === 1) {
          original(path, String(data).slice(0, 4), options)
          throw error
        }
        return original(path, data, options)
      },
    )
    try {
      await expect(writer.shutdown()).rejects.toBe(error)
      await expect(writer.flush()).rejects.toBe(error)
      await expect(writer.shutdown()).rejects.toBe(error)
      await expect(writer.appendEntry({ type: 'summary' })).rejects.toBe(error)
      expect(writer.appendsSealedForShutdown).toBe(true)
      expect(calls).toBe(1)
      expect(readFileSync(file, 'utf8')).toBe('{"ty')
    } finally {
      append.mockRestore()
    }
  })

  test('tombstone waits for admitted appendEntry before getSessionMessages resolves', async () => {
    const release = deferred()
    getSessionMessagesCache().set(
      asUuid(getSessionId()),
      release.promise.then(() => new Set()),
    )
    writer.shouldSkipPersistence = () => false
    writer.persistToRemote = async () => {}
    const old = writer.appendEntry({ type: 'assistant', uuid: 'old-X' })
    let removed = false
    const removal = writer.removeMessageByUuid('old-X').then(() => {
      removed = true
    })
    // This later enqueue must not hide the late-arriving earlier producer.
    const later = writer.enqueueWrite(file, { uuid: 'new-Y' })
    await new Promise(r => setTimeout(r, 15))
    const premature = removed
    release.resolve()
    await Promise.all([old, removal, later, writer.flush()])
    expect(premature).toBe(false)
    expect(readFileSync(file, 'utf8')).toBe('{"uuid":"new-Y"}\n')
    await writer.appendEntry({ type: 'assistant', uuid: 'after-Z' })
    await writer.flush()
    expect(readFileSync(file, 'utf8')).toContain('after-Z')
    expect(readFileSync(file, 'utf8')).not.toContain('old-X')
  })

  test('nested tombstone waits for an earlier sibling blocked on session messages', async () => {
    const release = deferred()
    getSessionMessagesCache().set(
      asUuid(getSessionId()),
      release.promise.then(() => new Set()),
    )
    writer.shouldSkipPersistence = () => false
    writer.persistToRemote = async () => {}
    await writer.trackWrite(async () => {
      const sibling = writer.appendEntry({ type: 'assistant', uuid: 'victim' })
      // Independent of deletion completion: this is not a manufactured cycle.
      setTimeout(() => release.resolve(), 25)
      await writer.removeMessageByUuid('victim')
      await sibling
    })
    await writer.flush()
    expect(readFileSync(file, 'utf8')).not.toContain('victim')
  })

  test('same-admission siblings respect both nested deletion boundaries', async () => {
    const release = deferred()
    await writer.trackWrite(async () => {
      const early = writer.trackWrite(async () => {
        await release.promise
        await writer.enqueueWrite(file, { uuid: 'same', version: 1 })
      })
      const first = writer.removeMessageByUuid('same')
      const middle = writer.trackWrite(() =>
        writer.enqueueWrite(file, { uuid: 'same', version: 2 }),
      )
      const second = writer.removeMessageByUuid('same')
      const late = writer.trackWrite(() =>
        writer.enqueueWrite(file, { uuid: 'same', version: 3 }),
      )
      release.resolve()
      await Promise.all([early, first, middle, second, late])
    })
    await writer.flush()
    expect(readFileSync(file, 'utf8')).toBe('{"uuid":"same","version":3}\n')
  })

  test('nested deletion does not wait for a later sibling producer', async () => {
    const release = deferred()
    await writer.trackWrite(async () => {
      // Queue before deletion without awaiting commit: ancestor rows count too.
      const before = writer.enqueueWrite(file, { uuid: 'same', version: 1 })
      const removal = writer.removeMessageByUuid('same')
      const later = writer.trackWrite(async () => {
        await release.promise
        await writer.enqueueWrite(file, { uuid: 'same', version: 2 })
      })
      try {
        await removal
        expect(readFileSync(file, 'utf8')).toBe('')
      } finally {
        release.resolve()
      }
      await Promise.all([before, later])
    })
    await writer.flush()
    expect(readFileSync(file, 'utf8')).toBe('{"uuid":"same","version":2}\n')
  })

  test('deletion includes descendants started by an earlier sibling during its wait', async () => {
    const release = deferred()
    const childRelease = deferred()
    let child!: Promise<void>
    await writer.trackWrite(async () => {
      const sibling = writer.trackWrite(async () => {
        await release.promise
        child = writer.trackWrite(async () => {
          await childRelease.promise
          await writer.enqueueWrite(file, { uuid: 'victim' })
        })
      })
      const removal = writer.removeMessageByUuid('victim')
      release.resolve()
      await sibling
      childRelease.resolve()
      await Promise.all([child, removal])
    })
    await writer.flush()
    expect(readFileSync(file, 'utf8')).toBe('')
  })

  test('nested deletion bypasses two deletions waiting on its ancestor', async () => {
    const release = deferred()
    const ancestor = writer.trackWrite(async () => {
      await release.promise
      const before = writer.enqueueWrite(file, { uuid: 'victim' })
      await writer.trackWrite(() => writer.removeMessageByUuid('victim'))
      await before
    })
    const first = writer.removeMessageByUuid('victim')
    const second = writer.removeMessageByUuid('victim')
    release.resolve()
    await Promise.all([ancestor, first, second, writer.flush()])
    expect(readFileSync(file, 'utf8')).toBe('')
  })

  test('detached nested producers retain their admission until completion', async () => {
    const release = deferred()
    let child!: Promise<void>
    await writer.trackWrite(async () => {
      child = writer.trackWrite(async () => {
        await release.promise
        await writer.enqueueWrite(file, { uuid: 'nested-X' })
      })
    })
    const removal = writer.removeMessageByUuid('nested-X')
    release.resolve()
    await Promise.all([child, removal, writer.flush()])
    expect(readFileSync(file, 'utf8')).toBe('')
  })

  test('nested tombstone does not wait for its own producer', async () => {
    await writer.trackWrite(async () => {
      await writer.enqueueWrite(file, { uuid: 'nested-X' })
      await writer.removeMessageByUuid('nested-X')
    })
    await writer.flush()
    expect(readFileSync(file, 'utf8')).toBe('')
  })

  test('nested tombstone cannot wait for a later producer waiting on its ancestor', async () => {
    const release = deferred()
    const producer = writer.trackWrite(async () => {
      await release.promise
      await writer.enqueueWrite(file, { uuid: 'nested-X' })
      await writer.removeMessageByUuid('nested-X')
    })
    const laterRemoval = writer.removeMessageByUuid('nested-X')
    release.resolve()
    await Promise.all([producer, laterRemoval, writer.flush()])
    expect(readFileSync(file, 'utf8')).toBe('')
  })

  test('metadata failure remains sticky even without a partial append', async () => {
    const error = new Error('metadata failure')
    writer.reAppendSessionMetadata = () => {
      throw error
    }
    await expect(writer.shutdown()).rejects.toBe(error)
    await expect(writer.flush()).rejects.toBe(error)
    expect(writer.appendsSealedForShutdown).toBe(true)
  })

  test('two tombstones preserve boundaries around a delayed producer', async () => {
    const release = deferred()
    const producer = writer.trackWrite(async () => {
      await release.promise
      await writer.enqueueWrite(file, { uuid: 'same', version: 1 })
    })
    const first = writer.removeMessageByUuid('same')
    const middle = writer.enqueueWrite(file, { uuid: 'same', version: 2 })
    const second = writer.removeMessageByUuid('same')
    const last = writer.enqueueWrite(file, { uuid: 'same', version: 3 })
    release.resolve()
    await Promise.all([producer, first, middle, second, last, writer.flush()])
    expect(readFileSync(file, 'utf8')).toBe('{"uuid":"same","version":3}\n')
  })

  test('shutdown waits for detached nested producers and rejects expired contexts', async () => {
    const release = deferred()
    const expired = deferred()
    let child!: Promise<void>
    let late!: Promise<unknown>
    writer.reAppendSessionMetadata = () => {}
    await writer.trackWrite(async () => {
      child = writer.trackWrite(async () => {
        await release.promise
        await writer.enqueueWrite(file, { uuid: 'child' })
      })
      late = expired.promise
        .then(() => writer.trackWrite(async () => {}))
        .catch((e: unknown) => e)
    })
    const shutdown = writer.shutdown()
    expired.resolve()
    expect(await late).toBeInstanceOf(Error)
    release.resolve()
    await Promise.all([child, shutdown])
    expect(readFileSync(file, 'utf8')).toBe('{"uuid":"child"}\n')
  })

  test('real append paths create missing parent directories', async () => {
    const nested = join(tempDir, 'missing', 'nested', 'session.jsonl')
    await writer.appendToFile(nested, '{"uuid":"created"}\n')
    expect(readFileSync(nested, 'utf8')).toBe('{"uuid":"created"}\n')
    writer.sessionFile = join(tempDir, 'metadata', 'nested', 'session.jsonl')
    writer.currentSessionTitle = 'created metadata'
    await writer.shutdown()
    expect(readFileSync(writer.sessionFile, 'utf8')).toContain(
      'created metadata',
    )
  })

  test('chunks count UTF8 bytes and oversized rows are intact and alone', async () => {
    writer.MAX_CHUNK_BYTES = 100
    const chunks: string[] = []
    writer.appendToFile = async (_: string, data: string) => {
      chunks.push(data)
    }
    const rows = [
      '汉'.repeat(15),
      '汉'.repeat(15),
      '𠮷'.repeat(100),
      'end',
    ].map(summary => ({ type: 'summary', summary }))
    const writes = rows.map(row => writer.enqueueWrite(file, row))
    await writer.flush()
    await Promise.all(writes)
    expect(chunks.join('')).toBe(
      rows.map(row => JSON.stringify(row) + '\n').join(''),
    )
    expect(
      chunks.every(
        chunk =>
          Buffer.byteLength(chunk) <= 100 ||
          chunk.trim().split('\n').length === 1,
      ),
    ).toBe(true)
    expect(chunks.every(chunk => chunk.length > 0)).toBe(true)
  })

  test('two tombstones and a window-time flush share the writer domain', async () => {
    writeFileSync(
      file,
      ['a', 'b', 'c'].map(uuid => JSON.stringify({ uuid })).join('\n') + '\n',
    )
    const entered = deferred()
    const release = deferred()
    let opens = 0
    writer.openTranscriptFile = async (...args: Parameters<typeof open>) => {
      opens++
      const fh = await open(...args)
      const truncate = fh.truncate.bind(fh)
      fh.truncate = async len => {
        if (opens === 1) {
          entered.resolve()
          await release.promise
        }
        return truncate(len)
      }
      return fh
    }
    const first = writer.removeMessageByUuid('b')
    await entered.promise
    const second = writer.removeMessageByUuid('a')
    const append = writer.enqueueWrite(file, { uuid: 'd' })
    let flushed = false
    const flushing = writer.flush().then(() => {
      flushed = true
    })
    await new Promise(r => setTimeout(r, 15))
    const observed = { opens, flushed, text: readFileSync(file, 'utf8') }
    release.resolve()
    await Promise.all([first, second, append, flushing])
    expect(observed.opens).toBe(1)
    expect(observed.flushed).toBe(false)
    expect(observed.text).not.toContain('"d"')
    expect(
      readFileSync(file, 'utf8')
        .trim()
        .split('\n')
        .map(line => JSON.parse(line).uuid),
    ).toEqual(['c', 'd'])
  })

  test('a tombstone does not consume an append admitted after its boundary', async () => {
    writeFileSync(file, '{"uuid":"same","version":1}\n')
    const removal = writer.removeMessageByUuid('same')
    const append = writer.enqueueWrite(file, { uuid: 'same', version: 2 })
    await Promise.all([removal, append, writer.flush()])
    expect(readFileSync(file, 'utf8')).toBe('{"uuid":"same","version":2}\n')
  })

  test('serialization errors settle queued writes and poison flush', async () => {
    const queued = writer
      .enqueueWrite(file, { uuid: 'queued' })
      .catch((e: unknown) => e)
    const circular: any = {}
    circular.self = circular
    await expect(writer.enqueueWrite(file, circular)).rejects.toThrow()
    expect(await queued).toBeInstanceOf(Error)
    await expect(writer.flush()).rejects.toThrow()
    expect(writer.getWriteBufferStats()).toEqual({
      queuedBytes: 0,
      inflightBytes: 0,
    })
  })

  test('shutdown rejects new admission but commits an already accepted producer', async () => {
    const release = deferred()
    writer.reAppendSessionMetadata = () => {}
    const producer = writer.trackWrite(async () => {
      await release.promise
      await writer.enqueueWrite(file, { uuid: 'accepted' })
    })
    const shutdown = writer.shutdown()
    await expect(writer.trackWrite(async () => {})).rejects.toThrow(
      'shutting down',
    )
    await expect(
      writer.enqueueWrite(file, { uuid: 'rejected' }),
    ).rejects.toThrow('shutting down')
    release.resolve()
    await Promise.all([producer, shutdown])
    expect(readFileSync(file, 'utf8')).toBe('{"uuid":"accepted"}\n')
    expect(writer.getWriteBufferStats()).toEqual({
      queuedBytes: 0,
      inflightBytes: 0,
    })
    await writer.shutdown()
  })

  test('flush drains entries produced after its first drain', async () => {
    const release = deferred()
    const producer = writer.trackWrite(async () => {
      await release.promise
      void writer.enqueueWrite(file, { type: 'summary', summary: 'late' })
    })
    const flushing = writer.flush()
    release.resolve()
    await Promise.all([producer, flushing])
    expect(readFileSync(file, 'utf8')).toContain('late')
  })
})

describe('getSessionMessagesCache', () => {
  test('returns the same Map instance across calls', () => {
    // Cache identity must be stable — `getLastSessionLog` uses
    // `getSessionMessagesCache()` directly to prime entries, so a
    // different instance each call would break that priming.
    expect(getSessionMessagesCache()).toBe(getSessionMessagesCache())
  })

  test('clearSessionMessagesCache empties a populated cache', async () => {
    const cache = getSessionMessagesCache()
    writeFileSync(sessionFilePath('id-1'), '')
    writeFileSync(sessionFilePath('id-2'), '')
    await getSessionMessages(asUuid('id-1'))
    await getSessionMessages(asUuid('id-2'))
    expect(cache.size).toBeGreaterThan(0)

    clearSessionMessagesCache()
    expect(cache.size).toBe(0)
  })

  test('clearSessionMessagesCache is a no-op on empty cache', () => {
    const cache = getSessionMessagesCache()
    expect(cache.size).toBe(0)
    clearSessionMessagesCache()
    expect(cache.size).toBe(0)
  })

  test('getSessionMessages dedups concurrent calls for the same sessionId', async () => {
    const cache = getSessionMessagesCache()
    const id = asUuid('same-id')
    writeFileSync(sessionFilePath('same-id'), '')
    const [a, b, c] = await Promise.all([
      getSessionMessages(id),
      getSessionMessages(id),
      getSessionMessages(id),
    ])
    expect(a).toBe(b)
    expect(b).toBe(c)
    expect(cache.size).toBe(1)
  })
})

describe('getSessionMessages bounded cache (memory leak fix)', () => {
  test('cache size stays at MAX_CACHED_ENTRIES after many distinct sessionIds', async () => {
    // Bounded cache — calling getSessionMessages with N distinct
    // sessionIds must NOT grow the cache beyond MAX_CACHED_ENTRIES.
    // Pre-fix: lodash memoize grew unbounded. Post-fix: Map-based
    // cache evicts oldest entry when at capacity.
    const cache = getSessionMessagesCache()
    const total = MAX_CACHED_ENTRIES * 3 // 600 distinct sessionIds
    for (let i = 0; i < total; i++) {
      writeFileSync(sessionFilePath(`id-${i}`), '')
      await getSessionMessages(asUuid(`id-${i}`))
    }
    expect(cache.size).toBe(MAX_CACHED_ENTRIES)
  })

  test('FIFO eviction: oldest entry is removed first', async () => {
    // Fill cache to MAX with sequential ids. The first inserted
    // (`oldest`) should be evicted on the (MAX+1)th insertion.
    const cache = getSessionMessagesCache()
    const oldestId = asUuid('id-0')
    writeFileSync(sessionFilePath('id-0'), '')
    await getSessionMessages(oldestId)
    for (let i = 1; i < MAX_CACHED_ENTRIES; i++) {
      writeFileSync(sessionFilePath(`id-${i}`), '')
      await getSessionMessages(asUuid(`id-${i}`))
    }
    expect(cache.size).toBe(MAX_CACHED_ENTRIES)
    expect(cache.has(oldestId)).toBe(true)

    writeFileSync(sessionFilePath('id-overflow'), '')
    await getSessionMessages(asUuid('id-overflow'))
    expect(cache.size).toBe(MAX_CACHED_ENTRIES)
    expect(cache.has(oldestId)).toBe(false)
  })

  test('cleared cache can be refilled without leaking entries', async () => {
    const cache = getSessionMessagesCache()
    for (let i = 0; i < MAX_CACHED_ENTRIES; i++) {
      writeFileSync(sessionFilePath(`id-${i}`), '')
      await getSessionMessages(asUuid(`id-${i}`))
    }
    expect(cache.size).toBe(MAX_CACHED_ENTRIES)

    clearSessionMessagesCache()
    expect(cache.size).toBe(0)

    for (let i = 0; i < MAX_CACHED_ENTRIES + 5; i++) {
      writeFileSync(sessionFilePath(`refill-${i}`), '')
      await getSessionMessages(asUuid(`refill-${i}`))
    }
    expect(cache.size).toBe(MAX_CACHED_ENTRIES)
  })
})

// Transcript write-queue tests (flush debounce + tombstone mutual exclusion).
// TEST_ENABLE_SESSION_PERSISTENCE lifts NodeEnv 'test' persistence skip so
// recordTranscript/removeTranscriptMessage actually enqueue and write.
describe('transcript write queue', () => {
  let persistenceEnv: string | undefined

  beforeEach(() => {
    persistenceEnv = process.env.TEST_ENABLE_SESSION_PERSISTENCE
    process.env.TEST_ENABLE_SESSION_PERSISTENCE = '1'
    resetProjectForTesting()
  })

  afterEach(() => {
    if (persistenceEnv === undefined) {
      delete process.env.TEST_ENABLE_SESSION_PERSISTENCE
    } else {
      process.env.TEST_ENABLE_SESSION_PERSISTENCE = persistenceEnv
    }
    resetProjectForTesting()
  })

  function makeUserMessage(i: number): any {
    return {
      type: 'user' as const,
      uuid: asUuid(`flood-${i}`),
      timestamp: new Date().toISOString(),
      message: { role: 'user', content: `flood message ${i}` },
    }
  }

  test('no entries are dropped when the queue floods past the old 1000-entry cap', async () => {
    // Regression for the silent splice-drop: enqueueWrite used to discard
    // the oldest entries once >=1000 were queued (resolving their futures
    // without writing), losing transcript bytes with zero logging. Official
    // enqueueWrite (docs/reverse-284 full-source/_ALL.js) has no cap —
    // nothing may be dropped; backpressure is surfaced by a bounded
    // logError instead.
    const file = sessionFilePath('flood-queue')
    writeFileSync(file, '')
    setSessionFileForTesting(file)

    const total = 1200
    const messages = Array.from({ length: total }, (_, i) => makeUserMessage(i))
    await recordTranscript(messages)
    await flushSessionStorage()

    const lines = readFileSync(file, 'utf8')
      .split('\n')
      .filter(l => l.trim().length > 0)
    expect(lines).toHaveLength(total)
    const uuids = new Set(
      lines.map(l => (JSON.parse(l) as { uuid: string }).uuid),
    )
    for (let i = 0; i < total; i++) {
      expect(uuids.has(`flood-${i}`)).toBe(true)
    }
  })

  test('tombstone excludes queued appends: remove + concurrent append never loses the appended entry', async () => {
    // Regression for the truncate-window race: appendEntry enqueues via the
    // 100ms debounced drain while removeMessageByUuid does a positional
    // truncate + re-append. The old implementation never drained the queue
    // first, so a debounced appendFile landing between truncate() and the
    // positional re-append of the trailing lines was silently cut.
    // Fixed behavior: removeMessageByUuid drains the queues BEFORE opening
    // its window and reinjects writes enqueued during the window AFTER the
    // tombstone completes — append order preserved, nothing lost.
    const file = sessionFilePath('tomb-race')
    const line = (uuid: string) =>
      JSON.stringify({
        type: 'user',
        uuid,
        message: { role: 'user', content: uuid },
      })
    writeFileSync(
      file,
      [line('aaa'), line('bbb'), line('ccc')].join('\n') + '\n',
    )
    setSessionFileForTesting(file)

    const appended = {
      type: 'user' as const,
      uuid: asUuid('appended-1'),
      timestamp: new Date().toISOString(),
      message: { role: 'user', content: 'appended during window' },
    }

    // Record the new message (queues it; drain timer arms for 100ms) and
    // race the tombstone for the last line immediately — the exact window
    // under review.
    await Promise.all([
      recordTranscript([appended]),
      removeTranscriptMessage(asUuid('ccc')),
    ])
    await flushSessionStorage()

    const lines = readFileSync(file, 'utf8')
      .split('\n')
      .filter(l => l.trim().length > 0)
    const uuids = lines.map(
      l => (JSON.parse(l) as { uuid?: string }).uuid ?? '',
    )
    expect(uuids).not.toContain('ccc')
    // The appended entry was neither cut nor duplicated.
    expect(uuids.filter(u => u === 'appended-1')).toHaveLength(1)
    expect(uuids).toContain('aaa')
    expect(uuids).toContain('bbb')
  })
})
