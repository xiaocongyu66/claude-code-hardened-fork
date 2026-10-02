import { t } from '../i18n/index.js'
import { readdir, readFile, unlink, writeFile } from 'fs/promises'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { getClaudeConfigHomeDir } from '../utils/envUtils.js'
import { isProcessRunning } from '../utils/genericProcessUtils.js'
import { jsonParse, jsonStringify } from '../utils/slowOperations.js'
import { selectEngine } from './bg/engines/index.js'
import type { SessionEntry } from './bg/engine.js'

export type { SessionEntry } from './bg/engine.js'

function getSessionsDir(): string {
  return join(getClaudeConfigHomeDir(), 'sessions')
}

export async function listLiveSessions(): Promise<SessionEntry[]> {
  const dir = getSessionsDir()
  let files: string[]
  try {
    files = await readdir(dir)
  } catch {
    return []
  }

  const sessions: SessionEntry[] = []
  for (const file of files) {
    if (!/^\d+\.json$/.test(file)) continue
    const pid = parseInt(file.slice(0, -5), 10)

    if (!isProcessRunning(pid)) {
      void unlink(join(dir, file)).catch(() => {})
      continue
    }

    try {
      const raw = await readFile(join(dir, file), 'utf-8')
      const entry = jsonParse(raw) as SessionEntry
      sessions.push(entry)
    } catch {
      // Corrupt file — skip
    }
  }

  return sessions
}

export function findSession(
  sessions: SessionEntry[],
  target: string,
  options: { sessionIdOnly?: boolean } = {},
): SessionEntry | undefined {
  // A full session ID is authoritative; never reinterpret its numeric prefix
  // as a PID. Do not add prefix matching to this shared CLI resolver.
  const byId = sessions.filter(s => s.sessionId === target)
  if (byId.length > 0) return byId.length === 1 ? byId[0] : undefined
  if (options.sessionIdOnly) return undefined

  const asNum = /^[1-9]\d*$/.test(target) ? Number(target) : NaN
  const matches = sessions.filter(
    s =>
      (Number.isSafeInteger(asNum) && s.pid === asNum) ||
      (s.name !== undefined && s.name === target),
  )
  // Duplicate names and PID/name collisions must not depend on roster order.
  return matches.length === 1 ? matches[0] : undefined
}

/**
 * 重命名指定会话（fleet ctrl+r）。updateSessionName 只能改当前进程自己的
 * pid 文件——跨进程改名直接读写目标 `<pid>.json`。
 */
export async function renameSession(
  pid: number,
  name: string,
): Promise<boolean> {
  // 官方体系（syncJobName）：主写 jobs/<short>/state.json，旧 pid.json 兼容写
  const sessions = await listLiveSessions()
  const entry = sessions.find(s => s.pid === pid)
  if (!entry) return false
  const { syncJobName } = await import('./fleet/jobState.js')
  const st = await syncJobName(
    entry.sessionId.slice(0, 8),
    name,
    'user',
    entry.sessionId,
  )
  if (!st) return false
  const file = join(getSessionsDir(), `${pid}.json`)
  try {
    const raw = await readFile(file, 'utf-8')
    const legacy = jsonParse(raw) as SessionEntry
    legacy.name = name
    await writeFile(file, jsonStringify(legacy), 'utf-8')
  } catch {
    // 旧文件缺失不致命
  }
  return true
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleString()
}

/**
 * Resolve the engine type for an existing session.
 * Backward-compatible: sessions without an `engine` field are inferred
 * from the presence of `tmuxSessionName`.
 */
/** 会话状态枚举的显示映射（busy/interactive 等数据值 → 中文）。 */
const STATUS_LABELS: Record<string, string> = {
  busy: '忙碌',
  idle: '空闲',
  crashed: '已崩溃',
  exited: '已退出',
}

/** 会话类型枚举的显示映射。 */
const KIND_LABELS: Record<string, string> = {
  interactive: '交互',
  headless: '无头',
}

function resolveSessionEngine(session: SessionEntry): 'tmux' | 'detached' {
  if (session.engine) return session.engine
  return session.tmuxSessionName ? 'tmux' : 'detached'
}

// ── printAgentsJson（官方 printAgentsJson 1:1——`claude agents --json` 契约）──

/** live session 的 status 归一（官方 p()）。 */
function normalizeStatus(
  status: string | undefined,
): 'busy' | 'idle' | 'waiting' | undefined {
  if (status === 'idle') return 'idle'
  if (status === 'waiting') return 'waiting'
  if (status) return 'busy'
  return undefined
}

