import { feature } from 'bun:bundle'
import type { CompactionResult } from '../compact/compact.js'
import type { QuerySource } from '../../constants/querySource.js'
import type { Message } from '../../types/message.js'
import type { ToolUseContext } from '../../Tool.js'
import type { CacheSafeParams } from '../../utils/forkedAgent.js'
import type { APIProvider } from '../../utils/model/providerClassification.js'
import {
  DEFAULT_COMPACTION_SETTINGS,
  type CompactionContext,
  type CompactionMethod,
  type CompactionMethodName,
  type CompactionOutcome,
  type CompactionSettings,
  type EntryView,
  type TriggerReason,
} from './contracts.js'
import { evaluateProgressGuard } from './guards/progress.js'
import type { PayloadRejectionEvidence } from './guards/payload.js'
import { createHandoffMethod } from './methods/handoff.js'
import { indexMethods, resolveMethodOrder } from './methods/registry.js'
import {
  createRemoteMethod,
  isRemoteCompactionEnabled,
  type RemoteMethodDeps,
} from './methods/remote.js'
import { buildRemoteTransport } from './methods/remote/transport.js'
import { createShakeMethod, type ShakeReducer } from './methods/shake.js'
import {
  createSoftMethod,
  type SoftCompactRun,
  type SoftMethodDeps,
} from './methods/soft.js'
import { createSnapcompactMethod } from './methods/snapcompact.js'
import { createShakeReducer } from './reducers/shakeReducer.js'
import {
  annotateCompactionResult,
  type CompactionMethodMetadata,
} from './session/display.js'
import {
  appendCompactionEntry,
  boundAttachmentMetaPair,
  createCompactionSessionEntry,
  projectAttachmentMeta,
  type CompactionEntryAttachmentMeta,
  type CompactionSessionEntry,
} from './session/entries.js'
import { countContextTokens } from './tokens/contextCount.js'
import { estimateTokens } from './tokens/index.js'
import { evaluateIdleTrigger } from './triggers/idle.js'
import { evaluateIncompleteTrigger } from './triggers/incomplete.js'
import { evaluateManualTrigger } from './triggers/manual.js'
import { evaluateMidTurnTrigger } from './triggers/midTurn.js'
import {
  evaluateOverflowTrigger,
  type ContextPromotion,
} from './triggers/overflow.js'
import {
  collectPromotionCandidates,
  createContextPromotion,
} from './triggers/promotion.js'
import { evaluateThresholdTrigger } from './triggers/threshold.js'
import type {
  PromotionResult,
  ThresholdDecision,
  TriggerDecision,
} from './triggers/types.js'

export interface CompactionV2Tracking {
  compacted?: boolean
  turnCounter?: number
  consecutiveFailures?: number
}

export type DecisionOutcome =
  | 'selected'
  | 'skipped'
  | 'failed'
  | 'compacted'
  | 'reduced'
  | 'guard-blocked'

export interface DecisionTraceEntry {
  trigger: TriggerReason
  method: CompactionMethodName | null
  outcome: DecisionOutcome
  reason: string
  tokensSaved?: number
  headroomTokens?: number
  warning?: string
  at: number
}

export interface CompactionV2Request {
  model: string
  trigger: TriggerReason
  messages: readonly Message[]
  settings?: Partial<CompactionSettings>
  /** Effective context window; defaults to getEffectiveContextWindowSize(model). */
  windowTokens?: number
  /** Canonical context-size estimate; defaults to tokenCountWithEstimation. */
  tokenCount?: number
  stopReason?: string | null
  overflowDetected?: boolean
  payloadRejection?: PayloadRejectionEvidence
  lastActivityAt?: number
  instructions?: string
  abortSignal?: AbortSignal
  agentId?: string
}

export interface CompactionV2Options {
  methods?: readonly CompactionMethod[]
  soft?: SoftMethodDeps | null
  shake?: ShakeReducer | null
  remote?: RemoteMethodDeps | null
  promotion?: ContextPromotion | null
  resolveWindowTokens?: (model: string) => number
  countTokens?: (messages: readonly Message[]) => number
  estimateEntryTokens?: (entry: EntryView) => number
  now?: () => number
  onTrace?: (entry: DecisionTraceEntry) => void
  /** Reject a compacted outcome the caller cannot render (e.g. no legacy result). */
  canAcceptOutcome?: (outcome: CompactionOutcome) => boolean
  /** Gate a method before it runs (e.g. circuit-breaker skips API methods). */
  canRunMethod?: (name: CompactionMethodName) => boolean
  /**
   * Raw `settings.compaction` from settings.json. Merged below the explicit
   * request settings and above DEFAULT_COMPACTION_SETTINGS.
   */
  compactionSettings?: unknown
  /** Environment map for CLAUDE_CODE_COMPACTION_* overrides. Defaults to process.env. */
  env?: Record<string, string | undefined>
  /**
   * Compute-only mode (speculative runs): the chain runs to a usable outcome
   * but the journal entry and every commit-time side effect are skipped. The
   * caller must invoke `applyCompactionOutcome()` once the snapshot is still
   * valid. Default false keeps the direct path unchanged.
   */
  deferApply?: boolean
  /**
   * Override for the journal writer (tests). When omitted the feature flag
   * gates `persistCompactionEntry`, matching production behavior.
   */
  persist?: (
    outcome: CompactionOutcome,
    messages: readonly Message[],
  ) => Promise<unknown>
}

export interface CompactionV2Result {
  trigger: TriggerDecision
  threshold: ThresholdDecision
  promotion?: PromotionResult
  outcome?: CompactionOutcome
  trace: DecisionTraceEntry[]
  shouldCompact: boolean
}

export interface DefaultMethodOptions {
  soft?: SoftMethodDeps | null
  shake?: ShakeReducer | null
  remote?: RemoteMethodDeps | null
  instructions?: string
  resolveThresholdTokens?(ctx: CompactionContext): number | undefined
}

/** Build the default method chain: remote → snapcompact → handoff → shake → soft. */
export function createDefaultMethods(
  options: DefaultMethodOptions = {},
): CompactionMethod[] {
  const softDeps: SoftMethodDeps | null = options.soft
    ? {
        ...options.soft,
        instructions: options.instructions ?? options.soft.instructions,
        resolveThresholdTokens:
          options.resolveThresholdTokens ?? options.soft.resolveThresholdTokens,
      }
    : null
  return [
    createRemoteMethod(options.remote),
    createSnapcompactMethod(),
    createHandoffMethod(),
    createShakeMethod({
      reducer: options.shake ?? null,
      resolveThresholdTokens: options.resolveThresholdTokens,
    }),
    createSoftMethod(softDeps),
  ]
}

