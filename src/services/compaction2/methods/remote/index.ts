// Ported from oh-my-pi (MIT). See THIRD_PARTY_NOTICES.md in this directory.
import { randomUUID } from 'crypto'
import type { Message, SystemMessage } from '../../../../types/message.js'
import type { APIProvider } from '../../../../utils/model/providerClassification.js'
import type {
  CompactionContext,
  CompactionMethod,
  CompactionOutcome,
  CutPoint,
} from '../../contracts.js'
import { estimateMessageTokens as estimatePruneMessageTokens } from '../../reducers/prune.js'
import { estimateTokens } from '../../tokens/index.js'
import {
  isAnthropicCompactionLaneAvailable,
  runAnthropicCompactionLane,
} from './anthropic.js'
import {
  isBedrockCompactionLaneAvailable,
  runBedrockCompactionLane,
} from './bedrock.js'
import {
  isOpenAiCompactionLaneAvailable,
  runOpenAiCompactionLane,
} from './openai.js'

/**
 * Provider-native server compaction.
 *
 * W5 wires the three lanes the reference implementation exposes:
 *
 * - `anthropic`: on-demand `compact-2026-09-04` beta (`compaction:
 *   { type: "summarize", instructions }`), firstParty/Vertex only.
 * - `openai`: Responses `/responses/compact` (V1) and streaming
 *   `compaction_trigger` (V2).
 * - `bedrock`: Converse side request through the shared Bedrock Runtime
 *   client, additionally gated by `CCH_BEDROCK_COMPACTION=1`.
 *
 * Availability is deliberately conservative: the feature is off unless
 * `CCH_REMOTE_COMPACTION=1`, and an unknown gateway is never available.
 */

export const REMOTE_COMPACTION_ENV = 'CCH_REMOTE_COMPACTION'

export const DEFAULT_REMOTE_COMPACTION_INSTRUCTIONS =
  'Summarize the conversation so far. Preserve decisions, open tasks, ' +
  'file paths, commands, and any constraints the user stated. Return only ' +
  'the summary.'

export type RemoteFetch = (
  input: string,
  init: {
    method?: string
    headers?: Record<string, string>
    body?: string
    signal?: AbortSignal
  },
) => Promise<Response>

export interface RemoteLaneTransport {
  fetch?: RemoteFetch
  apiKey?: string
  baseUrl?: string
  model: string
}

export interface RemoteLaneRequest {
  ctx: CompactionContext
  instructions: string
  signal?: AbortSignal
  provider?: APIProvider
  env: Record<string, string | undefined>
  transport: RemoteLaneTransport
  /**
   * Cut computed once by the method before dispatch. Lanes that summarize a
   * prefix (Anthropic) must send `cut.messages` and must not recompute the
   * boundary after the request.
   */
  cut?: RemoteCut
  options?: {
    /** OpenAI lane request shape. `auto` tries V2 then falls back to V1. */
    openAiVersion?: 'v1' | 'v2' | 'auto'
  }
}

export interface RemoteLaneSuccess {
  summary: string
  preserveData?: Record<string, unknown>
  warning?: string
}

export interface RemoteLaneSkip {
  skipped: string
}

export type RemoteLaneResult = RemoteLaneSuccess | RemoteLaneSkip

export type RemoteLane = (
  request: RemoteLaneRequest,
) => Promise<RemoteLaneResult>

export interface RemoteMethodDeps {
  /** Environment override; defaults to `process.env`. */
  env?: Record<string, string | undefined>
  /** Injected transport. Production supplies a fetch bound to the provider. */
  fetch?: RemoteFetch
  apiKey?: string
  baseUrl?: string
  provider?: APIProvider
  openAiVersion?: 'v1' | 'v2' | 'auto'
  instructions?: string
  resolveProvider?(ctx: CompactionContext): APIProvider | undefined
  resolveBaseUrl?(ctx: CompactionContext): string | undefined
  resolveApiKey?(ctx: CompactionContext): string | undefined
  /** Test/embedder override, evaluated before the built-in gates. */
  isAvailable?(ctx: CompactionContext): boolean
  /** Test/embedder override that replaces the whole lane dispatch. */
  run?(ctx: CompactionContext): Promise<CompactionOutcome>
}

interface ResolvedRemote {
  provider: APIProvider | undefined
  lane: RemoteLane | undefined
  baseUrl: string | undefined
  apiKey: string | undefined
}

