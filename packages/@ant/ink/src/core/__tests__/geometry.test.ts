import { describe, expect, test } from 'bun:test'
import { clamp, clampRect, edges } from '../layout/geometry.js'

describe('clamp', () => {
  test('value inside range passes through', () => {
    expect(clamp(5, 0, 10)).toBe(5)
  })

  test('below min clamps up', () => {
    expect(clamp(-3, 0, 10)).toBe(0)
  })

  test('above max clamps down', () => {
    expect(clamp(99, 0, 10)).toBe(10)
  })

  test('no bounds returns value', () => {
    expect(clamp(7)).toBe(7)
  })

  test('min-only clamps up', () => {
    expect(clamp(-2, 0)).toBe(0)
  })
})

describe('clampRect', () => {
  test('rect inside bounds unchanged', () => {
    const r = { x: 1, y: 1, width: 3, height: 3 }
    const c = clampRect(r, { width: 10, height: 10 })
    expect(c).toEqual({ x: 1, y: 1, width: 3, height: 3 })
  })

  test('overflow rect clamps to bounds', () => {
    const r = { x: -5, y: 8, width: 20, height: 20 }
    const c = clampRect(r, { width: 10, height: 10 })
    expect(c.x).toBe(0)
    expect(c.y).toBe(8)
  })
})

describe('edges', () => {
  test('uniform', () => {
    expect(edges(2)).toEqual({ top: 2, right: 2, bottom: 2, left: 2 })
  })

  test('vertical + horizontal', () => {
    expect(edges(1, 2)).toEqual({ top: 1, right: 2, bottom: 1, left: 2 })
  })

  test('all four', () => {
    expect(edges(1, 2, 3, 4)).toEqual({ top: 1, right: 2, bottom: 3, left: 4 })
  })
})
