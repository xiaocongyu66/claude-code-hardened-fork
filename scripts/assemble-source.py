#!/usr/bin/env python3
"""
assemble-source.py — 把 binary 全部 chunk 组合成完整可读代码树

binary 结构（已由 dump-binary-strings.py 证实）：
  每 chunk = [版权头 + JS 源区(minified) + \\x00 + bytecode 缓存]
  JS 源区占 97.5%（234MB/240MB）——bytecode 只是预编译缓存，跟着源走

产出 docs/reverse/full-source/：
  <name>.js      每 chunk 的 JS 源（头注释：偏移/依赖/导出）
  _ALL.js        全量拼接（偏移序 ≈ Bun 拓扑序），分节注释
  _deps.md       依赖图（每 chunk 的 import chunk + export 符号）
  _stats.md      组合统计（可恢复率）
"""
import os
import re
import sys

BIN = '/root/.local/share/claude/versions/2.1.283'
OUT = '/root/xiaocongyu66-claude-code/docs/reverse'
FS = f'{OUT}/full-source'

CHUNK_MARK = b'// (c) Anthropic PBC. All rights reserved.'
BUNFS = re.compile(rb'chunk-([0-9a-z]{8})\.js')
IMPORTS = re.compile(rb'import(?:\{([^}]*)\}|([A-Za-z_$][\w$]*))\s*from\s*"([^"]*chunk-[0-9a-z]{8}\.js)"')
EXPORTS = re.compile(rb'export\{([^}]{1,6000})\}')


def printable_ratio(b: bytes) -> float:
    if not b:
        return 0.0
    ok = sum(1 for c in b if 0x20 <= c < 0x7f or c in (0x0a, 0x09))
    return ok / len(b)


def js_source(seg: bytes):
    """切出 JS 源区（\x00// @bun @bytecode 之前）。
    ELF 段（bun runtime 本体）不是 JS 源——返回空。"""
    if seg.startswith(b'\x7fELF'):
        return b'', 0.0
    ratio = printable_ratio(seg[:5_000])
    nul = seg.find(b'\x00// @bun @bytecode')
    if nul < 0:
        nul = seg.find(b'\x00')
    if nul < 0 or ratio < 0.5:
        return b'', ratio
    return seg[:nul], ratio


def main():
    os.makedirs(FS, exist_ok=True)
    data = open(BIN, 'rb').read()
    total = len(data)
    bounds = [m.start() for m in re.finditer(re.escape(CHUNK_MARK), data)]
    segs = []
    if bounds and bounds[0] > 0:
        segs.append((0, bounds[0]))
    for i, b in enumerate(bounds):
        end = bounds[i + 1] if i + 1 < len(bounds) else total
        segs.append((b, end))

    deps_lines = ['# chunk 依赖图', '', '| chunk | 偏移 | 依赖 chunk | export 符号数 | 恢复状态 |', '|---|---|---|---|---|']
    stats = ['# 组合统计', '']
    all_parts = []
    restored_bytes = 0
    names = []
    for i, (start, end) in enumerate(segs):
        seg = data[start:end]
        size = end - start
        found = BUNFS.findall(seg[:4096])
        name = f'seg{i:03d}' if not found else f'chunk-{found[0].decode()}'
        src, ratio = js_source(seg)
        # 依赖
        dep_chunks = []
        seen = set()
        for m in IMPORTS.finditer(src[:400_000]):
            dep = BUNFS.search(m.group(3))
            if dep and dep.group(1).decode() not in seen:
                seen.add(dep.group(1).decode())
                dep_chunks.append(dep.group(1).decode())
        n_exports = len(EXPORTS.findall(src[:80_000]))
        restored = len(src) / size if size else 0
        restored_bytes += len(src)
        names.append(name)
        # 头注释
        header = (
            f'// ── {name} @ {start:,} ({size:,} bytes) ──\n'
            f'// 恢复率 {restored:.0%}（bytecode 缓存区 {size - len(src):,} bytes 不可反编译）\n'
            f'// 依赖: {", ".join(dep_chunks) if dep_chunks else "(无)"}\n'
        )
        if src:
            with open(f'{FS}/{name}.js', 'w', encoding='utf-8') as f:
                f.write(header)
                f.write(src.decode('utf-8', errors='replace'))
            all_parts.append(f'{header}\n{src.decode("utf-8", errors="replace")}')
        else:
            with open(f'{FS}/{name}.js', 'w', encoding='utf-8') as f:
                f.write(f'{header}// [纯 bytecode chunk——JS 源缺失，字符串池见 chunks/{name}.txt]\n')
            all_parts.append(f'{header}// [纯 bytecode chunk]\n')
        deps_lines.append(f'| {name} | {start:,} | {", ".join(dep_chunks[:6]) or "—"} | {n_exports} | {restored:.0%} |')

    with open(f'{FS}/_ALL.js', 'w', encoding='utf-8') as f:
        f.write('// Claude Code 2.1.283 — 全量组合源（偏移序，≈Bun chunk 拓扑序）\n')
        f.write(f'// 共 {len(segs)} chunk · JS 源 {restored_bytes:,} bytes / binary {total:,} bytes\n\n')
        f.write('\n\n// ══════════════════════════════════════════════════════════\n\n'.join(all_parts))
    open(f'{FS}/_deps.md', 'w', encoding='utf-8').write('\n'.join(deps_lines) + '\n')

    pure_bc = sum(1 for i, (s, e) in enumerate(segs) if printable_ratio(data[s:s + e][:200_000]) < 0.5)
    stats += [
        f'- binary: {total:,} bytes · {len(segs)} chunks',
        f'- JS 源区恢复: {restored_bytes:,} bytes（{restored_bytes / total:.1%}）',
        f'- 纯 bytecode chunk（无 JS 源，仅字符串池）: {pure_bc} 个',
        f'- 输出: {len(segs)} 个 .js + _ALL.js + _deps.md',
    ]
    open(f'{FS}/_stats.md', 'w', encoding='utf-8').write('\n'.join(stats) + '\n')
    print('\n'.join(stats))


if __name__ == '__main__':
    sys.exit(main())
