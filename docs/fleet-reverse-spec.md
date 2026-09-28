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

### 8.7 此前报告的 @212.6M 区（Cl/il/Da "原文"）——**作废**

binary 实际长度 179,299,667 字节，212.6M 偏移不存在；那份报告的"原文切片"为幻觉。
本文档 §8 全部来自 153.0M-153.14M 区已验证锚点。
