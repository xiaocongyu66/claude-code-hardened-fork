import {
  AlternateScreen,
  Box,
  ScrollBox,
  type ScrollBoxHandle,
  Text,
  useAnimationFrame,
  useInput,
  useApp,
} from '@anthropic/ink';
import { useEffect, useRef, useState } from 'react';
import { t } from '../i18n/index.js';
import { logEvent } from '../services/analytics/index.js';

/**
 * FleetView —— `cch agents` 的会话列表视图。
 *
 * 完整还原官方 `claude agents`（binary 2.1.283 逆向实证）：
 *   装配：mountFleetViewWithComposerBack → JJn → Hp（主组件）
 *   行类型（el 的 Ve）：header / fold / newsession / earlier / job
 *   job 行（Hi）：[tempo图标] [名称粗体] — [状态词+详情] [相对时间]
 *   tempo 图标（Tn）：working spinner / blocked ◐ / idle ○ / stopped ⏹ / failure ✗
 *   分组（state 模式，fleetViewGroupMode ?? 'state'）组间按官方顺序
 *   两段式删除（deleteArmed）：ctrl+x → armed 2s → 再次 ctrl+x 执行
 *   ctrl+r renaming / ? helpOpen / composer dispatch
 *
 * 明确跳过（数据源不存在）：PR 徽章（无 prStatuses 源）、earlier 行
 * （listLiveSessions 只报活进程）、childRows（SessionEntry 无 children）、
 * local/remote tab、groupEditing（roster 无 group 字段）。
 */

export interface FleetRow {
  shortId: string;
  name: string;
  kind: string;
  cwd: string;
  tempo: 'running' | 'blocked' | 'idle' | 'booked';
  blockedNeeds?: string;
  /** 元数据（对齐 Hi 的 age/extra 列） */
  ageLabel?: string;
  detail?: string;
  /** 日志尾行（active 会话，对齐 Hi 的 logTail） */
  logTail?: string;
  pid?: number;
}

type TempoColor = 'success' | 'warning' | 'subtle';

const TEMPO_STYLE: Record<FleetRow['tempo'], { label: string; color: TempoColor }> = {
  running: { label: 'working', color: 'success' },
  blocked: { label: 'blocked', color: 'warning' },
  idle: { label: 'idle', color: 'subtle' },
  booked: { label: 'scheduled', color: 'subtle' },
};

/** 组间官方顺序（state 模式）。 */
const GROUP_ORDER = ['running', 'blocked', 'idle', 'booked'] as const;
const GROUP_TITLE: Record<string, string> = {
  running: 'WORKING',
  blocked: 'BLOCKED — NEEDS YOUR INPUT',
  idle: 'IDLE',
  booked: 'SCHEDULED',
};

/** 每组折叠上限（官方 Rm=3 语义：超出折叠为 `… N more`）。 */
const FOLD_CAP = 3;

/** spinner 帧序列（官方 an()/wc() 同族 braille，120ms 轮转）。 */
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

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

