/**
 * 3.8 item 3: spawn-window worktree guard in AgentTool.call.
 *
 * After createAgentWorktree succeeds, the registration steps that follow
 * (registerAsyncAgent on the async path, registerAgentForeground + the
 * runAgent iterator on the sync path) are throw-capable. Each is now guarded:
 * on failure the just-created worktree is removed via cleanupWorktreeIfNeeded
 * (same helper the completion/abort paths use) and the original error is
 * rethrown. These tests simulate registration failure after successful
 * worktree creation and assert the worktree is removed, not leaked.
 *
 * Written per repo mock rules (write-only in this batch): only the forced
 * side-effect chain + previously-registered UI/context stubs are mocked;
 * pure helpers load for real.
 */
import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { join } from 'node:path'
import { debugMock } from '../../../../../../tests/mocks/debug'
import { errorsMock } from '../../../../../../tests/mocks/errors'
import {
  localAgentTaskMock,
  resetSpawnRegistrationFailure,
  spawnRegistrationFailure,
} from '../../../../../../tests/mocks/localAgentTask'
import { logMock } from '../../../../../../tests/mocks/log'
import { functionalStateMock } from '../../../../../../tests/mocks/state'

mock.module('src/utils/log.ts', logMock)
mock.module('src/utils/debug.ts', debugMock)
mock.module('bun:bundle', () => ({ feature: () => false }))
// Functional state shim + shared errors/LocalAgentTask factories: Bun's
// mock.module is process-global, and this file previously registered a
// noop-setProjectRoot state mock and a 4-export errors.js mock that shrank
// the module for every later test file in the worker (agentToolUtils.test.ts
// needs 17 error exports) — part of why the whole AgentTool group went red
// (CI log /tmp/test1c.log:2771, 2790, 2812, 2831, 2850).
mock.module('src/bootstrap/state.js', functionalStateMock)
mock.module('src/bootstrap/state.ts', functionalStateMock)
mock.module('src/utils/errors.js', errorsMock)
mock.module('src/utils/errors.ts', errorsMock)
mock.module('src/tasks/LocalAgentTask/LocalAgentTask.js', localAgentTaskMock)

// 跨套件 mock 污染修复（真实模块快照范式推广）：本文件的 20+ 个部分替换
// mock 是 HEAD 既有污染源（"Export not found" 随链路漂移 + 已绑定消费者读
// 到 undefined，如 cwd.js 的 getCwd: () => '/tmp' 让后加载的 CdTool 并发
// override 测试拿到 '/tmp'）。统一改为「真实模块快照 + 完整导出面 + 只覆盖
// 被测接缝」，并在 afterAll 统一还原真实模块，保证本文件之后加载的测试
// 拿到未污染的注册表。forkedAgent.js / ../runAgent.js 例外（真实模块拉
// query.js 全链，保留原 stub，污染面已由 afterAll 还原之外的单点隔离）。
import * as realWorktree from 'src/utils/worktree.js'
import * as realSessionStorage from 'src/utils/sessionStorage.js'
import * as realAnalytics from 'src/services/analytics/index.js'
import * as realGrowthbook from 'src/services/analytics/growthbook.js'
import * as realAgentSummary from 'src/services/AgentSummary/agentSummary.js'
import * as realDumpPrompts from 'src/services/api/dumpPrompts.js'
import * as realCoordinatorMode from 'src/coordinator/coordinatorMode.js'
import * as realPromptCategory from 'src/utils/promptCategory.js'
import * as realPromptsConstants from 'src/constants/prompts.js'
import * as realToolModule from 'src/Tool.js'
import * as realToolsRegistry from 'src/tools.js'
import * as realAgentToolFilter from 'src/utils/agentToolFilter.js'
import * as realIds from 'src/types/ids.js'
import * as realAgentContext from 'src/utils/agentContext.js'
import * as realAgentSwarmsEnabled from 'src/utils/agentSwarmsEnabled.js'
import * as realCwd from 'src/utils/cwd.js'
import * as realEnvUtils from 'src/utils/envUtils.js'
import * as realMessages from 'src/utils/messages.js'
import * as realAgentModel from 'src/utils/model/agent.js'
import * as realPermissionMode from 'src/utils/permissions/PermissionMode.js'
import * as realPermissions from 'src/utils/permissions/permissions.js'
import * as realSdkEventQueue from 'src/utils/sdkEventQueue.js'
import * as realDiskOutput from 'src/utils/task/diskOutput.js'
import * as realTeammate from 'src/utils/teammate.js'
import * as realTeammateContext from 'src/utils/teammateContext.js'
import * as realTeleport from 'src/utils/teleport.js'
import * as realTokens from 'src/utils/tokens.js'
import * as realUuid from 'src/utils/uuid.js'
import * as realSystemPrompt from 'src/utils/systemPrompt.js'
import * as realSystemPromptType from 'src/utils/systemPromptType.js'