export function buildCompactionContext(input: {
  model: string
  trigger: TriggerReason
  messages: readonly Message[]
  settings: CompactionSettings
  countTokens: (messages: readonly Message[]) => number
  estimateEntryTokens?: (entry: EntryView) => number
  abortSignal?: AbortSignal
  agentId?: string
  now: () => number
}): CompactionContext {
  return {
    model: input.model,
    trigger: input.trigger,
    messages: input.messages,
    settings: input.settings,
    tokenCount: input.countTokens,
    estimateEntryTokens:
      input.estimateEntryTokens ??
      (entry => defaultEstimateEntryTokens(entry, input.model)),
    abortSignal: input.abortSignal,
    agentId: input.agentId,
    now: input.now,
  }
}

/**
 * Run the configured method chain for one trigger decision.
 *
 * Unavailable methods are skipped, failed methods fall through to the next
 * preference, and a compacted/reduced outcome must pass the progress guard
 * (≤80% of the threshold) before it is accepted. Every decision is recorded.
 */
export async function runCompactionV2(
  request: CompactionV2Request,
  options: CompactionV2Options = {},
): Promise<CompactionV2Result> {
  const settings = resolveSettings(request.settings, {
    compaction: options.compactionSettings,
    env: options.env,
  })
  const countTokens = options.countTokens ?? defaultCountTokens
  const tokenCount = request.tokenCount ?? countTokens(request.messages)
  const windowTokens =
    request.windowTokens ??
    (options.resolveWindowTokens ?? defaultResolveWindowTokens)(request.model)
  const now = options.now ?? (() => Date.now())
  const ctx = buildCompactionContext({
    model: request.model,
    trigger: request.trigger,
    messages: request.messages,
    settings,
    countTokens,
    estimateEntryTokens: options.estimateEntryTokens,
    abortSignal: request.abortSignal,
    agentId: request.agentId,
    now,
  })

  const trace: DecisionTraceEntry[] = []
  const record = (entry: Omit<DecisionTraceEntry, 'trigger' | 'at'>): void => {
    const full: DecisionTraceEntry = {
      trigger: request.trigger,
      at: now(),
      ...entry,
    }
    trace.push(full)
    options.onTrace?.(full)
  }

  let triggerDecision: TriggerDecision
  switch (request.trigger) {
    case 'manual':
      triggerDecision = evaluateManualTrigger({
        tokenCount,
        windowTokens,
        settings,
      })
      break
    case 'threshold':
      triggerDecision = evaluateThresholdTrigger({
        tokenCount,
        windowTokens,
        settings,
      })
      break
    case 'midTurn':
      triggerDecision = evaluateMidTurnTrigger({
        tokenCount,
        windowTokens,
        settings,
      })
      break
    case 'incomplete':
      triggerDecision = evaluateIncompleteTrigger({
        tokenCount,
        windowTokens,
        settings,
        stopReason: request.stopReason,
      })
      break
    case 'idle':
      triggerDecision = evaluateIdleTrigger({
        tokenCount,
        windowTokens,
        settings,
        lastActivityAt: request.lastActivityAt,
        now: now(),
      })
      break
    case 'overflow':
      triggerDecision = await evaluateOverflowTrigger({
        tokenCount,
        windowTokens,
        settings,
        ctx,
        overflowDetected: request.overflowDetected,
        payloadRejection: request.payloadRejection,
        promotion: options.promotion ?? null,
      })
      break
  }

  const result: CompactionV2Result = {
    trigger: triggerDecision,
    threshold: triggerDecision.threshold,
    promotion: triggerDecision.promotion,
    trace,
    shouldCompact: triggerDecision.shouldCompact,
  }

  if (!triggerDecision.shouldCompact) {
    record({
      method: null,
      outcome: 'skipped',
      reason: triggerDecision.reason,
      headroomTokens: triggerDecision.threshold.headroomTokens,
    })
    return result
  }

  const order = resolveMethodOrder(settings.methodOrder)
  const methods = indexMethods(
    options.methods ??
      createDefaultMethods({
        soft: options.soft,
        shake: options.shake,
        remote: options.remote,
        instructions: request.instructions,
        resolveThresholdTokens: () => triggerDecision.threshold.thresholdTokens,
      }),
  )

  for (const name of order) {
    const method = methods.get(name)
    if (!method) {
      record({
        method: name,
        outcome: 'skipped',
        reason: 'method-not-registered',
      })
      continue
    }
    if (options.canRunMethod && !options.canRunMethod(name)) {
      record({
        method: name,
        outcome: 'skipped',
        reason: 'circuit-open',
      })
      continue
    }
    if (
      triggerDecision.payload?.excludeMediaMethods &&
      name === 'snapcompact'
    ) {
      record({
        method: name,
        outcome: 'skipped',
        reason: 'payload-rejection-excludes-media',
      })
      continue
    }
    if (!method.isAvailable(ctx)) {
      record({ method: name, outcome: 'skipped', reason: 'unavailable' })
      continue
    }

    let outcome: CompactionOutcome
    try {
      outcome = await method.run(ctx)
    } catch (error) {
      record({
        method: name,
        outcome: 'failed',
        reason: error instanceof Error ? error.message : String(error),
      })
      continue
    }

    if (outcome.kind === 'skipped') {
      record({ method: name, outcome: 'skipped', reason: outcome.reason })
      continue
    }
    if (outcome.kind === 'failed') {
      record({ method: name, outcome: 'failed', reason: outcome.reason })
      continue
    }

    const afterTokens = Math.max(0, tokenCount - outcome.tokensSaved)
    const thresholdTokens = triggerDecision.threshold.thresholdTokens
    // An unknown window (threshold 0) cannot be progress-checked; overflow
    // recovery there only needs the outcome to fit the window.
    const progress =
      thresholdTokens > 0
        ? evaluateProgressGuard(thresholdTokens, afterTokens)
        : {
            ok: true,
            reason: undefined,
            headroomTokens: outcome.headroomTokens,
          }
    const headroomTokens = progress.headroomTokens ?? outcome.headroomTokens
    // A reduced outcome has no side effects yet, so a failed guard can simply
    // fall through. A non-soft compacted method can also fall through: it has
    // not committed the legacy summary. Soft is the exception — its summary
    // and cleanup already ran, so discarding it would lose those effects; keep
    // it and surface the guard warning instead.
    if (
      !progress.ok &&
      (outcome.kind === 'reduced' ||
        (outcome.kind === 'compacted' && outcome.method !== 'soft'))
    ) {
      record({
        method: name,
        outcome: 'guard-blocked',
        reason: progress.reason ?? 'progress-guard',
        tokensSaved: outcome.tokensSaved,
        headroomTokens,
      })
      continue
    }
    // Callers that can only consume the legacy CompactionResult pass
    // `canAcceptOutcome`; an unrenderable compacted outcome then falls
    // through to the next method (soft) instead of returning a no-op.
    if (
      outcome.kind === 'compacted' &&
      options.canAcceptOutcome &&
      !options.canAcceptOutcome(outcome)
    ) {
      record({
        method: name,
        outcome: 'skipped',
        reason: 'unrenderable-compacted-outcome',
        tokensSaved: outcome.tokensSaved,
        headroomTokens,
      })
      continue
    }
    if (!progress.ok && outcome.kind === 'compacted') {
      outcome.warning = progress.reason ?? 'progress-guard'
    }

    record({
      method: name,
      outcome: outcome.kind,
      reason: outcome.kind === 'compacted' ? 'compacted' : 'reduced',
      tokensSaved: outcome.tokensSaved,
      headroomTokens,
      warning: outcome.warning,
    })
    result.outcome = outcome
    if (outcome.kind === 'compacted' && !options.deferApply) {
      // Preview runs return the outcome untouched; the commit path journals it.
      if (options.persist) {
        await options.persist(outcome, request.messages)
      } else if (feature('COMPACTION_V2')) {
        await persistCompactionEntry(outcome, request.messages)
      }
    }
    return result
  }

  record({
    method: null,
    outcome: 'skipped',
    reason: 'all-methods-unavailable-or-failed',
    headroomTokens: triggerDecision.threshold.headroomTokens,
  })
  return result
}

