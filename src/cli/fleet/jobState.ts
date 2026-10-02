import { watch } from 'fs'
import {
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from 'fs/promises'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { getClaudeConfigHomeDir } from '../../utils/envUtils.js'
import { isProcessRunning } from '../../utils/genericProcessUtils.js'
import { jsonParse, jsonStringify } from '../../utils/slowOperations.js'
import { logForDebugging } from '../../utils/debug.js'

/**
 * Fleet job state 持久化体系 —— 官方 chunk-fnma234m 的 cch 实现。
 *
 * 官方语义（binary 2.1.283 逆向实证）：
 *   目录布局：getJobsDir()/<shortId>/state.json（per-job 目录，诊断文案原文：
 *   `${WA()}/<short>/state.json` — per-job state）
 *   写路径：writeStateAtomic（tmp+rename 原子替换）
 *   终态：writeReapedTerminalState（收割，不删目录——stop≠delete 分离的根）
 *   写保护：withOwnJobStateWrite / isOwnStateWriteInFlight（自身写在飞检测）
 *   名字：nameSource auto/user/collision 防撞名
 *   谓词：isSettled/isTerminal/isLoopJob/hasOutstandingAsk/isSelfDriving/isExecLaunch
 *   常量：ABANDONED_WORKER_MS=172800000（48h，官方 Uot）
 */

// ── 常量（官方值） ──

/** 孤儿 worker 判弃阈值：48h（官方 ABANDONED_WORKER_MS）。 */
export const ABANDONED_WORKER_MS = 172_800_000
/** fleet 轮询基线（官方 Vd=2000）。 */
export const FLEET_POLL_MS = 2_000
/** 组折叠上限（官方 Rm=3）。 */
export const FOLD_CAP = 3

/** 预启动状态集合（官方 PRE_BOOT_STATES：job 已登记但 worker 未起）。 */
export const PRE_BOOT_STATES = ['pending', 'scheduled', 'booting'] as const
export type PreBootState = (typeof PRE_BOOT_STATES)[number]

/** 终态集合（官方 isTerminal 语义）。 */
export const TERMINAL_STATES = [
  'stopped',
  'completed',
  'failed',
  'crashed',
] as const
export type TerminalState = (typeof TERMINAL_STATES)[number]

/** 运行 tempo（官方 Ln categorize 的 state 侧值）。 */
export type FleetTempo = 'active' | 'blocked' | 'waiting'

// ── 目录布局 ──

export function getJobsDir(): string {
  return join(getClaudeConfigHomeDir(), 'sessions', 'jobs')
}

export function getJobDir(shortId: string): string {
  return join(getJobsDir(), shortId)
}

function getStatePath(shortId: string): string {
  return join(getJobDir(shortId), 'state.json')
}

/** 旧体系兼容：`<pid>.json` 扁平注册文件（listLiveSessions 仍在读）。 */
export function getLegacySessionsDir(): string {
  return join(getClaudeConfigHomeDir(), 'sessions')
}

// ── state schema（官方 makeInitialState 形态） ──

export interface JobState {
  /** 短 id（目录名，同官方 short id——8 hex）。 */
  shortId: string
  sessionId: string
  pid: number
  cwd: string
  /** 交互/无头/bg 等（官方 kind）。 */
  kind: string
  /** 显示名。 */
  name?: string
  /** 名字来源（官方 nameSource：auto=自动 / user=用户改 / collision=防撞后缀）。 */
  nameSource?: 'auto' | 'user' | 'collision'
  /** 运行 tempo。 */
  status: 'busy' | 'idle' | 'waiting' | (string & {})
  tempo?: FleetTempo
  /** blocked 时的需求描述（官方 IDLE_NEEDS 语义）。 */
  needs?: string
  /** 详情行（activity/detail）。 */
  detail?: string
  /** 置顶。 */
  pinned?: boolean
  /** 自定义分组名（官方 writeJobGroup）。 */
  group?: string
  /** 排序序号（官方 writeSortOrder）。 */
  sortOrder?: number
  /** 派发来源（官方 spawnOrigin）。 */
  spawnOrigin?: 'fleet' | 'cli' | 'repl' | 'bridge' | (string & {})
  startedAt: number
  updatedAt: number
  /** 终态时间（收割时写，官方 writeReapedTerminalState）。 */
  terminalAt?: number
  terminalOutcome?: 'stopped' | 'completed' | 'failed' | 'crashed'
  /** 日志路径。 */
  logPath?: string
  agent?: string
  entrypoint?: string
}

/** 官方 makeInitialState：job 登记时的初始 state。 */
export function makeInitialState(init: {
  sessionId: string
  pid: number
  cwd: string
  kind: string
  name?: string
  logPath?: string
  agent?: string
  entrypoint?: string
  spawnOrigin?: JobState['spawnOrigin']
}): JobState {
  const now = Date.now()
  return {
    shortId: init.sessionId.slice(0, 8),
    sessionId: init.sessionId,
    pid: init.pid,
    cwd: init.cwd,
    kind: init.kind,
    name: init.name,
    nameSource: 'auto',
    status: 'busy',
    tempo: 'active',
    spawnOrigin: init.spawnOrigin ?? 'cli',
    startedAt: now,
    updatedAt: now,
    logPath: init.logPath,
    agent: init.agent,
    entrypoint: init.entrypoint,
  }
}

// ── 写保护（官方 withOwnJobStateWrite / isOwnStateWriteInFlight） ──

const ownWritesInFlight = new Set<string>()

export function isOwnStateWriteInFlight(shortId: string): boolean {
  return ownWritesInFlight.has(shortId)
}

/** 自身 state 写的串行保护：写在飞时后续写排队（官方 RKe 语义）。 */
export async function withOwnJobStateWrite<T>(
  shortId: string,
  fn: () => Promise<T>,
): Promise<T> {
  ownWritesInFlight.add(shortId)
  try {
    return await fn()
  } finally {
    ownWritesInFlight.delete(shortId)
  }
}

export function logJobWriteError(shortId: string, err: unknown): void {
  logForDebugging(
    `[fleet:jobState] write failed for ${shortId}: ${err instanceof Error ? err.message : String(err)}`,
    { level: 'warn' },
  )
}

// ── 读三态（官方 Ir / ePt / fkr） ──

/** readJobState：读 state.json（ENOENT → null）。 */
export async function readJobState(shortId: string): Promise<JobState | null> {
  try {
    const raw = await readFile(getStatePath(shortId), 'utf-8')
    return jsonParse(raw) as JobState
  } catch {
    return null
  }
}

/** readJobStateFreshOrNull：绕任何进程内缓存直读（官方 fkr 语义——cch 无缓存，等价直读）。 */
export async function readJobStateFreshOrNull(
  shortId: string,
): Promise<JobState | null> {
  return readJobState(shortId)
}

/** readJobStateAfterSettle：读到 settled（终态）或超时为止（官方 ePt 语义）。 */
export async function readJobStateAfterSettle(
  shortId: string,
  timeoutMs = 5_000,
): Promise<JobState | null> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const st = await readJobState(shortId)
    if (st && isSettled(st)) return st
    if (Date.now() >= deadline) return st
    await new Promise(r => setTimeout(r, 100))
  }
}

