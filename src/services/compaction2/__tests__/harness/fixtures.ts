// Deterministic, in-memory replay fixtures for the COMPACTION_V2 decision
// graph.
//
// Every fixture pins the model, context window, message array, token count,
// settings, method wiring and the exact decision trace the orchestrator must
// produce. The harness injects a deterministic token counter (per-message
// weights plus a chars-per-token text counter), so replay never touches a real
// tokenizer, the network, or the filesystem.
//
// The expected trace is the golden data: `replay.test.ts` compares it verbatim
// against `runCompactionV2`'s trace (method / outcome / reason / tokensSaved /
// headroomTokens).
import type { CompactionResult } from '../../../compact/compact.js'
import type {
  Message,
  SystemMessage,
  UserMessage,
} from '../../../../types/message.js'
import type {
  CompactionMethod,
  CompactionMethodName,
  CompactionSettings,
  TriggerReason,
} from '../../contracts.js'
import type {
  PayloadGuardDecision,
  PayloadRejectionEvidence,
} from '../../guards/payload.js'
import type { DecisionOutcome } from '../../orchestrator.js'
import type { ContextPromotion } from '../../triggers/overflow.js'
import {
  createContextPromotion,
  type PromotionCandidate,
} from '../../triggers/promotion.js'
import type { PromotionResult } from '../../triggers/types.js'
import {
  applyShakeRegions,
  collectShakeRegions,
  type ShakeConfig,
} from '../../reducers/shake.js'
import { isSkillReadToolResult } from '../../reducers/toolProtection.js'
import { createHandoffMethod } from '../../methods/handoff.js'
import { createRemoteMethod } from '../../methods/remote.js'
import { createShakeMethod, type ShakeReducer } from '../../methods/shake.js'
import { createSnapcompactMethod } from '../../methods/snapcompact.js'
import { createSoftMethod, type SoftCompactRun } from '../../methods/soft.js'

/** Mirrors `MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES` from the legacy path. */
export const CIRCUIT_BREAKER_FAILURES = 3

export type FixtureContentBlock =
  | { type: 'text'; text: string }
  | {
      type: 'tool_use'
      id: string
      name: string
      input?: Record<string, unknown>
    }
  | { type: 'tool_result'; toolUseId: string; text: string }

export interface FixtureMessageSpec {
  role: 'user' | 'assistant'
  uuid: string
  content: string | FixtureContentBlock[]
  /**
   * Deterministic token weight used by the fixture counter. Weights across a
   * fixture sum to its `tokenCount`.
   */
  tokens: number
}

export interface FixtureShakePlan {
  /**
   * `detect` runs the real shake region detector with a deterministic text
   * counter; `stub` returns a fixed reduction without inspecting messages.
   */
  mode: 'detect' | 'stub'
  /** Stub only: tokens the reduction claims to save. */
  tokensSaved?: number
  /** Detect only: protect the most recent N tokens (default 0). */
  protectTokens?: number
  /** Detect only: minimum combined savings (default 0). */
  minSavings?: number
  /** Detect only: minimum fenced/XML block size (default 400). */
  fenceMinTokens?: number
  /** Detect only: deterministic chars-per-token for text counting (default 4). */
  charsPerToken?: number
}

export interface FixtureSoftPlan {
  tokensBefore: number
  tokensAfter: number
  summary?: string
}

export interface FixtureMethodsPlan {
  /** Remote is opt-in and needs a network lane; default false. */
  remoteAvailable?: boolean
  shake?: FixtureShakePlan | null
  soft?: FixtureSoftPlan | null
}

export interface GoldenTraceEntry {
  method: CompactionMethodName | null
  outcome: DecisionOutcome
  reason: string
  tokensSaved?: number
  headroomTokens?: number
}

export interface FixtureExpectation {
  shouldCompact: boolean
  /** Resolved threshold; omit when the fixture does not pin it. */
  thresholdTokens?: number
  /** Final outcome kind; null means the chain produced no outcome. */
  outcomeKind: 'compacted' | 'reduced' | null
  /**
   * Promotion decision returned by the overflow trigger, when pinned.
   * `null` asserts the trigger never reached the promotion step.
   */
  promotion?: PromotionResult | null
  /** Payload guard fields pinned for payload-rejection fixtures. */
  payload?: Pick<
    PayloadGuardDecision,
    'blockCompaction' | 'excludeMediaMethods' | 'tokenOverflowProven' | 'reason'
  >
  trace: GoldenTraceEntry[]
}

/**
 * Declarative promotion wiring. The harness builds the real
 * `createContextPromotion` adapter so `selectPromotion` decides availability.
 */
