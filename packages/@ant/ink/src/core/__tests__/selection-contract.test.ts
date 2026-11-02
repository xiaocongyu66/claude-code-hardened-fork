import { describe, expect, test } from 'bun:test'
import {
  CellWidth,
  CharPool,
  HyperlinkPool,
  StylePool,
  cellAt,
  createScreen,
  setCellAt,
  type Screen,
} from '../screen.js'
import {
  applySelectionOverlay,
  captureScrolledRows,
  clearSelection,
  createSelectionState,
  extendSelection,
  finishSelection,
  getSelectedText,
  hasSelection,
  isCellSelected,
  selectLineAt,
  selectWordAt,
  selectionBounds,
  shiftSelection,
  shiftSelectionForFollow,
  startSelection,
  updateSelection,
} from '../selection.js'

// P0 pure Screen/selection contracts, not ScrollBox/React integration.
// Pools belong to each fixture and are never shared across tests. No environment
// variables, global pools, Unicode-width oracle, or production algorithm mocks.
function fixture(width: number, rows: string[]) {
  const styles = new StylePool()
  const screen = createScreen(
    width,
    rows.length,
    styles,
    new CharPool(),
    new HyperlinkPool(),
  )
  // This helper accepts ASCII only: Unicode cells below have explicit coordinates
  // and widths, rather than deriving expected layout using the tested pipeline.
  rows.forEach((text, row) => {
    if (!/^[\x20-\x7e]*$/.test(text) || text.length > width) {
      throw new Error('ASCII fixture exceeds screen or contains non-ASCII text')
    }
    for (let col = 0; col < text.length; col++) {
      put(screen, col, row, text[col]!)
    }
  })
  return { screen, styles, selection: createSelectionState() }
}

function put(
  screen: Screen,
  col: number,
  row: number,
  char: string,
  width = CellWidth.Narrow,
) {
  setCellAt(screen, col, row, {
    char,
    width,
    styleId: screen.emptyStyleId,
    hyperlink: undefined,
  })
}

