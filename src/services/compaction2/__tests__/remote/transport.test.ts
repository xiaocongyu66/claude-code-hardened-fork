import { describe, expect, test } from 'bun:test'
import type { RemoteFetch } from '../../methods/remote/index.js'
import {
  buildRemoteAuthHeaders,
  buildRemoteTransport,
  normalizeRemoteBaseUrl,
} from '../../methods/remote/transport.js'

interface CapturedCall {
  url: string
  init: {
    method?: string
    headers?: Record<string, string>
    body?: string
    signal?: AbortSignal
  }
}

function captureFetch(): { fetch: RemoteFetch; calls: CapturedCall[] } {
  const calls: CapturedCall[] = []
  return {
    calls,
    fetch: async (url, init) => {
      calls.push({ url, init })
      return new Response('{}', { status: 200 })
    },
  }
}

function header(
  headers: Record<string, string> | undefined,
  name: string,
): string | undefined {
  if (!headers) return undefined
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name.toLowerCase()) return value
  }
  return undefined
}

describe('buildRemoteAuthHeaders', () => {
  test('firstParty prefers x-api-key and adds version + beta', () => {
    const headers = buildRemoteAuthHeaders({
      provider: 'firstParty',
      apiKey: 'sk-ant-secret',
    })
    expect(header(headers, 'x-api-key')).toBe('sk-ant-secret')
    expect(header(headers, 'authorization')).toBeUndefined()
    expect(header(headers, 'anthropic-version')).toBe('2023-06-01')
    expect(header(headers, 'anthropic-beta')).toContain('compact-2026-09-04')
  })

  test('firstParty falls back to OAuth authorization', () => {
    const headers = buildRemoteAuthHeaders({
      provider: 'firstParty',
      oauthToken: 'oauth-secret',
    })
    expect(header(headers, 'authorization')).toBe('Bearer oauth-secret')
    expect(header(headers, 'x-api-key')).toBeUndefined()
  })

  test('returns undefined without credentials', () => {
    expect(buildRemoteAuthHeaders({ provider: 'firstParty' })).toBeUndefined()
    expect(buildRemoteAuthHeaders({ provider: 'openai' })).toBeUndefined()
    expect(
      buildRemoteAuthHeaders({ provider: 'vertex', bearerToken: undefined }),
    ).toBeUndefined()
  })

  test('vertex uses a bearer token only', () => {
    const headers = buildRemoteAuthHeaders({
      provider: 'vertex',
      bearerToken: 'gcp-token',
    })
    expect(header(headers, 'authorization')).toBe('Bearer gcp-token')
    expect(header(headers, 'x-api-key')).toBeUndefined()
    expect(header(headers, 'anthropic-version')).toBeUndefined()
  })
})

describe('normalizeRemoteBaseUrl', () => {
  test('trims whitespace and trailing slashes', () => {
    expect(normalizeRemoteBaseUrl(' https://api.openai.com/v1/ ')).toBe(
      'https://api.openai.com/v1',
    )
    expect(normalizeRemoteBaseUrl(undefined, 'https://x.test/v1/')).toBe(
      'https://x.test/v1',
    )
    expect(normalizeRemoteBaseUrl(undefined)).toBeUndefined()
  })
})

