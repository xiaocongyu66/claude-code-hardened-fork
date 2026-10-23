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

    const decision = (await pending) as Record<string, unknown>
    expect(decision.behavior).toBe('allow')
    expect(decision.updatedInput).toEqual({ command: 'ls' })
    expect(answers).toHaveLength(1)
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