describe('selection contracts with real Screen cells', () => {
  test('click tremor does not select; finish retains selection until explicit clear', () => {
    const { screen, selection } = fixture(5, ['abcde'])
    startSelection(selection, 2, 0)
    updateSelection(selection, 2, 0)
    expect(hasSelection(selection)).toBe(false)
    expect(selectionBounds(selection)).toBeNull()
    expect(getSelectedText(selection, screen)).toBe('')
    updateSelection(selection, 4, 0)
    finishSelection(selection)
    updateSelection(selection, 0, 0)
    expect(selection.isDragging).toBe(false)
    expect(getSelectedText(selection, screen)).toBe('cde')
    clearSelection(selection)
    expect(hasSelection(selection)).toBe(false)
    expect(getSelectedText(selection, screen)).toBe('')
  })

  test('drag reverses through its anchor with inclusive, reading-order bounds', () => {
    const { screen, selection } = fixture(6, ['abcdef', 'ghijkl'])
    startSelection(selection, 2, 0)
    updateSelection(selection, 1, 1)
    expect(selectionBounds(selection)).toEqual({
      start: { col: 2, row: 0 },
      end: { col: 1, row: 1 },
    })
    expect(getSelectedText(selection, screen)).toBe('cdef\ngh')
    expect(isCellSelected(selection, 1, 0)).toBe(false)
    expect(isCellSelected(selection, 2, 0)).toBe(true)
    expect(isCellSelected(selection, 1, 1)).toBe(true)
    expect(isCellSelected(selection, 2, 1)).toBe(false)
    updateSelection(selection, 2, 0)
    expect(getSelectedText(selection, screen)).toBe('c')
    updateSelection(selection, 0, 0)
    expect(selectionBounds(selection)).toEqual({
      start: { col: 0, row: 0 },
      end: { col: 2, row: 0 },
    })
    expect(getSelectedText(selection, screen)).toBe('abc')
  })

  test('word drag reverses without losing the original word span', () => {
    const { screen, selection } = fixture(13, ['one two three'])
    selectWordAt(selection, screen, 5, 0)
    expect(getSelectedText(selection, screen)).toBe('two')
    extendSelection(selection, screen, 10, 0)
    expect(getSelectedText(selection, screen)).toBe('two three')
    extendSelection(selection, screen, 1, 0)
    expect(selectionBounds(selection)).toEqual({
      start: { col: 0, row: 0 },
      end: { col: 6, row: 0 },
    })
    expect(getSelectedText(selection, screen)).toBe('one two')
    extendSelection(selection, screen, 4, 0)
    expect(getSelectedText(selection, screen)).toBe('two')
  })

  test('double-clicking a wide tail selects the complete CJK word once', () => {
    const { screen, selection } = fixture(7, [''])
    put(screen, 0, 0, '\u4e2d', CellWidth.Wide)
    put(screen, 2, 0, '\u6587', CellWidth.Wide)
    put(screen, 4, 0, '!')
    expect(cellAt(screen, 3, 0)?.width).toBe(CellWidth.SpacerTail)
    selectWordAt(selection, screen, 3, 0)
    expect(selectionBounds(selection)).toEqual({
      start: { col: 0, row: 0 },
      end: { col: 3, row: 0 },
    })
    expect(getSelectedText(selection, screen)).toBe('\u4e2d\u6587')
  })

  test('copy preserves combining and ZWJ graphemes and omits spacer cells', () => {
    const { screen, selection } = fixture(6, [''])
    put(screen, 0, 0, 'e\u0301')
    put(screen, 1, 0, '\u{1f469}\u200d\u{1f4bb}', CellWidth.Wide)
    put(screen, 3, 0, 'x')
    put(screen, 4, 0, '', CellWidth.SpacerHead)
    selectLineAt(selection, screen, 0)
    expect(getSelectedText(selection, screen)).toBe(
      'e\u0301\u{1f469}\u200d\u{1f4bb}x',
    )
    selectWordAt(selection, screen, 2, 0)
    expect(selectionBounds(selection)).toEqual({
      start: { col: 1, row: 0 },
      end: { col: 2, row: 0 },
    })
    expect(getSelectedText(selection, screen)).toBe('\u{1f469}\u200d\u{1f4bb}')
  })

  test('soft wraps preserve separator spaces but exclude padding and retain hard newlines', () => {
    const { screen, selection } = fixture(8, ['hello ', 'world', 'end'])
    screen.softWrap[1] = 6
    startSelection(selection, 0, 0)
    updateSelection(selection, 7, 2)
    expect(getSelectedText(selection, screen)).toBe('hello world\nend')
    startSelection(selection, 2, 0)
    updateSelection(selection, 2, 1)
    expect(getSelectedText(selection, screen)).toBe('llo wor')
  })

  test('noSelect excludes gutters from copying and highlighting, and blocks word selection', () => {
    const { screen, styles, selection } = fixture(6, ['> code'])
    screen.noSelect[0] = 1
    screen.noSelect[1] = 1
    selectWordAt(selection, screen, 0, 0)
    expect(hasSelection(selection)).toBe(false)
    selectLineAt(selection, screen, 0)
    expect(getSelectedText(selection, screen)).toBe('code')
    applySelectionOverlay(screen, selection, styles)
    expect(cellAt(screen, 0, 0)?.styleId).toBe(styles.none)
    expect(cellAt(screen, 1, 0)?.styleId).toBe(styles.none)
    for (const col of [2, 3, 4, 5]) {
      expect(cellAt(screen, col, 0)?.styleId).not.toBe(styles.none)
    }
    expect(getSelectedText(selection, screen)).toBe('code')
  })

  test('capture above preserves a soft-wrapped logical line across viewport replacement', () => {
    const { screen, selection } = fixture(8, ['hello ', 'world', 'end'])
    screen.softWrap[1] = 6
    startSelection(selection, 0, 0)
    updateSelection(selection, 2, 2)
    captureScrolledRows(selection, screen, 0, 0, 'above')
    shiftSelection(selection, -1, 0, 2, 8)
    expect(selection.scrolledOffAbove).toEqual(['hello '])
    expect(selection.scrolledOffAboveSW).toEqual([false])
    expect(selection.virtualAnchorRow).toBe(-1)
    const next = fixture(8, ['world', 'end', 'new']).screen
    next.softWrap[0] = 6
    expect(getSelectedText(selection, next)).toBe('hello world\nend')
    // Pure selection shift, not a simulated ScrollBox implementation.
    shiftSelection(selection, 1, 0, 2, 8)
    expect(selection.scrolledOffAbove).toEqual([])
    expect(selection.scrolledOffAboveSW).toEqual([])
    expect(selection.virtualAnchorRow).toBeUndefined()
    expect(getSelectedText(selection, screen)).toBe('hello world\nend')
  })

  test('successive captures below prepend in reading order and reverse without duplicates', () => {
    const { screen, selection } = fixture(4, ['aa', 'bb', 'cc'])
    startSelection(selection, 3, 2)
    updateSelection(selection, 0, 0)
    captureScrolledRows(selection, screen, 2, 2, 'below')
    shiftSelection(selection, 1, 0, 2, 4)
    const next = fixture(4, ['zz', 'aa', 'bb']).screen
    expect(getSelectedText(selection, next)).toBe('aa\nbb\ncc')
    captureScrolledRows(selection, next, 2, 2, 'below')
    shiftSelection(selection, 1, 0, 2, 4)
    const third = fixture(4, ['yy', 'zz', 'aa']).screen
    expect(selection.scrolledOffBelow).toEqual(['bb', 'cc'])
    expect(selection.scrolledOffBelowSW).toEqual([false, false])
    expect(getSelectedText(selection, third)).toBe('aa\nbb\ncc')
    shiftSelection(selection, -2, 0, 2, 4)
    expect(selection.scrolledOffBelow).toEqual([])
    expect(selection.scrolledOffBelowSW).toEqual([])
    expect(getSelectedText(selection, screen)).toBe('aa\nbb\ncc')
  })

  test('capture intersects selected rows and applies partial columns and noSelect', () => {
    const { screen, selection } = fixture(6, ['ignore', '> abcd', '> efgh'])
    screen.noSelect[6] = 1
    screen.noSelect[7] = 1
    screen.noSelect[12] = 1
    screen.noSelect[13] = 1
    startSelection(selection, 3, 1)
    updateSelection(selection, 3, 2)
    captureScrolledRows(selection, screen, 0, 2, 'above')
    expect(selection.scrolledOffAbove).toEqual(['bcd', 'ef'])
    expect(selection.scrolledOffAboveSW).toEqual([false, false])
    captureScrolledRows(selection, screen, 2, 1, 'above')
    expect(selection.scrolledOffAbove).toEqual(['bcd', 'ef'])
    clearSelection(selection)
    expect(selection).toEqual({
      ...createSelectionState(),
      virtualAnchorRow: undefined,
      virtualFocusRow: undefined,
    })
    expect(getSelectedText(selection, screen)).toBe('')
  })

  for (const delta of [-3, 3]) {
    test(`keyboard shift ${delta} clears a selection entirely outside the viewport`, () => {
      const { screen, selection } = fixture(4, ['aa', 'bb', 'cc'])
      selectWordAt(selection, screen, 0, 1)
      selection.lastPressHadAlt = true
      shiftSelection(selection, delta, 0, 2, 4)
      expect(selection).toEqual({
        ...createSelectionState(),
        virtualAnchorRow: undefined,
        virtualFocusRow: undefined,
      })
      expect(getSelectedText(selection, screen)).toBe('')
    })
  }

  test('follow shift records virtual rows and signals clearing only after both ends leave', () => {
    const { screen, selection } = fixture(4, ['aa', 'bb', 'cc'])
    startSelection(selection, 0, 0)
    updateSelection(selection, 1, 2)
    captureScrolledRows(selection, screen, 0, 0, 'above')
    expect(shiftSelectionForFollow(selection, -1, 0, 2)).toBe(false)
    expect(selection.anchor).toEqual({ col: 0, row: 0 })
    expect(selection.focus).toEqual({ col: 1, row: 1 })
    expect(selection.virtualAnchorRow).toBe(-1)
    expect(shiftSelectionForFollow(selection, -2, 0, 2)).toBe(true)
    expect(hasSelection(selection)).toBe(false)
    expect(selection.scrolledOffAbove).toEqual([])
    expect(selection.scrolledOffAboveSW).toEqual([])
    expect(selection.virtualAnchorRow).toBeUndefined()
    expect(getSelectedText(selection, screen)).toBe('')
    expect(shiftSelectionForFollow(selection, -1, 0, 2)).toBe(false)
  })
})
