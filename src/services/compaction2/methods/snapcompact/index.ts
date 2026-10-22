/**
 * Snapcompact compaction method (W4): archive discarded history onto bitmap
 * PNG frames that a vision model reads back. The pass is local and
 * deterministic — no LLM call, no API key, no network.
 *
 * Gating (CCH has no reliable modality metadata):
 * - `CCH_SNAPCOMPACT_ENABLE=1` must be set, AND
 * - the caller must explicitly declare image input support
 *   (`declaresImageInput`), AND
 * - the provider/API family must be named explicitly (deps or
 *   `CCH_SNAPCOMPACT_FAMILY`), so a frame shape and price can be selected.
 *
 * Anything unresolved makes `isAvailable` false; the orchestrator then falls
 * through to the next configured method.
 */

import { randomUUID } from 'node:crypto'
import type {
  CompactionContext,
  CompactionMethod,
  CompactionOutcome,
  CutPoint,
} from '../../contracts.js'
import type { Message, SystemMessage } from '../../../../types/message.js'
import { FIVE_BY_EIGHT_FONT, type FontProvider } from './font.js'
import {
  DEFAULT_FRAME_DATA_BYTES_BUDGET,
  frameDataBytes,
  planArchive,
  resolveMaxFrames,
  resolveProfile,
  type ArchivePlan,
  type BudgetOptions,
  type FamilyProfile,
  type FramePlan,
  type ProviderFamily,
} from './planner.js'
import { renderFrame, type RenderedFrame } from './png.js'
import {
  normalizeForFrame,
  serializeConversation,
  type SerializeOptions,
} from './serializer.js'

export interface SnapcompactMethodDeps {
  /** Environment map; defaults to `process.env`. Tests pass an explicit map. */
  env?: Record<string, string | undefined>
  /**
   * Explicit declaration that the active model accepts image input. CCH has
   * no trustworthy modality metadata, so this defaults to false.
   */
  declaresImageInput?: boolean | ((ctx: CompactionContext) => boolean)
  /** Explicit provider/API family; wins over `CCH_SNAPCOMPACT_FAMILY`. */
  providerFamily?:
    | ProviderFamily
    | ((ctx: CompactionContext) => ProviderFamily | undefined)
  /** Explicit shape name; wins over `CCH_SNAPCOMPACT_SHAPE`. */
  shape?: string
  /** Explicit frame edge in pixels. */
  frameSize?: number
  /** Font used to rasterize glyphs. Defaults to the public-domain 5x8 font. */
  font?: FontProvider
  /** Caller upper limit on frames (still clamped to 80 and the budgets). */
  maxFrames?: number
  /** Token budget available to the archive. */
  tokenBudget?: number | ((ctx: CompactionContext) => number | undefined)
  /** Base64 payload budget. */
  dataBudgetBytes?: number
  /** Serialization budgets. */
  serializeOptions?: SerializeOptions
  /** Short resume lead-in stored with the archive. */
  summary?: string
}

/** Persisted archive key under `CompactionOutcome.preserveData`. */
export const SNAPCOMPACT_PRESERVE_KEY = 'snapcompact'

export interface SnapcompactArchive {
  version: 1
  family: ProviderFamily
  shape: string
  frameSize: number
  frames: RenderedFrame[]
  totalChars: number
  truncatedChars: number
  /** Bounded source text re-rendered on later compactions. */
  text: string
  textHead: string
  textTail: string
  summary: string
}

function resolveEnv(
  deps: SnapcompactMethodDeps,
): Record<string, string | undefined> {
  return deps.env ?? (process.env as Record<string, string | undefined>)
}

function declaredImageInput(
  deps: SnapcompactMethodDeps,
  ctx: CompactionContext,
): boolean {
  const declared = deps.declaresImageInput
  return typeof declared === 'function' ? declared(ctx) : declared === true
}

function resolveFamily(
  deps: SnapcompactMethodDeps,
  ctx: CompactionContext,
): ProviderFamily | undefined {
  const family = deps.providerFamily
  return typeof family === 'function' ? family(ctx) : family
}

function resolveProfileFor(
  deps: SnapcompactMethodDeps,
  ctx: CompactionContext,
): FamilyProfile | undefined {
  return resolveProfile({
    env: resolveEnv(deps),
    family: resolveFamily(deps, ctx),
    shape: deps.shape,
    frameSize: deps.frameSize,
  })
}

