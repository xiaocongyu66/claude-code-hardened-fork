import { describe, expect, test } from 'bun:test'
import { LogUpdate } from '../log-update.js'
import {
  CharPool,
  createScreen,
  HyperlinkPool,
  setCellAt,
  StylePool,
  CellWidth,
} from '../screen.js'
import { emptyFrame, shouldClearScreen } from '../frame.js'
import type { Frame } from '../frame.js'

/**
 * 黄金帧基线（批次 R0）：LogUpdate diff 输出的关键性质断言。
 * R1/R2/R3 每步以这些测试不回归为准——重写 diff 前先钉住行为。
 */
function makePools() {
  return {
    styles: new StylePool(),
    chars: new CharPool(),
    links: new HyperlinkPool(),
  }
}

function frameWithText(
  pools: ReturnType<typeof makePools>,
  width: number,
  height: number,
  lines: string[],
): Frame {
  const screen = createScreen(
    width,
    height,
    pools.styles,
    pools.chars,
    pools.links,
  )
  for (let y = 0; y < lines.length && y < height; y++) {
    const line = lines[y]
    for (let x = 0; x < line.length && x < width; x++) {
      setCellAt(screen, x, y, {
        char: line[x]!,
        styleId: pools.styles.none,
        width: CellWidth.Narrow,
        hyperlink: undefined,
      })
    }
  }
  return {
    screen,
    viewport: { width, height },
    cursor: { x: 0, y: 0, visible: true },
  }
}

function makeLogUpdate(pools: ReturnType<typeof makePools>): LogUpdate {
  return new LogUpdate({ isTTY: true, stylePool: pools.styles } as never)
}

describe('LogUpdate 黄金帧', () => {
  test('初帧：空 prev → 有内容 next = 全帧 stdout（含文本行）', () => {
    const pools = makePools()
    const log = makeLogUpdate(pools)
    const prev = emptyFrame(5, 20, pools.styles, pools.chars, pools.links)
    const next = frameWithText(pools, 20, 5, ['hello world'])
    const diff = log.render(prev, next)
    const stdout = diff.find(p => p.type === 'stdout')
    expect(stdout).toBeDefined()
    expect(
      stdout &&
        stdout.type === 'stdout' &&
        stdout.content.includes('hello world'),
    ).toBe(true)
  })

  test('增量帧：同尺寸仅一行变化 = patch 不含未变行文本', () => {
    const pools = makePools()
    const log = makeLogUpdate(pools)
    const prev = frameWithText(pools, 20, 5, [
      'alpha line',
      'beta  line',
      'gamma line',
    ])
    const next = frameWithText(pools, 20, 5, [
      'alpha line',
      'beta  CHANGED',
      'gamma line',
    ])
    const diff = log.render(prev, next)
    const stdoutPatches = diff.filter(p => p.type === 'stdout')
    const all = stdoutPatches
      .map(p => (p.type === 'stdout' ? p.content : ''))
      .join('\n')
    expect(all.includes('CHANGED')).toBe(true)
    // 未变行不应重复输出（增量性质）
    expect(all.includes('alpha line')).toBe(false)
    expect(all.includes('gamma line')).toBe(false)
  })

  test('resize：viewport 变化 → shouldClearScreen 返回 resize', () => {
    const pools = makePools()
    const prev = frameWithText(pools, 20, 5, ['hello'])
    const next = frameWithText(pools, 30, 8, ['hello'])
    expect(shouldClearScreen(prev, next)).toBe('resize')
  })

  test('同尺寸无变化 → 无 resize/offscreen 触发', () => {
    const pools = makePools()
    const prev = frameWithText(pools, 20, 5, ['hello'])
    const next = frameWithText(pools, 20, 5, ['hello'])
    expect(shouldClearScreen(prev, next)).toBeUndefined()
  })

  test('alt-screen 分支：render 不抛错且返回数组', () => {
    const pools = makePools()
    const log = makeLogUpdate(pools)
    const prev = frameWithText(pools, 20, 5, ['old'])
    const next = frameWithText(pools, 20, 5, ['new'])
    const diff = log.render(prev, next, true)
    expect(Array.isArray(diff)).toBe(true)
  })

  test('宽字符：CJK 占 2 cell，全帧输出保留字符', () => {
    const pools = makePools()
    const log = makeLogUpdate(pools)
    const screen = createScreen(20, 3, pools.styles, pools.chars, pools.links)
    const text = '你好'
    let x = 0
    for (const ch of text) {
      setCellAt(screen, x, 0, {
        char: ch,
        styleId: pools.styles.none,
        width: CellWidth.Wide,
        hyperlink: undefined,
      })
      x += 2
    }
    const next: Frame = {
      screen,
      viewport: { width: 20, height: 3 },
      cursor: { x: 0, y: 0, visible: true },
    }
    const prev = emptyFrame(3, 20, pools.styles, pools.chars, pools.links)
    const diff = log.render(prev, next)
    const stdout = diff.find(p => p.type === 'stdout')
    expect(
      stdout && stdout.type === 'stdout' && stdout.content.includes('你好'),
    ).toBe(true)
  })
})
