// Ported from oh-my-pi (MIT). See THIRD_PARTY_NOTICES.md in this directory.
import type { Message } from '../../../../types/message.js'
import { isAbortError } from '../../../../utils/errors.js'
import type { RemoteLaneRequest, RemoteLaneResult } from './index.js'

/**
 * OpenAI Responses remote compaction.
 *
 * - V1 (`POST /responses/compact`): send the Responses-native history and keep
 *   the returned `compaction` / `compaction_summary` item plus the retained
 *   messages as replacement history in `preserveData`.
 * - V2 (streaming): append a trailing `compaction_trigger` input item to the
 *   normal Responses stream and require exactly one streamed `compaction`
 *   output item.
 *
 * CCH's OpenAI provider speaks Chat Completions through the official SDK.
 * Only Responses-capable, known endpoints are mapped here; everything else
 * (unknown gateways, ChatGPT Codex without a configured compact endpoint,
 * unmappable content) returns `skipped` with a reason.
 */

export const OPENAI_REMOTE_COMPACTION_PRESERVE_KEY = 'openaiRemoteCompaction'
export const V2_RETAINED_MESSAGE_TOKEN_BUDGET = 64_000
const IMAGE_TOKEN_ESTIMATE = 765
const CONTEXTUAL_USER_PREFIXES = [
  '<environment_context>',
  '<user_instructions>',
  '<additional_context>',
  '<skills',
  '<token_budget>',
  '<model_switch>',
]

export type OpenAiEndpointKind =
  | 'official'
  | 'bedrock-openai'
  | 'codex'
  | 'unknown'

export function classifyOpenAiEndpoint(
  baseUrl: string | undefined,
): OpenAiEndpointKind {
  if (!baseUrl || baseUrl.trim().length === 0) return 'official'
  let url: URL
  try {
    url = new URL(baseUrl)
  } catch {
    return 'unknown'
  }
  const host = url.hostname.toLowerCase()
  if (host === 'api.openai.com' || host.endsWith('.api.openai.com')) {
    return 'official'
  }
  if (host === 'chatgpt.com' || url.pathname.includes('/codex')) {
    return 'codex'
  }
  const bedrockHost =
    host.includes('bedrock-runtime') || host.includes('bedrock-mantle')
  if (
    bedrockHost &&
    (url.pathname.includes('/openai') || url.pathname.startsWith('/v1'))
  ) {
    return 'bedrock-openai'
  }
  return 'unknown'
}

export function isOpenAiCompactionLaneAvailable(input: {
  model: string
  baseUrl?: string
  apiKey?: string
}): boolean {
  const kind = classifyOpenAiEndpoint(input.baseUrl)
  if (kind === 'unknown') return false
  if (kind === 'codex') {
    // Known endpoint, but the compact endpoint is not exposed by Codex.
    return true
  }
  return Boolean(input.apiKey && input.apiKey.length > 0)
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : undefined
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map(block => {
      const record = recordOf(block)
      return record?.type === 'text' && typeof record.text === 'string'
        ? record.text
        : ''
    })
    .join('')
}

function toDataUrl(block: Record<string, unknown>): string | undefined {
  const source = recordOf(block.source)
  if (source?.type === 'base64') {
    return `data:${source.media_type};base64,${source.data}`
  }
  return undefined
}

export interface OpenAiInputBuild {
  input: Array<Record<string, unknown>>
  unsupported?: string
}

/**
 * Build Responses-API native history from CCH messages. Unmappable content
 * (provider-native reasoning, server tools) makes the lane skip instead of
 * silently dropping state the provider would need.
 */
