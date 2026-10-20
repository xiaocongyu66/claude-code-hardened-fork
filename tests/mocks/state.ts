/**
 * Shared partial mock for src/bootstrap/state.ts
 *
 * Covers the most commonly imported exports plus their transitive callers.
 * Add exports here when new tests need them — never mock exports that don't exist.
 *
 * Usage:
 *   import { stateMock } from '../../../tests/mocks/state'
 *   mock.module('src/bootstrap/state.js', stateMock)
 */
import { tmpdir } from 'os'
import { join } from 'path'
// Real namespace object — loaded to harvest the COMPLETE export-name surface
// (211+ named exports). Bun's ESM linking verifies named imports against the
// mock module's OWN properties at file-load time, so a partial mock that
// misses any statically imported name (e.g. waitForScrollIdle, consumed via
// utils/git/gitFilesystem) poisons the whole worker process with
// "Export named '...' not found" — process-global, order-dependent
// (mock.module 不可撤). The namespace value is only used for its keys; the
// Proxy below still hands out noop for every non-overridden export.
// .js 扩展名（tsconfig allowImportingTsExtensions 未开，.ts 静态导入 TS5097；
// Bun 运行时把 .js 解析回 .ts 源文件——与 src/ 内部导入约定一致）。
import * as realBootstrapStateModule from 'src/bootstrap/state.js'

const realStateSurface = realBootstrapStateModule as unknown as Record<
  string | symbol,
  unknown
>

export function stateMock() {
  const noop = () => {}
  // Explicit (value-driven) surface — the most commonly imported exports.
  const explicit: Record<string | symbol, unknown> = {
    // Session identity
    getSessionId: () => 'mock-session-id',
    regenerateSessionId: noop,
    getParentSessionId: () => undefined,
    switchSession: noop,
    onSessionSwitch: () => () => {},

    // CWD / project — 真实透传（不在此处伪造路径）：伪造 '/mock/cwd' 会随
    // last-write-wins 漂进后加载的消费者（如 CdTool.test.ts 在文件体用真实
    // setter 锚定 cwd），让 not_found/same 判定集体失真。显式覆盖只留给
    // 与 cwd 无关的纯计数/会话接缝。

    // Direct-connect
    getDirectConnectServerUrl: () => undefined,
    setDirectConnectServerUrl: noop,

    // Duration / cost accumulators
    addToTotalDurationState: noop,
    resetTotalDurationStateAndCost_FOR_TESTS_ONLY: noop,
    addToTotalCostState: noop,
    getTotalCostUSD: () => 0,
    getTotalAPIDuration: () => 0,
    getTotalDuration: () => 0,
    getTotalAPIDurationWithoutRetries: () => 0,
    getTotalToolDuration: () => 0,
    addToToolDuration: noop,

    // Turn stats
    getTurnHookDurationMs: () => 0,
    addToTurnHookDuration: noop,
    resetTurnHookDuration: noop,
    getTurnHookCount: () => 0,
    getTurnToolDurationMs: () => 0,
    resetTurnToolDuration: noop,
    getTurnToolCount: () => 0,
    getTurnClassifierDurationMs: () => 0,
    addToTurnClassifierDuration: noop,
    resetTurnClassifierDuration: noop,
    getTurnClassifierCount: () => 0,

    // Stats store
    getStatsStore: () => ({}),
    setStatsStore: noop,

    // Interaction time
    updateLastInteractionTime: noop,
    flushInteractionTime: noop,

    // Lines changed
    addToTotalLinesChanged: noop,
    getTotalLinesAdded: () => 0,
    getTotalLinesRemoved: () => 0,

    // Token counts
    getTotalInputTokens: () => 0,
    getTotalOutputTokens: () => 0,
    getTotalCacheReadInputTokens: () => 0,
    getTotalCacheCreationInputTokens: () => 0,
    getTotalWebSearchRequests: () => 0,
    getTurnOutputTokens: () => 0,
    getCurrentTurnTokenBudget: () => null,

    // API request state
    setLastAPIRequest: noop,
    getLastAPIRequest: () => null,
    setLastAPIRequestMessages: noop,
    getLastAPIRequestMessages: () => [],

    // Various getters (add as needed)
    getIsNonInteractiveSession: () => false,
    getSdkAgentProgressSummariesEnabled: () => false,
    addSlowOperation: noop,
  }
  return withCompleteExportSurface(explicit)
}

/**
 * ESM link guard + real-semantics baseline: Bun verifies a consumer's named
 * imports against the mock module's OWN properties at file-load time (Proxy
 * `get` traps don't help; a missing name fails the whole worker with
 * "Export named '…' not found"). Every real src/bootstrap/state.ts export the
 * mock does not explicitly drive now keeps its REAL implementation (real
 * module snapshot passthrough) instead of a noop — a noop fallback poisons
 * already-bound consumers process-globally with `undefined` returns
 * (getPlanSlugCache/getModelStrings/getSessionCreatedTeams/getInlinePlugins
 * 撞出 "undefined is not an object"，CI run 39422044190 全量 33 fail 的主根因).
 * mock.module 是进程级 last-write-wins，任意顺序注册都安全的前提是基线真实。
 */
function withCompleteExportSurface(
  explicit: Record<string | symbol, unknown>,
): Record<string | symbol, unknown> {
  return new Proxy(
    { ...realStateSurface, ...explicit },
    {
      get(target, prop) {
        if (prop in target) return target[prop]
        // Unknown state export (new in src/bootstrap/state.ts): real passthrough
        // so consumers keep production semantics; undefined only for symbols.
        return realStateSurface[prop]
      },
    },
  )
}