export interface FixturePromotionPlan {
  /** Explicitly known candidates. */
  candidates?: readonly PromotionCandidate[]
  /** Model → window override map, merged with `candidates`. */
  windowOverrides?: Record<string, number>
  /** Effective window of the current model; defaults to `windowTokens`. */
  currentWindow?: number
}

export interface CompactionFixture {
  name: string
  description: string
  model: string
  windowTokens: number
  trigger: TriggerReason
  /** Authoritative pre-compaction context size for the request. */
  tokenCount: number
  settings: Partial<CompactionSettings>
  messages: FixtureMessageSpec[]
  methods: FixtureMethodsPlan
  consecutiveFailures?: number
  /** Assistant stop reason; drives the incomplete trigger. */
  stopReason?: string | null
  /** Explicit provider overflow signal (needed when tokenCount ≤ window). */
  overflowDetected?: boolean
  /** Payload-shaped rejection evidence for the overflow guard. */
  payloadRejection?: PayloadRejectionEvidence
  /** Idle trigger activity clock input. */
  lastActivityAt?: number
  /** Overflow promotion wiring; absent = no promotion configured. */
  promotion?: FixturePromotionPlan
  expected: FixtureExpectation
}

// ---------------------------------------------------------------------------
// Message construction
// ---------------------------------------------------------------------------

function toContent(
  spec: FixtureMessageSpec,
): string | Array<Record<string, unknown>> {
  if (typeof spec.content === 'string') return spec.content
  return spec.content.map(block => {
    switch (block.type) {
      case 'text':
        return { type: 'text', text: block.text }
      case 'tool_use':
        return {
          type: 'tool_use',
          id: block.id,
          name: block.name,
          input: block.input ?? {},
        }
      case 'tool_result':
        return {
          type: 'tool_result',
          tool_use_id: block.toolUseId,
          content: block.text,
        }
    }
  })
}

export function buildFixtureMessages(fixture: CompactionFixture): Message[] {
  return fixture.messages.map(spec => {
    const content = toContent(spec)
    return {
      type: spec.role,
      uuid: spec.uuid,
      message: { role: spec.role, content },
    } as unknown as Message
  })
}

// ---------------------------------------------------------------------------
// Deterministic token counting
// ---------------------------------------------------------------------------

export interface FixtureCounter {
  /** Sum of fixture-declared per-message weights (uuid-keyed). */
  countMessages(messages: readonly Message[]): number
  /** Deterministic text counter: chars / charsPerToken, rounded up. */
  countText(text: string): number
}

export function createFixtureCounter(
  fixture: CompactionFixture,
  charsPerToken = 4,
): FixtureCounter {
  const weights = new Map(
    fixture.messages.map(spec => [spec.uuid, spec.tokens]),
  )
  return {
    countMessages: messages =>
      messages.reduce(
        (sum, message) => sum + (weights.get(message.uuid) ?? 0),
        0,
      ),
    countText: text =>
      text.length === 0
        ? 0
        : Math.max(1, Math.ceil(text.length / charsPerToken)),
  }
}

// ---------------------------------------------------------------------------
// Method wiring
// ---------------------------------------------------------------------------

function createFixtureShakeReducer(
  fixture: CompactionFixture,
  plan: FixtureShakePlan,
): ShakeReducer {
  if (plan.mode === 'stub') {
    const tokensSaved = plan.tokensSaved ?? 0
    return {
      reduce: ctx => ({ messages: [...ctx.messages], tokensSaved }),
    }
  }
  const charsPerToken = plan.charsPerToken ?? 4
  const countText = (text: string): number =>
    text.length === 0 ? 0 : Math.max(1, Math.ceil(text.length / charsPerToken))
  return {
    reduce: ctx => {
      const config: ShakeConfig = {
        protectTokens: plan.protectTokens ?? 0,
        minSavings: plan.minSavings ?? 0,
        protectedTools: ['skill', isSkillReadToolResult],
        fenceMinTokens: plan.fenceMinTokens ?? 400,
      }
      const regions = collectShakeRegions(ctx.messages, countText, config)
      if (regions.length === 0) return null
      const applied = regions.map(region => {
        const replacement = `[Shaken: ${region.label} content moved to artifact://fixture]`
        return {
          region,
          replacement,
          replacementTokens: countText(replacement),
        }
      })
      let tokensSaved = 0
      for (const item of applied) {
        tokensSaved += Math.max(0, item.region.tokens - item.replacementTokens)
      }
      if (tokensSaved <= 0) return null
      return {
        messages: applyShakeRegions(ctx.messages, applied),
        tokensSaved,
      }
    },
  }
}

