# Fleet 视图逆向规格（binary 2.1.283）

> 状态标注：✅ 原文实证（附偏移）· ⚠️ 部分实证（缺口标明）· ❌ 未挖到（如实说明）
> 本文档是 FleetView 实施的唯一依据；实施中任何与本文档冲突的行为都是 bug。

## 0. 装配树总览 ✅

```
Hp（主组件 @153162004）
├─ store 装配：roster(ur) / selection(ui) / view(xp) / attach(pi) / editor(mi) /
│   deleteConfirm(Ep) / earlier(ne.earlier) / launcher(Bp)        ✅ @153162004+0..5500
├─ 键位：gje({handleKeyDown:mf}) → mf=K=>Tp(Bs(),K)                ⚠️ Tp 原文待补（挖掘中）
├─ 渲染：e(el,{owners,layout:Rn,header:e(Da,...),renameInput,groupInput,actions})
│        e(Cl,{owners,layout,highlights,...})
│        e(kl,{owners,layout,footer:e(il,...)})                   ✅ @153162004+16400..17200
└─ 事件：onKeyDownCapture(Yl+Yn) onKeyDown(gf) onPaste(cd)
         onWheel(K=>K.preventDefault(), to.current?.scrollBy(K.deltaY>0?3:-3))  ✅
```

## 1. 行渲染

### 1.1 Hi（完整 job 行）✅ @153091689

props：`{job,isFocused,focusFg,isOrigin,logTail,status,cols,showVerb,loopKickCount,age,childRows,renaming,groupEditing,deleteArmed,deleteRefused,attaching,heldInTerminal}`

列结构（原文实证）：
- **图标列** `width=cols.label+2, flexShrink:0`：`[图标 Text, " ", 标签 Text]`；
  图标 = `fe ?? <an/>`；attaching==='armed'→spinner、justKilled→`∙`、否则 Tn(state)
- **detail 列** `flexGrow:1 width:0 paddingLeft:2`，互斥分支（优先级）：
  1. groupEditing → `"group: "`(dim) + 编辑器 + `(reserved name)`(error)/`(new group)`/`(ungroup)`/`(add to X)`(dim)
  2. attaching==="armed" → `"opening… · esc to cancel"`(dim)
  3. deleteArmed → `"ctrl+x again to ungroup"`(warning)/`"stopped · ctrl+x again to delete"`/`"ctrl+x again to delete"`(error)
  4. deleteRefused → `"not deleted"`(error) + ` · {原因}`(dim)
  5. attaching → `"opening…"`(dim)
  6. heldInTerminal → `"Open in a terminal"`(suggestion) + `"continue it there"`(dim)
  7. showVerb → 状态词（rn 色）+ logTail(dim)；否则纯 dim logTail
- **artifact 列**（cols.artifact>0，`width=cols.artifact+2, paddingLeft:2, justifyContent:'flex-end'`）：
  多 PR → `"N PRs"`；单 PR → `<fY number url>`；无 number → `"PR"`
- **age 列** `width=cols.age+2, paddingLeft:2, justifyContent:'flex-end'`(dim)；
  loopKickCount 前缀 `"×"+N`（paddingLeft:1, dim）
- 整行 `r(Rt,{children:[Ye(icon列), Ht(detail列), _t(artifact列), xt(age列)]})`

### 1.2 Tn 图标 / an spinner / rn 状态词 ✅ @153067933/@153068073/@153064840

- glyph 集 `lt=["·","✢","*","✶","✻","✽"]`（ghostty 用 at 集）；普通态 `✻`=lt[4]、特殊态 `✢`=lt[1]、终态 `∙`（Nye="\u2219"）
- spinner 12 帧 `[...lt,...lt.toReversed()]`，Ea(120) 时钟
- 状态词 rn：success→`Done`(success)、failure→`Failed`(error)、stopped→`Stopped`(inactive)、
  busy/shell→`working`(无色)、blocked/waiting→`blocked`(warning)、else→`Idle`(dim)

### 1.3 Gi（simple 行）✅ @153097421

单行 `[❯|空格, icon, "  ", label]`；expanded||refusal 时第二行 `paddingLeft:3`：`[age, tokens, refusal(error)|extra(state.color)]`

### 1.4 el（行容器）⚠️ props✅ @153098899 · rows 装配循环与 cols 计算待补（挖掘中）

