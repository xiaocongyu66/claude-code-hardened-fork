/**
 * Tests for fix: 修复穷鬼模式的写入问题
 *
 * Before the fix, poorMode was an in-memory boolean that reset on restart.
 * After the fix, it reads from / writes to settings.json via
 * getInitialSettings() and updateSettingsForSource().
 */
import { afterAll, describe, expect, test, beforeEach, mock } from 'bun:test'
import * as settingsModule from '../../../utils/settings/settings.js'

// ── Mocks must be declared before the module under test is imported ──────────

let mockSettings: Record<string, unknown> = {}
let lastUpdate: { source: string; patch: Record<string, unknown> } | null = null

// 真实面捕获必须绕开 mock 注册表：Bun 把 mock.module 提升到静态导入之前，
// 同 specifier（无论别名还是相对形式，均解析到同一注册表条目）捕获到的
// 都是 mock 自身（实测：别名捕获 → 门控透传无限递归）。改用 ?query 后缀
// 新实例范式（与本文件主语 '../poorMode.js?poorModeTest' 同款）：后缀
// 强制全新模块求值，拿到未污染的生产语义面。
type RealSettingsFacePM = {
  getInitialSettings: () => Record<string, unknown>
  getSettingsForSource: () => Record<string, unknown>
  getSettings_DEPRECATED: () => Record<string, unknown>
  rawSettingsContainsKey: (k: string) => boolean
  hasAutoModeOptIn: () => boolean
  getUseAutoModeDuringPlan: () => boolean
}
const realSettingsFaceSpecifierPM =
  '../../../utils/settings/settings.js?realFace'
const realSettingsFacePM = (await import(
  realSettingsFaceSpecifierPM
)) as unknown as RealSettingsFacePM
let usePoorModeSettingsStubs = true
const stubbedPM = <T>(stub: T, real: T): T =>
  usePoorModeSettingsStubs ? stub : real
mock.module('src/utils/settings/settings.js', () => ({
  ...realSettingsFacePM,
  loadManagedFileSettings: () => ({ settings: null, errors: [] }),
  getManagedFileSettingsPresence: () => ({
    hasBase: false,
    hasDropIns: false,
  }),
  parseSettingsFile: () => ({ settings: null, errors: [] }),
  getSettingsRootPathForSource: () => '',
  getSettingsFilePathForSource: () => undefined,
  getRelativeSettingsFilePathForSource: () => '',
  getInitialSettings: () =>
    stubbedPM(
      mockSettings,
      realSettingsFacePM.getInitialSettings() as Record<string, unknown>,
    ),
  getSettingsForSource: () =>
    stubbedPM(mockSettings, realSettingsFacePM.getSettingsForSource()),
  getPolicySettingsOrigin: () => null,
  getSettingsWithErrors: () => ({ settings: mockSettings, errors: [] }),
  getSettingsWithSources: () => ({ effective: mockSettings, sources: [] }),
  getSettings_DEPRECATED: () =>
    stubbedPM(mockSettings, realSettingsFacePM.getSettings_DEPRECATED()),
  settingsMergeCustomizer: () => undefined,
  getManagedSettingsKeysForLogging: () => [],
  // Keep unrelated exports aligned with the real settings module so this
  // full-surface mock cannot change later test files if Bun keeps it alive.
  hasAutoModeOptIn: () =>
    stubbedPM(true, (realSettingsFacePM.hasAutoModeOptIn as () => boolean)()),
  hasSkipDangerousModePermissionPrompt: () => false,
  getAutoModeConfig: () => undefined,
  getUseAutoModeDuringPlan: () =>
    stubbedPM(
      true,
      (realSettingsFacePM.getUseAutoModeDuringPlan as () => boolean)(),
    ),
  rawSettingsContainsKey: (key: string) =>
    stubbedPM(
      key in mockSettings,
      (realSettingsFacePM.rawSettingsContainsKey as (k: string) => boolean)(
        key,
      ),
    ),
  updateSettingsForSource: (source: string, patch: Record<string, unknown>) => {
    lastUpdate = { source, patch }
    mockSettings = { ...mockSettings, ...patch }
  },
}))

// 门控 stub（share-projectdir 的 child_process 同款范式）：注册表面永不
// 撤下，但 settings 接缝由 flag 门控——本套件测试期 ON，afterAll 翻 OFF。
// 泄漏的注册表条目在 OFF 后与真实模块行为完全一致（真实快照透传），
// 任意加载顺序下后加载消费者拿到的都是生产语义。
afterAll(() => {
  usePoorModeSettingsStubs = false
})

// Import AFTER mocks are registered. The query suffix gives this file its own
// module instance so cross-file poorMode.js mocks cannot replace the subject
// under test during Bun's shared coverage run.
const poorModeModulePath = '../poorMode.js?poorModeTest'
const { isPoorModeActive, setPoorMode } = (await import(
  poorModeModulePath
)) as typeof import('../poorMode.js')

// ── Tests ────────────────────────────────────────────────────────────────────

describe('isPoorModeActive — reads from settings on first call', () => {
  beforeEach(() => {
    lastUpdate = null
  })

  test('returns false when settings has no poorMode key', () => {
    mockSettings = {}
    // Force re-read by setting internal state via setPoorMode then checking
    setPoorMode(false)
    expect(isPoorModeActive()).toBe(false)
  })

  test('returns true when settings.poorMode === true', () => {
    mockSettings = { poorMode: true }
    setPoorMode(true)
    expect(isPoorModeActive()).toBe(true)
  })
})

describe('setPoorMode — persists to settings', () => {
  beforeEach(() => {
    lastUpdate = null
  })

  test('setPoorMode(true) calls updateSettingsForSource with poorMode: true', () => {
    setPoorMode(true)
    expect(lastUpdate).not.toBeNull()
    expect(lastUpdate!.source).toBe('userSettings')
    expect(lastUpdate!.patch.poorMode).toBe(true)
  })

  test('setPoorMode(false) calls updateSettingsForSource with poorMode: undefined (removes key)', () => {
    setPoorMode(false)
    expect(lastUpdate).not.toBeNull()
    expect(lastUpdate!.source).toBe('userSettings')
    // false || undefined === undefined — key should be removed to keep settings clean
    expect(lastUpdate!.patch.poorMode).toBeUndefined()
  })

  test('isPoorModeActive() reflects the value set by setPoorMode()', () => {
    setPoorMode(true)
    expect(isPoorModeActive()).toBe(true)

    setPoorMode(false)
    expect(isPoorModeActive()).toBe(false)
  })

  test('toggling multiple times stays consistent', () => {
    setPoorMode(true)
    setPoorMode(true)
    expect(isPoorModeActive()).toBe(true)

    setPoorMode(false)
    setPoorMode(false)
    expect(isPoorModeActive()).toBe(false)
  })
})
