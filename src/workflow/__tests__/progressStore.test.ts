import { expect, test } from 'bun:test'
import { createProgressBus, type ProgressBus } from '../progress/bus.js'
import {
  createProgressStoreFromBus,
  type RunProgress,
} from '../progress/store.js'
import type { AgentRunResult } from '@claude-code-hardened/workflow-engine'

const ok = (o: string): AgentRunResult => ({
  kind: 'ok',
  output: o,
  usage: { outputTokens: 1 },
})

function newStore() {
  const bus: ProgressBus = createProgressBus()
  return { bus, store: createProgressStoreFromBus(bus) }
}

test('resuming replaces the previous generation and clears stale result/error', () => {
  const { bus, store } = newStore()
  bus.emit({
    type: 'run_done',
    runId: 'r1',
    status: 'failed',
    error: 'old',
    returnValue: 'old',
  })
  const old = store.get('r1')!
  bus.emit({
    type: 'run_started',
    runId: 'r1',
    workflowName: 'new',
    meta: null,
  })
  expect(store.get('r1')).not.toBe(old)
  expect(store.get('r1')?.error).toBeUndefined()
  expect(store.get('r1')?.returnValue).toBeUndefined()
  expect(old.status).toBe('failed')
})

test('late persistence acknowledgement cannot evict a newer generation', () => {
  const { bus, store } = newStore()
  bus.emit({
    type: 'run_done',
    runId: 'r1',
    status: 'completed',
    returnValue: 'old',
  })
  const old = store.get('r1')!
  bus.emit({
    type: 'run_started',
    runId: 'r1',
    workflowName: 'new',
    meta: null,
  })
  bus.emit({
    type: 'run_done',
    runId: 'r1',
    status: 'completed',
    returnValue: 'new',
  })
  store.markPersisted(old)
  expect(() => store.assertLaunchCapacity('r1')).toThrow('unpersisted')
  expect(store.get('r1')?.returnValue).toBe('new')
})

test('terminal retention evicts only acknowledged snapshots by count and bytes', () => {
  const bus = createProgressBus()
  const store = createProgressStoreFromBus(bus, {
    maxTerminalRuns: 2,
    maxTerminalBytes: 1500,
  })
  bus.emit({
    type: 'run_done',
    runId: 'unsaved',
    status: 'completed',
    returnValue: 'keep',
  })
  for (let i = 0; i < 100; i++) {
    const runId = `saved-${i}`
    bus.emit({
      type: 'run_done',
      runId,
      status: 'completed',
      returnValue: 'x'.repeat(800),
    })
    store.markPersisted(store.get(runId)!)
    expect(store.list().length).toBeLessThanOrEqual(2)
  }
  expect(store.get('unsaved')?.returnValue).toBe('keep')
  bus.emit({
    type: 'run_done',
    runId: 'large-unsaved',
    status: 'completed',
    returnValue: 'x'.repeat(2000),
  })
  expect(() => store.assertLaunchCapacity()).toThrow('persist')
  expect(store.get('large-unsaved')?.returnValue).toBe('x'.repeat(2000))
  store.markPersisted(store.get('large-unsaved')!)
  expect(() => store.assertLaunchCapacity()).not.toThrow()
})

test('run_started creates entry; phase_started/done updates phases', () => {
  const { bus, store } = newStore()
  bus.emit({ type: 'run_started', runId: 'r1', workflowName: 'w', meta: null })
  bus.emit({ type: 'phase_started', runId: 'r1', phase: 'A' })
  bus.emit({ type: 'phase_started', runId: 'r1', phase: 'B' })
  bus.emit({ type: 'phase_done', runId: 'r1', phase: 'A' })
  const r = store.get('r1')!
  expect(r.phases.map(p => [p.title, p.status])).toEqual([
    ['A', 'done'],
    ['B', 'running'],
  ])
  expect(r.currentPhase).toBe('B')
})

