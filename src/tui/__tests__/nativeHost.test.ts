import { describe, expect, test } from 'bun:test'
import type { CanUseToolFn } from '../../hooks/useCanUseTool.js'
import type {
  TuiNativeEvent,
  TuiNativeModule,
  TuiStartOptions,
} from '../../utils/tuiNative.js'
import { runNativeTui, type NativePermissionEvent } from '../nativeHost.js'

class FakeNativeModule implements TuiNativeModule {
  sent: unknown[] = []
  queue: TuiNativeEvent[] = []
  startCalls: TuiStartOptions[] = []
  stopCalls = 0

  start(options: TuiStartOptions): void {
    this.startCalls.push(options)
  }

  send(frame: string): void {
    this.sent.push(JSON.parse(frame))
  }

  poll(): TuiNativeEvent | null {
    return this.queue.shift() ?? null
  }

  stop(): void {
    this.stopCalls += 1
  }

  is_supported(): boolean {
    return true
  }
}

/**
 * Mutating sleep: lets a test inject poll frames after N poll calls without
 * relying on real timers. Every call yields to the microtask queue, so turn
 * chains make progress between polls.
 */
function scriptedSleep(
  mod: FakeNativeModule,
  script: Array<TuiNativeEvent | ((m: FakeNativeModule) => TuiNativeEvent)>,
): (ms: number) => Promise<void> {
  let index = 0
  return async () => {
    await Promise.resolve()
    const step = script[index]
    index += 1
    if (step === undefined) return
    mod.queue.push(typeof step === 'function' ? step(mod) : step)
  }
}

const tool = { name: 'Bash' } as never
const input = { command: 'ls' } as never
const permissionArgs = [
  tool,
  input,
  {} as never,
  {} as never,
  'toolu_1',
] as const

