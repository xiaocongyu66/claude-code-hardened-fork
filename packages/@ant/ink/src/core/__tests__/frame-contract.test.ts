import { describe, expect, test } from 'bun:test'
import { emptyFrame, type Diff, type Frame } from '../frame.js'
import { LogUpdate } from '../log-update.js'
import Output from '../output.js'
import {
  CellWidth,
  CharPool,
  HyperlinkPool,
  StylePool,
  cellAt,
  createScreen,
  type Screen,
} from '../screen.js'

// P0 characterization, not a frozen Rust specification or a terminal emulator.
// Keep real imports: a broken Unicode/ANSI dependency must fail, not silently skip.
function replay() {
  const stylePool = new StylePool()
  const charPool = new CharPool()
  const hyperlinkPool = new HyperlinkPool()
  const buffers = [0, 1].map(() =>
    createScreen(10, 2, stylePool, charPool, hyperlinkPool),
  )
  const output = new Output({
    width: 10,
    height: 2,
    stylePool,
    screen: buffers[0]!,
  })
  const log = new LogUpdate({ isTTY: true, stylePool })
  let previous = emptyFrame(6, 10, stylePool, charPool, hyperlinkPool)
  let index = 0

  return {
    stylePool,
    next(
      paint: (output: Output) => void,
      width = 10,
      height = 2,
      viewport = { width: 10, height: 6 },
    ) {
      const screen = buffers[index++ % 2]!
      output.reset(width, height, screen)
      paint(output)
      const frame: Frame = {
        screen: output.get(),
        viewport,
        cursor: { x: 0, y: height, visible: true },
      }
      const patches = log.render(previous, frame)
      previous = frame
      return { screen, patches }
    },
  }
}

function semanticCells(screen: Screen, pool: StylePool) {
  return Array.from({ length: screen.height }, (_, y) =>
    Array.from({ length: screen.width }, (_, x) => {
      const cell = cellAt(screen, x, y)!
      return {
        char: cell.char,
        width: cell.width,
        hyperlink: cell.hyperlink,
        styles: pool.get(cell.styleId).map(code => code.code),
      }
    }),
  )
}

// LogUpdate emits standalone LF patches to restore the cursor below content.
// Inspect glyph writes separately; never strip ANSI or normalize cell metadata.
function writes(patches: Diff) {
  return patches.flatMap(patch =>
    patch.type === 'stdout' && patch.content !== '\n' ? [patch.content] : [],
  )
}

function expectIncremental(patches: Diff) {
  expect(patches.some(patch => patch.type === 'clearTerminal')).toBe(false)
  expect(patches.some(patch => patch.type === 'clear')).toBe(false)
}

