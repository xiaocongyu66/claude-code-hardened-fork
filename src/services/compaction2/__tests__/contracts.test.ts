import { describe, expect, test } from 'bun:test'
import { resolveReserveTokens, speculationLeadTokens } from '../contracts.js'

describe('speculationLeadTokens', () => {
  test('clamps to [8192, 32000]', () => {
    expect(speculationLeadTokens(50_000)).toBe(8_192)
    expect(speculationLeadTokens(200_000)).toBe(25_000)
    expect(speculationLeadTokens(1_000_000)).toBe(32_000)
  })
})

describe('resolveReserveTokens', () => {
  test('default is max(15% window, 16384)', () => {
    expect(resolveReserveTokens(200_000)).toBe(30_000)
    expect(resolveReserveTokens(50_000)).toBe(16_384)
  })

  test('explicit reserve keeps the 15% floor', () => {
    expect(resolveReserveTokens(200_000, 8_192)).toBe(30_000)
    expect(resolveReserveTokens(200_000, 50_000)).toBe(50_000)
  })

  test('tiny windows fall back to the proportional reserve', () => {
    expect(resolveReserveTokens(16_000)).toBe(2_400)
    expect(resolveReserveTokens(19_000)).toBe(2_850)
    expect(resolveReserveTokens(20_000)).toBe(16_384)
  })

  test('an explicit reserve is never reduced', () => {
    expect(resolveReserveTokens(16_000, 16_384)).toBe(16_384)
  })
})
