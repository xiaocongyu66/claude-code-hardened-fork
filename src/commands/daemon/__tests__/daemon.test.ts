// Locale pin FIRST（首导入钉死模式，见 tests/mocks/localeEn.ts）：
// 本机 zh locale 下 t() 返回中文包文案（如 daemon 描述「管理后台会话和
// 守护进程」），断言的英文 'daemon' 子串翻转。CI / en 环境恒等。
import '../../../../tests/mocks/localeEn.js'
import { describe, test, expect } from 'bun:test'

describe('/daemon command', () => {
  test('index exports a valid Command', async () => {
    const mod = await import('../index.js')
    const cmd = mod.default
    expect(cmd.name).toBe('daemon')
    expect(cmd.type).toBe('local-jsx')
    expect(typeof cmd.load).toBe('function')
    expect(cmd.description).toContain('daemon')
  })

  test('daemon module exports call function', async () => {
    const mod = await import('../daemon.js')
    expect(typeof mod.call).toBe('function')
  })

  test('argumentHint lists subcommands', async () => {
    const mod = await import('../index.js')
    const cmd = mod.default
    expect(cmd.argumentHint).toContain('status')
    expect(cmd.argumentHint).toContain('bg')
  })
})
