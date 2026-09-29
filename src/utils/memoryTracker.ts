import { appendFile, mkdir } from 'fs/promises'
import { join } from 'path'

// Memory instrumentation, complementing debugMemorySampler.ts (which only
// samples in debug mode and only logs a line). This module:
// 1. Samples RSS every 30s, pausing while the session is idle.
// 2. Keeps a small ring buffer of recently-recorded operation names
//    (`recordMemoryOp`) so a threshold snapshot can attribute growth to
//    something concrete instead of just reporting a number.
// 3. When RSS crosses the configured threshold (default 1.5GB), emits ONE
//    snapshot per breach episode: tengu_memory_threshold (numeric metadata
//    only — analytics metadata must never carry strings) plus a local JSON
//    line under <config>/telemetry/memory/.
// Re-arms once RSS falls back below the threshold, so a sustained leak
// produces repeated episodes instead of a single event lost in the noise.

const MEMORY_SAMPLE_INTERVAL_MS = 30_000
const DEFAULT_MEMORY_THRESHOLD_MB = 1536
export const TOP_OPS_CAPACITY = 8

function getThresholdMb(): number {
  const raw = process.env.CLAUDE_CODE_MEMORY_THRESHOLD_MB
  if (raw === undefined || raw === '') return DEFAULT_MEMORY_THRESHOLD_MB
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_MEMORY_THRESHOLD_MB
}

export type MemorySample = {
  rss: number
  heapUsed: number
  heapTotal: number
  external: number
}

export type MemorySnapshot = {
  ts: number
  rss: number
  heapUsed: number
  heapTotal: number
  external: number
  topOps: string[]
}

/** Ring buffer of recent operation names, capped at TOP_OPS_CAPACITY. */
export class MemoryOpRingBuffer {
  private ops: string[] = []

  push(op: string): void {
    this.ops.push(op)
    if (this.ops.length > TOP_OPS_CAPACITY) {
      this.ops.shift()
    }
  }

  /** Oldest → newest, at most TOP_OPS_CAPACITY entries. */
  snapshot(): string[] {
    return [...this.ops]
  }

  clear(): void {
    this.ops.length = 0
  }
}

export type MemoryTrackerOptions = {
  /** Override the RSS sampler (defaults to process.memoryUsage). */
  sample?: () => MemorySample | null
  /** RSS threshold MB (env CLAUDE_CODE_MEMORY_THRESHOLD_MB, default 1.5GB). */
  thresholdMb?: number
  /** Pause sampling when true (default: false; prod wires activityManager). */
  isIdle?: () => boolean
  /** Snapshot sink (default: logEvent + local JSONL append). */
  onSnapshot?: (snapshot: MemorySnapshot) => void
}

export type MemoryTracker = {
  recordOp: (op: string) => void
  getTopOps: () => string[]
  /** Run one sampling pass. Returns the snapshot if one was emitted. */
  tick: (now?: number) => MemorySnapshot | null
  start: (intervalMs?: number) => void
  stop: () => void
}

export function createMemoryTracker(
  options: MemoryTrackerOptions = {},
): MemoryTracker {
  const sample = options.sample ?? ((): MemorySample => process.memoryUsage())
  const onSnapshot =
    options.onSnapshot ??
    ((): void => {
      /* no-op sink; startMemoryTracker wires the real one */
    })
  const isIdle = options.isIdle ?? ((): boolean => false)
  const thresholdMb = options.thresholdMb ?? getThresholdMb()
  const thresholdBytes = thresholdMb * 1048576
  const ring = new MemoryOpRingBuffer()
  // One snapshot per breach episode: re-arms after RSS drops back below.
  let inBreach = false
  let timer: ReturnType<typeof setInterval> | null = null

  function tick(now?: number): MemorySnapshot | null {
    if (isIdle()) return null
    const mem = sample()
    if (mem === null) return null
    if (mem.rss > thresholdBytes) {
      if (inBreach) return null
      inBreach = true
      const snapshot: MemorySnapshot = {
        ts: now ?? Date.now(),
        rss: mem.rss,
        heapUsed: mem.heapUsed,
        heapTotal: mem.heapTotal,
        external: mem.external,
        topOps: ring.snapshot(),
      }
      onSnapshot(snapshot)
      return snapshot
    }
    inBreach = false
    return null
  }

  return {
    recordOp: (op: string) => ring.push(op),
    getTopOps: () => ring.snapshot(),
    tick,
    start: (intervalMs = MEMORY_SAMPLE_INTERVAL_MS) => {
      if (timer !== null) return
      timer = setInterval(() => {
        tick()
      }, intervalMs)
      // Long-lived process either way, but never let the tracker alone keep
      // the event loop alive.
      timer.unref?.()
    },
    stop: () => {
      if (timer !== null) {
        clearInterval(timer)
        timer = null
      }
    },
  }
}

// ---------------------------------------------------------------------------
// Module-level singleton for the CLI process. recordMemoryOp is the public
// entry point for code that wants to leave breadcrumbs in the next threshold
// snapshot.
// ---------------------------------------------------------------------------

// Idle gate starts closed (never idle) and is swapped in by
// startMemoryTracker once activityManager finishes loading.
let idleGate: () => boolean = (): boolean => false

const moduleTracker = createMemoryTracker({
  isIdle: () => idleGate(),
  onSnapshot: writeSnapshot,
})

export function recordMemoryOp(op: string): void {
  moduleTracker.recordOp(op)
}

async function writeSnapshot(snapshot: MemorySnapshot): Promise<void> {
  try {
    // Lazy import: analytics + envUtils pull config machinery we don't want
    // on the import graph of every consumer of recordMemoryOp.
    const [{ logEvent }, { getClaudeConfigHomeDir }] = await Promise.all([
      import('../services/analytics/index.js'),
      import('./envUtils.js'),
    ])
    logEvent('tengu_memory_threshold', {
      rss_mb: Math.round(snapshot.rss / 1048576),
      heap_mb: Math.round(snapshot.heapUsed / 1048576),
    })
    const dir = join(getClaudeConfigHomeDir(), 'telemetry', 'memory')
    await mkdir(dir, { recursive: true })
    const line = `${JSON.stringify(snapshot)}\n`
    await appendFile(join(dir, 'memory-thresholds.jsonl'), line, 'utf8')
  } catch {
    // Telemetry is best-effort; never surface failures here.
  }
}

/**
 * Start the process-wide RSS sampler. Idempotent; safe to call from multiple
 * bootstrap paths. The idle check is wired via dynamic import so importing
 * this module doesn't drag bootstrap/state onto every consumer.
 */
export function startMemoryTracker(): void {
  void import('./activityManager.js').then(({ activityManager }) => {
    idleGate = (): boolean => {
      const states = activityManager.getActivityStates()
      return !states.isUserActive && !states.isCLIActive
    }
  })
  moduleTracker.start()
}

/** Stop the sampler (used by cleanup and tests). */
export function stopMemoryTracker(): void {
  moduleTracker.stop()
}
