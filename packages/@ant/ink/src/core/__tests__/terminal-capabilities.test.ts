import { describe, expect, test } from 'bun:test'
import {
  TerminalCapabilities,
  decrpmStatusSupported,
} from '../terminal-capabilities.js'
import { TerminalQuerier } from '../terminal-querier.js'

describe('decrpmStatusSupported', () => {
  test('DECRPM status 1-4 supported, 0 not (官方 DECRPM 语义)', () => {
    expect(decrpmStatusSupported(0)).toBe(false)
    expect(decrpmStatusSupported(1)).toBe(true)
    expect(decrpmStatusSupported(2)).toBe(true)
    expect(decrpmStatusSupported(3)).toBe(true)
    expect(decrpmStatusSupported(4)).toBe(true)
    expect(decrpmStatusSupported(5)).toBe(false)
  })
})

describe('TerminalCapabilities', () => {
  // 最小 stdout 桩：querier 只用 stdout.write
  function fakeStdout(): NodeJS.WriteStream & { writes: string[] } {
    const writes: string[] = []
    return {
      writes,
      write(s: string) {
        writes.push(s)
        return true
      },
    } as unknown as NodeJS.WriteStream & { writes: string[] }
  }

  test('官方默认值（extendedKeys/synchronizedOutput/kittyGraphics/mousePixels=false, kittyKeyboard=true）', () => {
    const caps = new TerminalCapabilities(new TerminalQuerier(fakeStdout()))
    expect(caps.get('extendedKeys')).toBe(false)
    expect(caps.get('synchronizedOutput')).toBe(false)
    expect(caps.get('kittyKeyboard')).toBe(true)
    expect(caps.get('kittyGraphics')).toBe(false)
    expect(caps.get('mousePixels')).toBe(false)
    // 默认态 probed=false
    expect(caps.now('synchronizedOutput')).toEqual({
      value: false,
      probed: false,
    })
  })

  test('probe 后 DECRPM 响应落入 settled(probe)', async () => {
    const stdout = fakeStdout()
    const querier = new TerminalQuerier(stdout)
    const caps = new TerminalCapabilities(querier)

    // 不等真实终端——直接操控 querier 队列：先发起 probe，
    // 逐个派发 DECRPM 响应（2026=1 支持、1016=0 不支持、2027=2 支持）
    const p = caps.probe()
    // probe 写入的请求顺序：2026、1016、2027（PROBE_MODE 遍历序）+ CSI ?u，最后 flush sentinel
    // 每个 decrqm 响应按 FIFO 匹配队列中的 query
    querier.onResponse({ type: 'decrpm', mode: 2026, status: 1 })
    querier.onResponse({ type: 'decrpm', mode: 1016, status: 0 })
    querier.onResponse({ type: 'decrpm', mode: 2027, status: 2 })
    // kittyKeyboard 响应（CSI ? u → kittyKeyboard 类型）
    querier.onResponse({ type: 'kittyKeyboard', flags: 1 } as never)
    await p

    expect(caps.get('synchronizedOutput')).toBe(true)
    expect(caps.get('mousePixels')).toBe(false)
    expect(caps.get('extendedKeys')).toBe(true)
    const kitty = caps.now('kittyKeyboard')
    expect(kitty.probed).toBe(true)
    // kittyGraphics 未探测——保持默认
    expect(caps.now('kittyGraphics').probed).toBe(false)
  })
})
