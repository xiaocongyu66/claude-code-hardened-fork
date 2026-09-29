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
  // 段头 4KB 的 chunk 引用会重名（几百个段引用同一 chunk）——序号前缀保证唯一，
  // 否则同名段 rmSync+重写互相覆盖，大段产物被后跑的小段抹掉（fleet 185K→64K 的根因）
  let seq = 0
  for (const seg of work) {
    const uniq = `${String(seq++).padStart(4, '0')}-${seg.name}`
    const body = data.slice(data.indexOf('\n', seg.start) + 1, seg.end)
    const tmpFile = path.join('/tmp', `decomp-${uniq}.js`)
    const outDir = path.join(OUT, uniq)
    try {
      // 守恒兜底：切段与声明大小差 >20%（_ALL.js 段边界解析歧义）时，
      // 不反编译——原样落盘原始段文本，保证零丢失
      if (Math.abs(body.length - seg.size) > seg.size * 0.2) {
        fs.mkdirSync(outDir, { recursive: true })
        fs.writeFileSync(path.join(outDir, 'raw-passthrough.js'), body)
        index.push(`| ${uniq} | ${seg.size} | - | passthrough (${body.length}B) |`)
        done++
        continue
      }
      fs.writeFileSync(tmpFile, body)
      const r = decompileFile(tmpFile, { useRust: false })
      const mods = (r.modules || []).length
      let outSum = 0
      for (const mod of r.modules) outSum += mod.content.length
      if (fs.existsSync(outDir)) fs.rmSync(outDir, { recursive: true })
      writeOutput(r, outDir, 'modules')
      // 切分输出 <80% 源时附加原始段（ruDevolution 对超大语句丢内容）
      if (outSum < body.length * 0.8) {
        fs.writeFileSync(path.join(outDir, 'raw-passthrough.js'), body)
      }
      index.push(`| ${uniq} | ${seg.size} | ${mods} | ok |`)
      done++
      if (done % 50 === 0) console.log(`progress: ${done}/${work.length}`)
    } catch (e) {
      index.push(`| ${uniq} | ${seg.size} | - | FAIL: ${String(e.message).slice(0, 80)} |`)
    } finally {
      try { fs.unlinkSync(tmpFile) } catch {}
    }
  }
  fs.writeFileSync(path.join(OUT, '_index.md'), index.join('\n') + '\n')
  console.log(`done: ${done}/${work.length} → ${OUT}`)
}

main()
