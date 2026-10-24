/**
 * Transport + message-adapter layer shared by the Ink hooks and the native
 * TUI for remote-style sessions (`claude ssh`, `claude connect` and the
 * KAIROS remote viewer).
 *
 * The React hooks own UI state; everything that talks to a transport or turns
 * SDK frames into native-TUI frames lives here so both renderers use exactly
 * the same lifecycle:
 *
 *   connect() / sendMessage() / sendInterrupt() / disconnect()
 *
 * `NativeSessionBridge` additionally drives the native host: it forwards SDK
 * messages into `send(frame)`, turns remote `can_use_tool` requests into
 * `control_request` frames and routes the TUI's answer back through the
 * transport's `respondToPermissionRequest`. Nothing here imports React.
 */

import type {
  SDKMessage,
  SDKUserMessage,
} from '../entrypoints/agentSdkTypes.js'
import type { SDKControlPermissionRequest } from '../entrypoints/sdk/controlTypes.js'
import type { DirectConnectConfig } from '../server/directConnectManager.js'
import { DirectConnectSessionManager } from '../server/directConnectManager.js'
import type { SSHSession } from '../ssh/createSSHSession.js'
import type { SSHSessionManager } from '../ssh/SSHSessionManager.js'
import type { Tool } from '../Tool.js'
import { findToolByName } from '../Tool.js'
import type { AssistantMessage } from '../types/message.js'
import type {
  PermissionAskDecision,
  PermissionDecision,
  PermissionUpdate,
} from '../types/permissions.js'
import type { RemoteMessageContent } from '../utils/teleport/api.js'
import {
  createSyntheticAssistantMessage,
  createToolStub,
} from './remotePermissionBridge.js'
import {
  type RemotePermissionResponse,
  type RemoteSessionConfig,
  RemoteSessionManager,
} from './RemoteSessionManager.js'

/**
 * Permission request payload common to every transport. The `subtype` field
 * added by the SDK transport is optional here; the bridge supplies it when
 * emitting a control_request frame.
 */
export interface SessionPermissionRequest {
  tool_name: string
  tool_use_id: string
  input: Record<string, unknown>
  description?: string
  permission_suggestions?: PermissionUpdate[]
  blocked_path?: string
}

/**
 * Normalize the SDK control-request shape onto the transport-agnostic type.
 * The SDK schema's `setMode` suggestions additionally admit the internal
 * `auto` mode, so the list is asserted to the dialog-facing
 * `PermissionUpdate[]` — the same boundary cast the Ink hooks used before the
 * transport extraction.
 */
function fromSDKPermissionRequest(
  request: SDKControlPermissionRequest,
): SessionPermissionRequest {
  return {
    tool_name: request.tool_name,
    tool_use_id: request.tool_use_id,
    input: request.input,
    description: request.description,
    permission_suggestions: request.permission_suggestions as
      | PermissionUpdate[]
      | undefined,
    blocked_path: request.blocked_path,
  }
}

/** Callbacks every transport can emit. All but `onMessage` are optional. */
export interface SessionTransportCallbacks {
  onMessage: (message: SDKMessage) => void
  onPermissionRequest: (
    request: SessionPermissionRequest,
    requestId: string,
  ) => void
  onPermissionCancelled?: (requestId: string, toolUseId?: string) => void
  onConnected?: () => void
  onReconnecting?: (attempt: number, max: number) => void
  onDisconnected?: () => void
  onError?: (error: Error) => void
}

/** Renderer-agnostic session lifecycle. */
export interface SessionTransport {
  connect(): void
  sendMessage(
    content: RemoteMessageContent,
    opts?: { uuid?: string },
  ): Promise<boolean>
  sendInterrupt(): void
  disconnect(): void
  respondToPermissionRequest(
    requestId: string,
    response: RemotePermissionResponse,
  ): void
}

/** `claude ssh`: a local SSH child process speaking stream-json. */
export class SSHSessionTransport implements SessionTransport {
  private manager: SSHSessionManager | null = null
  private closed = false

  constructor(
    private readonly session: SSHSession,
    private readonly callbacks: SessionTransportCallbacks,
  ) {}

