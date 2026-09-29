#!/usr/bin/env node
/**
 * decompile-official.js — 用 ruDevolution 全量反编译官方 binary 的 JS 源区
 *
 * 输入：_ALL.js（2138 段，按段头注释切分）
 * 输出：docs/reverse/decompiled/<name>/  每 chunk 一个目录（MinCut 模块 + manifest）
 *       docs/reverse/decompiled/_index.md  汇总索引
 *
 * 大 chunk 优先（业务代码集中）；单进程循环避免重复启动开销。
 */
'use strict'
const fs = require('fs')
const path = require('path')
const { decompileFile, writeOutput } = require('/tmp/rudevolution/npm/src/decompiler')

const ALL = process.env.CC_ALL || '/root/xiaocongyu66-claude-code/docs/reverse/full-source/_ALL.js'
const OUT = process.env.CC_DECOMP || '/root/xiaocongyu66-claude-code/docs/reverse/decompiled'
const MIN_BYTES = Number(process.env.MIN_CHUNK_BYTES || 8_000)

function main() {
  fs.mkdirSync(OUT, { recursive: true })
  const data = fs.readFileSync(ALL, 'utf-8')
  // 段边界：// ── <name> @ <offset> (N bytes) ──
  const headRe = /^\/\/ ── (chunk-[0-9a-z]{8}|seg\d+) @ ([\d,]+) \(([\d,]+) bytes\) ──$/gm
  const segs = []
  let m
  while ((m = headRe.exec(data)) !== null) {
    segs.push({ name: m[1], offset: Number(m[2].replace(/,/g, '')), size: Number(m[3].replace(/,/g, '')), start: m.index })
  }
  for (let i = 0; i < segs.length; i++) {
    segs[i].end = i + 1 < segs.length ? segs[i + 1].start : data.length
  }
  // 大 chunk 优先，过滤 runtime ELF 段（seg000）
  const work = segs
    .filter(s => s.name !== 'seg000' && s.size >= MIN_BYTES)
    .sort((a, b) => b.size - a.size)
  console.log(`segments: ${segs.length} total, ${work.length} to decompile (>=${MIN_BYTES}B)`)
  fs.writeFileSync(path.join(OUT, '_worklist.json'), JSON.stringify(work.map(s => s.name)))

  const index = ['# 官方 binary 反编译索引（ruDevolution）', '', '| chunk | 大小 | 模块数 | 状态 |', '|---|---|---|---|']
  let done = 0
  for (const seg of work) {
    const body = data.slice(data.indexOf('\n', seg.start) + 1, seg.end)
    const tmpFile = path.join('/tmp', `decomp-${seg.name}.js`)
    const outDir = path.join(OUT, seg.name)
    try {
      fs.writeFileSync(tmpFile, body)
      const r = decompileFile(tmpFile, {})
      const mods = (r.modules || []).length
      if (fs.existsSync(outDir)) fs.rmSync(outDir, { recursive: true })
      writeOutput(r, outDir, 'modules')
      index.push(`| ${seg.name} | ${seg.size} | ${mods} | ok |`)
      done++
      if (done % 50 === 0) console.log(`progress: ${done}/${work.length}`)
    } catch (e) {
      index.push(`| ${seg.name} | ${seg.size} | - | FAIL: ${String(e.message).slice(0, 80)} |`)
    } finally {
      try { fs.unlinkSync(tmpFile) } catch {}
    }
  }
  fs.writeFileSync(path.join(OUT, '_index.md'), index.join('\n') + '\n')
  console.log(`done: ${done}/${work.length} → ${OUT}`)
}

main()
