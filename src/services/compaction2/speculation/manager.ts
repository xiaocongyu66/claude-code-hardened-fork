// Asynchronous speculative compaction manager (COMPACTION_V2).
//
// The pure band decision lives in `triggers/speculation.ts`; this module owns
// the state machine around one background summarization run:
//
//   idle --maybeStart (in band)--> running --runner resolves--> armed
//   running --runner rejects / timeout--> idle
//   armed --consume (anchor still live)--> idle (result + appended messages)
//   armed --consume (branch rewritten) / timeout / cancel--> idle (discarded)
//
// The manager never blocks the query loop: `maybeStart` only schedules the
// injected runner, and `consume` never awaits an in-flight run. The transcript
// is append-only between iterations, so a run is committed when the snapshot's
// last message is still the live anchor; messages appended after it are
// returned alongside the result so the caller can keep that turn. A run whose
// anchor is gone (branch rewritten/truncated) is discarded instead of
// committed. The module deliberately holds no singleton state — callers own
// the instance and decide when it is created or cancelled.
import type { Message } from '../../../types/message.js'
import { speculationLeadTokens, type CompactionOutcome } from '../contracts.js'

/** Default speculative result: a full outcome or a summary string. */
export type SpeculationResult = CompactionOutcome | string

/** Default time a run (and its armed result) may take before it is discarded. */
export const DEFAULT_SPECULATION_TIMEOUT_MS = 120_000

export interface SpeculationContext<TContext = undefined> {
  /** Live transcript; copied (and frozen) when a run starts. */
  messages: readonly Message[]
  tokenCount: number
  /** Compaction threshold for the current model/window. */
  thresholdTokens: number
  model: string
  /**
   * Opaque caller payload captured into the snapshot (e.g. the query's
   * toolUseContext/cache params). Kept on the context rather than module
   * state so a background run never reads a later iteration's live values.
   */
  runnerContext?: TContext
}

/** Read-only branch snapshot handed to the runner. */
export interface SpeculationSnapshot<TContext = undefined> {
  /**
   * Last message uuid covered by the snapshot; commit requires it to still be
   * the live anchor (at the same position). Appended messages are allowed.
   */
  lastUuid: string | undefined
  messages: readonly Message[]
  tokenCount: number
  thresholdTokens: number
  model: string
  startedAt: number
  /** Aborted when the run is cancelled, superseded, or times out. */
  signal: AbortSignal
  runnerContext?: TContext
}

/**
 * Background runner. Returning `undefined` (or rejecting) reports a failed
 * run; the manager frees the slot so a later band entry can retry.
 */
export type SpeculationRunner<TResult, TContext = undefined> = (
  snapshot: SpeculationSnapshot<TContext>,
) => TResult | undefined | Promise<TResult | undefined>

export interface SpeculationManagerOptions<TResult, TContext = undefined> {
  runner: SpeculationRunner<TResult, TContext>
  now?: () => number
  /** Defaults to false: callers must opt in. */
  enabled?: boolean
  timeoutMs?: number
}

/** Commit payload: the armed result plus the turn appended after the snapshot. */
export interface SpeculationConsumption<TResult> {
  result: TResult
  /**
   * Live messages that arrived after the snapshot's last message. The caller
   * applies the result and then appends these, so the post-snapshot turn is
   * never dropped.
   */
  appendedMessages: Message[]
}

export interface SpeculationManager<TResult, TContext = undefined> {
  /** Start one background run when `tokenCount` is in the pre-threshold band. */
  maybeStart(ctx: SpeculationContext<TContext>): boolean
  /**
   * Claim the armed result at threshold. Returns undefined when nothing is
   * armed, the run is still in flight, it failed/timed out, or the snapshot's
   * last message is no longer the live anchor (branch rewritten/truncated).
   */
  consume(
    ctx: SpeculationContext<TContext>,
  ): SpeculationConsumption<TResult> | undefined
  /** Abort and discard any in-flight or armed run. */
  cancel(): void
  state(): 'idle' | 'running' | 'armed'
}

interface SpeculationRun<TResult, TContext> {
  snapshot: SpeculationSnapshot<TContext>
  controller: AbortController
  armed?: { value: TResult }
  finishedAt?: number
  timer?: ReturnType<typeof setTimeout>
}

/**
 * Locate the messages appended after the snapshot in the live transcript.
 * Returns undefined when the snapshot is no longer an intact prefix (branch
 * rewritten, truncated from the front, or the anchor moved).
 *
 * The anchor is the snapshot's last message; it must still sit at the same
 * index. Earlier uuids are cross-checked when both sides carry one. With no
 * uuid on the last message we can only commit an unchanged transcript.
 */