  connect(): void {
    if (this.closed || this.manager) return
    this.manager = this.session.createManager({
      onMessage: message => this.callbacks.onMessage(message),
      onPermissionRequest: (request, requestId) =>
        this.callbacks.onPermissionRequest(request, requestId),
      onConnected: () => this.callbacks.onConnected?.(),
      onReconnecting: (attempt, max) =>
        this.callbacks.onReconnecting?.(attempt, max),
      onDisconnected: () => this.callbacks.onDisconnected?.(),
      onError: error => this.callbacks.onError?.(error),
    })
    this.manager.connect()
  }

  async sendMessage(content: RemoteMessageContent): Promise<boolean> {
    if (this.closed) return false
    return this.manager?.sendMessage(content) ?? false
  }

  sendInterrupt(): void {
    if (!this.closed) this.manager?.sendInterrupt()
  }

  respondToPermissionRequest(
    requestId: string,
    response: RemotePermissionResponse,
  ): void {
    if (!this.closed) {
      this.manager?.respondToPermissionRequest(requestId, response)
    }
  }

  disconnect(): void {
    if (this.closed) return
    this.closed = true
    this.manager?.disconnect()
    this.manager = null
    // The auth proxy is owned by the SSH session and would otherwise leak a
    // local socket after the REPL/native host exits.
    try {
      this.session.proxy.stop()
    } catch {
      // Already stopped.
    }
  }
}

/** `claude connect`: a WebSocket to a (possibly remote) claude server. */
export class DirectConnectTransport implements SessionTransport {
  private manager: DirectConnectSessionManager
  private closed = false

  constructor(
    config: DirectConnectConfig,
    private readonly callbacks: SessionTransportCallbacks,
  ) {
    this.manager = new DirectConnectSessionManager(config, {
      onMessage: message => this.callbacks.onMessage(message),
      onPermissionRequest: (request, requestId) =>
        this.callbacks.onPermissionRequest(
          fromSDKPermissionRequest(request),
          requestId,
        ),
      onConnected: () => this.callbacks.onConnected?.(),
      onDisconnected: () => this.callbacks.onDisconnected?.(),
      onError: error => this.callbacks.onError?.(error),
    })
  }

  connect(): void {
    if (!this.closed) this.manager.connect()
  }

  async sendMessage(content: RemoteMessageContent): Promise<boolean> {
    if (this.closed) return false
    return this.manager.sendMessage(content)
  }

  sendInterrupt(): void {
    if (!this.closed) this.manager.sendInterrupt()
  }

  respondToPermissionRequest(
    requestId: string,
    response: RemotePermissionResponse,
  ): void {
    if (!this.closed) {
      this.manager.respondToPermissionRequest(requestId, response)
    }
  }

  disconnect(): void {
    if (this.closed) return
    this.closed = true
    this.manager.disconnect()
  }
}

/** KAIROS `--remote`: CCR session over WebSocket + HTTP POST. */
export class RemoteSessionTransport implements SessionTransport {
  private manager: RemoteSessionManager
  private closed = false

  constructor(
    config: RemoteSessionConfig,
    private readonly callbacks: SessionTransportCallbacks,
  ) {
    this.manager = new RemoteSessionManager(config, {
      onMessage: message => this.callbacks.onMessage(message),
      onPermissionRequest: (request, requestId) =>
        this.callbacks.onPermissionRequest(
          fromSDKPermissionRequest(request),
          requestId,
        ),
      onPermissionCancelled: (requestId, toolUseId) =>
        this.callbacks.onPermissionCancelled?.(requestId, toolUseId),
      onConnected: () => this.callbacks.onConnected?.(),
      onDisconnected: () => this.callbacks.onDisconnected?.(),
      onReconnecting: () => this.callbacks.onReconnecting?.(0, 0),
      onError: error => this.callbacks.onError?.(error),
    })
  }

  connect(): void {
    if (!this.closed) this.manager.connect()
  }

  sendMessage(
    content: RemoteMessageContent,
    opts?: { uuid?: string },
  ): Promise<boolean> {
    if (this.closed) return Promise.resolve(false)
    return this.manager.sendMessage(content, opts)
  }

  sendInterrupt(): void {
    if (!this.closed) this.manager.cancelSession()
  }

  respondToPermissionRequest(
    requestId: string,
    response: RemotePermissionResponse,
  ): void {
    if (!this.closed) {
      this.manager.respondToPermissionRequest(requestId, response)
    }
  }

  reconnect(): void {
    if (!this.closed) this.manager.reconnect()
  }

