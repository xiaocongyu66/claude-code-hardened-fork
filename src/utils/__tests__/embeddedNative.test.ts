import { describe, expect, test } from 'bun:test'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))

function probeWindowsVendor(arch: string, present: boolean) {
  // mock.module 是进程全局的；子进程隔离避免污染其他 loader 测试。
  const script = `
    import { mock } from 'bun:test'
    import * as fs from 'node:fs'
    import * as nodeModule from 'node:module'
    import { debugMock } from './tests/mocks/debug.ts'

    const checked = []
    const loaded = []
    const native = { marker: 'vendor-native' }
    mock.module('node:fs', () => ({
      ...fs,
      existsSync: path => {
        checked.push(path)
        return ${JSON.stringify(present)}
      },
    }))
    mock.module('node:module', () => ({
      ...nodeModule,
      createRequire: () => path => {
        loaded.push(path)
        return native
      },
    }))
    mock.module('src/utils/debug.ts', debugMock)

    const { loadNativeModule, isCompiledBinary } =
      await import('./src/utils/embeddedNative.ts')
    if (isCompiledBinary()) throw new Error('Expected vendor-only fixture')

    const platform = Object.getOwnPropertyDescriptor(process, 'platform')
    const arch = Object.getOwnPropertyDescriptor(process, 'arch')
    try {
      Object.defineProperty(process, 'platform', { value: 'win32' })
      Object.defineProperty(process, 'arch', { value: ${JSON.stringify(arch)} })
      const result = loadNativeModule(
        'loader-probe',
        'loader-fixture',
        mod => mod.marker === 'vendor-native',
      )
      console.log(JSON.stringify({ result, checked, loaded }))
    } finally {
      Object.defineProperty(process, 'platform', platform)
      Object.defineProperty(process, 'arch', arch)
    }
  `
  const child = Bun.spawnSync([process.execPath, '-e', script], {
    cwd: repoRoot,
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 10_000,
  })
  expect(child.exitCode, child.stderr.toString()).toBe(0)
  return JSON.parse(child.stdout.toString()) as {
    result: { marker: string } | null
    checked: string[]
    loaded: string[]
  }
}

describe('loadNativeModule Windows vendor loading', () => {
  for (const [arch, triple] of [
    ['arm64', 'aarch64-pc-windows-msvc'],
    ['x64', 'x86_64-pc-windows-msvc'],
  ] as const) {
    test(`${arch} process loads its matching vendor candidate`, () => {
      // 依据进程架构选 ABI；ARM Windows 上的 x64 进程也必须加载 x64。
      const { result, checked, loaded } = probeWindowsVendor(arch, true)
      expect(result).toEqual({ marker: 'vendor-native' })
      expect(checked).toHaveLength(1)
      expect(checked[0]?.replaceAll('\\', '/')).toEndWith(
        `/vendor/loader-fixture/${triple}/loader-probe.node`,
      )
      expect(loaded).toEqual(checked)
    })

    test(`${arch} process returns null when the candidate is missing`, () => {
      const { result, checked, loaded } = probeWindowsVendor(arch, false)
      expect(result).toBeNull()
      expect(checked).toHaveLength(1)
      expect(checked[0]?.replaceAll('\\', '/')).toEndWith(
        `/vendor/loader-fixture/${triple}/loader-probe.node`,
      )
      expect(loaded).toEqual([])
    })
  }

  for (const arch of ['ia32', 'arm', 'riscv64']) {
    test(`${arch} process does not probe or load a Windows binary`, () => {
      const { result, checked, loaded } = probeWindowsVendor(arch, true)
      expect(result).toBeNull()
      expect(checked).toEqual([])
      expect(loaded).toEqual([])
    })
  }
})
