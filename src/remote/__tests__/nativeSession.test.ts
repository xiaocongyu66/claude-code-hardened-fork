import { describe, expect, test } from 'bun:test'
import type { SDKMessage } from '../../entrypoints/agentSdkTypes.js'
import type { RemoteMessageContent } from '../../utils/teleport/api.js'
import {
  buildPermissionControlFrame,
  buildPermissionPrompt,
  NativeMessageAdapter,
  NativeSessionBridge,
  permissionDecisionToResponse,
  type SessionPermissionRequest,
  type SessionTransport,
  type SessionTransportCallbacks,
} from '../nativeSession.js'
import type { RemotePermissionResponse } from '../RemoteSessionManager.js'

class FakeTransport implements SessionTransport {
  sent: RemoteMessageContent[] = []
  interrupts = 0
  disconnects = 0
  responses: Array<{
    requestId: string
    response: RemotePermissionResponse
  }> = []
  sendResult = true
  connected = false

  constructor(readonly callbacks: SessionTransportCallbacks) {}

  connect(): void {
    this.connected = true
  }

  async sendMessage(content: RemoteMessageContent): Promise<boolean> {
    this.sent.push(content)
    return this.sendResult
  }

  sendInterrupt(): void {
    this.interrupts += 1
  }

  disconnect(): void {
    this.disconnects += 1
  }

  respondToPermissionRequest(
    requestId: string,
    response: RemotePermissionResponse,
  ): void {
    this.responses.push({ requestId, response })
  }
}

const init = {
  type: 'system',
  subtype: 'init',
  uuid: 'u-init',
  session_id: 's',
} as unknown as SDKMessage

const promptEcho = {
  type: 'user',
  uuid: 'u-echo',
  message: {
    role: 'user',
    content: [{ type: 'text', text: 'hi' }],
  },
} as unknown as SDKMessage

const toolResult = {
  type: 'user',
  uuid: 'u-result',
  message: {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: 'toolu_1' }],
  },
} as unknown as SDKMessage

const result = {
  type: 'result',
  subtype: 'success',
  uuid: 'u-result-end',
} as unknown as SDKMessage

const permissionRequest: SessionPermissionRequest = {
  tool_name: 'Bash',
  tool_use_id: 'toolu_1',
  input: { command: 'ls' },
  description: 'Run ls',
}

function flush(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0))
}

describe('NativeMessageAdapter', () => {
  test('dedupes system/init', () => {
    const adapter = new NativeMessageAdapter({ dedupeInit: true })
    expect(adapter.convert(init).frames).toHaveLength(1)
    expect(adapter.convert(init).frames).toHaveLength(0)
  })

  test('drops prompt echoes but forwards tool results', () => {
    const adapter = new NativeMessageAdapter({
      userFrames: 'tool-results-only',
    })
    expect(adapter.convert(promptEcho).frames).toHaveLength(0)
    expect(adapter.convert(toolResult).frames).toHaveLength(1)
  })

  test('forwards everything when user frames are allowed', () => {
    const adapter = new NativeMessageAdapter({ userFrames: 'all' })
    expect(adapter.convert(promptEcho).frames).toHaveLength(1)
  })

  test('marks result frames as turn endings', () => {
    const adapter = new NativeMessageAdapter()
    expect(adapter.convert(result).turnEnded).toBe(true)
    expect(adapter.convert(toolResult).turnEnded).toBe(false)
  })
})

describe('permission frames', () => {
  test('buildPermissionControlFrame carries the request id and request fields', () => {
    const frame = buildPermissionControlFrame(
      { ...permissionRequest, permission_suggestions: [], blocked_path: '/x' },
      'req-1',
    )
    expect(frame.type).toBe('control_request')
    expect(frame.request_id).toBe('req-1')
    const request = frame.request as Record<string, unknown>
    expect(request.subtype).toBe('can_use_tool')
    expect(request.tool_use_id).toBe('toolu_1')
    expect(request.blocked_path).toBe('/x')
  })

  test('buildPermissionPrompt provides dialog parts and falls back to a stub tool', () => {
    const parts = buildPermissionPrompt(permissionRequest, 'req-1', [])
    expect(parts.description).toBe('Run ls')
    expect(parts.permissionResult).toMatchObject({
      behavior: 'ask',
      message: 'Run ls',
    })
    expect(parts.tool.name).toBe('Bash')
    expect(parts.toolUseID).toBe('toolu_1')
  })

  test('permissionDecisionToResponse maps allow/deny and defaults to deny', () => {
    expect(
      permissionDecisionToResponse(
        { behavior: 'allow', updatedInput: { command: 'pwd' } },
        { command: 'ls' },
      ),
    ).toEqual({ behavior: 'allow', updatedInput: { command: 'pwd' } })

    expect(
      permissionDecisionToResponse({ behavior: 'allow' }, { command: 'ls' }),
    ).toEqual({ behavior: 'allow', updatedInput: { command: 'ls' } })

    expect(
      permissionDecisionToResponse(
        {
          behavior: 'deny',
          message: 'nope',
          decisionReason: { type: 'mode', mode: 'default' },
        },
        {},
      ),
    ).toEqual({ behavior: 'deny', message: 'nope' })

    // Unresolved ask decisions must never allow the tool.
    expect(
      permissionDecisionToResponse(
        { behavior: 'ask', message: 'still asking' },
        {},
      ),
    ).toEqual({ behavior: 'deny', message: 'still asking' })
  })
})