// ---------------------------------------------------------------------------
// Session journaling (COMPACTION_V2). A compacted outcome is persisted as a
// standalone `compaction` JSONL row so resume can rebuild from it. Legacy
// transcript writes are untouched; with the flag off nothing is written.
// ---------------------------------------------------------------------------

export interface PersistCompactionEntryOptions {
  /** `false` simulates the feature flag being off (tests / direct calls). */
  enabled?: boolean
  append?: (entry: CompactionSessionEntry) => Promise<void>
  uuid?: () => CompactionSessionEntry['uuid']
  now?: () => number
}

/**
 * Persist a successful compaction outcome. Soft always has a summary (the
 * legacy summary message); remote/snapcompact only journal when the provider
 * returned one. Failures are swallowed — journaling must never fail the
 * compaction itself.
 */
export async function persistCompactionEntry(
  outcome: CompactionOutcome | undefined,
  messages: readonly Message[],
  options: PersistCompactionEntryOptions = {},
): Promise<CompactionSessionEntry | null> {
  if (options.enabled === false) return null
  if (outcome?.kind !== 'compacted') return null
  const summary = resolveCompactionSummary(outcome)
  if (!summary) return null

  const legacy = getLegacyCompactionResult(outcome)
  const meta = boundAttachmentMetaPair(
    projectAttachmentMetas(legacy?.attachments),
    projectAttachmentMetas(legacy?.hookResults),
  )

  const entry = createCompactionSessionEntry({
    summary,
    firstKeptEntryId: outcome.cutPoint.firstKeptEntryId,
    tokensBefore: outcome.cutPoint.tokensBefore,
    method: outcome.method,
    preserveData: slimPreserveData(outcome.preserveData),
    ...meta,
    parentUuid: messages.at(-1)?.uuid,
    uuid: options.uuid?.(),
    timestamp: options.now ? new Date(options.now()).toISOString() : undefined,
  })

  try {
    await (options.append ?? appendCompactionEntry)(entry)
  } catch {
    return null
  }
  return entry
}

export interface ApplyCompactionOutcomeContext {
  /** Transcript the preview summary was computed from. */
  messages?: readonly Message[]
  /** Compacting query source (cleanup scope + journal metadata). */
  querySource?: QuerySource
  /**
   * Override the soft-path notification flag (defaults to the post-compaction
   * marker used by the direct path). Kept injectable for the commit tests.
   */
  applySideEffects?: (messages: readonly Message[]) => void
}

/** Injectable commit-time dependencies (tests). */
export interface ApplyCompactionOutcomeDeps {
  persist?: (
    outcome: CompactionOutcome,
    messages: readonly Message[],
  ) => Promise<unknown>
  resetLastSummarizedMessageId?: (id: undefined) => void
  cleanup?: (querySource?: QuerySource) => void
}

/**
 * Commit a preview outcome: apply the same effects the direct path performs
 * inside `compactConversation` / the soft runner, then journal the entry.
 *
 * Soft compactions own the legacy transcript/session writes (session metadata,
 * transcript segment, post-compaction marker, summarized-id reset, cleanup);
 * other compacted methods only journal. Call exactly once per committed
 * preview — discarded previews must never reach this function.
 */
export async function applyCompactionOutcome(
  outcome: CompactionOutcome | undefined,
  ctx: ApplyCompactionOutcomeContext = {},
  deps: ApplyCompactionOutcomeDeps = {},
): Promise<CompactionSessionEntry | null> {
  if (outcome?.kind !== 'compacted') return null
  const messages = ctx.messages ?? []
  if (outcome.method === 'soft') {
    const applySideEffects =
      ctx.applySideEffects ?? loadCompact().applyCompactConversationSideEffects
    applySideEffects(messages)
    const reset =
      deps.resetLastSummarizedMessageId ??
      loadSessionMemory().setLastSummarizedMessageId
    reset(undefined)
    const cleanup =
      deps.cleanup ?? loadPostCompactCleanup().runPostCompactCleanup
    cleanup(ctx.querySource)
  }
  const persist = deps.persist ?? persistCompactionEntry
  return (await persist(outcome, messages)) as CompactionSessionEntry | null
}

