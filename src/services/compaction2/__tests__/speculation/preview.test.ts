import { describe, expect, test } from 'bun:test'
import type { CompactionResult } from '../../../compact/compact.js'
import type { Message } from '../../../../types/message.js'
import {
  createSpeculationManager,
  type SpeculationContext,
} from '../../speculation/manager.js'
import {
  applyCompactionOutcome,
  createLegacySoftDeps,
  type LegacySoftDepsInput,
  runCompactionV2,
} from '../../orchestrator.js'

const message = {
  type: 'user',
  message: { role: 'user', content: 'hello' },
  uuid: 'u1',
} as unknown as Message

const legacyResult: CompactionResult = {
  boundaryMarker: { uuid: 'boundary' } as never,
  summaryMessages: [
    {
      type: 'user',
      message: { role: 'user', content: 'summary text' },
      uuid: 'summary',
      isCompactSummary: true,
      isVisibleInTranscriptOnly: true,
    } as never,
  ],
  attachments: [],
  hookResults: [],
  messagesToKeep: [message],
  userDisplayMessage: 'summary',
  preCompactTokenCount: 180_000,
  truePostCompactTokenCount: 80_000,
}

// window 200k → reserve 30k → threshold 170k; 180k fires.
const RUN_REQUEST = {
  model: 'test-model',
  trigger: 'threshold' as const,
  messages: [message],
  windowTokens: 200_000,
  tokenCount: 180_000,
  settings: { methodOrder: ['soft' as const] },
}

interface Spies {
  compactCalls: number
  persistCalls: number
  cleanupCalls: number
  resetCalls: number
  sideEffectCalls: number
  postCompactCalls: number
  postCompactSummary: string | undefined
  seenOptions: { deferApply?: boolean } | undefined
}

function makeSpies(): Spies {
  return {
    compactCalls: 0,
    persistCalls: 0,
    cleanupCalls: 0,
    resetCalls: 0,
    sideEffectCalls: 0,
    postCompactCalls: 0,
    postCompactSummary: undefined,
    seenOptions: undefined,
  }
}

/** Commit-time dependency seams shared by the apply tests. */
function applyDeps(spies: Spies) {
  return {
    persist: async () => {
      spies.persistCalls++
      return 'entry'
    },
    resetLastSummarizedMessageId: () => {
      spies.resetCalls++
    },
    cleanup: () => {
      spies.cleanupCalls++
    },
    executePostCompactHooks: async (data: { compactSummary: string }) => {
      spies.postCompactCalls++
      spies.postCompactSummary = data.compactSummary
      return {}
    },
  }
}

function softDeps(
  spies: Spies,
  deferApply: boolean,
): ReturnType<typeof createLegacySoftDeps> {
  const input: LegacySoftDepsInput = {
    toolUseContext: {} as never,
    cacheSafeParams: {} as never,
    querySource: 'repl_main_thread',
    tokenCount: 180_000,
    autoCompactThreshold: 170_000,
    deferApply,
    compactConversation: (async (
      _messages: unknown,
      _context: unknown,
      _cache: unknown,
      _suppress: unknown,
      _instructions: unknown,
      _isAuto: unknown,
      _info: unknown,
      options: { deferApply?: boolean } | undefined,
    ) => {
      spies.compactCalls++
      spies.seenOptions = options
      return legacyResult
    }) as unknown as LegacySoftDepsInput['compactConversation'],
    runPostCompactCleanup: () => {
      spies.cleanupCalls++
    },
    setLastSummarizedMessageId: () => {
      spies.resetCalls++
    },
  }
  return createLegacySoftDeps(input)
}

/** Let the runner's promise chain settle. */
function flush(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0))
}

