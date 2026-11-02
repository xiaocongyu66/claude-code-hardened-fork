import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, readlinkSync, statSync } from 'node:fs'
import {
  encodeBatch,
  encodeInspect,
  encodeText,
  type NativeBinding,
} from '../src/index.js'

// 静态 require 仍由 Bun 打包真实 loader，避免独立 tsc 引入 debug 的业务依赖树。
const { isCompiledBinary, loadNativeModule } = require('../../../src/utils/embeddedNative.ts') as {
  isCompiledBinary(): boolean
  loadNativeModule<T>(
    name: string,
    vendorSubPath: string,
    validate: (mod: Record<string, unknown>) => boolean,
  ): T | null
}

declare const EMBEDDED_SMOKE: {
  mode: 'valid' | 'missing' | 'invalid'
  moduleName: string
  vendorSubPath: string
  payloadSha256: string
}

const { mode, moduleName, vendorSubPath, payloadSha256 } = EMBEDDED_SMOKE
assert.equal(process.platform, 'linux')
assert.equal(process.arch, 'x64')
assert.equal(process.argv.length, 2, 'No external native or fixture arguments')
assert.equal(isCompiledBinary(), true)
const runtime = {
  bun: Bun.version,
  versions: process.versions,
  execPath: process.execPath,
  cwd: process.cwd(),
}
console.log(JSON.stringify({ mode, moduleName, runtime, compiled: true }))
const binding = loadNativeModule<NativeBinding>(
  moduleName,
  vendorSubPath,
  mod =>
    typeof mod.protocolVersion === 'function' &&
    typeof mod.Session === 'function',
)
if (mode !== 'valid') {
  assert.equal(binding, null, 'Negative case unexpectedly loaded a binding')
  console.log(JSON.stringify({ mode, loaderResult: null, runtime }))
  console.error(
    `EMBEDDED_SMOKE_REJECTED_${mode.toUpperCase()}: loader returned null`,
  )
  process.exit(mode === 'missing' ? 42 : 43)
}
assert.ok(binding, 'Valid embedded binding must load')
assert.equal(binding.protocolVersion(), 1)

// cwd 不排除 vendor 回退；同名 memfd 的内容和可执行映射才证明来源。
const expectedLink = `/memfd:cch-native-${moduleName} (deleted)`
const matchingFds = readdirSync('/proc/self/fd').filter(fd => {
  try {
    return readlinkSync(`/proc/self/fd/${fd}`) === expectedLink
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
})
assert.equal(matchingFds.length, 1, 'Expected exactly one fixture memfd')
const fdPath = `/proc/self/fd/${matchingFds[0]}`
const inode = statSync(fdPath, { bigint: true }).ino.toString()
const actualSha256 = createHash('sha256')
  .update(readFileSync(fdPath))
  .digest('hex')
assert.equal(actualSha256, payloadSha256)
const executableMaps = readFileSync('/proc/self/maps', 'utf8')
  .split('\n')
  .filter(line => {
    const fields = line.trim().split(/\s+/)
    return (
      fields[1]?.includes('x') &&
      fields[4] === inode &&
      fields.slice(5).join(' ') === expectedLink
    )
  })
assert.ok(executableMaps.length > 0, 'memfd inode must have executable mapping')

const session = new binding.Session()
const before = session.stats()
assert.equal(before.closed, false)
assert.equal(before.liveNodes, 1)
const text = 'embedded native 文本'
const applied = session.applyBatch(
  encodeBatch(before.revision, [
    {
      op: 'create',
      temp: 7,
      parent: { id: before.root },
      kind: 'text',
      text: encodeText(text),
    },
  ]),
)
assert.equal(applied.revision, before.revision + 1)
assert.equal(applied.created.length, 1)
assert.equal(applied.created[0]!.temp, 7)
const id = applied.created[0]!.id
const snapshots = session.inspect(encodeInspect([before.root, id]))
assert.deepEqual(snapshots[0]!.children, [id])
assert.equal(snapshots[1]!.kind, 'text')
assert.equal(snapshots[1]!.text, text)
assert.deepEqual(snapshots[1]!.parent, before.root)
const afterCreate = session.stats()
assert.equal(afterCreate.liveNodes, 2)
assert.equal(afterCreate.liveTextBytes, Buffer.byteLength(text))
session.close()
const afterClose = session.stats()
assert.equal(afterClose.closed, true)
assert.equal(afterClose.liveNodes, 0)
assert.equal(afterClose.liveTextBytes, 0)
console.log(
  JSON.stringify({
    result: 'EMBEDDED_SMOKE_VALID',
    mode,
    moduleName,
    vendorSubPath,
    runtime,
    protocolVersion: binding.protocolVersion(),
    memfd: {
      fdPath,
      link: expectedLink,
      inode,
      actualSha256,
      payloadSha256,
      executableMaps,
    },
    session: { before, applied, snapshots, afterCreate, afterClose },
  }),
)