describe('frame replay characterization (real Output → Screen → LogUpdate)', () => {
  test('identical frames are silent; a single-cell change writes only that cell', () => {
    const r = replay()
    const first = r.next(out => out.write(0, 0, 'abc'))
    const snapshot = semanticCells(first.screen, r.stylePool)
    const same = r.next(out => out.write(0, 0, 'abc'))
    expect(semanticCells(same.screen, r.stylePool)).toEqual(snapshot)
    expect(same.patches).toEqual([])

    const changed = r.next(out => out.write(0, 0, 'axc'))
    expect(cellAt(changed.screen, 1, 0)?.char).toBe('x')
    expect(cellAt(changed.screen, 0, 0)?.char).toBe('a')
    expect(cellAt(changed.screen, 2, 0)?.char).toBe('c')
    expect(writes(changed.patches)).toEqual(['x'])
    expectIncremental(changed.patches)
    expect(r.next(out => out.write(0, 0, 'axc')).patches).toEqual([])
  })

  for (const half of [0, 1]) {
    test(`overwriting wide-character half ${half} clears its other half`, () => {
      const r = replay()
      const wide = r.next(out => out.write(0, 0, '本!'))
      expect(cellAt(wide.screen, 0, 0)?.width).toBe(CellWidth.Wide)
      expect(cellAt(wide.screen, 1, 0)?.width).toBe(CellWidth.SpacerTail)
      const paint = (out: Output) => {
        out.write(0, 0, '本!')
        out.write(half, 0, 'x')
      }
      const next = r.next(paint)
      for (const x of [0, 1]) {
        expect(cellAt(next.screen, x, 0)).toEqual({
          char: x === half ? 'x' : ' ',
          width: CellWidth.Narrow,
          styleId: r.stylePool.none,
          hyperlink: undefined,
        })
      }
      expect(cellAt(next.screen, 2, 0)?.char).toBe('!')
      expect(writes(next.patches)).toEqual(half === 0 ? ['x', ' '] : [' ', 'x'])
      expectIncremental(next.patches)
      expect(r.next(paint).patches).toEqual([])
    })
  }

  test('combining sequences and ZWJ emoji remain whole grapheme cells', () => {
    const r = replay()
    const paint = (out: Output) => out.write(0, 0, 'e\u0301👩‍💻!')
    const first = r.next(paint)
    expect(cellAt(first.screen, 0, 0)?.char).toBe('e\u0301')
    expect(cellAt(first.screen, 0, 0)?.width).toBe(CellWidth.Narrow)
    expect(cellAt(first.screen, 1, 0)?.char).toBe('👩‍💻')
    expect(cellAt(first.screen, 1, 0)?.width).toBe(CellWidth.Wide)
    expect(cellAt(first.screen, 2, 0)?.width).toBe(CellWidth.SpacerTail)
    expect(cellAt(first.screen, 3, 0)?.char).toBe('!')
    expect(writes(first.patches)).toContain('e\u0301')
    expect(writes(first.patches)).toContain('👩‍💻')
    expect(r.next(paint).patches).toEqual([])
    const changed = r.next(out => out.write(0, 0, 'o\u0308👩‍💻!'))
    expect(writes(changed.patches)).toEqual(['o\u0308'])
    expectIncremental(changed.patches)
  })

  test('content shrink clears removed rows; viewport shrink requests resize reset', () => {
    const r = replay()
    r.next(out => out.write(0, 0, 'a\nb\nc'), 10, 3)
    const short = r.next(out => out.write(0, 0, 'a'), 10, 1)
    expect(short.screen.height).toBe(1)
    expect(cellAt(short.screen, 0, 1)).toBeUndefined()
    expect(short.patches).toContainEqual({ type: 'clear', count: 2 })
    expect(short.patches.some(patch => patch.type === 'clearTerminal')).toBe(
      false,
    )
    const resized = r.next(out => out.write(0, 0, 'a'), 8, 1, {
      width: 8,
      height: 4,
    })
    expect(resized.screen.width).toBe(8)
    expect(resized.patches).toContainEqual({
      type: 'clearTerminal',
      reason: 'resize',
    })
    expect(writes(resized.patches)).toContain('a')
    expect(
      r.next(out => out.write(0, 0, 'a'), 8, 1, {
        width: 8,
        height: 4,
      }).patches,
    ).toEqual([])
  })

  test('softWrap and noSelect change metadata without repainting equal cells', () => {
    const r = replay()
    const first = r.next(out => {
      out.write(1, 0, 'ab\ncd', [false, true])
      out.noSelect({ x: 1, y: 0, width: 1, height: 1 })
    })
    const snapshot = semanticCells(first.screen, r.stylePool)
    expect(Array.from(first.screen.softWrap)).toEqual([0, 3])
    expect(first.screen.noSelect[1]).toBe(1)
    const next = r.next(out => {
      out.write(1, 0, 'ab\ncd', [false, false])
      out.noSelect({ x: 2, y: 1, width: 1, height: 1 })
    })
    expect(semanticCells(next.screen, r.stylePool)).toEqual(snapshot)
    expect(Array.from(next.screen.softWrap)).toEqual([0, 0])
    expect(next.screen.noSelect[1]).toBe(0)
    expect(next.screen.noSelect[12]).toBe(1)
    expect(next.patches).toEqual([])
  })

  test('epoch remap preserves styles and cached text; actual style changes repaint', () => {
    const r = replay()
    r.stylePool.intern([
      { type: 'ansi', code: '\x1b[34m', endCode: '\x1b[39m' },
    ])
    const red = (out: Output) => out.write(0, 0, '\x1b[31mx\x1b[39m')
    const first = r.next(red)
    const snapshot = semanticCells(first.screen, r.stylePool)
    const oldId = cellAt(first.screen, 0, 0)!.styleId
    const epoch = r.stylePool.epoch
    r.stylePool.reset(first.screen)
    expect(r.stylePool.epoch).toBe(epoch + 1)
    expect(cellAt(first.screen, 0, 0)!.styleId).not.toBe(oldId)
    const same = r.next(red)
    expect(semanticCells(same.screen, r.stylePool)).toEqual(snapshot)
    expect(same.patches).toEqual([])
    const blue = r.next(out => out.write(0, 0, '\x1b[34mx\x1b[39m'))
    expect(semanticCells(blue.screen, r.stylePool)[0]![0]!.styles).toEqual([
      '\x1b[34m',
    ])
    expect(writes(blue.patches)).toEqual(['x'])
    expect(blue.patches).toContainEqual({ type: 'styleStr', str: '\x1b[34m' })
    expect(blue.patches).toContainEqual({ type: 'styleStr', str: '\x1b[39m' })
    expectIncremental(blue.patches)
  })

  test('hyperlink-only changes repaint and close the link after the glyph', () => {
    const r = replay()
    const linked = (uri: string) => (out: Output) =>
      out.write(0, 0, `\x1b]8;;${uri}\x07x\x1b]8;;\x07`)
    r.next(linked('https://example.com/a'))
    const next = r.next(linked('https://example.com/b'))
    expect(cellAt(next.screen, 0, 0)?.hyperlink).toBe('https://example.com/b')
    const relevant = next.patches.filter(
      patch =>
        patch.type === 'hyperlink' ||
        (patch.type === 'stdout' && patch.content !== '\n'),
    )
    expect(relevant).toEqual([
      { type: 'hyperlink', uri: 'https://example.com/b' },
      { type: 'stdout', content: 'x' },
      { type: 'hyperlink', uri: '' },
    ])
    expectIncremental(next.patches)
    expect(r.next(linked('https://example.com/b')).patches).toEqual([])
    const unlinked = r.next(out => out.write(0, 0, 'x'))
    expect(cellAt(unlinked.screen, 0, 0)?.hyperlink).toBeUndefined()
    expect(writes(unlinked.patches)).toEqual(['x'])
    expect(unlinked.patches.some(patch => patch.type === 'hyperlink')).toBe(
      false,
    )
  })
})
