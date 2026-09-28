import {
  listJobs,
  adoptRosterOrphans,
  watchJobDirOnce,
  type FleetJob,
  type JobState,
} from './jobState.js'
import { logForDebugging } from '../../utils/debug.js'

/**
 * Fleet store 层 —— 官方 7 个 class（Gd/Wd/qd/Xd/Cp/Ip/Jp）的 cch 实现。
 *
 * 官方语义（binary 2.1.283 逆向实证）：
 *   Gd FleetRoster.load()：双源并发（listJobs + listAliveDaemonJobs）→
 *   孤儿收养 → 已删过滤 → 乱序丢弃（load 序号）→ attachView 引用计数
 *   （首个订阅者触发监听启动）。
 *   每个 store 都是「可订阅快照 + 命令方法」的 zustand 风格最小实现。
 */

export type Unsubscribe = () => void

/** 可订阅快照基座（官方 #a=Me() emitter + getSnapshot + subscribe）。 */
class Subscribable<T> {
  protected snapshot: T
  private listeners = new Set<(snap: T) => void>()

  constructor(initial: T) {
    this.snapshot = initial
  }

  getSnapshot = (): T => this.snapshot

  subscribe = (fn: (snap: T) => void): Unsubscribe => {
    this.listeners.add(fn)
    return () => {
      this.listeners.delete(fn)
    }
  }

  protected emit(next: T): void {
    if (Object.is(next, this.snapshot)) return
    this.snapshot = next
    for (const fn of this.listeners) fn(this.snapshot)
  }
}

// ── AttachStore（官方 qd：attachingJobId/newSessionOpening/autoOpened） ──

export interface AttachSnapshot {
  attachingJobId: string | null
  newSessionOpening: boolean
  autoOpened: boolean
}

export class AttachStore extends Subscribable<AttachSnapshot> {
  constructor() {
    super({ attachingJobId: null, newSessionOpening: false, autoOpened: false })
  }
  beginAttach(jobId: string): void {
    this.emit({ ...this.getSnapshot(), attachingJobId: jobId })
  }
  endAttach(): void {
    this.emit({ ...this.getSnapshot(), attachingJobId: null })
  }
  setNewSessionOpening(opening: boolean): void {
    this.emit({ ...this.getSnapshot(), newSessionOpening: opening })
  }
  setAutoOpened(v: boolean): void {
    this.emit({ ...this.getSnapshot(), autoOpened: v })
  }
}

// ── DeleteConfirmStore（官方 Cp：pending armed/justKilled） ──

export interface DeletePending {
  id: string
  justKilled: boolean
  ungroup?: boolean
}

export class DeleteConfirmStore extends Subscribable<DeletePending | null> {
  arm(id: string, justKilled = false): void {
    this.emit({ id, justKilled })
  }
  disarm(): void {
    this.emit(null)
  }
}

// ── ViewStore（官方 Ip：groupMode/activeTab/renaming/helpOpen/debugOpen） ──

export type GroupMode = 'state' | 'group'
export type ActiveTab = 'local' | 'remote'

export interface ViewSnapshot {
  groupMode: GroupMode
  activeTab: ActiveTab
  renaming: { jobId: string; draft: string } | null
  helpOpen: boolean
  debugOpen: boolean
  groupEdit: { jobId: string; draft: string } | null
}

export class ViewStore extends Subscribable<ViewSnapshot> {
  setGroupMode(mode: GroupMode): void {
    this.emit({ ...this.getSnapshot(), groupMode: mode })
  }
  setActiveTab(tab: ActiveTab): void {
    this.emit({ ...this.getSnapshot(), activeTab: tab })
  }
  beginRename(jobId: string, initial: string): void {
    this.emit({ ...this.getSnapshot(), renaming: { jobId, draft: initial } })
  }
  updateRenameDraft(draft: string): void {
    const cur = this.getSnapshot().renaming
    if (cur) this.emit({ ...this.getSnapshot(), renaming: { ...cur, draft } })
  }
  endRename(): void {
    this.emit({ ...this.getSnapshot(), renaming: null })
  }
  setHelpOpen(open: boolean): void {
    this.emit({ ...this.getSnapshot(), helpOpen: open })
  }
  setDebugOpen(open: boolean): void {
    this.emit({ ...this.getSnapshot(), debugOpen: open })
  }
  beginGroupEdit(jobId: string, initial: string): void {
    this.emit({ ...this.getSnapshot(), groupEdit: { jobId, draft: initial } })
  }
  endGroupEdit(): void {
    this.emit({ ...this.getSnapshot(), groupEdit: null })
  }
}

// ── SelectionStore（官方 Wd：focusedIdx/hoverFocusIdx/collapsed/capExpanded） ──

