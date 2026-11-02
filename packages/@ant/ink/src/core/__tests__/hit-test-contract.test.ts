import { describe, expect, test } from 'bun:test'
import {
  appendChildNode,
  createNode,
  type DOMElement,
  removeChildNode,
  setStyle,
} from '../dom.js'
import type { ClickEvent } from '../events/click-event.js'
import { dispatchClick, dispatchHover, hitTest } from '../hit-test.js'
import { type CachedLayout, nodeCache, pendingClears } from '../node-cache.js'

// Real DOM/layout nodes and hand-authored committed screen rectangles. This
// exercises cache consumers, not Yoga layout, renderer clipping, or CLI startup.
// Each test owns its nodes; finally also handles detached subtrees and failures.
function withTree(run: (tree: ReturnType<typeof fixture>) => void): void {
  const tree = fixture()
  try {
    run(tree)
  } finally {
    tree.dispose()
  }
}

function fixture() {
  const nodes: DOMElement[] = []
  function node(rect?: CachedLayout, parent?: DOMElement): DOMElement {
    const element = createNode(parent ? 'ink-box' : 'ink-root')
    nodes.push(element)
    if (parent) appendChildNode(parent, element)
    if (rect) nodeCache.set(element, rect)
    return element
  }
  function dispose(): void {
    // Children are allocated after parents. Detach before freeing individually
    // so removed subtrees are released too, without freeRecursive double frees.
    for (const element of [...nodes].reverse()) {
      if (element.parentNode) removeChildNode(element.parentNode, element)
      nodeCache.delete(element)
      pendingClears.delete(element)
      element._eventHandlers = undefined
      element.yogaNode?.free()
    }
    nodes.length = 0
  }
  return { node, dispose }
}

