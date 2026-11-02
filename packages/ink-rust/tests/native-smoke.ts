import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  encodeBatch,
  encodeInspect,
  encodeText,
  loadNative,
  loadNativePackets,
  MAX_BATCH_BYTES,
  MAX_INSPECT_BYTES,
  type NodeId,
  type Op,
} from '../src/index.ts'

const artifact = process.argv[2]
const fixturePath = process.argv[3]
assert.ok(
  artifact && fixturePath,
  'Pass absolute native artifact and fixture paths',
)
const native = loadNative(artifact)
assert.equal(native.protocolVersion(), 1)
assert.throws(() => loadNative(`${artifact}.missing.node`))
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as {
  version: number
  initialText: string
  updatedText: string
  afterCreate: string[]
  afterReparent: string[]
  boxChildren: string[]
  afterDelete: string[]
}
assert.equal(fixture.version, 1)
const s = new native.Session()
const root = s.stats().root
const aliases = new Map<string, NodeId>([['root', root]])
function names(ids: NodeId[]): string[] {
  return ids.map(id => {
    const entry = [...aliases].find(
      ([, candidate]) =>
        candidate.session === id.session &&
        candidate.slot === id.slot &&
        candidate.generation === id.generation,
    )
    assert.ok(entry, 'Snapshot must reference a real created ID')
    return entry[0]
  })
}
function submit(ops: readonly Op[]) {
  return s.applyBatch(s.stats().revision, ops)
}
function fails(action: () => unknown, code: string, opIndex?: number) {
  assert.throws(action, error => {
    assert.ok(error instanceof Error)
    const actual = error as Error & { code?: string; opIndex?: number }
    assert.equal(actual.code, code)
    assert.equal(actual.opIndex, opIndex)
    return true
  })
}
const created = submit([
  { op: 'create', temp: 8, parent: { id: root }, kind: 'box' },
  {
    op: 'create',
    temp: 2,
    parent: { id: root },
    kind: 'text',
    text: encodeText(fixture.initialText),
  },
]).created
assert.deepEqual(
  created.map(item => item.temp),
  [2, 8],
)
const text = created[0]!.id
const box = created[1]!.id
aliases.set('box', box)
aliases.set('text', text)
assert.deepEqual(names(s.inspect([root])[0]!.children), fixture.afterCreate)
const original = s.inspect([text])[0]!
submit([
  {
    op: 'updateText',
    node: { id: text },
    text: encodeText(fixture.updatedText),
  },
  { op: 'reparent', node: { id: text }, parent: { id: box } },
])
assert.equal(original.text, fixture.initialText)
assert.equal(s.inspect([text])[0]!.text, fixture.updatedText)
assert.deepEqual(names(s.inspect([root])[0]!.children), fixture.afterReparent)
assert.deepEqual(names(s.inspect([box])[0]!.children), fixture.boxChildren)
// Fail in native after create has allocated a slot, not during TS encoding.
const rollback = new native.Session()
const rollbackRoot = rollback.stats().root
const rollbackStats = rollback.stats()
const rollbackTree = rollback.inspect([rollbackRoot])
fails(
  () =>
    rollback.applyBatch(rollbackStats.revision, [
      { op: 'create', temp: 0, parent: { id: rollbackRoot }, kind: 'box' },
      { op: 'delete', node: { id: rollbackRoot } },
    ]),
  'Tree',
  1,
)
assert.deepEqual(rollback.stats(), rollbackStats)
assert.deepEqual(rollback.inspect([rollbackRoot]), rollbackTree)
const afterRollback = rollback.applyBatch(rollbackStats.revision, [
  { op: 'create', temp: 0, parent: { id: rollbackRoot }, kind: 'box' },
]).created[0]!.id
assert.equal(afterRollback.slot, rollbackStats.slots)
assert.equal(afterRollback.generation, rollbackRoot.generation)
rollback.close()

