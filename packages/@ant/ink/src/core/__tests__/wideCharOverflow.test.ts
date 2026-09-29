import { describe, expect, test } from 'bun:test'
import {
  CellWidth,
  CharPool,
  HyperlinkPool,
  cellAt,
  createScreen,
  fixWideCharOverflow,
  type Screen,
  setCellAt,
  StylePool,
} from '../screen.js'

function makeScreen(width: number, height: number): Screen {
  return createScreen(
    width,
    height,
    new StylePool(),
    new CharPool(),
    new HyperlinkPool(),
  )
}

// Devanagari kṣa — 3 UTF-16 units, wcwidth 2. Matches the official Nd()
// gate (char.length > 2), so fixWideCharOverflow considers it.
const CLUSTER = 'क्ष'
// Single-codepoint CJK wide char — 1 UTF-16 unit. Excluded by Nd().
const CJK = '本'

describe('fixWideCharOverflow', () => {
  test('replaces a wide grapheme cluster that cannot fit before the row end', () => {
    const screen = makeScreen(10, 2)
    const styleId = new StylePool().intern([
      { type: 'ansi', code: '\x1b[31m', endCode: '\x1b[39m' },
    ])
    setCellAt(screen, 8, 0, {
      char: CLUSTER,
      styleId,
      width: CellWidth.Wide,
      hyperlink: undefined,
    })

    fixWideCharOverflow(screen)

    // Head cell: placeholder, Narrow, original style preserved
    const head = cellAt(screen, 8, 0)!
    expect(head.char).toBe('?')
    expect(head.width).toBe(CellWidth.Narrow)
    expect(head.styleId).toBe(styleId)
    // Tail cell: space padding, Narrow, style also preserved (official
    // writes styleId: M.styleId for every replaced cell)
    const tail = cellAt(screen, 9, 0)!
    expect(tail.char).toBe(' ')
    expect(tail.width).toBe(CellWidth.Narrow)
    expect(tail.styleId).toBe(styleId)
  })

  test('leaves a mid-row wide grapheme cluster untouched', () => {
    const screen = makeScreen(10, 2)
    setCellAt(screen, 4, 0, {
      char: CLUSTER,
      styleId: 0,
      width: CellWidth.Wide,
      hyperlink: undefined,
    })

    fixWideCharOverflow(screen)

    const cell = cellAt(screen, 4, 0)!
    expect(cell.char).toBe(CLUSTER)
    expect(cell.width).toBe(CellWidth.Wide)
    // Its SpacerTail is still intact
    expect(cellAt(screen, 5, 0)!.width).toBe(CellWidth.SpacerTail)
  })

  test('does nothing when damage is empty', () => {
    const screen = makeScreen(10, 2)
    setCellAt(screen, 8, 0, {
      char: CLUSTER,
      styleId: 0,
      width: CellWidth.Wide,
      hyperlink: undefined,
    })
    screen.damage = undefined

    fixWideCharOverflow(screen)

    const cell = cellAt(screen, 8, 0)!
    expect(cell.char).toBe(CLUSTER)
    expect(cell.width).toBe(CellWidth.Wide)
  })

  test('leaves single-codepoint wide characters at the row end untouched', () => {
    const screen = makeScreen(10, 2)
    setCellAt(screen, 8, 0, {
      char: CJK,
      styleId: 0,
      width: CellWidth.Wide,
      hyperlink: undefined,
    })

    fixWideCharOverflow(screen)

    // Official Nd(): char.length > 2 — CJK is excluded even though it
    // sits flush against the row end
    const cell = cellAt(screen, 8, 0)!
    expect(cell.char).toBe(CJK)
    expect(cell.width).toBe(CellWidth.Wide)
  })

  test('only touches rows and columns inside the damage bounding box', () => {
    const screen = makeScreen(10, 4)
    setCellAt(screen, 8, 2, {
      char: CLUSTER,
      styleId: 0,
      width: CellWidth.Wide,
      hyperlink: undefined,
    })
    setCellAt(screen, 8, 3, {
      char: CLUSTER,
      styleId: 0,
      width: CellWidth.Wide,
      hyperlink: undefined,
    })
    // Shrink damage to only the y=2 row, excluding the y=3 cluster
    screen.damage = { x: 8, y: 2, width: 2, height: 1 }

    fixWideCharOverflow(screen)

    // The overflowing cluster inside damage is replaced
    expect(cellAt(screen, 8, 2)!.char).toBe('?')
    // Same column on a row outside damage keeps its content — the damage
    // box only covers y=2, so y=3 was never scanned
    const outside = cellAt(screen, 8, 3)!
    expect(outside.char).toBe(CLUSTER)
    expect(outside.width).toBe(CellWidth.Wide)
  })
})