function resolveCompactionSummary(
  outcome: CompactionOutcome,
): string | undefined {
  // Soft's `summary` is the display message; the actual summary text lives in
  // the legacy summary message and is what resume should inject.
  const legacy = getLegacyCompactionResult(outcome)
  const legacySummary = legacy?.summaryMessages?.[0]?.message?.content
  if (typeof legacySummary === 'string' && legacySummary.length > 0) {
    return legacySummary
  }
  if (
    outcome.kind === 'compacted' &&
    typeof outcome.summary === 'string' &&
    outcome.summary.length > 0
  ) {
    return outcome.summary
  }
  return undefined
}

function projectAttachmentMetas(
  messages: readonly Message[] | undefined,
): CompactionEntryAttachmentMeta[] {
  if (!messages) return []
  const metas: CompactionEntryAttachmentMeta[] = []
  for (const message of messages) {
    const meta = projectAttachmentMeta(message)
    if (meta) metas.push(meta)
  }
  return metas
}

/**
 * Slim `preserveData` before journaling:
 * - drop the full legacy CompactionResult (its `messagesToKeep` duplicate
 *   transcript bytes already on disk),
 * - drop snapcompact `frames` base64 and keep only their count, so the row
 *   stays small while the archive's `text`/`textHead`/`textTail` remain
 *   available for text-mode resume.
 */
function slimPreserveData(
  data: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!data) return undefined
  const rest: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(data)) {
    if (key === 'legacyCompactionResult') continue
    rest[key] = key === 'snapcompact' ? slimSnapcompactArchive(value) : value
  }
  return Object.keys(rest).length > 0 ? rest : undefined
}

function slimSnapcompactArchive(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  const archive = value as Record<string, unknown>
  if (!Array.isArray(archive.frames)) return archive
  const { frames, ...rest } = archive
  return { ...rest, frameCount: frames.length }
}

// ---------------------------------------------------------------------------
// Production adapters. Everything below is only reachable when COMPACTION_V2
// is enabled; legacy modules are loaded lazily so the pure decision graph
// stays testable without the legacy compaction dependency chain.
// ---------------------------------------------------------------------------

export interface CompactionV2QueryRequest {
  messages: Message[]
  model: string
  trigger: TriggerReason
  tokenCount: number
  toolUseContext: ToolUseContext
  cacheSafeParams: CacheSafeParams
  querySource?: QuerySource
  instructions?: string
  stopReason?: string | null
  overflowDetected?: boolean
  payloadRejection?: PayloadRejectionEvidence
  lastActivityAt?: number
  tracking?: CompactionV2Tracking
  /** Trigger tuning (e.g. midTurnEnabled). Defaults match DEFAULT_COMPACTION_SETTINGS. */
  settings?: Partial<CompactionSettings>
  /**
   * Set false to suppress context promotion (e.g. after the one-shot
   * promotion retry already ran) so an overflow compacts instead.
   */
  allowPromotion?: boolean
  /**
   * Compute-only preview (speculative compaction): skip journaling and every
   * commit-time side effect, and return a `deferredApply` payload on success.
   */
  deferApply?: boolean
  /**
   * Report this context size to the trigger instead of the measured count.
   * Speculative runs summarize a pre-threshold snapshot but must still run
   * the threshold chain.
   */
  tokenCountOverride?: number
}

/** Payload a preview run hands back for `applyCompactionOutcome`. */
export interface DeferredCompactionApply {
  outcome: CompactionOutcome
  /** Transcript the summary was computed from (the frozen snapshot). */
  messages: Message[]
}

export interface CompactionV2QueryResult {
  wasCompacted: boolean
  compactionResult?: CompactionResult
  consecutiveFailures?: number
  /** Mechanical reduction (shake) to use for this request only. */
  reducedMessages?: Message[]
  /** Context-promotion decision from the overflow trigger, when applicable. */
  promotion?: PromotionResult
  /** Tokens removed by the reduction (drives the one-shot UI notice). */
  reducedTokensSaved?: number
  reducedMethod?: CompactionMethodName
  /**
   * Present when the request ran with `deferApply: true`: the caller owns
   * commit-time application via `applyCompactionOutcome`.
   */
  deferredApply?: DeferredCompactionApply
}

/**
 * Query-loop adapter: runs the v2 chain with the legacy soft runner and
 * returns the same shape as `autoCompactIfNeeded` so the existing result
 * handling in query.ts stays untouched.
 */
