// Provider-bound transport for remote compaction lanes.
//
// The lanes only know how to shape a request; this module supplies the
// provider-specific base URL and auth headers. Credentials are read lazily
// (per request) and are never logged. Nothing here changes behavior unless a
// caller explicitly injects the resulting `fetch`.
import type { APIProvider } from '../../../../utils/model/providerClassification.js'
import { ANTHROPIC_COMPACTION_BETA } from './anthropic.js'
import { resolveAnthropicMessagesEndpoint } from './anthropic.js'
import type { RemoteFetch } from './index.js'

/** Auth headers a lane may rely on; values are secret and must never be logged. */
export interface RemoteAuthHeaderInput {
  provider: APIProvider
  /** Anthropic API key (firstParty). */
  apiKey?: string
  /** Claude.ai OAuth access token (firstParty fallback). */
  oauthToken?: string
  /** Google Cloud access token (vertex). */
  bearerToken?: string
}

/**
 * Build the provider's auth headers. Returns `undefined` when the provider is
 * unsupported or no usable credential is available.
 */
export function buildRemoteAuthHeaders(
  input: RemoteAuthHeaderInput,
): Record<string, string> | undefined {
  if (input.provider === 'firstParty') {
    if (!input.apiKey && !input.oauthToken) return undefined
    return {
      'anthropic-version': '2023-06-01',
      'anthropic-beta': ANTHROPIC_COMPACTION_BETA,
      ...(input.apiKey
        ? { 'x-api-key': input.apiKey }
        : { authorization: `Bearer ${input.oauthToken}` }),
    }
  }
  if (input.provider === 'openai') {
    if (!input.apiKey) return undefined
    return { authorization: `Bearer ${input.apiKey}` }
  }
  if (input.provider === 'vertex') {
    if (input.bearerToken === undefined) return undefined
    return input.bearerToken
      ? { authorization: `Bearer ${input.bearerToken}` }
      : {}
  }
  return undefined
}

/** Trim whitespace and trailing slashes from a caller-supplied base URL. */
export function normalizeRemoteBaseUrl(
  baseUrl: string | undefined,
  fallback?: string,
): string | undefined {
  const raw = baseUrl?.trim() ? baseUrl.trim() : fallback
  if (!raw) return undefined
  return raw.replace(/\/+$/, '')
}

export interface BuiltRemoteTransport {
  fetch: RemoteFetch
  /** Anthropic API key, when one is available (firstParty). */
  apiKey?: string
  /** Normalized provider base URL. */
  baseUrl?: string
}

/**
 * Minimal Converse runtime surface used by the Bedrock transport. The
 * production adapter wraps `BedrockRuntimeClient` + `ConverseCommand`; tests
 * inject a plain object. Keeping this narrow avoids leaking AWS SDK types into
 * the compaction layer.
 */
export interface BedrockConverseInput {
  modelId: string
  messages?: unknown[]
  inferenceConfig?: Record<string, unknown>
  [key: string]: unknown
}

export interface BedrockConverseRuntime {
  sendConverse(
    input: BedrockConverseInput,
    options?: { abortSignal?: AbortSignal },
  ): Promise<unknown>
}

export interface BuildRemoteTransportInput {
  provider: APIProvider
  model?: string
  baseUrl?: string
  env?: Record<string, string | undefined>
  /** Underlying fetch; defaults to the runtime global. Tests inject a mock. */
  fetch?: RemoteFetch
  getAnthropicApiKey?: () => string | null | undefined
  getOAuthToken?: () => string | null | undefined
  getOpenAiApiKey?: () => string | null | undefined
  getGoogleAccessToken?: () => Promise<string | undefined>
  /**
   * Existing Bedrock Converse runtime (production: the shared
   * `createBedrockRuntimeClient()`; tests: a stub). When this property is
   * present it is authoritative: a missing runtime disables the transport
   * instead of falling back to the SDK, which keeps tests deterministic.
   */
  getBedrockConverseRuntime?: () =>
    | Promise<BedrockConverseRuntime | undefined>
    | BedrockConverseRuntime
    | undefined
}

function defaultAnthropicApiKey(): string | undefined {
  try {
    const { getAnthropicApiKey } = require('../../../../utils/auth.js') as {
      getAnthropicApiKey(): string | null
    }
    return getAnthropicApiKey() ?? undefined
  } catch {
    return undefined
  }
}

function defaultOAuthToken(): string | undefined {
  try {
    const { getClaudeAIOAuthTokens } = require('../../../../utils/auth.js') as {
      getClaudeAIOAuthTokens(): { accessToken?: string } | null
    }
    return getClaudeAIOAuthTokens()?.accessToken
  } catch {
    return undefined
  }
}

