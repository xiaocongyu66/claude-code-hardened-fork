import { describe, expect, test } from 'bun:test'
import { parseKeystroke } from '../parser.js'
import { keystrokesEqual } from '../resolver.js'

describe('parseKeystroke', () => {
  test('plain letter', () => {
    const k = parseKeystroke('j')
    expect(k.key).toBe('j')
    expect(k.ctrl).toBe(false)
    expect(k.shift).toBe(false)
  })

  test('ctrl modifier', () => {
    const k = parseKeystroke('ctrl+x')
    expect(k.key).toBe('x')
    expect(k.ctrl).toBe(true)
  })

  test('shift produces uppercase key', () => {
    const k = parseKeystroke('shift+a')
    expect(k.shift).toBe(true)
  })

  test('named arrow key', () => {
    const k = parseKeystroke('down')
    expect(k.key).toBe('down')
  })
})

describe('keystrokesEqual', () => {
  test('identical keys are equal', () => {
    expect(
      keystrokesEqual(parseKeystroke('ctrl+x'), parseKeystroke('ctrl+x')),
    ).toBe(true)
  })

  test('different keys are not equal', () => {
    expect(keystrokesEqual(parseKeystroke('j'), parseKeystroke('k'))).toBe(
      false,
    )
  })

  test('alt and meta collapse to one modifier', () => {
    // legacy terminals can't distinguish alt from meta
    expect(
      keystrokesEqual(parseKeystroke('alt+k'), parseKeystroke('meta+k')),
    ).toBe(true)
  })

  test('ctrl differs from plain', () => {
    expect(keystrokesEqual(parseKeystroke('x'), parseKeystroke('ctrl+x'))).toBe(
      false,
    )
  })
})
