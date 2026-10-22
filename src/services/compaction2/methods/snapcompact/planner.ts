/**
 * Frame planning for snapcompact.
 *
 * Everything here is data-driven: provider/API families select a shape and
 * price from {@link FAMILY_PROFILES}; the caller (or an explicit env var)
 * must name the family. There is deliberately no model-name substring
 * matching — CCH has no reliable modality metadata, so an unresolved family
 * makes the method unavailable.
 *
 * The layout mirrors oh-my-pi: one high-quality page stays verbatim as text
 * at each chronological edge, the middle is imaged, and an oversized middle
 * foveates to HQ/LQ/HQ (dropping the oldest dense slice) while respecting
 * `maxFrames` (default 80), the provider image budget, the token budget and
 * the base64 payload budget.
 */

import { NEWLINE_GLYPH, DIM_ON, DIM_OFF } from './serializer.js'

export type ProviderFamily = 'anthropic' | 'openai' | 'google'

export type ImageDetail = 'auto' | 'low' | 'high' | 'original'

export interface Shape {
  /** Stable shape name used in tests and preserve data. */
  name: string
  /** Font provider name (see `font.ts`). */
  font: string
  /** Target cell advance in pixels. */
  cellWidth: number
  /** Target cell pitch in pixels. */
  cellHeight: number
  /** Ink variant; only black-on-white is implemented. */
  variant: 'bw'
  /** Each text line printed this many times (1 in every bundled shape). */
  lineRepeat: number
  /** Frame edge in pixels. */
  frameSize: number
  /** Per-frame billed-token estimate for the family. */
  frameTokenEstimate: number
  /** Resolution hint attached to frames (OpenAI only). */
  imageDetail?: ImageDetail
}

export interface FamilyProfile {
  family: ProviderFamily
  /** Legible tier used at the archive edges. */
  high: Shape
  /** Denser tier used for the foveated middle. */
  low: Shape
  frameSize: number
  frameTokenEstimate: number
  imageDetail?: ImageDetail
  /** Deployment image-count budget (archive frames only). */
  imageBudget: number
}

/** Upper bound on archive frames carried per compaction. */
export const MAX_FRAMES_DEFAULT = 80
/** HQ frames rendered at each chronological edge of a foveated archive. */
export const HQ_EDGE_FRAMES = 3
/** Conservative per-frame base64 payload estimate at 1932px. */
export const FRAME_DATA_BYTES_ESTIMATE = 170_000
/** Payload cap when the deployment has no measured inline-image budget. */
export const DEFAULT_FRAME_DATA_BYTES_BUDGET = 3_000_000
/** Reference edge used to scale the payload estimate by pixel area. */
const FRAME_DATA_REFERENCE_EDGE = 1932

/** Raw shape geometry. `frameSize` is a family-level value applied below. */
interface ShapeGeometry {
  name: string
  font: string
  cellWidth: number
  cellHeight: number
  variant: 'bw'
  lineRepeat: number
  frameSize: number
}

const SHAPES: Record<string, ShapeGeometry> = {
  // 5x8 glyphs on their natural 5x8 cell (densest tier).
  '5x8-bw': {
    name: '5x8-bw',
    font: '5x8',
    cellWidth: 5,
    cellHeight: 8,
    variant: 'bw',
    lineRepeat: 1,
    frameSize: 1568,
  },
  // 5x8 glyphs on a 16px pitch (extra leading, legible tier).
  '5on16-bw': {
    name: '5on16-bw',
    font: '5x8',
    cellWidth: 5,
    cellHeight: 16,
    variant: 'bw',
    lineRepeat: 1,
    frameSize: 1568,
  },
  // 5x8 glyphs on a 22px pitch (more leading; Google/OpenAI winner).
  '5on22-bw': {
    name: '5on22-bw',
    font: '5x8',
    cellWidth: 5,
    cellHeight: 22,
    variant: 'bw',
    lineRepeat: 1,
    frameSize: 1568,
  },
  // 5x8 glyphs on a 6px advance (one pixel of letter-spacing).
  '6on16-bw': {
    name: '6on16-bw',
    font: '5x8',
    cellWidth: 6,
    cellHeight: 16,
    variant: 'bw',
    lineRepeat: 1,
    frameSize: 1568,
  },
}

