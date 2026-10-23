/**
 * TypeScript host for the in-process native TUI (`cch_tui` napi module).
 *
 * The Rust TUI owns rendering, input editing and dialog focus; this host owns
 * the engine. Frames flow both ways:
 *
 *   engine events → send(JSON.stringify(event))   (assistant/stream_event/…)
 *   poll()       → prompt / permission / interrupt / exit
 *   canUseTool   → control_request can_use_tool frame; the terminal decision
 *                  arrives as a `permission` poll frame and resolves the
 *                  pending promise.
 *
 * Everything side-effecting is injected so the loop can be unit-tested with a
 * fake native module — no FFI is touched by the tests.
 */

import type { CanUseToolFn } from '../hooks/useCanUseTool.js'
import type { PermissionDecision } from '../types/permissions.js'
import type {
  TuiNativeEvent,
  TuiNativeModule,
  TuiStartOptions,
} from '../utils/tuiNative.js'

/** Minimal permission answer shape carried by a `permission` poll frame. */
export interface NativePermissionAnswer {
  behavior: 'allow' | 'deny'
  updatedInput?: Record<string, unknown>
  message?: string
}

export interface NativePermissionEvent extends TuiNativeEvent {
  type: 'permission'
  requestId?: string
  request_id?: string
  behavior?: 'allow' | 'deny'
  updatedInput?: Record<string, unknown>
  updated_input?: Record<string, unknown>
  message?: string
  /** Optional promise supplied by the native side itself. */
  decision?: NativePermissionAnswer | PermissionDecision | Promise<unknown>
}

export interface RunNativeTuiDeps {
  /** Injected in tests; production resolves `loadTuiNative()` lazily. */
  nativeModule?: TuiNativeModule | null
  options?: TuiStartOptions
  /**
   * Runs one turn and yields engine events (QueryEngine/query async
   * generator). Receives the wrapped permission function to hand to the
   * engine config.
   */
  submitPrompt: (
    text: string,
    canUseTool: CanUseToolFn,
  ) => AsyncIterable<unknown> | Promise<AsyncIterable<unknown>>
  /**
   * Called for every `permission` poll frame. The returned value (or the
   * frame's own `decision` promise) resolves the pending canUseTool call.
   */
  answerPermission?: (
    event: NativePermissionEvent,
  ) =>
    | NativePermissionAnswer
    | PermissionDecision
    | undefined
    | Promise<unknown>
  /** Base policy checker; allow/deny decisions short-circuit the dialog. */
  canUseTool?: CanUseToolFn
  /** Interrupt the in-flight turn. */
  abort?: () => void
  pollIntervalMs?: number
  /** Injected for deterministic tests; defaults to setTimeout. */
  sleep?: (ms: number) => Promise<void>
  onError?: (error: unknown) => void
}

export interface RunNativeTuiResult {
  started: boolean
  reason?: string
}

const DEFAULT_POLL_INTERVAL_MS = 20

function defaultSleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : null
}

/** Normalize `poll()` output into a list of frames (array/JSON string/null). */
function normalizeFrames(
  raw: TuiNativeEvent | TuiNativeEvent[] | string | null | undefined,
): TuiNativeEvent[] {
  if (raw === null || raw === undefined) return []
  if (typeof raw === 'string') {
    try {
      return normalizeFrames(JSON.parse(raw) as unknown as TuiNativeEvent)
    } catch {
      return []
    }
  }
  if (Array.isArray(raw)) return raw
  if (typeof raw === 'object') return [raw]
  return []
}

function extractPromptText(event: TuiNativeEvent): string | null {
  for (const key of ['text', 'prompt', 'content'] as const) {
    const value = event[key]
    if (typeof value === 'string' && value.length > 0) return value
  }
  const message = asRecord(event.message)
  if (message) {
    const content = message.content
    if (typeof content === 'string') return content
    if (Array.isArray(content)) {
      const text = content
        .map(block => {
          const b = asRecord(block)
          return b && b.type === 'text' && typeof b.text === 'string'
            ? b.text
            : ''
        })
        .join('')
      if (text.length > 0) return text
    }
  }
  return null
}

function permissionRequestId(event: NativePermissionEvent): string | null {
  const id = event.requestId ?? event.request_id
  return typeof id === 'string' && id.length > 0 ? id : null
}

/**
 * Turn a poll frame into a PermissionDecision. Accepts the compact
 * `{behavior, updatedInput|updated_input, message}` shape produced by the
 * TUI. Anything unrecognized defaults to deny so a stalled dialog can never
 * silently allow a tool.
 */
function normalizeDecision(
  value: unknown,
  event: NativePermissionEvent,
): PermissionDecision {
  const record = asRecord(value)
  const behavior =
    (record?.behavior as string | undefined) ?? event.behavior ?? undefined
  if (behavior === 'allow') {
    const updatedInput =
      asRecord(record?.updatedInput) ??
      asRecord(record?.updated_input) ??
      event.updatedInput ??
      event.updated_input
    return {
      behavior: 'allow',
      ...(updatedInput ? { updatedInput } : {}),
    } as PermissionDecision
  }
  const message =
    (typeof record?.message === 'string' ? record.message : undefined) ??
    event.message ??
    'Denied in native TUI'
  return { behavior: 'deny', message } as PermissionDecision
}

