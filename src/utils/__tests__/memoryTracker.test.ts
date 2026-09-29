import { describe, expect, test } from 'bun:test'
import {
  createMemoryTracker,
  TOP_OPS_CAPACITY,
  type MemorySnapshot,
} from '../memoryTracker'

const MB = 1048576

function sampleOf(rss: number): {
  rss: number
  heapUsed: number
  heapTotal: number
  external: number
} {
  return {
    rss,
    heapUsed: Math.floor(rss / 2),
    heapTotal: Math.floor(rss / 1.5),
    external: 1024,
  }
}

describe('MemoryOpRingBuffer via createMemoryTracker.recordOp', () => {
  test('returns ops in insertion order while under capacity', () => {
    const tracker = createMemoryTracker()
    tracker.recordOp('op1')
    tracker.recordOp('op2')
    expect(tracker.getTopOps()).toEqual(['op1', 'op2'])
  })

  test('evicts the oldest op beyond capacity, keeping the last 8', () => {
    const tracker = createMemoryTracker()
    for (let i = 0; i < TOP_OPS_CAPACITY + 4; i++) {
      tracker.recordOp(`op${i}`)
    }
    const ops = tracker.getTopOps()
    expect(ops).toHaveLength(TOP_OPS_CAPACITY)
    expect(ops[0]).toBe('op4')
    expect(ops[ops.length - 1]).toBe(`op${TOP_OPS_CAPACITY + 3}`)
  })

  test('snapshot is a copy — mutating it does not affect the buffer', () => {
    const tracker = createMemoryTracker()
    tracker.recordOp('a')
    const ops = tracker.getTopOps()
    ops.push('mutated')
    expect(tracker.getTopOps()).toEqual(['a'])
  })
})

describe('createMemoryTracker tick threshold logic', () => {
  test('no snapshot while RSS is below threshold', () => {
    const snapshots: MemorySnapshot[] = []
    const tracker = createMemoryTracker({
      sample: () => sampleOf(100 * MB),
      thresholdMb: 200,
      onSnapshot: s => snapshots.push(s),
    })
    expect(tracker.tick(1000)).toBeNull()
    expect(snapshots).toHaveLength(0)
  })

  test('emits one snapshot on first crossing with the injected sample', () => {
    const snapshots: MemorySnapshot[] = []
    const tracker = createMemoryTracker({
      sample: () => sampleOf(300 * MB),
      thresholdMb: 200,
      onSnapshot: s => snapshots.push(s),
    })
    const snapshot = tracker.tick(1234)
    expect(snapshot).not.toBeNull()
    expect(snapshots).toHaveLength(1)
    expect(snapshot!.ts).toBe(1234)
    expect(snapshot!.rss).toBe(300 * MB)
    expect(snapshot!.heapUsed).toBe(150 * MB)
    expect(snapshot!.heapTotal).toBe(200 * MB)
    expect(snapshot!.external).toBe(1024)
    expect(snapshot!.topOps).toEqual([])
  })

  test('does not re-emit while sustained above the threshold', () => {
    const snapshots: MemorySnapshot[] = []
    const tracker = createMemoryTracker({
      sample: () => sampleOf(300 * MB),
      thresholdMb: 200,
      onSnapshot: s => snapshots.push(s),
    })
    tracker.tick(1)
    expect(tracker.tick(2)).toBeNull()
    expect(tracker.tick(3)).toBeNull()
    expect(snapshots).toHaveLength(1)
  })

  test('re-arms once RSS drops back below the threshold', () => {
    const snapshots: MemorySnapshot[] = []
    let rss = 300 * MB
    const tracker = createMemoryTracker({
      sample: () => sampleOf(rss),
      thresholdMb: 200,
      onSnapshot: s => snapshots.push(s),
    })
    tracker.tick(1)
    rss = 100 * MB
    tracker.tick(2)
    rss = 300 * MB
    const second = tracker.tick(3)
    expect(second).not.toBeNull()
    expect(snapshots).toHaveLength(2)
    expect(second!.ts).toBe(3)
  })

  test('pauses sampling while idle — no snapshot above threshold', () => {
    const snapshots: MemorySnapshot[] = []
    const tracker = createMemoryTracker({
      sample: () => sampleOf(300 * MB),
      thresholdMb: 200,
      isIdle: () => true,
      onSnapshot: s => snapshots.push(s),
    })
    expect(tracker.tick(1)).toBeNull()
    expect(snapshots).toHaveLength(0)
  })

  test('snapshot includes ops recorded before the breach', () => {
    const snapshots: MemorySnapshot[] = []
    const tracker = createMemoryTracker({
      sample: () => sampleOf(300 * MB),
      thresholdMb: 200,
      onSnapshot: s => snapshots.push(s),
    })
    tracker.recordOp('BashTool')
    tracker.recordOp('AgentTool')
    const snapshot = tracker.tick(1)
    expect(snapshot!.topOps).toEqual(['BashTool', 'AgentTool'])
    expect(snapshots[0]!.topOps).toEqual(['BashTool', 'AgentTool'])
  })

  test('handles a sampler that returns null (skip the tick)', () => {
    const snapshots: MemorySnapshot[] = []
    const tracker = createMemoryTracker({
      sample: () => null,
      thresholdMb: 200,
      onSnapshot: s => snapshots.push(s),
    })
    expect(tracker.tick(1)).toBeNull()
    expect(snapshots).toHaveLength(0)
  })

  test('default threshold reads CLAUDE_CODE_MEMORY_THRESHOLD_MB', () => {
    process.env.CLAUDE_CODE_MEMORY_THRESHOLD_MB = '50'
    try {
      const snapshots: MemorySnapshot[] = []
      const tracker = createMemoryTracker({
        sample: () => sampleOf(100 * MB),
        onSnapshot: s => snapshots.push(s),
      })
      expect(tracker.tick(1)).not.toBeNull()
    } finally {
      delete process.env.CLAUDE_CODE_MEMORY_THRESHOLD_MB
    }
  })
})