const realSnapshots: Array<readonly [string, Record<string, unknown>]> = [
  ['src/utils/worktree.js', { ...realWorktree }],
  ['src/utils/sessionStorage.js', { ...realSessionStorage }],
  ['src/services/analytics/index.js', { ...realAnalytics }],
  ['src/services/analytics/growthbook.js', { ...realGrowthbook }],
  ['src/services/AgentSummary/agentSummary.js', { ...realAgentSummary }],
  ['src/services/api/dumpPrompts.js', { ...realDumpPrompts }],
  ['src/coordinator/coordinatorMode.js', { ...realCoordinatorMode }],
  ['src/utils/promptCategory.js', { ...realPromptCategory }],
  ['src/constants/prompts.js', { ...realPromptsConstants }],
  ['src/Tool.js', { ...realToolModule }],
  ['src/tools.js', { ...realToolsRegistry }],
  ['src/utils/agentToolFilter.js', { ...realAgentToolFilter }],
  ['src/types/ids.js', { ...realIds }],
  ['src/utils/agentContext.js', { ...realAgentContext }],
  ['src/utils/agentSwarmsEnabled.js', { ...realAgentSwarmsEnabled }],
  ['src/utils/cwd.js', { ...realCwd }],
  ['src/utils/envUtils.js', { ...realEnvUtils }],
  ['src/utils/messages.ts', { ...realMessages }],
  ['src/utils/model/agent.js', { ...realAgentModel }],
  ['src/utils/permissions/PermissionMode.js', { ...realPermissionMode }],
  ['src/utils/permissions/permissions.js', { ...realPermissions }],
  ['src/utils/sdkEventQueue.js', { ...realSdkEventQueue }],
  ['src/utils/task/diskOutput.js', { ...realDiskOutput }],
  ['src/utils/teammate.js', { ...realTeammate }],
  ['src/utils/teammateContext.js', { ...realTeammateContext }],
  ['src/utils/teleport.js', { ...realTeleport }],
  ['src/utils/tokens.js', { ...realTokens }],
  ['src/utils/uuid.js', { ...realUuid }],
  ['src/utils/systemPrompt.js', { ...realSystemPrompt }],
  ['src/utils/systemPromptType.js', { ...realSystemPromptType }],
]

// Do not leak the registration-failure toggles into later test files.
import * as realBootstrapStateSWC from 'src/bootstrap/state.js'
const bootstrapStateSnapshotSWC: Record<string, unknown> = {
  ...realBootstrapStateSWC,
}
afterAll(() => {
  resetSpawnRegistrationFailure()
  // functionalStateMock 的 tmpdir cwd / 恒定 session id 不外溢：还原真实
  // bootstrap/state（本文件之后加载的 CdTool/cacheSafeParamsSlot 等依赖
  // 真实 cwd/session 语义）。
  mock.module('src/bootstrap/state.js', () => bootstrapStateSnapshotSWC)
  mock.module('src/bootstrap/state.ts', () => bootstrapStateSnapshotSWC)
  for (const [specifier, snapshot] of realSnapshots) {
    mock.module(specifier, () => snapshot)
  }
})

