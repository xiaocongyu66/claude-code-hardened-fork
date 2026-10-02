import { expect, test } from 'bun:test'

// Isolate dependency-boundary mocks in a subprocess. The handler, jobState,
// filesystem, atomic rename and lock implementation are production code.
test('production rename and stop preserve job ownership; resume failures are handled', async () => {
  const script = `
    import { mock, expect } from 'bun:test'
    import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
    import { tmpdir } from 'node:os'
    import { join } from 'node:path'
    import { debugMock } from './tests/mocks/debug.ts'
    const home = await mkdtemp(join(tmpdir(), 'fleet-stop-ownership-'))
    const alive = new Set([910001, 910002])
    const signals = []
    mock.module('src/utils/envUtils.ts', () => ({ getClaudeConfigHomeDir: () => home }))
    mock.module('src/utils/genericProcessUtils.ts', () => ({ isProcessRunning: pid => alive.has(pid) }))
    mock.module('src/utils/debug.ts', debugMock)
    // JSON instrumentation imports unavailable bootstrap dependencies; actual
    // state serialization and disk IO remain in the production write chain.
    mock.module('src/utils/slowOperations.ts', () => ({ jsonParse: JSON.parse, jsonStringify: JSON.stringify }))
    mock.module('src/i18n/index.ts', () => ({ t: text => text }))
    mock.module('src/cli/bg/engines/index.ts', () => ({ selectEngine: () => { throw new Error('not used') } }))
    const jobs = await import('./src/cli/fleet/jobState.ts')
    const { killHandler, renameSession } = await import('./src/cli/bg.ts')
    const first = jobs.makeInitialState({ sessionId: '12345678-first', pid: 910001, cwd: '/tmp', kind: 'bg' })
    const second = jobs.makeInitialState({ sessionId: '12345678-second', pid: 910002, cwd: '/tmp', kind: 'bg' })
    const originalKill = process.kill
    process.kill = (pid, signal) => { signals.push([pid, signal]); alive.delete(pid); return true }
    try {
      await mkdir(join(home, 'sessions'), { recursive: true })
      for (const state of [first, second]) await writeFile(join(home, 'sessions', state.pid + '.json'), JSON.stringify(state))
      await jobs.writeStateAtomic('12345678', second)
      const before = await readFile(join(jobs.getJobDir('12345678'), 'state.json'), 'utf8')
      const firstLegacy = await readFile(join(home, 'sessions', '910001.json'), 'utf8')
      const secondLegacy = await readFile(join(home, 'sessions', '910002.json'), 'utf8')
      await expect(renameSession(910001, 'ONLY-FIRST')).rejects.toThrow('belongs to a different session')
      expect(await readFile(join(jobs.getJobDir('12345678'), 'state.json'), 'utf8')).toBe(before)
      expect(await readFile(join(home, 'sessions', '910001.json'), 'utf8')).toBe(firstLegacy)
      expect(await readFile(join(home, 'sessions', '910002.json'), 'utf8')).toBe(secondLegacy)
      await jobs.withJobDirLock('12345678', 'state', async () => {
        await expect(renameSession(910002, 'LOCKED')).rejects.toThrow('Unable to lock')
        expect(await readFile(join(jobs.getJobDir('12345678'), 'state.json'), 'utf8')).toBe(before)
      })
      expect(await renameSession(910002, 'ONLY-SECOND')).toBe(true)
      expect((await jobs.readJobState('12345678')).name).toBe('ONLY-SECOND')
      expect(JSON.parse(await readFile(join(home, 'sessions', '910002.json'), 'utf8')).name).toBe('ONLY-SECOND')
      expect(await readFile(join(home, 'sessions', '910001.json'), 'utf8')).toBe(firstLegacy)
      await jobs.writeStateAtomic('12345678', second)
      await expect(killHandler(first.sessionId, { sessionIdOnly: true })).rejects.toThrow('belongs to a different session')
      expect(signals).toEqual([[910001, 'SIGTERM']])
      expect(await readFile(join(jobs.getJobDir('12345678'), 'state.json'), 'utf8')).toBe(before)
      expect(await jobs.legacySessionExists(910001)).toBe(false)
      expect(await jobs.legacySessionExists(910002)).toBe(true)

      // Legitimate stop still persists stopped and retains the job directory.
      await killHandler(second.sessionId, { sessionIdOnly: true })
      expect(signals).toEqual([[910001, 'SIGTERM'], [910002, 'SIGTERM']])
      expect((await jobs.readJobState('12345678')).terminalOutcome).toBe('stopped')
      expect(await jobs.legacySessionExists(910002)).toBe(false)

      await jobs.writeStateAtomic('12345678', first)
      await jobs.withJobDirLock('12345678', 'state', async () => {
        // All production state writers must honor the same lock, never run
        // their callback unlocked on EEXIST (the previous lock behavior).
        await expect(jobs.writeStateAtomic('12345678', second)).rejects.toThrow('Unable to lock')
        await expect(jobs.updateJobState('12345678', { sessionId: second.sessionId })).rejects.toThrow('Unable to lock')
        await expect(jobs.writeReapedTerminalState('12345678', 'stopped', first.sessionId)).rejects.toThrow('Unable to lock')
        expect((await jobs.readJobState('12345678')).sessionId).toBe(first.sessionId)
      })
      // Identity changed before acquiring the lock: check the fresh disk state,
      // not an earlier caller snapshot, and leave every persisted byte alone.
      await jobs.writeStateAtomic('12345678', second)
      await expect(jobs.writeReapedTerminalState('12345678', 'stopped', first.sessionId)).rejects.toThrow('belongs to a different session')
      expect(await jobs.readJobState('12345678')).toEqual(second)
      await jobs.writeReapedTerminalState('12345678', 'stopped', second.sessionId)
      expect((await jobs.readJobState('12345678')).terminalOutcome).toBe('stopped')
      expect(await jobs.writeReapedTerminalState('missing0', 'stopped', 'missing0-full')).toBeNull()

      // Execute the actual registered callback source against production jobState.
      // Avoid booting unrelated session/bootstrap dependencies in this subprocess.
      const source = await readFile('./src/utils/concurrentSessions.ts', 'utf8')
      const start = source.indexOf('onSessionSwitch(id => {')
      const end = source.indexOf('\\n        })', start) + '\\n        })'.length
      const callbackSource = source.slice(start, end).replace('../cli/fleet/jobState.js', './src/cli/fleet/jobState.ts')
      const messages = []
      let callback
      let logged
      const logReceived = new Promise(resolve => { logged = resolve })
      new Function('onSessionSwitch', 'st', 'logForDebugging', 'errorMessage', callbackSource)(
        fn => { callback = fn }, second,
        message => { messages.push(message); logged() }, error => error.message,
      )
      await jobs.withJobDirLock('12345678', 'state', async () => {
        callback('replacement-session')
        await Promise.race([logReceived, new Promise((_, reject) => setTimeout(() => reject(new Error('resume failure was not logged')), 1000))])
        expect(messages[0]).toContain('[concurrentSessions] fleet resume sync failed: Unable to lock')
        expect((await jobs.readJobState('12345678')).sessionId).toBe(second.sessionId)
      })
    } finally {
      process.kill = originalKill
      await rm(home, { recursive: true, force: true })
    }
  `
  const child = Bun.spawn([process.execPath, '--eval', script], {
    cwd: new URL('../../../../', import.meta.url).pathname,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  expect({ code, stderr, stdout }).toEqual({
    code: 0,
    stderr: '',
    stdout:
      'Killing session 12345678-first (PID: 910001)...\nSession stopped.\nKilling session 12345678-second (PID: 910002)...\nSession stopped.\n',
  })
}, 15000)