describe('NativeSessionBridge', () => {
  function createBridge() {
    let transport: FakeTransport | null = null
    const frames: unknown[] = []
    const bridge = new NativeSessionBridge({
      adapter: new NativeMessageAdapter({
        dedupeInit: true,
        userFrames: 'tool-results-only',
      }),
      createTransport: callbacks => {
        transport = new FakeTransport(callbacks)
        return transport
      },
    })
    bridge.attach({
      send: frame => frames.push(frame),
      requestPermission: async requestId => {
        return {
          behavior: 'allow',
          updatedInput: { command: `echo ${requestId}` },
        }
      },
    })
    return { bridge, frames, transport: transport! }
  }

  test('forwards adapted frames to the host and ends turns on result', async () => {
    const { bridge, frames, transport } = createBridge()
    expect(transport.connected).toBe(true)

    transport.callbacks.onMessage(init)
    transport.callbacks.onMessage(promptEcho)
    transport.callbacks.onMessage(toolResult)

    expect(frames).toHaveLength(2)
    expect((frames[0] as Record<string, unknown>).type).toBe('system')
    expect((frames[1] as Record<string, unknown>).type).toBe('user')

    const iterator = await bridge.submitPrompt('hello')
    expect(transport.sent).toEqual(['hello'])
    // Optimistic user bubble is injected for the native transcript.
    expect((frames.at(-1) as Record<string, unknown>).type).toBe('user')

    const done = (async () => {
      for await (const _ of iterator) {
        // No frames are yielded; the iterator only paces the queue.
      }
      return true
    })()
    transport.callbacks.onMessage(result)
    expect(await done).toBe(true)
    bridge.disconnect()
  })

  test('matches permission answers by request_id', async () => {
    const { bridge, frames, transport } = createBridge()

    transport.callbacks.onPermissionRequest(permissionRequest, 'remote-1')
    await flush()

    const frame = frames.find(
      candidate =>
        (candidate as Record<string, unknown>).type === 'control_request',
    ) as Record<string, unknown>
    expect(frame.request_id).toBe('remote-1')
    expect(transport.responses).toEqual([
      {
        requestId: 'remote-1',
        response: {
          behavior: 'allow',
          updatedInput: { command: 'echo remote-1' },
        },
      },
    ])

    // A duplicate delivery of the same request id (even after the first one
    // completed) is ignored: one terminal response per request_id.
    transport.callbacks.onPermissionRequest(permissionRequest, 'remote-1')
    await flush()
    expect(transport.responses).toHaveLength(1)

    // A different id is still an independent request.
    transport.callbacks.onPermissionRequest(permissionRequest, 'remote-2')
    await flush()
    expect(transport.responses).toHaveLength(2)
    expect(transport.responses[1]?.requestId).toBe('remote-2')
    bridge.disconnect()
  })

  test('interrupt and disconnect are idempotent', async () => {
    const { bridge, transport } = createBridge()

    bridge.interrupt()
    bridge.interrupt()
    expect(transport.interrupts).toBe(2)

    bridge.disconnect()
    bridge.disconnect()
    expect(transport.disconnects).toBe(1)

    // Sending after disconnect is a no-op.
    const iterator = await bridge.submitPrompt('ignored')
    for await (const _ of iterator) {
      // empty
    }
    expect(transport.sent).toEqual([])
  })

  test('disconnect ends an in-flight turn and surfaces the reason', async () => {
    let transport: FakeTransport | null = null
    const frames: unknown[] = []
    const bridge = new NativeSessionBridge({
      createTransport: callbacks => {
        transport = new FakeTransport(callbacks)
        return transport
      },
      describeDisconnect: () => 'remote stderr tail',
    })
    bridge.attach({
      send: frame => frames.push(frame),
      requestPermission: async () => ({
        behavior: 'deny',
        message: 'denied',
        decisionReason: { type: 'mode', mode: 'default' },
      }),
    })

    const iterator = await bridge.submitPrompt('hello')
    const done = (async () => {
      for await (const _ of iterator) {
        // empty
      }
      return true
    })()

    transport!.callbacks.onDisconnected?.()
    expect(await done).toBe(true)
    expect(transport!.disconnects).toBe(1)
    const system = frames.find(
      candidate => (candidate as Record<string, unknown>).type === 'system',
    ) as Record<string, unknown>
    expect(String(system.content)).toContain('remote stderr tail')
  })
})
