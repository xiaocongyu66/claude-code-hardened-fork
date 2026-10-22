import type { CompactionResult } from '../compact/compact.js'
import type { QuerySource } from '../../constants/querySource.js'
import type { Message } from '../../types/message.js'
import type { ToolUseContext } from '../../Tool.js'
import type { CacheSafeParams } from '../../utils/forkedAgent.js'
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
import { createRemoteMethod } from './methods/remote.js'
import { createShakeMethod, type ShakeReducer } from './methods/shake.js'
import {
  createSoftMethod,
  type SoftCompactRun,
  type SoftMethodDeps,
} from './methods/soft.js'
import { createSnapcompactMethod } from './methods/snapcompact.js'
import { createShakeReducer } from './reducers/shakeReducer.js'
import { estimateTokens } from './tokens/index.js'
import { evaluateIdleTrigger } from './triggers/idle.js'
import { evaluateIncompleteTrigger } from './triggers/incomplete.js'
import { evaluateManualTrigger } from './triggers/manual.js'
import { evaluateMidTurnTrigger } from './triggers/midTurn.js'
import {
  evaluateOverflowTrigger,
  type ContextPromotion,
} from './triggers/overflow.js'
import { evaluateThresholdTrigger } from './triggers/threshold.js'
import type {
  PromotionResult,
  ThresholdDecision,
  TriggerDecision,
} from './triggers/types.js'

export interface CompactionV2Tracking {
  compacted?: boolean
  turnCounter?: number
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
  promotion?: ContextPromotion | null
  resolveWindowTokens?: (model: string) => number
  countTokens?: (messages: readonly Message[]) => number
  estimateEntryTokens?: (entry: EntryView) => number
  now?: () => number
  onTrace?: (entry: DecisionTraceEntry) => void
  /** Reject a compacted outcome the caller cannot render (e.g. no legacy result). */
  canAcceptOutcome?: (outcome: CompactionOutcome) => boolean
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
    createRemoteMethod(),
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
  const settings = resolveSettings(request.settings)
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
}

export interface CompactionV2QueryResult {
  wasCompacted: boolean
  compactionResult?: CompactionResult
  consecutiveFailures?: number
  /** Mechanical reduction (shake/prune) to use for this request only. */
  reducedMessages?: Message[]
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
  } = loadAutoCompact()
  // Same guards as legacy shouldAutoCompact: never compact inside the compact
  // or session-memory forks (the compact fork runs query() with
  // querySource='compact' and would otherwise re-enter this branch forever),
  // and honor DISABLE_COMPACT / DISABLE_AUTO_COMPACT / autoCompactEnabled.
  if (!isAutoCompactEnabled()) return { wasCompacted: false }
  if (
    request.querySource === 'compact' ||
    request.querySource === 'session_memory'
  ) {
    return { wasCompacted: false }
  }
  const windowTokens = getEffectiveContextWindowSize(request.model)
  const autoCompactThreshold = getAutoCompactThreshold(request.model)

  const result = await runCompactionV2(
    {
      model: request.model,
      trigger: request.trigger,
      messages: request.messages,
      windowTokens,
      tokenCount: request.tokenCount,
      stopReason: request.stopReason,
      overflowDetected: request.overflowDetected,
      payloadRejection: request.payloadRejection,
      lastActivityAt: request.lastActivityAt,
      instructions: request.instructions,
      agentId: request.toolUseContext.agentId,
      abortSignal: request.toolUseContext.abortController?.signal,
    },
    {
      soft: createLegacySoftDeps({
        toolUseContext: request.toolUseContext,
        cacheSafeParams: request.cacheSafeParams,
        querySource: request.querySource,
        tokenCount: request.tokenCount,
        autoCompactThreshold,
        tracking: request.tracking,
      }),
      shake: createShakeReducer(),
      // The query loop only understands the legacy CompactionResult; let an
      // unrenderable remote/snapcompact outcome fall through to soft.
      canAcceptOutcome: outcome =>
        outcome.kind !== 'compacted' ||
        getLegacyCompactionResult(outcome) !== undefined,
      resolveWindowTokens: getEffectiveContextWindowSize,
    },
  )

  if (result.outcome?.kind === 'reduced') {
    return {
      wasCompacted: false,
      reducedMessages: result.outcome.messages,
    }
  }
  const legacyResult = getLegacyCompactionResult(result.outcome)
  if (legacyResult) {
    return { wasCompacted: true, compactionResult: legacyResult }
  }
  return { wasCompacted: false }
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
 * Idle maintenance adapter. Default settings have `idleEnabled: false`, so
 * this is a no-op unless a caller opts in.
 */