const before = s.stats()
const snapshot = s.inspect([root, box, text])
fails(
  () =>
    submit([
      { op: 'updateText', node: { id: text }, text: encodeText('discard') },
      { op: 'delete', node: { id: root } },
    ]),
  'Tree',
  1,
)
assert.deepEqual(s.stats(), before)
assert.deepEqual(s.inspect([root, box, text]), snapshot)
fails(
  () =>
    submit([
      { op: 'delete', node: { id: text } },
      {
        op: 'updateText',
        node: { id: text },
        text: encodeText('stale within batch'),
      },
    ]),
  'Id',
  1,
)
assert.deepEqual(s.stats(), before)
fails(
  () => submit([{ op: 'create', temp: 0, parent: { temp: 1 }, kind: 'box' }]),
  'Ref',
  0,
)
const other = new native.Session()
fails(() => s.inspect([other.stats().root]), 'Id')
other.close()
for (const bad of [NaN, Infinity, -Infinity, -1, 0.5, 2 ** 32]) {
  fails(() => s.applyBatch(bad, []), 'Input')
  fails(() => s.inspect([{ ...root, slot: bad }]), 'Input')
  fails(() => s.inspect([{ ...root, generation: bad }]), 'Input')
  fails(
    () =>
      submit([{ op: 'create', temp: bad, parent: { id: root }, kind: 'box' }]),
    'Input',
    0,
  )
}
for (const session of ['', '01', '+1', ' 1', '18446744073709551616']) {
  fails(() => s.inspect([{ ...root, session }]), 'Input')
}
fails(() => s.applyBatch(before.revision + 1, []), 'Revision')
fails(() => submit(new Array<Op>(257)), 'Limit')
for (const bytes of [[0xff], [0xc0, 0x80], [0xed, 0xa0, 0x80], [0xf0, 0x9f]]) {
  fails(
    () =>
      submit([
        { op: 'updateText', node: { id: text }, text: new Uint8Array(bytes) },
      ]),
    'Utf8',
    0,
  )
}
fails(
  () =>
    submit([
      { op: 'updateText', node: { id: text }, text: new Uint8Array(65537) },
    ]),
  'Limit',
  0,
)
fails(
  () =>
    submit(
      Array.from(
        { length: 5 },
        (): Op => ({
          op: 'updateText',
          node: { id: text },
          text: new Uint8Array(65536),
        }),
      ),
    ),
  'Limit',
  4,
)
fails(
  () =>
    submit([
      {
        op: 'updateText',
        node: { id: text },
        text: new Uint8Array(new SharedArrayBuffer(1)),
      },
    ]),
  'Input',
  0,
)
for (const input of ['\ud800', '\udc00', 'x\ud800y'])
  fails(() => encodeText(input), 'Input')
fails(() => encodeText('中'.repeat(65536)), 'Limit')
assert.equal(encodeText('x'.repeat(65536)).length, 65536)
let reads = 0
submit([
  {
    op: 'updateText',
    node: { id: text },
    get text() {
      reads++
      // Encoding is outside the native guard; getters are ordinary application JS.
      assert.equal(s.stats().closed, false)
      return encodeText(fixture.updatedText)
    },
  },
])
assert.equal(reads, 1)
// Malformed runtime values intentionally bypass the TS-only contract.
function rejectShape(value: unknown) {
  const stats = s.stats()
  const tree = s.inspect([root, box, text])
  fails(() => submit([value as Op]), 'Input', 0)
  assert.deepEqual(s.stats(), stats)
  assert.deepEqual(s.inspect([root, box, text]), tree)
  fails(
    () =>
      submit([
        {
          op: 'updateText',
          node: { id: text },
          text: encodeText('must roll back'),
        },
        value as Op,
      ]),
    'Input',
    1,
  )
  assert.deepEqual(s.stats(), stats)
  assert.deepEqual(s.inspect([root, box, text]), tree)
}
rejectShape({
  op: 'updateText',
  node: { id: text },
  text: new Uint8Array(new SharedArrayBuffer(1)),
})
// Additional application metadata is intentionally not serialized or enumerated.
const metadata = Object.defineProperty(
  {
    op: 'updateText',
    node: { id: text },
    text: encodeText('metadata ignored'),
  },
  'extra',
  {
    get() {
      throw new Error('must not enumerate metadata')
    },
  },
)
submit([metadata as Op])
assert.equal(s.inspect([text])[0]!.text, 'metadata ignored')