function enabled(deps: SnapcompactMethodDeps): boolean {
  return resolveEnv(deps).CCH_SNAPCOMPACT_ENABLE === '1'
}

function resolveTokenBudget(
  deps: SnapcompactMethodDeps,
  ctx: CompactionContext,
): number | undefined {
  const budget = deps.tokenBudget
  return typeof budget === 'function' ? budget(ctx) : budget
}

/**
 * Pick the cut point: keep the newest suffix whose token count fits
 * `keepRecentTokens`, and always keep at least the last message.
 */
function selectCut(ctx: CompactionContext): number {
  const messages = ctx.messages
  if (messages.length === 0) return 0
  const keep = Math.max(0, ctx.settings.keepRecentTokens)
  let low = 0
  let high = messages.length
  while (low < high) {
    const mid = (low + high) >>> 1
    if (ctx.tokenCount(messages.slice(mid)) <= keep) high = mid
    else low = mid + 1
  }
  return Math.min(low, messages.length - 1)
}

function createBoundaryMessage(
  trigger: CompactionContext['trigger'],
  preTokens: number,
): SystemMessage {
  return {
    type: 'system',
    subtype: 'compact_boundary',
    content: 'Conversation compacted',
    isMeta: false,
    timestamp: new Date().toISOString(),
    uuid: randomUUID(),
    level: 'info',
    compactMetadata: {
      trigger: trigger === 'manual' ? 'manual' : 'auto',
      preTokens,
    },
  } as unknown as SystemMessage
}

function budgetOptions(
  deps: SnapcompactMethodDeps,
  ctx: CompactionContext,
): BudgetOptions {
  const options: BudgetOptions = {}
  if (deps.maxFrames !== undefined) options.maxFrames = deps.maxFrames
  if (deps.dataBudgetBytes !== undefined) {
    options.dataBudgetBytes = deps.dataBudgetBytes
  }
  const tokenBudget = resolveTokenBudget(deps, ctx)
  if (tokenBudget !== undefined) options.tokenBudget = tokenBudget
  return options
}

function renderPlannedFrames(
  plan: readonly FramePlan[],
  font: FontProvider,
  ctx: CompactionContext,
): RenderedFrame[] {
  const rendered: RenderedFrame[] = []
  for (const frame of plan) {
    if (ctx.abortSignal?.aborted) {
      throw new Error('snapcompact-aborted')
    }
    rendered.push(renderFrame(frame.text, frame.shape, font))
  }
  return rendered
}

/**
 * Render the plan and, if the actual base64 payload exceeds `dataBudget`,
 * re-plan with the frame count that would fit and render again (at most
 * twice). A single frame is allowed to exceed the estimate — it cannot
 * shrink further.
 */
function renderWithinPayloadBudget(
  normalized: string,
  profile: FamilyProfile,
  options: BudgetOptions,
  font: FontProvider,
  ctx: CompactionContext,
  dataBudget: number,
): { plan: ArchivePlan; frames: RenderedFrame[] } {
  let plan = planArchive(normalized, profile, options)
  let frames = renderPlannedFrames(plan.frames, font, ctx)
  for (let attempt = 0; attempt < 2; attempt++) {
    if (frames.length <= 1) break
    const payload = frameDataBytes(frames)
    if (payload <= dataBudget) break
    const target = Math.max(
      1,
      Math.floor((frames.length * dataBudget) / payload),
    )
    plan = planArchive(normalized, profile, {
      ...options,
      maxFrames: Math.min(plan.maxFrames, target),
    })
    frames = renderPlannedFrames(plan.frames, font, ctx)
  }
  return { plan, frames }
}

function buildArchive(
  plan: ArchivePlan,
  profile: FamilyProfile,
  frames: RenderedFrame[],
  summary: string,
): SnapcompactArchive {
  return {
    version: 1,
    family: profile.family,
    shape: profile.high.name,
    frameSize: profile.frameSize,
    frames,
    totalChars: plan.keptText.length,
    truncatedChars: plan.truncatedChars,
    text: plan.keptText,
    textHead: plan.textHead,
    textTail: plan.textTail,
    summary,
  }
}

