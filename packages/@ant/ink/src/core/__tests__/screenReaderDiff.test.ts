import { describe, expect, test } from 'bun:test'
import type { Frame } from '../frame.js'
import {
  CellWidth,
  CharPool,
  createScreen,
  HyperlinkPool,
  setCellAt,
  StylePool,
  type Screen,
} from '../screen.js'
import { ScreenReaderDiff } from '../screen-reader-diff.js'

const stylePool = new StylePool()
const charPool = new CharPool()
const hyperlinkPool = new HyperlinkPool()

function makeFrame(width: number, height: number): Frame {
  return {
    screen: createScreen(width, height, stylePool, charPool, hyperlinkPool),
    viewport: { width, height },
    cursor: { x: 0, y: 0, visible: false },
  }
}

function writeLine(screen: Screen, y: number, text: string, x = 0): void {
  for (let i = 0; i < text.length; i++) {
    setCellAt(screen, x + i, y, {
      char: text[i]!,
      styleId: screen.emptyStyleId,
      width: CellWidth.Narrow,
      hyperlink: undefined,
    })
  }
}

describe('ScreenReaderDiff', () => {
  test('first capture reports the full frame', () => {
    const diff = new ScreenReaderDiff()
    const frame = makeFrame(10, 3)
    writeLine(frame.screen, 0, 'hello')
    writeLine(frame.screen, 2, 'world')

    expect(diff.capture(frame)).toBe('hello\nworld')
  })

  test('subsequent capture reports only changed lines', () => {
    const diff = new ScreenReaderDiff()
    const first = makeFrame(10, 3)
    writeLine(first.screen, 0, 'hello')
    writeLine(first.screen, 2, 'world')
    diff.capture(first)

    const second = makeFrame(10, 3)
    writeLine(second.screen, 0, 'hello')
    writeLine(second.screen, 2, 'WORLD')

    expect(diff.capture(second)).toBe('WORLD')
  })

  test('returns null when nothing changed', () => {
    const diff = new ScreenReaderDiff()
    const first = makeFrame(10, 2)
    writeLine(first.screen, 0, 'hello world')
    diff.capture(first)

    const second = makeFrame(10, 2)
    writeLine(second.screen, 0, 'hello world')

    expect(diff.capture(second)).toBeNull()
  })

  test('reset re-reports the full frame', () => {
    const diff = new ScreenReaderDiff()
    const frame = makeFrame(10, 2)
    writeLine(frame.screen, 0, 'hello')
    expect(diff.capture(frame)).toBe('hello')
    expect(diff.capture(frame)).toBeNull()

    diff.reset()
    expect(diff.capture(frame)).toBe('hello')
  })

  test('screen resize resets the cache and re-reports', () => {
    const diff = new ScreenReaderDiff()
    const first = makeFrame(10, 2)
    writeLine(first.screen, 0, 'hello')
    expect(diff.capture(first)).toBe('hello')

    // Same text, wider screen — dimensions changed, so the summary is
    // re-reported in full instead of diffing against a stale buffer.
    const second = makeFrame(12, 2)
    writeLine(second.screen, 0, 'hello')
    expect(diff.capture(second)).toBe('hello')
  })

  test('wide characters contribute their head char and skip spacer tails', () => {
    const diff = new ScreenReaderDiff()
    const frame = makeFrame(10, 1)
    // '你' occupies 2 cells: Wide head + SpacerTail (created by setCellAt).
    setCellAt(frame.screen, 0, 0, {
      char: '你',
      styleId: frame.screen.emptyStyleId,
      width: CellWidth.Wide,
      hyperlink: undefined,
    })
    writeLine(frame.screen, 0, 'a', 2)

    expect(diff.capture(frame)).toBe('你a')
  })

  test('empty screen produces null, not an empty summary', () => {
    const diff = new ScreenReaderDiff()
    expect(diff.capture(makeFrame(10, 3))).toBeNull()
  })
})