从 layout 解构：`{rows,filtered,byState,byGroup,isOnboarding,hasComposedDispatch,dispatchTargetGroup,hasMultipleOrigins,focusedGroup,groupCounts,earlierVisible,simpleBuilt,cols,loopJobIds,focusIsFromHover,queryIsFilter}`
- 宽度 ≥120 → 列表左缩进 1（Bt=1）
- 选中跟随：`scrollToElement(eo.current, focused? -1 : 0, {block:'nearest'})`
- group 建议面板：>4 条窗口化，上方 `"  … {ho} above"`

### 1.5 fold 行 ✅ @153104363

- finished/simple:finished 组：`… show all ({hidden} more{ · {failed} failed})`
- 其他组：`… {hidden} more`
- aria：`{selected?"selected, ":""}{hidden} more finished sessions folded:`

## 2. Header（Da）⚠️ counts✅ · logo 待补（挖掘中）

- 宽 ≥70 且非 compact：左侧 logo（Nre 组件）——**原文待补**
- 标题行：bold `Claude Code` + dim ` v{VERSION}`
- 第二行 dim：`{model 显示名} · {cwd}`（target≠launcher cwd 时截断+suggestion 色）
- counts 行 dim：`{N awaiting input} · {N working} · {N completed}`（completed 含 earlierVisible）；
  simpleBuilt：`{N needs you} · {N working} · {N idle}`；空：`nothing running`
- originJobId 行（仅 origin 场景）：`Your conversation moved to the background — enter opens it · esc returns to it · ctrl+c twice quits`

## 3. Composer（Cl）⚠️ 结构✅ @212646407 · Gh 边框细节待补（挖掘中）

- suggestion 层：`position:'absolute', marginTop:-1, height:1, alignItems:'flex-end'`
- 输入框：borderStyle/边各向 待 Gh 原文确认；bash 态 borderColor:'bashBorder' + prefix `!`
- placeholder（非 bash 非 voice）：`describe a task for a new session`（@212648398）
- prefix：bash→`!`、queryIsFilter→无、否则 `Z.pointer`（❯）；prefixDim:!hasDispatch&&!bash
- isFocused：`!previewOpen && renamingJobId===null && groupEdit===null && resumePicker===null`
- onboarding blurb（onlyOrigin && !query）：`A different way to work with Claude: hand off a bigger task than you would chat through, and Claude organizes it in the sections above so you know when it needs you.`

## 4. Footer（il @212622659 / kl @212642005）✅ 分档清单

优先级链（全 dimColor 除注明）：
1. exitPending → `Press Ctrl-C again to exit`（simple: `press ctrl+c or q again to exit`）+ 可选 ` · N agents will keep running`
2. renaming/groupEdit → chord：`enter save`、`tab complete`、`← deselect`、`escape cancel`（keyCase:"lower"）
3. deleteConfirm pending → `ctrl+x again to delete · esc to keep`（或 `stopped · ctrl+x again to delete · esc to keep`）
4. error → error 色，wrap truncate-end
5. voice 状态 → hint → dim truncate-end
6. simpleView idle → `→ or enter to start|open` / `ctrl+x to delete|stop` / `? for shortcuts`
7. 默认宽 footer（` · ` 连接，按列宽分档）：
   - dispatch defaults（ti）
   - `enter <enterLabel>`
   - col≥90：`paste again to expand`
   - group header 聚焦：`enter expand/collapse`；fold 聚焦：`enter show all`
   - col≥55：`space reply`
   - `hold space to speak`
   - col≥80：`ctrl+x delete|ungroup|delete all`
   - bash dispatch：`! for shell mode`（bashBorder 色）
   - query 非空：`escape clear`；否则 `? for shortcuts`
   - daemon 后端 col≥111：`ctrl+e group`
- kl 附属 resume-picker 覆盖层：absolute 底部，round 边框，标题 `Resume a past session`

## 5. 编辑器与联动 hooks ❌ 待补（挖掘中：Jm/El/t7n/mi/ve）

## 6. 键位 ⚠️
- Hp 渲染事件装配 ✅（onWheel scrollBy ±3 / onPaste cd / onKeyDown gf）
- Tp 主分发、Yp actions、Vc/Di/Hc openers、Lj exitPending —— 待补（挖掘中）
- 官方键位表 XP —— 待补（挖掘中）
- help 覆盖层键位清单 ✅ @212627878：`shift+↑↓ to reorder`、`ctrl+r to rename`、`ctrl+e to set group`、`<switchView key> to switch views`、`ctrl+j for newline`、`ctrl+enter to start and open`、`@ to mention`、`<togglePin key> to pin to top|unpin`、`alt+1[-N] to open`、`ctrl+x to <label>`、`← to go back`、`esc to close · esc again quits`（或 `esc to quit`）、`? to close`；两列 paddingX:2 gap:4

