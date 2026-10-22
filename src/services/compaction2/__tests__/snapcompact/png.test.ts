import { describe, expect, test } from 'bun:test'
import { TEST_FONT_5X7 } from '../../methods/snapcompact/font.js'
import { FAMILY_PROFILES } from '../../methods/snapcompact/planner.js'
import {
  crc32,
  decodeGrayscalePng,
  encodeGrayscalePng,
  inspectPng,
  renderFrame,
} from '../../methods/snapcompact/png.js'
import { DIM_OFF, DIM_ON } from '../../methods/snapcompact/serializer.js'

describe('crc32', () => {
  test('matches the standard check value', () => {
    const input = new TextEncoder().encode('123456789')
    expect(crc32(input)).toBe(0xcbf43926)
  })
})

describe('PNG encode/decode', () => {
  test('writes signature, IHDR, IDAT, IEND with valid CRCs', () => {
    const pixels = Uint8Array.of(0, 255, 128, 64)
    const png = encodeGrayscalePng(2, 2, pixels)
    const structure = inspectPng(png)
    expect(structure.width).toBe(2)
    expect(structure.height).toBe(2)
    expect(structure.bitDepth).toBe(8)
    expect(structure.colorType).toBe(0)
    expect(structure.chunks.map(chunk => chunk.type)).toEqual([
      'IHDR',
      'IDAT',
      'IEND',
    ])
    expect(structure.chunks.every(chunk => chunk.crcOk)).toBe(true)
    expect(structure.idat.length).toBeGreaterThan(0)
  })

  test('round-trips grayscale pixels', () => {
    const pixels = Uint8Array.of(0, 255, 128, 64, 1, 2, 3, 4, 5, 6, 7, 8)
    const png = encodeGrayscalePng(4, 3, pixels)
    const decoded = decodeGrayscalePng(png)
    expect(decoded.width).toBe(4)
    expect(decoded.height).toBe(3)
    expect([...decoded.pixels]).toEqual([...pixels])
  })

  test('rejects a corrupted CRC', () => {
    const png = encodeGrayscalePng(1, 1, Uint8Array.of(0))
    const corrupted = png.slice()
    corrupted[corrupted.length - 1] =
      (corrupted[corrupted.length - 1] ?? 0) ^ 0xff
    expect(() => inspectPng(corrupted)).not.toThrow()
    expect(inspectPng(corrupted).chunks.some(chunk => !chunk.crcOk)).toBe(true)
  })
})

describe('renderFrame', () => {
  const baseShape = {
    ...FAMILY_PROFILES.anthropic.high,
    frameSize: 100,
  }

  test('hugs rows with a 64px floor and reports geometry', () => {
    const frame = renderFrame('ABC', baseShape, TEST_FONT_5X7)
    expect(frame.mimeType).toBe('image/png')
    expect(frame.cols).toBe(Math.floor(100 / baseShape.cellWidth))
    expect(frame.rows).toBe(1)
    expect(frame.chars).toBe(3)
    const png = Buffer.from(frame.data, 'base64')
    const structure = inspectPng(png)
    expect(structure.width).toBe(100)
    expect(structure.height).toBe(64)
    expect(structure.chunks.every(chunk => chunk.crcOk)).toBe(true)
  })

  test('grows past the floor when many rows print', () => {
    const text = 'A'.repeat(1000)
    const frame = renderFrame(text, baseShape, TEST_FONT_5X7)
    const structure = inspectPng(Buffer.from(frame.data, 'base64'))
    expect(structure.height).toBeGreaterThan(64)
    expect(frame.rows).toBeGreaterThan(1)
  })

  test('draws dim ink and full-block line marks', () => {
    const frame = renderFrame(
      `${DIM_ON}A${DIM_OFF}\u2588`,
      baseShape,
      TEST_FONT_5X7,
    )
    const decoded = decodeGrayscalePng(Buffer.from(frame.data, 'base64'))
    const values = new Set(decoded.pixels)
    expect(values.has(0)).toBe(true)
    expect(values.has(128)).toBe(true)
  })
})