/** job state → 运行类别（官方 y()：working/blocked/done/failed/stopped）。 */
function categorizeJobState(
  state: { status?: string; tempo?: string; terminalOutcome?: string },
  liveStatus: string | undefined,
): 'working' | 'blocked' | 'done' | 'failed' | 'stopped' {
  if (liveStatus === 'busy') return 'working'
  if (state.terminalOutcome) {
    if (state.terminalOutcome === 'completed') return 'done'
    if (
      state.terminalOutcome === 'failed' ||
      state.terminalOutcome === 'crashed'
    )
      return 'failed'
    return 'stopped'
  }
  if (state.tempo === 'blocked' || liveStatus === 'waiting') return 'blocked'
  return 'working'
}

export interface AgentsJsonRow {
  pid?: number
  id?: string
  cwd: string
  kind: 'background' | 'interactive'
  startedAt: number
  sessionId?: string
  name?: string
  status?: 'busy' | 'idle' | 'waiting'
  waitingFor?: string
  state?: 'working' | 'blocked' | 'done' | 'failed' | 'stopped'
}

/**
 * 官方 printAgentsJson 语义（binary 2.1.283 实证）：
 *   三源融合（live sessions + jobs roster）→ pid 去重 → 默认只报
 *   working/blocked 或有 live session 的 job（done/stopped 需 --all）→
 *   startedAt 升序 → pretty JSON。
 */
export async function printAgentsJson(
  cwd?: string,
  all = false,
): Promise<void> {
  const rows: AgentsJsonRow[] = []
  const emittedPids = new Set<number>()

  // 源 1+2：live sessions（旧 pid.json）+ jobs roster（新 job 目录）
  const [sessions, jobsResult] = await Promise.all([
    listLiveSessions(),
    import('./fleet/jobState.js').then(m => m.listJobs()).catch(() => []),
  ])

  // bg live sessions 按 shortId 索引（jobId → session）
  const liveByShort = new Map<string, (typeof sessions)[number]>()
  for (const s of sessions) {
    if (s.kind === 'bg') liveByShort.set(s.sessionId.slice(0, 8), s)
  }

  // 第一遍：jobs（fleet roster）
  for (const job of jobsResult) {
    const live = liveByShort.get(job.id)
    if (live) emittedPids.add(live.pid)
    const liveStatus = live?.status
    const state = categorizeJobState(job.state, liveStatus)
    if (!all && !live && state !== 'working' && state !== 'blocked') continue
    const name = live?.name ?? job.state.name
    rows.push({
      ...(live ? { pid: live.pid } : {}),
      id: job.id,
      cwd: live?.cwd ?? job.state.cwd,
      kind: 'background',
      startedAt: live?.startedAt ?? job.state.startedAt,
      sessionId: live?.sessionId ?? job.state.sessionId,
      ...(name ? { name } : {}),
      ...(liveStatus ? { status: normalizeStatus(liveStatus) } : {}),
      ...(liveStatus === 'waiting' && live?.waitingFor
        ? { waitingFor: live.waitingFor }
        : {}),
      state,
    })
  }

  // 第二遍：未入 roster 的 live sessions（interactive + 孤儿 bg）
  for (const s of sessions) {
    if (emittedPids.has(s.pid)) continue
    if (
      s.kind === 'bg' &&
      liveByShort.has(s.sessionId.slice(0, 8)) &&
      jobsResult.some(j => j.id === s.sessionId.slice(0, 8))
    )
      continue
    const name = s.name
    rows.push({
      pid: s.pid,
      cwd: s.cwd,
      kind: s.kind === 'bg' ? 'background' : 'interactive',
      startedAt: s.startedAt,
      ...(s.sessionId ? { sessionId: s.sessionId } : {}),
      ...(name ? { name } : {}),
      ...(s.status ? { status: normalizeStatus(s.status) } : {}),
      ...(s.status === 'waiting' && s.waitingFor
        ? { waitingFor: s.waitingFor }
        : {}),
    })
  }

  rows.sort((a, b) => a.startedAt - b.startedAt)
  console.log(JSON.stringify(rows, null, 2))
}

/**
 * `cch agents` — list background sessions.
 */
