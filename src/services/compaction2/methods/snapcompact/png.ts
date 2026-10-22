// Ported from oh-my-pi (MIT). See THIRD_PARTY_NOTICES.md in this directory.
/**
 * Minimal PNG encoder/decoder for snapcompact frames.
 *
 * No image library is used: IHDR/IDAT/IEND chunks and CRC32 are written by
 * hand and the scanline stream is compressed with `node:zlib`'s deflate.
 * Frames are 8-bit grayscale (color type 0) — black ink, mid-gray dim ink,
 * white background — which keeps the payload small and the structure easy to
 * verify in tests.
 */

import { deflateSync, inflateSync } from 'node:zlib'
import type { FontProvider } from './font.js'
import { countCells, geometry, type Shape } from './planner.js'
import { DIM_OFF, DIM_ON, NEWLINE_GLYPH } from './serializer.js'

const PNG_SIGNATURE = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10)
const COLOR_TYPE_GRAYSCALE = 0
const BIT_DEPTH = 8

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    table[n] = c >>> 0
  }
  return table
})()

/** Standard PNG CRC-32 over `bytes`. */
export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff
  for (const byte of bytes) {
    c = (CRC_TABLE[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8)
  }
  return (c ^ 0xffffffff) >>> 0
}

function writeUint32(target: Uint8Array, offset: number, value: number): void {
  target[offset] = (value >>> 24) & 0xff
  target[offset + 1] = (value >>> 16) & 0xff
  target[offset + 2] = (value >>> 8) & 0xff
  target[offset + 3] = value & 0xff
}

function readUint32(bytes: Uint8Array, offset: number): number {
  return (
    (((bytes[offset] ?? 0) << 24) |
      ((bytes[offset + 1] ?? 0) << 16) |
      ((bytes[offset + 2] ?? 0) << 8) |
      (bytes[offset + 3] ?? 0)) >>>
    0
  )
}

