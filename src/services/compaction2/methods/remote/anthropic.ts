import type { Message } from '../../../../types/message.js'
import type { APIProvider } from '../../../../utils/model/providerClassification.js'
import type { RemoteLaneRequest, RemoteLaneResult } from './index.js'

/**
 * Anthropic on-demand compaction (`compact-2026-09-04` beta).
 *
 * The request sends the prefix to summarize with a top-level
 * `compaction: { type: "summarize", instructions }` parameter. The API answers
 * with one signed `compaction` content block; the block (content, signature and
 * optional `tool_changes`) is persisted in `preserveData` so a later turn on a
 * compaction-capable endpoint can replay it verbatim.
 *
 * Header name verified against the reference implementation:
 * `anthropic-beta` (Vertex rawPredict instead carries `anthropic_beta` in the
 * request body).
 */

export const ANTHROPIC_BETA_HEADER = 'anthropic-beta'
export const ANTHROPIC_COMPACTION_BETA = 'compact-2026-09-04'
export const ANTHROPIC_LEGACY_COMPACTION_BETA = 'compact-2026-01-12'
export const ANTHROPIC_COMPACTION_PRESERVE_KEY = 'anthropicCompaction'

const DEFAULT_ANTHROPIC_MAX_TOKENS = 8192

export interface AnthropicCompactionBlock {
  content: string
  signature: string
  toolChanges?: Record<string, unknown>[]
  encryptedContent?: string
}

export interface AnthropicCompactionPreserveData {
  provider: string
  content: string
  signature?: string
  toolChanges?: Record<string, unknown>[]
  encryptedContent?: string
  model?: string
  usedTokens?: number
}

/**
 * Conservative model gate for the beta. The catalog rule is Opus 4.6+,
 * Sonnet 4.6+, and Fable/Mythos 5+. Anything we cannot parse is unsupported.
 */
export function supportsAnthropicServerCompaction(model: string): boolean {
  const id = model.toLowerCase()
  const opusSonnet = /claude-(opus|sonnet)-(\d+)[.-](\d+)/.exec(id)
  if (opusSonnet) {
    const major = Number(opusSonnet[2])
    const minor = Number(opusSonnet[3])
    return major > 4 || (major === 4 && minor >= 6)
  }
  const nextGen = /claude-(fable|mythos)-(\d+)/.exec(id)
  if (nextGen) return Number(nextGen[2]) >= 5
  return false
}

/** Endpoint gate: only the known Anthropic API host counts as first-party. */
export function isKnownAnthropicEndpoint(baseUrl: string | undefined): boolean {
  if (!baseUrl || baseUrl.trim().length === 0) return true
  try {
    const url = new URL(baseUrl)
    return url.hostname === 'api.anthropic.com'
  } catch {
    return false
  }
}

export function resolveAnthropicMessagesEndpoint(input: {
  provider: APIProvider
  baseUrl?: string
  model: string
  env: Record<string, string | undefined>
}): string | undefined {
  const base = input.baseUrl?.replace(/\/+$/, '')
  if (base) {
    if (input.provider === 'vertex') {
      // A caller-supplied Vertex endpoint is already complete.
      if (base.includes(':rawPredict')) return base
      return `${base}/v1/messages`
    }
    return base.endsWith('/v1') ? `${base}/messages` : `${base}/v1/messages`
  }
  if (input.provider === 'firstParty') {
    return 'https://api.anthropic.com/v1/messages'
  }
  if (input.provider === 'vertex') {
    const project = input.env.ANTHROPIC_VERTEX_PROJECT_ID
    const region = input.env.CLOUD_ML_REGION ?? 'us-east5'
    if (!project) return undefined
    const model = input.model.replace(/^.*\//, '')
    return (
      `https://${region}-aiplatform.googleapis.com/v1/projects/${project}` +
      `/locations/${region}/publishers/anthropic/models/${model}:rawPredict`
    )
  }
  return undefined
}

export function isAnthropicCompactionLaneAvailable(input: {
  provider: APIProvider
  model: string
  baseUrl?: string
  env?: Record<string, string | undefined>
}): boolean {
  if (!supportsAnthropicServerCompaction(input.model)) return false
  if (input.provider === 'firstParty') {
    return isKnownAnthropicEndpoint(input.baseUrl)
  }
  if (input.provider === 'vertex') {
    return (
      resolveAnthropicMessagesEndpoint({
        provider: 'vertex',
        baseUrl: input.baseUrl,
        model: input.model,
        env: input.env ?? {},
      }) !== undefined
    )
  }
  return false
}

interface ConvertedAnthropicMessages {
  messages: Array<{ role: 'user' | 'assistant'; content: unknown[] }>
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
      if (record?.type === 'text' && typeof record.text === 'string') {
        return record.text
      }
      return ''
    })
    .join('')
}

