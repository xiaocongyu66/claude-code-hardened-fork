# 内存与性能峰值分析报告

> 进程 bun，RSS 基线 **682 MB**，最差 **1.8 GB** | 2026-05-02 | **调研完成**（12 轮迭代）
> 修复 commit：`ef10ad28` + `ab0bbbc4`（降 100-300 MB）| 架构限制：Bun mimalloc/JSC 不归还内存页（~150-250 MB 永久占用）
>
> **2026-09-13 逐项复核**：本报告部分条目已修复或经实测定案，详见各条目行内【标注】。未标注的条目仍是有效待办。复核时注意行号可能已漂移。

## JSC rope 复核（O(n²) 拼接条目，2026-09-29）

> 背景：Bun 运行于 JSC，`+=` 拼接生成 rope（cons string）节点，单次 O(1)；仅当字符串被"读"（charAt/slice/indexOf/比较/传入原生 API）或超大时才 flatten。因此 `+=` 循环只有**纯写**时整体 O(n)，**写-读交错**才是真 O(n²)。逐条以该语义复核原 O(n²) 拼接条目：

| 条目 | 判定 | 依据 | 修复 |
|------|------|------|------|
| 已修复表 R1：`claude.ts:1834,2271` 流式 text 拼接 | 已修（维持） | 现为 textDeltas 数组 push + 单次 join（`claude.ts:2223,2291-2294`）；且原版 `+=` 纯写下 rope 亦为 O(n)，修复收益主要是消除数千 rope 节点的 GC 压力 | 无需再动 |
| P1#7 text_delta 3 处 | 已修（验证一致） | `gemini/index.ts:153,177`、`grok/index.ts:180,200`、`openai/index.ts:463,480` 均数组累积 | — |
| P1#7 input/thinking 6 处（`openai/index.ts:465,468`、`gemini/index.ts:155,158`、`grok/index.ts:182,185`、`claude.ts:2178,2209,2258` 同型） | **误报**（rope O(n)） | delta 循环内纯写无读：无 slice/indexOf/charAt/字符串比较/原生 API 传入；唯一 flatten 在 `content_block_stop` → `normalizeContentFromAPI` → `safeParseJSON` 单次 O(n)（`utils/messages.ts:2566`）；`((block.input as string\|undefined) \|\| '')` 真值检查仅读 rope 长度 O(1) | 维持"保持原版"裁定 |
| P1#8 `messages.ts:3252,3268`（漂移至 `:3656,3676`） | 误报（维持剔除） | todo/task 提示消息各一次性 `+=`，无循环，n=1 | — |
| 交叉条目 `mcp-rust-rewrite-assessment.md:18`：stderrOutput += 未落地 | 过时（assessment 说法失效） | `captureStderr` 已是 chunks 数组 + 8MB cap + join（`packages/mcp-client/src/connection.ts:125-159`），调用方 `src/services/mcp/client.ts:1103,1174` 走 `getOutput()` | 已在 assessment 行内补【过时】标注 |

小结：复核 4 组条目、16 个代码位点——真 O(n²) 高危 0，修复 0，误报/已修 15，范围外新发现 1（下条）。

**范围外同类观察（本次不动）**：
- SSE 帧缓冲 `gemini/client.ts:66,82`、`openai/responsesAdapter.ts:209`、`dumpPrompts.ts:192`：`buffer += chunk` 后立即 indexOf/解析并 drain（`buffer = remaining`），n 上限 = 单 SSE 帧大小（KB 级）而非整条流 → 低危。
- `ripgrep.ts:219`：cap 截断守卫，`.length` 在 rope 上 O(1)，触发 cap 时单次 flatten → 低危。
- `voice.ts:94`：arecord 探针 150ms 生命周期 → 低危。
- **新发现（中低危，建议后续处理）**：`hooks.ts:1301` 的 `stderr/output += data` 配合 `hookEvents.ts:136` 进度轮询每秒 `output === lastEmittedOutput` 比较——输出持续变化时每 tick 触发 rope flatten（O(n_t)，Σ=O(n·ticks)），属真·写-读交错二次方模式；但 hook 输出通常 KB-MB 级、tick 间隔 1s，实际峰值有限。建议后续以变更计数器替代字符串比较。

## 已修复（10 项）

| 问题 | 原峰值 | 修复 | 位置 |
|------|--------|------|------|
| 流式字符串拼接 O(n²) | 2-20 MB | `+=` → 数组累积 | `claude.ts:1834,2271` |
| Messages.tsx 多次遍历 | 100-270 MB | 合并单次 pass | `Messages.tsx:417-418` |
| ColorFile 无缓存 | 50-100 MB | LRU-50 | `HighlightedCode.tsx:14-61` |
| Ink StylePool 无界 | 10-50+ MB | 1000 上限 | `@ant/ink/screen.ts:122` |
| CompanionSprite 高频 | CPU | TICK_MS→1000ms | `CompanionSprite.tsx:15` |
| MCP stderr 缓冲 | 1-640 MB | 64→8MB/server | `mcp-client/connection.ts:117` |
| BashTool 输出缓冲 | 30-330 MB | 32→2MB | `stringUtils.ts:88` |
| Transcript 写入队列 | 5-50 MB | 1000 上限 | `sessionStorage.ts:613-619` |
| contentReplacementState | 持续增长 | compact 清理 | `compact/compact.ts` |
| SSE 缓冲 | 无上限 | 1MB cap | SSE 处理代码 |