function asciiBytes(type: string): Uint8Array {
  const bytes = new Uint8Array(4)
  for (let index = 0; index < 4; index++) {
    bytes[index] = type.charCodeAt(index) & 0xff
  }
  return bytes
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = asciiBytes(type)
  const out = new Uint8Array(12 + data.length)
  writeUint32(out, 0, data.length)
  out.set(typeBytes, 4)
  out.set(data, 8)
  const crcInput = new Uint8Array(4 + data.length)
  crcInput.set(typeBytes, 0)
  crcInput.set(data, 4)
  writeUint32(out, 8 + data.length, crc32(crcInput))
  return out
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  let length = 0
  for (const part of parts) length += part.length
  const out = new Uint8Array(length)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

/** Encode 8-bit grayscale pixels as a PNG. */
export function encodeGrayscalePng(
  width: number,
  height: number,
  pixels: Uint8Array,
): Uint8Array {
  if (!Number.isInteger(width) || width <= 0) {
    throw new Error(`invalid PNG width: ${width}`)
  }
  if (!Number.isInteger(height) || height <= 0) {
    throw new Error(`invalid PNG height: ${height}`)
  }
  if (pixels.length !== width * height) {
    throw new Error(
      `pixel buffer has ${pixels.length} bytes, expected ${width * height}`,
    )
  }

  const ihdr = new Uint8Array(13)
  writeUint32(ihdr, 0, width)
  writeUint32(ihdr, 4, height)
  ihdr[8] = BIT_DEPTH
  ihdr[9] = COLOR_TYPE_GRAYSCALE
  ihdr[10] = 0 // compression
  ihdr[11] = 0 // filter
  ihdr[12] = 0 // interlace

  // Each scanline is prefixed with filter type 0 (None).
  const raw = new Uint8Array(height * (width + 1))
  for (let y = 0; y < height; y++) {
    const rowStart = y * (width + 1)
    raw[rowStart] = 0
    raw.set(pixels.subarray(y * width, (y + 1) * width), rowStart + 1)
  }
  const idat = deflateSync(raw, { level: 9 })

  return concat([
    PNG_SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', new Uint8Array(0)),
  ])
}

export interface PngChunkInfo {
  type: string
  length: number
  crcOk: boolean
}

export interface PngStructure {
  width: number
  height: number
  bitDepth: number
  colorType: number
  chunks: PngChunkInfo[]
  /** Concatenated IDAT payload (still zlib-compressed). */
  idat: Uint8Array
}

function verifySignature(bytes: Uint8Array): void {
  if (bytes.length < PNG_SIGNATURE.length) {
    throw new Error('not a PNG: truncated signature')
  }
  for (let index = 0; index < PNG_SIGNATURE.length; index++) {
    if (bytes[index] !== PNG_SIGNATURE[index]) {
      throw new Error('not a PNG: bad signature')
    }
  }
}

/**
 * Parse a PNG's chunk structure and verify every CRC. Throws on malformed
 * input; tests use this to prove the hand-written encoder round-trips.
 */
export function inspectPng(bytes: Uint8Array): PngStructure {
  verifySignature(bytes)
  let offset = PNG_SIGNATURE.length
  const chunks: PngChunkInfo[] = []
  const idatParts: Uint8Array[] = []
  let width = 0
  let height = 0
  let bitDepth = 0
  let colorType = 0
  let sawHeader = false
  let sawEnd = false

  while (offset + 12 <= bytes.length) {
    const length = readUint32(bytes, offset)
    const typeStart = offset + 4
    const dataStart = offset + 8
    const dataEnd = dataStart + length
    const crcEnd = dataEnd + 4
    if (crcEnd > bytes.length) {
      throw new Error('truncated PNG chunk')
    }
    const type = String.fromCharCode(
      bytes[typeStart] ?? 0,
      bytes[typeStart + 1] ?? 0,
      bytes[typeStart + 2] ?? 0,
      bytes[typeStart + 3] ?? 0,
    )
    const crcInput = bytes.subarray(typeStart, dataEnd)
    const expected = readUint32(bytes, dataEnd)
    const crcOk = crc32(crcInput) === expected
    chunks.push({ type, length, crcOk })
    const data = bytes.subarray(dataStart, dataEnd)

    if (type === 'IHDR') {
      if (length !== 13) throw new Error('bad IHDR length')
      width = readUint32(data, 0)
      height = readUint32(data, 4)
      bitDepth = data[8] ?? 0
      colorType = data[9] ?? 0
      sawHeader = true
    } else if (type === 'IDAT') {
      idatParts.push(data.slice())
    } else if (type === 'IEND') {
      sawEnd = true
      offset = crcEnd
      break
    }
    offset = crcEnd
  }

  if (!sawHeader) throw new Error('PNG has no IHDR')
  if (!sawEnd) throw new Error('PNG has no IEND')
  return {
    width,
    height,
    bitDepth,
    colorType,
    chunks,
    idat: concat(idatParts),
  }
}

/** Decode an 8-bit grayscale PNG written by {@link encodeGrayscalePng}. */
export function decodeGrayscalePng(bytes: Uint8Array): {
  width: number
  height: number
  pixels: Uint8Array
} {
  const structure = inspectPng(bytes)
  if (structure.bitDepth !== BIT_DEPTH) {
    throw new Error(`unsupported PNG bit depth: ${structure.bitDepth}`)
  }
  if (structure.colorType !== COLOR_TYPE_GRAYSCALE) {
    throw new Error(`unsupported PNG color type: ${structure.colorType}`)
  }
  const raw = inflateSync(structure.idat)
  const stride = structure.width + 1
  if (raw.length !== structure.height * stride) {
    throw new Error('unexpected IDAT payload length')
  }
  const pixels = new Uint8Array(structure.width * structure.height)
  for (let y = 0; y < structure.height; y++) {
    const filter = raw[y * stride] ?? 0
    if (filter !== 0) {
      throw new Error(`unsupported PNG filter type: ${filter}`)
    }
    pixels.set(
      raw.subarray(y * stride + 1, (y + 1) * stride),
      y * structure.width,
    )
  }
  return { width: structure.width, height: structure.height, pixels }
}

export interface RenderedFrame {
  /** Base64-encoded PNG. */
  data: string
  mimeType: 'image/png'
  cols: number
  rows: number
  /** Visible characters printed onto this frame. */
  chars: number
  font: string
  variant: Shape['variant']
  detail?: Shape['imageDetail']
}

const INK_BLACK = 0
const INK_DIM = 128
const PAPER = 255
const MIN_FRAME_HEIGHT = 64

function drawGlyph(
  pixels: Uint8Array,
  frameWidth: number,
  x0: number,
  y0: number,
  font: FontProvider,
  codePoint: number,
  ink: number,
): void {
  const glyph = font.glyph(codePoint) ?? font.glyph(0x3f) ?? font.glyph(0x20)
  if (!glyph) return
  for (let gy = 0; gy < glyph.height; gy++) {
    const row = glyph.rows[gy] ?? 0
    const y = y0 + gy
    if (y < 0) continue
    for (let gx = 0; gx < glyph.width; gx++) {
      if ((row & (0x80 >> gx)) === 0) continue
      const x = x0 + gx
      if (x < 0 || x >= frameWidth) continue
      const index = y * frameWidth + x
      if (index >= 0 && index < pixels.length) pixels[index] = ink
    }
  }
}

/**
 * Render normalized text onto one frame. Frame width is the shape's
 * `frameSize`; height hugs the rows actually printed with a 64px floor.
 */
export function renderFrame(
  text: string,
  shape: Shape,
  font: FontProvider,
): RenderedFrame {
  const geo = geometry(shape)
  const visibleCells = countCells(text)
  const rowsUsed = Math.max(1, Math.ceil(visibleCells / geo.cols))
  const height = Math.max(
    MIN_FRAME_HEIGHT,
    rowsUsed * shape.cellHeight * shape.lineRepeat,
  )
  const width = shape.frameSize
  const pixels = new Uint8Array(width * height)
  pixels.fill(PAPER)

  let cell = 0
  let dim = false
  let drawn = 0
  for (const ch of text) {
    if (ch === DIM_ON) {
      dim = true
      continue
    }
    if (ch === DIM_OFF) {
      dim = false
      continue
    }
    if (cell >= geo.capacity) break
    const col = cell % geo.cols
    const row = Math.floor(cell / geo.cols)
    const x0 = col * shape.cellWidth
    const y0 = row * shape.cellHeight * shape.lineRepeat
    const ink = dim ? INK_DIM : INK_BLACK
    if (ch === NEWLINE_GLYPH) {
      // A full-block cell; the same visible mark the upstream font prints.
      for (let dy = 0; dy < shape.cellHeight; dy++) {
        const y = y0 + dy
        if (y >= height) break
        pixels.fill(
          ink,
          y * width + x0,
          y * width + Math.min(x0 + shape.cellWidth, width),
        )
      }
    } else {
      const codePoint = ch.codePointAt(0)
      if (codePoint !== undefined) {
        drawGlyph(pixels, width, x0, y0, font, codePoint, ink)
      }
    }
    cell++
    drawn++
  }

  const png = encodeGrayscalePng(width, height, pixels)
  return {
    data: Buffer.from(png).toString('base64'),
    mimeType: 'image/png',
    cols: geo.cols,
    rows: rowsUsed,
    chars: drawn,
    font: shape.font,
    variant: shape.variant,
    ...(shape.imageDetail ? { detail: shape.imageDetail } : {}),
  }
}
