// Asynchronous speculative compaction manager (COMPACTION_V2).
//
// The pure band decision lives in `triggers/speculation.ts`; this module owns
// the state machine around one background summarization run:
//
//   idle --maybeStart (in band)--> running --runner resolves--> armed
//   running --runner rejects / timeout--> idle
//   armed --consume (prefix intact)--> idle (result returned)
//   armed --consume (prefix changed) / timeout / cancel--> idle (discarded)
//
// The manager never blocks the query loop: `maybeStart` only schedules the
// injected runner, and `consume` never awaits an in-flight run. A run whose
// snapshot prefix no longer matches the live transcript is discarded instead
// of committed. The module deliberately holds no singleton state — callers
// own the instance and decide when it is created or cancelled.
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
  /** Last message uuid covered by the snapshot; commit requires it to match. */
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

export interface SpeculationManager<TResult, TContext = undefined> {
  /** Start one background run when `tokenCount` is in the pre-threshold band. */
  maybeStart(ctx: SpeculationContext<TContext>): boolean
  /**
   * Claim the armed result at threshold. Returns undefined when nothing is
   * armed, the run is still in flight, it failed/timed out, or the snapshot
   * prefix no longer matches the live transcript.
   */
  consume(ctx: SpeculationContext<TContext>): TResult | undefined
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

  const consume = (ctx: SpeculationContext<TContext>): TResult | undefined => {
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
    // Commit only when the summarized prefix is still the live prefix. The
    // last-uuid check is the cheap contract; the length check also catches a
    // transcript that was truncated from the front.
    const lastUuid = ctx.messages.at(-1)?.uuid
    if (
      current.snapshot.lastUuid !== lastUuid ||
      ctx.messages.length < current.snapshot.messages.length
    ) {
      current.controller.abort()
      return undefined
    }
    return current.armed.value
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
