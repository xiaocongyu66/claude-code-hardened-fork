// Ported from oh-my-pi (MIT). See THIRD_PARTY_NOTICES.md in this directory.
import type { Message } from '../../../../types/message.js'
import type { RemoteLaneRequest, RemoteLaneResult } from './index.js'
import { supportsAnthropicServerCompaction } from './anthropic.js'

/**
 * Amazon Bedrock Converse compaction lane.
 *
 * The reference implementation compacts Converse models through a Bedrock
 * Runtime side request. CCH already ships `createBedrockRuntimeClient()` (the
 * same client/credential chain the main Bedrock provider uses), so the lane
 * shapes a standard Converse request and lets `transport.ts` forward it through
 * that runtime when one is available. Without a runtime the lane stays
 * `skipped` and the method chain falls through.
 *
 * The side request is gated by `CCH_BEDROCK_COMPACTION=1`, independent of the
 * outer `CCH_REMOTE_COMPACTION` switch: enabling remote compaction for
 * Anthropic/OpenAI must not silently start Bedrock side requests.
 */

export const BEDROCK_COMPACTION_ENV = 'CCH_BEDROCK_COMPACTION'
export const BEDROCK_COMPACTION_TIMEOUT_ENV =
  'CCH_BEDROCK_COMPACTION_TIMEOUT_MS'
export const DEFAULT_BEDROCK_COMPACTION_TIMEOUT_MS = 60_000
export const BEDROCK_COMPACTION_PRESERVE_KEY = 'bedrock'
export const BEDROCK_COMPACTION_SKIPPED_REASON =
  'bedrock-converse-transport-unavailable'
export const BEDROCK_COMPACTION_DISABLED_REASON = 'bedrock-compaction-disabled'
export const BEDROCK_COMPACTION_EMPTY_REASON =
  'bedrock-no-summarizable-messages'

const DEFAULT_MAX_TOKENS = 8192

export function isBedrockCompactionEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env[BEDROCK_COMPACTION_ENV] === '1'
}

export function isBedrockCompactionLaneAvailable(input: {
  model: string
  region?: string
  env?: Record<string, string | undefined>
}): boolean {
  if (!input.region || input.region.trim().length === 0) return false
  if (input.env && !isBedrockCompactionEnabled(input.env)) return false
  return supportsAnthropicServerCompaction(input.model)
}

/** Shape a Converse side request would take once a transport is available. */
export interface BedrockConverseCompactionSideRequest {
  modelId: string
  body: Record<string, unknown>
  contentType: 'application/json'
  accept: 'application/json'
}

export type BedrockConverseContentBlock =
  | { text: string }
  | { toolUse: { toolUseId: string; name: string; input: unknown } }
  | {
      toolResult: {
        toolUseId: string
        content: Array<{ text: string }>
        status?: 'success' | 'error'
      }
    }

export interface BedrockConverseMessage {
  role: 'user' | 'assistant'
  content: BedrockConverseContentBlock[]
}

export interface BedrockConverseMapping {
  messages: BedrockConverseMessage[]
  unsupported?: string
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

/**
 * Map CCH's Anthropic-shaped content blocks onto Converse blocks.
 *
 * Only text, tool_use and tool_result are translated. Images are not needed
 * for a summary and image sources differ between the two APIs; reasoning
 * blocks are provider-private. `system` and `tools` are deliberately omitted:
 * `CompactionContext` carries neither, and the summary request does not need
 * the live tool schema.
 */
export function toBedrockConverseMessages(
  messages: readonly Message[],
): BedrockConverseMapping {
  const converted: BedrockConverseMessage[] = []
  const push = (
    role: 'user' | 'assistant',
    block: BedrockConverseContentBlock,
  ) => {
    const last = converted[converted.length - 1]
    // Converse expects alternating roles; merge same-role neighbours.
    if (last && last.role === role) {
      last.content.push(block)
    } else {
      converted.push({ role, content: [block] })
    }
  }
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
      if (raw.trim().length > 0) push(role, { text: raw })
      continue
    }
    if (!Array.isArray(raw)) continue
    for (const item of raw) {
      const block = recordOf(item)
      if (!block) continue
      switch (block.type) {
        case 'text':
          if (typeof block.text === 'string' && block.text.length > 0) {
            push(role, { text: block.text })
          }
          break
        case 'tool_use':
          if (role !== 'assistant') {
            return {
              messages: [],
              unsupported: 'bedrock-tool-use-in-user-message',
            }
          }
          push(role, {
            toolUse: {
              toolUseId: String(block.id ?? ''),
              name: String(block.name ?? ''),
              input: block.input ?? {},
            },
          })
          break
        case 'tool_result':
          if (role !== 'user') {
            return {
              messages: [],
              unsupported: 'bedrock-tool-result-in-assistant-message',
            }
          }
          push(role, {
            toolResult: {
              toolUseId: String(block.tool_use_id ?? ''),
              content: [{ text: textOf(block.content) }],
              ...(block.is_error === true
                ? { status: 'error' as const }
                : { status: 'success' as const }),
            },
          })
          break
        case 'thinking':
        case 'redacted_thinking':
        case 'image':
          // Not part of a summary request.
          break
        default:
          // Unknown block types cannot be replayed safely.
          return {
            messages: [],
            unsupported: 'bedrock-unsupported-content-block',
          }
      }
    }
  }
  if (converted.length === 0) {
    return { messages: [], unsupported: BEDROCK_COMPACTION_EMPTY_REASON }
  }
  return { messages: converted }
}