describe('speculative preview (deferApply)', () => {
  test('commit after an appended turn applies once and keeps the tail', async () => {
    const spies = makeSpies()
    const tail = [
      { ...message, uuid: 'u2' } as unknown as Message,
      { ...message, uuid: 'u3' } as unknown as Message,
    ]
    const manager = createSpeculationManager({
      enabled: true,
      runner: () =>
        runCompactionV2(RUN_REQUEST, {
          soft: softDeps(spies, true),
          deferApply: true,
          persist: async () => {
            spies.persistCalls++
            return null
          },
          env: {},
        }),
    })
    const ctx: SpeculationContext = {
      messages: [message],
      tokenCount: 90_000,
      thresholdTokens: 100_000,
      model: 'test-model',
    }

    expect(manager.maybeStart(ctx)).toBe(true)
    await flush()
    const consumed = manager.consume({
      ...ctx,
      messages: [message, ...tail],
    })
    expect(consumed?.appendedMessages).toEqual(tail)
    // Preview must not fire commit-only hooks.
    expect(spies.postCompactCalls).toBe(0)

    await applyCompactionOutcome(
      consumed?.result.deferredApply?.outcome,
      {
        messages: [message],
        querySource: 'repl_main_thread',
        applySideEffects: () => {
          spies.sideEffectCalls++
        },
      },
      applyDeps(spies),
    )

    expect(spies.persistCalls).toBe(1)
    expect(spies.cleanupCalls).toBe(1)
    expect(spies.sideEffectCalls).toBe(1)
    expect(spies.resetCalls).toBe(1)
    // The PostCompact hooks the preview skipped run exactly once at commit,
    // with the committed summary.
    expect(spies.postCompactCalls).toBe(1)
    expect(spies.postCompactSummary).toBe('summary text')
  })

  test('commit clears the live file caches (the preview only cleared its clone)', async () => {
    const spies = makeSpies()
    const result = await runCompactionV2(RUN_REQUEST, {
      soft: softDeps(spies, true),
      deferApply: true,
      env: {},
    })
    const outcome = result.outcome
    expect(outcome?.kind).toBe('compacted')

    const readFileState = new Map([['/a.ts', { content: 'x' }]])
    const loadedNestedMemoryPaths = new Set(['/mem/a.md'])
    const liveContext = {
      readFileState,
      loadedNestedMemoryPaths,
      abortController: new AbortController(),
    }

    await applyCompactionOutcome(
      outcome,
      {
        messages: [message],
        querySource: 'repl_main_thread',
        applySideEffects: () => {},
        toolUseContext: liveContext as never,
      },
      applyDeps(spies),
    )

    expect(readFileState.size).toBe(0)
    expect(loadedNestedMemoryPaths.size).toBe(0)
  })

  test('computes the summary without persisting, cleaning up, or applying writes', async () => {
    const spies = makeSpies()
    const result = await runCompactionV2(RUN_REQUEST, {
      soft: softDeps(spies, true),
      deferApply: true,
      persist: async () => {
        spies.persistCalls++
        return null
      },
      env: {},
    })

    expect(result.outcome?.kind).toBe('compacted')
    expect(result.outcome?.method).toBe('soft')
    // The summary itself was computed...
    expect(spies.compactCalls).toBe(1)
    expect(spies.seenOptions?.deferApply).toBe(true)
    // ...but nothing was written or cleaned up.
    expect(spies.persistCalls).toBe(0)
    expect(spies.cleanupCalls).toBe(0)
    expect(spies.resetCalls).toBe(0)
    expect(spies.sideEffectCalls).toBe(0)
  })

  test('a discarded preview never reaches the writers', async () => {
    const spies = makeSpies()
    const manager = createSpeculationManager({
      enabled: true,
      runner: async () => {
        return runCompactionV2(RUN_REQUEST, {
          soft: softDeps(spies, true),
          deferApply: true,
          persist: async () => {
            spies.persistCalls++
            return null
          },
          env: {},
        })
      },
    })

    const ctx: SpeculationContext = {
      messages: [message],
      tokenCount: 90_000,
      thresholdTokens: 100_000,
      model: 'test-model',
    }
    expect(manager.maybeStart(ctx)).toBe(true)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(manager.state()).toBe('armed')
    // Branch rewritten → discard. The preview ran (computation), but no
    // journal/cleanup/apply side effect happened.
    manager.cancel()
    expect(manager.state()).toBe('idle')
    expect(spies.persistCalls).toBe(0)
    expect(spies.cleanupCalls).toBe(0)
    expect(spies.resetCalls).toBe(0)
    expect(spies.sideEffectCalls).toBe(0)
  })

  test('commit applies exactly one persist + one cleanup + transcript writes', async () => {
    const spies = makeSpies()
    const result = await runCompactionV2(RUN_REQUEST, {
      soft: softDeps(spies, true),
      deferApply: true,
      persist: async () => {
        spies.persistCalls++
        return null
      },
      env: {},
    })
    const outcome = result.outcome
    expect(outcome?.kind).toBe('compacted')

    const entry = await applyCompactionOutcome(
      outcome,
      {
        messages: [message],
        querySource: 'repl_main_thread',
        applySideEffects: () => {
          spies.sideEffectCalls++
        },
      },
      applyDeps(spies),
    )

    expect(entry).toBe('entry' as never)
    expect(spies.persistCalls).toBe(1)
    expect(spies.cleanupCalls).toBe(1)
    expect(spies.resetCalls).toBe(1)
    expect(spies.sideEffectCalls).toBe(1)
    expect(spies.postCompactCalls).toBe(1)
  })

  test('direct (non-deferred) runs keep writing immediately', async () => {
    const spies = makeSpies()
    const result = await runCompactionV2(RUN_REQUEST, {
      soft: softDeps(spies, false),
      persist: async () => {
        spies.persistCalls++
        return null
      },
      env: {},
    })

    expect(result.outcome?.kind).toBe('compacted')
    expect(spies.compactCalls).toBe(1)
    expect(spies.seenOptions?.deferApply).toBe(false)
    expect(spies.persistCalls).toBe(1)
    expect(spies.cleanupCalls).toBe(1)
    expect(spies.resetCalls).toBe(1)
  })

  test('non-soft outcomes journal without soft transcript/cleanup effects', async () => {
    const spies = makeSpies()
    const outcome = {
      kind: 'compacted' as const,
      method: 'remote' as const,
      cutPoint: {
        firstKeptEntryId: 'u1',
        tokensBefore: 180_000,
        boundaryMessage: { uuid: 'b' } as never,
      },
      tokensSaved: 100_000,
      headroomTokens: 0,
      summary: 'remote summary',
    }

    await applyCompactionOutcome(
      outcome,
      {
        messages: [message],
        querySource: 'repl_main_thread',
        applySideEffects: () => {
          spies.sideEffectCalls++
        },
      },
      applyDeps(spies),
    )

    expect(spies.persistCalls).toBe(1)
    expect(spies.cleanupCalls).toBe(0)
    expect(spies.resetCalls).toBe(0)
    expect(spies.sideEffectCalls).toBe(0)
    // Remote/snapcompact never run PostCompact hooks on the direct path.
    expect(spies.postCompactCalls).toBe(0)
  })
})

// Integration gap (recorded, not silently missing): the query.ts promotion
// wiring — config validation before switching, the one-shot retry, and the
// revert to the original model when the retried request ends with any
// isApiErrorMessage — is exercised by the query() loop with injected deps
// (`src/__tests__/queryAutonomyProviderBoundary.test.ts` is the harness
// template). That harness needs `feature('COMPACTION_V2')` plus a settings
// stub for `contextWindowOverrides`, which pulls the full query graph; this
// workspace's dependency cache cannot resolve it (missing @opentelemetry /
// ajv transitive packages), so the case is recorded here rather than faked
// with an orchestrator-only unit test that never touches query.ts.
test.skip('query.ts promotion retry reverts on any API error (integration)', () => {})