export async function runNativeTui(
  deps: RunNativeTuiDeps,
): Promise<RunNativeTuiResult> {
  let mod: TuiNativeModule | null
  if (deps.nativeModule !== undefined) {
    mod = deps.nativeModule
  } else {
    const { loadTuiNative } = await import('../utils/tuiNative.js')
    mod = loadTuiNative()
  }
  if (!mod) {
    return { started: false, reason: 'native module unavailable' }
  }
  if (!mod.is_supported()) {
    return { started: false, reason: 'native module unsupported' }
  }
  const native = mod

  const sleep = deps.sleep ?? defaultSleep
  const pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
  // Deliberately quiet: a frame-level failure must not take down the CLI.
  const onError = deps.onError ?? (() => {})

  const pendingPermissions = new Map<
    string,
    (decision: PermissionDecision) => void
  >()
  let stopped = false
  let stopCalled = false
  let requestSeq = 0
  let turnChain: Promise<void> = Promise.resolve()

  const stop = (): void => {
    stopped = true
    if (stopCalled) return
    stopCalled = true
    for (const resolve of pendingPermissions.values()) {
      resolve({
        behavior: 'deny',
        message: 'Native TUI stopped',
      } as PermissionDecision)
    }
    pendingPermissions.clear()
    try {
      native.stop()
    } catch (error) {
      onError(error)
    }
  }

  const sendFrame = (frame: unknown): void => {
    if (stopped) return
    try {
      native.send(JSON.stringify(frame))
    } catch (error) {
      onError(error)
    }
  }

  const wrappedCanUseTool: CanUseToolFn = async (
    tool,
    input,
    toolUseContext,
    assistantMessage,
    toolUseID,
    forceDecision,
  ) => {
    if (forceDecision) return forceDecision

    let base: PermissionDecision | undefined
    if (deps.canUseTool) {
      base = await deps.canUseTool(
        tool,
        input,
        toolUseContext,
        assistantMessage,
        toolUseID,
      )
      if (base.behavior !== 'ask') return base
    }

    const requestId = `tui-${++requestSeq}-${toolUseID}`
    const decision = new Promise<PermissionDecision>(resolve => {
      pendingPermissions.set(requestId, resolve)
    })
    sendFrame({
      type: 'control_request',
      request_id: requestId,
      request: {
        subtype: 'can_use_tool',
        tool_name: tool.name,
        tool_use_id: toolUseID,
        input,
        ...(base?.behavior === 'ask' && base.message
          ? { description: base.message }
          : {}),
        ...(base?.behavior === 'ask' && base.suggestions
          ? { permission_suggestions: base.suggestions }
          : {}),
        ...(base?.behavior === 'ask' && base.blockedPath
          ? { blocked_path: base.blockedPath }
          : {}),
      },
    })
    return decision
  }

  const runTurn = async (text: string): Promise<void> => {
    if (stopped) return
    try {
      const iterator = await deps.submitPrompt(text, wrappedCanUseTool)
      for await (const event of iterator) {
        // Returning closes the generator, which aborts the engine turn.
        if (stopped) return
        sendFrame(event)
      }
    } catch (error) {
      if (!stopped) onError(error)
    }
  }

  const enqueuePrompt = (text: string): void => {
    turnChain = turnChain.then(() => runTurn(text))
  }

  const answerPermission = async (
    event: NativePermissionEvent,
  ): Promise<void> => {
    const requestId = permissionRequestId(event)
    const resolve = requestId ? pendingPermissions.get(requestId) : undefined

    let answer: unknown
    try {
      answer = deps.answerPermission
        ? await deps.answerPermission(event)
        : undefined
      if (answer === undefined && event.decision !== undefined) {
        answer = await event.decision
      }
    } catch (error) {
      onError(error)
    }

    if (!resolve || !requestId) return
    pendingPermissions.delete(requestId)
    resolve(normalizeDecision(answer, event))
  }

  try {
    native.start(deps.options ?? {})
  } catch (error) {
    stop()
    return {
      started: false,
      reason: `start() failed: ${String(error).slice(0, 160)}`,
    }
  }

  try {
    while (!stopped) {
      let raw: Awaited<ReturnType<TuiNativeModule['poll']>>
      try {
        raw = await native.poll()
      } catch (error) {
        onError(error)
        break
      }
      for (const event of normalizeFrames(raw)) {
        if (stopped) break
        switch (event.type) {
          case 'prompt': {
            const text = extractPromptText(event)
            if (text !== null) enqueuePrompt(text)
            break
          }
          case 'permission': {
            await answerPermission(event as NativePermissionEvent)
            break
          }
          case 'interrupt': {
            try {
              deps.abort?.()
            } catch (error) {
              onError(error)
            }
            break
          }
          case 'exit': {
            stop()
            break
          }
          default:
            // Unknown frames are ignored: the engine ships ahead of the host.
            break
        }
      }
      if (!stopped) await sleep(pollIntervalMs)
    }
    // Exit is terminal: never await an in-flight turn (a wedged API call must
    // not keep the host alive). Pending permissions were denied by stop().
  } finally {
    stop()
  }

  return { started: true }
}