test('concurrent agent_done correlates by agentId precisely (regression of old LIFO race)', () => {
  const { bus, store } = newStore()
  bus.emit({ type: 'run_started', runId: 'r1', workflowName: 'w', meta: null })
  bus.emit({
    type: 'agent_started',
    runId: 'r1',
    agentId: 0,
    label: 'a',
    phase: 'A',
  })
  bus.emit({
    type: 'agent_started',
    runId: 'r1',
    agentId: 1,
    label: 'b',
    phase: 'A',
  })
  bus.emit({
    type: 'agent_done',
    runId: 'r1',
    agentId: 1,
    label: 'b',
    phase: 'A',
    result: ok('b-out'),
  })
  bus.emit({
    type: 'agent_done',
    runId: 'r1',
    agentId: 0,
    label: 'a',
    phase: 'A',
    result: ok('a-out'),
  })
  const agents = store.get('r1')!.agents
  expect(agents.find(x => x.id === 0)?.status).toBe('done')
  expect(agents.find(x => x.id === 1)?.status).toBe('done')
  expect(agents.find(x => x.id === 0)?.label).toBe('a')
  expect(agents.find(x => x.id === 1)?.label).toBe('b')
})

test('journal hit (agent_done without started) backfills done entry by id', () => {
  const { bus, store } = newStore()
  bus.emit({ type: 'run_started', runId: 'r1', workflowName: 'w', meta: null })
  bus.emit({
    type: 'agent_done',
    runId: 'r1',
    agentId: 7,
    label: 'c',
    phase: 'A',
    result: ok('c'),
  })
  const a = store.get('r1')!.agents.find(x => x.id === 7)!
  expect(a.status).toBe('done')
})

test('run_done terminal state + list sort + subscribe notification', () => {
  const { bus, store } = newStore()
  let calls = 0
  store.subscribe(() => calls++)
  bus.emit({ type: 'run_started', runId: 'r1', workflowName: 'w', meta: null })
  bus.emit({
    type: 'run_done',
    runId: 'r1',
    status: 'completed',
    returnValue: 42,
  })
  const r = store.get('r1')!
  expect(r.status).toBe('completed')
  expect(r.returnValue).toBe(42)
  expect(store.list().map(x => x.runId)).toEqual(['r1'])
  expect(calls).toBe(2)
})

test('run_done failed terminal state records error', () => {
  const { bus, store } = newStore()
  bus.emit({ type: 'run_started', runId: 'r2', workflowName: 'w', meta: null })
  bus.emit({ type: 'run_done', runId: 'r2', status: 'failed', error: 'boom' })
  const r = store.get('r2')!
  expect(r.status).toBe('failed')
  expect(r.error).toBe('boom')
})

test('log event does not trigger notify', () => {
  const { bus, store } = newStore()
  let calls = 0
  store.subscribe(() => calls++)
  bus.emit({ type: 'run_started', runId: 'r3', workflowName: 'w', meta: null })
  const before = calls
  bus.emit({ type: 'log', runId: 'r3', message: 'hi' })
  expect(calls).toBe(before) // log should not trigger notify
})

test('run_started persists declaredPhases (from meta.phases, order preserved)', () => {
  const { bus, store } = newStore()
  bus.emit({
    type: 'run_started',
    runId: 'r1',
    workflowName: 'w',
    meta: {
      name: 'w',
      description: 'd',
      phases: [{ title: 'Find' }, { title: 'Review' }, { title: 'Verify' }],
    },
  })
  expect(store.get('r1')!.declaredPhases).toEqual(['Find', 'Review', 'Verify'])
})

test('run_started meta is null → declaredPhases = []', () => {
  const { bus, store } = newStore()
  bus.emit({ type: 'run_started', runId: 'r1', workflowName: 'w', meta: null })
  expect(store.get('r1')!.declaredPhases).toEqual([])
})

