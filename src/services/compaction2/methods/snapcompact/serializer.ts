/**
 * Conversation serialization for snapcompact frames.
 *
 * Ported from oh-my-pi's `serializeConversation`, adapted to CCH's
 * Anthropic-shaped messages (`msg.message.content` with text/tool_use/
 * tool_result/thinking/image blocks).
 *
 * Budgets match the upstream contract:
 * - tool results: 2,000 chars, head+tail split at 0.6;
 * - each tool argument value: 500 chars;
 * - a whole tool call's argument list: 2,000 chars;
 * - tool-result bodies are dimmed (zero-width ink toggles) by default.
 */

import type { Message } from '../../../../types/message.js'

/** Default per-tool-result character cap. */
export const TOOL_RESULT_MAX_CHARS = 2000
/** Default per-argument-value character cap. */
export const TOOL_ARG_MAX_CHARS = 500
/** Default whole-argument-list cap per call. */
export const TOOL_CALL_MAX_CHARS = 2000
/** Head share of a truncation budget; the rest keeps the tail. */
export const TRUNCATE_HEAD_RATIO = 0.6

/** Zero-width dim-ink toggles understood by the renderer. */
export const DIM_ON = '\u000e'
export const DIM_OFF = '\u000f'

/** Visible cell used for a line break (matches the upstream full block). */
export const NEWLINE_GLYPH = '\u2588'