## 7. 与 cch 的已知差异登记（实施对照用）

| # | 项 | 官方 | cch 现状 | 状态 |
|---|---|---|---|---|
| D1 | logo 三行 art | Nre 组件 | 无 | ❌ 待 logo 原文 |
| D2 | model 行 | `{model} · {cwd}` | 仅 cwd | ⚠️ model 源待确认 |
| D3 | 分组组名 | byState 组名表（待 cols/rows 挖掘） | WORKING/BLOCKED/IDLE 大写+计数 | ❌ 待组名表 |
| D4 | composer 边框 | Gh 原文待确认 | round+仅上边 | ⚠️ |
| D5 | footer 键位集 | il 分档原文 | 自造键位集 | ✅ 可修 |
| D6 | detail 分隔 | 独立列 paddingLeft:2 | ` · ` 文本拼接 | ✅ 可修 |
| D7 | PRs/age 列 | artifact+age 独立列右对齐 | 无 artifact 列 | ⚠️ PR 数据源缺 |

## 8. 真原文定论（@153.0M-153.14M 区，全部已验真——此前 @212.6M 报告为幻觉作废）

### 8.1 分组（@153017478）✅

```js
var en = ["review","blocked","working","done"]          // 组序：review 最前
var ao = { review:"Ready for review", blocked:"Needs input", working:"Working", done:"Completed" }
var zs = { review:"", blocked:"Sessions that have a question or need your decision land here",
           working:"Sessions Claude is actively working on — they keep running even if you close the terminal",
           done:"Finished sessions wait here for you to review" }   // 组副标题
function ii(o,u,f){                                      // 分组函数
  if(f==="busy")return"working"
  if(o.activity==="failure")return"done"
  if(o.activity==="stopped")return"done"
  if(f==="waiting")return"blocked"
  if(有OPEN PR且error/warning未approved)return"review"
  if(o.activity==="success")return"done"
  if(o.state.tempo==="blocked")return"blocked"
  return"working"                                        // 兜底（含 idle）
}
function Dd(o){return o>0?`${o} awaiting input · claude agents`:"claude agents"}  // 终端标题
```

### 8.2 Header（@153088900-153090600）✅

```js
{columns:D}=ve(); {compactHeader:P, simpleBuilt:G, bandCounts:M, earlierVisible:A}=layout
version/cwd = MJe()
ee = query ? `${Qz(model)} (session)` : Qz(k?.model ?? it())   // model 显示名
te = target!==launcher cwd
Y  = Obe(te ? xa(b) : re, Math.max(D-11-(ee?ie(ee)+3:0), 10))  // cwd 截断：columns-11-model宽-3，最少10
ne = !P && D>=70 && e(Nre,{})                                   // logo：宽≥70 才渲染
de = 标题行: [bold 'Claude Code', ' ', dim ['v',version]] + [dim ee · ae(cwd, te?suggestion:dim)]
me = counts 行:
  simple: [`${needsCount} needs you`,`${workingCount} working`,`${liveCount-workingCount} idle`,'nothing running']
  普通:   [`${M.blocked} awaiting input`,`${M.active} working`,`${M.completed+A.length} completed`]  // A=earlier
Pe = r(s,{flexDirection:'column',children:[de,me]})
fe = r(s,{gap:2, marginBottom:1, children:[ne(logo), Pe]})      // 横排 logo+文本列，gap 2
Ce = origin 行: 'Your conversation moved to the background — enter opens it · esc returns to it · ctrl+c twice quits'
```

### 8.3 Logo（Nre @152987900-152990700）✅

```js
var L = {
  default:     {r1L:" ▐", r1E:"▛███▛█", r1R:"",       r2L:"▝▜", r2R:"██▀"},
  "look-left": {r1L:" ▐", r1E:"▟███▟█", r1R:"",       r2L:"▝▜", r2R:"██▀"},
  "look-right":{r1L:" ▐", r1E:"█▟███▟", r1R:"",       r2L:"▝▜", r2R:"██▀"},
  "arms-up":   {r1L:"▗▟", r1E:"▛███▛█", r1R:"▄",      r2L:" ▜", r2R:"█▘"}
}
渲染（非 Apple_Terminal、_t()=screen reader 时 null）：
  行1 = [r1L(clawd_body), r1E(clawd_body+clawd_background 底), r1R(clawd_body)]
  行2 = [r2L(clawd_body), '█████'(clawd_body+clawd_background), r2R(clawd_body)]
  行3 = ' ▝▝   ▝▝ '(clawd_body)
  容器 flexDirection:'column' flexShrink:0
Apple_Terminal 版（m）：'[▗反色][ ▗   ▖ 反色][▖]' 三行居中变体
```

