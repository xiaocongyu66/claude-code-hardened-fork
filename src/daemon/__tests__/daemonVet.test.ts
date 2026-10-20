import { describe, expect, test } from 'bun:test'
import {
  isFullMap,
  parseOverflowUid,
  parseUidMap,
  unmappedUid,
  vetAncestorOwnership,
  vetBindUid,
  UID_COLLAPSES_MESSAGE,
  ENOTOWNED,
} from '../daemonVet.js'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

describe('daemonVet（ID 隔离四道闸）', () => {
  describe('parseUidMap（官方 D）', () => {
    test('parses legal 3-col entries', () => {
      const m = parseUidMap('10405 10405 1\n0 65534 1\n')
      expect(m).toEqual([
        { innerStart: 10405, hostStart: 10405, count: 1 },
        { innerStart: 0, hostStart: 65534, count: 1 },
      ])
    })
    test('dirty line → undefined（不给半份信息）', () => {
      expect(parseUidMap('10405 10405\n')).toBeUndefined()
      expect(parseUidMap('x y z\n')).toBeUndefined()
      expect(parseUidMap('10405 10405 0\n')).toBeUndefined()
    })
    test('blank lines skipped', () => {
      expect(parseUidMap('\n\n10405 10405 1\n\n')).toEqual([
        { innerStart: 10405, hostStart: 10405, count: 1 },
      ])
    })
  })

  describe('parseOverflowUid（官方 F）', () => {
    test('legal digits', () => {
      expect(parseOverflowUid('65534\n')).toBe(65534)
    })
    test('dirty → undefined', () => {
      expect(parseOverflowUid('abc')).toBeUndefined()
      expect(parseOverflowUid('-1')).toBeUndefined()
    })
  })

  describe('isFullMap（官方 h）', () => {
    test('single full map = 未进任何 userns', () => {
      expect(
        isFullMap([{ innerStart: 0, hostStart: 0, count: 4294967295 }]),
      ).toBe(true)
      expect(isFullMap([{ innerStart: 0, hostStart: 0, count: 1 }])).toBe(false)
    })
  })

  describe('unmappedUid（官方 A）', () => {
    const map = [{ innerStart: 10405, hostStart: 10405, count: 1 }]
    test('in-range → undefined', () => {
      expect(unmappedUid(map, 10405)).toBeUndefined()
    })
    test('out-of-range → 原 uid（unmapped）', () => {
      expect(unmappedUid(map, 0)).toBe(0)
      expect(unmappedUid(map, 65534)).toBe(65534)
    })
  })

  describe('vetBindUid（官方 bTo）', () => {
    test('returns a well-formed result in current env', () => {
      const r = vetBindUid()
      expect(typeof r.uidCollapses).toBe('boolean')
      expect(typeof r.rootUidAmbiguous).toBe('boolean')
    })
  })

  describe('vetAncestorOwnership（官方 T）', () => {
    test('tempdir (uid-owned) passes', () => {
      const dir = mkdtempSync(join(tmpdir(), 'cch-vet-test-'))
      try {
        // 环境无关化：vetAncestorOwnership 首行 assertUidVetted()——user
        // namespace 无 uid mapping 的环境（uidCollapses，如部分容器/proot）
        // 按设计硬拒（ENOTOWNED throw），「属主校验通过」前提不成立，此时
        // 断言硬拒契约本身。
        if (vetBindUid().uidCollapses) {
          expect(() => vetAncestorOwnership(dir)).toThrow(/uid mapping/)
          return
        }
        const r = vetAncestorOwnership(dir)
        expect(r.ok).toBe(true)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })
    test('/tmp/cc-daemon-0/<hash> 祖先链 stat 正常（root 起的 env 属主匹配或 /tmp 例外可查）', () => {
      // uidCollapses 环境下 assertUidVetted 按设计 throw（ENOTOWNED）——
      // 断言这个硬拒契约而不是让它作为未处理异常炸掉测试。
      if (vetBindUid().uidCollapses) {
        expect(() => vetAncestorOwnership('/tmp/cc-daemon-0/x')).toThrow(
          /uid mapping/,
        )
        return
      }
      const r = vetAncestorOwnership('/tmp/cc-daemon-0/x')
      // root env：/tmp 属主 root（uid 0），/root 同——通过；
      // 若结果 not-ok，至少错误码必须是 ENOTOWNED
      if (!r.ok) expect(r.code).toBe(ENOTOWNED)
    })
    test('UID_COLLAPSES_MESSAGE 为官方原文', () => {
      expect(UID_COLLAPSES_MESSAGE).toContain('unshare -Ur')
      expect(UID_COLLAPSES_MESSAGE).toContain('uid mapping')
    })
  })
})
