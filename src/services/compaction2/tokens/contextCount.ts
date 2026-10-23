// Context-window token accounting for compaction v2.
//
// Mirrors oh-my-pi's `calculateContextTokens` shape: the last provider-reported
// usage block is an exact anchor for everything up to that API response, and
// only the messages after it are estimated locally. The tail prefers the real
// tokenizer from `CCH_TOKENIZER_DIR` (W13); when no vocabulary is configured it
// degrades to the native cl100k counter (`countTokensPrecise`), then to the
// content-adaptive rough estimate — the same chain as `estimateTokens`.
//
// Images and documents are priced per provider instead of by their base64
// payload size: Anthropic's 28px-patch formula capped at 4,784 tokens, Gemini's
// fixed 1,120-token media budget, and OpenAI's 32px-patch area estimate.
import {
  countTokensPrecise,
  countTokensPreciseForMessages,
} from '../../tokenEstimation.js'
import type { Message } from '../../../types/message.js'
import { SYNTHETIC_MODEL } from '../../../utils/messages.js'
import { jsonStringify } from '../../../utils/slowOperations.js'
import { getTokenCountFromUsage, getTokenUsage } from '../../../utils/tokens.js'
import { resolveTokenizer } from './registry.js'

/** Where the returned total came from. */
export type ContextTokenSource = 'usage-anchor' | 'tokenizer' | 'fallback'

export interface ContextTokenCount {
  tokens: number
  source: ContextTokenSource
  /** Index of the message whose usage block anchored the count. */
  anchorIndex?: number
  /** Locally estimated tokens after the anchor (the whole array without one). */
  tailTokens?: number
}

export interface CountContextTokensOptions {
  /**
   * Provider whose image billing rule applies. Defaults to `getAPIProvider()`
   * and is resolved lazily, only when an image/document block is counted.
   */
  provider?: string
  /**
   * Provider-side orchestration tokens: billable, but never replayed into the
   * conversation prefix, so they are excluded from the anchor.
   */
  orchestrationTokens?: number
  /** Test seam: price one image/document block instead of the built-in rule. */
  imageTokens?: (block: unknown, provider: string) => number
}

export interface CountMessagesWithTokenizerOptions {
  provider?: string
  imageTokens?: (block: unknown, provider: string) => number
}

export interface TokenizedMessageCount {
  tokens: number
  /** True when a real vocabulary from the tokenizer data directory was used. */
  exact: boolean
}

interface ImageSize {
  width: number
  height: number
}

interface CountContext {
  countText: (text: string) => number
  imageTokens: (block: Record<string, unknown>) => number
}

// Provider rules from oh-my-pi's catalog (`image-tokenization.kdl`).
const ANTHROPIC_PATCH_PX = 28
const ANTHROPIC_MAX_EDGE = 2576
const ANTHROPIC_MAX_TOKENS = 4784
const GOOGLE_IMAGE_TOKENS = 1120
const OPENAI_PATCH_PX = 32
const OPENAI_PATCH_MULTIPLIER = 1.2
// Snapcompact's frame estimate (ceil(4784 * 1.05)); used when an OpenAI image's
// dimensions cannot be read, so the unknown-size charge never undercounts.
const OPENAI_UNKNOWN_IMAGE_TOKENS = 5024

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : null
}

function createLazyProvider(provider: string | undefined): () => string {
  let resolved = provider
  return () => {
    if (resolved === undefined) {
      // Lazy require keeps the settings/provider graph out of the flag-off
      // path; it is only touched when an image actually needs pricing.
      /* eslint-disable @typescript-eslint/no-require-imports */
      const { getAPIProvider } =
        require('../../../utils/model/providers.js') as typeof import('../../../utils/model/providers.js')
      /* eslint-enable @typescript-eslint/no-require-imports */
      resolved = getAPIProvider()
    }
    return resolved
  }
}

function providerKind(provider: string): 'anthropic' | 'google' | 'openai' {
  switch (provider) {
    case 'gemini':
    case 'google':
      return 'google'
    case 'openai':
    case 'grok':
      return 'openai'
    // firstParty / bedrock / vertex / foundry all speak the Anthropic wire.
    default:
      return 'anthropic'
  }
}

/** Round half to even, like the Anthropic API's resize. */
function roundTiesToEven(value: number): number {
  const floor = Math.floor(value)
  if (value - floor !== 0.5) return Math.round(value)
  return floor % 2 === 0 ? floor : floor + 1
}