export function buildBedrockConverseCompactionSideRequest(
  request: RemoteLaneRequest,
  options: { maxTokens?: number } = {},
): BedrockConverseCompactionSideRequest | undefined {
  const converted = toBedrockConverseMessages(request.ctx.messages)
  if (converted.unsupported) return undefined
  return {
    modelId: request.ctx.model,
    body: {
      messages: converted.messages,
      inferenceConfig: {
        maxTokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
      },
    },
    contentType: 'application/json',
    accept: 'application/json',
  }
}

/** Concatenate the text blocks of `output.message.content`. */
export function extractBedrockConverseSummary(
  payload: unknown,
): string | undefined {
  const output = recordOf(recordOf(payload)?.output)
  const message = recordOf(output?.message)
  const content = Array.isArray(message?.content) ? message.content : []
  const text = content
    .map(block => {
      const record = recordOf(block)
      return typeof record?.text === 'string' ? record.text : ''
    })
    .join('\n')
    .trim()
  return text.length > 0 ? text : undefined
}

export function resolveBedrockConverseEndpoint(input: {
  baseUrl?: string
  model: string
  region?: string
}): string | undefined {
  const raw =
    input.baseUrl?.trim() ||
    (input.region
      ? `https://bedrock-runtime.${input.region}.amazonaws.com`
      : undefined)
  if (!raw) return undefined
  const base = raw.replace(/\/+$/, '')
  return `${base}/model/${encodeURIComponent(input.model)}/converse`
}

function resolveTimeoutMs(env: Record<string, string | undefined>): number {
  const raw = env[BEDROCK_COMPACTION_TIMEOUT_ENV]
  if (!raw) return DEFAULT_BEDROCK_COMPACTION_TIMEOUT_MS
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed > 0
    ? Math.floor(parsed)
    : DEFAULT_BEDROCK_COMPACTION_TIMEOUT_MS
}

export interface BedrockConversePreserveData {
  version: 1
  provider: 'bedrock'
  model: string
  modelId: string
  stopReason?: string
  usedTokens?: number
}

export function buildBedrockPreserveData(
  input: BedrockConversePreserveData,
): Record<string, unknown> {
  return { [BEDROCK_COMPACTION_PRESERVE_KEY]: input }
}

function usageOf(payload: unknown): { usedTokens?: number } {
  const usage = recordOf(recordOf(payload)?.usage)
  const inputTokens = usage?.inputTokens
  return typeof inputTokens === 'number' ? { usedTokens: inputTokens } : {}
}

/**
 * Run the Converse side request. Errors and timeouts throw so the method chain
 * records a `failed` outcome and degrades to the next method.
 */
export async function runBedrockCompactionLane(
  request: RemoteLaneRequest,
): Promise<RemoteLaneResult> {
  if (!isBedrockCompactionEnabled(request.env)) {
    return { skipped: BEDROCK_COMPACTION_DISABLED_REASON }
  }
  const fetchImpl = request.transport.fetch
  if (!fetchImpl) return { skipped: BEDROCK_COMPACTION_SKIPPED_REASON }

  const built = buildBedrockConverseCompactionSideRequest(request)
  if (!built) {
    const mapped = toBedrockConverseMessages(request.ctx.messages)
    return {
      skipped: mapped.unsupported ?? BEDROCK_COMPACTION_EMPTY_REASON,
    }
  }

  const endpoint = resolveBedrockConverseEndpoint({
    baseUrl: request.transport.baseUrl,
    model: built.modelId,
    region: request.env.AWS_REGION ?? request.env.AWS_DEFAULT_REGION,
  })
  if (!endpoint) return { skipped: BEDROCK_COMPACTION_SKIPPED_REASON }

  const controller = new AbortController()
  const onAbort = () => controller.abort()
  if (request.signal) {
    if (request.signal.aborted) controller.abort()
    else request.signal.addEventListener('abort', onAbort, { once: true })
  }
  const timeoutMs = resolveTimeoutMs(request.env)
  let timer: ReturnType<typeof setTimeout> | undefined
  let timedOut = false
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true
      controller.abort()
      reject(new Error(`Bedrock compaction timed out after ${timeoutMs}ms`))
    }, timeoutMs)
  })
  try {
    const call = fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        'content-type': built.contentType,
        accept: built.accept,
      },
      body: JSON.stringify(built.body),
      signal: controller.signal,
    })
    // After a timeout wins the race the aborted request may still reject; keep
    // that rejection handled.
    call.catch(() => {})
    let response: Response
    try {
      response = await Promise.race([call, timeout])
    } catch (error) {
      // The SDK may reject with the abort reason before the timeout promise
      // settles; normalize either path to the timeout error.
      if (timedOut) {
        throw new Error(`Bedrock compaction timed out after ${timeoutMs}ms`)
      }
      throw error
    }
    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      throw new Error(
        `Bedrock compaction failed (${response.status} ${response.statusText ?? ''})${detail ? `: ${detail.slice(0, 200)}` : ''}`,
      )
    }
    const payload = (await response.json()) as unknown
    const summary = extractBedrockConverseSummary(payload)
    if (!summary) {
      throw new Error('Bedrock Converse compaction returned no summary')
    }
    const stopReason = recordOf(payload)?.stopReason
    return {
      summary,
      preserveData: buildBedrockPreserveData({
        version: 1,
        provider: 'bedrock',
        model: request.ctx.model,
        modelId: built.modelId,
        ...(typeof stopReason === 'string' ? { stopReason } : {}),
        ...usageOf(payload),
      }),
    }
  } finally {
    if (timer) clearTimeout(timer)
    request.signal?.removeEventListener('abort', onAbort)
  }
}
