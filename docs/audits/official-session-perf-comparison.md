# 官方会话性能机制 vs cch 对照（binary 2.1.283 实证）

> 2026-09-29 批次 N 重写 | 锚点均为已验证偏移；「未挖到」项禁止臆测补全，需重挖取证。
> cch 侧状态截至 47dba9b7（批次 M/N1 落地后）。

## 机制 1：KEEP-RECENT MC（tool result 清理 + persist 落盘）

### 官方规格

可读实现：chunk-m210vdvf（@150882400-150885700）+ 调用方（@157026400-157028100）+ JW（@142844321）。

常量（原文 `var xar=20000,E=2000` @150882690）：
- `f='[Old tool result content cleared]'`（无 persist 时的占位）
- `g='<persisted-output>'`（指引串前缀；完整替换串 = 调用方 H @157027253：
  `Tool result saved to: <path> (truncated to the first N bytes)\n\nUse Read to view`）
- `E=2000`：image/document 块的固定 token 估算
- `keepRecent=5`：调用方 `var k=5` 以 `{keepRecent:k,...}` 传入 `lto`（同 chunk 紧邻，高置信）
- 幂等 `k(content)`：内容 === f 或 startsWith g 的跳过（只查 string 形态）
- 水印 `T(content)`/`d=c1t`：含 `<artifact-content-authored-by-others/>`（dh @136015452）的
  内容，替换串保留水印前缀（Gwt 的 `!p.startsWith(d)&&T?`${d}${p}`:p`）
- 白名单 `R = new Set([Read(at), ...ob, Ur, ro, uv, Dr, Rt, wn])`——**精确成员未完全溯源**
  （跨 chunk 同名变量干扰；ob=[Be,St] 的字面值未挖到）

核心语义（`Par` → `lto`）：
1. `Par(messages, keepRecent)`：按白名单收集 tool_use id，保留最后 5 个为 keepSet，
   其余 clearSet；逐条估算 tokensSaved（字符串 `Fu(len/4)`、image/document 固定 2000）
2. `lto`：tokensSaved < 20000 → 返回 null；否则**clearSet 内全部清除**——
   `u.set(id, m ?? f)`：persist 成功 → 指引串；失败/无 persist 回调 → 纯占位 f。
   persist 只决定替换串形态，不决定清不清（图片/文档块 persist 必拒 → 占位）
3. persist（JW @142844321）：非文本拒绝；maxBytes 截断（C1t，4MB cap）；
   `leafName = <id>.<json|txt>`；返回 `{filepath, truncatedAtBytes, preview}`

### cch 状态：✅ 已对齐（47dba9b7）

- `src/services/compact/microCompact.ts`：`TIME_BASED_MC_CLEARED_MESSAGE`（官方 f 原文）、
  keepSet/clearSet（keepRecent floor 1）、`ARTIFACT_WATERMARK`（官方 dh 原文）前缀、
  persist 走 `toolResultStorage.persistToolResult`（动态 import 规避静态环）、
  **persist 失败/无 storage → 纯占位（批次 N1 修正——原实现 continue 跳过替换，
  tokensSaved 虚计）**、幂等 `isAlreadyClearedContent`（=== 占位 或 startsWith
  `<persisted-output>`）
- `src/utils/toolResultStorage.ts`：`PERSISTED_OUTPUT_TAG='<persisted-output>'`（官方 g 原文）、
  `persistToolResult`（wx 幂等写盘、非文本拒绝）——与 JW 同构；
  **差异：无 maxBytes 截断**（cch 内容经常规路径已截断，语义等价，已标注）
- `IMAGE_MAX_TOKEN_SIZE=2000`（官方 E）✓
- 差异登记：cch 白名单 = Shell/Glob/Grep/FileRead/WebFetch/WebSearch/Edit/Write
  （官方 R 精确成员未溯源，按 clearable 语义对齐）

## 机制 2：xar=20000 估算门槛

### 官方规格

- `lto` 入口：`tokensSaved < 20000 → return null`——先只读估算（Par 返回 tokensSaved），
  达标才进入替换。防抖语义：省不出 2 万 token 时，persist IO + 引用断裂（模型需重新
  Read）的代价不划算。
- 20000 数值本身的选择依据：binary 无注释，**未挖到**。

### cch 状态：✅ 已对齐

- `timeBasedMCConfig.ts`：`minTokensSaved: 20000`（可配，默认官方 xar）
- `microCompact.ts`：两阶段——先只读估算循环，`tokensSaved < config.minTokensSaved → null`，
  达标才收集替换计划

## 机制 3：幂等

### 官方规格

`k(content)`（@150883200）：string 且（=== 占位 或 startsWith `<persisted-output>`）→ 跳过。
发生在 Par 估算阶段（`!k(c.content)` 才累计）与替换阶段（Gwt map）。

### cch 状态：✅ 已对齐

- `isAlreadyClearedContent`：同样两条（=== `TIME_BASED_MC_CLEARED_MESSAGE` ||
  startsWith `<persisted-output>`），估算与替换两处都调用。
  **差异：官方只查 string；cch 同样只查 string（数组块替换后已是 string，行为收敛）**

## 机制 4：触发链（两条路径）

### 官方规格