function readEnv(
  deps: RemoteMethodDeps | null | undefined,
): Record<string, string | undefined> {
  return deps?.env ?? process.env
}

/** Remote compaction is opt-in; `1` is the only enabling value. */
export function isRemoteCompactionEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env[REMOTE_COMPACTION_ENV] === '1'
}

function defaultProvider(): APIProvider | undefined {
  try {
    const module = require('../../../../utils/model/providers.js') as {
      getAPIProvider(): APIProvider
    }
    return module.getAPIProvider()
  } catch {
    return undefined
  }
}

function defaultBaseUrl(
  provider: APIProvider | undefined,
  env: Record<string, string | undefined>,
): string | undefined {
  if (provider === 'openai') return env.OPENAI_BASE_URL
  if (provider === 'firstParty' || provider === 'vertex') {
    return env.ANTHROPIC_BASE_URL
  }
  if (provider === 'bedrock') {
    const override = env.ANTHROPIC_BEDROCK_BASE_URL
    if (override) return override
    const region = env.AWS_REGION?.trim() || env.AWS_DEFAULT_REGION?.trim()
    return region
      ? `https://bedrock-runtime.${region}.amazonaws.com`
      : undefined
  }
  return undefined
}

function resolveRemote(
  ctx: CompactionContext,
  deps: RemoteMethodDeps | null | undefined,
): ResolvedRemote {
  const env = readEnv(deps)
  const provider =
    deps?.provider ?? deps?.resolveProvider?.(ctx) ?? defaultProvider()
  const baseUrl =
    deps?.baseUrl ??
    deps?.resolveBaseUrl?.(ctx) ??
    defaultBaseUrl(provider, env)
  const apiKey =
    deps?.apiKey ??
    deps?.resolveApiKey?.(ctx) ??
    (provider === 'openai'
      ? env.OPENAI_API_KEY
      : provider === 'firstParty' || provider === 'vertex'
        ? env.ANTHROPIC_API_KEY
        : undefined)

  let lane: RemoteLane | undefined
  if (provider === 'openai') {
    if (
      isOpenAiCompactionLaneAvailable({
        model: ctx.model,
        baseUrl,
        apiKey,
      })
    ) {
      lane = runOpenAiCompactionLane
    }
  } else if (provider === 'firstParty' || provider === 'vertex') {
    if (
      isAnthropicCompactionLaneAvailable({
        provider,
        model: ctx.model,
        baseUrl,
        env,
      })
    ) {
      lane = runAnthropicCompactionLane
    }
  } else if (provider === 'bedrock') {
    if (
      isBedrockCompactionLaneAvailable({
        model: ctx.model,
        region: env.AWS_REGION ?? env.AWS_DEFAULT_REGION,
        env,
      })
    ) {
      lane = runBedrockCompactionLane
    }
  }

  return { provider, lane, baseUrl, apiKey }
}

export function isRemoteMethodAvailable(
  ctx: CompactionContext,
  deps?: RemoteMethodDeps | null,
): boolean {
  const env = readEnv(deps)
  if (!isRemoteCompactionEnabled(env)) return false
  if (deps?.isAvailable) return deps.isAvailable(ctx)
  return resolveRemote(ctx, deps).lane !== undefined
}

/** A computed remote boundary: the summarized prefix and the retained tail. */
export interface RemoteCut {
  /** Leading messages the remote summary replaces and the request carries. */
  messages: Message[]
  /** Length of `messages`; equivalent to `ctx.messages.slice(0, index)`. */
  index: number
  cutPoint: CutPoint
  kept: Message[]
  tokensAfter: number
}

/**
 * The cut point a remote summary replaces: keep the newest
 * `settings.keepRecentTokens` intact, never splitting a tool result from its
 * assistant tool call.
 *
 * Token counts come from the reducers' `estimateMessageTokens` with the
 * model's tokenizer (`estimateTokens`), not `JSON.stringify().length / 4`:
 * the latter underestimates CJK by roughly 2-3x, which would keep far more
 * context than requested.
 */