export async function runCompactionV2ForQuery(
  request: CompactionV2QueryRequest,
): Promise<CompactionV2QueryResult> {
  const {
    getEffectiveContextWindowSize,
    getAutoCompactThreshold,
    isAutoCompactEnabled,
    MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES,
  } = loadAutoCompact()
  // Same guards as legacy shouldAutoCompact: never compact inside the compact
  // or session-memory forks (the compact fork runs query() with
  // querySource='compact' and would otherwise re-enter this branch forever),
  // and honor DISABLE_COMPACT / DISABLE_AUTO_COMPACT / autoCompactEnabled.
  if (!isAutoCompactEnabled()) return { wasCompacted: false }
  const compactionSettings = loadCompactionSettings()
  if (!isCompactionEnabledInSettings(compactionSettings)) {
    return { wasCompacted: false }
  }
  // Circuit breaker: once the API-backed methods have failed this many turns
  // in a row, skip them. Local reducers (shake/snapcompact) stay available —
  // they need no model call and are the only recovery left.
  const circuitOpen =
    (request.tracking?.consecutiveFailures ?? 0) >=
    MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES
  if (
    request.querySource === 'compact' ||
    request.querySource === 'session_memory'
  ) {
    return { wasCompacted: false }
  }
  // Match the remaining legacy shouldAutoCompact suppressions: context
  // collapse owns the headroom problem when enabled, and reactive-only mode
  // leaves overflow recovery to the API error path.
  if (feature('CONTEXT_COLLAPSE')) {
    if (request.querySource === 'marble_origami') {
      return { wasCompacted: false }
    }
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { isContextCollapseEnabled } =
      require('../contextCollapse/index.js') as typeof import('../contextCollapse/index.js')
    /* eslint-enable @typescript-eslint/no-require-imports */
    if (isContextCollapseEnabled()) return { wasCompacted: false }
  }
  if (feature('REACTIVE_COMPACT')) {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { getFeatureValue_CACHED_MAY_BE_STALE } =
      require('../analytics/growthbook.js') as typeof import('../analytics/growthbook.js')
    /* eslint-enable @typescript-eslint/no-require-imports */
    if (getFeatureValue_CACHED_MAY_BE_STALE('tengu_cobalt_raccoon', false)) {
      return { wasCompacted: false }
    }
  }
  const windowTokens = getEffectiveContextWindowSize(request.model)
  const autoCompactThreshold = getAutoCompactThreshold(request.model)
  // omp-style measurement: the last provider usage block anchors the count and
  // only the messages after it are tokenized. The caller's `tokenCount` is a
  // legacy estimate and is deliberately not used on this path. An explicit
  // override is only for preview runs whose snapshot sits below the threshold.
  const tokenCount =
    request.tokenCountOverride ??
    countContextTokens(request.messages, request.model).tokens

  // Remote compaction is opt-in. Build the provider-bound transport lazily so
  // the flag-off path never touches auth, and a missing transport keeps the
  // existing lane-unavailable / transport-missing skips.
  const remote = isRemoteCompactionEnabled()
    ? createQueryRemoteDeps(request.model)
    : null

  const result = await runCompactionV2(
    {
      model: request.model,
      trigger: request.trigger,
      messages: request.messages,
      windowTokens,
      tokenCount,
      stopReason: request.stopReason,
      overflowDetected: request.overflowDetected,
      payloadRejection: request.payloadRejection,
      lastActivityAt: request.lastActivityAt,
      instructions: request.instructions,
      settings: request.settings,
      agentId: request.toolUseContext.agentId,
      abortSignal: request.toolUseContext.abortController?.signal,
    },
    {
      soft: createLegacySoftDeps({
        toolUseContext: request.toolUseContext,
        cacheSafeParams: request.cacheSafeParams,
        querySource: request.querySource,
        tokenCount,
        autoCompactThreshold,
        tracking: request.tracking,
        deferApply: request.deferApply,
      }),
      shake: createShakeReducer(),
      remote,
      // Promotion is a decision only; the caller owns the model switch/retry.
      promotion:
        request.allowPromotion === false ? null : createQueryPromotion(),
      // The query loop only understands the legacy CompactionResult; let an
      // unrenderable remote/snapcompact outcome fall through to soft.
      canAcceptOutcome: outcome =>
        outcome.kind !== 'compacted' ||
        getLegacyCompactionResult(outcome) !== undefined,
      canRunMethod: name =>
        !circuitOpen || name === 'snapcompact' || name === 'shake',
      resolveWindowTokens: getEffectiveContextWindowSize,
      compactionSettings,
      deferApply: request.deferApply,
    },
  )

  if (result.outcome?.kind === 'reduced') {
    return {
      wasCompacted: false,
      reducedMessages: result.outcome.messages,
      reducedTokensSaved: result.outcome.tokensSaved,
      reducedMethod: result.outcome.method,
      // A successful local reduction resets the failure streak.
      consecutiveFailures: 0,
      promotion: result.promotion,
    }
  }
  if (result.outcome?.kind === 'compacted') {
    const outcome = result.outcome
    const legacyResult = getLegacyCompactionResult(outcome)
    if (legacyResult) {
      return {
        wasCompacted: true,
        compactionResult: annotateCompactionResult(
          legacyResult,
          outcome.method,
          methodMetadata(outcome),
        ),
        promotion: result.promotion,
        ...(request.deferApply
          ? {
              deferredApply: {
                outcome,
                messages: [...request.messages],
              },
            }
          : {}),
      }
    }
  }
  if (result.shouldCompact) {
    // A threshold pass was needed but no method produced a usable result.
    // Propagate the cumulative failure count so query.ts's circuit breaker
    // can stop retrying, matching autoCompactIfNeeded.
    return {
      wasCompacted: false,
      consecutiveFailures: (request.tracking?.consecutiveFailures ?? 0) + 1,
      promotion: result.promotion,
    }
  }
  return { wasCompacted: false, promotion: result.promotion }
}

export interface ManualCompactionV2Request {
  messages: Message[]
  model: string
  toolUseContext: ToolUseContext
  cacheSafeParams: CacheSafeParams
  querySource?: QuerySource
  /** `/compact [instructions]` focus text. */
  instructions?: string
  settings?: Partial<CompactionSettings>
}

/**
 * Manual `/compact` adapter. Unlike the automatic triggers this does not
 * consult `isAutoCompactEnabled` (the user explicitly asked) and does not
 * exclude the `compact` query source (the command itself may carry it).
 * It still honors abort and the method chain's own availability guards.
 *
 * Returns undefined when the chain produced no legacy `CompactionResult`
 * (e.g. every method failed or only a mechanical reduction ran) so the
 * caller can fall back to the legacy command path.
 */
export async function runManualCompactionV2(
  request: ManualCompactionV2Request,
): Promise<CompactionResult | undefined> {
  if (request.toolUseContext.abortController?.signal.aborted) return undefined
  const { getEffectiveContextWindowSize, getAutoCompactThreshold } =
    loadAutoCompact()
  const tokenCount = defaultCountTokens(request.messages)
  const result = await runCompactionV2(
    {
      model: request.model,
      trigger: 'manual',
      messages: request.messages,
      windowTokens: getEffectiveContextWindowSize(request.model),
      tokenCount,
      instructions: request.instructions,
      settings: request.settings,
      agentId: request.toolUseContext.agentId,
      abortSignal: request.toolUseContext.abortController?.signal,
    },
    {
      soft: createLegacySoftDeps({
        toolUseContext: request.toolUseContext,
        cacheSafeParams: request.cacheSafeParams,
        querySource: request.querySource,
        tokenCount,
        autoCompactThreshold: getAutoCompactThreshold(request.model),
      }),
      shake: createShakeReducer(),
      // `/compact` must return a legacy CompactionResult. A non-soft compacted
      // outcome without one falls through to soft (which always carries it).
      canAcceptOutcome: outcome =>
        outcome.kind !== 'compacted' ||
        getLegacyCompactionResult(outcome) !== undefined,
      resolveWindowTokens: getEffectiveContextWindowSize,
      compactionSettings: loadCompactionSettings(),
    },
  )
  if (result.outcome?.kind !== 'compacted') return undefined
  const legacyResult = getLegacyCompactionResult(result.outcome)
  if (!legacyResult) return undefined
  return annotateCompactionResult(
    legacyResult,
    result.outcome.method,
    methodMetadata(result.outcome),
  )
}