export class SelectionStore extends Subscribable<{
  focusedIdx: number
  hoverFocusIdx: number | null
  collapsed: Set<string>
  capExpanded: Set<string>
}> {
  constructor(initialIdx = 0) {
    super({
      focusedIdx: initialIdx,
      hoverFocusIdx: null,
      collapsed: new Set(),
      capExpanded: new Set(),
    })
  }
  get focusedIdx(): number {
    return this.getSnapshot().focusedIdx
  }
  focus(idx: number): void {
    this.emit({ ...this.getSnapshot(), focusedIdx: Math.max(0, idx) })
  }
  navigateTo(idx: number): void {
    this.focus(idx)
  }
  hoverTo(idx: number | null): void {
    this.emit({ ...this.getSnapshot(), hoverFocusIdx: idx })
  }
  toggleCollapse(group: string): void {
    const { collapsed } = this.getSnapshot()
    const next = new Set(collapsed)
    if (next.has(group)) next.delete(group)
    else next.add(group)
    this.emit({ ...this.getSnapshot(), collapsed: next })
  }
  expandCap(group: string): void {
    const { capExpanded } = this.getSnapshot()
    const next = new Set(capExpanded)
    next.add(group)
    this.emit({ ...this.getSnapshot(), capExpanded: next })
  }
}

// ── EditorStore（官方 Xd：composer 最小态） ──

export interface EditorSnapshot {
  query: string
  mode: 'default' | 'bash'
  hint: string | null
  error: string | null
}

export class EditorStore extends Subscribable<EditorSnapshot> {
  setQuery(query: string): void {
    this.emit({ ...this.getSnapshot(), query })
  }
  setMode(mode: EditorSnapshot['mode']): void {
    this.emit({ ...this.getSnapshot(), mode })
  }
  setHint(hint: string | null): void {
    this.emit({ ...this.getSnapshot(), hint })
  }
  setError(error: string | null): void {
    this.emit({ ...this.getSnapshot(), error })
  }
  dropDraft(): void {
    this.emit({ ...this.getSnapshot(), query: '' })
  }
}

// ── FleetRoster（官方 Gd：jobs 装配中枢） ──

export interface RosterSnapshot {
  jobs: FleetJob[]
  /** load 落地标记（官方 overlaidLoadLanded）。 */
  overlaidLoadLanded: boolean
}

export interface RosterClient {
  listJobs: () => Promise<FleetJob[]>
}

/** 官方 Gd：jobs store——双源 load + 乱序丢弃 + attachView 引用计数 +
 *  pending job 目录监听。 */
export class FleetRoster extends Subscribable<RosterSnapshot> {
  private client: RosterClient
  private loadSeq = 0
  private landedSeq = 0
  private viewRefs = 0
  private deletedIds = new Set<string>()
  private pendingWatchClose: (() => void) | null = null
  private watchTimer: ReturnType<typeof setInterval> | null = null

  constructor(client?: RosterClient) {
    super({ jobs: [], overlaidLoadLanded: false })
    this.client = client ?? {
      listJobs: () => listJobs().then(j => adoptRosterOrphans(j)),
    }
  }

  /** attachView（官方 #i 引用计数）：首个订阅者启动轮询监听。 */
  attachView(pollMs = 2_000): Unsubscribe {
    this.viewRefs++
    if (this.viewRefs === 1) this.startWatching(pollMs)
    return () => {
      this.viewRefs--
      if (this.viewRefs <= 0) this.stopWatching()
    }
  }

  private startWatching(pollMs: number): void {
    this.watchTimer = setInterval(() => void this.load(), pollMs)
    this.watchTimer.unref?.()
    void this.load()
  }

  private stopWatching(): void {
    if (this.watchTimer) clearInterval(this.watchTimer)
    this.watchTimer = null
    this.pendingWatchClose?.()
    this.pendingWatchClose = null
  }

  /** watchPendingJobDir（官方语义）：某 job 目录 state.json 变更即重载。 */
  watchPendingJobDir(shortId: string): void {
    this.pendingWatchClose?.()
    this.pendingWatchClose = watchJobDirOnce(shortId, () => void this.load())
  }

  reload = (): void => {
    void this.load()
  }

  /** load（官方 Gd.load 全流程）：序号防乱序 + 已删过滤 + 收割兜底。 */
  load = async (): Promise<void> => {
    const seq = ++this.loadSeq
    let jobs: FleetJob[]
    try {
      jobs = await this.client.listJobs()
    } catch (err) {
      logForDebugging(
        `[fleet:roster] load failed: ${err instanceof Error ? err.message : String(err)}`,
        { level: 'warn' },
      )
      return
    }
    if (seq <= this.landedSeq) return // 旧 load 丢弃
    this.landedSeq = seq
    const filtered = jobs.filter(j => !this.deletedIds.has(j.id))
    this.emit({ jobs: filtered, overlaidLoadLanded: true })
  }

  /** 本地删除标记（官方 #p deletedIds——已删 job 不再回显）。 */
  markDeleted(id: string): void {
    this.deletedIds.add(id)
    this.emit({
      jobs: this.getSnapshot().jobs.filter(j => j.id !== id),
      overlaidLoadLanded: this.getSnapshot().overlaidLoadLanded,
    })
  }

  /** 收到外界 state 更新（sync 后调用 reload）。 */
  applyExternalState(_shortId: string, _state: JobState): void {
    this.reload()
  }
}

// ── host（官方 createFleetViewHost 的最小版——store 容器） ──

export interface FleetHost {
  roster: FleetRoster
  selection: SelectionStore
  view: ViewStore
  attach: AttachStore
  editor: EditorStore
  deleteConfirm: DeleteConfirmStore
}

export function createFleetHost(): FleetHost {
  return {
    roster: new FleetRoster(),
    selection: new SelectionStore(),
    view: new ViewStore(),
    attach: new AttachStore(),
    editor: new EditorStore(),
    deleteConfirm: new DeleteConfirmStore(),
  }
}
