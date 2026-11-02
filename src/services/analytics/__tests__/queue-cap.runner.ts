import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  __getEventQueueLengthForTesting,
  __MAX_QUEUED_EVENTS_FOR_TESTING,
  _resetForTesting,
  attachAnalyticsSink,
  logEvent,
  logEventAsync,
  type AnalyticsSink,
} from '../index.js'

// Explicitly launched by queue-cap.test.ts; not discovered by bun test.
// Do not mock analytics here or import startup code that attaches a sink.
const CAP = 5_000

type Delivery = {
  eventName: string
  metadata: Parameters<AnalyticsSink['logEvent']>[1]
  async: boolean
}

function recordingSink() {
  const deliveries: Delivery[] = []
  const sink: AnalyticsSink = {
    logEvent: (eventName, metadata) => {
      deliveries.push({ eventName, metadata, async: false })
    },
    logEventAsync: async (eventName, metadata) => {
      deliveries.push({ eventName, metadata, async: true })
    },
  }
  return { deliveries, sink }
}

describe('analytics event queue cap', () => {
  beforeEach(() => {
    _resetForTesting()
    expect(__getEventQueueLengthForTesting()).toBe(0)
    expect(__MAX_QUEUED_EVENTS_FOR_TESTING).toBe(CAP)
  })

  afterEach(async () => {
    // Let any scheduled drain finish before clearing the sink it uses.
    await Promise.resolve()
    _resetForTesting()
  })

  test('drops the oldest events once the cap is exceeded', async () => {
    const overflow = 25
    for (let i = 0; i < CAP + overflow; i += 1) {
      logEvent('test_event', { i })
      expect(__getEventQueueLengthForTesting()).toBe(Math.min(i + 1, CAP))
    }

    const { deliveries, sink } = recordingSink()
    attachAnalyticsSink(sink)
    expect(__getEventQueueLengthForTesting()).toBe(0)
    expect(deliveries).toEqual([])
    await Promise.resolve()
    expect(deliveries).toEqual(
      Array.from({ length: CAP }, (_, i) => ({
        eventName: 'test_event',
        metadata: { i: i + overflow },
        async: false,
      })),
    )
    // Reattaching must neither replay the queue nor replace the active sink.
    const replacement = recordingSink()
    attachAnalyticsSink(replacement.sink)
    logEvent('after_attach', { i: CAP + overflow })
    await Promise.resolve()
    expect(deliveries).toHaveLength(CAP + 1)
    expect(deliveries[CAP]).toEqual({
      eventName: 'after_attach',
      metadata: { i: CAP + overflow },
      async: false,
    })
    expect(replacement.deliveries).toEqual([])
    expect(__getEventQueueLengthForTesting()).toBe(0)
  })

  test('async events share the same bounded queue', async () => {
    const overflow = 10
    // Mixed traffic distinguishes a shared queue from two separately capped
    // queues, and verifies that draining preserves each event's delivery API.
    for (let i = 0; i < CAP + overflow; i += 1) {
      if (i % 2 === 0) {
        logEvent('test_event', { i })
      } else {
        await logEventAsync('test_event_async', { i })
      }
      expect(__getEventQueueLengthForTesting()).toBe(Math.min(i + 1, CAP))
    }

    const { deliveries, sink } = recordingSink()
    attachAnalyticsSink(sink)
    expect(__getEventQueueLengthForTesting()).toBe(0)
    expect(deliveries).toEqual([])
    await Promise.resolve()
    expect(deliveries).toEqual(
      Array.from({ length: CAP }, (_, offset) => {
        const i = offset + overflow
        return {
          eventName: i % 2 === 0 ? 'test_event' : 'test_event_async',
          metadata: { i },
          async: i % 2 !== 0,
        }
      }),
    )
    await logEventAsync('after_attach_async', { i: CAP + overflow })
    expect(deliveries).toHaveLength(CAP + 1)
    expect(deliveries[CAP]).toEqual({
      eventName: 'after_attach_async',
      metadata: { i: CAP + overflow },
      async: true,
    })
    expect(__getEventQueueLengthForTesting()).toBe(0)
  })

  test('reset clears pending events and detaches the sink', async () => {
    logEvent('discard_sync', { i: 0 })
    await logEventAsync('discard_async', { i: 1 })
    expect(__getEventQueueLengthForTesting()).toBe(2)
    _resetForTesting()
    expect(__getEventQueueLengthForTesting()).toBe(0)

    const old = recordingSink()
    attachAnalyticsSink(old.sink)
    await Promise.resolve()
    expect(old.deliveries).toEqual([])
    logEvent('old_sink', { i: 2 })
    expect(old.deliveries).toEqual([
      { eventName: 'old_sink', metadata: { i: 2 }, async: false },
    ])
    _resetForTesting()
    logEvent('fresh_sync', { i: 3 })
    await logEventAsync('fresh_async', { i: 4 })
    expect(__getEventQueueLengthForTesting()).toBe(2)
    expect(old.deliveries).toHaveLength(1)

    const fresh = recordingSink()
    attachAnalyticsSink(fresh.sink)
    expect(__getEventQueueLengthForTesting()).toBe(0)
    expect(fresh.deliveries).toEqual([])
    await Promise.resolve()
    expect(fresh.deliveries).toEqual([
      { eventName: 'fresh_sync', metadata: { i: 3 }, async: false },
      { eventName: 'fresh_async', metadata: { i: 4 }, async: true },
    ])
    expect(old.deliveries).toHaveLength(1)
  })
})