  disconnect(): void {
    if (this.closed) return
    this.closed = true
    this.manager.disconnect()
  }
}

/**
 * Build the pieces every permission prompt needs from a remote request:
 * the locally-known (or stub) tool, the synthetic assistant message, the
 * `ask` decision shown by the dialog, and the tool_use id that ties the
 * dialog back to the remote request.
 */
export interface PermissionPromptParts {
  tool: Tool
  syntheticMessage: AssistantMessage
  description: string
  permissionResult: PermissionAskDecision
  toolUseID: string
  input: Record<string, unknown>
}

export function buildPermissionPrompt(
  request: SessionPermissionRequest,
  requestId: string,
  tools: Tool[],
): PermissionPromptParts {
  const tool =
    findToolByName(tools, request.tool_name) ??
    createToolStub(request.tool_name)
  const description =
    request.description ?? `${request.tool_name} requires permission`
  const sdkRequest: SDKControlPermissionRequest = {
    subtype: 'can_use_tool',
    tool_name: request.tool_name,
    tool_use_id: request.tool_use_id,
    input: request.input,
    ...(request.description ? { description: request.description } : {}),
    ...(request.permission_suggestions
      ? { permission_suggestions: request.permission_suggestions }
      : {}),
    ...(request.blocked_path ? { blocked_path: request.blocked_path } : {}),
  }

  return {
    tool,
    syntheticMessage: createSyntheticAssistantMessage(sdkRequest, requestId),
    description,
    permissionResult: {
      behavior: 'ask',
      message: description,
      suggestions: request.permission_suggestions,
      blockedPath: request.blocked_path,
    },
    toolUseID: request.tool_use_id,
    input: request.input,
  }
}

/** Which user frames a remote stream should surface in the native TUI. */
export type NativeUserFramePolicy = 'all' | 'tool-results-only' | 'none'

export interface NativeMessageAdapterOptions {
  /**
   * SSH/direct-connect echo the prompt back as a `user` frame; the bridge
   * already renders an optimistic bubble, so only tool results are forwarded.
   */
  userFrames?: NativeUserFramePolicy
  /** stream-json emits `system/init` once per turn on some servers. */
  dedupeInit?: boolean
}

export interface NativeFrameBatch {
  frames: unknown[]
  /** A `result` frame arrived: the in-flight turn is over. */
  turnEnded: boolean
}

function hasToolResult(message: SDKMessage): boolean {
  if (message.type !== 'user') return false
  const content = (message as SDKUserMessage).message?.content
  return (
    Array.isArray(content) &&
    content.some(
      block =>
        block !== null &&
        typeof block === 'object' &&
        (block as { type?: unknown }).type === 'tool_result',
    )
  )
}

/**
 * Turns SDK stream-json messages into frames the native host can hand to the
 * TUI unchanged. The native TUI speaks the same protocol, so the adapter only
 * filters (init de-dupe, prompt echoes) and flags turn boundaries.
 */
export class NativeMessageAdapter {
  private initSeen = false

  constructor(private readonly options: NativeMessageAdapterOptions = {}) {}

  convert(message: SDKMessage): NativeFrameBatch {
    if (message === null || typeof message !== 'object') {
      return { frames: [], turnEnded: false }
    }
    if (typeof message.type !== 'string') {
      return { frames: [], turnEnded: false }
    }

    if (message.type === 'system' && message.subtype === 'init') {
      if (this.options.dedupeInit !== false) {
        if (this.initSeen) return { frames: [], turnEnded: false }
        this.initSeen = true
      }
      return { frames: [message], turnEnded: false }
    }

    if (message.type === 'user') {
      const policy = this.options.userFrames ?? 'all'
      if (policy === 'none') return { frames: [], turnEnded: false }
      if (policy === 'tool-results-only' && !hasToolResult(message)) {
        return { frames: [], turnEnded: false }
      }
      return { frames: [message], turnEnded: false }
    }

    return {
      frames: [message],
      turnEnded: message.type === 'result',
    }
  }

  /** Reset per-connection de-dupe state (a fresh turn stream may re-init). */
  reset(): void {
    this.initSeen = false
  }
}