/**
 * Resolve a Google Cloud access token through the same ADC chain the Vertex
 * SDK uses. The empty string mirrors `CLAUDE_CODE_SKIP_VERTEX_AUTH` (proxy
 * mode) without adding an Authorization header.
 */
function isTruthy(value: string | undefined): boolean {
  if (!value) return false
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase().trim())
}

async function defaultGoogleAccessToken(): Promise<string | undefined> {
  if (isTruthy(process.env.CLAUDE_CODE_SKIP_VERTEX_AUTH)) return ''
  const { GoogleAuth } = await import('google-auth-library')
  const auth = new GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/cloud-platform'],
  })
  const client = await auth.getClient()
  const token = await client.getAccessToken()
  return token?.token ?? undefined
}

/** Case-insensitive merge; transport auth headers win over lane headers. */
function mergeHeaders(
  base: Record<string, string> | undefined,
  extra: Record<string, string>,
): Record<string, string> {
  const merged: Record<string, string> = { ...(base ?? {}) }
  for (const [name, value] of Object.entries(extra)) {
    const existing = Object.keys(merged).find(
      key => key.toLowerCase() === name.toLowerCase(),
    )
    if (existing !== undefined) delete merged[existing]
    merged[name] = value
  }
  return merged
}

function createAuthorizedFetch(
  baseFetch: RemoteFetch,
  resolveHeaders: () => Promise<Record<string, string> | undefined>,
): RemoteFetch {
  return async (input, init) => {
    const headers = await resolveHeaders()
    if (!headers) return baseFetch(input, init)
    return baseFetch(input, {
      ...init,
      headers: mergeHeaders(init.headers, headers),
    })
  }
}

/**
 * The runtime SDK ships as a normal dependency; `require.resolve` only tells
 * us whether a real client factory is reachable. Credentials are resolved
 * lazily inside `createBedrockRuntimeClient` (env, settings refresh, bearer
 * token, or the AWS default chain) and are never logged here.
 */
function isBedrockRuntimeSdkAvailable(): boolean {
  try {
    if (typeof Bun !== 'undefined') {
      Bun.resolveSync('@aws-sdk/client-bedrock-runtime', import.meta.dir)
      return true
    }
    require.resolve('@aws-sdk/client-bedrock-runtime')
    return true
  } catch {
    return false
  }
}

async function defaultBedrockConverseRuntime(): Promise<BedrockConverseRuntime> {
  const [{ createBedrockRuntimeClient }, sdk] = await Promise.all([
    import('../../../../utils/model/bedrock.js'),
    import('@aws-sdk/client-bedrock-runtime'),
  ])
  const client = (await createBedrockRuntimeClient()) as unknown as {
    send(
      command: unknown,
      options?: { abortSignal?: AbortSignal },
    ): Promise<unknown>
  }
  const ConverseCommand = sdk.ConverseCommand as unknown as new (
    input: Record<string, unknown>,
  ) => unknown
  return {
    sendConverse: async (input, options) => {
      const { modelId, ...rest } = input
      return client.send(new ConverseCommand({ modelId, ...rest }), options)
    },
  }
}