export interface SerializeOptions {
  /** Per-tool-result cap. Defaults to {@link TOOL_RESULT_MAX_CHARS}. */
  toolResultMaxChars?: number
  /** Per-argument-value cap. Defaults to {@link TOOL_ARG_MAX_CHARS}. */
  toolArgMaxChars?: number
  /** Whole-argument-list cap per call. Defaults to {@link TOOL_CALL_MAX_CHARS}. */
  toolCallMaxChars?: number
  /** Head share, clamped to [0, 1]. Defaults to {@link TRUNCATE_HEAD_RATIO}. */
  truncateHeadRatio?: number
  /** Print tool-result bodies in dim ink. Defaults to true. */
  dimToolResults?: boolean
  /** Serialize assistant reasoning as `¶think:` sections. Defaults to true. */
  includeThinking?: boolean
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: ink toggles are intentional zero-width control characters
const DIM_MARKERS = /[\u000e\u000f]/g
// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape introducer
const ANSI_ESCAPE = /\u001b\[[0-9;?]*[ -/]*[@-~]/g
const DATA_URL =
  /data:[A-Za-z][\w.+-]*\/[\w.+-]+(?:;[\w!#$%&'*+.^|~-]+=[\w!#$%&'*+.^|~-]+)*;base64,[A-Za-z0-9+/=]+/gi

/** Keep the head and tail of `text`, eliding the middle beyond `maxChars`. */
export function truncateForSummary(
  text: string,
  maxChars: number,
  headRatio: number,
): string {
  if (text.length <= maxChars) return text
  const ratio = Math.min(Math.max(headRatio, 0), 1)
  const headChars = Math.round(maxChars * ratio)
  const tailChars = maxChars - headChars
  const elided = text.length - maxChars
  const tail = tailChars > 0 ? text.slice(-tailChars) : ''
  return `${text.slice(0, headChars)} […${elided}ch elided…] ${tail}`
}

/** Strip stray ink toggles so raw content cannot forge dim spans. */
export function stripDimMarkers(text: string): string {
  return text.replace(DIM_MARKERS, '')
}

/** Replace inline base64 data URLs with a short marker before truncation. */
function elideDataUrls(text: string): string {
  return text.replace(DATA_URL, '[data-url]')
}

type AnyBlock = {
  type?: string
  text?: string
  thinking?: string
  id?: string
  name?: string
  input?: unknown
  arguments?: unknown
  content?: unknown
  tool_use_id?: string
  is_error?: boolean
  [key: string]: unknown
}

function blocksOf(message: Message): AnyBlock[] {
  const content = message.message?.content
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  if (!Array.isArray(content)) return []
  return content as unknown as AnyBlock[]
}

/** Flatten a tool_result body (string or content-block array) to text. */
function toolResultText(block: AnyBlock): string {
  const content = block.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) {
    return content === undefined ? '' : (JSON.stringify(content) ?? '')
  }
  const parts: string[] = []
  for (const item of content as unknown as AnyBlock[]) {
    if (item.type === 'text' && typeof item.text === 'string') {
      parts.push(item.text)
    } else if (item.type === 'image' || item.type === 'document') {
      parts.push(`[${item.type}]`)
    } else if (typeof item.text === 'string') {
      parts.push(item.text)
    }
  }
  return parts.join('')
}

function argValue(value: unknown): string {
  const json = JSON.stringify(value)
  return json === undefined ? 'undefined' : json
}

/**
 * Serialize the discarded conversation into frame-ready text. Tool results
 * merge into their originating `¶call:` scope when the call is in the window;
 * orphan results render standalone.
 */
export function serializeConversation(
  messages: readonly Message[],
  options?: SerializeOptions,
): string {
  const toolResultMaxChars =
    options?.toolResultMaxChars ?? TOOL_RESULT_MAX_CHARS
  const toolArgMaxChars = options?.toolArgMaxChars ?? TOOL_ARG_MAX_CHARS
  const toolCallMaxChars = options?.toolCallMaxChars ?? TOOL_CALL_MAX_CHARS
  const headRatio = options?.truncateHeadRatio ?? TRUNCATE_HEAD_RATIO
  const dimToolResults = options?.dimToolResults !== false
  const includeThinking = options?.includeThinking !== false

  const parts: string[] = []
  let lastPrefix: string | null = null

  const pushPart = (prefix: string, content: string): void => {
    const lastIndex = parts.length - 1
    if (lastIndex >= 0 && lastPrefix === prefix) {
      const previous = parts[lastIndex] ?? ''
      const sep =
        previous.endsWith('\n') || content.startsWith('\n') ? '' : '\n'
      parts[lastIndex] = previous + sep + content
    } else {
      parts.push(prefix + content)
      lastPrefix = prefix
    }
  }

  // Index surviving tool results by call id. CCH messages do not carry
  // oh-my-pi's `useless` flag, but honor it when a host sets one.
  const uselessCallIds = new Set<string>()
  const resultTextByCallId = new Map<string, string>()
  for (const message of messages) {
    if (message.type !== 'user') continue
    for (const block of blocksOf(message)) {
      if (block.type !== 'tool_result') continue
      const callId = block.tool_use_id
      if (typeof callId !== 'string') continue
      if (
        (message as unknown as { useless?: unknown }).useless === true &&
        block.is_error !== true
      ) {
        uselessCallIds.add(callId)
        continue
      }
      const text = toolResultText(block)
      if (text) resultTextByCallId.set(callId, text)
    }
  }

  const renderResultBlock = (rawText: string): string => {
    const body = truncateForSummary(
      elideDataUrls(stripDimMarkers(rawText)),
      toolResultMaxChars,
      headRatio,
    )
    return `<out>\n${dimToolResults ? `${DIM_ON}${body}${DIM_OFF}` : body}\n</out>`
  }

  const mergedCallIds = new Set<string>()

  for (const message of messages) {
    if (message.type === 'user') {
      for (const block of blocksOf(message)) {
        if (block.type === 'text' && typeof block.text === 'string') {
          const text = stripDimMarkers(block.text)
          if (text) pushPart('¶user:', text)
        } else if (block.type === 'image') {
          pushPart('¶user:', '[image]')
        }
      }
      continue
    }
    if (message.type !== 'assistant') continue

    let pendingThinking: string[] = []
    let pendingText: string[] = []
    const flushAssistant = (): void => {
      if (pendingThinking.length > 0) {
        pushPart('¶think:', pendingThinking.join('\n'))
      }
      if (pendingText.length > 0) {
        pushPart('¶ai:', pendingText.join('\n'))
      }
      pendingThinking = []
      pendingText = []
    }

    for (const block of blocksOf(message)) {
      if (block.type === 'text' && typeof block.text === 'string') {
        const text = stripDimMarkers(block.text)
        if (text.trim()) pendingText.push(text)
      } else if (block.type === 'thinking') {
        if (!includeThinking) continue
        const thinking = stripDimMarkers(
          typeof block.thinking === 'string' ? block.thinking : '',
        )
        if (thinking.trim()) pendingThinking.push(thinking)
      } else if (block.type === 'tool_use') {
        const callId = typeof block.id === 'string' ? block.id : ''
        if (callId && uselessCallIds.has(callId)) continue
        flushAssistant()
        const args = (block.input ?? block.arguments ?? {}) as Record<
          string,
          unknown
        >
        const rawIntent =
          typeof block.intent === 'string'
            ? block.intent
            : typeof args.intent === 'string'
              ? args.intent
              : ''
        const intent = stripDimMarkers(rawIntent).replace(/\s+/g, ' ').trim()
        const argsStr = truncateForSummary(
          Object.entries(args)
            .filter(([key]) => key !== 'intent')
            .map(
              ([key, value]) =>
                `${key}=${truncateForSummary(
                  elideDataUrls(argValue(value)),
                  toolArgMaxChars,
                  headRatio,
                )}`,
            )
            .join(', '),
          toolCallMaxChars,
          headRatio,
        )
        let firstLine = `${block.name ?? 'tool'}(${argsStr})`
        if (intent) firstLine += `//${intent}`
        const lines = [firstLine]
        const resultText = callId ? resultTextByCallId.get(callId) : undefined
        if (resultText !== undefined) {
          mergedCallIds.add(callId)
          lines.push(renderResultBlock(resultText))
        }
        pushPart('¶call:', lines.join('\n'))
      }
    }
    flushAssistant()
  }

  // Orphan tool results (their call is outside this window) render standalone.
  for (const message of messages) {
    if (message.type !== 'user') continue
    for (const block of blocksOf(message)) {
      if (block.type !== 'tool_result') continue
      const callId = block.tool_use_id
      if (typeof callId !== 'string') continue
      if (uselessCallIds.has(callId) || mergedCallIds.has(callId)) continue
      const resultText = resultTextByCallId.get(callId)
      if (resultText !== undefined) {
        pushPart('¶call:', `\n${renderResultBlock(resultText)}`)
      }
    }
  }

  return parts.join('\n\n')
}

/** Common Unicode punctuation folded to ASCII for the bitmap font. */
const CHAR_FOLD: Record<string, string> = {
  '\u00a0': ' ',
  '—': '-',
  '–': '-',
  '−': '-',
  '“': '"',
  '”': '"',
  '„': '"',
  '‘': "'",
  '’': "'",
  '‚': "'",
  '…': '...',
  '•': '*',
  '·': '*',
  '→': '->',
  '←': '<-',
  '¶': '#',
  '│': '|',
  '┃': '|',
  '─': '-',
  '━': '-',
  '┌': '+',
  '┐': '+',
  '└': '+',
  '┘': '+',
  '├': '+',
  '┤': '+',
  '┬': '+',
  '┴': '+',
  '┼': '+',
  '✓': '[OK]',
  '✔': '[OK]',
  '✗': '[X]',
  '✘': '[X]',
  '⚠': '[!]',
}

/**
 * Normalize serialized text for a bitmap frame: strip ANSI, collapse
 * whitespace, fold newlines to {@link NEWLINE_GLYPH}, and transliterate
 * unrenderable code points to ASCII (`?` when no fold exists). Ink toggles
 * are preserved as zero-width markers.
 */
export function normalizeForFrame(text: string): string {
  const stripped = text.replace(ANSI_ESCAPE, '').replace(/\r\n?/g, '\n')
  const collapsed = stripped
    .replace(/[\t\f\v ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  let out = ''
  for (const ch of collapsed) {
    if (ch === '\n') {
      out += NEWLINE_GLYPH
      continue
    }
    if (ch === DIM_ON || ch === DIM_OFF) {
      out += ch
      continue
    }
    const codePoint = ch.codePointAt(0)
    if (codePoint !== undefined && codePoint >= 0x20 && codePoint <= 0x7e) {
      out += ch
      continue
    }
    out += CHAR_FOLD[ch] ?? '?'
  }
  return out
}
