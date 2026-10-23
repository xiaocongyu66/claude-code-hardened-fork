import { describe, expect, test } from 'bun:test'
import type { Message } from '../../../../types/message.js'
import {
  createSpeculationManager,
  type SpeculationContext,
} from '../../speculation/manager.js'

function msg(uuid: string): Message {
  return {
    type: 'user',
    message: { role: 'user', content: uuid },
    uuid,
  } as unknown as Message
}

// lead = clamp(100_000 × 0.125, 8192, 32000) = 12_500 → band [87_500, 100_000)
const THRESHOLD = 100_000
const BAND_LOW = 87_500
const IN_BAND = 90_000

function ctx(
  messages: Message[],
  tokenCount: number = IN_BAND,
): SpeculationContext {
  return {
    messages,
    tokenCount,
    thresholdTokens: THRESHOLD,
    model: 'test-model',
  }
}

/** Let the runner's promise chain settle. */
function flush(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0))
}

describe('createSpeculationManager band', () => {
  test('starts only inside [threshold - lead, threshold)', () => {
    let calls = 0
    const make = () =>
      createSpeculationManager({
        enabled: true,
        now: () => 0,
        runner: () => {
          calls++
          return 'summary'
        },
      })

    const below = make()
    expect(below.maybeStart(ctx([msg('u1')], BAND_LOW - 1))).toBe(false)

    const low = make()
    expect(low.maybeStart(ctx([msg('u1')], BAND_LOW))).toBe(true)

    const atThreshold = make()
    expect(atThreshold.maybeStart(ctx([msg('u1')], THRESHOLD))).toBe(false)

    const above = make()
    expect(above.maybeStart(ctx([msg('u1')], THRESHOLD + 1))).toBe(false)

    expect(calls).toBe(1)
  })

  test('does not start for an unknown window (threshold 0)', () => {
    const manager = createSpeculationManager({
      enabled: true,
      runner: () => 'summary',
    })
    expect(
      manager.maybeStart({
        messages: [msg('u1')],
        tokenCount: 10,
        thresholdTokens: 0,
        model: 'test-model',
      }),
    ).toBe(false)
  })
})

describe('createSpeculationManager arm and commit', () => {
  test('arms a result and commits it when the prefix is unchanged', async () => {
    const messages = [msg('u1'), msg('u2')]
    const manager = createSpeculationManager({
      enabled: true,
      now: () => 0,
      runner: async () => 'summary',
    })

    expect(manager.maybeStart(ctx(messages))).toBe(true)
    expect(manager.state()).toBe('running')

    await flush()
    expect(manager.state()).toBe('armed')
    expect(manager.consume(ctx(messages))).toEqual({
      result: 'summary',
      appendedMessages: [],
    })
    expect(manager.state()).toBe('idle')
  })

  test('forwards runnerContext into the snapshot', () => {
    let received: { tag: string } | undefined
    const manager = createSpeculationManager<string, { tag: string }>({
      enabled: true,
      runner: snapshot => {
        received = snapshot.runnerContext
        return 'summary'
      },
    })

    expect(
      manager.maybeStart({ ...ctx([msg('u1')]), runnerContext: { tag: 'x' } }),
    ).toBe(true)
    expect(received).toEqual({ tag: 'x' })
  })

  test('snapshots a frozen copy of the messages', () => {
    const messages = [msg('u1')]
    let snapshotMessages: readonly Message[] | undefined
    const manager = createSpeculationManager({
      enabled: true,
      runner: snapshot => {
        snapshotMessages = snapshot.messages
        return 'summary'
      },
    })

    manager.maybeStart(ctx(messages))
    expect(snapshotMessages).not.toBe(messages)
    expect(Object.isFrozen(snapshotMessages!)).toBe(true)
    // The message objects themselves are shared read-only references.
    expect(snapshotMessages![0]).toBe(messages[0])
  })
})

