#!/usr/bin/env bun
/** Synthetic P0 microbenchmark, not a PTY, React, CLI or long-session benchmark. */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Writable } from 'node:stream'
import type { Frame } from '../packages/@ant/ink/src/core/frame.js'

export const BASELINE_COMMIT = 'ca18934c'
const LIMITS = {
  width: 512,
  height: 256,
  nodes: 4096,
  warmup: 1000,
  samples: 10000,
}
const DEFAULTS = {
  width: 120,
  height: 40,
  nodes: 200,
  warmup: 30,
  samples: 200,
}
export type Options = typeof DEFAULTS & { mode: 'all' | 'layout' | 'frame' }
export const HELP = `Usage: bun scripts/bench-ink.ts [--mode all|layout|frame]
  --width 120 --height 40 --nodes 200 --warmup 30 --samples 200
All numbers must be canonical positive decimal integers. Maximums:
  width=512 height=256 nodes=4096 warmup=1000 samples=10000
  width*height<=65536; (samples+warmup)*(width*height+nodes)<=50000000
--help runs without loading Ink dependencies. JSON-lines output.
Fixed synthetic fixture v1 (no random seed, no transcripts).
Scope: TS Yoga layout; Output -> LogUpdate -> optimize -> ANSI counting sink.
No PTY, real terminal I/O, React reconciliation, full CLI or long-session claims.
Baseline ca18934c is a reference commit, NOT a measured baseline or a speedup.
Repeat in independent processes for comparisons; no automatic performance gate.`

export function parseArgs(args: string[]): Options | null {
  if (args.length === 1 && args[0] === '--help') return null
  const result: Options = { ...DEFAULTS, mode: 'all' }
  const seen = new Set<string>()
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i]!
    if (!flag.startsWith('--')) throw new Error(`Unknown argument: ${flag}`)
    const key = flag.slice(2)
    if (seen.has(key)) throw new Error(`Duplicate argument: ${flag}`)
    seen.add(key)
    const value = args[i + 1]
    if (key === 'mode') {
      if (value !== 'all' && value !== 'layout' && value !== 'frame') {
        throw new Error('--mode must be all, layout or frame')
      }
      result.mode = value
      continue
    }
    if (!Object.hasOwn(LIMITS, key))
      throw new Error(`Unknown argument: ${flag}`)
    const name = key as keyof typeof LIMITS
    if (!value || !/^[1-9][0-9]*$/.test(value)) {
      throw new Error(`${flag} must be a positive decimal integer`)
    }
    const number = Number(value)
    if (!Number.isSafeInteger(number) || number > LIMITS[name]) {
      throw new Error(`${flag} exceeds safe maximum ${LIMITS[name]}`)
    }
    result[name] = number
  }
  const cells = result.width * result.height
  if (cells > 65536) throw new Error('Screen capacity exceeds 65536 cells')
  if ((result.samples + result.warmup) * (cells + result.nodes) > 50000000) {
    throw new Error('Aggregate work capacity exceeds 50000000 units')
  }
  return result
}

/** Nearest-rank percentiles, no interpolation; input must be nonempty and finite. */
export function summarize(values: readonly number[]) {
  if (!values.length || values.some(x => !Number.isFinite(x) || x < 0)) {
    throw new Error('Statistics require nonempty finite nonnegative samples')
  }
  const sorted = [...values].sort((a, b) => a - b)
  const percentile = (p: number) => sorted[Math.ceil(p * sorted.length) - 1]!
  return {
    count: sorted.length,
    min: sorted[0]!,
    p50: percentile(0.5),
    p95: percentile(0.95),
    p99: percentile(0.99),
    max: sorted.at(-1)!,
  }
}

function invariant(ok: boolean, message: string): asserts ok {
  if (!ok) throw new Error(`Fixture invariant failed: ${message}`)
}
function memory() {
  const m = process.memoryUsage()
  return {
    jsHeapUsedBytes: m.heapUsed,
    jsHeapTotalBytes: m.heapTotal,
    processRssBytes: m.rss,
    externalReportedBytes: m.external,
    arrayBuffersReportedBytes: m.arrayBuffers,
  }
}
function emit(value: unknown) {
  console.log(JSON.stringify(value))
}