## P0 — 核心瓶颈（6 项）

| # | 问题 | 峰值 | 位置 | 建议 |
|---|------|------|------|------|
| 1 | 消息数组 7-8x spread 拷贝（turn 尾部 3-4 份同时驻留） | 120-320 MB | `query.ts` 7 处（:477,:491,:897,:1135,:1745,:1857,:1878） | 去掉 spread / 传引用 / 改 push 【已修 2026-09-13 `perf/p0-hotpath`：全部改 concat，query.ts 已无 spread 消息数组模式】 |
| 2 | AutoCompact 时序缺陷（检查在 API 前，增长在 API 后） | API 超限 | `query.ts:575` | 加入预测式阈值检查 |
| 3 | reactiveCompact 空存根（API 413 时无紧急压缩） | 无降级 | `reactiveCompact.ts` 全文 | 实现真实逻辑 |
| 4 | buildMessageLookups 8 Map/Set 重建（流式每个 delta 触发） | GC STW 100-173ms | `Messages.tsx:519` | 增量更新 / 拆分 useMemo 链 【已修 2026-09-13 `perf/p0-hotpath`：MessageLookupsCache 增量维护，0.71ms vs 4.26ms/delta，17238 次断言对拍】 |
| 5 | useDeferredValue 双缓冲 | 100-200 MB | `REPL.tsx:1569` | React 调度机制固有，优化空间有限 |
| 6 | Compact 峰值窗口（preCompactReadFileState + summary + attachments） | 20-80 MB | `compact.ts:524-644` | 提前释放 preCompactReadFileState/summaryResponse 【已修：`compact.ts:572`/:681 均已提前置 undefined】 |

## P1 — 重要瓶颈（14 项）

| # | 问题 | 峰值 | 位置 | 建议 |
|---|------|------|------|------|
| 7 | OpenAI/Gemini/Grok 兼容层 O(n²) 拼接 | 25-75 MB | 3 文件 9 处（`openai/index.ts:386`, `gemini/index.ts:148`, `grok/index.ts:163`） | 改数组累积（同 claude.ts 模式） 【text_delta 3 处已修 2026-09-13 `perf/p1-quickwins`；input/thinking 经裁定保持原版（对齐 claude.ts 的 += 样板）】【JSC rope 复核 2026-09-29：input/thinking 误报——纯写循环单次终读，rope 下 O(n)，见"JSC rope 复核"节】 |
| 8 | messages.ts O(n²) 拼接 | 10-25 MB | `messages.ts:3252,3268` | 改数组累积 【误判 2026-09-13 复核：:3654/:3674 为 todo 提示消息的一次性追加，非流式热路径，剔除；2026-09-29 rope 复核维持，行号现漂移至 :3656/:3676】 |
| 9 | highlight.js 全量 192 语言（仅需 26 种） | 8-12 MB | `color-diff-napi/index.ts:21` | 自定义构建 |
| 10 | hlLineCache 模块级单例 2048 条目 | ~4 MB | `color-diff-napi/index.ts:508` | 改 LRU + size 上限 【已修：现 `index.ts:924` 已有 2048 上限淘汰，~4MB 收益过小，剔除】 |
| 11 | colorFileCache 3x 代码存储 | 2-5 MB | `HighlightedCode.tsx:14` | 移除 value 中 code 字段 【裁定不改 2026-09-13：code 字段是缓存键校验（`:48 cached.code === code`），非冗余；优化需重设计 key，不值】 |
| 12 | 虚拟滚动 200 组件常驻 | 50 MB | `useVirtualScroll.ts` | 降低 OVERSCAN_ROWS / MAX_MOUNTED_ITEMS |
| 13 | FileReadTool 大文件（输出上限 100K 字符，但读取期间完整加载） | 临时数 MB | `FileReadTool.ts:342` | 读取前检测大小，流式截断 |
| 14 | Session 恢复全量加载（磁盘→JSON→REPL 三阶段） | 200-300 MB | `sessionStorage.ts:3482` | 流式 JSONL / 增量恢复 |
| 15 | Session 写入 100MB 累积 | ~100 MB | `sessionStorage.ts:652` | 流式写入 |
| 16 | Forked Agent FileStateCache 完整克隆 | 50N MB | `forkedAgent.ts:382` | 共享/分层缓存（agent 用 10MB） |
| 17 | GC 阈值 350MB < 基线（每秒无意义强制 GC） | CPU 浪费 | `cli/print.ts:554` | 提高到 800MB+ |
| 18 | PDF 100 页处理 | ~100 MB | `apiLimits.ts:54` | 分页流式处理 |
| 19 | 图片单张处理（base64→解码→resize） | ~16 MB/张 | `apiLimits.ts:22` | 流式 resize |
| 20 | token 估算 ±25-50% 误差放大时序问题 | 阈值不准 | `tokenEstimation.ts:215` | 内容类型感知估算 |

