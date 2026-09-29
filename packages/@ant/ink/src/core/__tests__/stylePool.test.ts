import { describe, expect, test } from 'bun:test'
import type { AnsiCode } from '../screen.js'
import { StylePool } from '../screen.js'

function sgr(code: string, endCode: string): AnsiCode {
  return { type: 'ansi', code, endCode }
}

const RED_FG = sgr('\x1b[31m', '\x1b[39m')
const BLUE_BG = sgr('\x1b[44m', '\x1b[49m') // visible on spaces
const BOLD = sgr('\x1b[1m', '\x1b[22m')

describe('StylePool.transition', () => {
  test('transition cache hits return the same string without recompute', () => {
    const pool = new StylePool()
    const a = pool.intern([RED_FG])
    const b = pool.intern([RED_FG, BOLD])

    const first = pool.transition(a, b)
    expect(first).toBe('\x1b[1m')
    // Second call is served from transitionCache — same result.
    expect(pool.transition(a, b)).toBe(first)
    // Reverse direction is a distinct cache entry.
    expect(pool.transition(b, a)).toBe('\x1b[22m')
    // Same-ID transition is the empty string (no-op), both directions.
    expect(pool.transition(a, a)).toBe('')
    expect(pool.transition(pool.none, pool.none)).toBe('')
  })

  test('transition survives compact() (IDs stable, cache preserved)', () => {
    const pool = new StylePool()
    const a = pool.intern([RED_FG])
    const b = pool.intern([BLUE_BG])
    const warm = pool.transition(a, b)

    pool.compact()
    expect(pool.transition(a, b)).toBe(warm)
  })
})

describe('StylePool.needsCompaction', () => {
  test('small pool with small frame never needs compaction', () => {
    const pool = new StylePool()
    expect(pool.needsCompaction(0)).toBe(false)
    expect(pool.needsCompaction(1000)).toBe(false)
  })

  test('threshold boundary: max(4096, 2n) — floor dominates for small frames', () => {
    const pool = new StylePool()
    // Fill up to exactly 4096 entries (incl. `none`) — at the floor, not above.
    for (let i = 1; pool.size < 4096; i++) {
      pool.intern([sgr(`\x1b[${30 + (i % 8)}m`, '\x1b[39m')])
    }
    expect(pool.size).toBe(4096)
    expect(pool.needsCompaction(0)).toBe(false)

    // One more entry crosses the floor (4096 > max(4096, 2n) for 2n ≤ 4096).
    pool.intern([BOLD])
    expect(pool.size).toBe(4097)
    expect(pool.needsCompaction(0)).toBe(true)
    // Large frames raise the bar: 2n ≥ size keeps it under the threshold.
    expect(pool.needsCompaction(4096)).toBe(false)
    expect(pool.needsCompaction(10_000)).toBe(false)
  })

  test('2n dominates for large frames', () => {
    const pool = new StylePool()
    // 100 entries ≤ max(4096, 2n) for any frame ≥ 50 cells.
    expect(pool.needsCompaction(50)).toBe(false)
    expect(pool.needsCompaction(10_000)).toBe(false)
  })

  test('overflowWarned forces compaction regardless of size', () => {
    const pool = new StylePool()
    expect(pool.overflowed).toBe(false)
    expect(pool.needsCompaction(10_000)).toBe(false)

    pool.overflowWarned = true
    expect(pool.overflowed).toBe(true)
    expect(pool.isNearCapacity).toBe(false)
    expect(pool.needsCompaction(10_000)).toBe(true)
    expect(pool.needsCompaction(0)).toBe(true)
  })

  test('isNearCapacity tracks 75% of the inferred 4096 floor', () => {
    const pool = new StylePool()
    expect(pool.isNearCapacity).toBe(false)
    for (let i = 0; pool.size < 3072; i++) {
      pool.intern([sgr(`\x1b[${90 + (i % 8)}m`, '\x1b[39m')])
    }
    expect(pool.size).toBe(3072)
    expect(pool.isNearCapacity).toBe(true)
  })
})

describe('StylePool.compact', () => {
  test('intern consistency: dedup and IDs unchanged after compact', () => {
    const pool = new StylePool()
    const a = pool.intern([RED_FG])
    const b = pool.intern([RED_FG, BOLD])
    const none = pool.none

    pool.compact()
    expect(pool.generationCount).toBe(1)

    // Existing IDs still resolve to the same style arrays.
    expect(pool.get(a)).toEqual([RED_FG])
    expect(pool.get(b)).toEqual([RED_FG, BOLD])
    expect(pool.get(none)).toEqual([])
    // Re-interning the same style returns the SAME id (no duplicates).
    expect(pool.intern([RED_FG])).toBe(a)
    expect(pool.intern([RED_FG, BOLD])).toBe(b)
    expect(pool.intern([])).toBe(none)
    // Bit-0 "visible on space" flag is preserved by the rebuild.
    expect(pool.intern([BLUE_BG]) & 1).toBe(1)
    expect(a & 1).toBe(0)
  })

  test('compact is idempotent and does not shrink the pool', () => {
    const pool = new StylePool()
    pool.intern([RED_FG])
    pool.intern([BOLD])
    const before = pool.size

    pool.compact()
    pool.compact()
    expect(pool.size).toBe(before)
    expect(pool.generationCount).toBe(2)
  })

  test('derivative caches keep working after compact', () => {
    const pool = new StylePool()
    const base = pool.intern([RED_FG])
    const inv = pool.withInverse(base)
    expect(pool.get(inv).some(c => c.endCode === '\x1b[27m')).toBe(true)

    pool.compact()
    expect(pool.withInverse(base)).toBe(inv)
    expect(pool.intern([RED_FG])).toBe(base)
  })
})