// ── 原子写（官方 ja writeStateAtomic） ──

/** writeStateAtomic：tmp 写入 + rename 原子替换（崩溃安全）。 */
export async function writeStateAtomic(
  shortId: string,
  state: JobState,
): Promise<void> {
  return withJobDirLock(shortId, 'state', () =>
    writeStateAtomicUnlocked(shortId, state),
  )
}

/** Caller must hold the state lock across ownership checks and replacement. */
async function writeStateAtomicUnlocked(
  shortId: string,
  state: JobState,
): Promise<void> {
  return withOwnJobStateWrite(shortId, async () => {
    const dir = getJobDir(shortId)
    await mkdir(dir, { recursive: true })
    // 纯写（官方 ja 语义）：不自动盖时间——时间戳更新是 sync 层
    // （updateJobState）的职责，raw 写保留调用方给的时间戳
    const next: JobState = { ...state }
    const tmp = join(dir, `.state.${randomUUID().slice(0, 8)}.tmp`)
    const final = getStatePath(shortId)
    try {
      await writeFile(tmp, jsonStringify(next), 'utf-8')
      await rename(tmp, final)
    } catch (err) {
      logJobWriteError(shortId, err)
      await unlink(tmp).catch(() => {})
      throw err
    }
  })
}

/** 读-改-写辅助（基于原子写）。 */
export async function updateJobState(
  shortId: string,
  patch: Partial<JobState>,
  expectedSessionId?: string,
): Promise<JobState | null> {
  return withJobDirLock(shortId, 'state', async () => {
    const cur = await readJobState(shortId)
    if (!cur) return null
    if (
      expectedSessionId !== undefined &&
      cur.sessionId !== expectedSessionId
    ) {
      throw new Error(`Fleet job ${shortId} belongs to a different session`)
    }
    const next: JobState = { ...cur, ...patch, updatedAt: Date.now() }
    await writeStateAtomicUnlocked(shortId, next)
    return next
  })
}