### 8.4 Composer（@153135400-153136700）✅

```js
Ee = v(隐藏) ? null : e(s,{
  flexDirection:'column',
  borderStyle:'round', borderLeft:!1, borderRight:!1,
  borderColor: bash?'bashBorder':void 0,
  borderDimColor: !bash,                    // 非 bash 态 dim 边框
  children: e(Gh,{
    placeholder: bash||voice非idle ? '' : 'describe a task for a new session',
    prefix: bash?'!' : queryIsFilter?void 0 : Z.pointer,   // pointer
    prefixDim:!hasDispatch&&!bash, prefixColor:bash?'bashBorder':void 0,
    isFocused:!previewOpen&&renaming===null&&groupEdit===null&&resumePicker===null,
    width:'100%', borderless:!0, wrapColumns:columns
  })
})
rt = r(s,{flexShrink:0, flexDirection:'column', marginTop:1, children:[Be,ct,St,D,null,Ee]})
```

### 8.5 Footer（@153110800-153114400）✅

```js
Rt = simple?1:2
Ot = e(s,{flexShrink:0, paddingLeft:Rt, height:1, children:Le})
优先级链:
 1. exitPending → simple?'press ctrl+c or q again to exit':'Press Ctrl-C again to exit'
                  + (N>0 && ` · ${N} ${I(N,'agent')} will keep running`)
 2. renaming/groupEdit → chords: 'enter save'、(assign&&draft变&&suggestions)'tab complete'、
    (assign&&选中)'← deselect'、'escape cancel'（U 组件 keyCase:lower）
 3. deleteConfirm → simple? 文本('stopped · ctrl+x again to delete · esc to keep'|'ctrl+x again to delete · esc to keep')
                    : chord 'ctrl+x confirm'
 4. error → error 色 truncate-end
 5. voice(hbe/gbe) → hint(dim truncate-end)
 6. simple idle → '→ or enter to start|open'、'ctrl+x to delete|stop'、'? for shortcuts'
 7. 默认宽 footer（ye=' · ' 连接）:
    - dispatch defaults(ti)
    - 'enter <enterLabel>'
    - col≥90 && pasteId: 'paste again to expand'
    - header 聚焦: 'enter expand|collapse'；fold 聚焦: 'enter show all'
    - col≥55: 'space reply'；voice: 'hold space to speak'
    - col≥80: 聚焦 job→'ctrl+x delete'（或 ungroup/delete all 分支）
    - bash:'! for shell mode'(bashBorder) ; query非空:'escape clear' ; 否则:'? for shortcuts'
    - daemon col≥111: 'ctrl+e group'
```

### 8.6 cols（Ic @153064472）✅——行布局权威

```js
function Ic(jobs, ageOf, focusedId, columns){
  age      = Math.max(um, ...jobs.map(T => ie(On(T, ageOf(T)))))            // um 常量下限
  label    = Math.min(Math.max(40, Math.floor(columns/3)),
                      Math.max(12, ...jobs.map(T => ie(wo(T.state, isFocused)))))  // 40 列下限！
  artifact = Math.max(0, ...jobs.map(T => fm(T.state)))                      // PR 宽
  detail   = Math.max(8, columns - (label+2) - 2 - (artifact+2) - (age+2) - 2)
  return {age, label, artifact, detail}
}
```

### 8.7 此前报告的 @212.6M 区——**恢复有效（2026-09-29 勘误）**

**勘误**：早前用文本模式读 binary 得 179,299,667 字节，据此判定 212.6M 偏移不存在——
**这是错误结论**。二进制模式实际 240,902,136 字节（文本模式 UTF-8 多字节折叠了 61MB）。
二进制复核确认：`Da` @212601211、`Cl` @212646407、`il` @212622659、placeholder
@212648398 **全部真实**，且与批次 L 的 header/composer/footer 实现逐项吻合
（唯一例外见下）。教训：**读 binary 必须用二进制模式（'rb'）**。