describe('runNativeTui', () => {
  test('sends engine events and stops on exit', async () => {
    const mod = new FakeNativeModule()
    mod.queue.push({ type: 'prompt', text: 'hello' })

    const prompts: string[] = []
    const result = await runNativeTui({
      nativeModule: mod,
      sleep: scriptedSleep(mod, [
        () => ({ type: 'keep_alive' }),
        () => ({ type: 'exit' }),
      ]),
      submitPrompt: async function* (text: string) {
        prompts.push(text)
        yield { type: 'assistant', message: { content: 'hi' } }
      },
    })

    expect(result.started).toBe(true)
    expect(prompts).toEqual(['hello'])
    expect(mod.sent).toContainEqual({
      type: 'assistant',
      message: { content: 'hi' },
    })
    expect(mod.startCalls).toHaveLength(1)
    expect(mod.stopCalls).toBe(1)
  })

  test('dispatches permission frames and resolves the pending canUseTool', async () => {
    const mod = new FakeNativeModule()
    mod.queue.push({ type: 'prompt', text: 'run it' })

    let pending: Promise<unknown> | null = null
    const answers: NativePermissionEvent[] = []
    const result = await runNativeTui({
      nativeModule: mod,
      sleep: scriptedSleep(mod, [
        () => ({ type: 'keep_alive' }),
        m => {
          const request = m.sent.find(
            frame =>
              (frame as Record<string, unknown>).type === 'control_request',
          ) as Record<string, unknown> | undefined
          return {
            type: 'permission',
            request_id: request?.request_id as string,
            behavior: 'allow',
            updatedInput: { command: 'ls' },
          }
        },
        () => ({ type: 'exit' }),
      ]),
      answerPermission: (event: NativePermissionEvent) => {
        answers.push(event)
        return {
          behavior: 'allow',
          updatedInput: { command: 'ls' },
        }
      },
      submitPrompt: async function* (_text: string, canUseTool: CanUseToolFn) {
        pending = canUseTool(...permissionArgs)
        yield { type: 'assistant' }
      },
    })

    expect(result.started).toBe(true)

    const controlRequest = mod.sent.find(
      frame => (frame as Record<string, unknown>).type === 'control_request',
    ) as Record<string, unknown>
    expect(controlRequest).toBeDefined()
    expect(controlRequest.request_id).toBeString()

    const decision = (await pending) as unknown as Record<string, unknown>
    expect(decision.behavior).toBe('allow')
    expect(decision.updatedInput).toEqual({ command: 'ls' })
    expect(answers).toHaveLength(1)
  })

  test('answers get_context_usage with the injected percentage', async () => {
    const mod = new FakeNativeModule()
    const result = await runNativeTui({
      nativeModule: mod,
      contextWindowTokens: 1000,
      getContextUsage: () => 42,
      sleep: scriptedSleep(mod, [
        () => ({ type: 'get_context_usage', request_id: 'ctx-1' }),
        () => ({ type: 'exit' }),
      ]),
      submitPrompt: async function* () {},
    })

    expect(result.started).toBe(true)
    const response = mod.sent.find(
      frame => (frame as Record<string, unknown>).type === 'control_response',
    ) as Record<string, unknown> | undefined
    expect(response).toBeDefined()
    const body = response!.response as Record<string, unknown>
    expect(body.request_id).toBe('ctx-1')
    expect((body.response as Record<string, unknown>).percent).toBe(42)
  })

  test('answers complete_file and search_workspace with bounded system frames', async () => {
    const mod = new FakeNativeModule()
    mod.queue.push({
      type: 'complete_file',
      request_id: 'f1',
      query: 'src',
    })
    mod.queue.push({
      type: 'search_workspace',
      request_id: 's1',
      query: 'needle',
    })

    const workspaceMatch = (index: number) => ({
      path: `src/f${index}.ts`,
      line: index + 1,
      text: 'needle',
    })

    const result = await runNativeTui({
      nativeModule: mod,
      completeFile: () =>
        Array.from({ length: 101 }, (_, index) => `src/f${index}.ts`),
      searchWorkspace: async () => ({
        matches: Array.from({ length: 201 }, (_, index) =>
          workspaceMatch(index),
        ),
        truncated: false,
      }),
      sleep: scriptedSleep(mod, [
        () => ({ type: 'keep_alive' }),
        () => ({ type: 'keep_alive' }),
        () => ({ type: 'exit' }),
      ]),
      submitPrompt: async function* () {},
    })

    expect(result.started).toBe(true)
    const suggestions = mod.sent.find(
      frame =>
        (frame as Record<string, unknown>).subtype === 'file_suggestions',
    ) as Record<string, unknown> | undefined
    expect(suggestions?.request_id).toBe('f1')
    const files = suggestions?.files as string[] | undefined
    expect(files?.length).toBe(100)

    const workspace = mod.sent.find(
      frame =>
        (frame as Record<string, unknown>).subtype ===
        'workspace_search_results',
    ) as Record<string, unknown> | undefined
    expect(workspace?.request_id).toBe('s1')
    const matches = workspace?.matches as unknown[] | undefined
    expect(matches?.length).toBe(200)
    expect(workspace?.truncated).toBe(true)
  })

  test('interrupt calls the injected abort and unknown frames are ignored', async () => {
    const mod = new FakeNativeModule()
    mod.queue.push({ type: 'mystery' })
    mod.queue.push({ type: 'interrupt' })

    let aborts = 0
    const result = await runNativeTui({
      nativeModule: mod,
      sleep: scriptedSleep(mod, [
        () => ({ type: 'keep_alive' }),
        () => ({ type: 'exit' }),
      ]),
      submitPrompt: async function* () {},
      abort: () => {
        aborts += 1
      },
    })

    expect(result.started).toBe(true)
    expect(aborts).toBe(1)
    expect(mod.stopCalls).toBe(1)
  })

  test('onHostReady registers external permission requests and onStop fires once', async () => {
    const mod = new FakeNativeModule()
    let pending: Promise<{ behavior: string }> | null = null
    let stops = 0

    const result = await runNativeTui({
      nativeModule: mod,
      onHostReady: controls => {
        pending = controls.requestPermission('remote-1')
      },
      onStop: () => {
        stops += 1
      },
      sleep: scriptedSleep(mod, [
        () => ({ type: 'keep_alive' }),
        () => ({
          type: 'permission',
          request_id: 'remote-1',
          behavior: 'allow',
        }),
        () => ({ type: 'exit' }),
      ]),
      submitPrompt: async function* () {},
    })

    expect(result.started).toBe(true)
    expect(stops).toBe(1)
    const decision = await pending!
    expect(decision.behavior).toBe('allow')
  })

  test('returns not-started when no native module is available', async () => {
    const result = await runNativeTui({
      nativeModule: null,
      submitPrompt: async function* () {},
    })
    expect(result.started).toBe(false)
  })

  test('returns not-started when is_supported() is false', async () => {
    const mod = new FakeNativeModule()
    mod.is_supported = () => false
    const result = await runNativeTui({
      nativeModule: mod,
      submitPrompt: async function* () {},
    })
    expect(result.started).toBe(false)
    expect(mod.startCalls).toHaveLength(0)
  })
})