describe('createSpeculationManager invalidation', () => {
  test('commits with messages appended after the snapshot', async () => {
    const messages = [msg('u1'), msg('u2')]
    const appended = msg('u3')
    let signal: AbortSignal | undefined
    const manager = createSpeculationManager({
      enabled: true,
      runner: async snapshot => {
        signal = snapshot.signal
        return 'summary'
      },
    })

    manager.maybeStart(ctx(messages))
    await flush()
    const consumed = manager.consume(ctx([...messages, appended]))
    expect(consumed).toEqual({
      result: 'summary',
      appendedMessages: [appended],
    })
    // The appended turn is preserved; the run was not aborted.
    expect(consumed?.appendedMessages[0]).toBe(appended)
    expect(signal?.aborted).toBe(false)
    expect(manager.state()).toBe('idle')
  })

  test('commits with N appended messages after the snapshot', async () => {
    const messages = [msg('u1'), msg('u2')]
    const tail = [msg('u3'), msg('u4'), msg('u5')]
    const manager = createSpeculationManager({
      enabled: true,
      runner: async () => 'summary',
    })

    manager.maybeStart(ctx(messages))
    await flush()
    const consumed = manager.consume(ctx([...messages, ...tail]))
    expect(consumed?.result).toBe('summary')
    expect(consumed?.appendedMessages).toEqual(tail)
    expect(consumed?.appendedMessages).toHaveLength(3)
  })

  test('discards when the snapshot anchor is gone', async () => {
    const messages = [msg('u1'), msg('u2')]
    let signal: AbortSignal | undefined
    const manager = createSpeculationManager({
      enabled: true,
      runner: snapshot => {
        signal = snapshot.signal
        return 'summary'
      },
    })

    manager.maybeStart(ctx(messages))
    await flush()
    // Branch rewritten: the last snapshot message is no longer anywhere.
    expect(manager.consume(ctx([msg('u1'), msg('uX')]))).toBeUndefined()
    expect(signal?.aborted).toBe(true)
    expect(manager.state()).toBe('idle')
  })

  test('discards when the last uuid changed at the same length', async () => {
    const manager = createSpeculationManager({
      enabled: true,
      runner: async () => 'summary',
    })

    manager.maybeStart(ctx([msg('u1'), msg('u2')]))
    await flush()
    expect(manager.consume(ctx([msg('u1'), msg('uX')]))).toBeUndefined()
  })

  test('discards when the prefix changed but the anchor survived', async () => {
    const manager = createSpeculationManager({
      enabled: true,
      runner: async () => 'summary',
    })

    manager.maybeStart(ctx([msg('u1'), msg('u2'), msg('u3')]))
    await flush()
    // Same anchor/position, rewritten earlier history.
    expect(
      manager.consume(ctx([msg('uX'), msg('u2'), msg('u3')])),
    ).toBeUndefined()
  })

  test('discards when the transcript was truncated from the front', async () => {
    const manager = createSpeculationManager({
      enabled: true,
      runner: async () => 'summary',
    })

    manager.maybeStart(ctx([msg('u1'), msg('u2'), msg('u3')]))
    await flush()
    expect(manager.consume(ctx([msg('u2'), msg('u3')]))).toBeUndefined()
  })

  test('discards an in-flight run at threshold without blocking', () => {
    let signal: AbortSignal | undefined
    const manager = createSpeculationManager<string>({
      enabled: true,
      runner: snapshot => {
        signal = snapshot.signal
        return new Promise<string>(() => {})
      },
    })

    expect(manager.maybeStart(ctx([msg('u1')]))).toBe(true)
    expect(manager.consume(ctx([msg('u1')]))).toBeUndefined()
    expect(signal?.aborted).toBe(true)
    expect(manager.state()).toBe('idle')
    // The slot is free again.
    expect(manager.maybeStart(ctx([msg('u1')]))).toBe(true)
  })

  test('cancel aborts and discards an armed run', async () => {
    let signal: AbortSignal | undefined
    const manager = createSpeculationManager({
      enabled: true,
      runner: snapshot => {
        signal = snapshot.signal
        return 'summary'
      },
    })

    manager.maybeStart(ctx([msg('u1')]))
    manager.cancel()
    expect(signal?.aborted).toBe(true)
    expect(manager.state()).toBe('idle')
    await flush()
    expect(manager.consume(ctx([msg('u1')]))).toBeUndefined()
  })

  test('cancel releases an armed run and allows a later run to arm', async () => {
    const results = ['first', 'second']
    let calls = 0
    const manager = createSpeculationManager({
      enabled: true,
      runner: () => results[calls++]!,
    })

    expect(manager.maybeStart(ctx([msg('u1')]))).toBe(true)
    await flush()
    expect(manager.state()).toBe('armed')

    // Abort/exit path releases the frozen transcript + runner context.
    manager.cancel()
    expect(manager.state()).toBe('idle')

    // The `if (run)` slot guard must not keep speculation disabled forever.
    expect(manager.maybeStart(ctx([msg('u1')]))).toBe(true)
    await flush()
    expect(manager.consume(ctx([msg('u1')]))).toEqual({
      result: 'second',
      appendedMessages: [],
    })
  })

  test('discards an armed result older than its TTL at consume time', async () => {
    let clock = 0
    const manager = createSpeculationManager({
      enabled: true,
      now: () => clock,
      timeoutMs: 10_000,
      armedTtlMs: 500,
      runner: () => 'summary',
    })

    expect(manager.maybeStart(ctx([msg('u1')]))).toBe(true)
    await flush()
    expect(manager.state()).toBe('armed')

    // The run itself was fast (finishedAt - startedAt ≈ 0), but the result
    // sat armed past its TTL because the loop never reached the threshold.
    clock = 501
    expect(manager.consume(ctx([msg('u1')]))).toBeUndefined()
    expect(manager.state()).toBe('idle')
    // The slot is free after a stale discard.
    expect(manager.maybeStart(ctx([msg('u1')]))).toBe(true)
  })

  test('discards a snapshot whose last message has no uuid', async () => {
    let signal: AbortSignal | undefined
    const manager = createSpeculationManager({
      enabled: true,
      runner: snapshot => {
        signal = snapshot.signal
        return 'summary'
      },
    })
    const withoutUuid = [
      { type: 'user', message: { role: 'user', content: 'u1' } },
    ] as unknown as Message[]

    expect(manager.maybeStart(ctx(withoutUuid))).toBe(true)
    await flush()
    // Same length, rewritten tail: only the anchor uuid could prove the
    // snapshot is still a prefix, so no anchor means no commit.
    expect(manager.consume(ctx(withoutUuid))).toBeUndefined()
    expect(signal?.aborted).toBe(true)
    expect(manager.state()).toBe('idle')
  })
})

