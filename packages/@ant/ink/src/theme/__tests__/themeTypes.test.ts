import { describe, expect, test } from 'bun:test'
import { getTheme, THEME_NAMES, themeColorToAnsi } from '../theme-types.js'

describe('getTheme', () => {
  test('all six named themes resolve', () => {
    for (const name of THEME_NAMES) {
      const theme = getTheme(name)
      expect(theme).toBeDefined()
      // 语义色全集必须可解析（FleetView/组件依赖的 key）
      for (const key of [
        'text',
        'inverseText',
        'success',
        'error',
        'warning',
        'subtle',
        'suggestion',
      ] as const) {
        expect(theme[key]).toBeDefined()
      }
    }
  })

  test('dark is the fallback for unknown names', () => {
    expect(getTheme('nonexistent' as never)).toBe(getTheme('dark'))
  })

  test('dark and light differ on text/inverseText', () => {
    const dark = getTheme('dark')
    const light = getTheme('light')
    expect(dark.text).not.toBe(light.text)
    expect(dark.inverseText).not.toBe(light.inverseText)
  })

  test('ansi themes use ansi: prefixed colors', () => {
    const darkAnsi = getTheme('dark-ansi')
    expect(String(darkAnsi.success)).toContain('ansi:')
  })
})

describe('themeColorToAnsi', () => {
  test('rgb color produces a 24-bit escape prefix', () => {
    const seq = themeColorToAnsi('rgb(78, 186, 101)')
    expect(seq).toBe('\x1b[38;2;78;186;101m')
  })

  test('unparseable color falls back to magenta', () => {
    expect(themeColorToAnsi('not-a-color')).toBe('\x1b[35m')
  })
})