function findAppendedMessages<TContext>(
  snapshot: SpeculationSnapshot<TContext>,
  live: readonly Message[],
): Message[] | undefined {
  const snapshotMessages = snapshot.messages
  const anchor = snapshot.lastUuid
  if (anchor === undefined) {
    if (live.length !== snapshotMessages.length) return undefined
    for (let i = 0; i < snapshotMessages.length; i++) {
      const before = snapshotMessages[i]?.uuid
      const now = live[i]?.uuid
      if (before !== undefined && now !== undefined && before !== now) {
        return undefined
      }
    }
    return []
  }
  const anchorIndex = live.findIndex(message => message.uuid === anchor)
  if (anchorIndex !== snapshotMessages.length - 1) return undefined
  for (let i = 0; i < snapshotMessages.length; i++) {
    const before = snapshotMessages[i]?.uuid
    const now = live[i]?.uuid
    if (before !== undefined && now !== undefined && before !== now) {
      return undefined
    }
  }
  return live.slice(anchorIndex + 1)
}

export function createSpeculationManager<
  TResult = SpeculationResult,
  TContext = undefined,
>(
  options: SpeculationManagerOptions<TResult, TContext>,
): SpeculationManager<TResult, TContext> {
  const now = options.now ?? (() => Date.now())
  const enabled = options.enabled ?? false
  const timeoutMs = options.timeoutMs ?? DEFAULT_SPECULATION_TIMEOUT_MS

  let run: SpeculationRun<TResult, TContext> | undefined

  const clearTimer = (target: SpeculationRun<TResult, TContext>): void => {
    if (target.timer !== undefined) {
      clearTimeout(target.timer)
      target.timer = undefined
    }
  }

  const discard = (target: SpeculationRun<TResult, TContext>): void => {
    if (run === target) run = undefined
    clearTimer(target)
    target.controller.abort()
  }

  const maybeStart = (ctx: SpeculationContext<TContext>): boolean => {
    if (!enabled) return false
    // One run at a time: an in-flight or armed run owns the slot.
    if (run) return false

    const thresholdTokens = Math.max(0, Math.floor(ctx.thresholdTokens))
    if (thresholdTokens <= 0) return false
    const leadTokens = speculationLeadTokens(thresholdTokens)
    const bandLowTokens = Math.max(0, thresholdTokens - leadTokens)
    if (ctx.tokenCount < bandLowTokens || ctx.tokenCount >= thresholdTokens) {
      return false
    }

    const controller = new AbortController()
    const snapshot: SpeculationSnapshot<TContext> = {
      lastUuid: ctx.messages.at(-1)?.uuid,
      messages: Object.freeze([...ctx.messages]),
      tokenCount: ctx.tokenCount,
      thresholdTokens,
      model: ctx.model,
      startedAt: now(),
      signal: controller.signal,
      ...(ctx.runnerContext !== undefined
        ? { runnerContext: ctx.runnerContext }
        : {}),
    }
    const current: SpeculationRun<TResult, TContext> = {
      snapshot,
      controller,
    }
    run = current
    const timer = setTimeout(() => {
      // A run that never settles must not occupy the slot forever.
      discard(current)
    }, timeoutMs)
    // Never keep a CLI process alive for a speculative run.
    timer.unref?.()
    current.timer = timer

    let pending: Promise<TResult | undefined>
    try {
      // Invoke synchronously so the runner captures its snapshot context
      // before the loop can advance to another iteration.
      pending = Promise.resolve(options.runner(snapshot))
    } catch {
      discard(current)
      return false
    }

    void pending.then(
      result => {
        if (run !== current || controller.signal.aborted) return
        if (result === undefined) {
          // The runner reported a failure; free the slot for a later retry.
          discard(current)
          return
        }
        current.finishedAt = now()
        clearTimer(current)
        current.armed = { value: result }
      },
      () => {
        if (run === current) discard(current)
      },
    )
    return true
  }

  const consume = (
    ctx: SpeculationContext<TContext>,
  ): SpeculationConsumption<TResult> | undefined => {
    if (!enabled) return undefined
    const current = run
    if (!current) return undefined
    // The consumer owns the slot from here on, armed or not.
    run = undefined
    clearTimer(current)

    if (current.armed === undefined) {
      // Still summarizing at threshold: do not block, just discard it.
      current.controller.abort()
      return undefined
    }
    if (
      current.finishedAt !== undefined &&
      current.finishedAt - current.snapshot.startedAt > timeoutMs
    ) {
      current.controller.abort()
      return undefined
    }
    const appendedMessages = findAppendedMessages(
      current.snapshot,
      ctx.messages,
    )
    if (appendedMessages === undefined) {
      current.controller.abort()
      return undefined
    }
    return { result: current.armed.value, appendedMessages }
  }

  const cancel = (): void => {
    if (run) discard(run)
  }

  return {
    maybeStart,
    consume,
    cancel,
    state: () =>
      run === undefined
        ? 'idle'
        : run.armed === undefined
          ? 'running'
          : 'armed',
  }
}
