// Surgical local compaction ("shake") for CCH.
//
// Ported from oh-my-pi's `compaction/shake.ts`. Heavy tool-result text and
// large fenced/XML blocks are replaced with short placeholders while non-text
// tool-result content (images, documents) is preserved. Artifact offload is
// injected by the caller through `offload(region) => Promise<string>`; this
// module never touches disk or the network.
//
// Pure: input messages are not mutated; rewritten messages are shallow copies.
import type { Message } from '../../../types/message.js'
import { estimateMessageTokens, type CountTokens } from './prune.js'
import {
  collectToolUsesById,
  getToolName,
  getToolResultEntries,
  getToolResultText,
  isArtifactRecoveryToolResult,
  isProtectedToolResult,
  isSkillReadToolResult,
  isTextBlock,
  isToolResultBlock,
  replaceToolResultText,
  type ProtectedToolMatcher,
  type ToolResultBlock,
} from './toolProtection.js'

export interface ShakeConfig {
  /** Keep the most recent context tokens intact. */
  protectTokens: number
  /** Only shake when total estimated savings meets this threshold. */
  minSavings: number
  /** Tool-result protection matchers (string or predicate). */
  protectedTools: ProtectedToolMatcher[]
  /** Minimum token size for a fenced/XML block to be eligible. */
  fenceMinTokens: number
}

/** Auto-shake config: protects the live tail, conservative thresholds. */
export const DEFAULT_SHAKE_CONFIG: ShakeConfig = {
  protectTokens: 16_000,
  minSavings: 4_000,
  protectedTools: [
    'skill',
    isSkillReadToolResult,
    isArtifactRecoveryToolResult,
  ],
  fenceMinTokens: 400,
}

/**
 * Manual `/shake`: aggressive — no savings threshold and drops eligible
 * regions across history, artifact recovery reads included.
 */
export const AGGRESSIVE_SHAKE_CONFIG: ShakeConfig = {
  protectTokens: 4_000,
  minSavings: 0,
  protectedTools: ['skill', isSkillReadToolResult],
  fenceMinTokens: 400,
}

/**
 * Compaction dead-end rescue: aggressive reach, but artifact recovery reads
 * stay protected. The protect window is zero so even the newest oversized
 * result can be elided.
 */
export const RESCUE_SHAKE_CONFIG: ShakeConfig = {
  ...AGGRESSIVE_SHAKE_CONFIG,
  protectTokens: 0,
  protectedTools: [
    ...AGGRESSIVE_SHAKE_CONFIG.protectedTools,
    isArtifactRecoveryToolResult,
  ],
}

/** Rough token cost of a placeholder line; used only for the savings gate. */
const PLACEHOLDER_TOKEN_ESTIMATE = 16

export interface ToolResultShakeRegion {
  kind: 'toolResult'
  messageIndex: number
  /** Index of the `tool_result` block in the message content array. */
  blockIndex: number
  toolUseId: string
  /** Estimated tokens in the removable text only; retained images excluded. */
  tokens: number
  originalText: string
  /** Human label for the offload doc (tool name). */
  label: string
}

export interface BlockShakeRegion {
  kind: 'block'
  messageIndex: number
  /** Index into the content array, or -1 for string-form content. */
  blockIndex: number
  /** Character offsets into the target text (start inclusive, end exclusive). */
  start: number
  end: number
  tokens: number
  originalText: string
  /** Human label for the offload doc (message role). */
  label: string
}

export type ShakeRegion = ToolResultShakeRegion | BlockShakeRegion

export interface AppliedShakeRegion {
  region: ShakeRegion
  replacement: string
  replacementTokens: number
}

export interface ShakeResult {
  /** New message array; untouched entries are reused by reference. */
  messages: Message[]
  /** Every region that was replaced, in application order. */
  regions: AppliedShakeRegion[]
  tokensSaved: number
}

// Mirror prompt rendering: lowercase tag names only — conservative by design
// (uppercase / mixed-case tags are ignored).
const OPENING_XML = /^<([a-z_-]+)(?:\s+[^>]*)?>$/
const CLOSING_XML = /^<\/([a-z_-]+)>$/

/**
 * Locate fenced code blocks and top-level XML element spans inside `text`.
 * Returns character ranges `[start, end)` covering the full block (including
 * the opening and closing fence/tag lines, excluding the trailing newline).
 * Unterminated fences/tags yield no range; XML detection is suppressed inside
 * fences.
 */