// Independent constant vector, not generated by the Rust decoder.
assert.deepEqual(
  [
    ...encodeBatch(0x12345678, [
      {
        op: 'create',
        temp: 9,
        parent: { temp: 7 },
        kind: 'text',
        text: encodeText('é'),
      },
    ]),
  ],
  [
    73, 82, 85, 73, 1, 1, 120, 86, 52, 18, 1, 0, 2, 9, 0, 0, 0, 1, 7, 0, 0, 0,
    2, 0, 0, 0, 195, 169,
  ],
)
const raw = new (loadNativePackets(artifact).Session)()
const rawRoot = raw.stats().root
const rawInspect = () => {
  const rootSnapshot = raw.inspect(encodeInspect([rawRoot]))[0]!
  return raw.inspect(encodeInspect([rawRoot, ...rootSnapshot.children]))
}
function badPacket(
  packet: unknown,
  code: string,
  index?: number,
  inspect = false,
) {
  const stats = raw.stats()
  const tree = rawInspect()
  fails(
    () =>
      inspect
        ? raw.inspect(packet as Uint8Array)
        : raw.applyBatch(packet as Uint8Array),
    code,
    index,
  )
  assert.deepEqual(raw.stats(), stats, 'revision and allocator unchanged')
  assert.deepEqual(rawInspect(), tree, 'scene unchanged')
}
const valid = encodeBatch(0, [
  {
    op: 'create',
    temp: 0,
    parent: { id: rawRoot },
    kind: 'text',
    text: encodeText('A'),
  },
])
for (let end = 0; end < valid.length; end++)
  badPacket(valid.slice(0, end), 'Input', end < 12 ? undefined : 0)
for (const [offset, value, code, index] of [
  [4, 2, 'Input', undefined],
  [5, 2, 'Input', undefined],
  [12, 255, 'Input', 0],
  [17, 255, 'Input', 0],
  [37, 255, 'Limit', 0],
  [38, 255, 'Utf8', 0],
] as const) {
  const bad = valid.slice()
  bad[offset] = value
  badPacket(bad, code, index)
}
const trailing = new Uint8Array(valid.length + 1)
trailing.set(valid)
badPacket(trailing, 'Input')
const lateUnknown = trailing.slice()
new DataView(lateUnknown.buffer).setUint16(10, 2, true)
lateUnknown[lateUnknown.length - 1] = 255
badPacket(lateUnknown, 'Input', 1)
const staleMalformed = valid.slice()
new DataView(staleMalformed.buffer).setUint32(6, 1, true)
staleMalformed[12] = 255
badPacket(staleMalformed, 'Input', 0) // full decoding precedes revision
const forged = valid.slice()
new DataView(forged.buffer).setUint32(34, 2, true)
badPacket(forged, 'Input', 0)
badPacket(new Uint8Array(MAX_BATCH_BYTES + 1), 'Limit')
const oversizedCount = encodeBatch(0, []).slice()
new DataView(oversizedCount.buffer).setUint16(10, 257, true)
badPacket(oversizedCount, 'Limit')
const singleTooLong = valid.slice()
new DataView(singleTooLong.buffer).setUint32(34, 65537, true)
badPacket(singleTooLong, 'Limit', 0)
// Bypass the TS encoder to exceed the cumulative limit while staying below
// the packet hard cap: four 64KiB texts followed by one byte.
const cumulative = new Uint8Array(12 + 5 * 26 + 262145)
cumulative.set([73, 82, 85, 73, 1, 1, 0, 0, 0, 0, 5, 0])
let cursor = 12
for (let i = 0; i < 5; i++) {
  const length = i < 4 ? 65536 : 1
  cumulative.set(valid.subarray(12, 38), cursor)
  new DataView(cumulative.buffer).setUint32(cursor + 22, length, true)
  cursor += 26 + length
}
badPacket(cumulative, 'Limit', 4)
// Exact hard cap is admitted to decoding (bad magic => Input, not Limit).
badPacket(new Uint8Array(MAX_BATCH_BYTES), 'Input')
const wideId = encodeInspect([
  {
    session: '18446744073709551615',
    slot: 0x12345678,
    generation: 0x90abcdef,
  },
])
assert.deepEqual(
  [...wideId],
  [
    73, 82, 85, 73, 1, 2, 0, 0, 0, 0, 1, 0, 255, 255, 255, 255, 255, 255, 255,
    255, 120, 86, 52, 18, 239, 205, 171, 144,
  ],
)
badPacket(new Uint8Array(MAX_INSPECT_BYTES + 1), 'Limit', undefined, true)
for (const value of [
  {},
  [],
  new Proxy(valid, {}),
  new Uint16Array(4),
  new Uint8Array(new SharedArrayBuffer(12)),
])
  badPacket(value, 'Input')