export interface IdleCompactionV2Request {
  messages: Message[]
  model: string
  toolUseContext: ToolUseContext
  cacheSafeParams: CacheSafeParams
  querySource?: QuerySource
  lastActivityAt: number
  settings?: Partial<CompactionSettings>
}

export interface IdleCompactionV2Result {
  compacted: boolean
  messages?: Message[]
  trace: DecisionTraceEntry[]
}

/**
 * Idle maintenance adapter. The caller only invokes this when idle
 * maintenance is explicitly enabled, so force `idleEnabled` here; the default
 * settings would otherwise make the trigger a permanent no-op.
 */
export async function runIdleCompactionV2(
  request: IdleCompactionV2Request,
): Promise<IdleCompactionV2Result> {
  const {
    getEffectiveContextWindowSize,
    getAutoCompactThreshold,
    isAutoCompactEnabled,
  } = loadAutoCompact()
  // Idle is still automatic compaction: honor DISABLE_COMPACT /
  // DISABLE_AUTO_COMPACT / autoCompactEnabled even when the env opt-in is set.
  if (!isAutoCompactEnabled()) return { compacted: false, trace: [] }
  const compactionSettings = loadCompactionSettings()
  if (!isCompactionEnabledInSettings(compactionSettings)) {
    return { compacted: false, trace: [] }
  }
  // An explicit idleEnabled:false wins over the env opt-in.
  if (
    compactionSettings &&
    typeof compactionSettings === 'object' &&
    (compactionSettings as Record<string, unknown>).idleEnabled === false
  ) {
    return { compacted: false, trace: [] }
  }
  const tokenCount = defaultCountTokens(request.messages)
  const result = await runCompactionV2(
    {
      model: request.model,
      trigger: 'idle',
      messages: request.messages,
      settings: {
        ...request.settings,
        idleEnabled: request.settings?.idleEnabled ?? true,
      },
      windowTokens: getEffectiveContextWindowSize(request.model),
      tokenCount,
      lastActivityAt: request.lastActivityAt,
      agentId: request.toolUseContext.agentId,
      abortSignal: request.toolUseContext.abortController?.signal,
    },
    {
      soft: createLegacySoftDeps({
        toolUseContext: request.toolUseContext,
        cacheSafeParams: request.cacheSafeParams,
        querySource: request.querySource,
        tokenCount,
        autoCompactThreshold: getAutoCompactThreshold(request.model),
      }),
      resolveWindowTokens: getEffectiveContextWindowSize,
      compactionSettings,
    },
  )

  if (result.outcome?.kind === 'compacted') {
    const legacyResult = getLegacyCompactionResult(result.outcome)
    if (legacyResult) {
      const { buildPostCompactMessages } = loadCompact()
      return {
        compacted: true,
        messages: buildPostCompactMessages(
          annotateCompactionResult(
            legacyResult,
            result.outcome.method,
            methodMetadata(result.outcome),
          ),
        ),
        trace: result.trace,
      }
    }
  }
  return { compacted: false, trace: result.trace }
}

/**
 * Resolve the provider once and build its transport. No credentials are read
 * here beyond what `buildRemoteTransport` resolves synchronously; Google
 * tokens are fetched per request inside the returned fetch.
 */
function createQueryRemoteDeps(model: string): RemoteMethodDeps {
  const env = process.env
  let provider: APIProvider | undefined
  try {
    const { getAPIProvider } = require('../../utils/model/providers.js') as {
      getAPIProvider(): APIProvider
    }
    provider = getAPIProvider()
  } catch {
    provider = undefined
  }
  if (!provider) return { env }
  const transport = buildRemoteTransport({ provider, model, env })
  return {
    env,
    provider,
    ...(transport
      ? {
          fetch: transport.fetch,
          apiKey: transport.apiKey,
          baseUrl: transport.baseUrl,
        }
      : {}),
  }
}

/**
 * Promotion candidates come from `contextWindowOverrides`: those entries are
 * explicit user intent about a model's true window. No overrides → no
 * promotion, so the overflow path is unchanged for existing users.
 */
function createQueryPromotion(): ContextPromotion | null {
  try {
    const { getInitialSettings } =
      require('../../utils/settings/settings.js') as {
        getInitialSettings(): {
          contextWindowOverrides?: Record<string, number>
        }
      }
    const overrides = getInitialSettings().contextWindowOverrides
    if (!overrides) return null
    const candidates = collectPromotionCandidates({
      windowOverrides: overrides,
    })
    if (candidates.length === 0) return null
    return createContextPromotion({
      candidates,
      resolveWindow: model =>
        loadAutoCompact().getEffectiveContextWindowSize(model),
    })
  } catch {
    return null
  }
}

/**
 * Read `settings.compaction` from settings.json. The settings module is loaded
 * lazily so the pure decision graph (and its tests) never touches disk.
 */
function loadCompactionSettings(): unknown {
  try {
    const { getCompactionSettings } =
      require('../../utils/settings/settings.js') as {
        getCompactionSettings(): unknown
      }
    return getCompactionSettings()
  } catch {
    return undefined
  }
}

/**
 * Automatic triggers honor `compaction.enabled` (default true). An explicit
 * CLAUDE_CODE_COMPACTION_ENABLED wins. Manual `/compact` is never gated by it.
 */
function isCompactionEnabledInSettings(
  settings: unknown,
  env: Record<string, string | undefined> = process.env,
): boolean {
  const fromEnv = envBoolean(env, 'CLAUDE_CODE_COMPACTION_ENABLED')
  if (fromEnv !== undefined) return fromEnv
  if (settings && typeof settings === 'object') {
    const enabled = (settings as Record<string, unknown>).enabled
    if (enabled === false) return false
  }
  return true
}

type CompactConversationFn =
  typeof import('../compact/compact.js')['compactConversation']

export interface LegacySoftDepsInput {
  toolUseContext: ToolUseContext
  cacheSafeParams: CacheSafeParams
  querySource?: QuerySource
  tokenCount: number
  autoCompactThreshold: number
  tracking?: CompactionV2Tracking
  /**
   * Compute-only preview: `compactConversation` skips its session/transcript
   * writes and the cleanup/reset below are deferred to the commit path.
   */
  deferApply?: boolean
  /** Test seams; production uses the legacy modules. */
  compactConversation?: CompactConversationFn
  runPostCompactCleanup?: (querySource?: QuerySource) => void
  setLastSummarizedMessageId?: (id: undefined) => void
}

