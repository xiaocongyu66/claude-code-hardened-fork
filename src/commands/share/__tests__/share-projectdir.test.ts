/**
 * Covers the getTranscriptPath projectDir branch (line 127 in share/index.ts).
 *
 * This file mocks src/bootstrap/state.js to return a non-null projectDir,
 * which exercises the if (projectDir) branch of getTranscriptPath.
 *
 * It is isolated in a separate file to avoid state mock contamination.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// ── child_process mock (gh fails → shows gh not installed) ──
let _execFileImplPD: (
  cmd: string,
  args: string[],
  opts: unknown,
  cb: (err: Error | null, stdout: string, stderr: string) => void,
) => void = (_cmd, _args, _opts, cb) => cb(new Error('ENOENT'), '', '')

const execFileMockPD = (
  cmd: string,
  args: string[],
  opts: unknown,
  cb: (err: Error | null, stdout: string, stderr: string) => void,
) => _execFileImplPD(cmd, args, opts, cb)

;(execFileMockPD as unknown as Record<symbol, unknown>)[
  promisify.custom as symbol
] = (
  cmd: string,
  args: string[],
  opts: unknown,
): Promise<{ stdout: string; stderr: string }> =>
  new Promise((resolve, reject) =>
    _execFileImplPD(cmd, args, opts, (err, stdout, stderr) => {
      if (err) reject(err)
      else resolve({ stdout, stderr })
    }),
  )

// Spread real child_process + gate stub behind useShareProjectdirCpStubs.
// Default OFF: only this suite's beforeAll flips on; afterAll flips off.
// Without spread, every other test in the same `bun test` run that imports
// child_process (e.g. src/services/skillLearning/projectContext.ts which uses
// execFileSync for git) gets our stubs and breaks.
let useShareProjectdirCpStubs = false
mock.module('node:child_process', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const real = require('node:child_process') as Record<string, unknown>
  return {
    ...real,
    default: real,
    execFile: ((...args: unknown[]) =>
      useShareProjectdirCpStubs
        ? (execFileMockPD as (...a: unknown[]) => unknown)(...args)
        : (real.execFile as (...a: unknown[]) => unknown)(
            ...args,
          )) as typeof real.execFile,
    execFileSync: ((...args: unknown[]) =>
      useShareProjectdirCpStubs
        ? Buffer.from('')
        : (real.execFileSync as (...a: unknown[]) => unknown)(
            ...args,
          )) as typeof real.execFileSync,
  }
})

mock.module('bun:bundle', () => ({
  feature: (_name: string) => true,
}))

import * as realAnalyticsPD from 'src/services/analytics/index.js'
mock.module('src/services/analytics/index.js', () => ({
  ...realAnalyticsPD,
  logEvent: () => {},
  stripProtoFields: (v: unknown) => v,
}))

// ── State mock with non-null projectDir ──
// 跨套件 mock 污染修复：手写 56 行面缺 getModelStrings/getPlanSlugCache/
// getInlinePlugins 等真实导出，同进程后加载的消费者会读到 undefined。
// 改为真实模块快照 + 只覆盖被测接缝（getSessionId 确定性 + projectDir
// 注入）+ afterAll 还原。
import * as realBootstrapStatePD from 'src/bootstrap/state.js'
const bootstrapStateSnapshotPD: Record<string, unknown> = {
  ...realBootstrapStatePD,
}
let _mockProjectDir: string | null = null

mock.module('src/bootstrap/state.js', () => ({
  ...bootstrapStateSnapshotPD,
  getSessionId: () => 'test-session-pd',
  getSessionProjectDir: () => _mockProjectDir,
  getIsNonInteractiveSession: () => false,
}))
afterAll(() => {
  mock.module('src/bootstrap/state.js', () => bootstrapStateSnapshotPD)
})

// ── State ──
let tmpDir: string

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'share-pd-test-'))
  _execFileImplPD = (_cmd, _args, _opts, cb) => cb(new Error('ENOENT'), '', '')
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
  _mockProjectDir = null
})

// ── Helpers ──
type CallFn = (args: string) => Promise<{ type: string; value: string }>

async function getCallFn(): Promise<CallFn> {
  const mod = await import('../index.js')
  const loaded = await (
    mod.default as unknown as { load: () => Promise<{ call: CallFn }> }
  ).load()
  return loaded.call.bind(loaded) as CallFn
}

// Gate child_process stub on for this suite only.
beforeAll(() => {
  useShareProjectdirCpStubs = true
})
afterAll(() => {
  useShareProjectdirCpStubs = false
})

describe('share command — getTranscriptPath projectDir branch', () => {
  test('getSessionProjectDir non-null → uses projectDir path (session log not found)', async () => {
    // Set projectDir to tmpDir — session file won't exist → "Session log not found"
    _mockProjectDir = tmpDir
    const call = await getCallFn()
    const result = await call('--private')
    expect(result.type).toBe('text')
    // Since log doesn't exist at projectDir/test-session-pd.jsonl → log not found
    expect(result.value).toContain('Session log not found')
    expect(result.value).toContain('test-session-pd')
  })

  test('getSessionProjectDir non-null + log exists → proceeds past log check', async () => {
    // Write session log at projectDir/test-session-pd.jsonl
    _mockProjectDir = tmpDir
    const logPath = join(tmpDir, 'test-session-pd.jsonl')
    writeFileSync(
      logPath,
      JSON.stringify({ role: 'user', content: 'test' }) + '\n',
    )
    const call = await getCallFn()
    const result = await call('--private')
    expect(result.type).toBe('text')
    // gh fails → shows gh install instructions
    expect(typeof result.value).toBe('string')
    expect(result.value.length).toBeGreaterThan(0)
  })
})
