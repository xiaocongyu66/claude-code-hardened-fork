// Exact per-message token counting for compaction thresholds.
//
// The V2 threshold and blocking checks prefer a real vocabulary from
// `CCH_TOKENIZER_DIR`. Content is serialized per block with the same rules as
// `roughTokenCountEstimationForBlock` (text, tool_result, tool_use, thinking,
// images, JSON catch-all) and each piece is counted with `estimateTokens`.
// When no tokenizer resolves for the model, callers fall back to the existing
// usage-anchored / cl100k estimators.
import type { Message } from '../../../types/message.js'
import type { Attachment } from '../../../utils/attachments.js'
import { estimateTokens } from './index.js'
import { resolveTokenizer } from './registry.js'

/** Matches `roughTokenCountEstimationForBlock`'s conservative image charge. */
const IMAGE_TOKEN_ESTIMATE = 2000

/**
 * Count `messages` with the model's real tokenizer, or `null` when no
 * tokenizer data resolves (missing directory, unmatched model, missing file).
 */
export function countMessagesWithTokenizer(
  messages: readonly Message[],
  model: string,
): number | null {
  if (resolveTokenizer(model) === null) return null
  let total = 0
  for (const message of messages) {
    total += countMessage(message, model)
  }
  return total
}

/**
 * Threshold-facing count: exact tokenizer count when available, otherwise the
 * caller-provided fallback (a number, or a thunk to keep it lazy).
 */
export type TokenCountFallback = number | (() => number)

export function countMessagesForThreshold(
  messages: readonly Message[],
  model: string,
  fallback: TokenCountFallback,
): number {
  const exact = countMessagesWithTokenizer(messages, model)
  if (exact !== null) return exact
  return typeof fallback === 'function' ? fallback() : fallback
}

function countMessage(message: Message, model: string): number {
  if (
    (message.type === 'assistant' || message.type === 'user') &&
    message.message?.content
  ) {
    return countContent(message.message.content, model)
  }

  if (message.type === 'attachment' && message.attachment) {
    // Loaded lazily: utils/messages pulls the full tool/permission chain, and
    // the tokenizer layer must stay importable on its own (tests, CLI paths).
    /* eslint-disable @typescript-eslint/no-require-imports */
    const messagesModule =
      require('../../../utils/messages.js') as typeof import('../../../utils/messages.js')
    const { normalizeAttachmentForAPI } = messagesModule
    /* eslint-enable @typescript-eslint/no-require-imports */
    let total = 0
    for (const userMessage of normalizeAttachmentForAPI(
      message.attachment as Attachment,
    )) {
      total += countContent(userMessage.message.content, model)
    }
    return total
  }

  return 0
}

function countContent(content: unknown, model: string): number {
  if (typeof content === 'string') {
    return countText(content, model)
  }
  if (!Array.isArray(content)) {
    return 0
  }
  let total = 0
  for (const block of content as unknown[]) {
    total += countBlock(block, model)
  }
  return total
}

function countBlock(block: unknown, model: string): number {
  if (typeof block === 'string') {
    return countText(block, model)
  }
  if (!block || typeof block !== 'object') {
    return 0
  }
  const typed = block as Record<string, unknown>
  switch (typed.type) {
    case 'text':
      return typeof typed.text === 'string' ? countText(typed.text, model) : 0
    case 'image':
    case 'document':
      return IMAGE_TOKEN_ESTIMATE
    case 'tool_result':
      return countContent(typed.content, model)
    case 'tool_use': {
      const name = typeof typed.name === 'string' ? typed.name : ''
      return countText(name + stringify(typed.input ?? {}), model)
    }
    case 'thinking':
      return typeof typed.thinking === 'string'
        ? countText(typed.thinking, model)
        : 0
    case 'redacted_thinking':
      return typeof typed.data === 'string' ? countText(typed.data, model) : 0
    default:
      return countText(stringify(block), model)
  }
}

/** Same serialization as `jsonStringify` (JSON.stringify + slow-op logging). */
function stringify(value: unknown): string {
  return JSON.stringify(value) ?? ''
}

function countText(text: string, model: string): number {
  return estimateTokens(text, model).tokens
}
