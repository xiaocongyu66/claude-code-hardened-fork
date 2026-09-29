/**
 * DEC (Digital Equipment Corporation) Private Mode Sequences
 *
 * DEC private modes use CSI ? N h (set) and CSI ? N l (reset) format.
 * These are terminal-specific extensions to the ANSI standard.
 */

import { csi } from './csi.js'

/**
 * DEC private mode numbers
 */
export const DEC = {
  CURSOR_VISIBLE: 25,
  ALT_SCREEN: 47,
  ALT_SCREEN_CLEAR: 1049,
  MOUSE_NORMAL: 1000,
  MOUSE_BUTTON: 1002,
  MOUSE_ANY: 1003,
  MOUSE_SGR: 1006,
  MOUSE_SGR_PIXELS: 1016,
  FOCUS_EVENTS: 1004,
  BRACKETED_PASTE: 2004,
  THEME_NOTIFY: 2031,
  SYNCHRONIZED_UPDATE: 2026,
  WIN32_INPUT_MODE: 9001,
} as const

/** Generate CSI ? N h sequence (set mode) */
export function decset(mode: number): string {
  return csi(`?${mode}h`)
}

/** Generate CSI ? N l sequence (reset mode) */
export function decreset(mode: number): string {
  return csi(`?${mode}l`)
}

// Pre-generated sequences for common modes
export const BSU = decset(DEC.SYNCHRONIZED_UPDATE)
export const ESU = decreset(DEC.SYNCHRONIZED_UPDATE)
export const EBP = decset(DEC.BRACKETED_PASTE)
export const DBP = decreset(DEC.BRACKETED_PASTE)
export const EFE = decset(DEC.FOCUS_EVENTS)
export const DFE = decreset(DEC.FOCUS_EVENTS)
export const SHOW_CURSOR = decset(DEC.CURSOR_VISIBLE)
export const HIDE_CURSOR = decreset(DEC.CURSOR_VISIBLE)
export const ENTER_ALT_SCREEN = decset(DEC.ALT_SCREEN_CLEAR)
export const EXIT_ALT_SCREEN = decreset(DEC.ALT_SCREEN_CLEAR)
// Mouse tracking: 1000 reports button press/release/wheel, 1002 adds drag
// events (button-motion), 1003 adds all-motion (no button held — for
// hover), 1006 uses SGR format (CSI < btn;col;row M/m) instead of legacy
// X10 bytes. Combined: wheel + click/drag for selection + hover.
export const ENABLE_MOUSE_TRACKING =
  decset(DEC.MOUSE_NORMAL) +
  decset(DEC.MOUSE_BUTTON) +
  decset(DEC.MOUSE_ANY) +
  decset(DEC.MOUSE_SGR)
export const DISABLE_MOUSE_TRACKING =
  decreset(DEC.MOUSE_SGR) +
  decreset(DEC.MOUSE_ANY) +
  decreset(DEC.MOUSE_BUTTON) +
  decreset(DEC.MOUSE_NORMAL)

// ── 官方 Cm 表补全（docs/reverse-284 chunk-6epjwwt0：var Cm={...}）──
// 官方 DEC 表比 cch 多 3 个模式：MOUSE_SGR_PIXELS(1016)/THEME_NOTIFY(2031)/
// WIN32_INPUT_MODE(9001)；并有三档鼠标选择 ZVt(mode)。

/** 1016：鼠标坐标以像素（而非字符单元）上报——官方 pixelReportsLive/mousePixels。 */
export const ENABLE_MOUSE_PIXELS = decset(DEC.MOUSE_SGR_PIXELS)
export const DISABLE_MOUSE_PIXELS = decreset(DEC.MOUSE_SGR_PIXELS)
/** 2031：终端主题变化通知（DECSET）。 */
export const ENABLE_THEME_NOTIFY = decset(DEC.THEME_NOTIFY)
export const DISABLE_THEME_NOTIFY = decreset(DEC.THEME_NOTIFY)
/** 9001：Windows win32-input-mode（conhost 支持）。 */
export const ENABLE_WIN32_INPUT = decset(DEC.WIN32_INPUT_MODE)
export const DISABLE_WIN32_INPUT = decreset(DEC.WIN32_INPUT_MODE)

/**
 * 官方 ZVt(E) 三档鼠标选择（原文：full→S、scroll→_、off→''）：
 * - full  = 1000+1002+1003+1006（wheel + 拖拽 + hover + SGR）
 * - scroll= 1000+1006（wheel + SGR 点击，无拖拽/hover——列表视图默认档）
 * - off   = ''
 */
export function mouseTrackingSeq(mode: 'full' | 'scroll' | 'off'): string {
  switch (mode) {
    case 'full':
      return ENABLE_MOUSE_TRACKING
    case 'scroll':
      return decset(DEC.MOUSE_NORMAL) + decset(DEC.MOUSE_SGR)
    case 'off':
      return ''
  }
}

/** 官方 Qoe：off 档的完整复位序列（含 1000/1002/1003/1006 全关）。 */
export const DISABLE_MOUSE_TRACKING_FULL = DISABLE_MOUSE_TRACKING
/** 官方 iQr：pixel 模式关闭 = 1016l + 1006h（回到 cell SGR 报告）。 */
export const EXIT_MOUSE_PIXELS =
  decreset(DEC.MOUSE_SGR_PIXELS) + decset(DEC.MOUSE_SGR)
