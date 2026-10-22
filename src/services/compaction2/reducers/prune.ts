// Age-based and supersede/useless tool-output pruning for CCH.
//
// Ported from oh-my-pi's `compaction/pruning.ts` (`pruneToolOutputs`) to CCH's
// message model: tool results live as `tool_result` blocks inside user
// messages, and one message may carry several of them.
//
// Pure: the input messages are never mutated. Rewritten messages are shallow
// copies; uuids, order, non-text content blocks, and tool_use/tool_result
// pairing are preserved. Token counting is injected.
import type { Message } from '../../../types/message.js'
import {
  collectToolUsesById,
  getToolName,
  getToolResultEntries,
  getToolResultText,
  isProtectedToolResult,
  isSkillReadToolResult,
  replaceToolResultText,
  type ProtectedToolMatcher,
  type ToolResultBlock,
  type ToolUseBlock,
} from './toolProtection.js'

/** Text-based token estimator (e.g. len/4, or a tokenizer adapter). */
export type CountTokens = (text: string) => number

/**
 * Maps a tool call to a supersede key. Results sharing a key form a group in
 * which a newer successful result supersedes every older one. Return
 * `undefined` to exempt a call from supersede grouping.
 */
export type SupersedeKeyFn = (
  toolName: string,
  args: Record<string, unknown>,
) => string | undefined

/**
 * Whether a successful keyed result shows its whole target. Absent, every
 * successful result is complete. (CCH reads use offset/limit rather than the
 * oh-my-pi selector grammar, so the default is complete.)
 */
export type SupersedeCompleteFn = (
  toolResult: ToolResultBlock,
  message: Message,
) => boolean

export interface PruneConfig {
  /** Keep the most recent context tokens intact. */
  protectTokens: number
  /** Only prune if total estimated savings meets this threshold. */
  minimumSavings: number
  /** Tool-result protection matchers (string or predicate). */
  protectedTools: ProtectedToolMatcher[]
  /** Optional supersede key function; enables stale re-read pruning. */
  supersedeKey?: SupersedeKeyFn
  supersedeComplete?: SupersedeCompleteFn
  /** Useless-flagged results bypass the protect window. Default true. */
  pruneUseless?: boolean
  /**
   * Prompt-cache guard: when set, results whose all-message suffix exceeds
   * this many tokens sit in the already-sent warm prefix and are left alone.
   */
  cacheWarmSuffixTokens?: number
  /**
   * Optional prompt-cache lookback in block positions. Conservative floor:
   * results at or below it are not rewritten. Undefined = no lookback bound.
   */
  cacheLookbackPositions?: number
}

export const DEFAULT_PRUNE_CONFIG: PruneConfig = {
  protectTokens: 40_000,
  minimumSavings: 20_000,
  protectedTools: ['skill', isSkillReadToolResult],
  pruneUseless: true,
  // Reads of the same path supersede each other out of the box.
  supersedeKey: readToolSupersedeKey,
}

/** Exact placeholder written over a superseded tool result. */
export const SUPERSEDED_NOTICE = '[Superseded by a newer read of this file]'

/** Exact placeholder written over an elided useless tool result. */
export const USELESS_NOTICE = '[Uneventful result elided]'

/**
 * Generic age-based pruning floor. Blanking a sub-floor result to
 * `[Output truncated - N tokens]` recovers nothing (the placeholder itself
 * costs tokens), so it would grow the context instead of shrinking it.
 */
export const MIN_PRUNE_TOKENS = 50

/** Positions kept free for the next request's own input. */
const RESERVED_LOOKBACK_POSITIONS = 6

export interface PrunedToolResult {
  messageIndex: number
  blockIndex: number
  toolUseId: string
  notice: string
  /** Estimated tokens saved by this result. */
  tokensSaved: number
}

export interface PruneResult {
  /** New message array; identical entries are reused by reference. */
  messages: Message[]
  prunedCount: number
  tokensSaved: number
  pruned: PrunedToolResult[]
}

interface Candidate {
  messageIndex: number
  blockIndex: number
  block: ToolResultBlock
  tokens: number
  notice: string
  superseded: boolean
  useless: boolean
}

