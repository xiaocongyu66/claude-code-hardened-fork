#!/usr/bin/env bun
/**
 * Minimal local stand-in for the Anthropic Messages API.
 *
 * The TUI engine (`cli --print --input-format stream-json ...`) is exercised
 * end-to-end by `tests/integration/tui-engine-e2e.test.ts`. That test must not
 * touch the real API, so this server answers `POST /v1/messages` with the
 * smallest SSE stream the SDK accepts:
 *
 *   message_start → content_block_start → text_delta… → content_block_stop
 *   → message_delta (end_turn) → message_stop
 *
 * The request body is read (to echo the model and to drain the socket) but its
 * contents are otherwise ignored.
 *
 * As a standalone process it listens on a random port, prints `READY <port>`
 * on stdout, and exits on SIGTERM/SIGINT. The test imports
 * `startMockAnthropicServer()` and runs it in-process instead, so both the
 * script contract and the reusable helper are covered.
 *
 *   bun scripts/mock-anthropic-server.ts
 *   # READY 43123
 *   curl -sN -X POST http://127.0.0.1:43123/v1/messages -d '{}'
 */
import type { Server } from 'bun'

export const DEFAULT_MOCK_TEXT = 'Hello from the mock Anthropic server.'

const DEFAULT_MODEL = 'claude-sonnet-4-5'

export type MockAnthropicServer = {
  readonly port: number
  readonly text: string
  stop(): void
}

type StartOptions = {
  text?: string
  hostname?: string
}

/** Format one SSE frame. The Anthropic SDK reads `event:` + `data:` pairs. */
function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

function buildStream(model: string, text: string): string {
  // Split the reply in two so the client observes more than one delta.
  const midpoint = Math.max(1, Math.floor(text.length / 2))
  const chunks = [text.slice(0, midpoint), text.slice(midpoint)].filter(
    chunk => chunk.length > 0,
  )
  const outputTokens = Math.max(1, Math.ceil(text.length / 4))
  const messageId = `msg_mock_${crypto.randomUUID().replaceAll('-', '')}`

  const events = [
    sse('message_start', {
      type: 'message_start',
      message: {
        id: messageId,
        type: 'message',
        role: 'assistant',
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: 12,
          output_tokens: 1,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
    }),
    sse('content_block_start', {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    }),
    ...chunks.map(chunk =>
      sse('content_block_delta', {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: chunk },
      }),
    ),
    sse('content_block_stop', { type: 'content_block_stop', index: 0 }),
    sse('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: outputTokens },
    }),
    sse('message_stop', { type: 'message_stop' }),
  ]
  return events.join('')
}

export function startMockAnthropicServer(
  options: StartOptions = {},
): MockAnthropicServer {
  const text = options.text ?? DEFAULT_MOCK_TEXT
  const server: Server = Bun.serve({
    hostname: options.hostname ?? '127.0.0.1',
    // 0 lets the OS pick a free port; the test reads it back from `port`.
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      if (request.method !== 'POST' || url.pathname !== '/v1/messages') {
        return new Response('Not Found', { status: 404 })
      }

      // Drain the body. Echo the requested model when present so clients that
      // compare message_start.message.model with the request stay happy.
      let model = DEFAULT_MODEL
      try {
        const body = (await request.json()) as { model?: unknown }
        if (typeof body?.model === 'string') {
          model = body.model
        }
      } catch {
        // Non-JSON body: still return a valid message.
      }

      const encoder = new TextEncoder()
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(buildStream(model, text)))
          controller.close()
        },
      })
      return new Response(body, {
        headers: {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache',
          'x-request-id': `req_mock_${crypto.randomUUID()}`,
        },
      })
    },
  })

  if (server.port === undefined) {
    throw new Error('mock server did not bind to a TCP port')
  }

  return {
    port: server.port,
    text,
    stop() {
      server.stop(true)
    },
  }
}

if (import.meta.main) {
  const server = startMockAnthropicServer({
    text: process.env.MOCK_ANTHROPIC_TEXT,
  })
  console.log(`READY ${server.port}`)

  const shutdown = () => {
    server.stop()
    process.exit(0)
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
}
