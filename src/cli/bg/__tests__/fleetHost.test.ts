import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import type { SessionEntry } from '../engine.js'

// Execute the actual resolver and agents action without booting the CLI or
// loading unrelated optional/native dependencies. Imports are host boundaries.
const transpiler = new Bun.Transpiler({
  loader: 'tsx',
  tsconfig: { compilerOptions: { jsx: 'react' } },
})
const bgSource = readFileSync(new URL('../../bg.ts', import.meta.url), 'utf8')
const resolverSource = bgSource.slice(
  bgSource.indexOf('export function findSession('),
  bgSource.indexOf('/**', bgSource.indexOf('export function findSession(')),
)
const findSession = new Function(
  `${transpiler.transformSync(resolverSource.replace('export ', ''))}; return findSession`,
)() as (
  sessions: SessionEntry[],
  target: string,
  options?: { sessionIdOnly?: boolean },
) => SessionEntry | undefined
const session = (
  sessionId: string,
  pid: number,
  name?: string,
): SessionEntry => ({
  sessionId,
  pid,
  name,
  cwd: '/tmp',
  startedAt: 1,
  kind: 'bg',
})

describe('Fleet session resolution', () => {
  test('a stale Fleet identity never falls back to another session name', () => {
    const entries = [session('other-id', 123, '12345678-gone')]
    expect(
      findSession(entries, '12345678-gone', { sessionIdOnly: true }),
    ).toBeUndefined()
    expect(findSession(entries, '123', { sessionIdOnly: true })).toBeUndefined()
  })
  test('full ID wins over names and numeric prefixes regardless of order', () => {
    const selected = session('12345678-abcd', 77)
    const other = session('other-id', 12345678, selected.sessionId)
    for (const entries of [
      [other, selected],
      [selected, other],
    ]) {
      expect(findSession(entries, selected.sessionId)).toBe(selected)
    }
  })
  test('does not introduce prefix or partial PID matching', () => {
    const entries = [session('12345678-abcd', 123)]
    for (const target of [
      '12345678',
      '123abc',
      '123-abcd',
      '123.0',
      ' 123',
      '+123',
      '0123',
    ]) {
      expect(findSession(entries, target)).toBeUndefined()
    }
    expect(findSession(entries, '123')).toBe(entries[0])
  })
  test('rejects duplicate names, duplicate IDs and PID/name collisions', () => {
    expect(
      findSession([session('a', 1, 'same'), session('b', 2, 'same')], 'same'),
    ).toBeUndefined()
    expect(findSession([session('a', 1), session('a', 2)], 'a')).toBeUndefined()
    expect(
      findSession([session('a', 123), session('b', 2, '123')], '123'),
    ).toBeUndefined()
    const entry = session('a', 123, '123')
    expect(findSession([entry], '123')).toBe(entry)
  })
})

const mainSource = readFileSync(
  new URL('../../../main.tsx', import.meta.url),
  'utf8',
)
const start = mainSource.indexOf(
  '.action(async options => {',
  mainSource.indexOf(".command('agents')"),
)
const end = mainSource.indexOf(
  "\n  if (feature('TRANSCRIPT_CLASSIFIER'))",
  start,
)
const actionSource = mainSource
  .slice(start + '.action('.length, end)
  .trim()
  .replace(/\);$/, '')
  .replace(/import\(/g, 'loadModule(')

async function runHost(
  mode: 'attach' | 'throw' | 'kill' | 'delete' | 'delete-error',
) {
  const live = [session('12345678-first', 31), session('12345678-second', 32)]
  const job = {
    id: 'original-job-id',
    state: {
      ...session('87654321-terminal', 99),
      terminalOutcome: 'completed',
    },
  }
  const calls: string[] = []
  const proc = {
    stdout: { isTTY: true },
    exitCode: undefined as number | undefined,
    exit: (code: number) => {
      calls.push(`exit:${code}`)
      throw new Error('host exited')
    },
  }
  let renderOptions: unknown
  const bg = {
    listLiveSessions: async () => live,
    attachHandler: async (id: string) => {
      calls.push(`attach:${id}`)
      if (mode === 'throw') throw new Error('attach failed')
      proc.exitCode = 1
    },
    killHandler: async (id: string) => {
      await Promise.resolve()
      calls.push(`kill:${id}`)
    },
  }
  const jobs = {
    listJobs: async () => [job],
    readJobState: async () => job.state,
    isTerminal: () => true,
    removeJobDir: async (id: string) => {
      calls.push(`delete:${id}`)
      if (mode === 'delete-error') throw new Error('delete failed')
    },
  }
  const fleet = {
    FleetView: 'FleetView',
    toFleetRows: (
      entries: Array<SessionEntry & { terminalOutcome?: string }>,
    ) =>
      entries.map(s => ({
        shortId: s.sessionId.slice(0, 8),
        pid: s.pid,
        tempo: s.terminalOutcome ? 'done' : 'running',
      })),
  }
  const ink = {
    ThemeProvider: 'ThemeProvider',
    wrappedRender: async (tree: any, options: unknown) => {
      renderOptions = options
      const props = tree.children[0].props
      const rows = await props.loadRows()
      if (mode === 'kill') props.onKill(rows[1])
      else if (mode.startsWith('delete')) props.onKill(rows[2])
      else props.onAttach(rows[1])
      return { waitUntilExit: async () => {} }
    },
  }
  const loadModule = async (path: string) => {
    if (path === './cli/bg.js') return bg
    if (path === './components/FleetView.js') return fleet
    if (path === '@anthropic/ink') return ink
    if (path === './cli/fleet/jobState.js') return jobs
    if (path === 'fs/promises') return {}
    throw new Error(`Unexpected import: ${path}`)
  }
  const React = {
    createElement: (type: unknown, props: unknown, ...children: unknown[]) => ({
      type,
      props,
      children,
    }),
  }
  const code = transpiler.transformSync(`const action = ${actionSource};`)
  const action = new Function(
    'loadModule',
    'process',
    'React',
    'console',
    `${code}; return action`,
  )(loadModule, proc, React, { error: () => {} })
  await expect(action({})).rejects.toThrow('host exited')
  return { calls, renderOptions }
}

describe('agents Fleet host', () => {
  test('passes full identity despite short-ID collisions and preserves attach exitCode', async () => {
    const result = await runHost('attach')
    expect(result.calls).toEqual(['attach:12345678-second', 'exit:1'])
    expect(result.renderOptions).toEqual({ exitOnCtrlC: false })
  })
  test('reports thrown attach failures as failures', async () => {
    expect((await runHost('throw')).calls).toEqual([
      'attach:12345678-second',
      'exit:1',
    ])
  })
  test('waits for full-ID stop before exiting without deleting the job', async () => {
    expect((await runHost('kill')).calls).toEqual([
      'kill:12345678-second',
      'exit:0',
    ])
  })
  test('deletes terminal jobs by roster ID without needing a live session', async () => {
    expect((await runHost('delete')).calls).toEqual([
      'delete:original-job-id',
      'exit:0',
    ])
  })
  test('does not hide asynchronous deletion failures', async () => {
    expect((await runHost('delete-error')).calls).toEqual([
      'delete:original-job-id',
      'exit:1',
    ])
  })
})
