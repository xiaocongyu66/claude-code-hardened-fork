import {
  AlternateScreen,
  Box,
  ScrollBox,
  type ScrollBoxHandle,
  Text,
  stringWidth,
  useAnimationFrame,
  useInput,
  useApp,
  useTerminalSize,
} from '@anthropic/ink';
import { useEffect, useRef, useState } from 'react';
import type { Theme, DOMElement } from '@anthropic/ink';
import { FleetRoster } from '../cli/fleet/stores.js';
import { t } from '../i18n/index.js';
import { logEvent } from '../services/analytics/index.js';

/**
 * FleetView —— `cch agents` 的会话列表视图。
 *
 * 对齐官方 `claude agents`（binary 2.1.283 原文实证，批次 J）：
 *   装配：Hp → el(行容器) + Cl(composer) + kl/il(footer) + Da(header)
 *   图标（Tn）：FLEET_GLYPHS=['·','✢','*','✶','✻','✽']，普通态 [4]='✻'、
 *     特殊态 [1]='✢'，终态='∙'(\u2219)；busy 行由 spinner 顶替
 *   spinner（an）：12 帧字符轮转 [...glyphs, ...glyphs.toReversed()]
 *   状态词（rn）：Done(success)/Failed(error)/Stopped(inactive)/
 *     working(无色)/blocked(warning)/Idle(dim)
 *   行布局（Hi）：icon 列固定宽 label+2 → detail 列 flexGrow:1 width:0
 *     paddingLeft:2 → age 列右对齐 width+2
 *   fold（@153104363）：PAST 组 `… show all (N more[ · M failed])`，
 *     其他组 `… N more`
 *   composer（Cl @212646407）：round 上下边框 + ❯ prefix +
 *     placeholder "describe a task for a new session"
 *   footer（il @212622659）：exitPending/armed/renaming 分档 + 宽度分档
 *
 * 明确跳过（数据源不存在）：PR 徽章（无 prStatuses 源）、earlier 行
 * （无持久化 roster 历史源）、childRows、remote tab、groupEditing、
 * 宽屏 logo（ASCII 资产未挖）。
 */

export interface FleetRow {
  shortId: string;
  name: string;
  kind: string;
  cwd: string;
  tempo: 'running' | 'blocked' | 'idle' | 'booked' | 'done' | 'failed' | 'stopped';
  blockedNeeds?: string;
  /** 元数据（对齐 Hi 的 age/extra 列） */
  ageLabel?: string;
  detail?: string;
  /** 日志尾行（active 会话，对齐 Hi 的 logTail） */
  logTail?: string;
  pid?: number;
}

// ── 官方图标与 spinner 体系（Tn/an @153067933 权威） ──

const FLEET_GLYPHS = ['·', '✢', '*', '✶', '✻', '✽'];
/** 12 帧字符轮转（官方 an 的 wc()：[...lt, ...lt.toReversed()]）。 */
const SPINNER_FRAMES = [...FLEET_GLYPHS, ...FLEET_GLYPHS.toReversed()];
/** 普通态图标（官方 xc()[4]）。 */
const GLYPH_ACTIVE = '✻';
/** 特殊态图标（官方 xc()[1]——loop 等谓词命中时）。 */
const GLYPH_SPECIAL = '✢';
/** 终态图标（官方 Nye='\u2219'）。 */
const GLYPH_TERMINAL = '∙';

/** 状态词映射（官方 rn @153064840 语义）。 */
type StatusStyle = { word: string; color: keyof Theme | undefined; dim: boolean };

function statusWord(row: FleetRow): StatusStyle {
  switch (row.tempo) {
    case 'done':
      return { word: 'Done', color: 'success', dim: false };
    case 'failed':
      return { word: 'Failed', color: 'error', dim: false };
    case 'stopped':
      return { word: 'Stopped', color: 'inactive', dim: false };
    case 'running':
      return { word: 'working', color: undefined, dim: false };
    case 'blocked':
      return { word: 'blocked', color: 'warning', dim: false };
    default:
      return { word: 'Idle', color: undefined, dim: true };
  }
}