/** Convert CCH's Anthropic-shaped messages into a Messages API request body. */
export function toAnthropicMessages(
  messages: readonly Message[],
): ConvertedAnthropicMessages {
  const converted: ConvertedAnthropicMessages['messages'] = []
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
        converted.push({ role, content: [{ type: 'text', text: raw }] })
      }
      continue
    }
    if (!Array.isArray(raw)) continue
    const blocks: unknown[] = []
    for (const item of raw) {
      const block = recordOf(item)
      if (!block) continue
      switch (block.type) {
        case 'text':
          if (typeof block.text === 'string' && block.text.length > 0) {
            blocks.push({ type: 'text', text: block.text })
          }
          break
        case 'image': {
          const source = recordOf(block.source)
          if (source?.type === 'base64') {
            blocks.push({
              type: 'image',
              source: {
                type: 'base64',
                media_type: source.media_type,
                data: source.data,
              },
            })
          }
          break
        }
        case 'tool_use':
          blocks.push({
            type: 'tool_use',
            id: block.id,
            name: block.name,
            input: block.input ?? {},
          })
          break
        case 'tool_result':
          blocks.push({
            type: 'tool_result',
            tool_use_id: block.tool_use_id,
            content: block.content ?? '',
          })
          break
        case 'thinking':
        case 'redacted_thinking':
          // Reasoning is not part of a summary request.
          break
        default:
          // Unknown block types cannot be replayed safely.
          return { messages: [], unsupported: 'anthropic-unsupported-content-block' }
      }
    }
    if (blocks.length > 0) converted.push({ role, content: blocks })
  }
  if (converted.length === 0) {
    return { messages: [], unsupported: 'anthropic-no-summarizable-messages' }
  }
  return { messages: converted }
}

export interface BuildAnthropicCompactionRequestInput {
  model: string
  messages: readonly Message[]
  instructions: string
  maxTokens?: number
  system?: string
  tools?: unknown[]
  stream?: boolean
  /** Vertex rawPredict carries betas in the body, not the header. */
  vertex?: boolean
}

export interface BuiltAnthropicCompactionRequest {
  body: Record<string, unknown>
  unsupported?: string
}

export function buildAnthropicCompactionRequest(
  input: BuildAnthropicCompactionRequestInput,
): BuiltAnthropicCompactionRequest {
  const converted = toAnthropicMessages(input.messages)
  if (converted.unsupported) {
    return { body: {}, unsupported: converted.unsupported }
  }
  const body: Record<string, unknown> = {
    model: input.model,
    max_tokens: input.maxTokens ?? DEFAULT_ANTHROPIC_MAX_TOKENS,
    messages: converted.messages,
    compaction: {
      type: 'summarize',
      instructions: input.instructions,
    },
    stream: input.stream === true,
  }
  if (input.system) body.system = input.system
  if (input.tools && input.tools.length > 0) body.tools = input.tools
  if (input.vertex) body.anthropic_beta = [ANTHROPIC_COMPACTION_BETA]
  return { body }
}

export function buildAnthropicCompactionHeaders(input: {
  apiKey?: string
  vertex?: boolean
  extraBetas?: string[]
}): Record<string, string> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
  }
  if (input.apiKey) headers['x-api-key'] = input.apiKey
  if (!input.vertex) {
    const betas = [ANTHROPIC_COMPACTION_BETA, ...(input.extraBetas ?? [])]
    headers[ANTHROPIC_BETA_HEADER] = betas.join(',')
  }
  return headers
}

function parseCompactionBlock(
  candidate: Record<string, unknown>,
): AnthropicCompactionBlock | undefined {
  if (candidate.type !== 'compaction') return undefined
  if (typeof candidate.content !== 'string' || candidate.content.length === 0) {
    return undefined
  }
  if (typeof candidate.signature !== 'string' || candidate.signature.length === 0) {
    // Legacy `encrypted_content` blocks are replay-only, never a new summary.
    return undefined
  }
  const toolChanges = Array.isArray(candidate.tool_changes)
    ? candidate.tool_changes.filter(
        (item): item is Record<string, unknown> =>
          item !== null && typeof item === 'object',
      )
    : undefined
  return {
    content: candidate.content,
    signature: candidate.signature,
    ...(toolChanges && toolChanges.length > 0 ? { toolChanges } : {}),
    ...(typeof candidate.encrypted_content === 'string'
      ? { encryptedContent: candidate.encrypted_content }
      : {}),
  }
}

/** Extract the signed compaction block from a non-streamed Messages response. */
export function extractAnthropicCompactionBlock(
  payload: unknown,
): AnthropicCompactionBlock | undefined {
  const message = recordOf(payload)
  if (!message) return undefined
  if (message.stop_reason !== undefined && message.stop_reason !== 'compaction') {
    return undefined
  }
  const content = Array.isArray(message.content) ? message.content : []
  for (const item of content) {
    const block = recordOf(item)
    if (!block) continue
    const parsed = parseCompactionBlock(block)
    if (parsed) return parsed
  }
  return undefined
}

/**
 * Extract the signed compaction block from streamed Messages events. The block
 * arrives whole in `content_block_start`; text deltas are appended defensively.
 */