export const SHAPE_NAMES = Object.keys(SHAPES) as readonly string[]

export function isShapeName(value: unknown): value is string {
  return typeof value === 'string' && Object.hasOwn(SHAPES, value)
}

function shape(name: string, frameSize: number): Shape {
  const base = SHAPES[name]
  if (!base) throw new Error(`unknown snapcompact shape: ${name}`)
  return { ...base, frameSize }
}

/**
 * Provider-family profiles. Prices are conservative catalog-derived
 * estimates, not model-name heuristics:
 * - Anthropic: 4,784 visual-token cap + 5% margin (5,024);
 * - OpenAI: same ceiling until a deployment proves a smaller rule;
 * - Google: fixed default `media_resolution` budget (1,120).
 */
export const FAMILY_PROFILES: Record<ProviderFamily, FamilyProfile> = {
  anthropic: {
    family: 'anthropic',
    high: shape('6on16-bw', 1568),
    low: shape('5x8-bw', 1568),
    frameSize: 1568,
    frameTokenEstimate: 5024,
    imageBudget: MAX_FRAMES_DEFAULT,
  },
  openai: {
    family: 'openai',
    high: shape('5on22-bw', 1568),
    low: shape('5x8-bw', 1568),
    frameSize: 1568,
    frameTokenEstimate: 5024,
    imageDetail: 'original',
    imageBudget: MAX_FRAMES_DEFAULT,
  },
  google: {
    family: 'google',
    high: shape('5on22-bw', 2048),
    low: shape('5x8-bw', 2048),
    frameSize: 2048,
    frameTokenEstimate: 1120,
    imageBudget: MAX_FRAMES_DEFAULT,
  },
}

export function isProviderFamily(value: unknown): value is ProviderFamily {
  return value === 'anthropic' || value === 'openai' || value === 'google'
}

function parsePositiveInt(value: string | undefined): number | undefined {
  if (!value) return undefined
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
}

export interface ProfileInput {
  env?: Record<string, string | undefined>
  /** Explicit family from settings/caller; wins over env. */
  family?: ProviderFamily
  /** Explicit shape name; wins over env. */
  shape?: string
  /** Explicit frame edge in pixels. */
  frameSize?: number
}

/**
 * Resolve the profile for a reader. Returns undefined when no explicit
 * family is available or an override is invalid — callers must then treat
 * snapcompact as unavailable.
 */
export function resolveProfile(
  input: ProfileInput = {},
): FamilyProfile | undefined {
  const env = input.env ?? {}
  const envFamily = env.CCH_SNAPCOMPACT_FAMILY ?? env.CCH_SNAPCOMPACT_API_FAMILY
  const family = input.family ?? envFamily
  if (!isProviderFamily(family)) return undefined
  const base = FAMILY_PROFILES[family]

  const shapeName = input.shape ?? env.CCH_SNAPCOMPACT_SHAPE
  if (shapeName !== undefined && !isShapeName(shapeName)) return undefined

  const frameSize =
    input.frameSize ??
    parsePositiveInt(env.CCH_SNAPCOMPACT_FRAME_SIZE) ??
    base.frameSize
  const frameTokenEstimate =
    parsePositiveInt(env.CCH_SNAPCOMPACT_FRAME_TOKENS) ??
    base.frameTokenEstimate
  const imageBudget =
    parsePositiveInt(env.CCH_SNAPCOMPACT_IMAGE_BUDGET) ?? base.imageBudget

  const high = shapeName
    ? shape(shapeName, frameSize)
    : { ...base.high, frameSize }
  return {
    ...base,
    high,
    low: { ...base.low, frameSize },
    frameSize,
    frameTokenEstimate,
    imageBudget,
  }
}

