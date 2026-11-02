import { describe, expect, test } from 'bun:test'
import { relative, resolve } from 'node:path'

const PROJECT_ROOT = resolve(__dirname, '..', '..', '..', '..')
const RUNNER_ABS = resolve(__dirname, 'queue-cap.runner.ts')
const RUNNER_REL = './' + relative(PROJECT_ROOT, RUNNER_ABS).replace(/\\/g, '/')

// Other suites mock analytics process-wide, including logEvent and reset but
// retaining the real queue getter. Only a fresh process tests the real module.
describe('analytics event queue cap', () => {
  test('runs real queue regressions in an isolated process', async () => {
    const proc = Bun.spawn([process.execPath, 'test', RUNNER_REL], {
      cwd: PROJECT_ROOT,
      env: { ...process.env, USER_TYPE: '' },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [code, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    if (code !== 0) {
      throw new Error(
        `analytics queue tests failed (exit ${code}):\n${stderr}\n${stdout}`,
      )
    }
    expect(code).toBe(0)
  }, 60_000)
})