const noop = () => {}

const createdWorktrees: string[] = []
const removedWorktrees: string[] = []

mock.module('src/utils/worktree.js', () => ({
  ...realSnapshots[0][1],
  createAgentWorktree: async (slug: string) => {
    createdWorktrees.push(slug)
    return {
      worktreePath: join('/tmp', `wt-${slug}`),
      worktreeBranch: 'ccb-agent-x',
      headCommit: 'deadbeef',
      gitRoot: '/tmp',
      hookBased: false,
    }
  },
  hasWorktreeChanges: async () => false,
  removeAgentWorktree: async (p: string) => {
    removedWorktrees.push(p)
  },
}))

mock.module('src/utils/sessionStorage.js', () => ({
  ...realSnapshots[1][1],
  writeAgentMetadata: async () => {},
}))

// Registration failure toggles come from the shared localAgentTask mock
// (tests/mocks/localAgentTask.ts) — set per test before calling AgentTool.call.

// Local runAgent is never reached in these failure scenarios, but its module
// must resolve (relative specifier resolved against this __tests__ dir).
mock.module('../runAgent.js', () => ({
  runAgent: () => ({
    [Symbol.asyncIterator]: () => ({
      next: async () => ({ done: true, value: undefined }),
    }),
  }),
}))

mock.module('src/services/analytics/index.js', () => ({
  ...realSnapshots[2][1],
  logEvent: noop,
  stripProtoFields: (v: any) => v,
  attachAnalyticsSink: noop,
}))
mock.module('src/services/analytics/growthbook.js', () => ({
  ...realSnapshots[3][1],
  getFeatureValue_CACHED_MAY_BE_STALE: () => false,
}))
mock.module('src/services/AgentSummary/agentSummary.js', () => ({
  ...realSnapshots[4][1],
  startAgentSummarization: () => ({ stop: noop }),
}))
mock.module('src/services/api/dumpPrompts.js', () => ({
  ...realSnapshots[5][1],
  clearDumpState: noop,
}))
// bootstrap/state is fully covered by the functional shim registered above —
// this partial 2-export mock used to overwrite it for the whole process.
mock.module('src/coordinator/coordinatorMode.js', () => ({
  ...realSnapshots[6][1],
  isCoordinatorMode: () => false,
}))
mock.module('src/utils/promptCategory.js', () => ({
  ...realSnapshots[7][1],
  getQuerySourceForAgent: () => 'agent_tool',
}))
mock.module('src/constants/prompts.js', () => ({
  ...realSnapshots[8][1],
  getSystemPrompt: () => [],
  enhanceSystemPromptWithEnvDetails: (_getSys: any, prompt: any) => prompt,
}))
mock.module('src/Tool.js', () => ({
  ...realSnapshots[9][1],
  // Identity so AgentTool.call is exercised directly (no def wrapper).
  buildTool: (def: any) => def,
  toolMatchesName: () => false,
  findToolByName: noop,
}))
mock.module('src/tools.js', () => ({
  ...realSnapshots[10][1],
  assembleToolPool: () => [],
}))
mock.module('src/utils/agentToolFilter.js', () => ({
  ...realSnapshots[11][1],
  filterParentToolsForFork: () => [],
}))
mock.module('src/types/ids.js', () => ({
  ...realSnapshots[12][1],
  asAgentId: (id: string) => id,
}))
mock.module('src/utils/agentContext.js', () => ({
  ...realSnapshots[13][1],
  runWithAgentContext: (_ctx: any, fn: any) => fn(),
}))
mock.module('src/utils/agentSwarmsEnabled.js', () => ({
  ...realSnapshots[14][1],
  isAgentSwarmsEnabled: () => false,
}))
mock.module('src/utils/cwd.js', () => ({
  ...realSnapshots[15][1],
  getCwd: () => '/tmp',
  runWithCwdOverride: (_p: string, fn: any) => fn(),
}))
mock.module('src/utils/envUtils.js', () => ({
  ...realSnapshots[16][1],
  isEnvTruthy: () => false,
  isInProtectedNamespace: () => false,
}))
mock.module('src/utils/forkedAgent.js', () => ({}))
mock.module('src/utils/messages.ts', () => ({
  ...realSnapshots[17][1],
  createUserMessage: (args: any) => ({ type: 'user', ...args }),
  extractTextContent: (content: any[]) =>
    content
      ?.filter?.((b: any) => b.type === 'text')
      ?.map?.((b: any) => b.text)
      ?.join('') ?? '',
  getLastAssistantMessage: () => null,
  isSyntheticMessage: () => false,
  normalizeMessages: (m: any[]) => m,
}))
mock.module('src/utils/model/agent.js', () => ({
  ...realSnapshots[18][1],
  getAgentModel: () => undefined,
}))
mock.module('src/utils/permissions/PermissionMode.js', () => ({
  ...realSnapshots[19][1],
  permissionModeSchema: { parse: (v: any) => v },
}))
mock.module('src/utils/permissions/permissions.js', () => ({
  ...realSnapshots[20][1],
  // Pass-through: the shared paths under test need the discovered
  // general-purpose definition to survive the deny-rule filter.
  filterDeniedAgents: (agents: unknown[]) => agents,
  getDenyRuleForAgent: () => undefined,
}))
mock.module('src/utils/sdkEventQueue.js', () => ({
  ...realSnapshots[21][1],
  enqueueSdkEvent: noop,
  emitTaskTerminatedSdk: noop,
}))
mock.module('src/utils/task/diskOutput.js', () => ({
  ...realSnapshots[22][1],
  getTaskOutputPath: () => '/tmp/agent-out.jsonl',
}))
mock.module('src/utils/teammate.js', () => ({
  ...realSnapshots[23][1],
  getParentSessionId: () => undefined,
  isTeammate: () => false,
}))
mock.module('src/utils/teammateContext.js', () => ({
  ...realSnapshots[24][1],
  isInProcessTeammate: () => false,
}))
mock.module('src/utils/teleport.js', () => ({
  ...realSnapshots[25][1],
  teleportToRemote: async () => undefined,
  // 进程级注册表 last-write-wins：同进程后跑的消费面（如 query 链上的
  // archiveRemoteSession / pollRemoteSessionEvents）也吃这份 stub——缺
  // 导出会让后续文件加载即炸 SyntaxError（本文件断言面只消费
  // teleportToRemote，补齐是纯增量）。
  archiveRemoteSession: async () => undefined,
  pollRemoteSessionEvents: async () => undefined,
}))
mock.module('src/utils/tokens.js', () => ({
  ...realSnapshots[26][1],
  getTokenCountFromUsage: () => 0,
  getAssistantMessageContentLength: () => 0,
}))
mock.module('src/utils/uuid.js', () => ({
  ...realSnapshots[27][1],
  createAgentId: () => 'agentid-1234567890',
}))
mock.module('src/utils/systemPrompt.js', () => ({
  ...realSnapshots[28][1],
  buildEffectiveSystemPrompt: () => '',
}))
mock.module('src/utils/systemPromptType.js', () => ({
  ...realSnapshots[29][1],
  asSystemPrompt: (v: any) => v,
}))
mock.module('../BashTool/UI.js', () => ({ BackgroundHint: () => null }))
mock.module('../BashTool/toolName.js', () => ({ BASH_TOOL_NAME: 'bash' }))
mock.module('../FileReadTool/prompt.js', () => ({
  FILE_READ_TOOL_NAME: 'read',
}))
mock.module('../shared/spawnMultiAgent.js', () => ({
  spawnTeammate: async () => ({}),
}))
mock.module('./agentColorManager.js', () => ({ setAgentColor: noop }))
mock.module('./constants.js', () => ({
  AGENT_TOOL_NAME: 'agent',
  LEGACY_AGENT_TOOL_NAME: 'task',
}))
mock.module('./forkSubagent.js', () => ({ isForkSubagentEnabled: () => false }))
mock.module('./loadAgentsDir.js', () => ({
  filterAgentsByMcpRequirements: (a: any) => a,
  hasRequiredMcpServers: () => true,
  isBuiltInAgent: () => false,
}))
mock.module('./prompt.js', () => ({ getPrompt: () => '' }))
mock.module('./built-in/generalPurposeAgent.js', () => ({
  GENERAL_PURPOSE_AGENT: { agentType: 'general-purpose' },
}))