export interface Geometry {
  cols: number
  rows: number
  capacity: number
}

export function geometry(
  shape: Shape,
  size: number = shape.frameSize,
): Geometry {
  const cols = Math.max(1, Math.floor(size / shape.cellWidth))
  const rows = Math.max(
    1,
    Math.floor(size / shape.cellHeight / Math.max(1, shape.lineRepeat)),
  )
  return { cols, rows, capacity: cols * rows }
}

/** Cells one character occupies: dim toggles are zero-width, everything
 *  else (including the newline glyph) takes one cell. */
function cellUnits(ch: string): number {
  if (ch === DIM_ON || ch === DIM_OFF) return 0
  return 1
}

/** Visible cells in `text` (dim toggles excluded). */
export function countCells(text: string): number {
  let cells = 0
  for (const ch of text) cells += cellUnits(ch)
  return cells
}

/**
 * Split `text` into contiguous pages of at most `capacity` cells. Pages are
 * contiguous substrings, so each renders independently starting at cell 0
 * and foveation can re-slice the middle without losing text.
 */
export function paginateCells(
  text: string,
  capacity: number,
  _cols: number,
): string[] {
  if (capacity <= 0) return []
  const chars = [...text]
  const pages: string[] = []
  let start = 0
  let cell = 0
  let hasCell = false
  for (let index = 0; index < chars.length; index++) {
    const width = cellUnits(chars[index] ?? '')
    if (width === 0) continue
    if (hasCell && cell + width > capacity) {
      pages.push(chars.slice(start, index).join(''))
      start = index
      cell = 0
    }
    cell += width
    hasCell = true
  }
  if (hasCell) pages.push(chars.slice(start).join(''))
  return pages
}

/**
 * Frame-count cap implied by a base64 byte budget. Frames are charged the
 * 170 KB estimate scaled by pixel area below the 1932px reference edge.
 */
export function maxFramesForDataBudget(
  shape: Pick<Shape, 'frameSize'>,
  budget: number,
): number {
  const ratio = Math.min(1, (shape.frameSize / FRAME_DATA_REFERENCE_EDGE) ** 2)
  const frameBytes = Math.min(
    FRAME_DATA_BYTES_ESTIMATE,
    Math.ceil(FRAME_DATA_BYTES_ESTIMATE * ratio),
  )
  return Math.max(1, Math.floor(budget / frameBytes))
}

export interface BudgetOptions {
  /** Caller upper limit; clamped to {@link MAX_FRAMES_DEFAULT}. */
  maxFrames?: number
  /** Token budget available to archive frames. */
  tokenBudget?: number
  /** Base64 payload budget. */
  dataBudgetBytes?: number
}

/** Resolve the effective frame cap from all budgets. */
export function resolveMaxFrames(
  profile: FamilyProfile,
  options: BudgetOptions = {},
): number {
  const requested = Math.min(
    options.maxFrames ?? MAX_FRAMES_DEFAULT,
    MAX_FRAMES_DEFAULT,
  )
  const tokenFrames =
    options.tokenBudget === undefined
      ? Number.POSITIVE_INFINITY
      : Math.max(
          1,
          Math.floor(options.tokenBudget / profile.frameTokenEstimate),
        )
  const dataFrames = maxFramesForDataBudget(
    profile.high,
    options.dataBudgetBytes ?? DEFAULT_FRAME_DATA_BYTES_BUDGET,
  )
  return Math.max(
    1,
    Math.min(requested, profile.imageBudget, tokenFrames, dataFrames),
  )
}

export interface FramePlan {
  text: string
  shape: Shape
}

export interface ArchivePlan {
  frames: FramePlan[]
  textHead: string
  textTail: string
  keptText: string
  truncatedChars: number
  maxFrames: number
  family: ProviderFamily
}