/**
 * Build the soft-method runner around the legacy `compactConversation` path.
 *
 * Direct calls preserve the historical behavior: summarize, then reset the
 * summarized-message id and run post-compact cleanup immediately. Preview
 * (`deferApply`) calls only summarize; those writes happen in
 * `applyCompactionOutcome` when the result is committed.
 */
export function createLegacySoftDeps(
  input: LegacySoftDepsInput,
): SoftMethodDeps {
  return {
    run: async request => {
      const compactConversation =
        input.compactConversation ?? loadCompact().compactConversation
      const isAutoCompact = request.trigger !== 'manual'
      const result = await compactConversation(
        [...request.messages],
        input.toolUseContext,
        input.cacheSafeParams,
        isAutoCompact,
        request.instructions,
        isAutoCompact,
        {
          isRecompactionInChain: input.tracking?.compacted === true,
          turnsSincePreviousCompact: input.tracking?.turnCounter ?? -1,
          autoCompactThreshold: input.autoCompactThreshold,
          querySource: input.querySource,
        },
        { deferApply: input.deferApply === true },
      )
      if (!input.deferApply) {
        const setLastSummarizedMessageId =
          input.setLastSummarizedMessageId ??
          loadSessionMemory().setLastSummarizedMessageId
        const runPostCompactCleanup =
          input.runPostCompactCleanup ??
          loadPostCompactCleanup().runPostCompactCleanup
        setLastSummarizedMessageId(undefined)
        runPostCompactCleanup(input.querySource)
      }
      return {
        result,
        tokensBefore: result.preCompactTokenCount ?? input.tokenCount,
        tokensAfter:
          result.truePostCompactTokenCount ?? result.postCompactTokenCount ?? 0,
      } satisfies SoftCompactRun
    },
  }
}

function methodMetadata(
  outcome: Extract<CompactionOutcome, { kind: 'compacted' }>,
): CompactionMethodMetadata {
  return {
    tokensSaved: outcome.tokensSaved,
    ...(outcome.warning !== undefined && { warning: outcome.warning }),
  }
}

function getLegacyCompactionResult(
  outcome: CompactionOutcome | undefined,
): CompactionResult | undefined {
  if (outcome?.kind !== 'compacted') return undefined
  const candidate = outcome.preserveData?.legacyCompactionResult
  if (
    typeof candidate === 'object' &&
    candidate !== null &&
    'boundaryMarker' in candidate &&
    'summaryMessages' in candidate
  ) {
    return candidate as CompactionResult
  }
  // Remote/snapcompact outcomes carry a summary and cut point but no legacy
  // result. Build the minimal shape the query loop/transcript understand so
  // the result is not discarded and soft does not run a second summary call.
  if (typeof outcome.summary === 'string' && outcome.summary.length > 0) {
    return buildLegacyResultFromOutcome(outcome)
  }
  return undefined
}

function buildLegacyResultFromOutcome(
  outcome: Extract<CompactionOutcome, { kind: 'compacted' }>,
): CompactionResult {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { createUserMessage } =
    require('../../utils/messages.js') as typeof import('../../utils/messages.js')
  /* eslint-enable @typescript-eslint/no-require-imports */
  const summary = outcome.summary
  if (!summary) {
    throw new Error('compacted outcome has no summary')
  }
  const tokensBefore = outcome.cutPoint.tokensBefore
  const tokensAfter = Math.max(0, tokensBefore - outcome.tokensSaved)
  return {
    boundaryMarker: outcome.cutPoint.boundaryMessage,
    summaryMessages: [
      createUserMessage({
        content: summary,
        isCompactSummary: true,
        isVisibleInTranscriptOnly: true,
      }),
    ],
    attachments: [],
    hookResults: [],
    preCompactTokenCount: tokensBefore,
    postCompactTokenCount: tokensAfter,
    truePostCompactTokenCount: tokensAfter,
  }
}

function defaultCountTokens(messages: readonly Message[]): number {
  const { tokenCountWithEstimation } = loadTokens()
  return tokenCountWithEstimation([...messages])
}

function defaultResolveWindowTokens(model: string): number {
  const { getEffectiveContextWindowSize } = loadAutoCompact()
  return getEffectiveContextWindowSize(model)
}

/** Local mirror of CompactionMethodName (avoids importing the settings schema). */
const COMPACTION_METHOD_NAMES: readonly CompactionMethodName[] = [
  'remote',
  'snapcompact',
  'handoff',
  'shake',
  'soft',
]

function isCompactionMethodName(value: unknown): value is CompactionMethodName {
  return (
    typeof value === 'string' &&
    (COMPACTION_METHOD_NAMES as readonly string[]).includes(value)
  )
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

function asPositiveInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
    ? value
    : undefined
}

function asNonNegativeInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
    ? value
    : undefined
}

function asThresholdPercent(value: unknown): number | undefined {
  const percent = asPositiveInt(value)
  return percent !== undefined && percent <= 99 ? percent : undefined
}

function asIdleTimeout(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 60
    ? value
    : undefined
}

/** Filter unknown method names; an empty result is treated as invalid. */
function sanitizeMethodOrder(
  value: unknown,
): CompactionMethodName[] | undefined {
  if (!Array.isArray(value)) return undefined
  const filtered = value.filter(isCompactionMethodName)
  return filtered.length > 0 ? filtered : undefined
}

function envValue(
  env: Record<string, string | undefined>,
  name: string,
): string | undefined {
  const raw = env[name]
  if (raw === undefined) return undefined
  const trimmed = raw.trim()
  return trimmed === '' ? undefined : trimmed
}

function envBoolean(
  env: Record<string, string | undefined>,
  name: string,
): boolean | undefined {
  const raw = envValue(env, name)?.toLowerCase()
  if (raw === undefined) return undefined
  if (raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on') {
    return true
  }
  if (raw === '0' || raw === 'false' || raw === 'no' || raw === 'off') {
    return false
  }
  return undefined
}

function envInteger(
  env: Record<string, string | undefined>,
  name: string,
  guard: (value: unknown) => number | undefined,
): number | undefined {
  const raw = envValue(env, name)
  if (raw === undefined) return undefined
  return guard(Number(raw))
}