**勘误后的修正**：Da 的 `de=q(标题, model·cwd)` 是**纵排两行**（q 为 column 容器；
证据：用户截图官方三行结构 + `Pe=column[de,me]` 需 de 为两行才自洽）——
批次 L 误实现为单行，已修正（FleetHeader 三行：标题 / model·cwd / counts）。
q 的 minified 定义跨 chunk 未溯源（渲染语义由截图实证）。

全量导出工具：`scripts/dump-binary-strings.py` → `docs/reverse/`（2138 chunk、
JS 源区 234MB、字符串池 68,211 条——后续逆向先查导出，不再直接读 binary）。

---

## 9. ink 渲染核心对照（284 chunk-6epjwwt0，2026-09-29）

### 9.1 DEC 终端模式层 ✅ 已对齐（b17c0f3c）

官方 `var Cm={...}`（_ALL.js @12417954，362KB ink 核心 chunk-6epjwwt0）：
`CURSOR_VISIBLE:25, ALT_SCREEN:47, ALT_SCREEN_CLEAR:1049, MOUSE_NORMAL:1000,
MOUSE_BUTTON:1002, MOUSE_ANY:1003, MOUSE_SGR:1006, MOUSE_SGR_PIXELS:1016,
FOCUS_EVENTS:1004, BRACKETED_PASTE:2004, THEME_NOTIFY:2031,
SYNCHRONIZED_UPDATE:2026, WIN32_INPUT_MODE:9001`。
cch `termio/dec.ts` 已补 1016/2031/9001 + `mouseTrackingSeq()` 三档（官方
`ZVt(E)`：full→1000+1002+1003+1006、scroll→1000+1006、off→''）；AlternateScreen
接入三档 prop + 2031 主题通知（14f05763）。

### 9.2 渲染器：官方为池化双缓冲代际——cch 是行级 diff ❌ 结构性差异

官方证据（handleResume 切片，_ALL.js @13461xxx 区）：

```
this.frontFrame = ho(height, width, this.stylePool, this.charPool, this.hyperlinkPool)
this.backFrame  = ho(...)
this.log.reset(); this.prevFrameContaminated=!0; this.imagesStale=!0;
this.displayCursor=null; this.nativeCursorVisible=this.accessibilityMode;
this.resetScreenReaderDiffState(); this.scheduleRender()
```

- **双缓冲帧**（frontFrame/backFrame）+ 三对象池（stylePool/charPool/hyperlinkPool）
  ——帧差分在 cell 网格层做，cch log-update 是行字符串 diff
- **StylePool 类**（@13359262）：`{ids:Map, styles:[], transitionCache:Map,
  atlasRecorder, needsCompaction()}`——样式去重 + 转移缓存 + 容量压实
- **终端能力探测状态机**（@13099953）：
  `{extendedKeys, synchronizedOutput, kittyKeyboard, kittyGraphics, mousePixels}`
  五项 DECRQM 异步探测（readings Map，settled/pending 两态）——cch
  terminal-querier.ts 只查 2026 一项
- **Kitty 图形协议**（kittyGraphics 开关 + imagesStale 图片层）——cch 无
- **屏幕阅读器 diff**（resetScreenReaderDiffState）——cch 无

### 9.3 结论与决策点

- 渲染器重写（行 diff → 池化双缓冲 + 能力探测五项 + kitty/图片层）等效重写
  ink 渲染核心（log-update/renderer/reconciler 三层），改动面大——**未实施**，
  待用户决策
- 像素鼠标 1016（mousePixels）接入依赖官方 handoff 流程（mouseOnSeq reassert），
  序列常量已备（dec.ts），状态机待 renderer 对照后接
- 能力探测扩展（extendedKeys/kittyKeyboard/mousePixels 三项加入 querier）是
  低风险增量——可先行

---

## 10. 像素鼠标（1016）接入设计（只读调研，2026-09-29）

证据全部来自 `docs/reverse-284/full-source/_ALL.js`（40,446,725 bytes；偏移为该文件
字节偏移，`@N` 即 `seek(N)`）。ink 核心为 chunk-6epjwwt0（@13.2M-13.56M 区）、
modes 状态机 chunk-8m1123rr（@13.164M 区）、fleet 插件宿主 chunk-6s4zx6py（@24.7M 区）。

### 10.1 序列常量与 modes 登记（@12480515 / @13164000）

