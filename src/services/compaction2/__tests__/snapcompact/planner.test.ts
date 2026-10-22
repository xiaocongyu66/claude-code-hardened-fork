import { describe, expect, test } from 'bun:test'
import {
  DIM_OFF,
  DIM_ON,
  NEWLINE_GLYPH,
} from '../../methods/snapcompact/serializer.js'
import {
  FAMILY_PROFILES,
  MAX_FRAMES_DEFAULT,
  countCells,
  geometry,
  maxFramesForDataBudget,
  paginateCells,
  planArchive,
  resolveMaxFrames,
  resolveProfile,
} from '../../methods/snapcompact/planner.js'

describe('resolveProfile', () => {
  test('requires an explicit family', () => {
    expect(resolveProfile({})).toBeUndefined()
    expect(
      resolveProfile({ env: { CCH_SNAPCOMPACT_FAMILY: 'nope' } }),
    ).toBeUndefined()
  })

  test('accepts an explicit family or env family', () => {
    expect(resolveProfile({ family: 'anthropic' })?.family).toBe('anthropic')
    expect(
      resolveProfile({ env: { CCH_SNAPCOMPACT_FAMILY: 'google' } })?.family,
    ).toBe('google')
  })

  test('applies env shape and frame-size overrides', () => {
    const profile = resolveProfile({
      family: 'openai',
      env: {
        CCH_SNAPCOMPACT_SHAPE: '5on16-bw',
        CCH_SNAPCOMPACT_FRAME_SIZE: '1024',
      },
    })
    expect(profile?.high.name).toBe('5on16-bw')
    expect(profile?.frameSize).toBe(1024)
    expect(profile?.high.frameSize).toBe(1024)
  })

  test('rejects an unknown shape override', () => {
    expect(
      resolveProfile({
        family: 'anthropic',
        env: { CCH_SNAPCOMPACT_SHAPE: 'nope' },
      }),
    ).toBeUndefined()
  })
})

describe('geometry', () => {
  test('derives cols, rows and capacity from the shape', () => {
    const shape = FAMILY_PROFILES.anthropic.high
    const geo = geometry(shape, 1568)
    expect(geo.cols).toBe(Math.floor(1568 / shape.cellWidth))
    expect(geo.rows).toBe(Math.floor(1568 / shape.cellHeight))
    expect(geo.capacity).toBe(geo.cols * geo.rows)
  })
})

describe('pagination', () => {
  test('pages are contiguous and cover the input', () => {
    const text = 'a'.repeat(100) + NEWLINE_GLYPH + 'b'.repeat(50)
    const pages = paginateCells(text, 40, 8)
    expect(pages.join('')).toBe(text)
    expect(pages.every(page => countCells(page) <= 40)).toBe(true)
  })

  test('dim markers are zero-width', () => {
    const text = `${DIM_ON}abc${DIM_OFF}`
    expect(countCells(text)).toBe(3)
    expect(paginateCells(text, 3, 3)).toEqual([text])
  })
})

describe('budgets', () => {
  test('payload budget scales frame count by pixel area', () => {
    const shape = FAMILY_PROFILES.anthropic.high
    expect(maxFramesForDataBudget(shape, 340_000)).toBe(3)
    expect(maxFramesForDataBudget({ frameSize: 1932 }, 340_000)).toBe(2)
  })

  test('resolveMaxFrames clamps to 80, provider, token and byte caps', () => {
    const profile = FAMILY_PROFILES.anthropic
    expect(
      resolveMaxFrames(profile, {
        maxFrames: 500,
        dataBudgetBytes: 1_000_000_000,
      }),
    ).toBe(MAX_FRAMES_DEFAULT)
    expect(
      resolveMaxFrames(profile, { tokenBudget: profile.frameTokenEstimate }),
    ).toBe(1)
    expect(resolveMaxFrames(profile, { maxFrames: 4 })).toBe(4)
    expect(resolveMaxFrames(profile, { dataBudgetBytes: 340_000 })).toBe(3)
  })
})

describe('planArchive', () => {
  test('keeps short history entirely as text', () => {
    const profile = FAMILY_PROFILES.anthropic
    const plan = planArchive('short history', profile)
    expect(plan.frames).toHaveLength(0)
    expect(plan.textHead).toBe('short history')
    expect(plan.keptText).toBe('short history')
  })

  test('images the middle without foveation when it fits', () => {
    const profile = FAMILY_PROFILES.anthropic
    const cap = geometry(profile.high).capacity
    const text = 'x'.repeat(cap * 3)
    const plan = planArchive(text, profile, {
      maxFrames: MAX_FRAMES_DEFAULT,
      dataBudgetBytes: 1_000_000_000,
    })
    expect(plan.frames.length).toBeGreaterThan(0)
    expect(
      plan.frames.every(frame => frame.shape.name === profile.high.name),
    ).toBe(true)
    expect(plan.truncatedChars).toBe(0)
  })

  test('foveates HQ/LQ/HQ and drops the oldest dense slice', () => {
    const profile = FAMILY_PROFILES.anthropic
    const cap = geometry(profile.high).capacity
    const text = 'y'.repeat(cap * 20)
    const plan = planArchive(text, profile, {
      maxFrames: 8,
      dataBudgetBytes: 1_000_000_000,
    })
    expect(plan.maxFrames).toBe(8)
    expect(plan.frames).toHaveLength(8)
    expect(
      plan.frames.slice(0, 3).every(f => f.shape.name === profile.high.name),
    ).toBe(true)
    expect(
      plan.frames.slice(3, 5).every(f => f.shape.name === profile.low.name),
    ).toBe(true)
    expect(
      plan.frames.slice(5).every(f => f.shape.name === profile.high.name),
    ).toBe(true)
    expect(plan.truncatedChars).toBeGreaterThan(0)
    expect(plan.keptText.length).toBeLessThan(text.length)
  })

  test('a byte budget reduces the frame count', () => {
    const profile = FAMILY_PROFILES.anthropic
    const cap = geometry(profile.high).capacity
    const text = 'z'.repeat(cap * 20)
    const plan = planArchive(text, profile, {
      maxFrames: 80,
      dataBudgetBytes: 200_000,
    })
    expect(plan.frames.length).toBeLessThanOrEqual(2)
  })
})