const { AgentTool } = await import('../AgentTool.js')

// call() requires canUseTool + parent assistant message; both guarded paths
// under test throw at registration before either stub is consumed.
const stubCanUseTool = async () => ({ behavior: 'allow' }) as any
const stubParentMessage = {
  type: 'assistant',
  message: { id: 'msg_parent', content: [] },
} as any

function makeContext(): any {
  return {
    getAppState: () => ({
      toolPermissionContext: {
        mode: 'default',
        additionalWorkingDirectories: new Map(),
      },
      mcp: { tools: [] },
      agentDefinitions: { activeAgents: [], customAgents: [] },
      tasks: {},
      agentNameRegistry: new Map(),
    }),
    setAppState: noop,
    abortController: new AbortController(),
    messages: [],
    // AgentTool.call resolves the spawn target through
    // toolUseContext.options.agentDefinitions.activeAgents
    // (AgentTool.tsx:477-478 — CI log /tmp/test1c.log:2763, 2782: the stub
    // previously only carried { tools: [] }, so call() crashed with
    // "undefined is not an object (evaluating
    // 'toolUseContext.options.agentDefinitions.activeAgents')" before either
    // registration path could fail).
    options: {
      tools: [],
      agentDefinitions: {
        activeAgents: [{ agentType: 'general-purpose' }],
        customAgents: [],
      },
    },
  }
}

