import { beforeAll, describe, expect, test } from 'bun:test'
import {
  LayoutAlign,
  LayoutDisplay,
  LayoutEdge,
  LayoutFlexDirection,
  LayoutGutter,
  LayoutMeasureMode,
  type LayoutNode,
  LayoutPositionType,
} from '../layout/node.js'
import { createYogaLayoutNode } from '../layout/yoga.js'

// P0 characterization of the real TS adapter's supported LTR, non-wrapping
// subset, not a claim of complete Yoga compatibility or a frozen Rust spec.
// Height constraints use setHeight: calculateLayout's height argument is
// currently ignored by the adapter. No global counters/config are inspected.
function geometry(node: LayoutNode) {
  return [
    node.getComputedLeft(),
    node.getComputedTop(),
    node.getComputedWidth(),
    node.getComputedHeight(),
  ]
}

function child(parent: LayoutNode, width?: number, height?: number) {
  const node = createYogaLayoutNode()
  parent.insertChild(node, parent.getChildCount())
  if (width !== undefined) node.setWidth(width)
  if (height !== undefined) node.setHeight(height)
  return node
}

function withRoot(run: (root: LayoutNode) => void) {
  const root = createYogaLayoutNode()
  try {
    run(root)
  } finally {
    root.freeRecursive()
  }
}

// A deliberately simple, monospaced ASCII measurement fixture supplied through
// the existing callback API. It does not replace layout or test Unicode shaping.
function measuredText(node: LayoutNode, initialText = 'abcdefghijkl') {
  let text = initialText
  const calls: { width: number; mode: LayoutMeasureMode }[] = []
  node.setMeasureFunc((width, mode) => {
    calls.push({ width, mode })
    const columns =
      mode === LayoutMeasureMode.Undefined
        ? text.length
        : Math.max(1, Math.min(width, text.length))
    return { width: columns, height: Math.ceil(text.length / columns) }
  })
  return {
    calls,
    update(value: string) {
      text = value
      node.markDirty()
    },
  }
}