function emptyResult(messages: readonly Message[]): PruneResult {
  return {
    messages: [...messages],
    prunedCount: 0,
    tokensSaved: 0,
    pruned: [],
  }
}

function candidateKey(candidate: { messageIndex: number; blockIndex: number }) {
  return `${candidate.messageIndex}:${candidate.blockIndex}`
}

/** Concatenated text of a message, used only for token estimation. */
function messageText(message: Message): string {
  const content = message.message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const item of content) {
    if (typeof item !== 'object' || item === null) continue
    const block = item as unknown as Record<string, unknown>
    if (block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text)
    } else if (block.type === 'tool_result') {
      const text = getToolResultText(block as unknown as ToolResultBlock)
      if (text !== undefined) parts.push(text)
    } else if (block.type === 'tool_use' && block.input !== undefined) {
      parts.push(JSON.stringify(block.input))
    }
  }
  return parts.join('\n')
}

/** Estimated tokens of a whole message. */
export function estimateMessageTokens(
  message: Message,
  countTokens: CountTokens,
): number {
  return countTokens(messageText(message))
}

function createPrunedNotice(tokens: number): string {
  return `[Output truncated - ${tokens} tokens]`
}

function estimateSavings(
  tokens: number,
  notice: string,
  countTokens: CountTokens,
): number {
  return Math.max(0, tokens - countTokens(notice))
}

/**
 * Index of the oldest message that can be rewritten while the next request
 * still reaches a prompt-cache entry, given `lookback` in block positions.
 * Conservative: a run of consecutive `tool_use` or `tool_result` blocks counts
 * as one position. Returns 0 when unbounded.
 */
function cacheLookbackFloor(
  messages: readonly Message[],
  lookback: number | undefined,
): number {
  if (lookback === undefined) return 0
  let positions = RESERVED_LOOKBACK_POSITIONS
  let later: 'tool_use' | 'tool_result' | undefined
  let floor = messages.length
  for (let i = messages.length - 1; i >= 0; i--) {
    const content = messages[i].message?.content
    if (typeof content === 'string') {
      if (content.trim().length > 0) {
        positions++
        later = undefined
      }
    } else if (Array.isArray(content)) {
      for (let b = content.length - 1; b >= 0; b--) {
        const item = content[b]
        const type =
          typeof item === 'object' && item !== null
            ? (item as unknown as Record<string, unknown>).type
            : undefined
        const kind =
          type === 'tool_use'
            ? 'tool_use'
            : type === 'tool_result'
              ? 'tool_result'
              : undefined
        if (kind === undefined || kind !== later) positions++
        later = kind
      }
    }
    if (positions >= lookback) return floor
    floor = i
  }
  return 0
}

/**
 * Collect results superseded by a newer successful read of the same key. Walks
 * newest -> oldest because supersession only depends on newer results.
 */
function collectSuperseded(
  messages: readonly Message[],
  toolUses: Map<string, ToolUseBlock>,
  config: PruneConfig,
  countTokens: CountTokens,
): Candidate[] {
  const supersedeKey = config.supersedeKey
  if (!supersedeKey) return []
  const newerByKey = new Map<string, { success: boolean; complete: boolean }>()
  const candidates: Candidate[] = []

  for (let i = messages.length - 1; i >= 0; i--) {
    const entries = getToolResultEntries(messages[i])
    for (let e = entries.length - 1; e >= 0; e--) {
      const { block, index } = entries[e]
      if (block.pruned) continue
      const toolCall = toolUses.get(block.tool_use_id)
      if (isProtectedToolResult(block, toolCall, config.protectedTools)) {
        continue
      }
      const name = getToolName(block, toolCall)
      if (name === undefined) continue
      const key = supersedeKey(name, toolCall?.input ?? {})
      if (key === undefined) continue

      const prior = newerByKey.get(key)
      const isError = block.is_error === true
      const superseded = isError ? prior !== undefined : prior?.success === true

      if (!isError) {
        if (!prior?.success) {
          newerByKey.set(key, {
            success: true,
            complete: config.supersedeComplete
              ? config.supersedeComplete(block, messages[i])
              : true,
          })
        }
      } else if (prior === undefined) {
        newerByKey.set(key, { success: false, complete: false })
      }

      if (!superseded) continue
      const tokens = countTokens(getToolResultText(block) ?? '')
      candidates.push({
        messageIndex: i,
        blockIndex: index,
        block,
        tokens,
        notice: SUPERSEDED_NOTICE,
        superseded: true,
        useless: false,
      })
    }
  }
  return candidates.reverse()
}