badPacket(new Uint8Array(), 'Input')
const inspectPacket = encodeInspect([rawRoot])
for (let end = 0; end < inspectPacket.length; end++)
  badPacket(inspectPacket.slice(0, end), 'Input', undefined, true)
const inspectTrailing = new Uint8Array(inspectPacket.length + 1)
inspectTrailing.set(inspectPacket)
badPacket(inspectTrailing, 'Input', undefined, true)
assert.equal(
  raw.inspect(encodeInspect(Array.from({ length: 4096 }, () => rawRoot)))
    .length,
  4096,
)
const padded = new Uint8Array(valid.length + 2)
padded.set(valid, 1)
const packetView = padded.subarray(1, valid.length + 1)
Object.defineProperty(packetView, 'buffer', {
  get() {
    throw new Error('native must not read buffer getter')
  },
})
raw.applyBatch(packetView)
const rawText = rawInspect()[0]!.children[0]!
// Exactly 256 ops, exactly 64KiB per text and 256KiB cumulative text.
raw.applyBatch(
  encodeBatch(
    1,
    Array.from(
      { length: 256 },
      (_, i): Op => ({
        op: 'updateText',
        node: { id: rawText },
        text: new Uint8Array(i < 4 ? 65536 : 0),
      }),
    ),
  ),
)
assert.equal(raw.stats().revision, 2)
if (typeof structuredClone === 'function') {
  const detached = valid.slice()
  structuredClone(detached.buffer, { transfer: [detached.buffer] })
  badPacket(detached, 'Input')
}
if ('resize' in ArrayBuffer.prototype) {
  const Constructor = ArrayBuffer as unknown as new (
    n: number,
    options: { maxByteLength: number },
  ) => ArrayBuffer & { resize(n: number): void }
  const buffer = new Constructor(14, { maxByteLength: 32 })
  const view = new Uint8Array(buffer, 1)
  view.set(encodeBatch(2, []))
  buffer.resize(13)
  raw.applyBatch(view)
  buffer.resize(1)
  badPacket(view, 'Input')
}
raw.close()
const getterThrown = { marker: 'original thrown object' }
const getterStats = s.stats()
const getterTree = s.inspect([root, box, text])
assert.throws(
  () =>
    submit([
      {
        op: 'updateText',
        node: { id: text },
        get text(): Uint8Array {
          throw getterThrown
        },
      },
    ]),
  error => error === getterThrown,
)
assert.deepEqual(s.stats(), getterStats)
assert.deepEqual(s.inspect([root, box, text]), getterTree)
// Required own fields may be nonenumerable; null prototypes are accepted.
const nullOp = Object.assign(Object.create(null), {
  op: 'updateText',
  node: Object.assign(Object.create(null), { id: root }),
})
nullOp.node.id = Object.assign(Object.create(null), text)
Object.defineProperty(nullOp, 'text', {
  value: encodeText('own nonenumerable'),
})
submit([nullOp])
assert.equal(s.inspect([text])[0]!.text, 'own nonenumerable')
const backing = new Uint8Array([255, 65, 66, 255])
const offset = backing.subarray(1, 3)
Object.defineProperty(offset, 'buffer', {
  get() {
    throw new Error('do not read JS buffer')
  },
})
submit([{ op: 'updateText', node: { id: text }, text: offset }])
assert.equal(s.inspect([text])[0]!.text, 'AB')
submit([{ op: 'updateText', node: { id: text }, text: new Uint8Array(0) }])
assert.equal(s.inspect([text])[0]!.text, '')
rejectShape({
  op: 'updateText',
  node: { id: text },
  text: new Proxy(new Uint8Array(), {}),
})
if (typeof structuredClone === 'function') {
  const detached = new Uint8Array([65])
  structuredClone(detached.buffer, { transfer: [detached.buffer] })
  rejectShape({ op: 'updateText', node: { id: text }, text: detached })
  console.log('covered: detached ArrayBuffer rejection')
} else {
  console.log('not-covered: detached ArrayBuffer (structuredClone unavailable)')
}
// Feature detection is explicit; exceptions from supported capabilities fail smoke.
if ('resize' in ArrayBuffer.prototype) {
  const ResizableBuffer = ArrayBuffer as unknown as new (
    size: number,
    options: { maxByteLength: number },
  ) => ArrayBuffer & { resize(size: number): void }
  const buffer = new ResizableBuffer(4, { maxByteLength: 8 })
  const view = new Uint8Array(buffer, 1)
  view.set([65, 66, 67])
  buffer.resize(3)
  submit([{ op: 'updateText', node: { id: text }, text: view }])
  assert.equal(s.inspect([text])[0]!.text, 'AB')
  buffer.resize(1)
  submit([{ op: 'updateText', node: { id: text }, text: view }])
  assert.equal(s.inspect([text])[0]!.text, '')
  console.log('covered: resizable ArrayBuffer shrink and empty view')
} else {
  console.log('not-covered: resizable ArrayBuffer (resize unavailable)')
}
// Application Proxy traps are outside the native wire budget, not a native protocol feature.
const guarded = new Array<Op>(257)
Object.defineProperty(guarded, '0', {
  get() {
    throw new Error('must not read oversized batch')
  },
})
fails(() => submit(guarded), 'Limit')
submit([
  { op: 'delete', node: { id: text } },
  { op: 'delete', node: { id: box } },
])
assert.deepEqual(names(s.inspect([root])[0]!.children), fixture.afterDelete)
fails(() => s.inspect([text]), 'Id')
const reused = submit([
  { op: 'create', temp: 0, parent: { id: root }, kind: 'box' },
]).created[0]!.id
assert.equal(reused.slot, text.slot)
assert.equal(reused.generation, text.generation + 1)
fails(() => s.inspect([box]), 'Id')
const tempBatch = submit([
  { op: 'create', temp: 0, parent: { id: root }, kind: 'box' },
  {
    op: 'create',
    temp: 1,
    parent: { temp: 0 },
    kind: 'text',
    text: encodeText('temp'),
  },
])
assert.equal(tempBatch.created.length, 2)
s.close()
s.close()
assert.equal(s.stats().closed, true)
assert.equal(s.stats().liveNodes, 0)
fails(() => s.applyBatch(s.stats().revision, []), 'Closed')
fails(() => s.inspect([]), 'Closed')
console.log('ink-rust native protocol 1 smoke passed', {
  artifact,
  fixturePath,
  runtime: process.versions,
})
