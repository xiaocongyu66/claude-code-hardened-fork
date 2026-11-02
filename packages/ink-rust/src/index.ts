import { createRequire } from 'node:module'
import { isAbsolute } from 'node:path'

/**
 * Typed application objects are a local convenience, NOT a sandbox. Only
 * declared fields are read once; extra metadata never enters the wire. Getters
 * and Proxies may execute arbitrary JS, throw unchanged, or mutate the session;
 * their cost and side effects are not bounded or rolled back. Encoding finishes
 * before native is called. Native accepts only bounded Uint8Array packets and
 * rejects malformed wire atomically; it never reflects on application objects.
 */
export type NodeId = Readonly<{
  session: string
  slot: number
  generation: number
}>
export type NodeRef = { id: NodeId } | { temp: number }
export type Op =
  | { op: 'create'; temp: number; parent: NodeRef; kind: 'box' }
  | { op: 'create'; temp: number; parent: NodeRef; kind: 'text'; text: Uint8Array }
  | { op: 'updateText'; node: NodeRef; text: Uint8Array }
  | { op: 'reparent'; node: NodeRef; parent: NodeRef }
  | { op: 'delete'; node: NodeRef }
export interface Stats {
  root: NodeId
  revision: number
  closed: boolean
  slots: number
  freeSlots: number
  retiredSlots: number
  liveNodes: number
  liveTextBytes: number
  lastBatchVisits: number
}
export interface Applied {
  revision: number
  created: { temp: number; id: NodeId }[]
  visits: number
}
export interface Snapshot {
  id: NodeId
  parent?: NodeId | null
  children: NodeId[]
  kind: 'box' | 'text'
  text?: string | null
}
export interface Session {
  stats(): Stats
  applyBatch(expectedRevision: number, ops: readonly Op[]): Applied
  inspect(ids: readonly NodeId[]): Snapshot[]
  close(): void
}
/**
 * Wire v1 (little-endian): IRUI[4], version:u8=1, kind:u8 (1 batch,
 * 2 inspect), revision:u32 (inspect requires 0), count:u16. No trailing bytes.
 * ID = session:u64 + slot:u32 + generation:u32. Ref = 0+ID or 1+temp:u32.
 * Ops: 1 createBox(temp,ref), 2 createText(temp,ref,text), 3 update(ref,text),
 * 4 reparent(ref,ref), 5 delete(ref). Text = length:u32 + strict UTF-8 bytes.
 * Limits: 256 ops, 65536 bytes/text, 262144 text bytes/batch; batch packet
 * <=12+256*35+262144=271116 bytes; inspect <=4096 IDs / 65548 bytes.
 * Native error priority: Reentrant, Closed, Input brand/backing, Limit size,
 * wire validation in byte order, Revision, checked Id, core transaction.
 * Wire/header/trailing errors use Input; UTF-8 uses Utf8; budgets use Limit.
 * Only per-op wire/ID/core errors carry zero-based opIndex. Inspect never does.
 * TS validation precedes native invocation and can therefore win over Closed.
 */
export interface NativeSession {
  stats(): Stats
  applyBatch(packet: Uint8Array): Applied
  inspect(packet: Uint8Array): Snapshot[]
  close(): void
}
export interface NativeBinding {
  protocolVersion(): number
  Session: new () => NativeSession
}
export interface Binding {
  protocolVersion(): number
  Session: new () => Session
}

/** Explicit artifact path, also valid when this module is bundled for Node. */
export function loadNativePackets(artifact: string): NativeBinding {
  if (!isAbsolute(artifact) || !artifact.endsWith('.node')) {
    throw new Error('Expected an absolute .node artifact path')
  }
  const binding: unknown = createRequire(import.meta.url)(artifact)
  if (
    typeof binding !== 'object' ||
    binding === null ||
    !('protocolVersion' in binding) ||
    typeof binding.protocolVersion !== 'function' ||
    binding.protocolVersion() !== 1 ||
    !('Session' in binding) ||
    typeof binding.Session !== 'function'
  ) {
    throw new Error('Ink Rust native protocol mismatch (expected 1)')
  }
  return binding as NativeBinding
}

export function loadNative(artifact: string): Binding {
  const binding = loadNativePackets(artifact)
  return {
    protocolVersion: () => binding.protocolVersion(),
    Session: class implements Session {
      private readonly native = new binding.Session()
      stats() { return this.native.stats() }
      close() { this.native.close() }
      applyBatch(revision: number, ops: readonly Op[]) {
        return this.native.applyBatch(encodeBatch(revision, ops))
      }
      inspect(ids: readonly NodeId[]) {
        return this.native.inspect(encodeInspect(ids))
      }
    },
  }
}

// Fixed-size allocation, independent of application object graph size.
export const MAX_BATCH_BYTES = 12 + 256 * 35 + 256 * 1024
export const MAX_INSPECT_BYTES = 12 + 4096 * 16
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype)
const bufferGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'buffer')!.get!
const lengthGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength')!.get!
const offsetGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteOffset')!.get!
const tagGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, Symbol.toStringTag)!.get!
const arrayBufferLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength')!.get!