```
Cm.MOUSE_SGR_PIXELS:1016
sQr = TN(1016)               // CSI ? 1016 h   开像素
iQr = pW(1016)+TN(1006)      // CSI ? 1016 l + CSI ? 1006 h   关像素、回落 cell SGR
S   = TN(1000)+TN(1002)+TN(1003)+TN(1006)   // ZVt("full")
_   = TN(1000)+TN(1006)                     // ZVt("scroll")
Qoe = pW(1006)+pW(1003)+pW(1002)+pW(1000)   // 鼠标全关
```

modes 优先级表：`{bracketedPaste:0,themeReports:0,extendedKeys:0,altScreen:1,
altScreenKeys:2,mouse:2,mousePixels:2,surface:3,focusEvents:4}`。
`w("mousePixels")={on:sQr,off:iQr}`；`entry("mouse",n)` → `{on:ZVt(o),off:o==="off"?"":Qoe}`。
set 幂等、reset 返回 off、reassert 输出该 entry 的 on、reassertFrom 按优先级 ≥r 重放、
suspend（保留 kept 项）逆序关其余、resume 重放全部 on。

### 10.2 能力探测（DECRQM 1016 + XTWINOPS 16t）

初值（@13163983 `y(e)`）：bgWorker→`{settled:!1}`；tmux/screen（multiplexed）→
`{settled:!1}`；否则 `{likely:!1, source:"env: terminal=…, not asked yet"}`——默认按
"不支持"兜底，等 DECRPM 回答。

探测（@13448300 `tg()`）：

```
D = !b || TERM_PROGRAM==="Apple_Terminal"        // b=XTVERSION 有应答
H = !D && readings.get("mousePixels").state==="pending"
U = H ? send(Aor()) : …   // Aor()={request:Oa("16t"), match:e=>e.type==="cellSize"}
V = H ? send(Cor(Cm.MOUSE_SGR_PIXELS)) : …
  // Cor(e)={request:Oa(`?${e}$p`), match:n=>n.type==="decrpm"&&n.mode===e}
if(U) ig(U)               // ig(n){ if(n.width>0&&n.height>0) CE().cellPixels={width,height} }
if(V) answer("mousePixels", V.status===1||V.status===2||V.status===3,
             `probe: DECRPM 1016 status=${V.status}, cell ${og()}`)
clearTimeout(F); u.deadline()   // pending 项按 likely 兜底 settle
```

要点：Apple_Terminal 或 XTVERSION 无应答→根本不探测（保持 likely:false）；DECRPM
status 0（不认识该模式）→false，status 1/2/3（set/reset/permanently-set）→true；
cell 像素尺寸与 1016 探测同批发出（16t 应答 type=cellSize），`og()` 读到
"size unknown" 也照样 answer。`Ux(n)` 为重探：`send(16t)+flush` → ig → 日志
"Cell size asked again: {w}x{h}px"。`kM()=CE().capabilities`（per-host store），
`now(name)` 返回 settled 值否则默认表值。

### 10.3 syncMousePixels——唯一开关状态机（@13552859）

```js
pixelReportsLive = !1;
mouseReportsInPixels = () => this.pixelReportsLive;
syncMousePixels = () => {
  if (this.isUnmounted) return;
  let n = this.finePointerHolds > 0 && this.altScreenActive
       && this.altScreenMouseTracking === "full"
       && kM().now("mousePixels") && CE().cellPixels !== void 0;
  if (n === this.modes.isSet("mousePixels")) return;
  let u = n ? this.modes.set("mousePixels") : this.modes.reset("mousePixels");
  let f = u !== "" && !this.isHandedOff;
  if (f) this.writeAfterKept(u);
  let m = this.appRef.current?.querier;
  if (f && m && this.holdsRawMode) m.flush().then(() => { this.pixelReportsLive = n });
  else this.pixelReportsLive = n;
  t(`Mouse reports in ${n ? "pixels" : "cells"}`);
};
```

开启必须五条件全真：有 finePointer hold + alt 屏活跃 + 鼠标档位 full + 能力探测
settled-true + cellPixels 已知。live 标志只在序列真正写出且 querier flush 完成后才
翻转（防 backpressure 丢序列导致解析错位）；isHandedOff 时不写不翻。
`modes.isSet` 作真值源，live 只是"下行解析口径"标志。

引用计数 hold（@13522104）：

```js
finePointerHolds = 0;
retainFinePointer = () => {
  this.finePointerHolds++;
  this.cancelFinePointerSettle ??= kM().onSettle("mousePixels", () => this.syncMousePixels());
  this.syncMousePixels();
  return () => { /* n 守卫 */ this.finePointerHolds--; this.syncMousePixels(); };
};
```