export async function psHandler(_args: string[]): Promise<void> {
  // 批次 E：融合 jobs 目录——终态 job 一并显示（已停止|已完成|已失败）
  const [sessions, fleetJobs] = await Promise.all([
    listLiveSessions(),
    import('./fleet/jobState.js').then(m => m.listJobs()).catch(() => []),
  ])
  const liveShorts = new Set(sessions.map(s => s.sessionId.slice(0, 8)))
  const pastJobs = fleetJobs.filter(j => !liveShorts.has(j.id))

  if (sessions.length === 0 && pastJobs.length === 0) {
    console.log('没有活跃会话。')
    return
  }

  console.log(`共 ${sessions.length} 个活跃会话：\n`)

  for (const s of sessions) {
    const engineType = resolveSessionEngine(s)
    const parts: string[] = [
      `  PID: ${s.pid}`,
      `  类型：${KIND_LABELS[s.kind] ?? s.kind}`,
      `  引擎：${engineType === 'tmux' ? 'tmux' : '独立进程'}`,
      `  会话：${s.sessionId}`,
      `  CWD: ${s.cwd}`,
    ]

    if (s.name) parts.push(`  名称：${s.name}`)
    if (s.startedAt) parts.push(`  启动于：${formatTime(s.startedAt)}`)
    if (s.status) parts.push(`  状态：${STATUS_LABELS[s.status] ?? s.status}`)
    if (s.waitingFor) parts.push(`  等待：${s.waitingFor}`)
    if (s.bridgeSessionId) parts.push(`  Bridge: ${s.bridgeSessionId}`)
    if (s.tmuxSessionName) parts.push(`  Tmux：${s.tmuxSessionName}`)
    if (s.logPath) parts.push(`  日志：${s.logPath}`)

    console.log(parts.join('\n'))
    console.log()
  }

  // 终态 job（PAST）：官方 earlier 行的文本形态
  for (const job of pastJobs) {
    const state = categorizeJobState(job.state, undefined)
    const label =
      state === 'done' ? '已完成' : state === 'failed' ? '已失败' : '已停止'
    const parts = [
      `  ID: ${job.id}`,
      `  类型：${KIND_LABELS[job.state.kind] ?? job.state.kind}`,
      `  会话：${job.state.sessionId}`,
      `  CWD: ${job.state.cwd}`,
      `  状态：${label}`,
    ]
    if (job.state.name) parts.push(`  名称：${job.state.name}`)
    console.log(parts.join('\n'))
    console.log()
  }
}

/**
 * `cch logs <target>` — show logs for a session.
 */
export async function logsHandler(target: string | undefined): Promise<void> {
  const sessions = await listLiveSessions()

  if (!target) {
    if (sessions.length === 0) {
      console.log('没有活跃会话。')
      return
    }
    if (sessions.length === 1) {
      target = sessions[0]!.sessionId
    } else {
      console.log(t('Multiple sessions active. Specify one:'))
      for (const s of sessions) {
        const label = s.name ? `${s.name} (${s.sessionId})` : s.sessionId
        console.log(`  ${label}  PID=${s.pid}`)
      }
      return
    }
  }

  const session = findSession(sessions, target)
  if (!session) {
    console.error(`Session not found: ${target}`)
    process.exitCode = 1
    return
  }

  if (!session.logPath) {
    console.log(`No log path recorded for session ${session.sessionId}`)
    return
  }

  try {
    const content = await readFile(session.logPath, 'utf-8')
    process.stdout.write(content)
  } catch (e) {
    console.error(`Failed to read log file: ${session.logPath}`)
    console.error(e instanceof Error ? e.message : String(e))
    process.exitCode = 1
  }
}

/**
 * `cch bg attach <target>` — attach to a background session.
 *
 * Engine-aware: tmux sessions use tmux attach, detached sessions use log tail.
 */
export async function attachHandler(
  target: string | undefined,
  options: { sessionIdOnly?: boolean } = {},
): Promise<void> {
  const sessions = await listLiveSessions()

  if (!target) {
    // Find bg sessions (tmux or detached)
    const bgSessions = sessions.filter(
      s => s.tmuxSessionName || s.engine === 'detached',
    )
    if (bgSessions.length === 0) {
      console.log(
        t('No background sessions to attach to. Start one with `cch bg`.'),
      )
      return
    }
    if (bgSessions.length === 1) {
      target = bgSessions[0]!.sessionId
    } else {
      console.log(t('Multiple background sessions. Specify one:'))
      for (const s of bgSessions) {
        const label = s.name ? `${s.name} (${s.sessionId})` : s.sessionId
        const engineType = resolveSessionEngine(s)
        console.log(`  ${label}  PID=${s.pid}  engine=${engineType}`)
      }
      return
    }
  }

  const session = findSession(sessions, target, options)
  if (!session) {
    console.error(`Session not found or ambiguous: ${target}`)
    process.exitCode = 1
    return
  }

  const engineType = resolveSessionEngine(session)

  try {
    if (engineType === 'tmux') {
      const { TmuxEngine } = await import('./bg/engines/tmux.js')
      const tmux = new TmuxEngine()
      if (!(await tmux.available())) {
        console.error(
          'tmux is no longer available. Cannot attach to tmux session.',
        )
        process.exitCode = 1
        return
      }
      await tmux.attach(session)
    } else {
      const { DetachedEngine } = await import('./bg/engines/detached.js')
      const detached = new DetachedEngine()
      await detached.attach(session)
    }
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e))
    process.exitCode = 1
  }
}