/** Collect results their tool flagged contextually useless. */
function collectUseless(
  messages: readonly Message[],
  toolUses: Map<string, ToolUseBlock>,
  config: PruneConfig,
  countTokens: CountTokens,
  exclude: ReadonlySet<string>,
): Candidate[] {
  if (config.pruneUseless === false) return []
  const candidates: Candidate[] = []
  for (let i = 0; i < messages.length; i++) {
    for (const { block, index } of getToolResultEntries(messages[i])) {
      if (block.useless !== true) continue
      if (block.pruned || block.is_error === true) continue
      const key = `${i}:${index}`
      if (exclude.has(key)) continue
      const toolCall = toolUses.get(block.tool_use_id)
      if (isProtectedToolResult(block, toolCall, config.protectedTools)) {
        continue
      }
      const tokens = countTokens(getToolResultText(block) ?? '')
      if (estimateSavings(tokens, USELESS_NOTICE, countTokens) <= 0) continue
      candidates.push({
        messageIndex: i,
        blockIndex: index,
        block,
        tokens,
        notice: USELESS_NOTICE,
        superseded: false,
        useless: true,
      })
    }
  }
  return candidates
}

/**
 * Collect age-based victims: results older than the protect window that are
 * large enough to shrink. Also reports the warm-cache floor implied by the
 * optional cache guard.
 */
function collectAged(
  messages: readonly Message[],
  toolUses: Map<string, ToolUseBlock>,
  config: PruneConfig,
  countTokens: CountTokens,
): { candidates: Candidate[]; warmFloor: number } {
  const lookbackFloor =
    config.cacheLookbackPositions === undefined
      ? 0
      : cacheLookbackFloor(messages, config.cacheLookbackPositions)
  const candidates: Candidate[] = []
  let accumulated = 0
  let warmFloor = 0

  for (let i = messages.length - 1; i >= 0; i--) {
    if (
      config.cacheWarmSuffixTokens !== undefined &&
      (accumulated > config.cacheWarmSuffixTokens || i < lookbackFloor)
    ) {
      warmFloor = i + 1
      break
    }
    accumulated += estimateMessageTokens(messages[i], countTokens)

    for (const { block, index } of getToolResultEntries(messages[i])) {
      if (block.pruned) continue
      if (accumulated < config.protectTokens) continue
      const tokens = countTokens(getToolResultText(block) ?? '')
      if (tokens < MIN_PRUNE_TOKENS) continue
      const toolCall = toolUses.get(block.tool_use_id)
      if (isProtectedToolResult(block, toolCall, config.protectedTools)) {
        continue
      }
      candidates.push({
        messageIndex: i,
        blockIndex: index,
        block,
        tokens,
        notice: createPrunedNotice(tokens),
        superseded: false,
        useless: false,
      })
    }
  }
  return { candidates, warmFloor }
}