/** Build the `control_request` frame that opens the TUI permission dialog. */
export function buildPermissionControlFrame(
  request: SessionPermissionRequest,
  requestId: string,
): Record<string, unknown> {
  return {
    type: 'control_request',
    request_id: requestId,
    request: {
      subtype: 'can_use_tool',
      tool_name: request.tool_name,
      tool_use_id: request.tool_use_id,
      input: request.input,
      ...(request.description ? { description: request.description } : {}),
      ...(request.permission_suggestions
        ? { permission_suggestions: request.permission_suggestions }
        : {}),
      ...(request.blocked_path ? { blocked_path: request.blocked_path } : {}),
    },
  }
}

/**
 * Map the terminal decision produced by the native dialog onto the response
 * shape every remote transport expects. Unknown/`ask` decisions deny: a
 * stalled dialog must never silently allow a tool.
 */
export function permissionDecisionToResponse(
  decision: PermissionDecision,
  input: Record<string, unknown>,
): RemotePermissionResponse {
  if (decision.behavior === 'allow') {
    return {
      behavior: 'allow',
      updatedInput:
        (decision.updatedInput as Record<string, unknown> | undefined) ?? input,
    }
  }
  if (decision.behavior === 'deny') {
    return {
      behavior: 'deny',
      message: decision.message || 'User denied permission',
    }
  }
  return {
    behavior: 'deny',
    message: decision.message || 'Permission not granted',
  }
}

/** Controls exposed by the native host to a bridge/transport. */
export interface NativeHostControls {
  send(frame: unknown): void
  requestPermission(requestId: string): Promise<PermissionDecision>
}

export interface NativeSessionBridgeOptions {
  createTransport: (callbacks: SessionTransportCallbacks) => SessionTransport
  adapter?: NativeMessageAdapter
  /** Extra detail (e.g. SSH stderr tail) surfaced when the transport dies. */
  describeDisconnect?: () => string | undefined
}

/** Cap on remembered terminal permission ids (oldest evicted first). */
const MAX_ANSWERED_PERMISSIONS = 256

/**
 * Connects a `SessionTransport` to the native host.
 *
 * - incoming SDK messages are adapted and injected with `host.send`
 * - prompts are written optimistically (the TUI never sees a local engine
 *   user echo for remote sessions) and the returned iterator completes on the
 *   next `result`, so queued prompts drain one turn at a time
 * - permission requests are forwarded as `control_request` frames; the TUI's
 *   answer is matched by `request_id` and sent back to the transport
 * - interrupt/disconnect are idempotent and always release the turn wait
 */
export class NativeSessionBridge {
  private readonly transport: SessionTransport
  private readonly adapter: NativeMessageAdapter
  private host: NativeHostControls | null = null
  private turnResolve: (() => void) | null = null
  private attached = false
  private disconnected = false
  private readonly pendingPermissions = new Set<string>()
  /**
   * Request ids that already received their terminal response. The protocol
   * allows exactly one terminal response per request_id, so late duplicates
   * (a re-send, or a second onPermissionRequest after the first resolved)
   * must be ignored rather than opening the dialog again. Bounded because the
   * id space is server-controlled.
   */
  private readonly answeredPermissions = new Set<string>()

  constructor(private readonly options: NativeSessionBridgeOptions) {
    this.adapter =
      options.adapter ??
      new NativeMessageAdapter({ dedupeInit: true, userFrames: 'all' })
    this.transport = options.createTransport({
      onMessage: message => this.handleMessage(message),
      onPermissionRequest: (request, requestId) => {
        void this.handlePermission(request, requestId)
      },
      onConnected: () => {},
      onReconnecting: (attempt, max) => {
        this.sendSystem(
          `Remote connection dropped — reconnecting (attempt ${attempt}/${max})…`,
          'warning',
        )
        this.endTurn()
      },
      onDisconnected: () => this.handleDisconnected(),
      onError: () => {
        // Transport callbacks are best-effort; diagnostics stay in the
        // transport's own debug log.
      },
    })
  }

  /** Called by the native host once the TUI has started. */
  attach(host: NativeHostControls): void {
    if (this.disconnected || this.attached) return
    this.attached = true
    this.host = host
    this.transport.connect()
  }