function padEnd(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

function colorFor(row: FleetRow): TempoColor {
  if (row.detail?.startsWith('failure')) return 'warning';
  return TEMPO_STYLE[row.tempo]!.color;
}

/** tempo 图标（Tn 语义：running 用 spinner 顶替）。 */
function glyphFor(row: FleetRow, spinnerFrame: string): string {
  if (row.detail?.startsWith('failure')) return '✗';
  switch (row.tempo) {
    case 'running':
      return spinnerFrame;
    case 'blocked':
      return '◐';
    case 'idle':
      return '○';
    case 'booked':
      return '◔';
  }
}

// ── 子组件（对齐官方 Da/Hi/an/il 分层）──

/** 官方 an()：120ms 帧转 spinner（共享时钟，离屏自动暂停）。 */
function Spinner({ active }: { active: boolean }): React.ReactNode {
  const [ref, time] = useAnimationFrame(active ? 120 : null);
  const frame = Math.floor(time / 120) % SPINNER_FRAMES.length;
  return (
    <Box ref={ref}>
      <Text color="success">{SPINNER_FRAMES[frame] ?? SPINNER_FRAMES[0]}</Text>
    </Box>
  );
}

/** 官方 Da：标题行 + counts 行。 */
function FleetHeader({ data }: { data: FleetRow[] }): React.ReactNode {
  const blocked = data.filter(r => r.tempo === 'blocked').length;
  const working = data.filter(r => r.tempo === 'running').length;
  const idle = data.filter(r => r.tempo === 'idle' || r.tempo === 'booked').length;
  return (
    <Box flexDirection="column">
      <Box>
        <Text bold>Claude Code</Text>
        <Text dimColor>{` v${MACRO.VERSION}`}</Text>
        <Text dimColor>
          {' '}
          — {data.length} session{data.length === 1 ? '' : 's'}
        </Text>
        {data.length > 0 ? <Text dimColor> · live</Text> : null}
      </Box>
      <Text dimColor>
        {t('{{blocked}} awaiting input · {{working}} working · {{idle}} idle', {
          blocked,
          working,
          idle,
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

/** 官方 Hi：单行渲染（icon/名/状态词/detail/age/logTail/cwd/armed 态）。 */
function JobLine({
  row,
  selected,
  armed,
  renaming,
  spinnerActive,
  nameWidth,
  detailWidth,
}: {
  row: FleetRow;
  selected: boolean;
  armed: boolean;
  renaming: { draft: string } | undefined;
  spinnerActive: boolean;
  nameWidth: number;
  detailWidth: number;
}): React.ReactNode {
  const ts = TEMPO_STYLE[row.tempo]!;
  const detail = row.blockedNeeds ?? row.detail;
  return (
    <Box paddingLeft={1}>
      <Text color={selected ? 'suggestion' : 'subtle'}>{selected ? '❯ ' : '  '}</Text>
      {spinnerActive ? <Spinner active /> : <Text color={colorFor(row)}>{glyphFor(row, '●')}</Text>}
      <Text> </Text>
      {renaming ? (
        <Text>
          {renaming.draft}
          <Text color="suggestion">|</Text>
        </Text>
      ) : (
        <Text bold={selected}>{padEnd(row.name.slice(0, 24), nameWidth)}</Text>
      )}
      <Text> </Text>
      <Text color={ts.color} dimColor={row.tempo === 'idle'}>
        {ts.label}
      </Text>
      {detail ? <Text dimColor>{` · ${detail}`.slice(0, detailWidth + 3)}</Text> : null}
      {row.logTail && row.tempo === 'running' ? (
        <Text dimColor>{`  $ ${row.logTail}`.slice(0, 60)}</Text>
      ) : (
        <Text dimColor>{`  ${row.ageLabel ?? ''}`}</Text>
      )}
      <Text dimColor>{`  ${row.cwd}`}</Text>
      {armed ? <Text color="error"> · {t('ctrl+x again to delete')}</Text> : null}
    </Box>
  );
}

/** 官方 helpOpen：键位表覆盖层。 */
function FleetHelp(): React.ReactNode {
  const rows: Array<[string, string]> = [
    ['↑↓ / j k', t('move selection')],
    ['↵', t('open session / expand fold')],
    ['n', t('focus dispatch input')],
    ['ctrl+r', t('rename session')],
    ['ctrl+x', t('stop session (press twice)')],
    ['esc / q', t('quit')],
  ];
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="promptBorder" paddingX={2} paddingY={1}>
      {rows.map(([k, d]) => (
        <Box key={k}>
          <Box width={22}>
            <Text color="suggestion">{k}</Text>
          </Box>
          <Text>{d}</Text>
        </Box>
      ))}
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
  /** 提供则每 2s 轮询刷新（对齐官方 JJn 循环的 roster 持续订阅） */
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
  const [selected, setSelected] = useState(0);
  const [killArmed, setKillArmed] = useState<string | null>(null);
  const [live, setLive] = useState<FleetRow[] | null>(null);
  const [renaming, setRenaming] = useState<{ shortId: string; draft: string } | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const [composerDraft, setComposerDraft] = useState<string | null>(null);
  const [dispatching, setDispatching] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [renameError, setRenameError] = useState<string | null>(null);
  const scrollRef = useRef<ScrollBoxHandle>(null);

  useEffect(() => {
    if (!loadRows) return undefined;
    let cancelled = false;
    const poll = () => {
      loadRows()
        .then(r => {
          if (!cancelled) setLive(r);
        })
        .catch(() => {});
    };
    const timer = setInterval(poll, 2000);
    void poll();
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [loadRows]);

  const data = live ?? rows;
  const rowCount = data.length;

  useEffect(() => {
    if (killArmed === null) return undefined;
    const timer = setTimeout(() => setKillArmed(null), 2000);
    return () => clearTimeout(timer);
  }, [killArmed]);

  // 可聚焦序列（官方 Ve rows 语义：header 不可聚焦，job/fold/newsession 可聚焦）
  const lines: FleetLine[] = [];
  for (const g of GROUP_ORDER) {
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
  lines.push({ kind: 'newsession' });

  const focusable = lines.filter(l => l.kind !== 'header');
  const focusCount = focusable.length;

  useEffect(() => {
    if (selected >= focusCount) setSelected(Math.max(0, focusCount - 1));
  }, [focusCount, selected]);

  const focusedLine = focusable[selected];
  const focusedRow = focusedLine?.kind === 'job' ? focusedLine.row : undefined;

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
    // 轮询会在新会话注册后自动带上；提示由调用方通过 hint 反馈
    setTimeout(() => setDispatching(false), 3000);
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
        backspace?: boolean;
        delete?: boolean;
      },
    ) => {
      // ── 帮助面板：优先级最高 ──
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
      // ── 列表导航 ──
      if (input === 'j' || key.downArrow) {
        setKillArmed(null);
        setSelected(s => Math.min(focusCount - 1, s + 1));
        scrollRef.current?.scrollBy(1);
      } else if (input === 'k' || key.upArrow) {
        setKillArmed(null);
        setSelected(s => Math.max(0, s - 1));
        scrollRef.current?.scrollBy(-1);
      } else if (key.ctrl && input === 'r' && focusedRow) {
        // 官方 ctrl+r renaming
        setKillArmed(null);
        setRenameError(null);
        setRenaming({ shortId: focusedRow.shortId, draft: focusedRow.name });
      } else if (key.ctrl && input === 'x' && focusedRow) {
        // 官方 deleteArmed：第一次 armed，第二次执行
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
          // 官方 fold 展开（遥测 tengu_fleetview_fold_expand）
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
        exit();
      }
    },
  );

  // ── 空态（官方空态引导文案）──
  if (rowCount === 0 && composerDraft === null && !dispatching) {
    return (
      <AlternateScreen>
        <Box flexDirection="column" paddingX={1} paddingY={1}>
          <Box>
            <Text bold>Claude Code</Text>
            <Text dimColor>{` v${MACRO.VERSION}`}</Text>
            <Text dimColor> agents</Text>
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
                {t('or run')} <Text color="suggestion">{t('claude --bg "task"')}</Text>
                {t(' from any terminal,')}
              </Text>
              <Text dimColor>
                {t('or')} <Text color="suggestion">{t('/fork')}</Text>
                {t(" a session you're already in.")}
              </Text>
            </Box>
          </Box>
          {composerDraft !== null ? (
            <Box marginTop={1} paddingLeft={1}>
              <Text color="suggestion">{'> '}</Text>
              <Text>
                {composerDraft}
                <Text color="suggestion">|</Text>
              </Text>
              <Text dimColor>{` · ${t('enter to dispatch · esc to cancel')}`}</Text>
            </Box>
          ) : null}
          <Box marginTop={1}>
            <Text dimColor>{t(' ↑↓ select · n dispatch · ctrl+x stop · ? help · esc quit')}</Text>
          </Box>
        </Box>
      </AlternateScreen>
    );
  }

  const nameWidth = Math.max(...data.map(r => r.name.slice(0, 24).length), 8);
  const detailWidth = Math.max(...data.map(r => (r.blockedNeeds ?? r.detail ?? '').length), 12);
  const spinnerActive = focusedRow?.tempo === 'running';

  return (
    // 全屏（对齐官方 JJn：alt screen + 视口高度约束 + 内部滚动）
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
                    {t(GROUP_TITLE[line.group!])} ({data.filter(r => r.tempo === line.group).length})
                  </Text>
                </Box>
              );
            }
            if (line.kind === 'fold') {
              const sel = focusable.indexOf(line) === selected;
              return (
                <Box key={`f:${line.group}`} paddingLeft={1}>
                  <Text color={sel ? 'suggestion' : 'subtle'}>{sel ? '❯ ' : '  '}</Text>
                  <Text dimColor>{t('… {{count}} more', { count: line.hidden ?? 0 })}</Text>
                </Box>
              );
            }
            if (line.kind === 'newsession') {
              const sel = focusable.indexOf(line) === selected;
              return (
                <Box key="newsession" marginTop={1} paddingLeft={1}>
                  <Text color={sel ? 'suggestion' : 'subtle'}>{sel ? '❯ ' : '  '}</Text>
                  <Text color="suggestion">
                    {sel ? <Text underline>{t('+ new session')}</Text> : t('+ new session')}
                  </Text>
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
                spinnerActive={sel && spinnerActive}
                nameWidth={nameWidth}
                detailWidth={detailWidth}
              />
            );
          })}
        </ScrollBox>

        {/* composer（官方 Cl editor 最小版） */}
        {composerDraft !== null ? (
          <Box marginTop={1} paddingLeft={1}>
            <Text color="suggestion">{'> '}</Text>
            <Text>
              {composerDraft}
              <Text color="suggestion">|</Text>
            </Text>
            <Text dimColor>{` · ${t('enter to dispatch · esc to cancel')}`}</Text>
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

        {/* footer：hint + 快捷键（官方 il） */}
        <Box marginTop={1}>
          {hint ? <Text color="warning"> {hint}</Text> : null}
          <Text dimColor>
            {t(' ↑↓ select · ↵ open · n dispatch · ctrl+r rename · ctrl+x stop · ? help · esc quit')}
          </Text>
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
  }>,
): FleetRow[] {
  const now = Date.now();
  return sessions.map(s => {
    let tempo: FleetRow['tempo'] = 'running';
    if (s.waitingFor) tempo = 'blocked';
    else if (s.status === 'idle') tempo = 'idle';
    const base = s.updatedAt ?? s.startedAt ?? now;
    return {
      shortId: s.sessionId.slice(0, 8),
      name: s.name ?? s.sessionId,
      kind: s.kind,
      cwd: s.cwd,
      tempo,
      blockedNeeds: s.waitingFor,
      detail: s.status && s.status !== 'idle' ? s.status : undefined,
      ageLabel: relativeAge(now - base),
      pid: s.pid,
    };
  });
}