function applyCandidates(
  messages: readonly Message[],
  candidates: readonly Candidate[],
  countTokens: CountTokens,
): PruneResult {
  const byMessage = new Map<number, Map<number, ToolResultBlock>>()
  const pruned: PrunedToolResult[] = []
  let tokensSaved = 0

  for (const candidate of candidates) {
    const replacement = replaceToolResultText(candidate.block, candidate.notice)
    const blanked: ToolResultBlock = { ...replacement, pruned: true }
    let blocks = byMessage.get(candidate.messageIndex)
    if (!blocks) {
      blocks = new Map()
      byMessage.set(candidate.messageIndex, blocks)
    }
    blocks.set(candidate.blockIndex, blanked)
    const saved = estimateSavings(
      candidate.tokens,
      candidate.notice,
      countTokens,
    )
    tokensSaved += saved
    pruned.push({
      messageIndex: candidate.messageIndex,
      blockIndex: candidate.blockIndex,
      toolUseId: candidate.block.tool_use_id,
      notice: candidate.notice,
      tokensSaved: saved,
    })
  }

  const next = messages.map((message, messageIndex) => {
    const replacements = byMessage.get(messageIndex)
    if (!replacements) return message
    const content = message.message?.content
    if (!Array.isArray(content)) return message
    const nextContent = content.map((block, blockIndex) => {
      const replacement = replacements.get(blockIndex)
      return replacement !== undefined
        ? (replacement as unknown as (typeof content)[number])
        : block
    })
    return {
      ...message,
      message: {
        ...message.message,
        content: nextContent as unknown as typeof content,
      },
    }
  })

  return {
    messages: next,
    prunedCount: pruned.length,
    tokensSaved,
    pruned,
  }
}

/**
 * Prune stale tool outputs before compaction.
 *
 * Order of precedence: superseded reads (a newer successful read of the same
 * path) and useless-flagged results are pruned regardless of age; other results
 * are pruned only once they fall outside the `protectTokens` window. The whole
 * pass is skipped when total savings fall below `minimumSavings`.
 *
 * `pruned: true` is stamped on rewritten `tool_result` blocks so a later pass
 * does not blank them again; non-text blocks are preserved.
 */
export function pruneToolOutputs(
  messages: readonly Message[],
  countTokens: CountTokens,
  config: PruneConfig = DEFAULT_PRUNE_CONFIG,
): PruneResult {
  if (messages.length === 0) return emptyResult(messages)

  const toolUses = collectToolUsesById(messages)
  const superseded = collectSuperseded(messages, toolUses, config, countTokens)
  const supersededKeys = new Set(superseded.map(candidateKey))
  const useless = collectUseless(
    messages,
    toolUses,
    config,
    countTokens,
    supersededKeys,
  )
  const { candidates: aged, warmFloor } = collectAged(
    messages,
    toolUses,
    config,
    countTokens,
  )

  const merged = new Map<string, Candidate>()
  // The cache guard applies to every class of victim: deeper, still-warm
  // results are left for compaction/shake, which rebuild the cache anyway.
  for (const candidate of superseded) {
    if (candidate.messageIndex >= warmFloor) {
      merged.set(candidateKey(candidate), candidate)
    }
  }
  for (const candidate of useless) {
    if (candidate.messageIndex < warmFloor) continue
    const key = candidateKey(candidate)
    if (!merged.has(key)) merged.set(key, candidate)
  }
  for (const candidate of aged) {
    const key = candidateKey(candidate)
    if (!merged.has(key)) merged.set(key, candidate)
  }

  const candidates = [...merged.values()].sort(
    (a, b) => a.messageIndex - b.messageIndex || a.blockIndex - b.blockIndex,
  )
  if (candidates.length === 0) return emptyResult(messages)

  const tokensSaved = candidates.reduce(
    (sum, candidate) =>
      sum + estimateSavings(candidate.tokens, candidate.notice, countTokens),
    0,
  )
  if (tokensSaved < config.minimumSavings) return emptyResult(messages)

  return applyCandidates(messages, candidates, countTokens)
}

/**
 * Supersede key for CCH's `Read` tool: the target path (CCH uses `file_path`).
 * Internal/URL-scheme paths (`skill://`, `artifact://`, `https://`) are exempt.
 * Later reads of the same path supersede earlier ones regardless of
 * offset/limit — the newer view is authoritative.
 */
export function readToolSupersedeKey(
  toolName: string,
  args: Record<string, unknown>,
): string | undefined {
  if (toolName.toLowerCase() !== 'read') return undefined
  const path = args.file_path ?? args.path
  if (typeof path !== 'string' || path.length === 0) return undefined
  if (path.includes('://')) return undefined
  return path
}