export function parseAnthropicCompactionEvents(
  events: readonly unknown[],
): AnthropicCompactionBlock | undefined {
  let block: AnthropicCompactionBlock | undefined
  let blockIndex: number | undefined
  for (const event of events) {
    const record = recordOf(event)
    if (!record) continue
    if (record.type === 'content_block_start') {
      const candidate = recordOf(record.content_block)
      const parsed = candidate ? parseCompactionBlock(candidate) : undefined
      if (parsed) {
        block = parsed
        blockIndex = typeof record.index === 'number' ? record.index : undefined
      }
      continue
    }
    if (
      record.type === 'content_block_delta' &&
      block &&
      (blockIndex === undefined || record.index === blockIndex)
    ) {
      const delta = recordOf(record.delta)
      if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
        block = { ...block, content: block.content + delta.text }
      }
    }
  }
  return block
}

export function withAnthropicCompactionPreserveData(
  preserveData: Record<string, unknown> | undefined,
  compaction: AnthropicCompactionPreserveData | undefined,
): Record<string, unknown> | undefined {
  if (compaction) {
    return {
      ...preserveData,
      [ANTHROPIC_COMPACTION_PRESERVE_KEY]: compaction,
    }
  }
  if (!preserveData || !(ANTHROPIC_COMPACTION_PRESERVE_KEY in preserveData)) {
    return preserveData
  }
  const { [ANTHROPIC_COMPACTION_PRESERVE_KEY]: _removed, ...rest } = preserveData
  return Object.keys(rest).length > 0 ? rest : undefined
}

export function getPreservedAnthropicCompactionData(
  preserveData: Record<string, unknown> | undefined,
): AnthropicCompactionPreserveData | undefined {
  const candidate = recordOf(preserveData?.[ANTHROPIC_COMPACTION_PRESERVE_KEY])
  if (!candidate) return undefined
  if (typeof candidate.provider !== 'string') return undefined
  if (typeof candidate.content !== 'string' || candidate.content.length === 0) {
    return undefined
  }
  const toolChanges = Array.isArray(candidate.toolChanges)
    ? candidate.toolChanges.filter(
        (item): item is Record<string, unknown> =>
          item !== null && typeof item === 'object',
      )
    : undefined
  return {
    provider: candidate.provider,
    content: candidate.content,
    ...(typeof candidate.signature === 'string'
      ? { signature: candidate.signature }
      : {}),
    ...(typeof candidate.encryptedContent === 'string'
      ? { encryptedContent: candidate.encryptedContent }
      : {}),
    ...(toolChanges ? { toolChanges } : {}),
    ...(typeof candidate.model === 'string' ? { model: candidate.model } : {}),
    ...(typeof candidate.usedTokens === 'number'
      ? { usedTokens: candidate.usedTokens }
      : {}),
  }
}

export async function runAnthropicCompactionLane(
  request: RemoteLaneRequest,
): Promise<RemoteLaneResult> {
  const fetchImpl = request.transport.fetch
  if (!fetchImpl) return { skipped: 'anthropic-transport-missing' }

  const vertex = request.provider === 'vertex'
  const built = buildAnthropicCompactionRequest({
    model: request.ctx.model,
    messages: request.ctx.messages,
    instructions: request.instructions,
    vertex,
  })
  if (built.unsupported) return { skipped: built.unsupported }

  const endpoint = resolveAnthropicMessagesEndpoint({
    provider: vertex ? 'vertex' : 'firstParty',
    baseUrl: request.transport.baseUrl,
    model: request.ctx.model,
    env: request.env,
  })
  if (!endpoint) return { skipped: 'anthropic-endpoint-unresolved' }

  const response = await fetchImpl(endpoint, {
    method: 'POST',
    headers: buildAnthropicCompactionHeaders({
      apiKey: request.transport.apiKey,
      vertex,
    }),
    body: JSON.stringify(built.body),
    signal: request.signal,
  })
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(
      `Anthropic compaction failed (${response.status} ${response.statusText ?? ''})${detail ? `: ${detail.slice(0, 200)}` : ''}`,
    )
  }
  const payload = (await response.json()) as unknown
  const block =
    extractAnthropicCompactionBlock(payload) ??
    (Array.isArray(payload) ? parseAnthropicCompactionEvents(payload) : undefined)
  if (!block) {
    throw new Error('Anthropic compaction returned no signed summary')
  }
  const usage = recordOf(recordOf(payload)?.usage)
  const usedTokens =
    typeof usage?.input_tokens === 'number' ? usage.input_tokens : undefined
  const preserved: AnthropicCompactionPreserveData = {
    provider: vertex ? 'vertex' : 'firstParty',
    content: block.content,
    signature: block.signature,
    ...(block.toolChanges ? { toolChanges: block.toolChanges } : {}),
    ...(block.encryptedContent
      ? { encryptedContent: block.encryptedContent }
      : {}),
    model: request.ctx.model,
    ...(usedTokens !== undefined ? { usedTokens } : {}),
  }
  return {
    summary: block.content,
    preserveData: withAnthropicCompactionPreserveData(undefined, preserved),
  }
}