/**
 * `cch bg kill <target>` — kill a session.
 */
export async function killHandler(
  target: string | undefined,
  options: { sessionIdOnly?: boolean } = {},
): Promise<void> {
  const sessions = await listLiveSessions()

  if (!target) {
    if (sessions.length === 0) {
      console.log(t('No active sessions to kill.'))
      return
    }
    console.log(t('Specify a session to kill:'))
    for (const s of sessions) {
      const label = s.name ? `${s.name} (${s.sessionId})` : s.sessionId
      console.log(`  ${label}  PID=${s.pid}`)
    }
    return
  }

  const session = findSession(sessions, target, options)
  if (!session) {
    console.error(`Session not found or ambiguous: ${target}`)
    process.exitCode = 1
    return
  }

  console.log(`Killing session ${session.sessionId} (PID: ${session.pid})...`)

  try {
    process.kill(session.pid, 'SIGTERM')
  } catch {
    console.log(t('Session already exited.'))
  }

  await new Promise(resolve => setTimeout(resolve, 2000))

  if (isProcessRunning(session.pid)) {
    try {
      process.kill(session.pid, 'SIGKILL')
      console.log(t('Session force-killed.'))
    } catch {
      console.log(t('Session exited during grace period.'))
    }
  } else {
    console.log(t('Session stopped.'))
  }

  // 官方语义（writeReapedTerminalState）：stop≠delete——落终态收割，
  // 保留 job 目录供 fleet 显示 stopped；目录由 48h reaper 或 rm 清理。
  const { writeReapedTerminalState, reapLegacySession } = await import(
    './fleet/jobState.js'
  )
  try {
    await writeReapedTerminalState(
      session.sessionId.slice(0, 8),
      'stopped',
      session.sessionId,
    )
  } finally {
    await reapLegacySession(session.pid)
  }
}

/**
 * `cch bg [args]` — start a background session.
 *
 * Cross-platform: uses TmuxEngine on macOS/Linux when tmux is available,
 * falls back to DetachedEngine on Windows or when tmux is absent.
 */
export async function handleBgStart(args: string[]): Promise<void> {
  // 官方 launcher 协议（1:1）：
  // ① CLAUDE_CODE_PROCESS_WRAPPER 设置但不可用 → refuse（stderr + exit 1，
  //    "refuse to start rather than run unwrapped"）
  // ② record 可用 → 经 wrapper argv 拉起共享 daemon（"will start the next
  //    background service through it"）
  // ③ 未设置 → 无 launcher，daemon ensure 走默认 detached 通道
  const pw = await import('../daemon/processWrapper.js')
  const wrapperError = pw.getWrapperError()
  if (wrapperError) {
    const diag = await pw.wrapperDiagnostics()
    pw.refuse('bg', diag ?? wrapperError)
  }
  try {
    const { ensureSharedDaemon } = await import('../daemon/sharedClient.js')
    const argv = pw.getWrapperArgv()
    await ensureSharedDaemon(
      process.cwd(),
      argv.length > 0 ? { wrapperArgv: argv } : {},
    )
  } catch {
    // supervisor 不可用不阻塞会话发起（未设置 wrapper 的合法形态）
  }

  const engine = await selectEngine()

  // Strip --bg/--background from args (for backward-compat shortcut)
  const filteredArgs = args.filter(a => a !== '--bg' && a !== '--background')

  const sessionName = `claude-bg-${randomUUID().slice(0, 8)}`
  const logPath = join(
    getClaudeConfigHomeDir(),
    'sessions',
    'logs',
    `${sessionName}.log`,
  )

  try {
    const result = await engine.start({
      sessionName,
      args: filteredArgs,
      env: { ...process.env },
      logPath,
      cwd: process.cwd(),
    })

    console.log(
      t('Background session started: {{name}}', { name: result.sessionName }),
    )
    console.log(t('  Engine: {{engine}}', { engine: result.engineUsed }))
    console.log(t('  Log: {{path}}', { path: result.logPath }))
    console.log()
    console.log(
      t('Use `cch bg attach {{name}}` to reconnect.', {
        name: result.sessionName,
      }),
    )
    console.log(t('Use `cch agents` to list sessions.'))
    console.log(
      t('Use `cch stop {{name}}` to stop.', { name: result.sessionName }),
    )
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e))
    process.exitCode = 1
  }
}