describe('createSpeculationManager concurrency', () => {
  test('starts at most one run at a time', async () => {
    let calls = 0
    let resolveRun: ((value: string) => void) | undefined
    const manager = createSpeculationManager<string>({
      enabled: true,
      runner: () => {
        calls++
        return new Promise<string>(resolve => {
          resolveRun = resolve
        })
      },
    })

    expect(manager.maybeStart(ctx([msg('u1')]))).toBe(true)
    expect(manager.maybeStart(ctx([msg('u1')]))).toBe(false)
    expect(calls).toBe(1)

    resolveRun!('summary')
    await flush()
    expect(manager.consume(ctx([msg('u1')]))).toEqual({
      result: 'summary',
      appendedMessages: [],
    })
  })
})

describe('createSpeculationManager failures', () => {
  test('is a no-op when disabled', async () => {
    let calls = 0
    const manager = createSpeculationManager({
      enabled: false,
      runner: () => {
        calls++
        return 'summary'
      },
    })

    expect(manager.maybeStart(ctx([msg('u1')]))).toBe(false)
    expect(manager.consume(ctx([msg('u1')]))).toBeUndefined()
    await flush()
    expect(calls).toBe(0)
    expect(manager.state()).toBe('idle')
  })

  test('discards a rejected run', async () => {
    const manager = createSpeculationManager<string>({
      enabled: true,
      runner: async () => {
        throw new Error('boom')
      },
    })

    expect(manager.maybeStart(ctx([msg('u1')]))).toBe(true)
    await flush()
    expect(manager.state()).toBe('idle')
    expect(manager.consume(ctx([msg('u1')]))).toBeUndefined()
  })

  test('discards a run that reports no result', async () => {
    const manager = createSpeculationManager<string | undefined>({
      enabled: true,
      runner: async () => undefined,
    })

    expect(manager.maybeStart(ctx([msg('u1')]))).toBe(true)
    await flush()
    expect(manager.state()).toBe('idle')
    expect(manager.consume(ctx([msg('u1')]))).toBeUndefined()
  })

  test('discards a run that finished after the timeout', async () => {
    let clock = 0
    let resolveRun: ((value: string) => void) | undefined
    const manager = createSpeculationManager<string>({
      enabled: true,
      now: () => clock,
      timeoutMs: 1_000,
      runner: () =>
        new Promise<string>(resolve => {
          resolveRun = resolve
        }),
    })

    expect(manager.maybeStart(ctx([msg('u1')]))).toBe(true)
    clock = 2_000
    resolveRun!('summary')
    await flush()

    expect(manager.state()).toBe('armed')
    expect(manager.consume(ctx([msg('u1')]))).toBeUndefined()
  })
})