describe('buildRemoteTransport provider branches', () => {
  test('firstParty injects auth headers into the lane request', async () => {
    const { fetch, calls } = captureFetch()
    const transport = buildRemoteTransport({
      provider: 'firstParty',
      env: {},
      fetch,
      getAnthropicApiKey: () => 'sk-ant-secret',
      getOAuthToken: () => undefined,
    })
    expect(transport).toBeDefined()
    expect(transport?.apiKey).toBe('sk-ant-secret')

    await transport?.fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    })

    expect(calls).toHaveLength(1)
    const sent = calls[0]
    expect(sent?.url).not.toContain('sk-ant-secret')
    expect(header(sent?.init.headers, 'x-api-key')).toBe('sk-ant-secret')
    expect(header(sent?.init.headers, 'anthropic-version')).toBe('2023-06-01')
    expect(header(sent?.init.headers, 'anthropic-beta')).toContain(
      'compact-2026-09-04',
    )
    expect(header(sent?.init.headers, 'authorization')).toBeUndefined()
    // Lane-provided headers survive the merge.
    expect(header(sent?.init.headers, 'content-type')).toBe('application/json')
  })

  test('firstParty uses OAuth when no API key is available', async () => {
    const { fetch, calls } = captureFetch()
    const transport = buildRemoteTransport({
      provider: 'firstParty',
      env: {},
      fetch,
      getAnthropicApiKey: () => null,
      getOAuthToken: () => 'oauth-secret',
    })
    expect(transport).toBeDefined()
    expect(transport?.apiKey).toBeUndefined()

    await transport?.fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
    })
    expect(header(calls[0]?.init.headers, 'authorization')).toBe(
      'Bearer oauth-secret',
    )
    expect(header(calls[0]?.init.headers, 'x-api-key')).toBeUndefined()
  })

  test('firstParty without any credential returns undefined', () => {
    expect(
      buildRemoteTransport({
        provider: 'firstParty',
        env: {},
        fetch: captureFetch().fetch,
        getAnthropicApiKey: () => null,
        getOAuthToken: () => null,
      }),
    ).toBeUndefined()
  })

  test('openai normalizes the base URL and sends a bearer token', async () => {
    const { fetch, calls } = captureFetch()
    const transport = buildRemoteTransport({
      provider: 'openai',
      baseUrl: ' https://api.openai.com/v1/ ',
      env: {},
      fetch,
      getOpenAiApiKey: () => 'sk-openai-secret',
    })
    expect(transport?.baseUrl).toBe('https://api.openai.com/v1')
    expect(transport?.apiKey).toBe('sk-openai-secret')

    await transport?.fetch('https://api.openai.com/v1/responses/compact', {
      method: 'POST',
    })
    expect(header(calls[0]?.init.headers, 'authorization')).toBe(
      'Bearer sk-openai-secret',
    )
    expect(calls[0]?.url).not.toContain('sk-openai-secret')
  })

  test('openai defaults the base URL to the official endpoint', () => {
    const transport = buildRemoteTransport({
      provider: 'openai',
      env: {},
      fetch: captureFetch().fetch,
      getOpenAiApiKey: () => 'k',
    })
    expect(transport?.baseUrl).toBe('https://api.openai.com/v1')
  })

  test('openai without a key returns undefined', () => {
    expect(
      buildRemoteTransport({
        provider: 'openai',
        env: {},
        fetch: captureFetch().fetch,
        getOpenAiApiKey: () => null,
      }),
    ).toBeUndefined()
  })

  test('vertex resolves rawPredict and a fresh bearer token', async () => {
    const { fetch, calls } = captureFetch()
    let tokenCalls = 0
    const transport = buildRemoteTransport({
      provider: 'vertex',
      model: 'claude-opus-4-6',
      env: {
        ANTHROPIC_VERTEX_PROJECT_ID: 'proj',
        CLOUD_ML_REGION: 'us-east5',
      },
      fetch,
      getGoogleAccessToken: async () => {
        tokenCalls++
        return 'gcp-token'
      },
    })
    expect(transport).toBeDefined()
    expect(transport?.baseUrl).toContain(
      '/projects/proj/locations/us-east5/publishers/anthropic/models/',
    )
    expect(transport?.baseUrl).toContain(':rawPredict')

    await transport?.fetch(transport?.baseUrl ?? '', { method: 'POST' })
    expect(tokenCalls).toBe(1)
    expect(header(calls[0]?.init.headers, 'authorization')).toBe(
      'Bearer gcp-token',
    )
    expect(header(calls[0]?.init.headers, 'x-api-key')).toBeUndefined()
  })

  test('bedrock and unknown providers return undefined', () => {
    for (const provider of ['bedrock', 'foundry', 'gemini', 'grok'] as const) {
      expect(
        buildRemoteTransport({
          provider,
          env: { AWS_REGION: 'us-east-1' },
          fetch: captureFetch().fetch,
        }),
      ).toBeUndefined()
    }
  })
})
