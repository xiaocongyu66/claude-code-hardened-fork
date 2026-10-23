// Ported from oh-my-pi (MIT). See THIRD_PARTY_NOTICES.md in this directory.
import type { Message } from '../../../../types/message.js'
import { computeRemoteCut } from './index.js'
import type { RemoteLaneRequest, RemoteLaneResult } from './index.js'

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

/** Placeholder for tool results whose text payload is empty. Converse rejects
 * empty `text` blocks, so an omitted/empty result must not be sent verbatim. */
export const BEDROCK_EMPTY_TOOL_RESULT_TEXT = '(no output)'

/** Converse stop reasons that represent a completed completion. Anything else
 * (`max_tokens`, `content_filtered`, `guardrail_intervened`, …) means the
 * summary is truncated or withheld and must degrade instead of being accepted. */
const SUCCESSFUL_STOP_REASONS = new Set(['end_turn', 'stop_sequence'])

/**
 * Bedrock Converse summaries do not use Anthropic's server-side compaction
 * beta, so the Anthropic model catalog (Opus/Sonnet 4.6+, …) does not apply.
 * Any Claude model reachable through Converse can be summarized; only a
 * clearly non-Claude model id is skipped.
 */
export function supportsBedrockConverseCompaction(model: string): boolean {
  return /claude[-.]/.test(model.toLowerCase())
}

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
  return supportsBedrockConverseCompaction(input.model)
}

/** Shape a Converse side request would take once a transport is available. */
export interface BedrockConverseCompactionSideRequest {
  modelId: string
  body: Record<string, unknown>
  contentType: 'application/json'
  accept: 'application/json'
  /** Unsupported blocks dropped from the request (non-fatal). */
  skippedBlocks?: number
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
  /** Blocks with no Converse equivalent that were dropped (non-fatal). */
  skippedBlocks?: number
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
 * blocks are provider-private. Blocks with no Converse equivalent (document,
 * web_search_tool_result, …) are skipped and counted rather than failing the
 * whole request. `tools` is deliberately omitted: `CompactionContext` carries
 * no tool schema and the summary request does not need it.
 */
export function toBedrockConverseMessages(
  messages: readonly Message[],
): BedrockConverseMapping {
  const converted: BedrockConverseMessage[] = []
  let skippedBlocks = 0
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
          const resultText = textOf(block.content)
          push(role, {
            toolResult: {
              toolUseId: String(block.tool_use_id ?? ''),
              content: [
                {
                  text:
                    resultText.trim().length > 0
                      ? resultText
                      : BEDROCK_EMPTY_TOOL_RESULT_TEXT,
                },
              ],
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
          // Unknown block types (document, web_search_tool_result, …) have no
          // Converse equivalent. Drop the block and keep the rest — a summary
          // of an older prefix need not include every provider-private
          // artefact.
          skippedBlocks++
          break
      }
    }
  }
  if (converted.length === 0) {
    return { messages: [], unsupported: BEDROCK_COMPACTION_EMPTY_REASON }
  }
  return skippedBlocks > 0
    ? { messages: converted, skippedBlocks }
    : { messages: converted }
}

export function buildBedrockConverseCompactionSideRequest(
  request: RemoteLaneRequest,
  options: { maxTokens?: number; messages?: readonly Message[] } = {},
): BedrockConverseCompactionSideRequest | undefined {
  // Summarize the cut prefix, never the full live history. Direct callers
  // without a precomputed cut fall back to the same boundary the method uses.
  const messages =
    options.messages ?? request.cut?.messages ?? request.ctx.messages
  const converted = toBedrockConverseMessages(messages)
  if (converted.unsupported) return undefined
  const instructions = request.instructions.trim()
  return {
    modelId: request.ctx.model,
    body: {
      // Converse has no `compaction.instructions` field; the equivalent is a
      // system prompt that explicitly asks for a summary. Without it the model
      // merely continues the conversation and the text is not a summary.
      ...(instructions.length > 0 ? { system: [{ text: instructions }] } : {}),
      messages: converted.messages,
      inferenceConfig: {
        maxTokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
      },
    },
    contentType: 'application/json',
    accept: 'application/json',
    ...(converted.skippedBlocks !== undefined
      ? { skippedBlocks: converted.skippedBlocks }
      : {}),
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

  // Serialize the summarized prefix only, matching the Anthropic lane. The
  // method computes the cut once before dispatch; a direct lane call falls
  // back to computing it here so the request never regresses to full history.
  const cut = request.cut ?? computeRemoteCut(request.ctx)
  if (cut.messages.length === 0) {
    return { skipped: BEDROCK_COMPACTION_EMPTY_REASON }
  }
  const built = buildBedrockConverseCompactionSideRequest(request, {
    messages: cut.messages,
  })
  if (!built) {
    const mapped = toBedrockConverseMessages(cut.messages)
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
    const stopReason = recordOf(payload)?.stopReason
    // A truncated (`max_tokens`) or filtered (`content_filtered`,
    // `guardrail_intervened`) generation is not a usable summary, even if the
    // returned text is non-empty: degrade to the next method instead.
    if (
      typeof stopReason === 'string' &&
      !SUCCESSFUL_STOP_REASONS.has(stopReason)
    ) {
      throw new Error(
        `Bedrock Converse compaction stopped with reason "${stopReason}"`,
      )
    }
    const summary = extractBedrockConverseSummary(payload)
    if (!summary) {
      throw new Error('Bedrock Converse compaction returned no summary')
    }
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
      ...(built.skippedBlocks !== undefined
        ? {
            warning: `bedrock-skipped-unsupported-blocks:${built.skippedBlocks}`,
          }
        : {}),
    }
  } finally {
    if (timer) clearTimeout(timer)
    request.signal?.removeEventListener('abort', onAbort)
  }
}