export function buildOpenAiCompactionInput(
  messages: readonly Message[],
): OpenAiInputBuild {
  const input: Array<Record<string, unknown>> = []
  for (const message of messages) {
    const role =
      message.type === 'assistant'
        ? 'assistant'
        : message.type === 'user'
          ? 'user'
          : undefined
    if (!role) continue
    const raw = message.message?.content
    if (typeof raw === 'string') {
      if (raw.trim().length > 0) {
        input.push({
          type: 'message',
          role,
          content: [
            {
              type: role === 'assistant' ? 'output_text' : 'input_text',
              text: raw,
            },
          ],
        })
      }
      continue
    }
    if (!Array.isArray(raw)) continue
    const blocks: Array<Record<string, unknown>> = []
    for (const item of raw) {
      const block = recordOf(item)
      if (!block) continue
      switch (block.type) {
        case 'text':
          if (typeof block.text === 'string' && block.text.length > 0) {
            blocks.push({
              type: role === 'assistant' ? 'output_text' : 'input_text',
              text: block.text,
            })
          }
          break
        case 'image': {
          const url = toDataUrl(block)
          if (url) blocks.push({ type: 'input_image', image_url: url })
          break
        }
        case 'tool_use':
          if (role !== 'assistant') {
            return { input: [], unsupported: 'openai-tool-use-in-user-message' }
          }
          input.push({
            type: 'function_call',
            call_id: block.id,
            name: block.name,
            arguments: JSON.stringify(block.input ?? {}),
          })
          break
        case 'tool_result':
          input.push({
            type: 'function_call_output',
            call_id: block.tool_use_id,
            output: textOf(block.content),
          })
          break
        case 'thinking':
        case 'redacted_thinking':
          // Reasoning blocks are not part of the OpenAI wire format; skip them
          // instead of refusing the whole compaction for thinking sessions.
          break
        default:
          return {
            input: [],
            unsupported: 'openai-unsupported-content-block',
          }
      }
    }
    if (blocks.length > 0) {
      input.push({ type: 'message', role, content: blocks })
    }
  }
  if (input.length === 0) {
    return { input: [], unsupported: 'openai-no-summarizable-messages' }
  }
  return { input }
}

function resolveOpenAiBase(baseUrl: string | undefined): string {
  const raw = baseUrl?.trim() ? baseUrl : 'https://api.openai.com/v1'
  return raw.replace(/\/+$/, '')
}

export function resolveOpenAiCompactEndpoint(
  baseUrl: string | undefined,
): string {
  const base = resolveOpenAiBase(baseUrl)
  return base.endsWith('/v1')
    ? `${base}/responses/compact`
    : `${base}/v1/responses/compact`
}

export function resolveOpenAiResponsesEndpoint(
  baseUrl: string | undefined,
): string {
  const base = resolveOpenAiBase(baseUrl)
  return base.endsWith('/v1') ? `${base}/responses` : `${base}/v1/responses`
}

function openAiHeaders(apiKey: string | undefined): Record<string, string> {
  return {
    'content-type': 'application/json',
    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
  }
}

function shouldKeepV1OutputItem(item: Record<string, unknown>): boolean {
  if (item.type === 'compaction' || item.type === 'compaction_summary') {
    return true
  }
  if (item.type !== 'message') return false
  return item.role === 'assistant' || item.role === 'user'
}

function isCompactionItem(item: Record<string, unknown>): boolean {
  if (item.type === 'compaction') {
    return typeof item.encrypted_content === 'string'
  }
  return item.type === 'compaction_summary'
}

export interface OpenAiRemoteCompactionPreserveData {
  provider?: string
  replacementHistory: Array<Record<string, unknown>>
  compactionItem: Record<string, unknown>
}

export function withOpenAiRemoteCompactionPreserveData(
  preserveData: Record<string, unknown> | undefined,
  compaction: OpenAiRemoteCompactionPreserveData | undefined,
): Record<string, unknown> | undefined {
  if (compaction) {
    return {
      ...preserveData,
      [OPENAI_REMOTE_COMPACTION_PRESERVE_KEY]: compaction,
    }
  }
  if (
    !preserveData ||
    !(OPENAI_REMOTE_COMPACTION_PRESERVE_KEY in preserveData)
  ) {
    return preserveData
  }
  const { [OPENAI_REMOTE_COMPACTION_PRESERVE_KEY]: _removed, ...rest } =
    preserveData
  return Object.keys(rest).length > 0 ? rest : undefined
}

export function getPreservedOpenAiRemoteCompactionData(
  preserveData: Record<string, unknown> | undefined,
): OpenAiRemoteCompactionPreserveData | undefined {
  const candidate = recordOf(
    preserveData?.[OPENAI_REMOTE_COMPACTION_PRESERVE_KEY],
  )
  if (!candidate) return undefined
  if (!Array.isArray(candidate.replacementHistory)) return undefined
  const item = recordOf(candidate.compactionItem)
  if (!item || !isCompactionItem(item)) return undefined
  return {
    ...(typeof candidate.provider === 'string'
      ? { provider: candidate.provider }
      : {}),
    replacementHistory: candidate.replacementHistory as Array<
      Record<string, unknown>
    >,
    compactionItem: item,
  }
}