describe('layout adapter supported-subset characterization', () => {
  test.each([LayoutFlexDirection.Row, LayoutFlexDirection.Column])(
    '%s places fixed children with axis gap, padding and border',
    direction => {
      withRoot(root => {
        root.setWidth(20)
        root.setHeight(16)
        root.setFlexDirection(direction)
        root.setAlignItems(LayoutAlign.FlexStart)
        root.setPadding(LayoutEdge.All, 1)
        root.setBorder(LayoutEdge.All, 1)
        root.setGap(LayoutGutter.All, 2)
        const a = child(root, 4, 3)
        const b = child(root, 6, 2)
        root.calculateLayout()
        expect(geometry(root)).toEqual([0, 0, 20, 16])
        expect(geometry(a)).toEqual([2, 2, 4, 3])
        expect(geometry(b)).toEqual(
          direction === LayoutFlexDirection.Row ? [8, 2, 6, 2] : [2, 7, 6, 2],
        )
        for (const edge of [
          LayoutEdge.Left,
          LayoutEdge.Top,
          LayoutEdge.Right,
          LayoutEdge.Bottom,
        ]) {
          expect(root.getComputedPadding(edge)).toBe(1)
          expect(root.getComputedBorder(edge)).toBe(1)
        }
      })
    },
  )

  test('row distributes grow by weight and shrink by weighted basis', () => {
    withRoot(root => {
      root.setFlexDirection(LayoutFlexDirection.Row)
      root.setHeight(2)
      const a = child(root, 4)
      const b = child(root, 8)
      a.setFlexGrow(1)
      b.setFlexGrow(2)
      a.setFlexShrink(1)
      b.setFlexShrink(1)
      root.calculateLayout(24)
      expect([root, a, b].map(geometry)).toEqual([
        [0, 0, 24, 2],
        [0, 0, 8, 2],
        [8, 0, 16, 2],
      ])
      root.calculateLayout(6)
      expect([root, a, b].map(geometry)).toEqual([
        [0, 0, 6, 2],
        [0, 0, 2, 2],
        [2, 0, 4, 2],
      ])
    })
  })

  test('flex redistribution respects max during growth and min during shrink', () => {
    withRoot(root => {
      root.setFlexDirection(LayoutFlexDirection.Row)
      root.setHeight(2)
      const a = child(root, 4)
      const b = child(root, 4)
      a.setFlexGrow(1)
      b.setFlexGrow(1)
      a.setMaxWidth(6)
      root.calculateLayout(20)
      expect([root, a, b].map(geometry)).toEqual([
        [0, 0, 20, 2],
        [0, 0, 6, 2],
        [6, 0, 14, 2],
      ])
      a.setWidth(8)
      b.setWidth(8)
      a.setMinWidth(6)
      a.setFlexShrink(1)
      b.setFlexShrink(1)
      root.calculateLayout(10)
      expect([root, a, b].map(geometry)).toEqual([
        [0, 0, 10, 2],
        [0, 0, 6, 2],
        [6, 0, 4, 2],
      ])
    })
  })

  test('column distributes grow and shrink on the height axis', () => {
    withRoot(root => {
      root.setWidth(3)
      root.setHeight(12)
      root.setFlexDirection(LayoutFlexDirection.Column)
      const a = child(root, undefined, 2)
      const b = child(root, undefined, 4)
      a.setFlexGrow(1)
      b.setFlexGrow(2)
      a.setFlexShrink(1)
      b.setFlexShrink(1)
      root.calculateLayout()
      expect([root, a, b].map(geometry)).toEqual([
        [0, 0, 3, 12],
        [0, 0, 3, 4],
        [0, 4, 3, 8],
      ])
      root.setHeight(3)
      root.calculateLayout()
      expect([root, a, b].map(geometry)).toEqual([
        [0, 0, 3, 3],
        [0, 0, 3, 1],
        [0, 1, 3, 2],
      ])
    })
  })

  test('min/max dimensions clamp explicit sizes on both axes', () => {
    withRoot(root => {
      root.setFlexDirection(LayoutFlexDirection.Row)
      root.setAlignItems(LayoutAlign.FlexStart)
      const a = child(root, 1, 1)
      a.setMinWidth(4)
      a.setMinHeight(3)
      const b = child(root, 30, 20)
      b.setMaxWidth(6)
      b.setMaxHeight(5)
      root.calculateLayout(20)
      expect([root, a, b].map(geometry)).toEqual([
        [0, 0, 20, 5],
        [0, 0, 4, 3],
        [4, 0, 6, 5],
      ])
    })
  })

  test('percent dimensions resolve against an unpadded definite parent on resize', () => {
    withRoot(root => {
      root.setHeight(12)
      root.setAlignItems(LayoutAlign.FlexStart)
      const a = child(root)
      a.setWidthPercent(50)
      a.setHeightPercent(50)
      root.calculateLayout(24)
      expect([root, a].map(geometry)).toEqual([
        [0, 0, 24, 12],
        [0, 0, 12, 6],
      ])
      root.calculateLayout(44)
      expect([root, a].map(geometry)).toEqual([
        [0, 0, 44, 12],
        [0, 0, 22, 6],
      ])
    })
  })

  // content-box 目标仍待语义裁决，不是冻结的 Rust 兼容规范。
  // 算法执行和释放放在 beforeAll：无关异常必须失败，不能被 failing 吞掉。
  describe('known discrepancy: padded parent percentage basis', () => {
    let initial: number[][]
    let resized: number[][]

    beforeAll(() => {
      withRoot(root => {
        root.setHeight(12)
        root.setPadding(LayoutEdge.All, 2)
        root.setAlignItems(LayoutAlign.FlexStart)
        const a = child(root)
        a.setWidthPercent(50)
        a.setHeightPercent(50)
        root.calculateLayout(24)
        initial = [root, a].map(geometry)
        root.calculateLayout(44)
        resized = [root, a].map(geometry)
      })
      for (const snapshot of [initial, resized]) {
        expect(snapshot).toHaveLength(2)
        for (const rect of snapshot) {
          expect(rect).toHaveLength(4)
          expect(rect.every(Number.isFinite)).toBe(true)
        }
      }
    })

    test.failing('pending content-box target at width 24', () => {
      expect(initial).toEqual([
        [0, 0, 24, 12],
        [2, 2, 10, 4],
      ])
    })

    test.failing('pending content-box target after resize to width 44', () => {
      expect(resized).toEqual([
        [0, 0, 44, 12],
        [2, 2, 20, 4],
      ])
    })
  })

  test('absolute point/percent insets do not consume flow space', () => {
    withRoot(root => {
      root.setWidth(20)
      root.setHeight(10)
      const flow = child(root, 7, 2)
      const overlay = child(root, 4, 3)
      overlay.setPositionType(LayoutPositionType.Absolute)
      overlay.setPositionPercent(LayoutEdge.Left, 50)
      overlay.setPosition(LayoutEdge.Top, 2)
      const corner = child(root, 2, 2)
      corner.setPositionType(LayoutPositionType.Absolute)
      corner.setPosition(LayoutEdge.Right, 1)
      corner.setPosition(LayoutEdge.Bottom, 1)
      root.calculateLayout()
      expect([root, flow, overlay, corner].map(geometry)).toEqual([
        [0, 0, 20, 10],
        [0, 0, 7, 2],
        [10, 2, 4, 3],
        [17, 7, 2, 2],
      ])
    })
  })

  test('display none zeros a subtree and restores flow after toggling', () => {
    withRoot(root => {
      root.setFlexDirection(LayoutFlexDirection.Row)
      root.setAlignItems(LayoutAlign.FlexStart)
      root.setGap(LayoutGutter.Column, 1)
      const a = child(root, 3, 2)
      const hidden = child(root, 4, 3)
      const nested = child(hidden, 2, 1)
      const b = child(root, 5, 2)
      root.calculateLayout(20)
      expect([root, a, hidden, nested, b].map(geometry)).toEqual([
        [0, 0, 20, 3],
        [0, 0, 3, 2],
        [4, 0, 4, 3],
        [0, 0, 2, 1],
        [9, 0, 5, 2],
      ])
      hidden.setDisplay(LayoutDisplay.None)
      root.calculateLayout(20)
      expect(hidden.getDisplay()).toBe(LayoutDisplay.None)
      expect([root, a, hidden, nested, b].map(geometry)).toEqual([
        [0, 0, 20, 2],
        [0, 0, 3, 2],
        [0, 0, 0, 0],
        [0, 0, 0, 0],
        [4, 0, 5, 2],
      ])
      hidden.setDisplay(LayoutDisplay.Flex)
      root.calculateLayout(20)
      expect(hidden.getDisplay()).toBe(LayoutDisplay.Flex)
      expect([root, a, hidden, nested, b].map(geometry)).toEqual([
        [0, 0, 20, 3],
        [0, 0, 3, 2],
        [4, 0, 4, 3],
        [0, 0, 2, 1],
        [9, 0, 5, 2],
      ])
    })
  })

  test('unconstrained text receives Undefined; exact width excludes padding/border', () => {
    withRoot(root => {
      const text = measuredText(root)
      root.calculateLayout()
      expect(text.calls).toEqual([
        { width: NaN, mode: LayoutMeasureMode.Undefined },
      ])
      expect(geometry(root)).toEqual([0, 0, 12, 1])
      text.calls.length = 0
      root.setPadding(LayoutEdge.All, 1)
      root.setBorder(LayoutEdge.All, 1)
      root.calculateLayout(10)
      expect(text.calls).toEqual([
        { width: 6, mode: LayoutMeasureMode.Exactly },
      ])
      expect(geometry(root)).toEqual([0, 0, 10, 6])
    })
  })

  test('non-stretched text receives AtMost and wraps under a narrow parent', () => {
    withRoot(root => {
      root.setAlignItems(LayoutAlign.FlexStart)
      const leaf = child(root)
      const text = measuredText(leaf)
      root.calculateLayout(5)
      expect(text.calls).toContainEqual({
        width: 5,
        mode: LayoutMeasureMode.AtMost,
      })
      expect([root, leaf].map(geometry)).toEqual([
        [0, 0, 5, 3],
        [0, 0, 5, 3],
      ])
      root.calculateLayout(20)
      expect(text.calls).toContainEqual({
        width: 20,
        mode: LayoutMeasureMode.AtMost,
      })
      expect([root, leaf].map(geometry)).toEqual([
        [0, 0, 20, 1],
        [0, 0, 12, 1],
      ])
    })
  })

  test('resize, clean relayout, dirty text and style changes update ancestor geometry', () => {
    withRoot(root => {
      const container = child(root)
      const leaf = child(container)
      const text = measuredText(leaf)
      const footer = child(root, undefined, 1)
      root.calculateLayout(6)
      expect([root, container, leaf, footer].map(geometry)).toEqual([
        [0, 0, 6, 3],
        [0, 0, 6, 2],
        [0, 0, 6, 2],
        [0, 2, 6, 1],
      ])
      text.calls.length = 0
      root.calculateLayout(6)
      expect(text.calls).toEqual([])
      root.calculateLayout(1)
      expect([root, container, leaf, footer].map(geometry)).toEqual([
        [0, 0, 1, 13],
        [0, 0, 1, 12],
        [0, 0, 1, 12],
        [0, 12, 1, 1],
      ])
      root.calculateLayout(6)
      text.calls.length = 0
      text.update('abcdefghijklmnopqr')
      root.calculateLayout(6)
      expect(text.calls.length).toBeGreaterThan(0)
      expect([root, container, leaf, footer].map(geometry)).toEqual([
        [0, 0, 6, 4],
        [0, 0, 6, 3],
        [0, 0, 6, 3],
        [0, 3, 6, 1],
      ])
      footer.setHeight(2)
      root.calculateLayout(6)
      expect([root, container, leaf, footer].map(geometry)).toEqual([
        [0, 0, 6, 5],
        [0, 0, 6, 3],
        [0, 0, 6, 3],
        [0, 3, 6, 2],
      ])
      leaf.unsetMeasureFunc()
      text.calls.length = 0
      root.calculateLayout(6)
      expect(text.calls).toEqual([])
      expect([root, container, leaf, footer].map(geometry)).toEqual([
        [0, 0, 6, 2],
        [0, 0, 6, 0],
        [0, 0, 6, 0],
        [0, 0, 6, 2],
      ])
    })
  })

  test('detach/free and recursive release clear local tree ownership', () => {
    const root = createYogaLayoutNode()
    const branch = child(root, 4, 2)
    const leaf = child(branch, 2, 1)
    const survivor = child(root, 3, 1)
    let detached = false
    try {
      root.calculateLayout(10)
      expect(branch.getParent()?.getChildCount()).toBe(2)
      root.removeChild(branch)
      detached = true
      expect(branch.getParent()).toBeNull()
      expect(root.getChildCount()).toBe(1)
      root.calculateLayout(10)
      expect([root, survivor].map(geometry)).toEqual([
        [0, 0, 10, 1],
        [0, 0, 3, 1],
      ])
    } finally {
      if (detached) branch.freeRecursive()
      root.freeRecursive()
    }
    for (const node of [root, branch, leaf, survivor]) {
      expect(node.getParent()).toBeNull()
      expect(node.getChildCount()).toBe(0)
    }
    // free() is exercised only on an unattached leaf; no use-after-free layout
    // or double-free/idempotence guarantee is asserted.
    const standalone = createYogaLayoutNode()
    standalone.free()
    expect(standalone.getParent()).toBeNull()
    expect(standalone.getChildCount()).toBe(0)
  })
})
