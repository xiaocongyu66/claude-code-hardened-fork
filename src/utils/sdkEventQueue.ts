import type { UUID } from 'crypto'
import { randomUUID } from 'crypto'
import { getIsNonInteractiveSession, getSessionId } from '../bootstrap/state.js'
import { getTaskHandleRecord } from '../services/taskRegistry/taskRegistry.js'
import type { SdkWorkflowProgress } from '../types/tools.js'

/**
 * Canonical fields the TUI task panel relies on. Every task_* frame carries
 * them; task_started/task_progress fill `status`/`task_type`/`output` from the
 * read-only task registry at drain time (the handle is recorded by the task
 * implementation, which may happen just after registerTask emits the start
 * frame).
 */
type TaskFrameFields = {
  task_id: string
  task_type?: string
  status?: string
  /** Output file path (mirrors task_notification.output_file) when known. */
  output?: string
  summary?: string
}

type TaskStartedEvent = TaskFrameFields & {
  type: 'system'
  subtype: 'task_started'
  description: string
  tool_use_id?: string
  workflow_name?: string
  prompt?: string
}

type TaskProgressEvent = TaskFrameFields & {
  type: 'system'
  subtype: 'task_progress'
  description: string
  tool_use_id?: string
  usage: {
    total_tokens: number
    tool_uses: number
    duration_ms: number
  }
  last_tool_name?: string
  // Delta batch of workflow state changes. Clients upsert by
  // `${type}:${index}` then group by phaseIndex to rebuild the phase tree,
  // same fold as collectFromEvents + groupByPhase in PhaseProgress.tsx.
  workflow_progress?: SdkWorkflowProgress[]
}

// Emitted when a foreground agent completes without being backgrounded.
// Drained by drainSdkEvents() directly into the output stream — does NOT
// go through the print.ts XML task_notification parser and does NOT trigger
// the LLM loop. Consumers (e.g. VS Code session.ts) use this to remove the
// task from the subagent panel.
type TaskNotificationSdkEvent = TaskFrameFields & {
  type: 'system'
  subtype: 'task_notification'
  tool_use_id?: string
  status: 'completed' | 'failed' | 'stopped'
  output_file: string
  summary: string
  usage?: {
    total_tokens: number
    tool_uses: number
    duration_ms: number
  }
}

// Mirrors notifySessionStateChanged. The CCR bridge already receives this
// via its own listener; SDK consumers (scmuxd, VS Code) need the same signal
// to know when the main turn's generator is idle vs actively producing.
// The 'idle' transition fires AFTER heldBackResult flushes and the bg-agent
// do-while loop exits — so SDK consumers can trust it as the authoritative
// "turn is over" signal even when result was withheld for background agents.
type SessionStateChangedEvent = {
  type: 'system'
  subtype: 'session_state_changed'
  state: 'idle' | 'running' | 'requires_action'
}

export type SdkEvent =
  | TaskStartedEvent
  | TaskProgressEvent
  | TaskNotificationSdkEvent
  | SessionStateChangedEvent

const MAX_QUEUE_SIZE = 1000
const queue: SdkEvent[] = []

export function enqueueSdkEvent(event: SdkEvent): void {
  // SDK events are only consumed (drained) in headless/streaming mode.
  // In TUI mode they would accumulate up to the cap and never be read.
  if (!getIsNonInteractiveSession()) {
    return
  }
  if (queue.length >= MAX_QUEUE_SIZE) {
    queue.shift()
  }
  queue.push(event)
}

export function drainSdkEvents(): Array<
  SdkEvent & { uuid: UUID; session_id: string }
> {
  if (queue.length === 0) {
    return []
  }
  const events = queue.splice(0)
  return events.map(e => ({
    ...enrichSdkTaskEvent(e),
    uuid: randomUUID(),
    session_id: getSessionId(),
  }))
}

function isTaskFrame(
  event: SdkEvent,
): event is TaskStartedEvent | TaskProgressEvent | TaskNotificationSdkEvent {
  return (
    event.type === 'system' &&
    (event.subtype === 'task_started' ||
      event.subtype === 'task_progress' ||
      event.subtype === 'task_notification')
  )
}

/**
 * Read-only relay from the central task registry into the task_* frame shape
 * the TUI consumes. Does not mutate the registry or AppState.
 *
 * `status` prefers the frame's own value (terminal notifications carry the
 * authoritative end state); otherwise it reflects the registry's latest state.
 * `output` mirrors the task output file path (same value as `output_file` on
 * task_notification) so every frame exposes an optional artifact.
 */
export function enrichSdkTaskEvent(event: SdkEvent): SdkEvent {
  if (!isTaskFrame(event)) {
    return event
  }
  const record = getTaskHandleRecord(event.task_id)
  // task_notification frames carry no `description` field of their own; the
  // registry supplies it. `in` keeps the union narrowing explicit.
  const frameDescription =
    'description' in event && typeof event.description === 'string'
      ? event.description
      : undefined
  const common = {
    task_type: event.task_type ?? record?.type ?? 'unknown',
    description: frameDescription ?? record?.description ?? '',
  }
  if (event.subtype === 'task_notification') {
    const output = event.output ?? event.output_file ?? record?.outputFile
    return {
      ...event,
      ...common,
      // Preserve the terminal literal; the frame's own status is authoritative.
      status: event.status,
      ...(output !== undefined ? { output } : {}),
    }
  }
  const output = event.output ?? record?.outputFile
  return {
    ...event,
    ...common,
    status: event.status ?? record?.status ?? 'running',
    ...(output !== undefined ? { output } : {}),
  }
}

/**
 * Emit a task_notification SDK event for a task reaching a terminal state.
 *
 * registerTask() always emits task_started; this is the closing bookend.
 * Call this from any exit path that sets a task terminal WITHOUT going
 * through enqueuePendingNotification-with-<task-id> (print.ts parses that
 * XML into the same SDK event, so paths that do both would double-emit).
 * Paths that suppress the XML notification (notified:true pre-set, kill
 * paths, abort branches) must call this directly so SDK consumers
 * (Scuttle's bg-task dot, VS Code subagent panel) see the task close.
 */
export function emitTaskTerminatedSdk(
  taskId: string,
  status: 'completed' | 'failed' | 'stopped',
  opts?: {
    toolUseId?: string
    summary?: string
    outputFile?: string
    usage?: { total_tokens: number; tool_uses: number; duration_ms: number }
  },
): void {
  enqueueSdkEvent({
    type: 'system',
    subtype: 'task_notification',
    task_id: taskId,
    tool_use_id: opts?.toolUseId,
    status,
    output_file: opts?.outputFile ?? '',
    summary: opts?.summary ?? '',
    usage: opts?.usage,
  })
}