第一个 hold 注册 onSettle 监听——探测晚于 UI 挂载时 settle 自动重 sync。
React hook `CEn(o)`（@17237470 区）：`const{retainFinePointer}=use(InternalAppContext);
useEffect(()=>o?retain():void 0,[o,r])`，组件挂载即 hold、卸载释放。

### 10.4 mouseOnSeq 与 alt-screen handoff 全流程（@13528519 区）

- `mouseOnSeq(){ return ZVt(this.altScreenMouseTracking) + this.modes.reassert("mousePixels") }`
  ——cell 跟踪序列后追加 1016 reassert（未 set 时 reassert 返回 ""）。
- **alt 进入**：AlternateScreen effect（@17196882 区）写
  `modes.set("altScreen")+modes.set("mouse",档位)+nativeCursorSeq`；此时 1016 尚未
  开——等 UI 调 retainFinePointer → syncMousePixels 补写。
- **winch/resize**：`syncTerminalSize()` 在 `altScreenActive&&!isHandedOff&&tracking!=="off"`
  时 `write(mouseOnSeq())`（重放 cell+pixel，因为终端 resize 可能重置 DEC 私有模式）；
  `handleWinch=()=>appRef.current?.reprobeCellPixels()`（handleResize 同），重探 16t
  后 `onCellPixels:this.syncMousePixels` 回调重算（cell 尺寸变了，五条件可能翻转）。
- **reprobeCellPixels**（@13451378）：门=`querier!=null&&rawModeEnabledCount>0
  &&!hasReleasedTerminal&&kM().now("mousePixels")`；`cellReprobe` 三态
  `idle/asking/again`，runCellReprobe 完成后若 again 则续跑（合并连发 winch）。
- **SIGCONT**（handleResume @13526966）：modes.isSuspended 时只重置帧；否则
  `reenterAltScreen()` → `modes.reassertFrom("altScreen")`（按优先级重放 alt+mouse+
  mousePixels）。
- **交出终端（编辑器挂起 `$Q` @17495600）**：
  `prepareTerminalForHandoff(){ pause(); write((tracking!=="off"?Qoe:"")+CQe);
  flush; suspendStdin() }`——鼠标全关+焦点关；
  `restoreTerminalAfterHandoff(){ resumeStdin(); write(mouseOnSeq()+XVt); resume() }`
  ——mouseOnSeq 恢复 cell+像素。pause() 即 `isPaused=!0` → `isHandedOff` getter
  （`isPaused||modes.isSuspended||ownTree!==void 0&&Ms().has(stdout)`）为真。
- **daemon/gateway 交接 `handoffAltScreen()`（@13553543 定义 / @17700849 调用）**：
  `isPaused=!0; altScreenActive=!1; endPointerCapture(); tellClickedNowhere();
  modes.reset("altScreen"); modes.reset("surface")`——状态直改+指针捕获清空+
  click 监听者收 (null,null)；随后外层 unmount。序列由 cleanupTerminalModes
  （@17215989）兜底：`write(reset("mousePixels")+Qoe)` 再 `reset("mouse")`——先关
  1016 再关 cell 跟踪，顺序不可反（否则残留 1016 下发 cell 坐标）。
- **backpressure 恢复**（reassertTerminalModes @13553374 区，drain 且丢字节时）：
  `write(DXn + reassert("bracketedPaste")+reassert("extendedKeys")
  +reassert("mouse")+reassert("mousePixels"))`——四连 reassert，含 1016。

### 10.5 解析层：SGR 统一解析 + App 层 px→cell 换算

解析不区分 cell/pixel（@13395565 / @13403400 / @13406910）：

```
cd = /^\x1b\[<(\d+);(-?\d+);(-?\d+)([Mm])$/        // 允许负数（像素 0 基边缘）
rd(n): (f&64)!==0 → null（滚轮让路）；否则 {kind:"mouse",button,action,col,row}
jy(n,u,f,m): (u&67)===64|65 → {kind:"key",name:"wheelup"/"wheeldown",col,row}
```

换算发生在 App 消费层（@13443260 / @13459690）：

