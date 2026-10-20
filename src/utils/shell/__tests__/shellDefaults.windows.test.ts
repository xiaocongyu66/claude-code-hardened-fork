/**
 * Windows default shell: PowerShell tool on by default; ! routing prefers it.
 */
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from 'bun:test'

const settingsState: { defaultShell?: 'bash' | 'powershell' } = {}

import * as realSettingsShell from 'src/utils/settings/settings.js'
const realSettingsSnapshotShellDef: Record<string, unknown> = {
  ...realSettingsShell,
}
mock.module('src/utils/settings/settings.js', () => ({
  ...realSettingsShell,
  getInitialSettings: () => ({ ...settingsState }),
}))
// afterAll 还原真实 settings 模块：交错模型下后加载的测试文件（如
// bypassPermissionsKillswitch.test.ts 直读真实 settings.json）不再吃到
// 本文件钉死的静态 settings 面（CI run 39422044190 killswitch x3 同族根因）。
afterAll(() => {
  mock.module(
    'src/utils/settings/settings.js',
    () => realSettingsSnapshotShellDef,
  )
})

// Force windows platform for these unit tests regardless of host OS.
mock.module('src/utils/platform.js', () => ({
  getPlatform: () => 'windows' as const,
  SUPPORTED_PLATFORMS: ['macos', 'wsl'],
}))

import { isPowerShellToolEnabled } from '../shellToolUtils.js'
import { resolveDefaultShell } from '../resolveDefaultShell.js'

const ENV_KEY = 'CLAUDE_CODE_USE_POWERSHELL_TOOL'
let savedEnv: string | undefined

beforeEach(() => {
  savedEnv = process.env[ENV_KEY]
  delete process.env[ENV_KEY]
  delete settingsState.defaultShell
})

afterEach(() => {
  if (savedEnv === undefined) delete process.env[ENV_KEY]
  else process.env[ENV_KEY] = savedEnv
  delete settingsState.defaultShell
})

describe('isPowerShellToolEnabled (windows)', () => {
  test('enabled by default when env unset', () => {
    expect(isPowerShellToolEnabled()).toBe(true)
  })

  test('disabled when env is falsy', () => {
    process.env[ENV_KEY] = '0'
    expect(isPowerShellToolEnabled()).toBe(false)
    process.env[ENV_KEY] = 'false'
    expect(isPowerShellToolEnabled()).toBe(false)
  })

  test('enabled when env is truthy', () => {
    process.env[ENV_KEY] = '1'
    expect(isPowerShellToolEnabled()).toBe(true)
  })
})

describe('resolveDefaultShell (windows)', () => {
  test('defaults to powershell when tool enabled and no settings', () => {
    expect(resolveDefaultShell()).toBe('powershell')
  })

  test('honors settings.defaultShell=bash', () => {
    settingsState.defaultShell = 'bash'
    expect(resolveDefaultShell()).toBe('bash')
  })

  test('honors settings.defaultShell=powershell', () => {
    settingsState.defaultShell = 'powershell'
    expect(resolveDefaultShell()).toBe('powershell')
  })

  test('falls back to bash when PowerShell tool is disabled', () => {
    process.env[ENV_KEY] = '0'
    expect(resolveDefaultShell()).toBe('bash')
  })
})