async function layoutBenchmark(o: Options) {
  const { createYogaLayoutNode } = await import(
    '../packages/@ant/ink/src/core/layout/yoga.js'
  )
  const root = createYogaLayoutNode()
  const children = []
  try {
    root.setFlexDirection('column')
    for (let i = 0; i < o.nodes; i++) {
      const child = createYogaLayoutNode()
      child.setHeight(1)
      child.setFlexShrink(0)
      child.setWidthPercent(100)
      root.insertChild(child, i)
      children.push(child)
    }
    const times: number[] = []
    let checksum = 0
    let before = memory()
    for (let i = 0; i < o.warmup + o.samples; i++) {
      if (i === o.warmup) before = memory()
      const width = o.width + (i % 2)
      root.setWidth(width) // Real geometry change, not repeated cached calculateLayout.
      const start = performance.now()
      root.calculateLayout(width)
      const elapsed = performance.now() - start
      invariant(
        root.getComputedWidth() === width &&
          root.getComputedHeight() === o.nodes,
        'root geometry',
      )
      for (let j = 0; j < children.length; j++) {
        const child = children[j]!
        invariant(
          child.getComputedWidth() === width &&
            child.getComputedHeight() === 1 &&
            child.getComputedTop() === j,
          'child geometry',
        )
        if (i >= o.warmup) checksum += width + j + 1
      }
      if (i >= o.warmup) times.push(elapsed)
    }
    return {
      scenario: 'layout-changing-width',
      layoutMs: summarize(times),
      checksum,
      memoryBeforeSamples: before,
      memoryAfterSamples: memory(),
      timing: 'calculateLayout only; mutations and geometry checks excluded',
    }
  } finally {
    root.freeRecursive()
  }
}