describe('AgentTool spawn-window worktree guard', () => {
  beforeEach(() => {
    // The recorder arrays are module-scoped and the async-path test runs
    // first: without a per-test reset the sync-path test counts the async
    // test's create and sees 2 (CI /tmp/test2.log:1670 — createdWorktrees
    // expected 1, received 2), so its leak assertion is meaningless.
    createdWorktrees.length = 0
    removedWorktrees.length = 0
  })

  test('async path: registerAsyncAgent failure removes the created worktree', async () => {
    spawnRegistrationFailure.sync = false
    spawnRegistrationFailure.async = true
    try {
      await AgentTool.call(
        // isolation: 'worktree' — the guard under test only exists once
        // createAgentWorktree has run (AgentTool.tsx:796-799); the stubbed
        // worktree module in this file records the create/remove pair.
        {
          prompt: 'do work',
          run_in_background: true,
          isolation: 'worktree',
        } as any,
        makeContext(),
        stubCanUseTool,
        stubParentMessage,
      )
      throw new Error('expected AgentTool.call to reject')
    } catch (error) {
      expect((error as Error).message).toBe('register-async-failed')
    }
    expect(createdWorktrees.length).toBe(1)
    expect(removedWorktrees.length).toBe(1)
  })

  test('sync path: foreground registration failure removes the worktree', async () => {
    spawnRegistrationFailure.async = false
    spawnRegistrationFailure.sync = true
    try {
      await AgentTool.call(
        { prompt: 'do work', isolation: 'worktree' } as any,
        makeContext(),
        stubCanUseTool,
        stubParentMessage,
      )
      throw new Error('expected AgentTool.call to reject')
    } catch (error) {
      expect((error as Error).message).toBe('register-foreground-failed')
    }
    expect(createdWorktrees.length).toBe(1)
    expect(removedWorktrees.length).toBe(1)
  })
})