async function runV1(
  request: RemoteLaneRequest,
  input: Array<Record<string, unknown>>,
): Promise<RemoteLaneResult> {
  const fetchImpl = request.transport.fetch
  if (!fetchImpl) return { skipped: 'openai-transport-missing' }
  const endpoint = resolveOpenAiCompactEndpoint(request.transport.baseUrl)
  const response = await fetchImpl(endpoint, {
    method: 'POST',
    headers: openAiHeaders(request.transport.apiKey),
    body: JSON.stringify({
      model: request.transport.model,
      input,
      instructions: request.instructions,
    }),
    signal: request.signal,
  })
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(
      `OpenAI remote compaction failed (${response.status} ${response.statusText ?? ''})${detail ? `: ${detail.slice(0, 200)}` : ''}`,
    )
  }
  const data = recordOf((await response.json()) as unknown)
  const rawOutput = Array.isArray(data?.output) ? data.output : []
  const replacementHistory = rawOutput.filter(
    (item): item is Record<string, unknown> =>
      recordOf(item) !== undefined &&
      shouldKeepV1OutputItem(recordOf(item) as Record<string, unknown>),
  )
  const compactionItem = [...replacementHistory]
    .reverse()
    .find(item => isCompactionItem(item))
  if (!compactionItem) {
    throw new Error('Remote compaction response missing compaction item')
  }
  const summary =
    typeof compactionItem.summary === 'string' && compactionItem.summary
      ? compactionItem.summary
      : 'Conversation compacted by the provider.'
  return {
    summary,
    preserveData: withOpenAiRemoteCompactionPreserveData(undefined, {
      provider: 'openai',
      replacementHistory,
      compactionItem,
    }),
  }
}

export interface OpenAiV2Usage {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  cachedInputTokens?: number
  reasoningOutputTokens?: number
}

export interface OpenAiV2Collection {
  compactionItem?: Record<string, unknown>
  usage?: OpenAiV2Usage
  usedTokens: number
  outputItemCount: number
  completed: boolean
}

/** Parse `data:` frames from a Responses SSE stream. */
export function parseOpenAiCompactionSse(
  text: string,
): Array<Record<string, unknown>> {
  const events: Array<Record<string, unknown>> = []
  const lines = text.split(/\r?\n/)
  let dataLines: string[] = []
  const dispatch = (): void => {
    if (dataLines.length === 0) return
    const data = dataLines.join('\n')
    dataLines = []
    if (data === '[DONE]') return
    try {
      const parsed = recordOf(JSON.parse(data) as unknown)
      if (parsed) events.push(parsed)
    } catch {
      throw new Error('OpenAI V2 compaction stream parse failed')
    }
  }
  for (const line of lines) {
    if (line === '') {
      dispatch()
    } else if (line.startsWith('data:')) {
      dataLines.push(line.slice('data:'.length).trimStart())
    }
  }
  dispatch()
  return events
}

function parseUsage(event: Record<string, unknown>): OpenAiV2Usage | undefined {
  const response = recordOf(event.response)
  const usage = recordOf(response?.usage)
  if (!usage) return undefined
  const inputTokens = usage.input_tokens
  const outputTokens = usage.output_tokens
  const totalTokens = usage.total_tokens
  if (
    typeof inputTokens !== 'number' ||
    typeof outputTokens !== 'number' ||
    typeof totalTokens !== 'number'
  ) {
    return undefined
  }
  const inputDetails = recordOf(usage.input_tokens_details)
  const outputDetails = recordOf(usage.output_tokens_details)
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    ...(typeof inputDetails?.cached_tokens === 'number'
      ? { cachedInputTokens: inputDetails.cached_tokens }
      : {}),
    ...(typeof outputDetails?.reasoning_tokens === 'number'
      ? { reasoningOutputTokens: outputDetails.reasoning_tokens }
      : {}),
  }
}

/** Fold Responses events into the single compaction item V2 requires. */
export function collectOpenAiCompactionV2Events(
  events: readonly Record<string, unknown>[],
): OpenAiV2Collection {
  const collection: OpenAiV2Collection = {
    usedTokens: 0,
    outputItemCount: 0,
    completed: false,
  }
  const compactionItems: Array<Record<string, unknown>> = []
  for (const event of events) {
    const type = typeof event.type === 'string' ? event.type : undefined
    if (type === 'response.output_item.done') {
      collection.outputItemCount++
      const item = recordOf(event.item)
      if (item?.type === 'compaction') compactionItems.push(item)
      continue
    }
    if (type === 'response.completed' || type === 'response.done') {
      collection.completed = true
      collection.usage = parseUsage(event)
      continue
    }
    if (type === 'response.failed' || type === 'response.incomplete') {
      throw new Error(`V2 compaction stream ${type}`)
    }
    if (type === 'error') {
      const message =
        typeof event.message === 'string' ? event.message : 'unknown error'
      throw new Error(`V2 compaction stream error: ${message}`)
    }
  }
  if (!collection.completed) {
    throw new Error('V2 compaction stream closed before response.completed')
  }
  if (compactionItems.length !== 1) {
    throw new Error(
      `V2 compaction expected exactly one compaction output item, got ${compactionItems.length}`,
    )
  }
  collection.compactionItem = compactionItems[0]
  collection.usedTokens = collection.usage?.inputTokens ?? 0
  return collection
}

