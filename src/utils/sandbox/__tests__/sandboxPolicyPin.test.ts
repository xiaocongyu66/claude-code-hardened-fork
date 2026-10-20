/**
 * W4/R4 (#55) — policy-pin boundary tests for sandboxDecision.ts.
 *
 * R4: isSandboxDecisionPolicyPinned('enabled') is now a real consumer inside
 * areUnsandboxedCommandsAllowedIn — when the policy layer explicitly pins
 * sandbox.enabled=true (double condition: key present AND value true), the
 * dangerouslyDisableSandbox escape hatch is closed regardless of merged user
 * preference; only the policy layer itself allowing unsandboxed commands
 * reopens it.
 *
 * The settings source is process-mocked (same complete-mock pattern as
 * policySettings.test.ts) so the policy layer can be simulated; the merged
 * settings handed to the predicates stay explicit arguments.
 */
import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { logMock } from '../../../../tests/mocks/log.js'
import { debugMock } from '../../../../tests/mocks/debug.js'

let currentPolicy: Record<string, unknown> | null = null

mock.module('src/utils/log.ts', logMock)
mock.module('src/utils/debug.ts', debugMock)
// Complete settings.js export set (mock.module is process-global; a partial
// mock would break unrelated tests loaded later that link real named exports).
import * as realSettingsSandboxPin from 'src/utils/settings/settings.js'
const realSettingsSnapshotSandboxPin: Record<string, unknown> = {
  ...realSettingsSandboxPin,
}
const settingsMock = {
  loadManagedFileSettings: () => null,
  getManagedFileSettingsPresence: () => ({}),
  parseSettingsFile: () => null,
  getSettingsRootPathForSource: () => '/tmp',
  getSettingsFilePathForSource: () => undefined,
  getRelativeSettingsFilePathForSource: () => undefined,
  getSettingsForSource: (_source: string) => currentPolicy,
  getPolicySettingsOrigin: () => undefined,
  updateSettingsForSource: () => {},
  settingsMergeCustomizer: (_old: unknown, fresh: unknown) => fresh,
  getManagedSettingsKeysForLogging: () => [],
  getInitialSettings: () => currentPolicy ?? {},
  getSettings_DEPRECATED: () => currentPolicy ?? {},
  getSettingsWithSources: () => ({
    effective: currentPolicy ?? {},
    sources: {},
  }),
  getSettingsWithErrors: () => ({ settings: currentPolicy ?? {}, errors: [] }),
  hasSkipDangerousModePermissionPrompt: () => false,
  hasAutoModeOptIn: () => false,
  getUseAutoModeDuringPlan: () => undefined,
  getAutoModeConfig: () => undefined,
  rawSettingsContainsKey: () => false,
}
mock.module('src/utils/settings/settings.js', () => settingsMock)
// afterAll 还原真实 settings 模块：交错模型下后加载的测试文件（如
// bypassPermissionsKillswitch.test.ts 直读真实 settings.json）不再吃到
// 本文件钉死的静态 settings 面（CI run 39422044190 killswitch x3 同族根因）。
afterAll(() => {
  mock.module(
    'src/utils/settings/settings.js',
    () => realSettingsSnapshotSandboxPin,
  )
})

const { areUnsandboxedCommandsAllowedIn, areUnsandboxedCommandsDisabledIn } =
  await import('../sandboxDecision.js')

beforeEach(() => {
  currentPolicy = null
})

describe('policy-pin boundary in areUnsandboxedCommandsAllowedIn (R4)', () => {
  test('without a policy layer the merged settings decide as before', () => {
    expect(
      areUnsandboxedCommandsAllowedIn({
        sandbox: { allowUnsandboxedCommands: true },
      }),
    ).toBe(true)
    expect(
      areUnsandboxedCommandsAllowedIn({
        sandbox: { allowUnsandboxedCommands: false },
      }),
    ).toBe(false)
    expect(areUnsandboxedCommandsAllowedIn({})).toBe(true)
  })

  test('policy pins enabled=true → hatch closed, user allow cannot reopen', () => {
    currentPolicy = { sandbox: { enabled: true } }
    // Merged settings carry a user-level allow (would have opened the hatch
    // before the pin): policy wins.
    expect(
      areUnsandboxedCommandsAllowedIn({
        sandbox: { allowUnsandboxedCommands: true },
      }),
    ).toBe(false)
    expect(
      areUnsandboxedCommandsDisabledIn({
        sandbox: { allowUnsandboxedCommands: true },
      }),
    ).toBe(true)
  })

  test('policy that itself allows unsandboxed commands reopens the hatch', () => {
    currentPolicy = {
      sandbox: { enabled: true, allowUnsandboxedCommands: true },
    }
    expect(
      areUnsandboxedCommandsAllowedIn({
        sandbox: { allowUnsandboxedCommands: false },
      }),
    ).toBe(true)
  })

  test('policy sandbox block without pinning enabled stays a no-op', () => {
    // autoAllowBashIfSandboxed alone (or enabled:false) does not pin `enabled`
    // — merged settings keep deciding the hatch.
    currentPolicy = { sandbox: { autoAllowBashIfSandboxed: true } }
    expect(
      areUnsandboxedCommandsAllowedIn({
        sandbox: { allowUnsandboxedCommands: true },
      }),
    ).toBe(true)
    currentPolicy = { sandbox: { enabled: false } }
    expect(
      areUnsandboxedCommandsAllowedIn({
        sandbox: { allowUnsandboxedCommands: true },
      }),
    ).toBe(true)
  })
})
