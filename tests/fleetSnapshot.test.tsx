/**
 * FleetView 渲染快照（无 TTY 实证）：
 * bun test tests/fleetSnapshot.test.tsx —— renderSync 抓实际帧检查布局。
 */
import { describe, expect, test } from 'bun:test'
import { PassThrough } from 'stream'

const FRAME_FILES: Array<{ file: string; name: string }> = [
  { file: 'busy', name: 'busy' },
]

function makeStdout(): { stream: PassThrough; chunks: string[] } {
  const chunks: string[] = []
  const stream = new PassThrough()
  stream.on('data', (d: Buffer) => chunks.push(d.toString()))
  ;(stream as unknown as { columns: number }).columns = 100
  ;(stream as unknown as { rows: number }).rows = 24
  ;(stream as unknown as { isTTY: boolean }).isTTY = true
  return { stream, chunks }
}

const sessions = [
  {
    sessionId: 'abcd1234-0000-0000-0000-000000000000',
    kind: 'bg',
    name: '重构登录模块',
    cwd: '/root/项目/后端服务',
    status: 'busy',
    startedAt: Date.now() - 120_000,
  },
  {
    sessionId: 'efef5678-0000-0000-0000-000000000000',
    kind: 'bg',
    name: 'fix-auth-bug',
    cwd: '/root/xiaocongyu66-claude-code',
    status: 'waiting',
    waitingFor: '确认数据库迁移方案',
    startedAt: Date.now() - 3_600_000,
  },
  {
    sessionId: '9999aaaa-0000-0000-0000-000000000000',
    kind: 'bg',
    name: 'idle-会话',
    cwd: '/tmp',
    status: 'idle',
    startedAt: Date.now() - 86_400_000,
  },
]

describe('FleetView 渲染快照', () => {
  test('抓实际帧：列对齐与间距', async () => {
    const { toFleetRows } = await import('../src/components/FleetView.js')
    const { FleetView } = await import('../src/components/FleetView.js')
    const { renderSync, ThemeProvider } = await import('@anthropic/ink')
    const rows = toFleetRows(sessions)
    const { stream, chunks } = makeStdout()
    const instance = renderSync(
      <ThemeProvider>
        <FleetView rows={rows} />
      </ThemeProvider>,
      { stdout: stream as never, exitOnCtrlC: false, patchConsole: false },
    )
    await new Promise(r => setTimeout(r, 400))
    instance.unmount()
    const raw = chunks.join('')
    // 去转义后的可读帧
    const clean = raw.replace(/\x1b\[[\d;?]*[a-zA-Z]/g, '')
    console.log('=====去转义帧=====')
    console.log(clean.split('\n').map(l => `|${l}|`).join('\n'))
    expect(raw.length).toBeGreaterThan(0)
    // 名字与图标间不应有大段空白（批次 K 的核心断言）
    const jobLine = clean.split('\n').find(l => l.includes('重构登录模块'))
    expect(jobLine).toBeDefined()
    if (jobLine) {
      // 图标后到名字前的空白不应超过 4 列
      const m = jobLine.match(/✻(\s+)/)
      expect(m === null || m[1]!.length <= 4).toBe(true)
    }
  }, 20_000)
})