/** Extract the model id from a Converse URL of the form `/model/<id>/converse`. */
function modelIdFromConverseUrl(url: string): string | undefined {
  const match = /\/(?:model|inference-profile)\/([^/?#]+)\/converse/.exec(url)
  if (!match?.[1]) return undefined
  try {
    return decodeURIComponent(match[1])
  } catch {
    return match[1]
  }
}

function bedrockConverseFetch(
  getRuntime: () => Promise<BedrockConverseRuntime>,
): RemoteFetch {
  let runtimePromise: Promise<BedrockConverseRuntime> | undefined
  const runtime = (): Promise<BedrockConverseRuntime> => {
    runtimePromise ??= getRuntime()
    return runtimePromise
  }
  return async (input, init) => {
    const modelId = modelIdFromConverseUrl(input)
    if (!modelId) {
      throw new Error('Bedrock Converse endpoint is missing a model id')
    }
    const body =
      typeof init.body === 'string' && init.body.length > 0
        ? (JSON.parse(init.body) as Record<string, unknown>)
        : {}
    const output = await (await runtime()).sendConverse(
      { ...body, modelId },
      init.signal ? { abortSignal: init.signal } : undefined,
    )
    return new Response(JSON.stringify(output ?? {}), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
}

function resolveBedrockBaseUrl(input: {
  baseUrl?: string
  env: Record<string, string | undefined>
}): string {
  const explicit = normalizeRemoteBaseUrl(
    input.baseUrl ?? input.env.ANTHROPIC_BEDROCK_BASE_URL,
  )
  if (explicit) return explicit
  const region =
    input.env.AWS_REGION?.trim() ||
    input.env.AWS_DEFAULT_REGION?.trim() ||
    'us-east-1'
  return `https://bedrock-runtime.${region}.amazonaws.com`
}

function resolveVertexBaseUrl(input: {
  model: string
  baseUrl?: string
  env: Record<string, string | undefined>
}): string | undefined {
  const explicit = normalizeRemoteBaseUrl(
    input.baseUrl ?? input.env.ANTHROPIC_BASE_URL,
  )
  if (explicit) return explicit
  // No caller-supplied endpoint: use the canonical rawPredict URL, which the
  // Anthropic lane passes through unchanged.
  return resolveAnthropicMessagesEndpoint({
    provider: 'vertex',
    model: input.model,
    env: input.env,
  })
}

/**
 * Build a provider-bound transport for the remote compaction lanes.
 *
 * Returns `undefined` for providers without a reusable side-request transport
 * (bedrock needs either the Runtime SDK or an injected Converse runtime) or
 * when no credential can be resolved.
 */
export function buildRemoteTransport(
  input: BuildRemoteTransportInput,
): BuiltRemoteTransport | undefined {
  const env = input.env ?? process.env
  const baseFetch = input.fetch ?? (globalThis.fetch as unknown as RemoteFetch)
  if (typeof baseFetch !== 'function') return undefined

  if (input.provider === 'firstParty') {
    // An injected getter is authoritative (tests rely on determinism); only
    // fall through to the real credential chain when none was supplied.
    const apiKey = input.getAnthropicApiKey
      ? (input.getAnthropicApiKey() ?? undefined)
      : (env.ANTHROPIC_API_KEY ?? defaultAnthropicApiKey())
    const oauthToken = input.getOAuthToken
      ? (input.getOAuthToken() ?? undefined)
      : defaultOAuthToken()
    const headers = buildRemoteAuthHeaders({
      provider: 'firstParty',
      apiKey: apiKey ?? undefined,
      oauthToken,
    })
    if (!headers) return undefined
    return {
      fetch: createAuthorizedFetch(baseFetch, async () => headers),
      apiKey: apiKey ?? undefined,
      baseUrl: normalizeRemoteBaseUrl(input.baseUrl ?? env.ANTHROPIC_BASE_URL),
    }
  }

  if (input.provider === 'openai') {
    const apiKey = input.getOpenAiApiKey
      ? (input.getOpenAiApiKey() ?? undefined)
      : env.OPENAI_API_KEY
    if (!apiKey) return undefined
    const headers = buildRemoteAuthHeaders({ provider: 'openai', apiKey })
    if (!headers) return undefined
    return {
      fetch: createAuthorizedFetch(baseFetch, async () => headers),
      apiKey,
      baseUrl: normalizeRemoteBaseUrl(
        input.baseUrl ?? env.OPENAI_BASE_URL,
        'https://api.openai.com/v1',
      ),
    }
  }

  if (input.provider === 'vertex') {
    const model = input.model ?? ''
    const getToken = input.getGoogleAccessToken ?? defaultGoogleAccessToken
    return {
      fetch: createAuthorizedFetch(baseFetch, async () => {
        const bearerToken = await getToken()
        if (bearerToken === undefined) {
          throw new Error('Vertex access token unavailable')
        }
        return buildRemoteAuthHeaders({ provider: 'vertex', bearerToken })
      }),
      baseUrl: resolveVertexBaseUrl({ model, baseUrl: input.baseUrl, env }),
    }
  }

  if (input.provider === 'bedrock') {
    // An injected getter is authoritative; the default path only exists when
    // the Bedrock Runtime SDK is installed. Either way the client/credential
    // resolution happens lazily on first request.
    const injected = input.getBedrockConverseRuntime
    if (!injected && !isBedrockRuntimeSdkAvailable()) return undefined
    return {
      fetch: bedrockConverseFetch(async () => {
        const runtime = injected
          ? await injected()
          : await defaultBedrockConverseRuntime()
        if (!runtime) throw new Error('Bedrock Converse runtime unavailable')
        return runtime
      }),
      baseUrl: resolveBedrockBaseUrl({ baseUrl: input.baseUrl, env }),
    }
  }

  // foundry/gemini/grok: no side transport.
  return undefined
}
