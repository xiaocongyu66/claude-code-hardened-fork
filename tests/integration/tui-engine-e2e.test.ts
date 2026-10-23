import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  startMockAnthropicServer,
  type MockAnthropicServer,
} from '../../scripts/mock-anthropic-server'

/**
 * End-to-end test for the TUI engine path.
 *
 * The Rust TUI drives the engine as a child process:
 *
 *   cli --print --input-format stream-json --output-format stream-json \
 *       --include-partial-messages
 *
 * This test spawns that same process shape against a local mock Anthropic
 * server, so it needs no API key and no network. It asserts the frames the TUI
 * depends on (system:init, assistant, result) and that the assistant text
 * carries the mock reply. See docs/tui-engine-protocol.md.
 */

const REPO_ROOT = join(import.meta.dir, '..', '..')
const CLI_ENTRY = join(REPO_ROOT, 'src/entrypoints/cli.tsx')
const USER_TEXT = 'Say hello in one short sentence.'

/** Upper bound for the whole turn (CLI cold start + one mocked API round trip). */
const READ_TIMEOUT_MS = 30_000
/** Extra headroom so a timeout failure can still print diagnostics/clean up. */
const TEST_TIMEOUT_MS = 40_000
const KILL_GRACE_MS = 2_000

// Environment variables that would route the engine to a different provider
// or auth source. Cleared so a developer's shell config cannot change the path
// under test.
const PROVIDER_ENV_KEYS = [
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_OPENAI',
  'CLAUDE_CODE_USE_GEMINI',
  'CLAUDE_CODE_USE_GROK',
  'ANTHROPIC_MODEL',
]

type Frame = Record<string, unknown>

let mock: MockAnthropicServer
let tempDir: string
let configDir: string

// In CI the full `bun test --coverage` sweep also discovers this file. Keep the
// E2E out of that blocking sweep and let the dedicated, non-blocking CI step
// opt in with TUI_E2E=1, so an engine cold-start flake cannot gate packaging.
// Local `bun test` runs it unconditionally.
const IS_CI = process.env.CI === 'true' || process.env.CI === '1'
const e2eDescribe =
  !IS_CI || process.env.TUI_E2E === '1' ? describe : describe.skip

/** Yield complete stdout lines; the final partial line is flushed at EOF. */
async function* stdoutLines(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<string> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let newline = buffer.indexOf('\n')
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        if (line) yield line
        newline = buffer.indexOf('\n')
      }
    }
    const tail = `${buffer}${decoder.decode()}`.trim()
    if (tail) yield tail
  } finally {
    reader.releaseLock()
  }
}

/** Collect NDJSON frames until `result` arrives or stdout closes. */
async function collectFrames(
  stream: ReadableStream<Uint8Array>,
  frames: Frame[],
): Promise<void> {
  for await (const line of stdoutLines(stream)) {
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      // stdout is NDJSON on this path; ignore anything that is not JSON.
      continue
    }
    if (parsed && typeof parsed === 'object' && 'type' in parsed) {
      const frame = parsed as Frame
      frames.push(frame)
      if (frame.type === 'result') return
    }
  }
}

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

function assistantText(frame: Frame): string {
  const message = frame.message as { content?: unknown } | undefined
  const content = Array.isArray(message?.content) ? message.content : []
  return content
    .map(block => {
      if (
        block &&
        typeof block === 'object' &&
        (block as { type?: string }).type === 'text'
      ) {
        const text = (block as { text?: unknown }).text
        return typeof text === 'string' ? text : ''
      }
      return ''
    })
    .join('')
}

function printDiagnostics(frames: Frame[], stderr: string): void {
  console.error(
    `[tui-engine-e2e] read ${frames.length} frame(s) before failing:`,
  )
  for (const frame of frames) {
    console.error(JSON.stringify(frame))
  }
  if (stderr.trim()) {
    console.error('[tui-engine-e2e] cli stderr:\n' + stderr)
  }
}