/** Accept either a raw SSE body or a non-streamed Responses JSON body. */
export function collectOpenAiCompactionV2Body(
  text: string,
): OpenAiV2Collection {
  const trimmed = text.trim()
  if (trimmed.startsWith('{')) {
    const body = recordOf(JSON.parse(trimmed) as unknown)
    const output = Array.isArray(body?.output) ? body.output : []
    const events: Array<Record<string, unknown>> = output
      .map(item => recordOf(item))
      .filter((item): item is Record<string, unknown> => item !== undefined)
      .map(item => ({ type: 'response.output_item.done', item }))
    events.push({
      type: 'response.completed',
      response: { usage: body?.usage },
    })
    return collectOpenAiCompactionV2Events(events)
  }
  return collectOpenAiCompactionV2Events(parseOpenAiCompactionSse(text))
}

function isRetainedUserItem(item: Record<string, unknown>): boolean {
  const isMessage =
    item.type === 'message' ||
    (item.type === undefined && typeof item.role === 'string')
  if (!isMessage || item.role !== 'user') return false
  const content = Array.isArray(item.content) ? item.content : []
  return !content.some(part => {
    const record = recordOf(part)
    if (record?.type !== 'input_text') return false
    const text =
      typeof record.text === 'string'
        ? record.text.trimStart().toLowerCase()
        : ''
    return CONTEXTUAL_USER_PREFIXES.some(prefix => text.startsWith(prefix))
  })
}

function approxTokenCount(text: string): number {
  return Math.ceil(text.length / 4)
}

function itemTokenCount(item: Record<string, unknown>): number {
  const content = Array.isArray(item.content) ? item.content : []
  let tokens = 0
  for (const part of content) {
    const record = recordOf(part)
    if (!record) continue
    if (record.type === 'input_image') {
      tokens += IMAGE_TOKEN_ESTIMATE
    } else if (record.type === 'input_text' || record.type === 'output_text') {
      tokens += approxTokenCount(
        typeof record.text === 'string' ? record.text : '',
      )
    }
  }
  return tokens
}

function truncateTextToBudget(text: string, maxTokens: number): string {
  if (maxTokens <= 0) return ''
  const maxChars = maxTokens * 4
  if (text.length <= maxChars) return text
  return text.slice(0, maxChars)
}

function truncateItemToBudget(
  item: Record<string, unknown>,
  maxTokens: number,
): Record<string, unknown> | undefined {
  const content = Array.isArray(item.content) ? item.content : []
  let remaining = maxTokens
  const kept: unknown[] = []
  for (const part of content) {
    const record = recordOf(part)
    if (!record) continue
    if (record.type === 'input_image') {
      if (remaining < IMAGE_TOKEN_ESTIMATE) continue
      kept.push(record)
      remaining -= IMAGE_TOKEN_ESTIMATE
      continue
    }
    if (record.type !== 'input_text' && record.type !== 'output_text') continue
    if (remaining <= 0) continue
    const text = typeof record.text === 'string' ? record.text : ''
    const tokens = approxTokenCount(text)
    if (tokens <= remaining) {
      kept.push(record)
      remaining -= tokens
    } else {
      const truncated = truncateTextToBudget(text, remaining)
      remaining = 0
      if (truncated.length > 0) kept.push({ ...record, text: truncated })
    }
  }
  if (kept.length === 0) return undefined
  return { ...item, content: kept }
}

export function buildOpenAiV2ReplacementHistory(
  input: readonly Record<string, unknown>[],
  compactionItem: Record<string, unknown>,
  retainedMessageBudget = V2_RETAINED_MESSAGE_TOKEN_BUDGET,
): {
  replacementHistory: Array<Record<string, unknown>>
  retainedImageCount: number
} {
  const budget = Math.min(
    V2_RETAINED_MESSAGE_TOKEN_BUDGET,
    Math.max(1, Math.floor(retainedMessageBudget)),
  )
  let remaining = budget
  const keptReversed: Array<Record<string, unknown>> = []
  for (let i = input.length - 1; i >= 0; i--) {
    if (remaining === 0) break
    const item = input[i]
    if (!isRetainedUserItem(item)) continue
    const tokens = Math.max(itemTokenCount(item), 1)
    if (tokens <= remaining) {
      keptReversed.push(item)
      remaining -= tokens
    } else {
      const truncated = truncateItemToBudget(item, remaining)
      if (truncated) keptReversed.push(truncated)
      remaining = 0
    }
  }
  const replacementHistory = keptReversed.reverse()
  const retainedImageCount = replacementHistory.reduce((count, item) => {
    const content = Array.isArray(item.content) ? item.content : []
    return (
      count +
      content.filter(part => recordOf(part)?.type === 'input_image').length
    )
  }, 0)
  replacementHistory.push(compactionItem)
  return { replacementHistory, retainedImageCount }
}