**路径 A — gap 超时（time-based）**：`tengu_time_based_microcompact` 遥测事件名。
GB 配置（`tengu_hazel_osprey` 开关 @157026400、`tengu_hazel_osprey_floor` floor=75000）。
触发计时来源的字面证据：**未挖到**（名字含 time_based，现行实证触发是路径 B 的
context_hint 拒绝 + 请求前 gap 检查）。

**路径 B — context_hint 声明→拒绝→本地 MC**（@157026400-157028710，已验真）：

```js
var b = 75000
function m()   { return x('tengu_hazel_osprey_floor', b) }        // target floor
function p(e)  { return e instanceof Ot && (e.status===422 || e.status===424) }  // 拒绝
function f(e)  { return e instanceof Ot && e.status===409 }       // 冲突
function E(e)  { status===400 && (msg含'Unexpected value'+'anthropic-beta' || MSo(msg)) }  // busy
// M$r = C('context_hint', 'context-hint-2026-04-09')  @137739971

buildRequestParams（仅 repl_main_thread）:
  Par(messages, 5).tokensSaved >= 20000
    → beta: M$r, body.context_hint = {enabled:true, target_tokens_saved?}
    → 否则 context_hint: null
onRequestError:
  p(r)  → C()：本地 MC（lto）+ tengu_context_hint_reject {requestId,
          pre/postCompactTokenEstimate, tokensSaved, mcApplied, mcTokensSaved}
  E(r)  → l()：tengu_context_hint_busy_fallback
```

### cch 状态：⚠️ 部分

- ✅ 路径 A：gap 触发（60min，GB `tengu_slate_heron` 配置）、遥测
  `{toolsCleared, toolsKept, keepRecent, tokensSaved, gapMinutes, gapThresholdMinutes}`
- ❌ 路径 B：**未实现**（批次 M3 显式暂缓）。理由：cch 走第三方渠道，
  422/424 拒绝形态与 `context-hint-2026-04-09` beta 是否被服务端接受不可验证；
  声明面跨 claude.ts options 类型/query.ts 主调用点 5+ 处签名。
  **待真机确认服务端行为后落**（规格已完整，实现路径明确）。

## 机制 5：autoCompactWindow（数值窗口）

### 官方规格（@144220714 CE 解析链 + @138774155 常量，已验真）

窗口解析优先级（`CE(facts, settingsValue)`）：

```
1. env      CLAUDE_CODE_AUTO_COMPACT_WINDOW → window=min(contextWindow, max(k9e, v))
            source:'env'（k9e 下限值未挖到）
2. settings settings.autoCompactWindow → window=min(g, n)      source:'settings'
3. clientdata  p0n(canonical).window                            source:'clientdata'
4. experiment hwe(e)（kelp_forest_sonnet，仅 claude-sonnet-4-6，
            值 ∈ (200000, 1000000]）                            source:'experiment'
5. model-default g<1e6 且（unclampedButBilledPast200k || native1mInCatalog || ILr）
            → window=min(g, SK=200000)                          source:'model-default'
6. u0n(canonical)（模型目录替换值）→ …（后续分支未逐行挖完）
```

伴生常量：`A$e=200000`（基准）、`SK=200000`、`gh=32000`、`Mx=128000`、`Ux=1e6`（1M 上限）。
遥测：`windowSource: ue(_Ct(facts, window))`（@145115642）；
`window_source_auto`/`window_above_boundary` 字符串（@62900030）；
org 默认不强制时用户文案（@62900030）："…so this session can grow past it.
To enforce it, set CLAUDE_CODE_AUTO_COMPACT_WINDOW=<n> (or the autoCompactWindow setting)"。

### cch 状态：❌ 缺口

- cch autoCompact 是比例阈值式（`src/services/compact/autoCompact.ts`），无数值窗口
  setting、无 env 覆盖、无窗口来源遥测。缺口属于 autoCompact 域改造（非 MC 域），
  未在本批次范围——已登记待办。

## cch 对齐状态总表

| # | 机制 | 官方 | cch | 状态 |
|---|------|------|-----|------|
| 1 | KEEP-RECENT MC（keepRecent=5+persist+m??f+幂等+水印） | @150882400-150885700 | microCompact.ts | ✅ |
| 2 | xar=20000 门槛（两阶段） | @150884560 | minTokensSaved=20000 | ✅ |
| 3 | 幂等（k(content)） | @150883200 | isAlreadyClearedContent | ✅ |
| 4 | 触发链 A（gap 超时） | 遥测名实证 | timeBasedMCConfig | ✅ |
| 4b | 触发链 B（context_hint 声明→拒绝→MC） | @157026400-157028710 | 未实现 | ❌ 待服务端确认 |
| 5 | autoCompactWindow 数值窗口 | @144220714 | 比例阈值式 | ❌ autoCompact 域待办 |

## 未挖到清单（禁止臆测，需重挖）

1. 工具白名单 R 全部成员字面值（已知 Read；ob=[Be,St] 未溯源）
2. 指引串前缀 VZ / 尾缀 LUn 字面值（cch 用 g + H 原文重组，形态一致）
3. `tengu_time_based_microcompact` 命名中 time 的历史来源
4. `k9e`（env 窗口下限）与 `pft`（env 解析形态）的值
5. CE 解析链第 6 步之后的完整分支（u0n 后续）
6. `clearedContent`（lto 返回的 Map<id,替换串>）在上层的消费用途
7. 20000 / 75000 两个数值的选择依据（binary 无注释）