e2eDescribe('TUI engine E2E (mock Anthropic API)', () => {
  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cch-tui-e2e-'))
    configDir = join(tempDir, 'config')
    await mkdir(configDir, { recursive: true })
    mock = startMockAnthropicServer()
  })

  afterAll(async () => {
    mock?.stop()
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  test(
    'stream-json turn emits system:init, assistant, and result',
    async () => {
      const env: Record<string, string | undefined> = { ...process.env }
      for (const key of PROVIDER_ENV_KEYS) {
        delete env[key]
      }
      Object.assign(env, {
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${mock.port}`,
        ANTHROPIC_API_KEY: 'test',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        DISABLE_TELEMETRY: '1',
        // Keep config/session state out of the developer's ~/.claude.
        CLAUDE_CONFIG_DIR: configDir,
        NO_COLOR: '1',
      })

      // `--verbose` is required by the engine for stream-json output
      // (src/cli/print.ts rejects it otherwise); pass it even though the TUI
      // documentation elides it.
      //
      // No `--dangerously-skip-permissions`/trust flag is needed: `-p` skips
      // the workspace trust dialog ("trust is implicit in -p mode") and the
      // mock returns a text-only turn, so no tool permission prompt can fire.
      const proc = Bun.spawn({
        cmd: [
          process.execPath,
          CLI_ENTRY,
          '--print',
          '--input-format',
          'stream-json',
          '--output-format',
          'stream-json',
          '--include-partial-messages',
          '--verbose',
        ],
        // Run outside the repo so project CLAUDE.md/settings/MCP config do not
        // influence the path under test.
        cwd: tempDir,
        env,
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
      })

      // Start draining stderr immediately so a full pipe cannot wedge the CLI.
      const stderrPromise = Bun.readableStreamToText(proc.stderr).catch(
        () => '',
      )
      const frames: Frame[] = []
      let failure: unknown

      try {
        proc.stdin.write(
          `${JSON.stringify({
            type: 'user',
            message: {
              role: 'user',
              content: [{ type: 'text', text: USER_TEXT }],
            },
            parent_tool_use_id: null,
          })}\n`,
        )
        await proc.stdin.flush()

        await withTimeout(
          collectFrames(proc.stdout, frames),
          READ_TIMEOUT_MS,
          `no result frame within ${READ_TIMEOUT_MS}ms`,
        )

        const initIndex = frames.findIndex(
          frame => frame.type === 'system' && frame.subtype === 'init',
        )
        const assistantIndex = frames.findIndex(
          frame => frame.type === 'assistant',
        )
        const resultIndex = frames.findIndex(frame => frame.type === 'result')

        const initFrame = frames[initIndex]
        const assistantFrame = frames[assistantIndex]
        const resultFrame = frames[resultIndex]
        const replyText = assistantFrame ? assistantText(assistantFrame) : ''

        expect(initFrame).toBeDefined()
        expect(typeof initFrame?.session_id).toBe('string')
        expect(initFrame?.model).toBeTruthy()

        expect(assistantFrame).toBeDefined()
        expect(replyText).toContain(mock.text)

        expect(resultFrame).toBeDefined()
        expect(resultFrame?.subtype).toBe('success')
        expect(resultFrame?.is_error).toBe(false)

        // The TUI consumes the stream in order: init, then the assistant turn,
        // then result.
        expect(initIndex).toBeLessThan(assistantIndex)
        expect(assistantIndex).toBeLessThan(resultIndex)

        // --include-partial-messages must surface raw stream events too.
        expect(frames.some(frame => frame.type === 'stream_event')).toBe(true)
      } catch (error) {
        failure = error
      } finally {
        try {
          proc.kill()
        } catch {
          // Already exited.
        }
        const killTimer = setTimeout(() => {
          try {
            proc.kill('SIGKILL')
          } catch {
            // Already exited.
          }
        }, KILL_GRACE_MS)
        await proc.exited.catch(() => {})
        clearTimeout(killTimer)
      }

      if (failure) {
        printDiagnostics(frames, await stderrPromise)
        throw failure
      }
    },
    TEST_TIMEOUT_MS,
  )
})