function scanTextForBlockRanges(
  text: string,
): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = []
  let inFence = false
  let fenceStart = -1
  const tagStack: string[] = []
  let xmlStart = -1

  let lineStart = 0
  for (let i = 0; i <= text.length; i++) {
    if (i !== text.length && text[i] !== '\n') continue
    const line = text.slice(lineStart, i)
    const lineEnd = i
    const trimmedStart = line.trimStart()

    const isFenceLine =
      trimmedStart.startsWith('```') || trimmedStart.startsWith('~~~')
    if (isFenceLine) {
      if (!inFence) {
        inFence = true
        fenceStart = lineStart
      } else {
        inFence = false
        ranges.push({ start: fenceStart, end: lineEnd })
        fenceStart = -1
      }
      lineStart = i + 1
      continue
    }

    if (!inFence) {
      const isOpeningXml =
        line.length === trimmedStart.length && OPENING_XML.test(trimmedStart)
      if (isOpeningXml) {
        const match = OPENING_XML.exec(trimmedStart)
        if (match) {
          if (tagStack.length === 0) xmlStart = lineStart
          tagStack.push(match[1])
        }
      } else {
        const closingMatch = CLOSING_XML.exec(trimmedStart)
        if (
          closingMatch &&
          tagStack.length > 0 &&
          tagStack[tagStack.length - 1] === closingMatch[1]
        ) {
          tagStack.pop()
          if (tagStack.length === 0 && xmlStart >= 0) {
            ranges.push({ start: xmlStart, end: lineEnd })
            xmlStart = -1
          }
        }
      }
    }

    lineStart = i + 1
  }

  return mergeRanges(ranges)
}

/**
 * Sort ascending by start and drop any range that overlaps an already-kept
 * range. Fence/XML spans are properly nested, so overlap means containment and
 * keeping the earlier-starting range keeps the outermost span.
 */
function mergeRanges(
  ranges: Array<{ start: number; end: number }>,
): Array<{ start: number; end: number }> {
  if (ranges.length <= 1) return ranges
  const sorted = [...ranges].sort((a, b) => a.start - b.start)
  const kept: Array<{ start: number; end: number }> = []
  let lastEnd = -1
  for (const range of sorted) {
    if (range.start < lastEnd) continue
    kept.push(range)
    lastEnd = range.end
  }
  return kept
}

function pushBlockRegions(
  regions: ShakeRegion[],
  messageIndex: number,
  blockIndex: number,
  text: string,
  countTokens: CountTokens,
  config: ShakeConfig,
  label: string,
): void {
  for (const range of scanTextForBlockRanges(text)) {
    const slice = text.slice(range.start, range.end)
    if (slice.length === 0) continue
    const tokens = countTokens(slice)
    if (tokens < config.fenceMinTokens) continue
    regions.push({
      kind: 'block',
      messageIndex,
      blockIndex,
      start: range.start,
      end: range.end,
      tokens,
      originalText: slice,
      label,
    })
  }
}

/**
 * Pure detection: locate every eligible shake region.
 *
 * Walks the protect-recent window (the most recent `protectTokens` of context
 * stays intact), collects tool-result text (honoring `protectedTools`, skipping
 * already-pruned results) and large fenced/XML blocks inside user/assistant
 * text. Useless-flagged tool results bypass the protect window.
 *
 * `tool_use` blocks are never touched (pairing is preserved) and regions never
 * span a message boundary. When combined estimated savings are below
 * `minSavings`, returns `[]`.
 */
export function collectShakeRegions(
  messages: readonly Message[],
  countTokens: CountTokens,
  config: ShakeConfig,
): ShakeRegion[] {
  const n = messages.length
  if (n === 0) return []

  // Tokens of all messages strictly more recent than index i.
  const accumulatedAfter = new Array<number>(n)
  let accumulated = 0
  for (let i = n - 1; i >= 0; i--) {
    accumulatedAfter[i] = accumulated
    accumulated += estimateMessageTokens(messages[i], countTokens)
  }

  const toolUses = collectToolUsesById(messages)
  const regions: ShakeRegion[] = []

  for (let i = 0; i < n; i++) {
    const message = messages[i]
    const results = getToolResultEntries(message)
    // Useless-flagged results carry no information once consumed; they are
    // eligible even inside the protect-recent window.
    const hasUseless = results.some(
      ({ block }) => block.useless === true && block.is_error !== true,
    )
    if (!hasUseless && accumulatedAfter[i] < config.protectTokens) continue

    if (results.length > 0) {
      for (const { block, index } of results) {
        if (block.pruned) continue
        const toolCall = toolUses.get(block.tool_use_id)
        if (isProtectedToolResult(block, toolCall, config.protectedTools)) {
          continue
        }
        const text = getToolResultText(block)
        if (text === undefined) continue
        regions.push({
          kind: 'toolResult',
          messageIndex: i,
          blockIndex: index,
          toolUseId: block.tool_use_id,
          tokens: countTokens(text),
          originalText: text,
          label: getToolName(block, toolCall) ?? 'tool',
        })
      }
      // Tool-result messages are not scanned for fenced blocks (the result
      // text is already a whole region).
      continue
    }

    if (message.type !== 'user' && message.type !== 'assistant') continue
    const content = message.message?.content
    if (typeof content === 'string') {
      pushBlockRegions(
        regions,
        i,
        -1,
        content,
        countTokens,
        config,
        message.type,
      )
    } else if (Array.isArray(content)) {
      for (let blockIndex = 0; blockIndex < content.length; blockIndex++) {
        const block = content[blockIndex]
        if (isTextBlock(block)) {
          pushBlockRegions(
            regions,
            i,
            blockIndex,
            block.text,
            countTokens,
            config,
            message.type,
          )
        }
      }
    }
  }

  let savings = 0
  for (const region of regions) {
    savings += Math.max(0, region.tokens - PLACEHOLDER_TOKEN_ESTIMATE)
  }
  if (savings < config.minSavings) return []
  return regions
}