/** 图标颜色（跟状态走；working 无色，终态 dim）。 */
function glyphColor(row: FleetRow): keyof Theme | undefined {
  switch (row.tempo) {
    case 'running':
      return 'success';
    case 'blocked':
      return 'warning';
    case 'failed':
      return 'error';
    default:
      return undefined;
  }
}

/** 组间官方顺序（state 模式）。 */
const GROUP_ORDER = ['running', 'blocked', 'idle', 'booked', 'done', 'failed', 'stopped'] as const;

const GROUP_TITLE: Record<string, string> = {
  running: 'WORKING',
  blocked: 'BLOCKED — NEEDS YOUR INPUT',
  idle: 'IDLE',
  booked: 'SCHEDULED',
  done: 'PAST',
  failed: 'PAST',
  stopped: 'PAST',
  past: 'PAST',
};

/** 每组折叠上限（官方 Rm=3 语义）。 */
const FOLD_CAP = 3;

/** 相对时间（mostSignificantOnly 语义）。 */
export function relativeAge(ms: number): string {
  if (ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  if (s < 1) return '<1s';
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d`;
  if (d < 30) return `${Math.floor(d / 7)}w`;
  if (d < 365) return `${Math.floor(d / 30)}mo`;
  return `${Math.floor(d / 365)}y`;
}

/** 终端列宽感知 padEnd（CJK 占 2 列）。 */
function padEnd(s: string, n: number): string {
  const w = stringWidth(s);
  return w >= n ? s : s + ' '.repeat(n - w);
}

/** 按终端列宽截断。 */
function truncateWidth(s: string, maxCols: number): string {
  if (maxCols <= 0) return '';
  let cols = 0;
  let out = '';
  for (const ch of s) {
    const cw = stringWidth(ch);
    if (cols + cw > maxCols) break;
    out += ch;
    cols += cw;
  }
  return out;
}

// ── 子组件（对齐官方 an/Hi/Da/il 分层） ──

/**
 * 官方 an()：spinner 帧转。cch 的 useAnimationFrame 参数是 intervalMs
 * （官方 Ea(120) 是 fps 经 alignFrameInterval 对齐——两 API 语义不同，
 * 120ms 节拍等价）。共享时钟、离屏自动暂停。
 */
function Spinner({ active }: { active: boolean }): React.ReactNode {
  const [ref, time] = useAnimationFrame(active ? 120 : null);
  const frame = Math.floor(time / 120) % SPINNER_FRAMES.length;
  return (
    <Box ref={ref}>
      <Text color="success">{SPINNER_FRAMES[frame] ?? SPINNER_FRAMES[0]}</Text>
    </Box>
  );
}

/** launcher cwd（模块级一次——渲染期禁系统调用副作用）。 */
const LAUNCHER_CWD = process.cwd();

/** 官方 Da：标题行 + counts 行 + cwd。 */
function FleetHeader({ data }: { data: FleetRow[] }): React.ReactNode {
  const blocked = data.filter(r => r.tempo === 'blocked').length;
  const working = data.filter(r => r.tempo === 'running').length;
  const completed = data.filter(r => r.tempo === 'done' || r.tempo === 'failed' || r.tempo === 'stopped').length;
  const hasLive = data.some(r => r.tempo !== 'done' && r.tempo !== 'failed' && r.tempo !== 'stopped');
  const cwd = truncateWidth(LAUNCHER_CWD, 44);
  return (
    <Box flexDirection="column">
      <Box>
        <Text bold>Claude Code</Text>
        <Text dimColor>{` v${MACRO.VERSION}`}</Text>
        <Text dimColor>{` · ${cwd}`}</Text>
        {hasLive ? <Text dimColor> · live</Text> : null}
      </Box>
      <Text dimColor>
        {data.length === 0
          ? t('nothing running')
          : t('{{blocked}} awaiting input · {{working}} working · {{completed}} completed', {
              blocked,
              working,
              completed,
            })}
      </Text>
    </Box>
  );
}

interface FleetLine {
  kind: 'header' | 'job' | 'fold' | 'newsession';
  group?: string;
  row?: FleetRow;
  hidden?: number;
}

/** 官方 Hi：单行渲染（固定列：icon 列宽 → detail 弹性 → age 右对齐）。 */
function JobLine({
  row,
  selected,
  armed,
  renaming,
  labelCol,
  ageCol,
  registerRef,
}: {
  row: FleetRow;
  selected: boolean;
  armed: boolean;
  renaming: { draft: string } | undefined;
  labelCol: number;
  ageCol: number;
  registerRef: (id: string, el: DOMElement | null) => void;
}): React.ReactNode {
  const st = statusWord(row);
  const spinning = row.tempo === 'running';
  const glyph = row.tempo === 'running' ? null : GLYPH_TERMINAL;
  const gColor = glyphColor(row);
  // 官方 Hi 的 ct detail 链：needs 优先 → blocked 无 needs 用 cwd →
  // running 用 logTail → 否则 state.detail（cwd 不是常驻列）
  const detailText =
    row.tempo === 'blocked' && row.blockedNeeds
      ? row.blockedNeeds
      : row.tempo === 'blocked'
        ? row.cwd
        : row.logTail && row.tempo === 'running'
          ? `$ ${row.logTail}`
          : row.detail;
  return (
    <Box ref={el => registerRef(row.shortId, el)} paddingLeft={1}>
      {/* icon+label 列（官方 [指针, 图标, 2空格, 名字]，width=cols.label+2） */}
      <Box width={labelCol + 2} flexShrink={0}>
        <Text color={selected ? 'suggestion' : undefined}>{selected ? '❯' : ' '}</Text>
        {spinning ? (
          <Spinner active />
        ) : (
          <Text color={gColor} dimColor={row.tempo !== 'running' && row.tempo !== 'blocked' && row.tempo !== 'failed'}>
            {glyph ?? GLYPH_ACTIVE}
          </Text>
        )}
        <Text> </Text>
        {renaming ? (
          <Text bold={selected}>
            {renaming.draft}
            <Text color="suggestion">|</Text>
          </Text>
        ) : (
          <Text bold={selected} wrap="truncate">
            {truncateWidth(row.name, labelCol - 4)}
          </Text>
        )}
      </Box>
      {/* detail 列：flexGrow:1 width:0 paddingLeft:2（官方弹性列） */}
      <Box flexGrow={1} width={0} paddingLeft={2} flexShrink={1}>
        {armed ? (
          <Text color="error" wrap="truncate">
            {t('ctrl+x again to delete')}
          </Text>
        ) : (
          <>
            <Text color={st.color} dimColor={st.dim}>
              {t(st.word)}
            </Text>
            {detailText ? <Text dimColor> · {truncateWidth(detailText, 48)}</Text> : null}
          </>
        )}
      </Box>
      {/* age 列：右对齐（官方 width=cols.age+2 justifyContent:'flex-end'） */}
      <Box width={ageCol + 2} paddingLeft={2} justifyContent="flex-end" flexShrink={0}>
        <Text dimColor>{row.ageLabel ?? ''}</Text>
      </Box>
    </Box>
  );
}

/** 官方 helpOpen：两列键位覆盖层（absolute 覆盖，消文档流闪烁）。 */
function FleetHelp(): React.ReactNode {
  const rows: Array<[string, string]> = [
    ['↑↓ / j k', t('move selection')],
    ['g / G', t('jump to top / bottom')],
    ['alt+1-9', t('open Nth session')],
    ['↵', t('open session / expand fold')],
    ['n', t('focus dispatch input')],
    ['ctrl+r', t('rename session')],
    ['ctrl+x', t('stop session (press twice)')],
    ['wheel', t('scroll list')],
    ['esc / q', t('quit')],
  ];
  // 两列布局（官方 paddingX:2 两两一行）
  const pairs: Array<Array<[string, string]>> = [];
  for (let i = 0; i < rows.length; i += 2) pairs.push(rows.slice(i, i + 2));
  return (
    <Box
      position="absolute"
      width="100%"
      height="100%"
      flexDirection="column"
      justifyContent="center"
      alignItems="center"
    >
      <Box flexDirection="column" borderStyle="round" borderColor="promptBorder" paddingX={2} paddingY={1}>
        {pairs.map(pair => (
          <Box key={pair[0]![0]}>
            <Box width={28}>
              <Text color="suggestion">{pair[0]![0]}</Text>
              <Text> </Text>
              <Text>{pair[0]![1]}</Text>
            </Box>
            {pair[1] ? (
              <>
                <Box width={18}>
                  <Text color="suggestion">{pair[1]![0]}</Text>
                </Box>
                <Text>{pair[1]![1]}</Text>
              </>
            ) : null}
          </Box>
        ))}
      </Box>
    </Box>
  );
}

export function FleetView({
  rows,
  loadRows,
  onAttach,
  onKill,
  onRename,
  onDispatch,
  hint,
}: {
  rows: FleetRow[];
  /** 提供则经 FleetRoster 引用计数驱动 2s 轮询刷新 */
  loadRows?: () => Promise<FleetRow[]>;
  onAttach?: (row: FleetRow) => void;
  /** ctrl+x 两段式的执行端（缺省不启用） */
  onKill?: (row: FleetRow) => void;
  /** ctrl+r 重命名的执行端（缺省不启用） */
  onRename?: (row: FleetRow, name: string) => void;
  /** composer dispatch 提交端（缺省不启用） */
  onDispatch?: (task: string) => void;
  /** 底部一次性提示（错误/信息） */
  hint?: string;
}): React.ReactNode {
  const { exit } = useApp();
  const { columns } = useTerminalSize();
  const [selected, setSelected] = useState(0);
  const [killArmed, setKillArmed] = useState<string | null>(null);
  const [live, setLive] = useState<FleetRow[] | null>(null);
  const [renaming, setRenaming] = useState<{ shortId: string; draft: string } | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const [composerDraft, setComposerDraft] = useState<string | null>(null);
  const [dispatching, setDispatching] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [renameError, setRenameError] = useState<string | null>(null);
  const [exitPending, setExitPending] = useState(false);
  const scrollRef = useRef<ScrollBoxHandle>(null);
  const rowRefs = useRef(new Map<string, DOMElement>());

  // FleetRoster（官方 Gd）：attachView 引用计数驱动轮询节拍
  const rosterRef = useRef<InstanceType<typeof FleetRoster> | null>(null);
  useEffect(() => {
    if (!loadRows) return undefined;
    if (!rosterRef.current) rosterRef.current = new FleetRoster();
    const roster = rosterRef.current;
    const unsub = roster.subscribe(() => {
      loadRows()
        .then(r => setLive(r))
        .catch(() => {});
    });
    const detach = roster.attachView(2000);
    return () => {
      unsub();
      detach();
    };
  }, [loadRows]);

  const data = live ?? rows;
  const rowCount = data.length;

  useEffect(() => {
    if (killArmed === null) return undefined;
    const timer = setTimeout(() => setKillArmed(null), 2000);
    return () => clearTimeout(timer);
  }, [killArmed]);

  useEffect(() => {
    if (!exitPending) return undefined;
    const timer = setTimeout(() => setExitPending(false), 2000);
    return () => clearTimeout(timer);
  }, [exitPending]);

  // dispatching 提示的自动清除（卸载安全 + 重复提交重置）
  useEffect(() => {
    if (!dispatching) return undefined;
    const timer = setTimeout(() => setDispatching(false), 3000);
    return () => clearTimeout(timer);
  }, [dispatching]);

  // 可聚焦序列（header 不可聚焦；终态合并 PAST 组）
  const lines: FleetLine[] = [];
  const PAST_TEMPOS = ['done', 'failed', 'stopped'] as const;
  for (const g of GROUP_ORDER) {
    if ((PAST_TEMPOS as readonly string[]).includes(g)) continue;
    const items = data.filter(r => r.tempo === g);
    if (items.length === 0) continue;
    lines.push({ kind: 'header', group: g });
    if (items.length > FOLD_CAP && !expanded.has(g)) {
      for (const row of items.slice(0, FOLD_CAP)) lines.push({ kind: 'job', row });
      lines.push({ kind: 'fold', group: g, hidden: items.length - FOLD_CAP });
    } else {
      for (const row of items) lines.push({ kind: 'job', row });
    }
  }
  const pastItems = data.filter(r => (PAST_TEMPOS as readonly string[]).includes(r.tempo));
  if (pastItems.length > 0) {
    lines.push({ kind: 'header', group: 'past' });
    if (pastItems.length > FOLD_CAP && !expanded.has('past')) {
      for (const row of pastItems.slice(0, FOLD_CAP)) lines.push({ kind: 'job', row });
      lines.push({ kind: 'fold', group: 'past', hidden: pastItems.length - FOLD_CAP });
    } else {
      for (const row of pastItems) lines.push({ kind: 'job', row });
    }
  }
  lines.push({ kind: 'newsession' });

  const focusable = lines.filter(l => l.kind !== 'header');
  const focusCount = focusable.length;

  useEffect(() => {
    if (selected >= focusCount) setSelected(Math.max(0, focusCount - 1));
  }, [focusCount, selected]);

  const focusedLine = focusable[selected];
  const focusedRow = focusedLine?.kind === 'job' ? focusedLine.row : undefined;

  // 选中跟随（官方 el 的 scrollToElement block:nearest 语义）
  useEffect(() => {
    if (!focusedRow) return;
    const el = rowRefs.current.get(focusedRow.shortId);
    if (el) scrollRef.current?.scrollToElement(el, 0);
  }, [selected, focusedRow?.shortId]);

  const registerRef = (id: string, el: DOMElement | null) => {
    if (el) rowRefs.current.set(id, el);
    else rowRefs.current.delete(id);
  };

  const submitRename = () => {
    if (!renaming) return;
    const target = data.find(r => r.shortId === renaming.shortId);
    const draft = renaming.draft.trim();
    if (target && draft) {
      const clash = data.some(r => r.shortId !== renaming.shortId && r.name === draft);
      if (clash) {
        setRenameError(`(name taken) ${draft}`);
        return;
      }
      onRename?.(target, draft);
      logEvent('fleet_view_rename', {});
    }
    setRenaming(null);
    setRenameError(null);
  };

  const submitDispatch = () => {
    if (!composerDraft) return;
    const task = composerDraft.trim();
    if (!task) {
      setComposerDraft(null);
      return;
    }
    setDispatching(true);
    setComposerDraft(null);
    onDispatch?.(task);
    logEvent('fleet_view_dispatch', {});
  };

  useInput(
    (
      input: string,
      key: {
        upArrow?: boolean;
        downArrow?: boolean;
        return?: boolean;
        escape?: boolean;
        ctrl?: boolean;
        alt?: boolean;
        backspace?: boolean;
        delete?: boolean;
        wheelUp?: boolean;
        wheelDown?: boolean;
      },
    ) => {
      // ── 帮助面板 ──
      if (helpOpen) {
        if (key.escape || input === '?' || input === 'q') setHelpOpen(false);
        return;
      }
      // ── 重命名态 ──
      if (renaming) {
        if (key.escape) {
          setRenaming(null);
          setRenameError(null);
        } else if (key.return) {
          submitRename();
        } else if (key.backspace || key.delete) {
          setRenaming(r => (r ? { ...r, draft: r.draft.slice(0, -1) } : r));
        } else if (input.length === 1 && !key.ctrl && input >= ' ') {
          setRenaming(r => (r ? { ...r, draft: r.draft + input } : r));
        }
        return;
      }
      // ── composer 输入态 ──
      if (composerDraft !== null) {
        if (key.escape) {
          setComposerDraft(null);
        } else if (key.return) {
          submitDispatch();
        } else if (key.backspace || key.delete) {
          setComposerDraft(d => (d ? d.slice(0, -1) : d));
        } else if (input.length === 1 && !key.ctrl && input >= ' ') {
          setComposerDraft(d => (d ?? '') + input);
        }
        return;
      }
      // ── wheel 滚动（官方 onWheel→scrollBy(±3)）──
      if (key.wheelUp) {
        scrollRef.current?.scrollBy(-3);
        return;
      }
      if (key.wheelDown) {
        scrollRef.current?.scrollBy(3);
        return;
      }
      // ── ctrl+c 两段退出（官方 exitPending）──
      if (key.ctrl && input === 'c') {
        if (exitPending) exit();
        else setExitPending(true);
        return;
      }
      // ── 列表导航 ──
      if (input === 'j' || key.downArrow) {
        setKillArmed(null);
        setSelected(s => Math.min(focusCount - 1, s + 1));
      } else if (input === 'k' || key.upArrow) {
        setKillArmed(null);
        setSelected(s => Math.max(0, s - 1));
      } else if (input === 'g') {
        setSelected(0);
      } else if (input === 'G') {
        setSelected(focusCount - 1);
      } else if (key.alt && /^[1-9]$/.test(input)) {
        // 官方 alt+1-N：直接打开第 N 个可聚焦 job
        const jobs = focusable.filter(l => l.kind === 'job');
        const target = jobs[Number(input) - 1];
        if (target?.row && onAttach) {
          onAttach(target.row);
          exit();
        }
      } else if (key.ctrl && input === 'r' && focusedRow) {
        setKillArmed(null);
        setRenameError(null);
        setRenaming({ shortId: focusedRow.shortId, draft: focusedRow.name });
      } else if (key.ctrl && input === 'x' && focusedRow) {
        if (killArmed === focusedRow.shortId) {
          setKillArmed(null);
          onKill?.(focusedRow);
          logEvent('fleet_view_kill', {});
        } else {
          setKillArmed(focusedRow.shortId);
        }
      } else if (input === '?') {
        setHelpOpen(true);
      } else if (input === 'n') {
        setComposerDraft('');
      } else if (key.return && focusedLine) {
        if (focusedLine.kind === 'job' && focusedLine.row && onAttach) {
          onAttach(focusedLine.row);
          exit();
        } else if (focusedLine.kind === 'fold' && focusedLine.group) {
          setExpanded(prev => {
            const next = new Set(prev);
            next.add(focusedLine.group!);
            return next;
          });
          logEvent('fleet_view_fold_expand', { hidden: focusedLine.hidden ?? 0 });
        } else if (focusedLine.kind === 'newsession') {
          setComposerDraft('');
        }
      } else if (key.escape || input === 'q') {
        // 两段退出（footer 文案 press ... again to exit 的行为一致性）
        if (exitPending) exit();
        else setExitPending(true);
      }
    },
  );

  // ── 空态 ──
  if (rowCount === 0 && composerDraft === null && !dispatching) {
    return (
      <AlternateScreen>
        <Box flexDirection="column" paddingX={1} paddingY={1}>
          <Box>
            <Text bold>Claude Code</Text>
            <Text dimColor>{` v${MACRO.VERSION}`}</Text>
          </Box>
          <Box marginTop={1} paddingLeft={1} flexDirection="column">
            <Text bold>{t('Nothing running in the background.')}</Text>
            <Text dimColor>
              {t('Hand off a task and it keeps working while you do something else — even if you close this terminal.')}
            </Text>
            <Box marginTop={1} flexDirection="column">
              <Text dimColor>
                {t('Start one with')} <Text color="suggestion">{t('+ new session')}</Text>
                {t(' in the full view,')}
              </Text>
              <Text dimColor>
                {t('or run')} <Text color="suggestion">claude --bg &quot;task&quot;</Text>
                {t(' from any terminal,')}
              </Text>
              <Text dimColor>
                {t('or')} <Text color="suggestion">/fork</Text>
                {t(" a session you're already in.")}
              </Text>
            </Box>
          </Box>
          <Box marginTop={1}>
            <Text dimColor>{t(' ↑↓ select · n dispatch · ? help · esc quit')}</Text>
          </Box>
        </Box>
      </AlternateScreen>
    );
  }

  // 官方 cols.label = 指针+图标+2空格+名的整列宽（名字截断 24）
  const labelCol = Math.max(...data.map(r => stringWidth(truncateWidth(r.name, 24))), 8) + 4;
  const ageCol = Math.max(...data.map(r => stringWidth(r.ageLabel ?? '')), 4);
  // footer 分档（官方 il 优先级链）
  const footerText = exitPending
    ? `${t('press ctrl+c or q again to exit')} · ${t('{{count}} agents will keep running', { count: data.filter(r => r.tempo === 'running' || r.tempo === 'blocked').length })}`
    : killArmed
      ? t('ctrl+x again to delete · esc to keep')
      : renaming
        ? t('enter save · escape cancel')
        : composerDraft !== null
          ? t('enter to dispatch · esc to cancel')
          : null;

  return (
    <AlternateScreen>
      <Box flexDirection="column" paddingX={1} paddingY={1} flexGrow={1}>
        <FleetHeader data={data} />

        <ScrollBox ref={scrollRef} flexDirection="column" flexGrow={1} flexShrink={1} marginTop={1}>
          {lines.map((line, idx) => {
            if (line.kind === 'header') {
              return (
                <Box key={`h:${line.group}`} marginTop={idx === 0 ? 0 : 1}>
                  <Text bold color="subtle">
                    {' '}
                    {t(GROUP_TITLE[line.group!])} (
                    {line.group === 'past'
                      ? data.filter(r => (['done', 'failed', 'stopped'] as string[]).includes(r.tempo)).length
                      : data.filter(r => r.tempo === line.group).length}
                    )
                  </Text>
                </Box>
              );
            }
            if (line.kind === 'fold') {
              const sel = focusable.indexOf(line) === selected;
              const isPast = line.group === 'past';
              const failedHidden = isPast
                ? data.filter(r => r.tempo === 'failed').length -
                  Math.min(FOLD_CAP, data.filter(r => r.tempo === 'failed').length)
                : 0;
              const label = isPast
                ? `… ${t('show all ({{count}} more{{failed}})', { count: line.hidden ?? 0, failed: failedHidden > 0 ? ` · ${failedHidden} ${t('failed')}` : '' })}`
                : t('… {{count}} more', { count: line.hidden ?? 0 });
              return (
                <Box key={`f:${line.group}`} paddingLeft={1}>
                  <Text color={sel ? 'suggestion' : 'subtle'}>{sel ? '❯ ' : '  '}</Text>
                  <Text dimColor>{label}</Text>
                </Box>
              );
            }
            if (line.kind === 'newsession') {
              const sel = focusable.indexOf(line) === selected;
              return (
                <Box key="newsession" marginTop={1} paddingLeft={1} backgroundColor={sel ? 'selectionBg' : undefined}>
                  <Text color={sel ? 'suggestion' : 'subtle'}>{sel ? '❯ ' : '  '}</Text>
                  <Text color="suggestion">{t('+ new session')}</Text>
                  <Text dimColor>{` · ${t('enter to type a task')}`}</Text>
                </Box>
              );
            }
            const row = line.row!;
            const sel = focusable.indexOf(line) === selected;
            return (
              <JobLine
                key={row.shortId}
                row={row}
                selected={sel}
                armed={killArmed === row.shortId}
                renaming={renaming?.shortId === row.shortId ? { draft: renaming.draft } : undefined}
                labelCol={labelCol}
                ageCol={ageCol}
                registerRef={registerRef}
              />
            );
          })}
        </ScrollBox>

        {/* composer（官方 Cl：round 上下边框 + ❯ prefix + placeholder） */}
        {composerDraft !== null ? (
          <Box
            marginTop={1}
            borderStyle="round"
            borderLeft={false}
            borderRight={false}
            borderBottom={false}
            borderColor="promptBorder"
            paddingX={1}
          >
            <Text color="suggestion">❯ </Text>
            {composerDraft ? (
              <Text>
                {composerDraft}
                <Text color="suggestion">|</Text>
              </Text>
            ) : (
              <Text dimColor>{t('describe a task for a new session')}|</Text>
            )}
          </Box>
        ) : null}
        {dispatching ? (
          <Box marginTop={1} paddingLeft={1}>
            <Text color="suggestion">{t('Dispatching…')}</Text>
          </Box>
        ) : null}
        {renameError ? (
          <Box marginTop={1} paddingLeft={1}>
            <Text color="error">{renameError}</Text>
          </Box>
        ) : null}

        {/* footer（官方 il 分档） */}
        <Box marginTop={1}>
          {hint ? <Text color="warning"> {hint}</Text> : null}
          {footerText ? (
            <Text dimColor> {footerText}</Text>
          ) : (
            <Text dimColor>
              {columns >= 80
                ? t(' ↑↓ select · ↵ open · n dispatch · ctrl+r rename · ctrl+x stop · ? help · esc quit')
                : t(' ↑↓ select · ↵ open · n dispatch · esc quit')}
            </Text>
          )}
        </Box>

        {helpOpen ? <FleetHelp /> : null}
      </Box>
    </AlternateScreen>
  );
}

/** 从 SessionEntry 装配 FleetRow（tempo 推断 + age 计算，对齐 Hp 的 roster）。 */
export function toFleetRows(
  sessions: Array<{
    sessionId: string;
    kind: string;
    name?: string;
    cwd: string;
    status?: string;
    waitingFor?: string;
    startedAt?: number;
    updatedAt?: number;
    logPath?: string;
    pid?: number;
    terminalOutcome?: string;
    terminalAt?: number;
  }>,
): FleetRow[] {
  const now = Date.now();
  return sessions.map(s => {
    let tempo: FleetRow['tempo'] = 'running';
    if (s.terminalOutcome === 'completed') tempo = 'done';
    else if (s.terminalOutcome === 'failed' || s.terminalOutcome === 'crashed') tempo = 'failed';
    else if (s.terminalOutcome) tempo = 'stopped';
    else if (s.waitingFor) tempo = 'blocked';
    else if (s.status === 'idle') tempo = 'idle';
    const base =
      (tempo === 'done' || tempo === 'failed' || tempo === 'stopped'
        ? (s.terminalAt ?? s.updatedAt)
        : (s.updatedAt ?? s.startedAt)) ?? now;
    return {
      shortId: s.sessionId.slice(0, 8),
      name: s.name ?? s.sessionId,
      kind: s.kind,
      cwd: s.cwd,
      tempo,
      blockedNeeds: s.waitingFor,
      detail:
        tempo === 'done' || tempo === 'failed' || tempo === 'stopped'
          ? s.terminalOutcome
          : s.status && s.status !== 'idle'
            ? s.status
            : undefined,
      ageLabel: relativeAge(now - base),
      pid: s.pid,
    };
  });
}