export interface PlanOptions extends BudgetOptions {}

/** Wrap pages as planned frames at one tier. */
function planFrames(pages: readonly string[], shape: Shape): FramePlan[] {
  return pages.map(text => ({ text, shape }))
}

/**
 * Lay out normalized archive text (oldest→newest) with text at both
 * chronological edges and images in the middle.
 */
export function planArchive(
  text: string,
  profile: FamilyProfile,
  options: PlanOptions = {},
): ArchivePlan {
  const maxFrames = resolveMaxFrames(profile, options)
  const high = profile.high
  const low = profile.low
  const geoHigh = geometry(high)
  const edgeCap = geoHigh.capacity

  if (text.length <= 2 * edgeCap) {
    return {
      frames: [],
      textHead: text,
      textTail: '',
      keptText: text,
      truncatedChars: 0,
      maxFrames,
      family: profile.family,
    }
  }

  if (maxFrames < 1) {
    const textHead = text.slice(0, edgeCap)
    const textTail = text.slice(text.length - edgeCap)
    return {
      frames: [],
      textHead,
      textTail,
      keptText: textHead + textTail,
      truncatedChars: text.length - textHead.length - textTail.length,
      maxFrames,
      family: profile.family,
    }
  }

  const textHead = text.slice(0, edgeCap)
  const textTail = text.slice(text.length - edgeCap)
  const imageText = text.slice(edgeCap, text.length - edgeCap)
  if (imageText.length === 0) {
    return {
      frames: [],
      textHead: text,
      textTail: '',
      keptText: text,
      truncatedChars: 0,
      maxFrames,
      family: profile.family,
    }
  }

  const highPages = paginateCells(imageText, geoHigh.capacity, geoHigh.cols)
  if (highPages.length <= maxFrames) {
    return {
      frames: planFrames(highPages, high),
      textHead,
      textTail,
      keptText: textHead + imageText + textTail,
      truncatedChars: 0,
      maxFrames,
      family: profile.family,
    }
  }

  // Foveate: HQ edges, denser middle, drop the oldest dense slice.
  const geoLow = geometry(low)
  const edgeFrames = Math.min(HQ_EDGE_FRAMES, Math.floor((maxFrames - 1) / 2))
  const headPages = highPages.slice(0, edgeFrames)
  const tailPages =
    edgeFrames > 0 ? highPages.slice(highPages.length - edgeFrames) : []
  const imageHead = headPages.join('')
  const imageTail = tailPages.join('')
  const middleSource = imageText.slice(
    imageHead.length,
    imageText.length - imageTail.length,
  )
  let middlePages = paginateCells(middleSource, geoLow.capacity, geoLow.cols)
  const middleBudget = maxFrames - 2 * edgeFrames
  let truncatedChars = 0
  let middleText = middleSource
  if (middlePages.length > middleBudget) {
    const dropped = middlePages
      .slice(0, middlePages.length - middleBudget)
      .join('')
    truncatedChars = dropped.length
    middleText = middleSource.slice(dropped.length)
    middlePages = middlePages.slice(middlePages.length - middleBudget)
  }

  return {
    frames: [
      ...planFrames(headPages, high),
      ...planFrames(middlePages, low),
      ...planFrames(tailPages, high),
    ],
    textHead,
    textTail,
    keptText: textHead + imageHead + middleText + imageTail + textTail,
    truncatedChars,
    maxFrames,
    family: profile.family,
  }
}

/** Base64 byte length of a set of frames. */
export function frameDataBytes(frames: readonly { data: string }[]): number {
  return frames.reduce((sum, frame) => sum + frame.data.length, 0)
}

/** Whether `text` is non-empty after normalization (a renderable archive). */
export function hasRenderableText(text: string): boolean {
  for (const ch of text) {
    if (ch !== DIM_ON && ch !== DIM_OFF && ch !== NEWLINE_GLYPH) return true
  }
  return false
}