class PacketWriter {
  readonly bytes: Uint8Array
  readonly view: DataView
  offset = 0
  total = 0
  index: number | undefined
  constructor(size: number) {
    this.bytes = new Uint8Array(size)
    this.view = new DataView(this.bytes.buffer)
  }
  fail(code: 'Input' | 'Limit'): never {
    const error = inputError(code)
    if (this.index !== undefined) Object.assign(error, { opIndex: this.index })
    throw error
  }
  number(value: number, max = 0xffffffff): number {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > max) this.fail('Input')
    return value
  }
  u8(value: number) { this.view.setUint8(this.offset++, value) }
  u32(value: number) {
    this.view.setUint32(this.offset, this.number(value), true)
    this.offset += 4
  }
  header(kind: number, revision: number, count: number) {
    for (const b of [73, 82, 85, 73, 1, kind]) this.u8(b)
    this.u32(revision)
    this.view.setUint16(this.offset, count, true)
    this.offset += 2
  }
  id(id: NodeId) {
    if (typeof id !== 'object' || id === null) this.fail('Input')
    const { session, slot, generation } = id
    if (typeof session !== 'string' || session.length > 20 || !/^(0|[1-9][0-9]*)$/.test(session)) this.fail('Input')
    const owner = BigInt(session)
    if (owner > 0xffffffffffffffffn) this.fail('Input')
    this.view.setBigUint64(this.offset, owner, true)
    this.offset += 8
    this.u32(slot)
    this.u32(generation)
  }
  reference(ref: NodeRef) {
    if (typeof ref !== 'object' || ref === null) this.fail('Input')
    // Discrimination is explicit: a defined id selects the ID alternative.
    const id = (ref as { id?: NodeId }).id
    if (id !== undefined) { this.u8(0); this.id(id) }
    else { const temp = (ref as { temp: number }).temp; this.u8(1); this.u32(temp) }
  }
  text(text: Uint8Array) {
    let source: Uint8Array
    try {
      if (tagGetter.call(text) !== 'Uint8Array') this.fail('Input')
      const buffer = bufferGetter.call(text) as ArrayBuffer
      arrayBufferLength.call(buffer) // rejects SAB, without reading own .buffer
      const length = lengthGetter.call(text) as number
      const offset = offsetGetter.call(text) as number
      if (length > 65536 || length > 262144 - this.total) this.fail('Limit')
      source = new Uint8Array(buffer, offset, length) // rejects detached buffers
    } catch (error) {
      if (error instanceof Error && 'code' in error) throw error
      this.fail('Input')
    }
    this.total += source.byteLength
    this.u32(source.byteLength)
    this.bytes.set(source, this.offset)
    this.offset += source.byteLength
  }
  finish() { return this.bytes.subarray(0, this.offset) }
}

export function encodeBatch(revision: number, ops: readonly Op[]): Uint8Array {
  if (!Array.isArray(ops)) throw inputError('Input')
  const count = ops.length
  if (count > 256) throw inputError('Limit')
  const w = new PacketWriter(MAX_BATCH_BYTES)
  w.header(1, revision, w.number(count, 256))
  for (let i = 0; i < count; i++) {
    w.index = i
    const item = ops[i]!
    if (typeof item !== 'object' || item === null) w.fail('Input')
    const op = item.op
    switch (op) {
      case 'create': {
        const { temp, parent, kind } = item
        if (kind !== 'box' && kind !== 'text') w.fail('Input')
        w.u8(kind === 'box' ? 1 : 2)
        w.u32(temp)
        w.reference(parent)
        if (kind === 'text') { const text = item.text; w.text(text) }
        break
      }
      case 'updateText': {
        const { node, text } = item
        w.u8(3); w.reference(node); w.text(text)
        break
      }
      case 'reparent': {
        const { node, parent } = item
        w.u8(4); w.reference(node); w.reference(parent)
        break
      }
      case 'delete': { const node = item.node; w.u8(5); w.reference(node); break }
      default: w.fail('Input')
    }
  }
  return w.finish()
}

export function encodeInspect(ids: readonly NodeId[]): Uint8Array {
  if (!Array.isArray(ids)) throw inputError('Input')
  const count = ids.length
  if (count > 4096) throw inputError('Limit')
  const w = new PacketWriter(MAX_INSPECT_BYTES)
  w.header(2, 0, w.number(count, 4096))
  for (let i = 0; i < count; i++) w.id(ids[i]!)
  return w.finish()
}

function inputError(code: 'Input' | 'Limit'): Error {
  return Object.assign(new Error(code), { code })
}

export function encodeText(text: string): Uint8Array {
  if (typeof text !== 'string') throw inputError('Input')
  // UTF-8 cannot be shorter than UTF-16 code-unit count.
  if (text.length > 64 * 1024) throw inputError('Limit')
  let bytes = 0
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = text.charCodeAt(++i)
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw inputError('Input')
      bytes += 4
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      throw inputError('Input')
    } else {
      bytes += c < 0x80 ? 1 : c < 0x800 ? 2 : 3
    }
    if (bytes > 64 * 1024) throw inputError('Limit')
  }
  return new TextEncoder().encode(text)
}
