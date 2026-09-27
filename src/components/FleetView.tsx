import { Box, Text, useInput, useApp } from '@anthropic/ink';
import { useEffect, useState } from 'react';

/**
 * FleetView —— `cch agents` 的会话列表视图。
 *
 * 完整还原官方 `claude agents`（binary 2.1.283 逆向实证）：
 *   装配：mountFleetViewWithComposerBack → JJn → Hp（主组件）
 *   行类型（el 的 Ve）：header / fold / newsession / earlier / job
 *   job 行（Hi）：[tempo图标] [名称粗体] — [状态词+详情] [相对时间]
 *   tempo 图标（Tn）：working ● / blocked ◐ / idle ○ / stopped ⏹ / failure ✗
 *   分组（state 模式，fleetViewGroupMode ?? 'state'）组间按官方顺序
 *   两段式删除（deleteArmed）：ctrl+x → armed 2s → 再次 ctrl+x 执行
 *   空态（newsession 引导）：Nothing running in the background. …
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
  pid?: number;
}

type TempoColor = 'success' | 'warning' | 'secondaryText';

const TEMPO_STYLE: Record<FleetRow['tempo'], { label: string; color: TempoColor }> = {
  running: { label: 'working', color: 'success' },
  blocked: { label: 'blocked', color: 'warning' },
  idle: { label: 'idle', color: 'secondaryText' },
  booked: { label: 'scheduled', color: 'secondaryText' },
};

/** 组间官方顺序（state 模式）。 */
const GROUP_ORDER = ['running', 'blocked', 'idle', 'booked'] as const;

const GROUP_TITLE: Record<string, string> = {
  running: 'WORKING',
  blocked: 'BLOCKED — NEEDS YOUR INPUT',
  idle: 'IDLE',
  booked: 'SCHEDULED',
};

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

/** tempo → 展示图标（Tn 语义：spinner/armed 顶替由上层处理）。 */
function glyphFor(row: FleetRow): string {
  if (row.detail?.startsWith('failure')) return '✗';
  switch (row.tempo) {
    case 'running':
      return '●';
    case 'blocked':
      return '◐';
    case 'idle':
      return '○';
    case 'booked':
      return '◔';
  }
}

function colorFor(row: FleetRow): TempoColor {
  if (row.detail?.startsWith('failure')) return 'warning';
  return TEMPO_STYLE[row.tempo]!.color;
}

