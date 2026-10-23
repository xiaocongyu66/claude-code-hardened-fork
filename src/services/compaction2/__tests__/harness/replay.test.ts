import { describe, expect, test } from 'bun:test'
import { runCompactionV2, type DecisionTraceEntry } from '../../orchestrator.js'
import {
  buildFixtureMessages,
  createFixtureCounter,
  createFixtureMethods,
  loadFixture,
  loadFixtures,
  type CompactionFixture,
  type GoldenTraceEntry,
} from './fixtures.js'

const FIXED_NOW = 1_700_000_000_000

/** Project the live trace onto the golden fields (ignore trigger/at/warning). */
function goldenTrace(trace: readonly DecisionTraceEntry[]): GoldenTraceEntry[] {
  return trace.map(entry => {
    const picked: GoldenTraceEntry = {
      method: entry.method,
      outcome: entry.outcome,
      reason: entry.reason,
    }
    if (entry.tokensSaved !== undefined) picked.tokensSaved = entry.tokensSaved
    if (entry.headroomTokens !== undefined) {
      picked.headroomTokens = entry.headroomTokens
    }
    return picked
  })
}

async function replay(fixture: CompactionFixture) {
  const counter = createFixtureCounter(fixture)
  const { methods, canRunMethod } = createFixtureMethods(fixture)
  return runCompactionV2(
    {
      model: fixture.model,
      trigger: fixture.trigger,
      messages: buildFixtureMessages(fixture),
      windowTokens: fixture.windowTokens,
      tokenCount: fixture.tokenCount,
      settings: fixture.settings,
    },
    {
      methods,
      countTokens: counter.countMessages,
      now: () => FIXED_NOW,
      ...(canRunMethod ? { canRunMethod } : {}),
    },
  )
}

describe('compaction replay fixtures', () => {
  const fixtures = loadFixtures()

  test('ships a stable, uniquely named fixture set', () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(4)
    expect(fixtures.length).toBeLessThanOrEqual(6)
    expect(new Set(fixtures.map(fixture => fixture.name)).size).toBe(
      fixtures.length,
    )
  })

  for (const fixture of fixtures) {
    test(`golden trace: ${fixture.name}`, async () => {
      const result = await replay(fixture)

      expect(result.shouldCompact).toBe(fixture.expected.shouldCompact)
      if (fixture.expected.thresholdTokens !== undefined) {
        expect(result.threshold.thresholdTokens).toBe(
          fixture.expected.thresholdTokens,
        )
      }
      expect(result.outcome?.kind ?? null).toBe(fixture.expected.outcomeKind)
      expect(goldenTrace(result.trace)).toEqual(fixture.expected.trace)
      // Every recorded decision belongs to this trigger and the injected clock.
      expect(
        result.trace.every(entry => entry.trigger === fixture.trigger),
      ).toBe(true)
      expect(result.trace.every(entry => entry.at === FIXED_NOW)).toBe(true)
    })
  }
})

describe('compaction replay boundaries', () => {
  test('an empty message array terminates the chain without running a method', async () => {
    const base = loadFixture('corrupt-empty-messages')
    const empty: CompactionFixture = {
      ...base,
      name: 'empty-array',
      tokenCount: 0,
      messages: [],
      // Default method order so the whole chain is walked and skipped.
      settings: {},
      methods: { ...base.methods, shake: null, soft: null },
      expected: {
        shouldCompact: true,
        outcomeKind: null,
        trace: [
          { method: 'remote', outcome: 'skipped', reason: 'unavailable' },
          { method: 'snapcompact', outcome: 'skipped', reason: 'unavailable' },
          { method: 'handoff', outcome: 'skipped', reason: 'unavailable' },
          { method: 'shake', outcome: 'skipped', reason: 'unavailable' },
          { method: 'soft', outcome: 'skipped', reason: 'unavailable' },
          {
            method: null,
            outcome: 'skipped',
            reason: 'all-methods-unavailable-or-failed',
            headroomTokens: 170_000,
          },
        ],
      },
    }

    const result = await replay(empty)

    expect(result.outcome).toBeUndefined()
    expect(goldenTrace(result.trace)).toEqual(empty.expected.trace)
  })

  test('the loader returns fresh copies', () => {
    const first = loadFixtures()
    first[0]!.expected.trace[0]!.reason = 'mutated'
    first[0]!.settings.methodOrder = ['soft']

    const second = loadFixture(first[0]!.name)
    expect(second.expected.trace[0]!.reason).not.toBe('mutated')
    expect(second.settings.methodOrder).not.toEqual(['soft'])
  })
})
