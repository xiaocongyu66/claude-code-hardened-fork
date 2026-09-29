#!/usr/bin/env python3
"""
dump-binary-strings.py — Claude Code binary 全量导出器

按 chunk 边界（// (c) Anthropic PBC 头）切分 binary：
  1. 可读 JS 源区（minified，import..export）→ 原样导出
  2. Bun bytecode 区 → 提取字符串池（明文字符串，\x00 分隔格式）
     bytecode 指令本身无公开规范、不可反编译——字符串池是 chunk 里
     唯一可靠可读的信息层（事件名/错误消息/常量串全在此）

输出 docs/reverse/：
  index.md              chunk 索引（偏移/大小/类型/导出符号）
  chunks/<name>.txt     每 chunk：[JS SOURCE] 节 + [STRING POOL] 节
"""
import os
import re
import sys

BIN = os.environ.get('CC_BIN', '/root/.local/share/claude/versions/2.1.283')
OUT = os.environ.get('CC_OUT', '/root/xiaocongyu66-claude-code/docs/reverse')

CHUNK_MARK = b'// (c) Anthropic PBC. All rights reserved.'
BUNFS = re.compile(rb'chunk-([0-9a-z]{8})\.js')
# 可打印提取：ASCII 可见 + 常用 Unicode（中日文/符号/emoji 区段），长度 >=4
PRINTABLE = re.compile(rb'([\x20-\x7e][\x20-\x7e]{3,}|[\xe0-\xef][\x80-\xbf]{2}(?:[\xe0-\xef][\x80-\xbf]{2}){3,})')


def printable_ratio(b: bytes) -> float:
    if not b:
        return 0.0
    ok = sum(1 for c in b if 0x20 <= c < 0x7f or c in (0x0a, 0x09))
    return ok / len(b)


def extract_strings(blob: bytes, min_len: int = 4):
    """bytecode 字符串池提取：连续可打印序列（ASCII >=4 或 UTF-8 多字节 >=4 字符）"""
    out = []
    for m in PRINTABLE.finditer(blob):
        raw = m.group(1)
        try:
            text = raw.decode('utf-8')
        except UnicodeDecodeError:
            continue
        text = text.strip('\x00').strip()
        if len(text) >= min_len:
            out.append(text)
    return out


def main():
    os.makedirs(f'{OUT}/chunks', exist_ok=True)
    data = open(BIN, 'rb').read()
    total = len(data)
    print(f'binary: {total:,} bytes')

    # chunk 边界 = Anthropic 版权头
    bounds = [m.start() for m in re.finditer(re.escape(CHUNK_MARK), data)]
    # 前导区（无版权头）也算一段
    segments = []
    if bounds and bounds[0] > 0:
        segments.append((0, bounds[0]))
    for i, b in enumerate(bounds):
        end = bounds[i + 1] if i + 1 < len(bounds) else total
        segments.append((b, end))
    print(f'chunks: {len(segments)} 段')

    index = ['# binary chunk 索引（2.1.283）', '',
             '| # | 偏移 | 大小 | 类型 | chunk 名 | JS 可读率 | 字符串池条数 |',
             '|---|------|------|------|----------|-----------|--------------|']
    js_total = pool_total = 0
    for i, (start, end) in enumerate(segments):
        seg = data[start:end]
        size = end - start
        # chunk 名：头 4KB 内的 chunk-xxxxxxxx 引用
        names = BUNFS.findall(seg[:4096])
        name = f'seg{i:03d}'
        if names:
            name = f'chunk-{names[0].decode()}'
        ratio = printable_ratio(seg[:200_000])
        # JS 源区 = 首个 \x00 之前（bytecode 区以 \x00 起始的字符串表跟随）
        nul = seg.find(b'\x00// @bun @bytecode')
        if nul < 0:
            nul = seg.find(b'\x00')
        if nul < 0 or ratio < 0.5:
            js_part, pool_part = b'', seg
        else:
            js_part, pool_part = seg[:nul], seg[nul:]
        strings = extract_strings(pool_part)
        js_total += len(js_part)
        pool_total += len(strings)
        kind = 'js' if ratio >= 0.5 else 'bytecode'
        index.append(
            f'| {i} | {start:,} | {size:,} | {kind} | {name} | {ratio:.0%} | {len(strings):,} |')
        # 导出符号（JS 区）
        exports = re.findall(rb'export\{([^}]{1,4000})\}', js_part[:80_000])
        with open(f'{OUT}/chunks/{name}.txt', 'w', encoding='utf-8') as f:
            f.write(f'# {name} @ {start:,} ({size:,} bytes, {kind})\n\n')
            if js_part:
                f.write('## JS SOURCE（minified 原样）\n\n```\n')
                f.write(js_part.decode('utf-8', errors='replace'))
                f.write('\n```\n\n')
            f.write(f'## STRING POOL（{len(strings):,} 条）\n\n')
            for s in strings:
                f.write(s + '\n')
    index.append('')
    index.append(f'**JS 源区合计**: {js_total:,} bytes · **字符串池合计**: {pool_total:,} 条')
    open(f'{OUT}/index.md', 'w', encoding='utf-8').write('\n'.join(index) + '\n')
    print(f'输出: {OUT}/index.md + {len(segments)} 个 chunk 文件')
    print(f'JS 源区 {js_total:,} bytes / 字符串池 {pool_total:,} 条')


if __name__ == '__main__':
    sys.exit(main())
