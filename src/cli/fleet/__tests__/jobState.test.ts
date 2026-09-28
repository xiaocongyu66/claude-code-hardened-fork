import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  ABANDONED_WORKER_MS,
  adoptRosterOrphans,
  countJobs,
  dedupeJobName,
  getJobDir,
  getJobsDir,
  isReservedGroupName,
  isSettled,
  isTerminal,
  listJobs,
  makeInitialState,
  markCrashed,
  readJobState,
  readJobStateAfterSettle,
  registerJob,
  removeJobDir,
  syncJobName,
  writeJobPinned,
  writeReapedTerminalState,
  writeStateAtomic,
} from '../jobState.js'
import { FleetRoster, createFleetHost } from '../stores.js'

let configDir: string

beforeEach(async () => {
  configDir = await mkdtemp(join(tmpdir(), 'fleet-test-'))
  process.env.CLAUDE_CONFIG_DIR = configDir
})

afterEach(async () => {
  delete process.env.CLAUDE_CONFIG_DIR
  await rm(configDir, { recursive: true, force: true })
})

function makeJob(
  overrides: Partial<Parameters<typeof makeInitialState>[0]> = {},
) {
  return makeInitialState({
    sessionId: 'abcd1234-0000-0000-0000-000000000000',
    pid: process.pid,
    cwd: '/tmp/proj',
    kind: 'bg',
    ...overrides,
  })
}

describe('jobState 目录布局', () => {
  test('getJobsDir 在 CLAUDE_CONFIG_DIR 下的 sessions/jobs', () => {
    expect(getJobsDir()).toBe(join(configDir, 'sessions', 'jobs'))
    expect(getJobDir('abcd1234')).toBe(
      join(configDir, 'sessions', 'jobs', 'abcd1234'),
    )
  })
})

describe('makeInitialState', () => {
  test('初始 schema：shortId 取 sessionId 前 8 位 + busy/active', () => {
    const st = makeJob()
    expect(st.shortId).toBe('abcd1234')
    expect(st.status).toBe('busy')
    expect(st.tempo).toBe('active')
    expect(st.nameSource).toBe('auto')
    expect(st.spawnOrigin).toBe('cli')
  })
})

describe('原子写往返', () => {
  test('writeStateAtomic → readJobState 往返一致', async () => {
    const st = makeJob()
    await writeStateAtomic(st.shortId, st)
    const back = await readJobState(st.shortId)
    expect(back?.sessionId).toBe(st.sessionId)
    expect(back?.pid).toBe(st.pid)
  })

  test('readJobState 不存在的 job 返回 null', async () => {
    expect(await readJobState('nonexist')).toBeNull()
  })

  test('registerJob 双写：job 目录 + 旧 pid.json', async () => {
    const st = makeJob()
    await registerJob(st)
    const jobs = await listJobs()
    expect(jobs).toHaveLength(1)
    expect(jobs[0]!.id).toBe('abcd1234')
    expect(jobs[0]!.alive).toBe(true)
  })
})

describe('终态收割（stop≠delete）', () => {
  test('writeReapedTerminalState 落终态但保留目录', async () => {
    const st = makeJob()
    await registerJob(st)
    await writeReapedTerminalState(st.shortId, 'stopped')
    const back = await readJobState(st.shortId)
    expect(back?.terminalOutcome).toBe('stopped')
    expect(back?.terminalAt).toBeGreaterThan(0)
    expect(isTerminal(back!)).toBe(true)
    expect(isSettled(back!)).toBe(true)
    // 目录仍在——listJobs 仍列出（fleet 显示 stopped）
    const jobs = await listJobs()
    expect(jobs).toHaveLength(1)
  })

  test('markCrashed 标记 crashed', async () => {
    const st = makeJob()
    await registerJob(st)
    await markCrashed(st.shortId)
    const back = await readJobState(st.shortId)
    expect(back?.terminalOutcome).toBe('crashed')
  })

  test('removeJobDir 显式删除', async () => {
    const st = makeJob()
    await registerJob(st)
    await removeJobDir(st.shortId)
    expect(await listJobs()).toHaveLength(0)
  })
})

describe('同步操作', () => {
  test('syncJobName 带 nameSource=user', async () => {
    const st = makeJob()
    await registerJob(st)
    const back = await syncJobName(st.shortId, 'renamed')
    expect(back?.name).toBe('renamed')
    expect(back?.nameSource).toBe('user')
  })

  test('writeJobPinned', async () => {
    const st = makeJob()
    await registerJob(st)
    const back = await writeJobPinned(st.shortId, true)
    expect(back?.pinned).toBe(true)
  })
})