// ── 终态收割（官方 BDe writeReapedTerminalState / CKe markCrashed） ──

/** writeReapedTerminalState：标记终态，保留目录（stop≠delete 分离的根——
 *  官方语义：被停的 job 留 state.json 供 fleet 显示 stopped，目录由
 *  reaper（ABANDONED_WORKER_MS 48h）或显式 rm 清理）。 */
export async function writeReapedTerminalState(
  shortId: string,
  outcome: Exclude<JobState['terminalOutcome'], undefined>,
  expectedSessionId?: string,
): Promise<JobState | null> {
  return updateJobState(
    shortId,
    {
      terminalAt: Date.now(),
      terminalOutcome: outcome,
    },
    expectedSessionId,
  )
}

/** markCrashed：进程消失但未走正常停止路径（官方 CKe）。 */
export async function markCrashed(shortId: string): Promise<JobState | null> {
  return writeReapedTerminalState(shortId, 'crashed')
}

/** 显式删除 job 目录（官方 rm 对等——kill 二段式的第二段）。 */
export async function removeJobDir(shortId: string): Promise<void> {
  await rm(getJobDir(shortId), { recursive: true, force: true })
}

// ── 同步操作（官方 syncJob* / writeJob*） ──

export async function syncJobName(
  shortId: string,
  name: string,
  source: JobState['nameSource'] = 'user',
  expectedSessionId?: string,
): Promise<JobState | null> {
  return updateJobState(
    shortId,
    { name, nameSource: source },
    expectedSessionId,
  )
}

export async function writeJobPinned(
  shortId: string,
  pinned: boolean,
): Promise<JobState | null> {
  return updateJobState(shortId, { pinned })
}

export async function writeJobGroup(
  shortId: string,
  group: string | undefined,
): Promise<JobState | null> {
  return updateJobState(shortId, { group })
}

export async function writeSortOrder(
  shortId: string,
  sortOrder: number,
): Promise<JobState | null> {
  return updateJobState(shortId, { sortOrder })
}

export async function syncJobActivity(
  shortId: string,
  patch: {
    status?: JobState['status']
    tempo?: FleetTempo
    needs?: string
    detail?: string
  },
): Promise<JobState | null> {
  return updateJobState(shortId, patch)
}

/** resume 切换后同步 jobId 映射（官方 syncJobResumeSessionId——
 *  --resume / /resume 换 sessionId 时 state.json 里的映射不能旧）。 */
export async function syncJobResumeSessionId(
  shortId: string,
  newSessionId: string,
): Promise<JobState | null> {
  return updateJobState(shortId, {
    sessionId: newSessionId,
    shortId: newSessionId.slice(0, 8),
  })
}