export async function runIdleCompactionV2(
  request: IdleCompactionV2Request,
): Promise<IdleCompactionV2Result> {
  const { getEffectiveContextWindowSize, getAutoCompactThreshold } =
    loadAutoCompact()
  const tokenCount = defaultCountTokens(request.messages)
  const result = await runCompactionV2(
    {
      model: request.model,
      trigger: 'idle',
      messages: request.messages,
      settings: request.settings,
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
    },
  )

  const legacyResult = getLegacyCompactionResult(result.outcome)
  if (legacyResult) {
    const { buildPostCompactMessages } = loadCompact()
    return {
      compacted: true,
      messages: buildPostCompactMessages(legacyResult),
      trace: result.trace,
    }
  }
  return { compacted: false, trace: result.trace }
}

function createLegacySoftDeps(input: {
  toolUseContext: ToolUseContext
  cacheSafeParams: CacheSafeParams
  querySource?: QuerySource
  tokenCount: number
  autoCompactThreshold: number
  tracking?: CompactionV2Tracking
}): SoftMethodDeps {
  return {
    run: async request => {
      const { compactConversation } = loadCompact()
      const { runPostCompactCleanup } = loadPostCompactCleanup()
      const { setLastSummarizedMessageId } = loadSessionMemory()
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
      )
      setLastSummarizedMessageId(undefined)
      runPostCompactCleanup(input.querySource)
      return {
        result,
        tokensBefore: result.preCompactTokenCount ?? input.tokenCount,
        tokensAfter:
          result.truePostCompactTokenCount ?? result.postCompactTokenCount ?? 0,
      } satisfies SoftCompactRun
    },
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
  return undefined
}

function defaultCountTokens(messages: readonly Message[]): number {
  const { tokenCountWithEstimation } = loadTokens()
  return tokenCountWithEstimation([...messages])
}

function defaultResolveWindowTokens(model: string): number {
  const { getEffectiveContextWindowSize } = loadAutoCompact()
  return getEffectiveContextWindowSize(model)
}

function resolveSettings(
  input: Partial<CompactionSettings> | undefined,
): CompactionSettings {
  return {
    methodOrder: input?.methodOrder ?? DEFAULT_COMPACTION_SETTINGS.methodOrder,
    keepRecentTokens:
      input?.keepRecentTokens ?? DEFAULT_COMPACTION_SETTINGS.keepRecentTokens,
    reserveTokens:
      input?.reserveTokens ?? DEFAULT_COMPACTION_SETTINGS.reserveTokens,
    thresholdTokens:
      input?.thresholdTokens ?? DEFAULT_COMPACTION_SETTINGS.thresholdTokens,
    thresholdPercent:
      input?.thresholdPercent ?? DEFAULT_COMPACTION_SETTINGS.thresholdPercent,
    midTurnEnabled:
      input?.midTurnEnabled ?? DEFAULT_COMPACTION_SETTINGS.midTurnEnabled,
    autoContinue:
      input?.autoContinue ?? DEFAULT_COMPACTION_SETTINGS.autoContinue,
    asyncEnabled:
      input?.asyncEnabled ?? DEFAULT_COMPACTION_SETTINGS.asyncEnabled,
    idleEnabled: input?.idleEnabled ?? DEFAULT_COMPACTION_SETTINGS.idleEnabled,
    idleThresholdTokens:
      input?.idleThresholdTokens ??
      DEFAULT_COMPACTION_SETTINGS.idleThresholdTokens,
    idleTimeoutSeconds:
      input?.idleTimeoutSeconds ??
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
