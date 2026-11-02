import { describe, expect, test } from 'bun:test'
import { BASELINE_COMMIT, parseArgs, summarize } from './bench-ink.js'

describe('bench-ink pure CLI validation (no Ink imports or mocks)', () => {
  test('defaults and independent help', () => {
    expect(BASELINE_COMMIT).toBe('ca18934c')
    expect(parseArgs(['--help'])).toBeNull()
    expect(parseArgs([])).toEqual({
      width: 120,
      height: 40,
      nodes: 200,
      warmup: 30,
      samples: 200,
      mode: 'all',
    })
    expect(
      parseArgs([
        '--width',
        '1',
        '--height',
        '1',
        '--nodes',
        '1',
        '--samples',
        '1',
        '--warmup',
        '1',
        '--mode',
        'layout',
      ])?.width,
    ).toBe(1)
  })
  for (const value of [
    '0',
    '-1',
    '+1',
    '1.5',
    '1e2',
    '0x10',
    'NaN',
    'Infinity',
    '',
    ' 2',
    '02',
    '9007199254740992',
    '9'.repeat(400),
  ]) {
    test(`rejects invalid integer ${JSON.stringify(value)}`, () => {
      expect(() => parseArgs(['--samples', value])).toThrow()
    })
  }
  for (const args of [
    ['--width'],
    ['--width', '--height'],
    ['width', '1'],
    ['--wat', '1'],
    ['--samples', '1', '--samples', '2'],
    ['--mode', 'unknown'],
    ['--mode'],
    ['--help', '--samples', '1'],
    ['--width', '513'],
    ['--height', '257'],
    ['--nodes', '4097'],
    ['--samples', '10001'],
    ['--warmup', '1001'],
    ['--width', '512', '--height', '256'],
    ['--width', '256', '--height', '256', '--samples', '1000'],
  ]) {
    test(`rejects invalid/capacity arguments ${args.join(' ')}`, () => {
      expect(() => parseArgs(args)).toThrow()
    })
  }
  test('accepts capacity boundaries with bounded aggregate work', () => {
    expect(
      parseArgs([
        '--width',
        '256',
        '--height',
        '256',
        '--samples',
        '1',
        '--warmup',
        '1',
      ])?.height,
    ).toBe(256)
    expect(
      parseArgs([
        '--width',
        '1',
        '--height',
        '1',
        '--nodes',
        '1',
        '--samples',
        '10000',
        '--warmup',
        '1000',
      ])?.samples,
    ).toBe(10000)
  })
})

describe('bench-ink standalone CLI (no Ink mocks)', () => {
  const script = new URL('./bench-ink.ts', import.meta.url).pathname
  test('help succeeds without loading the frame dependencies', () => {
    const child = Bun.spawnSync([process.execPath, script, '--help'])
    expect(child.exitCode).toBe(0)
    expect(child.stdout.toString()).toContain('No PTY')
    expect(child.stderr.toString()).toBe('')
  })
  for (const args of [
    ['--samples', 'NaN'],
    ['--width', '512', '--height', '256'],
  ]) {
    test(`bad arguments fail before any metadata or measurements: ${args.join(' ')}`, () => {
      const child = Bun.spawnSync([process.execPath, script, ...args])
      expect(child.exitCode).toBe(1)
      expect(child.stdout.toString()).toBe('')
      expect(child.stderr.toString()).toContain('bench-ink FAILED')
    })
  }
})

describe('bench-ink nearest-rank statistics', () => {
  test('known unsorted percentiles; does not mutate input', () => {
    const values = Array.from({ length: 100 }, (_, i) => 100 - i)
    expect(summarize(values)).toEqual({
      count: 100,
      min: 1,
      p50: 50,
      p95: 95,
      p99: 99,
      max: 100,
    })
    expect(values[0]).toBe(100)
  })
  test('single sample, zero values and even sample count', () => {
    expect(summarize([0])).toEqual({
      count: 1,
      min: 0,
      p50: 0,
      p95: 0,
      p99: 0,
      max: 0,
    })
    expect(summarize([2, 1]).p50).toBe(1)
    expect(summarize([1, 1, 1]).p99).toBe(1)
  })
  for (const values of [[], [NaN], [Infinity], [-1], [1, NaN]]) {
    test(`rejects invalid samples ${String(values)}`, () => {
      expect(() => summarize(values)).toThrow()
    })
  }
})