// ── 谓词（官方语义） ──

/** isTerminal：终态。 */
export function isTerminal(state: JobState): boolean {
  return state.terminalOutcome !== undefined
}

/** isSettled：已落终态或结果可读（官方 Mi 语义）。 */
export function isSettled(state: JobState): boolean {
  return isTerminal(state)
}

/** isLoopJob：循环型 job（cron/loop 类，官方 PKe——cch 由 kind 前缀判定）。 */
export function isLoopJob(state: JobState): boolean {
  return state.kind.startsWith('loop')
}

/** isSelfDriving：无人值守自驱（官方 GW）。 */
export function isSelfDriving(state: JobState): boolean {
  return state.status === 'busy' && state.tempo === 'active' && !state.needs
}

/** isExecLaunch：一次性 exec 型（官方 ET——跑完即退）。 */
export function isExecLaunch(state: JobState): boolean {
  return state.kind === 'exec'
}

/** hasOutstandingAsk：有未决权限/提问（官方 xKe——blocked 的根因之一）。 */
export function hasOutstandingAsk(state: JobState): boolean {
  return state.tempo === 'blocked' && !!state.needs
}

/** terminalOutcome 兜底（官方 terminalOutcome）。 */
export function terminalOutcome(state: JobState): JobState['terminalOutcome'] {
  return state.terminalOutcome
}

// ── 名字（官方 nameSource 防撞体系） ──

/** 保留组名（官方 Qxt isReservedGroupName——state 分组名不可用作自定义组）。 */
export const RESERVED_GROUP_NAMES = new Set([
  'pinned',
  'working',
  'blocked',
  'idle',
  'done',
  'earlier',
  'past',
])

export function isReservedGroupName(name: string): boolean {
  return RESERVED_GROUP_NAMES.has(name.trim().toLowerCase())
}

export function sanitizeGroupName(name: string): string {
  return name.trim().replace(/\s+/g, ' ').slice(0, 40)
}

/** 防撞后缀（官方 collision nameSource——同名的后来者加 -2/-3）。 */
export async function dedupeJobName(
  name: string,
  existing: string[],
): Promise<{ name: string; collision: boolean }> {
  if (!existing.includes(name)) return { name, collision: false }
  for (let i = 2; i < 100; i++) {
    const candidate = `${name}-${i}`
    if (!existing.includes(candidate))
      return { name: candidate, collision: true }
  }
  return { name: `${name}-${randomUUID().slice(0, 4)}`, collision: true }
}

// ── job 登记（官方 appendRespawnFlag / syncRespawnFlag 体系的最小版） ──

/** 登记一个新 job（写初始 state.json + 迁移写旧 pid.json 兼容）。 */
export async function registerJob(state: JobState): Promise<void> {
  await writeStateAtomic(state.shortId, state)
  // 旧体系兼容写：`<pid>.json`（listLiveSessions 探活扫描仍认识它）
  const legacyFile = join(getLegacySessionsDir(), `${state.pid}.json`)
  try {
    await mkdir(getLegacySessionsDir(), { recursive: true })
    await writeFile(legacyFile, jsonStringify(state), 'utf-8')
  } catch (err) {
    logJobWriteError(state.shortId, err)
  }
}

// ── 列举（官方 av listJobs / Jht listAliveDaemonJobs 形态） ──

export interface FleetJob {
  id: string
  state: JobState
  /** 进程探活（listJobs 扫描时的快照）。 */
  alive: boolean
}

/** listJobs：扫 jobs 目录（state.json 存在即 job；终态的也列出——
 *  官方语义：fleet 显示 stopped 条目）。 */
export async function listJobs(): Promise<FleetJob[]> {
  let entries: string[]
  try {
    entries = await readdir(getJobsDir())
  } catch {
    return []
  }
  const jobs: FleetJob[] = []
  for (const shortId of entries) {
    if (!/^[\w-]{4,16}$/.test(shortId)) continue
    const state = await readJobState(shortId)
    if (!state) continue
    jobs.push({ id: shortId, state, alive: isProcessRunning(state.pid) })
  }
  return jobs
}