export function computeRemoteCut(ctx: CompactionContext): RemoteCut {
  const messages = ctx.messages
  const keepRecent = Math.max(0, ctx.settings.keepRecentTokens)
  const countText = (text: string): number =>
    estimateTokens(text, ctx.model).tokens
  let index = messages.length
  if (keepRecent > 0) {
    let accumulated = 0
    for (let i = messages.length - 1; i >= 0; i--) {
      const tokens = estimatePruneMessageTokens(messages[i], countText)
      if (accumulated > 0 && accumulated + tokens > keepRecent) break
      accumulated += tokens
      index = i
    }
  }
  // A kept tool_result without its assistant tool_use would make the kept tail
  // unrenderable; pull the cut back until the tail starts before the call.
  while (
    index > 0 &&
    index < messages.length &&
    isToolResultMessage(messages[index])
  ) {
    index--
  }

  const kept = messages.slice(index)
  const tokensBefore = ctx.tokenCount(messages)
  const tokensAfter =
    kept.length === 0
      ? 0
      : Math.min(tokensBefore, Math.max(0, ctx.tokenCount(kept)))
  const firstKept = messages[index] as { uuid?: string } | undefined
  const cutPoint: CutPoint = {
    firstKeptEntryId: firstKept?.uuid ?? '',
    tokensBefore,
    boundaryMessage: createRemoteBoundary(ctx, tokensBefore),
  }
  return {
    messages: messages.slice(0, index),
    index,
    cutPoint,
    kept,
    tokensAfter,
  }
}

function createRemoteBoundary(
  ctx: CompactionContext,
  preTokens: number,
): SystemMessage {
  const boundary = {
    type: 'system',
    subtype: 'compact_boundary',
    content: 'Conversation compacted',
    isMeta: false,
    timestamp: new Date(ctx.now()).toISOString(),
    uuid: randomUUID(),
    level: 'info',
    compactMetadata: {
      trigger: ctx.trigger === 'manual' ? 'manual' : 'auto',
      preTokens,
      remote: true,
    },
  }
  return boundary as unknown as SystemMessage
}

function isToolResultMessage(message: Message | undefined): boolean {
  if (!message || message.type !== 'user') return false
  const content = message.message?.content
  if (!Array.isArray(content)) return false
  return content.some(block => {
    if (!block || typeof block !== 'object') return false
    return (block as unknown as Record<string, unknown>).type === 'tool_result'
  })
}

export function createRemoteMethod(
  deps?: RemoteMethodDeps | null,
): CompactionMethod {
  return {
    name: 'remote',
    isAvailable: ctx => isRemoteMethodAvailable(ctx, deps),
    run: async (ctx: CompactionContext): Promise<CompactionOutcome> => {
      if (deps?.run) return deps.run(ctx)

      if (!isRemoteCompactionEnabled(readEnv(deps))) {
        return {
          kind: 'skipped',
          method: 'remote',
          reason: 'remote-disabled',
        }
      }

      const resolved = resolveRemote(ctx, deps)
      if (!resolved.lane) {
        return {
          kind: 'skipped',
          method: 'remote',
          reason: 'remote-lane-unavailable',
        }
      }
      if (!deps?.fetch) {
        return {
          kind: 'skipped',
          method: 'remote',
          reason: 'remote-transport-missing',
        }
      }

      try {
        // Compute the boundary once, before the request: the lane serializes
        // only this prefix and the outcome reuses the same cut point.
        const cut = computeRemoteCut(ctx)
        const result = await resolved.lane({
          ctx,
          cut,
          instructions:
            deps?.instructions ?? DEFAULT_REMOTE_COMPACTION_INSTRUCTIONS,
          signal: ctx.abortSignal,
          provider: resolved.provider,
          env: readEnv(deps),
          transport: {
            fetch: deps.fetch,
            apiKey: resolved.apiKey,
            baseUrl: resolved.baseUrl,
            model: ctx.model,
          },
          options: { openAiVersion: deps?.openAiVersion },
        })
        if ('skipped' in result) {
          return {
            kind: 'skipped',
            method: 'remote',
            reason: result.skipped,
          }
        }
        const { cutPoint, tokensAfter } = cut
        const threshold = ctx.settings.thresholdTokens ?? 0
        return {
          kind: 'compacted',
          method: 'remote',
          cutPoint,
          tokensSaved: Math.max(0, cutPoint.tokensBefore - tokensAfter),
          headroomTokens: threshold > 0 ? threshold - tokensAfter : 0,
          summary: result.summary,
          preserveData: result.preserveData,
          warning: result.warning,
        }
      } catch (error) {
        return {
          kind: 'failed',
          method: 'remote',
          reason: error instanceof Error ? error.message : String(error),
          error,
        }
      }
    },
  }
}

export const remoteMethod = createRemoteMethod()