function cloneForWrite(
  working: Map<number, Message>,
  messages: readonly Message[],
  index: number,
): Message | undefined {
  const existing = working.get(index)
  if (existing) return existing
  const source = messages[index]
  if (!source?.message) return undefined
  const content = source.message.content
  const clone: Message = Array.isArray(content)
    ? {
        ...source,
        message: {
          ...source.message,
          content: [...content] as unknown as typeof content,
        },
      }
    : { ...source, message: { ...source.message } }
  working.set(index, clone)
  return clone
}

function applyOne(
  working: Map<number, Message>,
  messages: readonly Message[],
  item: AppliedShakeRegion,
): void {
  const { region, replacement } = item
  const message = cloneForWrite(working, messages, region.messageIndex)
  if (!message?.message) return
  const content = message.message.content

  if (region.kind === 'toolResult') {
    if (!Array.isArray(content)) return
    const block = content[region.blockIndex]
    if (!isToolResultBlock(block)) return
    const blanked: ToolResultBlock = {
      ...replaceToolResultText(block, replacement),
      pruned: true,
    }
    content[region.blockIndex] = blanked as unknown as (typeof content)[number]
    return
  }

  if (region.blockIndex === -1) {
    if (typeof content !== 'string') return
    message.message.content =
      content.slice(0, region.start) + replacement + content.slice(region.end)
    return
  }

  if (!Array.isArray(content)) return
  const block = content[region.blockIndex]
  if (!isTextBlock(block)) return
  const nextText =
    block.text.slice(0, region.start) +
    replacement +
    block.text.slice(region.end)
  content[region.blockIndex] = {
    ...block,
    text: nextText,
  } as unknown as (typeof content)[number]
}

/**
 * Apply many regions at once. Block regions are applied highest-start-first so
 * splicing one region never shifts the offsets of another in the same text
 * block; tool-result regions are independent. Inputs are not mutated.
 */
export function applyShakeRegions(
  messages: readonly Message[],
  items: ReadonlyArray<AppliedShakeRegion>,
): Message[] {
  if (items.length === 0) return [...messages]
  const working = new Map<number, Message>()
  const ordered = [...items].sort((a, b) => {
    const aStart = a.region.kind === 'block' ? a.region.start : -1
    const bStart = b.region.kind === 'block' ? b.region.start : -1
    return bStart - aStart
  })
  for (const item of ordered) applyOne(working, messages, item)
  return messages.map((message, index) => working.get(index) ?? message)
}

/**
 * Detect, offload, and replace eligible regions.
 *
 * `offload` receives each region and returns the replacement text (for example
 * an `artifact://` reference minted by the caller). No persistence happens
 * here. Returns the rewritten messages, the applied regions, and the actual
 * tokens saved (`region.tokens - replacement tokens`, floored at 0).
 */
export async function shakeMessages(
  messages: readonly Message[],
  countTokens: CountTokens,
  config: ShakeConfig,
  offload: (region: ShakeRegion) => Promise<string>,
): Promise<ShakeResult> {
  const regions = collectShakeRegions(messages, countTokens, config)
  if (regions.length === 0) {
    return { messages: [...messages], regions: [], tokensSaved: 0 }
  }

  const applied: AppliedShakeRegion[] = []
  let tokensSaved = 0
  for (const region of regions) {
    const replacement = await offload(region)
    const replacementTokens = countTokens(replacement)
    tokensSaved += Math.max(0, region.tokens - replacementTokens)
    applied.push({ region, replacement, replacementTokens })
  }

  return {
    messages: applyShakeRegions(messages, applied),
    regions: applied,
    tokensSaved,
  }
}