export function FleetView({
  rows,
  onAttach,
  onKill,
  hint,
}: {
  rows: FleetRow[];
  onAttach?: (row: FleetRow) => void;
  /** ctrl+x 两段式的执行端（缺省不启用） */
  onKill?: (row: FleetRow) => void;
  /** 底部一次性提示（错误/信息） */
  hint?: string;
}): React.ReactNode {
  const { exit } = useApp();
  const [selected, setSelected] = useState(0);
  const [killArmed, setKillArmed] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (selected >= rows.length) setSelected(Math.max(0, rows.length - 1));
  }, [rows.length, selected]);

  useEffect(() => {
    if (killArmed === null) return undefined;
    const t = setTimeout(() => setKillArmed(null), 2000);
    return () => clearTimeout(t);
  }, [killArmed]);

  // 按 tempo 分组后展平——选择与渲染共用这一个顺序（组内保持 rows 原序）
  const flatRows = GROUP_ORDER.flatMap(g => rows.filter(r => r.tempo === g));

  useInput(
    (
      input: string,
      key: {
        upArrow?: boolean;
        downArrow?: boolean;
        return?: boolean;
        escape?: boolean;
        ctrl?: boolean;
      },
    ) => {
      const focused = flatRows[selected];
      if (input === 'j' || key.downArrow) {
        setKillArmed(null);
        setSelected(s => Math.min(rows.length - 1, s + 1));
      } else if (input === 'k' || key.upArrow) {
        setKillArmed(null);
        setSelected(s => Math.max(0, s - 1));
      } else if (key.ctrl && input === 'x' && focused) {
        // 官方 deleteArmed：第一次 armed，第二次执行
        if (killArmed === focused.shortId) {
          setKillArmed(null);
          onKill?.(focused);
        } else {
          setKillArmed(focused.shortId);
        }
      } else if (key.return && focused) {
        if (onAttach) {
          onAttach(focused);
          exit();
        }
      } else if (key.escape || input === 'q') {
        exit();
      }
    },
  );

  if (rows.length === 0) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Box>
          <Text bold>Claude Code</Text>
          <Text dimColor> agents</Text>
        </Box>
        <Box marginTop={1} paddingLeft={1} flexDirection="column">
          <Text bold>Nothing running in the background.</Text>
          <Text dimColor>
            Hand off a task and it keeps working while you do something else — even if you close this terminal.
          </Text>
          <Box marginTop={1} flexDirection="column">
            <Text dimColor>
              Start one with <Text color="suggestion">+ new session</Text> in the full view,
            </Text>
            <Text dimColor>
              or run <Text color="suggestion">claude --bg &quot;task&quot;</Text> from any terminal,
            </Text>
            <Text dimColor>
              or <Text color="suggestion">/fork</Text> a session you&apos;re already in.
            </Text>
          </Box>
        </Box>
      </Box>
    );
  }

  const nameWidth = Math.max(...rows.map(r => r.name.slice(0, 24).length), 8);
  const detailWidth = Math.max(...rows.map(r => (rowDetail(row) ?? '').length), 12);

  function rowDetail(row: FleetRow): string | undefined {
    if (row.blockedNeeds) return row.blockedNeeds;
    return row.detail;
  }

  const groups = GROUP_ORDER.map(g => ({
    tempo: g,
    items: rows.filter(r => r.tempo === g),
  })).filter(g => g.items.length > 0);

  const focused = flatRows[selected];

  return (
    <Box flexDirection="column" paddingX={1}>
      {groups.map(group => (
        <Box key={group.tempo} flexDirection="column" marginTop={1}>
          <Text bold color="secondaryText">
            {' '}
            {GROUP_TITLE[group.tempo]} ({group.items.length})
          </Text>
          {group.items.map(row => {
            const sel = flatRows.indexOf(row) === selected;
            const ts = TEMPO_STYLE[row.tempo]!;
            const armed = killArmed === row.shortId;
            const detail = rowDetail(row);
            return (
              <Box key={row.shortId} paddingLeft={1}>
                <Text color={sel ? 'suggestion' : 'secondaryText'}>{sel ? '❯ ' : '  '}</Text>
                <Text color={colorFor(row)}>{glyphFor(row)}</Text>
                <Text> </Text>
                <Text bold={sel}>{padEnd(row.name.slice(0, 24), nameWidth)}</Text>
                <Text> </Text>
                <Text color={ts.color} dimColor={row.tempo === 'idle'}>
                  {ts.label}
                </Text>
                {detail ? <Text dimColor>{` · ${detail}`.slice(0, detailWidth + 3)}</Text> : null}
                <Text dimColor>{`  ${row.ageLabel ?? ''}`}</Text>
                <Text dimColor>{`  ${row.cwd}`}</Text>
                {armed ? <Text color="error"> · ctrl+x again to delete</Text> : null}
              </Box>
            );
          })}
        </Box>
      ))}

      <Box marginTop={1} paddingLeft={1}>
        <Text color={flatRows.indexOf(focused ?? rows[0]!) === selected ? 'suggestion' : 'secondaryText'}>
          {focused ? '❯ ' : '  '}
        </Text>
        <Text color="suggestion">{focused ? <Text underline>+ new session</Text> : '+  new session'}</Text>
        <Text dimColor> · run `cch --bg &quot;task&quot;` to dispatch</Text>
      </Box>

      <Box marginTop={1}>
        {hint ? <Text color="warning"> {hint}</Text> : null}
        <Text dimColor> ↑↓ select · ↵ open · ctrl+x stop · esc quit</Text>
      </Box>
    </Box>
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