## P2 — 次要问题（10 项）

| # | 问题 | 峰值 | 位置 |
|---|------|------|------|
| 21 | lastAPIRequestMessages 常驻 | 30-50 MB | `bootstrap/state.ts:118` |
| 22 | MCP Tool Schema 双重存储 | ~40 MB | `manager.ts:73` + `AppStateStore.ts:175` |
| 23 | ContentReplacementState 单调增长 | 0.5-2 MB | `toolResultStorage.ts:390` |
| 24 | Perfetto 100K 事件 | ~30 MB | `perfettoTracing.ts:106` |
| 25 | StreamingMarkdown 双渲染 | 临时 | `Markdown.tsx:185` |
| 26 | MarkdownTable 3 次遍历 | CPU 峰值 | `MarkdownTable.tsx:99` |
| 27 | 搜索索引 WeakMap | 5-10 MB | `transcriptSearch.ts:17` |
| 28 | ACP FileStateCache/会话 | 50 MB | `acp/agent.ts:554` |
| 29 | Agent initialMessages 浅拷贝 | 1-5 MB/agent | `runAgent.ts:382` |
| 30 | Hook 结果累积 | ~1 MB+ | `toolExecution.ts:1474` |

## CPU / 渲染热点

| # | 问题 | 影响 | 位置 |
|---|------|------|------|
| C2 | Ink 每次 React commit 触发 Yoga 布局 | ~1-3ms/commit | `reconciler.ts:279` → `ink.tsx:323` |
| C3 | MessageRow 挂载 ~1.5ms（React/Yoga/Ink 管线开销） | 批量挂载 ~290ms 卡顿 | `useVirtualScroll.ts` |
| C4 | 布局偏移触发全屏 damage | O(rows×cols) | `ink.tsx:655-661` |
| C9 | 同步 fs 操作阻塞主线程 | 间歇卡顿 | `projectOnboardingState.ts:20` 等 |

已有缓解：React ConcurrentRoot 批处理、帧率限制 16ms、虚拟滚动 overscan 80 + SLIDE_STEP=25 + useDeferredValue、Markdown tokenCache LRU-500 + hasMarkdownSyntax 快速路径、Yoga 增量缓存。

## 已否认（12 轮汇总）

VSZ 516 GB 是虚拟映射 | Zod ~650KB | Markdown LRU-500 已优化 | useSkillsChange/useSettingsChange 正确 cleanup | useInboxPoller 收敛设计（非循环）| React Compiler `_c(N)` 未使用 | File watchers ~5KB | React reconciler WeakMap + freeRecursive | Ink 屏幕缓冲 ~86KB | CharPool/HyperlinkPool ~1-5MB 5min 重置 | AWS/Google/Azure SDK 均懒加载 | Sentry 空实现 | useCallback 闭包通过 messagesRef 规避（无泄漏）| MCP stderrHandler 有 64MB cap + cleanup | useRef 有 clearConversation/compact 清理 | apiMetricsRef turn 结束重置 | useEffect 有 cleanup 函数 | lodash-es tree-shakable | AppState useSyncExternalStore 仅相关切片更新 | SDK 无全局重试队列 | Ink unmount 有清理

## 结论

**内存根因排序**：
1. 消息数组 7-8x spread 拷贝（120-320 MB）— 核心瓶颈
2. useDeferredValue 双缓冲 + React useMemo 链全量重算（100-200 MB + GC STW）
3. Session 恢复/写入峰值（200-300 MB）
4. AutoCompact 时序缺陷 + reactiveCompact 空存根（API 超限风险）
5. Forked Agent FileStateCache 克隆（50N MB）
6. 虚拟滚动 200 组件 ~50MB 常驻
7. Bun/JSC 不归还内存页（架构级）

**CPU 根因**：useInboxPoller 每秒轮询 → React commit → Yoga 布局 → 全屏 Ink diff 完整管线。Markdown 渲染批量挂载时 ~290ms 卡顿。

**预估优化空间**：

| 优先级 | 措施数 | 预估降低 |
|--------|--------|----------|
| P0 | 6 | 240-600 MB |
| P1 | 14 | 300-600 MB |
| P2 | 10 | 80-200 MB |
| **合计** | **30 项** | **620-1400 MB** |

理论可从 400-700 MB 降至 **200-350 MB**（受 mimalloc/JSC 架构限制约束）。