/**
 * Anthropic visual tokens after the API's resize: the largest
 * aspect-preserving size whose 28px-padded edges fit `maxEdge` and whose patch
 * count fits `maxTokens`, found by bisecting the long edge.
 */
function anthropicImageTokens(size: ImageSize): number {
  const long = Math.max(size.width, size.height)
  const shortSide = Math.min(size.width, size.height)
  const aspect = long / shortSide
  const patches = (l: number, s: number) =>
    Math.ceil(l / ANTHROPIC_PATCH_PX) * Math.ceil(s / ANTHROPIC_PATCH_PX)
  const fits = (l: number, s: number) =>
    Math.ceil(l / ANTHROPIC_PATCH_PX) * ANTHROPIC_PATCH_PX <=
      ANTHROPIC_MAX_EDGE &&
    Math.ceil(s / ANTHROPIC_PATCH_PX) * ANTHROPIC_PATCH_PX <=
      ANTHROPIC_MAX_EDGE &&
    patches(l, s) <= ANTHROPIC_MAX_TOKENS
  const short = (l: number) => Math.max(roundTiesToEven(l / aspect), 1)
  if (fits(long, shortSide)) return patches(long, shortSide)
  let lo = 1 // always fits
  let hi = long // never fits
  while (lo + 1 < hi) {
    const mid = Math.floor((lo + hi) / 2)
    if (fits(mid, short(mid))) lo = mid
    else hi = mid
  }
  return patches(lo, short(lo))
}

function openAiImageTokens(size: ImageSize): number {
  const patches =
    Math.ceil(size.width / OPENAI_PATCH_PX) *
    Math.ceil(size.height / OPENAI_PATCH_PX)
  return Math.ceil(patches * OPENAI_PATCH_MULTIPLIER)
}

function defaultImageTokens(
  block: Record<string, unknown>,
  provider: string,
): number {
  const size = imageSizeFromBlock(block)
  switch (providerKind(provider)) {
    case 'google':
      return GOOGLE_IMAGE_TOKENS
    case 'openai':
      return size ? openAiImageTokens(size) : OPENAI_UNKNOWN_IMAGE_TOKENS
    default:
      return size ? anthropicImageTokens(size) : ANTHROPIC_MAX_TOKENS
  }
}

function imageSizeFromBlock(block: Record<string, unknown>): ImageSize | null {
  // Some callers attach dimensions directly instead of embedding an image
  // payload (e.g. already-decoded or remote images).
  const width = block.width
  const height = block.height
  if (
    typeof width === 'number' &&
    typeof height === 'number' &&
    width > 0 &&
    height > 0
  ) {
    return { width, height }
  }
  const source = asRecord(block.source)
  if (!source) return null
  const sourceWidth = source.width
  const sourceHeight = source.height
  if (
    typeof sourceWidth === 'number' &&
    typeof sourceHeight === 'number' &&
    sourceWidth > 0 &&
    sourceHeight > 0
  ) {
    return { width: sourceWidth, height: sourceHeight }
  }
  if (source.type === 'base64' && typeof source.data === 'string') {
    return imageSizeFromBase64(source.data)
  }
  if (source.type === 'url' && typeof source.url === 'string') {
    const comma = source.url.indexOf(',')
    if (source.url.startsWith('data:') && comma >= 0) {
      return imageSizeFromBase64(source.url.slice(comma + 1))
    }
  }
  return null
}

function imageSizeFromBase64(data: string): ImageSize | null {
  if (data.length === 0) return null
  try {
    // 64 KiB of base64 is enough for a PNG/GIF/WebP header and a JPEG SOF
    // marker behind typical EXIF/ICC segments. Multiple of 4 so the slice
    // decodes cleanly.
    return imageSizeFromBuffer(Buffer.from(data.slice(0, 65_536), 'base64'))
  } catch {
    return null
  }
}