test('agent_done persists outputShape (ok·object / ok·text / dead none)', () => {
  const { bus, store } = newStore()
  bus.emit({ type: 'run_started', runId: 'r1', workflowName: 'w', meta: null })
  bus.emit({ type: 'agent_started', runId: 'r1', agentId: 0, phase: 'A' })
  bus.emit({ type: 'agent_started', runId: 'r1', agentId: 1, phase: 'A' })
  bus.emit({ type: 'agent_started', runId: 'r1', agentId: 2, phase: 'A' })
  bus.emit({
    type: 'agent_done',
    runId: 'r1',
    agentId: 0,
    phase: 'A',
    result: { kind: 'ok', output: { x: 1 }, usage: { outputTokens: 1 } },
  })
  bus.emit({
    type: 'agent_done',
    runId: 'r1',
    agentId: 1,
    phase: 'A',
    result: { kind: 'ok', output: 'hi', usage: { outputTokens: 1 } },
  })
  bus.emit({
    type: 'agent_done',
    runId: 'r1',
    agentId: 2,
    phase: 'A',
    result: { kind: 'dead' },
  })
  const agents = store.get('r1')!.agents
  expect(agents.find(a => a.id === 0)?.outputShape).toBe('object')
  expect(agents.find(a => a.id === 1)?.outputShape).toBe('text')
  expect(agents.find(a => a.id === 2)?.outputShape).toBeUndefined()
})

test('agent_progress real-time updates token/tool (correlated by agentId)', () => {
  const { bus, store } = newStore()
  bus.emit({ type: 'run_started', runId: 'r1', workflowName: 'w', meta: null })
  bus.emit({
    type: 'agent_started',
    runId: 'r1',
    agentId: 0,
    label: 'a',
    phase: 'A',
  })
  bus.emit({
    type: 'agent_progress',
    runId: 'r1',
    agentId: 0,
    tokenCount: 1200,
    toolCount: 2,
  })
  let a = store.get('r1')!.agents.find(x => x.id === 0)!
  expect(a.tokenCount).toBe(1200)
  expect(a.toolCount).toBe(2)
  bus.emit({
    type: 'agent_progress',
    runId: 'r1',
    agentId: 0,
    tokenCount: 2400,
    toolCount: 3,
  })
  a = store.get('r1')!.agents.find(x => x.id === 0)!
  expect(a.tokenCount).toBe(2400)
  expect(a.toolCount).toBe(3)
})

test('agent_done persists model/tokenCount/toolCount (ok variant)', () => {
  const { bus, store } = newStore()
  bus.emit({ type: 'run_started', runId: 'r1', workflowName: 'w', meta: null })
  bus.emit({ type: 'agent_started', runId: 'r1', agentId: 0, phase: 'A' })
  bus.emit({
    type: 'agent_done',
    runId: 'r1',
    agentId: 0,
    phase: 'A',
    result: {
      kind: 'ok',
      output: 'x',
      usage: { outputTokens: 5 },
      model: 'glm-5.2',
      tokenCount: 22900,
      toolCount: 1,
    },
  })
  const a = store.get('r1')!.agents.find(x => x.id === 0)!
  expect(a.model).toBe('glm-5.2')
  expect(a.tokenCount).toBe(22900)
  expect(a.toolCount).toBe(1)
})

// ---- hydrate: inject historical run from disk (cross-restart recovery) ----

test('hydrate injects new run → get hits + list includes it + notifies listener', () => {
  const { store } = newStore()
  let notified = 0
  store.subscribe(() => notified++)

  const historical: RunProgress = {
    runId: 'hist-1',
    workflowName: 'old-job',
    status: 'completed',
    phases: [],
    declaredPhases: [],
    currentPhase: null,
    agents: [],
    agentCount: 5,
    returnValue: { summary: 'past' },
    startedAt: 1,
    updatedAt: 2,
  }
  store.hydrate(historical)

  expect(store.get('hist-1')).toBe(historical)
  expect(store.list().map(r => r.runId)).toContain('hist-1')
  expect(notified).toBeGreaterThan(0)
})

test('hydrate existing runId → skip (memory first, not overwritten by disk)', () => {
  const { bus, store } = newStore()
  bus.emit({
    type: 'run_started',
    runId: 'r1',
    workflowName: 'live',
    meta: null,
  })

  const stale: RunProgress = {
    runId: 'r1',
    workflowName: 'STALE-SHOULD-NOT-WIN',
    status: 'completed',
    phases: [],
    declaredPhases: [],
    currentPhase: null,
    agents: [],
    agentCount: 0,
    startedAt: 1,
    updatedAt: 2,
  }
  store.hydrate(stale)

  const got = store.get('r1')!
  expect(got.workflowName).toBe('live')
  expect(got.status).toBe('running')
})