/**
 * Functional variant of the state mock: unlike {@link stateMock} (纯真实基线
 * + 显式接缝覆盖），this mirrors the REAL bootstrap/state semantics —
 * cwd/project-root setters are stateful, the session-cron store works, and
 * resetStateForTests resets to safe defaults. Use it in test files whose
 * subjects resolve paths through getProjectRoot() (e.g. cronTasks) AND
 * register it before importing the module under test, so ordering against
 * other files' bootstrap/state registrations cannot poison the paths
 * (CI log /tmp/test1c.log:551-659, 879-921: durable cron writes hit
 * `EACCES: permission denied, mkdir '/mock'`).
 *
 * Unknown state exports fall back to the real module via the Proxy so newly
 * added state exports never break consumers.
 */
export function functionalStateMock() {
  // Default to a temp-dir-rooted cwd/project so a test that writes relative
  // to the root before calling setProjectRoot cannot spray files into the
  // repo checkout (stray writes land under the OS temp dir instead).
  const defaultCwd = join(tmpdir(), 'bootstrap-state-mock')
  const state = {
    sessionId: 'mock-session-id',
    cwd: defaultCwd,
    originalCwd: defaultCwd,
    projectRoot: defaultCwd,
    sessionCronTasks: [] as Array<Record<string, unknown>>,
  }
  const noop = () => {}

  const explicit: Record<string | symbol, unknown> = {
    // Session identity (debug.ts reads getSessionId)
    getSessionId: () => state.sessionId,
    regenerateSessionId: noop,
    getParentSessionId: () => undefined,
    switchSession: noop,
    onSessionSwitch: () => () => {},

    // CWD / project root — real stateful semantics (mirrors state.ts 506-528)
    getOriginalCwd: () => state.originalCwd,
    setOriginalCwd: (cwd: string) => {
      state.originalCwd = cwd.normalize('NFC')
    },
    getProjectRoot: () => state.projectRoot,
    setProjectRoot: (cwd: string) => {
      state.projectRoot = cwd.normalize('NFC')
    },
    getCwdState: () => state.cwd,
    setCwdState: (cwd: string) => {
      state.cwd = cwd.normalize('NFC')
    },

    // Session cron store — real semantics (mirrors state.ts 1274-1295)
    getSessionCronTasks: () => state.sessionCronTasks,
    addSessionCronTask: (task: Record<string, unknown>) => {
      state.sessionCronTasks.push(task)
    },
    removeSessionCronTasks: (ids: readonly string[]): number => {
      if (ids.length === 0) return 0
      const idSet = new Set(ids)
      const remaining = state.sessionCronTasks.filter(
        t => !idSet.has((t as { id: string }).id),
      )
      const removed = state.sessionCronTasks.length - remaining.length
      if (removed > 0) {
        state.sessionCronTasks = remaining
      }
      return removed
    },

    // Tests-only reset: back to initial values (mirrors resetStateForTests)
    resetStateForTests: () => {
      state.sessionId = 'mock-session-id'
      state.cwd = defaultCwd
      state.originalCwd = defaultCwd
      state.projectRoot = defaultCwd
      state.sessionCronTasks = []
    },

    // Direct-connect
    getDirectConnectServerUrl: () => undefined,
    setDirectConnectServerUrl: noop,

    // Duration / cost accumulators
    addToTotalDurationState: noop,
    resetTotalDurationStateAndCost_FOR_TESTS_ONLY: noop,
    addToTotalCostState: noop,
    getTotalCostUSD: () => 0,
    getTotalAPIDuration: () => 0,
    getTotalDuration: () => 0,
    getTotalAPIDurationWithoutRetries: () => 0,
    getTotalToolDuration: () => 0,
    addToToolDuration: noop,

    // Turn stats
    getTurnHookDurationMs: () => 0,
    addToTurnHookDuration: noop,
    resetTurnHookDuration: noop,
    getTurnToolDurationMs: () => 0,
    addToTotalAPIDuration: noop,
    getTurnToolCount: () => 0,
    resetTurnToolCount: noop,

    // log.ts transitive imports
    setLastAPIRequest: noop,
    getLastAPIRequest: () => null,
    setLastAPIRequestMessages: noop,
    getLastAPIRequestMessages: () => [],
    updateLastInteractionTime: noop,
    flushInteractionTime: noop,

    // Stats store
    getStatsStore: () => ({}),
    setStatsStore: noop,

    // Lines changed
    addToTotalLinesChanged: noop,
    getTotalLinesAdded: () => 0,
    getTotalLinesRemoved: () => 0,

    // Token counts
    getTotalInputTokens: () => 0,
    getTotalOutputTokens: () => 0,
    getTotalCacheReadInputTokens: () => 0,
    getTotalCacheCreationInputTokens: () => 0,
    getTotalWebSearchRequests: () => 0,
    getTurnOutputTokens: () => 0,
    getCurrentTurnTokenBudget: () => null,
    streamTokensForTurn: noop,

    // API request state
    setLastAPIRequestOptions: noop,

    // Misc getters (same defaults as tests/mocks/state.ts)
    getIsNonInteractiveSession: () => false,
    getSdkAgentProgressSummariesEnabled: () => false,
    addSlowOperation: noop,
  }

  // Same ESM link guard as stateMock: complete export-name surface + noop
  // backstop for exports added later (see withCompleteExportSurface).
  return withCompleteExportSurface(explicit)
}