function imageSizeFromBuffer(buffer: Buffer): ImageSize | null {
  // PNG: signature, then IHDR width/height at offsets 16/20.
  if (
    buffer.length >= 24 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[12] === 0x49 &&
    buffer[13] === 0x48 &&
    buffer[14] === 0x44 &&
    buffer[15] === 0x52
  ) {
    const width = buffer.readUInt32BE(16)
    const height = buffer.readUInt32BE(20)
    return width > 0 && height > 0 ? { width, height } : null
  }

  // GIF: "GIF87a"/"GIF89a", little-endian dimensions at 6/8.
  if (buffer.length >= 10 && buffer.toString('ascii', 0, 3) === 'GIF') {
    const width = buffer.readUInt16LE(6)
    const height = buffer.readUInt16LE(8)
    return width > 0 && height > 0 ? { width, height } : null
  }

  // JPEG: walk markers until a start-of-frame segment.
  if (buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2
    while (offset + 9 <= buffer.length) {
      if (buffer[offset] !== 0xff) {
        offset += 1
        continue
      }
      let marker = buffer[offset + 1] ?? 0
      while (marker === 0xff) {
        offset += 1
        marker = buffer[offset + 1] ?? 0
      }
      if (marker === 0xd8 || marker === 0xd9) {
        offset += 2
        continue
      }
      if (marker >= 0xd0 && marker <= 0xd7) {
        offset += 2
        continue
      }
      const length = buffer.readUInt16BE(offset + 2)
      if (length < 2) return null
      const isSof =
        marker >= 0xc0 &&
        marker <= 0xcf &&
        marker !== 0xc4 &&
        marker !== 0xc8 &&
        marker !== 0xcc
      if (isSof) {
        const height = buffer.readUInt16BE(offset + 5)
        const width = buffer.readUInt16BE(offset + 7)
        return width > 0 && height > 0 ? { width, height } : null
      }
      offset += 2 + length
    }
    return null
  }

  // WebP: RIFF container with VP8X/VP8/VP8L chunk dimensions.
  if (
    buffer.length >= 30 &&
    buffer.toString('ascii', 0, 4) === 'RIFF' &&
    buffer.toString('ascii', 8, 12) === 'WEBP'
  ) {
    const chunk = buffer.toString('ascii', 12, 16)
    if (chunk === 'VP8X') {
      const width = 1 + (buffer[24]! | (buffer[25]! << 8) | (buffer[26]! << 16))
      const height =
        1 + (buffer[27]! | (buffer[28]! << 8) | (buffer[29]! << 16))
      return { width, height }
    }
    if (
      chunk === 'VP8 ' &&
      buffer[23] === 0x9d &&
      buffer[24] === 0x01 &&
      buffer[25] === 0x2a
    ) {
      const width = buffer.readUInt16LE(26) & 0x3fff
      const height = buffer.readUInt16LE(28) & 0x3fff
      return width > 0 && height > 0 ? { width, height } : null
    }
    if (chunk === 'VP8L') {
      const b0 = buffer[21]!
      const b1 = buffer[22]!
      const b2 = buffer[23]!
      const b3 = buffer[24]!
      const width = 1 + (((b1 & 0x3f) << 8) | b0)
      const height = 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6))
      return { width, height }
    }
  }

  return null
}

function countContent(content: unknown, ctx: CountContext): number {
  if (typeof content === 'string') return ctx.countText(content)
  if (!Array.isArray(content)) return 0
  let total = 0
  for (const item of content) total += countBlock(item, ctx)
  return total
}

function countDocument(
  block: Record<string, unknown>,
  ctx: CountContext,
): number {
  const source = asRecord(block.source)
  if (source?.type === 'text' && typeof source.data === 'string') {
    return ctx.countText(source.data)
  }
  if (source?.type === 'content') return countContent(source.content, ctx)
  return ctx.imageTokens(block)
}

function countBlock(item: unknown, ctx: CountContext): number {
  if (typeof item === 'string') return ctx.countText(item)
  const block = asRecord(item)
  if (!block) return 0
  switch (block.type) {
    case 'text':
      return ctx.countText(typeof block.text === 'string' ? block.text : '')
    case 'thinking':
      return ctx.countText(
        typeof block.thinking === 'string' ? block.thinking : '',
      )
    case 'redacted_thinking':
      return ctx.countText(typeof block.data === 'string' ? block.data : '')
    case 'tool_use':
      return ctx.countText(
        `${typeof block.name === 'string' ? block.name : ''}${jsonStringify(
          block.input ?? {},
        )}`,
      )
    case 'tool_result':
      return countContent(block.content, ctx)
    case 'image':
      return ctx.imageTokens(block)
    case 'document':
      return countDocument(block, ctx)
    default:
      // server_tool_use, web_search_tool_result, ... — text-like payloads.
      return ctx.countText(jsonStringify(block))
  }
}