```js
Sx = n => ({col:Math.max(1,Math.floor(n.col)+1), row:Math.max(1,Math.floor(n.row)+1), fine:n});
Pd = (n,u,f) => Sx({col:n/f.width, row:u/f.height});      // px → (cell, fine=浮点 cell)
Kx(n,u)  // press/release/.motion：!props.mouseReportsInPixels?.()||cellPixels===void 0 → 原样
         // 否则 {...u, ...Pd(u.col,u.row,CE().cellPixels)}
Yx(n,u)  // wheel 同上
```

即 wire 上 col/row 字段就是原始 px；`mouseReportsInPixels()` 真时除以 cellPixels，
整数部分作 col/row，原始浮点作 `fine`（亚 cell 精度）。dispatch（@13458400）：
`kind==="mouse"` → scroll 档过滤 `(button&3)===0` → `Wx(n, Kx(n,A))`；wheel →
`dispatchWheelEvent(Yx(n,A))`。

fine 传播（@13470091 `Wl` / @13560000）：元素级 onPointer 收
`{localCol,localRow, fine:{col:u.fine.col-floor(x), row:u.fine.row-floor(y)}}`
——fine 是相对元素的浮点 cell 坐标；pointerCapture（down/move/up）与 hover
（门控 altScreenActive）都透传。

### 10.6 消费方（含 fleet）

- **fleet 插件 pane（chunk-6s4zx6py @24721650 区）——确有消费**：
  `F=R&&x.acceptsPointer(); CEn(F)`（pane 接受指针即 hold fine pointer），事件转发
  `x.pointer({type, x:localCol, y:localRow, ...fine&&{fine:{x:fine.col,y:fine.row}}, ...mods})`
  ——外部插件收到 `fine:{x,y}` 浮点 cell 坐标 + onMouseEnter/Leave。
- **面板分隔条拖拽**（@28857150 区 `dx`）：只用整数 col/row（axis/cells/onResize），
  不消费 fine。
- **选择/点击/超链接**（Wx @13459860 区）：用换算后 col/row；`u.fine` 透传给
  onPointerPress/Drag/Release/Hover props（App 级 pointer API）。

### 10.7 cch 接入设计草案

现状：`packages/@ant/ink/src/core/termio/dec.ts` 已备
`DEC.MOUSE_SGR_PIXELS:1016`、`ENABLE/DISABLE/EXIT_MOUSE_PIXELS`（EXIT=iQr 语义）；
`packages/@ant/ink/src/core/terminal-capabilities.ts` 已落 DECRQM 探测（decrpmStatusSupported）。
App.tsx 已有 cell 档鼠标（selection/wheel），无 onPointer/fine 设施。

1. **能力层**（terminal-capabilities.ts）：DECRQM 判定对齐官方只认 status 1|2|3
   （cch 现为 1..4，status 4=permanently reset 官方不启用）；同批复用 querier 发
   `CSI 16 t`（cellSize），存 `{width,height}`；探测门补 Apple_Terminal/XTVERSION
   无应答跳过 + tmux/screen 置 pending-not-asked。结果接入 §9.3 的五项 readings。
2. **新增状态**（ink 实例层）：`pixelReportsLive:boolean`（默认 false）+
   `finePointerHolds:number` + `retainFinePointer():()=>void`。真值源用 modes 登记
   （mousePixels entry，优先级 2），live 仅为解析口径。
3. **切换时机**（syncMousePixels 移植）：开=holds>0 && altScreenActive &&
   tracking==="full" && capability && cellPixels 已知；关序列必须用 EXIT_MOUSE_PIXELS
   （1016l+1006h）；序列写出后等 querier flush 再翻 live；handoff/paused 期间不写。
   触发点：retain/release、能力 settle、alt 进出、resize 重探（cellReprobe
   idle/asking/again 三态）后、SIGCONT reassert、backpressure drain 四连 reassert、
   cleanup 先 1016l 后 Qoe。
4. **解析层**：parse-keypress 无需改（cd 正则已同构，含负数）；在 App.tsx mouse
   分支加 Kx/Yx 等价换算（`Pd(px,py,{width,height})` → col/row+fine），由
   `mouseReportsInPixels()` 门控。
5. **消费方建议**：先落 App 级 `onPointer{Press,Drag,Release,Hover}` + Box
   `onPointer` 元素事件（localCol/localRow/fine），hover 门控 altScreenActive；
   fleet 侧对齐官方 pane 语义——acceptsPointer() 时 hook 持 hold 并把
   `fine:{x,y}` 透传插件；分隔条等 cell 级交互不必迁 fine。低风险起步顺序：
   能力探测（先行）→ 状态机+解析 → onPointer 事件 → fleet pane 透传。