function envMethodOrder(
  env: Record<string, string | undefined>,
  name: string,
): CompactionMethodName[] | undefined {
  const raw = envValue(env, name)
  if (raw === undefined) return undefined
  return sanitizeMethodOrder(raw.split(',').map(part => part.trim()))
}

export interface CompactionSettingsSources {
  /** Raw `settings.compaction` object from settings.json. */
  compaction?: unknown
  /** Environment map; defaults to process.env. */
  env?: Record<string, string | undefined>
}

/**
 * Resolve the effective compaction settings.
 *
 * Precedence (highest first):
 *   1. explicit request settings
 *   2. CLAUDE_CODE_COMPACTION_* environment variables (only when set)
 *   3. settings.compaction from settings.json
 *   4. DEFAULT_COMPACTION_SETTINGS
 *
 * Invalid values are skipped per field, so a bad request value falls through
 * to the next source instead of poisoning the whole policy.
 */
export function resolveSettings(
  input: Partial<CompactionSettings> | undefined,
  sources: CompactionSettingsSources = {},
): CompactionSettings {
  const global =
    sources.compaction && typeof sources.compaction === 'object'
      ? (sources.compaction as Record<string, unknown>)
      : {}
  const env = sources.env ?? process.env

  return {
    methodOrder: sanitizeMethodOrder(input?.methodOrder) ??
      envMethodOrder(env, 'CLAUDE_CODE_COMPACTION_METHOD_ORDER') ??
      sanitizeMethodOrder(global.methodOrder) ?? [
        ...DEFAULT_COMPACTION_SETTINGS.methodOrder,
      ],
    keepRecentTokens:
      asNonNegativeInt(input?.keepRecentTokens) ??
      envInteger(
        env,
        'CLAUDE_CODE_COMPACTION_KEEP_RECENT_TOKENS',
        asNonNegativeInt,
      ) ??
      asNonNegativeInt(global.keepRecentTokens) ??
      DEFAULT_COMPACTION_SETTINGS.keepRecentTokens,
    reserveTokens:
      asPositiveInt(input?.reserveTokens) ??
      envInteger(env, 'CLAUDE_CODE_COMPACTION_RESERVE_TOKENS', asPositiveInt) ??
      asPositiveInt(global.reserveTokens),
    thresholdTokens:
      asPositiveInt(input?.thresholdTokens) ??
      envInteger(
        env,
        'CLAUDE_CODE_COMPACTION_THRESHOLD_TOKENS',
        asPositiveInt,
      ) ??
      asPositiveInt(global.thresholdTokens),
    thresholdPercent:
      asThresholdPercent(input?.thresholdPercent) ??
      envInteger(
        env,
        'CLAUDE_CODE_COMPACTION_THRESHOLD_PERCENT',
        asThresholdPercent,
      ) ??
      asThresholdPercent(global.thresholdPercent),
    midTurnEnabled:
      asBoolean(input?.midTurnEnabled) ??
      envBoolean(env, 'CLAUDE_CODE_COMPACTION_MID_TURN_ENABLED') ??
      asBoolean(global.midTurnEnabled) ??
      DEFAULT_COMPACTION_SETTINGS.midTurnEnabled,
    autoContinue:
      asBoolean(input?.autoContinue) ??
      envBoolean(env, 'CLAUDE_CODE_COMPACTION_AUTO_CONTINUE') ??
      asBoolean(global.autoContinue) ??
      DEFAULT_COMPACTION_SETTINGS.autoContinue,
    asyncEnabled:
      asBoolean(input?.asyncEnabled) ??
      envBoolean(env, 'CLAUDE_CODE_COMPACTION_ASYNC_ENABLED') ??
      asBoolean(global.asyncEnabled) ??
      DEFAULT_COMPACTION_SETTINGS.asyncEnabled,
    idleEnabled:
      asBoolean(input?.idleEnabled) ??
      envBoolean(env, 'CLAUDE_CODE_COMPACTION_IDLE_ENABLED') ??
      asBoolean(global.idleEnabled) ??
      DEFAULT_COMPACTION_SETTINGS.idleEnabled,
    idleThresholdTokens:
      asPositiveInt(input?.idleThresholdTokens) ??
      envInteger(
        env,
        'CLAUDE_CODE_COMPACTION_IDLE_THRESHOLD_TOKENS',
        asPositiveInt,
      ) ??
      asPositiveInt(global.idleThresholdTokens) ??
      DEFAULT_COMPACTION_SETTINGS.idleThresholdTokens,
    idleTimeoutSeconds:
      asIdleTimeout(input?.idleTimeoutSeconds) ??
      envInteger(
        env,
        'CLAUDE_CODE_COMPACTION_IDLE_TIMEOUT_SECONDS',
        asIdleTimeout,
      ) ??
      asIdleTimeout(global.idleTimeoutSeconds) ??
      DEFAULT_COMPACTION_SETTINGS.idleTimeoutSeconds,
  }
}

function defaultEstimateEntryTokens(entry: EntryView, model?: string): number {
  if (typeof entry.tokens === 'number') return entry.tokens
  if (!entry.message) return 0
  const serialized = JSON.stringify(entry.message)
  if (!serialized) return 0
  if (model) return estimateTokens(serialized, model).tokens
  return Math.ceil(serialized.length / 4)
}

/* eslint-disable @typescript-eslint/no-require-imports */
function loadCompact(): typeof import('../compact/compact.js') {
  return require('../compact/compact.js') as typeof import('../compact/compact.js')
}

function loadAutoCompact(): typeof import('../compact/autoCompact.js') {
  return require('../compact/autoCompact.js') as typeof import('../compact/autoCompact.js')
}

function loadPostCompactCleanup(): typeof import('../compact/postCompactCleanup.js') {
  return require('../compact/postCompactCleanup.js') as typeof import('../compact/postCompactCleanup.js')
}

function loadSessionMemory(): typeof import('../SessionMemory/sessionMemoryUtils.js') {
  return require('../SessionMemory/sessionMemoryUtils.js') as typeof import('../SessionMemory/sessionMemoryUtils.js')
}

function loadTokens(): typeof import('../../utils/tokens.js') {
  return require('../../utils/tokens.js') as typeof import('../../utils/tokens.js')
}
/* eslint-enable @typescript-eslint/no-require-imports */