function countOneMessage(message: unknown, ctx: CountContext): number {
  const record = asRecord(message)
  if (!record) return 0
  const type = record.type
  const inner = asRecord(record.message)
  if ((type === 'assistant' || type === 'user') && inner) {
    return countContent(inner.content, ctx)
  }
  if (type === 'attachment') {
    // Attachments are normalized into API user messages; reuse the precise
    // message walk rather than re-implementing every attachment shape.
    return countTokensPreciseForMessages([
      message as Parameters<typeof countTokensPreciseForMessages>[0][number],
    ])
  }
  return 0
}

/**
 * Count `messages` with the model's real tokenizer when configured, else the
 * native cl100k counter, else the content-adaptive rough estimate. Images and
 * documents are priced separately (see {@link defaultImageTokens}).
 */
export function countMessagesWithTokenizer(
  messages: readonly Message[],
  model: string,
  options: CountMessagesWithTokenizerOptions = {},
): TokenizedMessageCount {
  const tokenizer = resolveTokenizer(model)
  const getProvider = createLazyProvider(options.provider)
  const injectedImageTokens = options.imageTokens
  const ctx: CountContext = {
    countText: text => {
      if (text.length === 0) return 0
      return tokenizer ? tokenizer.count(text) : countTokensPrecise(text)
    },
    imageTokens: block =>
      injectedImageTokens
        ? injectedImageTokens(block, getProvider())
        : defaultImageTokens(block, getProvider()),
  }

  let tokens = 0
  for (const message of messages) tokens += countOneMessage(message, ctx)
  return { tokens, exact: tokenizer !== null }
}

function getAssistantMessageId(message: Message): string | undefined {
  const inner = message.message
  if (
    message.type === 'assistant' &&
    inner &&
    typeof inner.id === 'string' &&
    inner.model !== SYNTHETIC_MODEL
  ) {
    return inner.id
  }
  return undefined
}

interface UsageAnchor {
  index: number
  tokens: number
}

/**
 * Find the last real usage anchor, walking back over sibling records split
 * from the same API response (same message.id) so interleaved tool_results
 * between them are included in the tail estimate. Synthetic and all-zero
 * usage blocks are skipped.
 */
function findUsageAnchor(messages: readonly Message[]): UsageAnchor | null {
  let i = messages.length - 1
  while (i >= 0) {
    const message = messages[i]
    const usage = message ? getTokenUsage(message) : undefined
    if (message && usage) {
      const tokens = getTokenCountFromUsage(usage)
      if (tokens > 0) {
        const responseId = getAssistantMessageId(message)
        if (responseId) {
          let j = i - 1
          while (j >= 0) {
            const prior = messages[j]
            const priorId = prior ? getAssistantMessageId(prior) : undefined
            if (priorId === responseId) {
              // Earlier split of the same API response — anchor here instead.
              i = j
            } else if (priorId !== undefined) {
              // Hit a different API response — stop walking.
              break
            }
            // priorId === undefined: a user/tool_result/attachment message,
            // possibly interleaved between splits — keep walking.
            j--
          }
        }
        return { index: i, tokens }
      }
    }
    i--
  }
  return null
}

/**
 * Context-window size for `messages`.
 *
 * Formula: `anchor(input + cache_read + cache_creation + output)
 *          - orchestrationTokens
 *          + tokenizerEstimate(messages after the anchor)`
 *
 * With no usage anchor the whole transcript is tokenized; with no tokenizer
 * data the tail falls back to cl100k and then to the rough estimate.
 */
export function countContextTokens(
  messages: readonly Message[],
  model: string,
  options: CountContextTokensOptions = {},
): ContextTokenCount {
  const anchor = findUsageAnchor(messages)
  const tail = anchor ? messages.slice(anchor.index + 1) : messages
  const counted = countMessagesWithTokenizer(tail, model, {
    provider: options.provider,
    imageTokens: options.imageTokens,
  })
  const orchestration = Math.max(0, options.orchestrationTokens ?? 0)
  const anchorTokens = anchor ? Math.max(0, anchor.tokens - orchestration) : 0

  return {
    tokens: anchorTokens + counted.tokens,
    source: anchor ? 'usage-anchor' : counted.exact ? 'tokenizer' : 'fallback',
    ...(anchor ? { anchorIndex: anchor.index } : {}),
    tailTokens: counted.tokens,
  }
}