function createFixtureSoftRun(
  fixture: CompactionFixture,
  plan: FixtureSoftPlan,
): SoftCompactRun {
  const summary = plan.summary ?? `fixture summary: ${fixture.name}`
  const kept = buildFixtureMessages(fixture).at(-1)
  const result: CompactionResult = {
    boundaryMarker: {
      type: 'system',
      subtype: 'compact_boundary',
      uuid: `boundary-${fixture.name}`,
      content: 'fixture compact boundary',
    } as unknown as SystemMessage,
    summaryMessages: [
      {
        type: 'user',
        uuid: `summary-${fixture.name}`,
        message: { role: 'user', content: summary },
      } as unknown as UserMessage,
    ],
    attachments: [],
    hookResults: [],
    messagesToKeep: kept ? [kept] : [],
    userDisplayMessage: summary,
    preCompactTokenCount: plan.tokensBefore,
    truePostCompactTokenCount: plan.tokensAfter,
  }
  return {
    result,
    tokensBefore: plan.tokensBefore,
    tokensAfter: plan.tokensAfter,
  }
}

export interface FixtureMethods {
  methods: CompactionMethod[]
  /** Present when the fixture opens the API-method circuit breaker. */
  canRunMethod?: (name: CompactionMethodName) => boolean
}

/**
 * Build the method chain for a fixture. Unconfigured methods stay unavailable
 * (remote/snapcompact/handoff never call out, shake/soft have no reducer).
 */
export function createFixtureMethods(
  fixture: CompactionFixture,
): FixtureMethods {
  const plan = fixture.methods
  const softPlan = plan.soft
  const methods: CompactionMethod[] = [
    createRemoteMethod({
      env: {},
      isAvailable: () => plan.remoteAvailable === true,
      run: async () => ({
        kind: 'skipped',
        method: 'remote',
        reason: 'fixture-remote-lane-unavailable',
      }),
    }),
    // Explicit empty env keeps snapcompact unavailable regardless of the host
    // environment (`CCH_SNAPCOMPACT_ENABLE`).
    createSnapcompactMethod({ env: {} }),
    createHandoffMethod(),
    createShakeMethod(
      plan.shake
        ? { reducer: createFixtureShakeReducer(fixture, plan.shake) }
        : null,
    ),
    createSoftMethod(
      softPlan
        ? { run: async () => createFixtureSoftRun(fixture, softPlan) }
        : null,
    ),
  ]
  const circuitOpen =
    (fixture.consecutiveFailures ?? 0) >= CIRCUIT_BREAKER_FAILURES
  return {
    methods,
    ...(circuitOpen
      ? {
          // Same policy as `runCompactionV2ForQuery`: API-backed methods are
          // skipped, local reducers stay available.
          canRunMethod: (name: CompactionMethodName) =>
            name === 'snapcompact' || name === 'shake',
        }
      : {}),
  }
}

/**
 * Build the promotion adapter for a fixture. Reuses the production
 * `createContextPromotion`/`selectPromotion` decision so goldens pin the real
 * larger-window policy instead of a stub.
 */
