# 官方会话性能机制 vs cch 对照（binary 2.1.283 实证）

> 2026-09-29 | 锚点均为已验证偏移；标注「未挖到」的项禁止后续臆测补全，需重挖 binary 取证。

## 官方机制（已实证）

### 1. KEEP-RECENT MC（time-based microcompact，tool result 清理）

可读实现：chunk-m210vdvf（@150882400-150885700）+ 调用方 chunk（@157027000-157028100）。

常量（原文 `var xar=20000,E=2000` @150882690）：
- `xar=20000` — 最低节省 token 门槛；估算节省 < 20000 时整个 MC 返回 null 不动
- `E=2000` — 具体用途未挖到（不猜；与输出截断相关，待重挖）
- `keepRecent=5` — 调用方局部 `var k=5` 且以 `{keepRecent:k,...}` 传入 `lto`（同 chunk 紧邻，高置信）
- 占位串：`f="[Old tool result content cleared]"`、`g="<persisted-output>"`、前缀 `d=c1t`
- 可清理判定 `k(content)`：已是清理占位或已持久化的内容跳过（幂等）

流程（`Par` → `lto` @150883500/150884560）：
1. `Par(messages, keepRecent)`：收集全部 tool_use id，保留**最后 5 个**为 keepSet，其余 clearSet；
   逐条估算 tokensSaved（`A(e)` 按字符串/块累计）
2. `lto`：tokensSaved < 20000 → 返回 null；否则对每个 clear 条目调 `persist(content, id)`
   写磁盘文件，替换内容为 `<persisted-output>` 指引串（调用方 `H`：`Tool result saved to: <path>
   (truncated to the first N bytes) — Use Read tool to view`）；图片/文档块保留占位不持久化
3. 遥测：`tool_result_clear`（仅 main）+ `tengu_time_based_microcompact`
   `{toolsCleared, toolsKept, keepRecent, tokensSaved, trigger}`
4. 触发方：context_hint 流程（`[CONTEXT_HINT_REJECT] mc=<是否生效> tokensSaved=<n>` @157027592）——
   context hint 被拒/需要腾空间时先跑 MC 再考虑 full compact

### 2. autoCompactWindow（有界自动压缩）

- settings 键 `autoCompactWindow`（描述 "Auto-compact window size" @136586896）+
  env `CLAUDE_CODE_AUTO_COMPACT_WINDOW`（@62900030）
- org 默认不强制时的用户文案（原文）："…so this session can grow past it. To enforce it,
  set CLAUDE_CODE_AUTO_COMPACT_WINDOW=<n> (or the autoCompactWindow setting)"
- 语义标记：`window_source_auto` / `window_above_boundary`；`autoCompactWindowsCache`
  （按模型的窗口缓存 @65957785）

### 3. 会话遥测/缓存伴生机制（存在性实证，内部数值未挖到）

- `cachedUsageUtilization`（prompt cache 利用率 @65957785）
- compaction 遥测：`{trigger, success, duration_ms, pre_tokens, postCompactTokenEstimate,
  tokensSaved, mcApplied, mcTokensSaved}`（@141101823 与 @157027000 两处字段清单）

## cch 对照（依据 docs/audits/memory-peak-analysis.md + 现有代码）

| 官方机制 | cch 现状 | 缺口 |
|---|---|---|
| KEEP-RECENT MC（keepRecent=5 + persist 落盘 + 20000 门槛 + 幂等占位） | **无对应机制**（audit 无此条目）；compact 是全量摘要式 | **最大缺口**：长会话中旧 tool result 全部驻留内存与上下文；需新建 tool-result-clear 模块（候选收集/估算门槛/persist 写盘/占位替换/遥测五件套） |
| autoCompactWindow（数值窗口 + env 覆盖 + 按模型缓存） | 阈值比例式检查（P0#2 预测式已修）；`reactiveCompact` 仍是空存根（P0#3） | 需补：数值窗口设置 + env 覆盖 + 窗口缓存；reactiveCompact 落地 |
| persist 后输出截断标注（truncatedAtBytes + "Use Read to view"） | FileReadTool 有 100K 输出上限（P1#13），但无 MC persist 路径 | 随 MC 一起实现 |
| compaction 遥测字段（mcApplied/mcTokensSaved 等） | logEvent 已有 compaction 相关（未逐字段核对） | 待逐字段对齐（重挖再定，不猜） |

## 结论

官方长会话内存的第一道防线不是 full compact，而是 **KEEP-RECENT MC**：
保留最近 5 个 tool result、更旧的持久化到磁盘文件、上下文里只留指引串，
且有 20000 token 门槛防止小操作白跑。cch 完全没有这一层——这是「对比我们的会话」
最优先要补的机制；其次是 reactiveCompact 落地与 autoCompactWindow 数值化。

## 未挖到清单（后续重挖取证，禁止臆测）

1. `E=2000` 的确切用途
2. autoCompactWindow 的默认数值
3. `tengu_time_based_microcompact` 中 time 触发的具体计时来源（名字含 time_based，
   但本次只实证了 context_hint 触发路径）
4. `c1t` 前缀常量的字面值