describe('readJobStateAfterSettle', () => {
  test('已终态立即返回', async () => {
    const st = makeJob()
    await registerJob(st)
    await writeReapedTerminalState(st.shortId, 'completed')
    const back = await readJobStateAfterSettle(st.shortId, 500)
    expect(back?.terminalOutcome).toBe('completed')
  })
})

describe('adoptRosterOrphans', () => {
  test('死进程未落终态 → 补 crashed；48h 弃置 → 删目录', async () => {
    const deadPid = 3_999_999_999
    const orphan = makeJob({ pid: deadPid })
    await registerJob(orphan)
    const ancient = makeJob({
      sessionId: 'ffff0000-0000-0000-0000-000000000000',
      pid: deadPid,
    })
    // 手动把 updatedAt 推到 48h 以前
    await writeStateAtomic(ancient.shortId, {
      ...ancient,
      updatedAt: Date.now() - ABANDONED_WORKER_MS - 1000,
    })
    const jobs = await listJobs()
    const adopted = await adoptRosterOrphans(jobs)
    const byId = new Map(adopted.map(j => [j.id, j]))
    // 近期孤儿 → crashed 收养
    expect(byId.get(orphan.shortId)?.state.terminalOutcome).toBe('crashed')
    // 48h 弃置 → 目录删除
    expect(byId.has(ancient.shortId)).toBe(false)
  })
})

describe('countJobs', () => {
  test('按 tempo/status 分类', () => {
    const busy = { state: { ...makeJob(), status: 'busy' } } as never
    const blocked = {
      state: { ...makeJob(), tempo: 'blocked', needs: 'x' },
    } as never
    const idle = { state: { ...makeJob(), status: 'idle' } } as never
    const stopped = {
      state: { ...makeJob(), terminalOutcome: 'stopped' },
    } as never
    const c = countJobs([busy, blocked, idle, stopped])
    expect(c).toEqual({ blocked: 1, working: 1, idle: 1, terminal: 1 })
  })
})

describe('nameSource 防撞', () => {
  test('dedupeJobName 无冲突原样返回', async () => {
    expect(await dedupeJobName('alpha', ['beta'])).toEqual({
      name: 'alpha',
      collision: false,
    })
  })
  test('冲突加 -2 后缀', async () => {
    expect(await dedupeJobName('alpha', ['alpha', 'alpha-2'])).toEqual({
      name: 'alpha-3',
      collision: true,
    })
  })
  test('保留组名判定', () => {
    expect(isReservedGroupName('Pinned')).toBe(true)
    expect(isReservedGroupName('my-group')).toBe(false)
  })
})

describe('FleetRoster（官方 Gd）', () => {
  test('load 落数据 + 订阅通知', async () => {
    const st = makeJob()
    await registerJob(st)
    const roster = new FleetRoster()
    const seen: number[] = []
    const unsub = roster.subscribe(snap => seen.push(snap.jobs.length))
    await roster.load()
    expect(roster.getSnapshot().jobs).toHaveLength(1)
    expect(seen).toContain(1)
    unsub()
  })

  test('markDeleted 过滤已删 job', async () => {
    const st = makeJob()
    await registerJob(st)
    const roster = new FleetRoster()
    await roster.load()
    roster.markDeleted(st.shortId)
    expect(roster.getSnapshot().jobs).toHaveLength(0)
  })

  test('attachView 引用计数：首个订阅启动轮询，全部退订停止', async () => {
    const roster = new FleetRoster()
    const un1 = roster.attachView(50)
    const un2 = roster.attachView(50)
    un1()
    un2()
    // 再 attach 重新启动（不抛错即语义正确）
    const un3 = roster.attachView(50)
    un3()
  })

  test('自定义 client 注入（官方 listAliveDaemonJobs 双源形态）', async () => {
    const roster = new FleetRoster({
      listJobs: async () => [
        {
          id: 'aaaa1111',
          state: makeJob({ sessionId: 'aaaa1111-0000-0000-0000-000000000000' }),
          alive: true,
        },
      ],
    })
    await roster.load()
    expect(roster.getSnapshot().jobs[0]?.id).toBe('aaaa1111')
  })
})

describe('createFleetHost（官方 store 容器）', () => {
  test('六个 store 齐备', () => {
    const host = createFleetHost()
    expect(host.roster.getSnapshot().jobs).toEqual([])
    expect(host.selection.focusedIdx).toBe(0)
    expect(host.view.getSnapshot().groupMode).toBe('state')
    expect(host.attach.getSnapshot().attachingJobId).toBeNull()
    expect(host.editor.getSnapshot().query).toBe('')
    expect(host.deleteConfirm.getSnapshot()).toBeNull()
  })
})
