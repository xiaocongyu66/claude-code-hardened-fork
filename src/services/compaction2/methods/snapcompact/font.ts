/**
 * Bitmap fonts for snapcompact frames.
 *
 * The production font is the X.org `5x8` BDF font shipped with oh-my-pi at
 * `crates/pi-natives/src/fonts/5x8.bdf` (ucs-fonts, Markus Kuhn). Its BDF
 * header declares:
 *
 *   COPYRIGHT "Public domain font.  Share and enjoy."
 *
 * Only the printable ASCII subset (U+0020..U+007E) is embedded below, so the
 * derived data stays public domain. Do not add fonts here without checking
 * each upstream LICENSE/COPYRIGHT header first; unknown-provenance fonts must
 * not be committed.
 *
 * `TEST_FONT_5X7` is a deliberately tiny, hand-written 5x7 font used by the
 * tests and as an example of an injectable {@link FontProvider}. It is not
 * derived from any third-party font.
 */

/** One glyph bitmap. `rows[y]` holds the row's pixels in bits 7..3 (the
 *  leftmost pixel is bit 7), matching the BDF source encoding. */
export interface BitmapGlyph {
  readonly width: number
  readonly height: number
  readonly rows: readonly number[]
}

/** Injectable glyph source. The renderer only asks for one code point at a
 *  time and falls back to `?`/a blank cell when `glyph` returns undefined. */
export interface FontProvider {
  readonly name: string
  readonly width: number
  readonly height: number
  glyph(codePoint: number): BitmapGlyph | undefined
}

/**
 * Printable ASCII glyphs from X.org `5x8.bdf`, 16 hex characters per glyph
 * (eight rows of one byte, in code-point order U+0020..U+007E). Public domain;
 * see the file header for provenance.
 */
const ASCII_5X8_HEX =
  '0000000000000000002020202000200000505050000000005050F850F8505000' +
  '2070A07028702000004050205010000040A0A040A0A050000020202000000000' +
  '0020404040402000004020202020400000009060F060900000002020F8202000' +
  '000000000030204000000000F000000000000000002070200010102040808000' +
  '00205070505020000020602020207000006090106080F00000F0206010906000' +
  '002060A0F020200000F080E010906000006080E09090600000F0102020404000' +
  '0060906090906000006090907010600000006060006060000000303000302040' +
  '0010204040201000000000F000F0000000402010102040000020501020002000' +
  '304898A8A890403000609090F090900000E090E09090E0000060908080906000' +
  '00E090909090E00000F080E08080F00000F080E08080800000609080B0906000' +
  '009090F09090900000702020202070000070202020A040000090A0C0A0A09000' +
  '008080808080F0000090F0F0909090000090D0F0B0B090000060909090906000' +
  '00E09090E080800000609090D0B0601000E09090E09090000060904020906000' +
  '00702020202020000090909090906000009090909060600000909090F0F09000' +
  '0090906060909000008888502020200000F010204080F0000070404040407000' +
  '00808040201010000070101010107000002050000000000000000000000000F0' +
  '00402000000000000000007090907000008080E09090E0000000003040403000' +
  '001010709090700000000060B0C0600000205040E04040000000006090701060' +
  '008080E0909090000020006020207000001000101010502000808090E0909000' +
  '0060202020207000000000D0A8A8A800000000E0909090000000006090906000' +
  '000000E090E080800000007090701010000000A0D08080000000003060106000' +
  '004040E0405020000000009090907000000000505050200000000088A8A85000' +
  '00000090606090000000009090709060000000F02040F000304020C020403000' +
  '0020202020202000C02040304020C0000050A00000000000'

const FIRST_ASCII = 0x20

function parseGlyph(hex: string, width: number, height: number): BitmapGlyph {
  const rows: number[] = []
  for (let y = 0; y < height; y++) {
    rows.push(Number.parseInt(hex.slice(y * 2, y * 2 + 2), 16) || 0)
  }
  return { width, height, rows }
}

function createAsciiFont(
  name: string,
  width: number,
  height: number,
  hex: string,
): FontProvider {
  const glyphs = new Map<number, BitmapGlyph>()
  const stride = height * 2
  for (let index = 0; index * stride < hex.length; index++) {
    const start = index * stride
    glyphs.set(
      FIRST_ASCII + index,
      parseGlyph(hex.slice(start, start + stride), width, height),
    )
  }
  return {
    name,
    width,
    height,
    glyph: codePoint => glyphs.get(codePoint),
  }
}

/** Public-domain X.org 5x8 ASCII font (the default production font). */
export const FIVE_BY_EIGHT_FONT: FontProvider = createAsciiFont(
  '5x8',
  5,
  8,
  ASCII_5X8_HEX,
)

const BLANK_5X7: BitmapGlyph = {
  width: 5,
  height: 7,
  rows: [0, 0, 0, 0, 0, 0, 0],
}

function glyph5x7(rows: readonly number[]): BitmapGlyph {
  return { width: 5, height: 7, rows }
}

/**
 * Minimal hand-written 5x7 test font. Only a handful of glyphs are real; any
 * other printable code point renders as a box outline so tests can still
 * assert frame structure without depending on a bundled font.
 */
const TEST_GLYPHS = new Map<number, BitmapGlyph>([
  [0x20, BLANK_5X7],
  [0x41, glyph5x7([0x70, 0x88, 0x88, 0xf8, 0x88, 0x88, 0x88])], // A
  [0x42, glyph5x7([0xf0, 0x88, 0x88, 0xf0, 0x88, 0x88, 0xf0])], // B
  [0x43, glyph5x7([0x70, 0x88, 0x80, 0x80, 0x80, 0x88, 0x70])], // C
  [0x30, glyph5x7([0x70, 0x88, 0x98, 0xa8, 0xc8, 0x88, 0x70])], // 0
  [0x31, glyph5x7([0x20, 0x60, 0x20, 0x20, 0x20, 0x20, 0x70])], // 1
  [0x2e, glyph5x7([0, 0, 0, 0, 0, 0x60, 0x60])], // .
  [0x3f, glyph5x7([0x70, 0x88, 0x08, 0x10, 0x20, 0, 0x20])], // ?
])

const TEST_BOX = glyph5x7([0x70, 0x88, 0x88, 0x88, 0x88, 0x88, 0x70])

export const TEST_FONT_5X7: FontProvider = {
  name: 'test-5x7',
  width: 5,
  height: 7,
  glyph: codePoint => TEST_GLYPHS.get(codePoint) ?? TEST_BOX,
}