const V2_TIMEOUT_MS = 300_000
const V2_MAX_RETRIES = 2

async function fetchV2Once(
  fetchImpl: NonNullable<RemoteLaneRequest['transport']['fetch']>,
  endpoint: string,
  apiKey: string | undefined,
  body: Record<string, unknown>,
  signal: AbortSignal | undefined,
): Promise<Response> {
  const controller = new AbortController()
  const onAbort = () => controller.abort()
  if (signal) {
    if (signal.aborted) controller.abort()
    else signal.addEventListener('abort', onAbort, { once: true })
  }
  const timer = setTimeout(() => controller.abort(), V2_TIMEOUT_MS)
  try {
    return await fetchImpl(endpoint, {
      method: 'POST',
      headers: openAiHeaders(apiKey),
      body: JSON.stringify(body),
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}

async function runV2(
  request: RemoteLaneRequest,
  input: Array<Record<string, unknown>>,
): Promise<RemoteLaneResult> {
  const fetchImpl = request.transport.fetch
  if (!fetchImpl) return { skipped: 'openai-transport-missing' }
  const endpoint = resolveOpenAiResponsesEndpoint(request.transport.baseUrl)
  const body = {
    model: request.transport.model,
    input: [...input, { type: 'compaction_trigger' }],
    instructions: request.instructions,
    stream: true,
    store: false,
  }
  let response: Response | undefined
  let lastError: unknown
  for (let attempt = 0; attempt <= V2_MAX_RETRIES; attempt++) {
    try {
      response = await fetchV2Once(
        fetchImpl,
        endpoint,
        request.transport.apiKey,
        body,
        request.signal,
      )
      break
    } catch (error) {
      if (isAbortError(error) && request.signal?.aborted) throw error
      lastError = error
      if (attempt === V2_MAX_RETRIES) throw error
      await new Promise(resolve => setTimeout(resolve, 250 * (attempt + 1)))
    }
  }
  if (!response) throw lastError ?? new Error('V2 remote compaction failed')
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(
      `V2 remote compaction failed (${response.status} ${response.statusText ?? ''})${detail ? `: ${detail.slice(0, 200)}` : ''}`,
    )
  }
  const collection = collectOpenAiCompactionV2Body(await response.text())
  const compactionItem = collection.compactionItem
  if (!compactionItem) {
    throw new Error('V2 remote compaction returned no compaction item')
  }
  const { replacementHistory, retainedImageCount } =
    buildOpenAiV2ReplacementHistory(input, compactionItem)
  const summary =
    typeof compactionItem.summary === 'string' && compactionItem.summary
      ? compactionItem.summary
      : 'Conversation compacted by the provider.'
  return {
    summary,
    preserveData: {
      [OPENAI_REMOTE_COMPACTION_PRESERVE_KEY]: {
        version: 'v2',
        provider: 'openai',
        replacementHistory,
        compactionItem,
        usedTokens: collection.usedTokens,
        usage: collection.usage,
        retainedImageCount,
      },
    },
  }
}

export async function runOpenAiCompactionLane(
  request: RemoteLaneRequest,
): Promise<RemoteLaneResult> {
  const kind = classifyOpenAiEndpoint(request.transport.baseUrl)
  if (kind === 'unknown') {
    return { skipped: 'openai-endpoint-unknown' }
  }
  if (kind === 'codex') {
    return { skipped: 'openai-codex-compact-unsupported' }
  }
  const built = buildOpenAiCompactionInput(request.ctx.messages)
  if (built.unsupported) return { skipped: built.unsupported }

  const version = request.options?.openAiVersion ?? 'auto'
  if (version === 'v1') return runV1(request, built.input)
  if (version === 'v2') return runV2(request, built.input)
  try {
    return await runV2(request, built.input)
  } catch (error) {
    // Never swallow an abort (user ESC) into a duplicate V1 request. DOMException
    // from undici/bun is not an Error instance, so use the shared helper.
    if (isAbortError(error)) throw error
    return runV1(request, built.input)
  }
}