export function createFixturePromotion(
  fixture: CompactionFixture,
): ContextPromotion | null {
  const plan = fixture.promotion
  if (!plan) return null
  return createContextPromotion({
    candidates: plan.candidates ?? null,
    windowOverrides: plan.windowOverrides ?? null,
    resolveWindow: () => plan.currentWindow ?? fixture.windowTokens,
  })
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SHAKE_TOOL_RESULT = 'A'.repeat(60_000)

const CJK_TEXT = '这是一个用于压缩回放测试的长上下文段落。'.repeat(2_000)

export const FIXTURES: readonly CompactionFixture[] = [
  {
    name: 'english-tool-result-shake',
    description:
      'English tool result outside the protect window is mechanically shaken.',
    model: 'claude-sonnet-4-5',
    windowTokens: 50_000,
    trigger: 'threshold',
    // threshold = 50_000 - max(7_500, 16_384) = 33_616
    tokenCount: 40_000,
    settings: {},
    messages: [
      {
        role: 'user',
        uuid: 'fx-shake-u1',
        content: 'Please read the large generated file.',
        tokens: 8,
      },
      {
        role: 'assistant',
        uuid: 'fx-shake-a1',
        content: [
          {
            type: 'tool_use',
            id: 'toolu-shake-1',
            name: 'Read',
            input: { file_path: '/repo/big.ts' },
          },
        ],
        tokens: 20,
      },
      {
        role: 'user',
        uuid: 'fx-shake-u2',
        content: [
          {
            type: 'tool_result',
            toolUseId: 'toolu-shake-1',
            text: SHAKE_TOOL_RESULT,
          },
        ],
        // 60_000 chars / 4 = 15_000 tokens in the deterministic text counter.
        tokens: 15_000,
      },
      {
        role: 'assistant',
        uuid: 'fx-shake-a2',
        content: 'Read complete.',
        tokens: 24_972,
      },
    ],
    methods: {
      shake: {
        mode: 'detect',
        protectTokens: 0,
        minSavings: 4_000,
        charsPerToken: 4,
      },
      soft: { tokensBefore: 40_000, tokensAfter: 10_000 },
    },
    expected: {
      shouldCompact: true,
      thresholdTokens: 33_616,
      outcomeKind: 'reduced',
      trace: [
        { method: 'remote', outcome: 'skipped', reason: 'unavailable' },
        { method: 'snapcompact', outcome: 'skipped', reason: 'unavailable' },
        { method: 'handoff', outcome: 'skipped', reason: 'unavailable' },
        {
          method: 'shake',
          outcome: 'reduced',
          reason: 'reduced',
          // 15_000 - 13 (placeholder) tokens.
          tokensSaved: 14_987,
          // 33_616 - (40_000 - 14_987).
          headroomTokens: 8_603,
        },
      ],
    },
  },
  {
    name: 'cjk-large-context',
    description:
      'CJK context over the threshold: fixture-pinned token count drives the threshold arithmetic.',
    model: 'claude-sonnet-4-5',
    windowTokens: 128_000,
    trigger: 'threshold',
    // threshold = 128_000 - max(19_200, 16_384) = 108_800
    tokenCount: 115_000,
    settings: {},
    messages: [
      {
        role: 'user',
        uuid: 'fx-cjk-u1',
        content: CJK_TEXT,
        tokens: 60_000,
      },
      {
        role: 'assistant',
        uuid: 'fx-cjk-a1',
        content: `已完成阅读。${CJK_TEXT}`,
        tokens: 55_000,
      },
    ],
    methods: {
      soft: { tokensBefore: 115_000, tokensAfter: 40_000 },
    },
    expected: {
      shouldCompact: true,
      thresholdTokens: 108_800,
      outcomeKind: 'compacted',
      trace: [
        { method: 'remote', outcome: 'skipped', reason: 'unavailable' },
        { method: 'snapcompact', outcome: 'skipped', reason: 'unavailable' },
        { method: 'handoff', outcome: 'skipped', reason: 'unavailable' },
        { method: 'shake', outcome: 'skipped', reason: 'unavailable' },
        {
          method: 'soft',
          outcome: 'compacted',
          reason: 'compacted',
          tokensSaved: 75_000,
          // 108_800 - 40_000.
          headroomTokens: 68_800,
        },
      ],
    },
  },
  {
    name: 'degraded-methods-to-soft',
    description:
      'Remote and snapcompact are unavailable; the chain degrades to soft.',
    model: 'claude-sonnet-4-5',
    windowTokens: 200_000,
    trigger: 'threshold',
    // threshold = 200_000 - 30_000 = 170_000
    tokenCount: 180_000,
    settings: {},
    messages: [
      {
        role: 'user',
        uuid: 'fx-degrade-u1',
        content: 'hello',
        tokens: 100_000,
      },
      {
        role: 'assistant',
        uuid: 'fx-degrade-a1',
        content: 'hi',
        tokens: 80_000,
      },
    ],
    methods: {
      remoteAvailable: false,
      soft: { tokensBefore: 180_000, tokensAfter: 70_000 },
    },
    expected: {
      shouldCompact: true,
      thresholdTokens: 170_000,
      outcomeKind: 'compacted',
      trace: [
        { method: 'remote', outcome: 'skipped', reason: 'unavailable' },
        { method: 'snapcompact', outcome: 'skipped', reason: 'unavailable' },
        { method: 'handoff', outcome: 'skipped', reason: 'unavailable' },
        { method: 'shake', outcome: 'skipped', reason: 'unavailable' },
        {
          method: 'soft',
          outcome: 'compacted',
          reason: 'compacted',
          tokensSaved: 110_000,
          headroomTokens: 100_000,
        },
      ],
    },
  },
  {
    name: 'progress-guard-blocked',
    description:
      'A reduction that leaves context above 80% of the threshold is guard-blocked and the chain falls through.',
    model: 'claude-sonnet-4-5',
    windowTokens: 200_000,
    trigger: 'threshold',
    tokenCount: 180_000,
    settings: { methodOrder: ['shake', 'soft'] },
    messages: [
      { role: 'user', uuid: 'fx-guard-u1', content: 'one', tokens: 90_000 },
      {
        role: 'assistant',
        uuid: 'fx-guard-a1',
        content: 'two',
        tokens: 90_000,
      },
    ],
    methods: {
      shake: { mode: 'stub', tokensSaved: 10_000 },
      soft: { tokensBefore: 180_000, tokensAfter: 50_000 },
    },
    expected: {
      shouldCompact: true,
      thresholdTokens: 170_000,
      outcomeKind: 'compacted',
      trace: [
        {
          method: 'shake',
          outcome: 'guard-blocked',
          // 180_000 - 10_000 = 170_000 > 136_000 (80% of 170_000).
          reason:
            'post-compaction context 170000 exceeds 136000 (80% of 170000)',
          tokensSaved: 10_000,
          headroomTokens: 0,
        },
        {
          method: 'soft',
          outcome: 'compacted',
          reason: 'compacted',
          tokensSaved: 130_000,
          headroomTokens: 120_000,
        },
      ],
    },
  },
  {
    name: 'circuit-breaker-local-only',
    description:
      'Three consecutive failures open the breaker: API methods are skipped, local shake still reduces.',
    model: 'claude-sonnet-4-5',
    windowTokens: 200_000,
    trigger: 'threshold',
    tokenCount: 180_000,
    settings: {},
    consecutiveFailures: CIRCUIT_BREAKER_FAILURES,
    messages: [
      { role: 'user', uuid: 'fx-circuit-u1', content: 'one', tokens: 90_000 },
      {
        role: 'assistant',
        uuid: 'fx-circuit-a1',
        content: 'two',
        tokens: 90_000,
      },
    ],
    methods: {
      shake: { mode: 'stub', tokensSaved: 50_000 },
      soft: { tokensBefore: 180_000, tokensAfter: 40_000 },
    },
    expected: {
      shouldCompact: true,
      thresholdTokens: 170_000,
      outcomeKind: 'reduced',
      trace: [
        { method: 'remote', outcome: 'skipped', reason: 'circuit-open' },
        { method: 'snapcompact', outcome: 'skipped', reason: 'unavailable' },
        { method: 'handoff', outcome: 'skipped', reason: 'circuit-open' },
        {
          method: 'shake',
          outcome: 'reduced',
          reason: 'reduced',
          tokensSaved: 50_000,
          headroomTokens: 40_000,
        },
      ],
    },
  },
  {
    name: 'corrupt-empty-messages',
    description:
      'Empty and dangling tool-result content survive shake detection; the chain still compacts.',
    model: 'claude-sonnet-4-5',
    windowTokens: 200_000,
    trigger: 'manual',
    tokenCount: 1_000,
    settings: { methodOrder: ['shake', 'soft'] },
    messages: [
      {
        role: 'user',
        uuid: 'fx-corrupt-u1',
        content: '',
        tokens: 0,
      },
      {
        role: 'user',
        uuid: 'fx-corrupt-u2',
        content: [{ type: 'tool_result', toolUseId: 'missing-call', text: '' }],
        tokens: 1_000,
      },
    ],
    methods: {
      shake: { mode: 'detect', protectTokens: 0, minSavings: 0 },
      soft: { tokensBefore: 1_000, tokensAfter: 500 },
    },
    expected: {
      shouldCompact: true,
      thresholdTokens: 170_000,
      outcomeKind: 'compacted',
      trace: [
        { method: 'shake', outcome: 'skipped', reason: 'shake-noop' },
        {
          method: 'soft',
          outcome: 'compacted',
          reason: 'compacted',
          tokensSaved: 500,
          headroomTokens: 169_500,
        },
      ],
    },
  },
  {
    name: 'overflow-payload-blocked',
    description:
      'A 413 with local headroom is a payload rejection, not token overflow: compaction is blocked before any method runs.',
    model: 'claude-sonnet-4-5',
    windowTokens: 200_000,
    trigger: 'overflow',
    // threshold = 200_000 - max(30_000, 16_384) = 170_000
    tokenCount: 100_000,
    settings: {},
    overflowDetected: true,
    payloadRejection: { status: 413, message: 'request too large' },
    messages: [
      {
        role: 'user',
        uuid: 'fx-payload-block-u1',
        content: 'one',
        tokens: 50_000,
      },
      {
        role: 'assistant',
        uuid: 'fx-payload-block-a1',
        content: 'two',
        tokens: 50_000,
      },
    ],
    methods: {
      soft: { tokensBefore: 100_000, tokensAfter: 40_000 },
    },
    expected: {
      shouldCompact: false,
      thresholdTokens: 170_000,
      outcomeKind: null,
      // Payload guard returns before promotion is attempted.
      promotion: null,
      payload: {
        blockCompaction: true,
        excludeMediaMethods: true,
        tokenOverflowProven: false,
        reason: 'payload-budget-with-headroom',
      },
      trace: [
        {
          method: null,
          outcome: 'skipped',
          reason: 'payload-rejection: payload-budget-with-headroom',
          // 170_000 - 100_000.
          headroomTokens: 70_000,
        },
      ],
    },
  },
  {
    name: 'overflow-media-blocked',
    description:
      'Explicit media-limit evidence (400 + "too many images") blocks compaction and excludes media methods.',
    model: 'claude-sonnet-4-5',
    windowTokens: 200_000,
    trigger: 'overflow',
    tokenCount: 100_000,
    settings: {},
    overflowDetected: true,
    payloadRejection: {
      status: 400,
      message: 'request_too_large: too many images',
    },
    messages: [
      {
        role: 'user',
        uuid: 'fx-media-block-u1',
        content: 'one',
        tokens: 50_000,
      },
      {
        role: 'assistant',
        uuid: 'fx-media-block-a1',
        content: 'two',
        tokens: 50_000,
      },
    ],
    methods: {
      soft: { tokensBefore: 100_000, tokensAfter: 40_000 },
    },
    expected: {
      shouldCompact: false,
      thresholdTokens: 170_000,
      outcomeKind: null,
      promotion: null,
      payload: {
        blockCompaction: true,
        excludeMediaMethods: true,
        tokenOverflowProven: false,
        reason: 'media-limit-evidence',
      },
      trace: [
        {
          method: null,
          outcome: 'skipped',
          reason: 'payload-rejection: media-limit-evidence',
          headroomTokens: 70_000,
        },
      ],
    },
  },
  {
    name: 'overflow-promotion',
    description:
      'A strictly larger-window candidate is promoted instead of compacting; no method runs.',
    model: 'claude-sonnet-4-5',
    windowTokens: 200_000,
    trigger: 'overflow',
    tokenCount: 250_000,
    settings: {},
    overflowDetected: true,
    promotion: {
      candidates: [{ model: 'claude-opus-4-5', windowTokens: 1_000_000 }],
      currentWindow: 200_000,
    },
    messages: [
      {
        role: 'user',
        uuid: 'fx-promotion-u1',
        content: 'one',
        tokens: 125_000,
      },
      {
        role: 'assistant',
        uuid: 'fx-promotion-a1',
        content: 'two',
        tokens: 125_000,
      },
    ],
    methods: {
      soft: { tokensBefore: 250_000, tokensAfter: 100_000 },
    },
    expected: {
      shouldCompact: false,
      thresholdTokens: 170_000,
      outcomeKind: null,
      promotion: {
        kind: 'promoted',
        model: 'claude-opus-4-5',
        reason: 'larger-window:1000000',
      },
      trace: [
        {
          method: null,
          outcome: 'skipped',
          reason: 'context-promoted: claude-opus-4-5',
          // 170_000 - 250_000.
          headroomTokens: -80_000,
        },
      ],
    },
  },
  {
    name: 'overflow-media-overflow-proven',
    description:
      'Provider usage proves token overflow despite media evidence: compaction runs, but snapcompact is excluded by the payload guard.',
    model: 'claude-sonnet-4-5',
    windowTokens: 200_000,
    trigger: 'overflow',
    tokenCount: 250_000,
    settings: {},
    overflowDetected: true,
    payloadRejection: {
      status: 413,
      message: 'request_too_large: too many images',
      providerInputTokens: 250_000,
    },
    messages: [
      {
        role: 'user',
        uuid: 'fx-media-proven-u1',
        content: 'one',
        tokens: 125_000,
      },
      {
        role: 'assistant',
        uuid: 'fx-media-proven-a1',
        content: 'two',
        tokens: 125_000,
      },
    ],
    methods: {
      soft: { tokensBefore: 250_000, tokensAfter: 100_000 },
    },
    expected: {
      shouldCompact: true,
      thresholdTokens: 170_000,
      outcomeKind: 'compacted',
      promotion: { kind: 'skipped', reason: 'no-promotion-configured' },
      payload: {
        blockCompaction: false,
        excludeMediaMethods: true,
        tokenOverflowProven: true,
        reason: 'usage-proven-token-overflow',
      },
      trace: [
        { method: 'remote', outcome: 'skipped', reason: 'unavailable' },
        {
          method: 'snapcompact',
          outcome: 'skipped',
          reason: 'payload-rejection-excludes-media',
        },
        { method: 'handoff', outcome: 'skipped', reason: 'unavailable' },
        { method: 'shake', outcome: 'skipped', reason: 'unavailable' },
        {
          method: 'soft',
          outcome: 'compacted',
          reason: 'compacted',
          tokensSaved: 150_000,
          // 170_000 - 100_000.
          headroomTokens: 70_000,
        },
      ],
    },
  },
  {
    name: 'incomplete-length-over',
    description:
      'A length stop above the threshold triggers incomplete-output recovery and compacts.',
    model: 'claude-sonnet-4-5',
    windowTokens: 200_000,
    trigger: 'incomplete',
    tokenCount: 180_000,
    settings: { methodOrder: ['soft'] },
    stopReason: 'length',
    messages: [
      {
        role: 'user',
        uuid: 'fx-inc-length-u1',
        content: 'one',
        tokens: 90_000,
      },
      {
        role: 'assistant',
        uuid: 'fx-inc-length-a1',
        content: 'two',
        tokens: 90_000,
      },
    ],
    methods: {
      soft: { tokensBefore: 180_000, tokensAfter: 60_000 },
    },
    expected: {
      shouldCompact: true,
      thresholdTokens: 170_000,
      outcomeKind: 'compacted',
      trace: [
        {
          method: 'soft',
          outcome: 'compacted',
          reason: 'compacted',
          tokensSaved: 120_000,
          // 170_000 - 60_000.
          headroomTokens: 110_000,
        },
      ],
    },
  },
  {
    name: 'incomplete-max-tokens-under',
    description:
      'A max_tokens stop below the threshold does not trigger recovery; the chain is not walked.',
    model: 'claude-sonnet-4-5',
    windowTokens: 200_000,
    trigger: 'incomplete',
    tokenCount: 160_000,
    settings: { methodOrder: ['soft'] },
    stopReason: 'max_tokens',
    messages: [
      { role: 'user', uuid: 'fx-inc-under-u1', content: 'one', tokens: 80_000 },
      {
        role: 'assistant',
        uuid: 'fx-inc-under-a1',
        content: 'two',
        tokens: 80_000,
      },
    ],
    methods: {
      soft: { tokensBefore: 160_000, tokensAfter: 40_000 },
    },
    expected: {
      shouldCompact: false,
      thresholdTokens: 170_000,
      outcomeKind: null,
      trace: [
        {
          method: null,
          outcome: 'skipped',
          reason: 'incomplete-output-below-threshold',
          // 170_000 - 160_000.
          headroomTokens: 10_000,
        },
      ],
    },
  },
  {
    name: 'midturn-enabled',
    description:
      'With midTurnEnabled the mid-turn pass applies the threshold rule and compacts.',
    model: 'claude-sonnet-4-5',
    windowTokens: 200_000,
    trigger: 'midTurn',
    tokenCount: 180_000,
    settings: { methodOrder: ['soft'], midTurnEnabled: true },
    messages: [
      { role: 'user', uuid: 'fx-mid-on-u1', content: 'one', tokens: 90_000 },
      {
        role: 'assistant',
        uuid: 'fx-mid-on-a1',
        content: 'two',
        tokens: 90_000,
      },
    ],
    methods: {
      soft: { tokensBefore: 180_000, tokensAfter: 60_000 },
    },
    expected: {
      shouldCompact: true,
      thresholdTokens: 170_000,
      outcomeKind: 'compacted',
      trace: [
        {
          method: 'soft',
          outcome: 'compacted',
          reason: 'compacted',
          tokensSaved: 120_000,
          headroomTokens: 110_000,
        },
      ],
    },
  },
  {
    name: 'midturn-disabled',
    description:
      'midTurnEnabled=false short-circuits the mid-turn pass even above the threshold.',
    model: 'claude-sonnet-4-5',
    windowTokens: 200_000,
    trigger: 'midTurn',
    tokenCount: 180_000,
    settings: { methodOrder: ['soft'], midTurnEnabled: false },
    messages: [
      { role: 'user', uuid: 'fx-mid-off-u1', content: 'one', tokens: 90_000 },
      {
        role: 'assistant',
        uuid: 'fx-mid-off-a1',
        content: 'two',
        tokens: 90_000,
      },
    ],
    methods: {
      soft: { tokensBefore: 180_000, tokensAfter: 60_000 },
    },
    expected: {
      shouldCompact: false,
      thresholdTokens: 170_000,
      outcomeKind: null,
      trace: [
        {
          method: null,
          outcome: 'skipped',
          reason: 'mid-turn-disabled',
          // 170_000 - 180_000.
          headroomTokens: -10_000,
        },
      ],
    },
  },
  {
    name: 'progress-boundary-pass',
    description:
      'A reduction landing exactly on 80% of the threshold passes the progress guard.',
    model: 'claude-sonnet-4-5',
    windowTokens: 200_000,
    trigger: 'threshold',
    tokenCount: 180_000,
    settings: { methodOrder: ['shake'] },
    messages: [
      {
        role: 'user',
        uuid: 'fx-progress-pass-u1',
        content: 'one',
        tokens: 90_000,
      },
      {
        role: 'assistant',
        uuid: 'fx-progress-pass-a1',
        content: 'two',
        tokens: 90_000,
      },
    ],
    methods: {
      // 180_000 - 44_000 = 136_000 = floor(170_000 * 0.8).
      shake: { mode: 'stub', tokensSaved: 44_000 },
    },
    expected: {
      shouldCompact: true,
      thresholdTokens: 170_000,
      outcomeKind: 'reduced',
      trace: [
        {
          method: 'shake',
          outcome: 'reduced',
          reason: 'reduced',
          tokensSaved: 44_000,
          // 170_000 - 136_000.
          headroomTokens: 34_000,
        },
      ],
    },
  },
  {
    name: 'progress-boundary-fail',
    description:
      'One token above the 80% boundary guard-blocks the reduction; with no fallback the chain reports a final skip.',
    model: 'claude-sonnet-4-5',
    windowTokens: 200_000,
    trigger: 'threshold',
    tokenCount: 180_000,
    settings: { methodOrder: ['shake'] },
    messages: [
      {
        role: 'user',
        uuid: 'fx-progress-fail-u1',
        content: 'one',
        tokens: 90_000,
      },
      {
        role: 'assistant',
        uuid: 'fx-progress-fail-a1',
        content: 'two',
        tokens: 90_000,
      },
    ],
    methods: {
      // 180_000 - 43_999 = 136_001 > 136_000.
      shake: { mode: 'stub', tokensSaved: 43_999 },
    },
    expected: {
      shouldCompact: true,
      thresholdTokens: 170_000,
      outcomeKind: null,
      trace: [
        {
          method: 'shake',
          outcome: 'guard-blocked',
          reason:
            'post-compaction context 136001 exceeds 136000 (80% of 170000)',
          tokensSaved: 43_999,
          // 170_000 - 136_001.
          headroomTokens: 33_999,
        },
        {
          method: null,
          outcome: 'skipped',
          reason: 'all-methods-unavailable-or-failed',
          headroomTokens: -10_000,
        },
      ],
    },
  },
]

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

function cloneFixture(fixture: CompactionFixture): CompactionFixture {
  return {
    ...fixture,
    settings: { ...fixture.settings },
    messages: fixture.messages.map(spec => ({
      ...spec,
      content:
        typeof spec.content === 'string'
          ? spec.content
          : spec.content.map(block => ({ ...block })),
    })),
    methods: { ...fixture.methods },
    ...(fixture.payloadRejection
      ? { payloadRejection: { ...fixture.payloadRejection } }
      : {}),
    ...(fixture.promotion
      ? {
          promotion: {
            ...fixture.promotion,
            ...(fixture.promotion.candidates
              ? {
                  candidates: fixture.promotion.candidates.map(candidate => ({
                    ...candidate,
                  })),
                }
              : {}),
            ...(fixture.promotion.windowOverrides
              ? { windowOverrides: { ...fixture.promotion.windowOverrides } }
              : {}),
          },
        }
      : {}),
    expected: {
      ...fixture.expected,
      ...(fixture.expected.promotion
        ? { promotion: { ...fixture.expected.promotion } }
        : {}),
      ...(fixture.expected.payload
        ? { payload: { ...fixture.expected.payload } }
        : {}),
      trace: fixture.expected.trace.map(entry => ({ ...entry })),
    },
  }
}

/** Pure in-memory loader; returns fresh copies so tests cannot mutate goldens. */
export function loadFixtures(): CompactionFixture[] {
  return FIXTURES.map(cloneFixture)
}

export function loadFixture(name: string): CompactionFixture {
  const fixture = FIXTURES.find(candidate => candidate.name === name)
  if (!fixture) throw new Error(`unknown compaction fixture: ${name}`)
  return cloneFixture(fixture)
}