/** 孤儿收养（官方 Skr adoptRosterOrphans 语义的最小版）：
 *  进程已死但 state.json 未落终态的 job → 补 markCrashed。 */
export async function adoptRosterOrphans(
  jobs: FleetJob[],
): Promise<FleetJob[]> {
  const adopted: FleetJob[] = []
  for (const job of jobs) {
    if (!job.alive && !isTerminal(job.state)) {
      const elapsed = Date.now() - (job.state.updatedAt ?? job.state.startedAt)
      if (elapsed > ABANDONED_WORKER_MS) {
        // 48h 弃置 → 直接删目录（reaper）
        await removeJobDir(job.id).catch(() => {})
        continue
      }
      const st = await markCrashed(job.id)
      if (st) adopted.push({ ...job, state: st })
    } else {
      adopted.push(job)
    }
  }
  return adopted
}

// ── 目录监听（官方 pkr watchJobDirOnce：state.json 变更触发一次） ──

/** watchJobDirOnce：watch job 目录，state.json 变更时回调一次（官方语义：
 *  filename.startsWith('state.json') 才触发）。返回关闭函数。 */
export function watchJobDirOnce(
  shortId: string,
  onChange: () => void,
): () => void {
  let closed = false
  let watcher: import('fs').FSWatcher | undefined
  try {
    watcher = watch(getJobDir(shortId), (_event, filename) => {
      if (closed) return
      if (filename && !filename.startsWith('state.json')) return
      closed = true
      watcher?.close()
      onChange()
    })
    watcher.on('error', err =>
      logForDebugging(`[fleet:jobState] watch error: ${err.message}`, {
        level: 'warn',
      }),
    )
    watcher.unref()
  } catch (err) {
    logForDebugging(
      `[fleet:jobState] watch skipped: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
  return () => {
    closed = true
    watcher?.close()
  }
}

// ── 统计（fleet header counts 用） ──

export interface FleetCounts {
  blocked: number
  working: number
  idle: number
  terminal: number
}

export function countJobs(jobs: FleetJob[]): FleetCounts {
  const c: FleetCounts = { blocked: 0, working: 0, idle: 0, terminal: 0 }
  for (const j of jobs) {
    if (isTerminal(j.state)) c.terminal++
    else if (j.state.tempo === 'blocked' || j.state.status === 'waiting')
      c.blocked++
    else if (j.state.status === 'busy') c.working++
    else c.idle++
  }
  return c
}

// ── 旧体系收割（官方 reaper：旧 pid.json 探活失败即清——保留给 listLiveSessions） ──

export async function reapLegacySession(pid: number): Promise<void> {
  await unlink(join(getLegacySessionsDir(), `${pid}.json`)).catch(() => {})
}

export async function legacySessionExists(pid: number): Promise<boolean> {
  try {
    await stat(join(getLegacySessionsDir(), `${pid}.json`))
    return true
  } catch {
    return false
  }
}

/** 独占句柄工具（job dir 内锁文件用——withSortOrderLock 的最小版）。 */
export async function withJobDirLock<T>(
  shortId: string,
  key: string,
  fn: () => Promise<T>,
): Promise<T> {
  const lockPath = join(getJobDir(shortId), `.${key}.lock`)
  let fh: Awaited<ReturnType<typeof open>> | undefined
  try {
    await mkdir(getJobDir(shortId), { recursive: true })
    fh = await open(lockPath, 'wx')
  } catch (error) {
    // Never run unlocked: a contending writer may be replacing session identity.
    // Fail closed rather than silently corrupting another session's state.
    throw new Error(`Unable to lock Fleet job ${shortId} (${key})`, {
      cause: error,
    })
  }
  try {
    return await fn()
  } finally {
    await fh?.close().catch(() => {})
    await unlink(lockPath).catch(() => {})
  }
}