async function frameBenchmarks(o: Options) {
  // Real modules only: import failure is fatal, never substitute an algorithm.
  const s = await import('../packages/@ant/ink/src/core/screen.js')
  const { default: Output } = await import(
    '../packages/@ant/ink/src/core/output.js'
  )
  const { LogUpdate } = await import(
    '../packages/@ant/ink/src/core/log-update.js'
  )
  const { optimize } = await import(
    '../packages/@ant/ink/src/core/optimizer.js'
  )
  const { writeDiffToTerminal } = await import(
    '../packages/@ant/ink/src/core/terminal.js'
  )
  for (const scenario of ['sparse', 'dense', 'static'] as const) {
    const styles = new s.StylePool()
    const chars = new s.CharPool()
    const links = new s.HyperlinkPool()
    const screens = [0, 1].map(() =>
      s.createScreen(o.width, o.height, styles, chars, links),
    )
    const output = new Output({
      width: o.width,
      height: o.height,
      stylePool: styles,
      screen: screens[0]!,
    })
    const updater = new LogUpdate({ isTTY: true, stylePool: styles })
    const frame = (screen: (typeof screens)[number]): Frame => ({
      screen,
      viewport: { width: o.width, height: o.height + 1 },
      // 主屏输出完成后的光标位于内容下一行，静止帧不需要归位。
      cursor: { x: 0, y: o.height, visible: true },
    })
    const lines = ['A', 'B'].map(letter =>
      Array.from({ length: o.height }, (_, y) =>
        scenario === 'dense'
          ? letter.repeat(o.width)
          : (y === 0 ? letter : 'x') + 'x'.repeat(o.width - 1),
      ),
    )
    const paint = (index: number, phase: number) => {
      output.reset(o.width, o.height, screens[index]!)
      for (let y = 0; y < o.height; y++) output.write(0, y, lines[phase]![y]!)
      return output.get()
    }
    let previous = frame(paint(0, 0))
    let bytes = 0
    let wire = ''
    // A real Writable transport counts serialized UTF-8, not a mocked Ink algorithm.
    const sink = new Writable({
      write(chunk, _encoding, done) {
        bytes += chunk.length
        wire += chunk.toString('utf8')
        done()
      },
    })
    const phases = {
      paint: [] as number[],
      diff: [] as number[],
      optimize: [] as number[],
      serializeToSink: [] as number[],
      total: [] as number[],
    }
    const rawCounts: number[] = [],
      optimizedCounts: number[] = [],
      byteCounts: number[] = []
    let checksum = 0
    let before = memory()
    try {
      for (let i = 0; i < o.warmup + o.samples; i++) {
        if (i === o.warmup) before = memory()
        bytes = 0
        wire = ''
        const phase = scenario === 'static' ? 0 : (i + 1) % 2
        const start = performance.now()
        const next = frame(paint((i + 1) % 2, phase))
        const painted = performance.now()
        const patches = updater.render(previous, next)
        const diffed = performance.now()
        const optimized = optimize(patches)
        const optimizedAt = performance.now()
        writeDiffToTerminal({ stdout: sink, stderr: sink }, optimized, true)
        const ended = performance.now()
        const expected = phase === 0 ? 'A' : 'B'
        invariant(
          s.charInCellAt(next.screen, 0, 0) === expected,
          'painted marker',
        )
        if (scenario === 'static') {
          invariant(
            bytes === 0 && optimized.length === 0,
            'static frame must not output',
          )
        } else {
          invariant(
            s.charInCellAt(previous.screen, 0, 0) !== expected,
            'frame must change',
          )
          invariant(
            patches.length > 0 && bytes > 0 && wire.includes(expected),
            'changed marker reaches serialized output',
          )
          invariant(
            !patches.some(p => p.type === 'clearTerminal'),
            'fixed viewport must not reset',
          )
        }
        // Full screen semantics checked outside measured region, not just one marker.
        for (let y = 0; y < o.height; y++) {
          for (let x = 0; x < o.width; x++) {
            const actual = s.charInCellAt(next.screen, x, y)
            invariant(actual === lines[phase]![y]![x], 'screen content')
            if (i >= o.warmup)
              checksum = (Math.imul(checksum, 31) + actual!.charCodeAt(0)) >>> 0
          }
        }
        if (i >= o.warmup) {
          phases.paint.push(painted - start)
          phases.diff.push(diffed - painted)
          phases.optimize.push(optimizedAt - diffed)
          phases.serializeToSink.push(ended - optimizedAt)
          phases.total.push(ended - start)
          rawCounts.push(patches.length)
          optimizedCounts.push(optimized.length)
          byteCounts.push(bytes)
        }
        previous = next
      }
      emit({
        scenario: `frame-${scenario}`,
        phasesMs: Object.fromEntries(
          Object.entries(phases).map(([k, v]) => [k, summarize(v)]),
        ),
        patchesBeforeOptimize: summarize(rawCounts),
        patchesAfterOptimize: summarize(optimizedCounts),
        utf8Bytes: summarize(byteCounts),
        totalUtf8Bytes: byteCounts.reduce((a, b) => a + b, 0),
        checksum,
        memoryBeforeSamples: before,
        memoryAfterSamples: memory(),
      })
    } finally {
      sink.destroy()
    }
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (!options) {
    console.log(HELP)
    return
  }
  const repo = fileURLToPath(new URL('../', import.meta.url))
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim()
  const status = git('status', '--porcelain', '--untracked-files=normal')
  emit({
    type: 'metadata',
    baselineCommit: BASELINE_COMMIT,
    baselineMeasured: false,
    revision: git('rev-parse', 'HEAD'),
    dirty: status.length > 0,
    gitStatus: status,
    bunVersion: process.versions.bun ?? null,
    nodeCompatibilityVersion: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    lockfileSha256: createHash('sha256')
      .update(readFileSync(new URL('../bun.lock', import.meta.url)))
      .digest('hex'),
    options,
    fixture: 'synthetic-ascii-v1; deterministic alternating A/B; no RNG',
    percentileMethod: 'nearest-rank',
    scope:
      'microbenchmark only; no React/PTY/full CLI/real terminal I/O; layout separate from frame processing',
    phaseMapping:
      'FrameEvent yoga=layout; renderer approximated by Output paint only; diff/optimize real; write=serialization + in-memory Writable sink, not terminal latency; no commit timing',
    memoryCaveat:
      'process.memoryUsage snapshots, not peaks; JS heap and process RSS are distinct; not native allocation accounting, not post-GC live bytes; no forced GC',
    timingCaveat:
      'warmup discarded; checks and memory snapshots outside timers; imports/setup excluded; counting sink overhead included; repeat independent processes',
  })
  if (options.mode !== 'frame') emit(await layoutBenchmark(options))
  if (options.mode !== 'layout') await frameBenchmarks(options)
  emit({ type: 'complete', scope: options.mode, p0Complete: false })
}

if (import.meta.main) {
  main().catch(error => {
    console.error(
      `bench-ink FAILED (no fallback; any preceding results are PARTIAL): ${error instanceof Error ? error.stack || error.message || String(error) : String(error)}`,
    )
    process.exitCode = 1
  })
}
