import type { Frame } from './frame.js'
import { charInCellAt, type Screen } from './screen.js'

/**
 * Screen reader diff layer.
 *
 * Mirrors the official ink fork's frame-to-frame text diff state for
 * accessibility mode: each frame's visible text lines are extracted from the
 * screen buffer and compared against the previous frame's lines. New or
 * changed lines are merged into a summary string that the host can feed to
 * assistive output (e.g. an aria-live region or a screen-reader-focused
 * stderr stream). `reset()` drops the cached state — called whenever frame
 * state is reset (alt-screen reset, SIGCONT resume), and on screen resize so
 * the next capture reports the full frame again instead of spurious
 * line-index deltas against a stale buffer.
 */
export class ScreenReaderDiff {
  private prevLines: string[] | null = null
  private prevWidth = -1
  private prevHeight = -1

  /** Drop cached frame text so the next capture re-reports everything. */
  reset(): void {
    this.prevLines = null
    this.prevWidth = -1
    this.prevHeight = -1
  }

  /**
   * Extract visible text lines from `frame.screen`, diff against the previous
   * capture, and return a newline-joined summary of new/changed lines.
   * Returns null when nothing changed (or the screen is empty). A screen
   * size change resets the cache first, so the first capture after a resize
   * reports the full frame.
   */
  capture(frame: Frame): string | null {
    const screen = frame.screen
    if (screen.width !== this.prevWidth || screen.height !== this.prevHeight) {
      this.prevLines = null
      this.prevWidth = screen.width
      this.prevHeight = screen.height
    }

    const lines = extractLines(screen)

    const prev = this.prevLines
    const changed: string[] = []
    if (prev === null) {
      // First capture after a reset: report every non-empty line.
      for (const line of lines) {
        if (line !== '') changed.push(line)
      }
    } else {
      const max = Math.max(prev.length, lines.length)
      for (let i = 0; i < max; i++) {
        const line = lines[i]
        // Rows past the previous frame are new content; rows that vanished
        // (screen shrank) produce undefined — nothing to announce.
        if (line === undefined) continue
        if (line !== '' && line !== prev[i]) changed.push(line)
      }
    }

    this.prevLines = lines
    return changed.length > 0 ? changed.join('\n') : null
  }
}

/**
 * Extract one trimmed text line per screen row via charInCellAt. Unwritten
 * cells read as spaces (pool index 0), spacer cells of wide (CJK/emoji)
 * characters read as the empty string — so word-separating spaces survive
 * and wide-char spacer tails contribute nothing. Trailing whitespace is
 * trimmed so rewrite-only-whitespace frames don't register as changes.
 */
function extractLines(screen: Screen): string[] {
  const { width, height } = screen
  const lines: string[] = []
  for (let y = 0; y < height; y++) {
    let line = ''
    for (let x = 0; x < width; x++) {
      line += charInCellAt(screen, x, y) ?? ''
    }
    lines.push(line.replace(/\s+$/, ''))
  }
  return lines
}