  async submitPrompt(text: string): Promise<AsyncIterable<unknown>> {
    if (this.disconnected || !this.host) return emptyIterable()
    // Arm the turn gate before writing: a fast transport can deliver `result`
    // while `sendMessage` is still awaiting.
    const wait = this.beginTurn()
    this.host.send(buildUserFrame(text))
    const sent = await this.transport.sendMessage(text)
    if (!sent) {
      this.endTurn()
      this.sendSystem('Failed to send prompt to the remote session.', 'error')
      return emptyIterable()
    }
    return iterableForTurn(wait)
  }

  /** Ctrl+C / Esc: forward the transport interrupt and release the queue. */
  interrupt(): void {
    if (this.disconnected) return
    this.transport.sendInterrupt()
    this.endTurn()
  }

  /** Host shutdown. Safe to call more than once. */
  disconnect(): void {
    if (this.disconnected) return
    this.disconnected = true
    this.endTurn()
    // A host that failed before onHostReady never connected the transport;
    // leave the session intact so the caller can still fall back to Ink.
    if (this.attached) this.transport.disconnect()
  }

  private handleMessage(message: SDKMessage): void {
    if (this.disconnected) return
    const batch = this.adapter.convert(message)
    for (const frame of batch.frames) {
      this.host?.send(frame)
    }
    if (batch.turnEnded) this.endTurn()
  }

  private async handlePermission(
    request: SessionPermissionRequest,
    requestId: string,
  ): Promise<void> {
    if (this.disconnected || !this.host) return
    // One terminal response per request_id: ignore while in flight and after
    // it has been answered.
    if (
      this.pendingPermissions.has(requestId) ||
      this.answeredPermissions.has(requestId)
    ) {
      return
    }
    this.pendingPermissions.add(requestId)
    this.host.send(buildPermissionControlFrame(request, requestId))
    try {
      const decision = await this.host.requestPermission(requestId)
      this.respondOnce(
        requestId,
        permissionDecisionToResponse(decision, request.input ?? {}),
      )
    } catch {
      this.respondOnce(requestId, {
        behavior: 'deny',
        message: 'Permission request failed',
      })
    } finally {
      this.pendingPermissions.delete(requestId)
    }
  }

  /**
   * Record the terminal decision before writing it, so a throwing transport
   * (or re-entrant duplicate) cannot produce a second response for the id.
   */
  private respondOnce(
    requestId: string,
    response: RemotePermissionResponse,
  ): void {
    if (this.answeredPermissions.has(requestId)) return
    this.answeredPermissions.add(requestId)
    if (this.answeredPermissions.size > MAX_ANSWERED_PERMISSIONS) {
      const oldest = this.answeredPermissions.values().next().value
      if (oldest !== undefined) this.answeredPermissions.delete(oldest)
    }
    this.transport.respondToPermissionRequest(requestId, response)
  }

  private handleDisconnected(): void {
    if (this.disconnected) return
    this.disconnected = true
    this.endTurn()
    const detail = this.options.describeDisconnect?.()?.trim()
    this.sendSystem(
      detail ? `Remote session ended.\n${detail}` : 'Remote session ended.',
      'warning',
    )
    this.transport.disconnect()
  }

  private sendSystem(
    content: string,
    level: 'info' | 'warning' | 'error',
  ): void {
    this.host?.send({
      type: 'system',
      subtype: 'informational',
      content,
      level,
      uuid: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
    })
  }

  private beginTurn(): Promise<void> {
    return new Promise<void>(resolve => {
      this.turnResolve = resolve
    })
  }

  private endTurn(): void {
    const resolve = this.turnResolve
    this.turnResolve = null
    resolve?.()
  }
}

function buildUserFrame(text: string): Record<string, unknown> {
  return {
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'text', text }],
    },
    parent_tool_use_id: null,
    session_id: '',
    uuid: crypto.randomUUID(),
    isReplay: true,
  }
}

/** Completes (without yielding) when the current remote turn ends. */
function iterableForTurn(wait: Promise<void>): AsyncIterable<unknown> {
  return {
    [Symbol.asyncIterator]() {
      let done = false
      return {
        async next(): Promise<IteratorResult<unknown>> {
          if (done) return { done: true, value: undefined }
          done = true
          await wait
          return { done: true, value: undefined }
        },
      }
    },
  }
}

function emptyIterable(): AsyncIterable<unknown> {
  return {
    [Symbol.asyncIterator]() {
      return {
        next: async (): Promise<IteratorResult<unknown>> => ({
          done: true,
          value: undefined,
        }),
      }
    },
  }
}