describe('hit-test contracts with committed geometry', () => {
  test('includes left/top and excludes right/bottom edges', () => {
    withTree(({ node }) => {
      const root = node({ x: 10, y: 4, width: 6, height: 3 })
      expect(hitTest(root, 10, 4)).toBe(root)
      expect(hitTest(root, 15, 6)).toBe(root)
      expect(hitTest(root, 9, 4)).toBeNull()
      expect(hitTest(root, 10, 3)).toBeNull()
      expect(hitTest(root, 16, 4)).toBeNull()
      expect(hitTest(root, 10, 7)).toBeNull()
    })
  })

  test('missing and zero-area rectangles cannot be hit', () => {
    withTree(({ node }) => {
      const root = node()
      const child = node({ x: 0, y: 0, width: 4, height: 2 }, root)
      expect(hitTest(root, 0, 0)).toBeNull()
      nodeCache.set(root, { x: 0, y: 0, width: 10, height: 5 })
      expect(hitTest(root, 0, 0)).toBe(child)
      nodeCache.delete(child)
      expect(hitTest(root, 0, 0)).toBe(root)
      nodeCache.set(child, { x: 0, y: 0, width: 0, height: 2 })
      expect(hitTest(root, 0, 0)).toBe(root)
      nodeCache.set(child, { x: 0, y: 0, width: 4, height: 0 })
      expect(hitTest(root, 0, 0)).toBe(root)
    })
  })

  test('later overlapping siblings win, even without click handlers', () => {
    withTree(({ node }) => {
      const root = node({ x: 0, y: 0, width: 20, height: 10 })
      const earlier = node({ x: 2, y: 2, width: 8, height: 4 }, root)
      const later = node({ x: 5, y: 3, width: 8, height: 4 }, root)
      let earlierClicks = 0
      earlier._eventHandlers = {
        onClick: () => {
          earlierClicks++
        },
      }
      expect(hitTest(root, 6, 3)).toBe(later)
      expect(dispatchClick(root, 6, 3)).toBe(false)
      expect(earlierClicks).toBe(0)
      expect(hitTest(root, 2, 2)).toBe(earlier)
      expect(hitTest(root, 13, 3)).toBe(root)
    })
  })

  test('descendants win inside their parent; ancestor rectangles bound traversal', () => {
    withTree(({ node }) => {
      const root = node({ x: 0, y: 0, width: 20, height: 10 })
      const parent = node({ x: 4, y: 2, width: 6, height: 4 }, root)
      const child = node({ x: 8, y: 3, width: 6, height: 2 }, parent)
      expect(hitTest(root, 4, 2)).toBe(parent)
      expect(hitTest(root, 8, 3)).toBe(child)
      expect(hitTest(root, 9, 4)).toBe(child)
      // This is ancestor-rectangle rejection, NOT an independent clip API.
      expect(hitTest(root, 10, 3)).toBe(root)
      expect(hitTest(root, 13, 4)).toBe(root)
      expect(hitTest(root, 20, 3)).toBeNull()
    })
  })

  test('scroll hit and local coordinates use committed screen bounds, not scrollTop', () => {
    withTree(({ node }) => {
      const root = node({ x: 0, y: 0, width: 30, height: 20 })
      const viewport = node({ x: 3, y: 5, width: 10, height: 4 }, root)
      setStyle(viewport, { overflow: 'scroll' })
      viewport.scrollTop = 6
      // The child has already been translated into screen space by the fixture.
      const child = node({ x: 4, y: 4, width: 5, height: 3, top: 5 }, viewport)
      const clicks: number[][] = []
      child._eventHandlers = {
        onClick: event => {
          clicks.push([event.localCol, event.localRow])
        },
      }
      expect(hitTest(root, 4, 4)).toBe(root)
      expect(hitTest(root, 4, 5)).toBe(child)
      expect(dispatchClick(root, 5, 6)).toBe(true)
      expect(clicks).toEqual([[1, 2]])
      viewport.scrollTop = 7
      expect(hitTest(root, 4, 6)).toBe(child)
      // Only publishing a new cached rect changes this consumer's geometry.
      nodeCache.set(child, { x: 4, y: 3, width: 5, height: 3, top: 5 })
      expect(hitTest(root, 4, 5)).toBe(child)
      expect(hitTest(root, 4, 6)).toBe(viewport)
      expect(hitTest(root, 4, 9)).toBe(root)
    })
  })

  test('click bubbles through handlerless ancestors and recomputes local coordinates', () => {
    withTree(({ node }) => {
      const root = node({ x: 2, y: 1, width: 20, height: 12 })
      const parent = node({ x: 5, y: 3, width: 12, height: 8 }, root)
      const middle = node({ x: 6, y: 4, width: 8, height: 6 }, parent)
      const child = node({ x: 8, y: 5, width: 4, height: 3 }, middle)
      const calls: unknown[][] = []
      const events: ClickEvent[] = []
      const record = (name: string) => (event: ClickEvent) => {
        events.push(event)
        calls.push([
          name,
          event.col,
          event.row,
          event.localCol,
          event.localRow,
          event.cellIsBlank,
        ])
      }
      child._eventHandlers = { onClick: record('child') }
      parent._eventHandlers = { onClick: record('parent') }
      root._eventHandlers = { onClick: record('root') }
      expect(dispatchClick(root, 9, 6, true)).toBe(true)
      expect(calls).toEqual([
        ['child', 9, 6, 1, 1, true],
        ['parent', 9, 6, 4, 3, true],
        ['root', 9, 6, 7, 5, true],
      ])
      expect(events[0]).toBe(events[1])
      expect(events[1]).toBe(events[2])
      expect(dispatchClick(root, 22, 6)).toBe(false)
      expect(calls).toHaveLength(3)
    })
  })

  test('stopImmediatePropagation prevents ancestor clicks', () => {
    withTree(({ node }) => {
      const root = node({ x: 0, y: 0, width: 10, height: 5 })
      const child = node({ x: 1, y: 1, width: 3, height: 2 }, root)
      const calls: string[] = []
      root._eventHandlers = {
        onClick: () => {
          calls.push('root')
        },
      }
      child._eventHandlers = {
        onClick: event => {
          calls.push('child')
          expect(event.cellIsBlank).toBe(false)
          event.stopImmediatePropagation()
        },
      }
      expect(dispatchClick(root, 1, 1)).toBe(true)
      expect(calls).toEqual(['child'])
    })
  })

  test('hover tracks membership without bubbling sibling transitions to the parent', () => {
    withTree(({ node }) => {
      const root = node({ x: 0, y: 0, width: 20, height: 10 })
      const parent = node({ x: 2, y: 2, width: 12, height: 5 }, root)
      const left = node({ x: 3, y: 3, width: 3, height: 2 }, parent)
      const right = node({ x: 8, y: 3, width: 3, height: 2 }, parent)
      const calls: string[] = []
      const hovered = new Set<DOMElement>()
      const targets = [
        [parent, 'parent'],
        [left, 'left'],
        [right, 'right'],
      ] as const
      for (const [element, name] of targets) {
        element._eventHandlers = {
          onMouseEnter: () => {
            calls.push(`${name}:enter`)
          },
          onMouseLeave: () => {
            calls.push(`${name}:leave`)
          },
        }
      }
      dispatchHover(root, 3, 3, hovered)
      expect(calls).toEqual(['left:enter', 'parent:enter'])
      expect([...hovered]).toEqual([left, parent])
      calls.length = 0
      dispatchHover(root, 4, 3, hovered)
      expect(calls).toEqual([])
      dispatchHover(root, 8, 3, hovered)
      expect(calls).toEqual(['left:leave', 'right:enter'])
      expect([...hovered]).toEqual([parent, right])
      calls.length = 0
      dispatchHover(root, 20, 3, hovered)
      expect(calls).toEqual(['parent:leave', 'right:leave'])
      expect(hovered.size).toBe(0)
    })
  })

  test('removing a subtree invalidates every cached rect and exposes the sibling below', () => {
    withTree(({ node }) => {
      const root = node({ x: 0, y: 0, width: 20, height: 10 })
      const below = node({ x: 2, y: 2, width: 8, height: 5 }, root)
      const overlay = node({ x: 2, y: 2, width: 8, height: 5 }, root)
      const child = node({ x: 3, y: 3, width: 3, height: 2 }, overlay)
      expect(hitTest(root, 3, 3)).toBe(child)
      removeChildNode(root, overlay)
      expect(overlay.parentNode).toBeUndefined()
      expect(nodeCache.has(overlay)).toBe(false)
      expect(nodeCache.has(child)).toBe(false)
      expect(nodeCache.has(below)).toBe(true)
      expect(hitTest(root, 3, 3)).toBe(below)
      expect(hitTest(overlay, 3, 3)).toBeNull()
      expect(pendingClears.get(root)).toEqual([
        { x: 2, y: 2, width: 8, height: 5 },
        { x: 3, y: 3, width: 3, height: 2 },
      ])
    })
  })

  test('hover drops a directly removed node without invoking its leave handler', () => {
    withTree(({ node }) => {
      const root = node({ x: 0, y: 0, width: 10, height: 5 })
      const child = node({ x: 1, y: 1, width: 3, height: 2 }, root)
      const calls: string[] = []
      const hovered = new Set<DOMElement>()
      child._eventHandlers = {
        onMouseEnter: () => {
          calls.push('enter')
        },
        onMouseLeave: () => {
          calls.push('leave')
        },
      }
      dispatchHover(root, 1, 1, hovered)
      expect(calls).toEqual(['enter'])
      removeChildNode(root, child)
      dispatchHover(root, 1, 1, hovered)
      expect(calls).toEqual(['enter'])
      expect(hovered.size).toBe(0)
    })
  })
})