export function createSnapcompactMethod(
  deps: SnapcompactMethodDeps = {},
): CompactionMethod {
  return {
    name: 'snapcompact',
    isAvailable: (ctx: CompactionContext): boolean => {
      if (!enabled(deps)) return false
      if (!declaredImageInput(deps, ctx)) return false
      if (ctx.abortSignal?.aborted) return false
      if (ctx.messages.length === 0) return false
      return resolveProfileFor(deps, ctx) !== undefined
    },
    run: async (ctx: CompactionContext): Promise<CompactionOutcome> => {
      if (!enabled(deps)) {
        return {
          kind: 'skipped',
          method: 'snapcompact',
          reason: 'snapcompact-disabled',
        }
      }
      if (!declaredImageInput(deps, ctx)) {
        return {
          kind: 'skipped',
          method: 'snapcompact',
          reason: 'snapcompact-image-input-not-declared',
        }
      }
      const profile = resolveProfileFor(deps, ctx)
      if (!profile) {
        return {
          kind: 'skipped',
          method: 'snapcompact',
          reason: 'snapcompact-family-unresolved',
        }
      }
      if (ctx.messages.length === 0) {
        return {
          kind: 'skipped',
          method: 'snapcompact',
          reason: 'snapcompact-empty',
        }
      }

      try {
        const cut = selectCut(ctx)
        if (cut <= 0) {
          return {
            kind: 'skipped',
            method: 'snapcompact',
            reason: 'snapcompact-nothing-to-archive',
          }
        }
        const archived = ctx.messages.slice(0, cut) as Message[]
        const kept = ctx.messages.slice(cut) as Message[]
        const serialized = serializeConversation(
          archived,
          deps.serializeOptions,
        )
        const normalized = normalizeForFrame(serialized)
        if (normalized.length === 0) {
          return {
            kind: 'skipped',
            method: 'snapcompact',
            reason: 'snapcompact-empty-archive',
          }
        }

        const font = deps.font ?? FIVE_BY_EIGHT_FONT
        const options = budgetOptions(deps, ctx)
        const dataBudget =
          deps.dataBudgetBytes ?? DEFAULT_FRAME_DATA_BYTES_BUDGET
        const { plan, frames } = renderWithinPayloadBudget(
          normalized,
          profile,
          options,
          font,
          ctx,
          dataBudget,
        )
        if (frames.length > 1 && frameDataBytes(frames) > dataBudget) {
          return {
            kind: 'skipped',
            method: 'snapcompact',
            reason: 'snapcompact-payload-over-budget',
          }
        }

        const tokensBefore = ctx.tokenCount(ctx.messages)
        const archivedTokens = ctx.tokenCount(archived)
        const summary =
          deps.summary ??
          `[snapcompact archive] ${frames.length} frame(s) (${profile.family}), ` +
            `${plan.keptText.length} chars kept, ${plan.truncatedChars} chars elided.`
        const textTokens = Math.ceil(
          (plan.textHead.length + plan.textTail.length + summary.length) / 4,
        )
        const frameTokens = frames.length * profile.frameTokenEstimate
        const tokensSaved = Math.max(
          0,
          archivedTokens - textTokens - frameTokens,
        )
        if (tokensSaved <= 0) {
          return {
            kind: 'skipped',
            method: 'snapcompact',
            reason: 'snapcompact-no-savings',
          }
        }

        const firstKeptEntryId =
          (kept[0] as { uuid?: string } | undefined)?.uuid ??
          (archived[archived.length - 1] as { uuid?: string } | undefined)
            ?.uuid ??
          ''
        const cutPoint: CutPoint = {
          firstKeptEntryId,
          tokensBefore,
          boundaryMessage: createBoundaryMessage(ctx.trigger, tokensBefore),
        }
        const afterTokens = Math.max(0, tokensBefore - tokensSaved)
        const threshold = ctx.settings.thresholdTokens
        const archive = buildArchive(plan, profile, frames, summary)

        return {
          kind: 'compacted',
          method: 'snapcompact',
          cutPoint,
          tokensSaved,
          headroomTokens: threshold === undefined ? 0 : threshold - afterTokens,
          summary,
          preserveData: {
            [SNAPCOMPACT_PRESERVE_KEY]: archive,
          },
        }
      } catch (error) {
        return {
          kind: 'failed',
          method: 'snapcompact',
          reason: error instanceof Error ? error.message : String(error),
          error,
        }
      }
    },
  }
}

export const snapcompactMethod = createSnapcompactMethod()

export { frameDataBytes, planArchive, resolveMaxFrames, resolveProfile }
export { FIVE_BY_EIGHT_FONT, TEST_FONT_5X7 } from './font.js'
export type { FontProvider } from './font.js'
export type { SerializeOptions } from './serializer.js'
export type { FamilyProfile, ProviderFamily, Shape } from './planner.js'
