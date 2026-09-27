import { Box, Text, useInput, useApp } from '@anthropic/ink';
import { useEffect, useState } from 'react';

/**
 * FleetView —— `cch agents` 的会话列表视图。
 *
 * 官方视觉契约（binary 2.1.283 实证）：
 *   - 按 state 分组渲染（fleetViewGroupMode ?? 'state'）：working →
 *     blocked → idle 分组头 + 会话行（Hp 主组件的 groups 体系）；
 *   - 行文案：`${arrowRight} or enter to open` / new session 行
 *     `${arrowRight} or enter to start` / `ctrl+x to stop|delete`；
 *   - footer 快捷键：ctrl+r rename · ctrl+e group · ctrl+x stop。
 */

export interface FleetRow {
  shortId: string;
  name: string;
  kind: string;
  cwd: string;
  tempo: 'running' | 'blocked' | 'idle' | 'booked';
  blockedNeeds?: string;
}

type TempoColor = 'success' | 'warning' | 'secondaryText';

const TEMPO_STYLE: Record<FleetRow['tempo'], { label: string; color: TempoColor }> = {
  running: { label: 'working', color: 'success' },
  blocked: { label: 'blocked', color: 'warning' },
  idle: { label: 'idle', color: 'secondaryText' },
  booked: { label: 'booked', color: 'secondaryText' },
};

/** 官方分组顺序（state 模式）。 */
const GROUP_ORDER = ['running', 'blocked', 'idle', 'booked'] as const;

const GROUP_TITLE: Record<string, string> = {
  running: 'WORKING',
  blocked: 'BLOCKED — NEEDS YOUR INPUT',
  idle: 'IDLE',
  booked: 'SCHEDULED',
};

function padEnd(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

export function FleetView({
  rows,
  onAttach,
}: {
  rows: FleetRow[];
  onAttach?: (row: FleetRow) => void;
}): React.ReactNode {
  const { exit } = useApp();
  const [selected, setSelected] = useState(0);

  useEffect(() => {
    if (selected >= rows.length) setSelected(Math.max(0, rows.length - 1));
  }, [rows.length, selected]);

  useInput(
    (
      input: string,
      key: {
        upArrow?: boolean;
        downArrow?: boolean;
        return?: boolean;
        escape?: boolean;
      },
    ) => {
      if (input === 'j' || key.downArrow) {
        setSelected(s => Math.min(rows.length - 1, s + 1));
      } else if (input === 'k' || key.upArrow) {
        setSelected(s => Math.max(0, s - 1));
      } else if (key.return) {
        const row = rows[selected];
        if (row && onAttach) {
          onAttach(row);
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
        <Text bold> agents</Text>
        <Text dimColor> No background sessions. Dispatch one with `cch --bg "task"`.</Text>
      </Box>
    );
  }

  const nameWidth = Math.max(...rows.map(r => r.name.slice(0, 24).length), 8);

  // 按 tempo 分组（保持 rows 原序、组间按官方顺序）
  const groups = GROUP_ORDER.map(g => ({
    tempo: g,
    items: rows.filter(r => r.tempo === g),
  })).filter(g => g.items.length > 0);

  // 展平后的行索引（含分组头跳过）——用累计计数对齐 rows 下标
  let flatIndex = -1;

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box>
        <Text bold>{' agents'}</Text>
        <Text dimColor>
          {' '}
          — {rows.length} session{rows.length === 1 ? '' : 's'}
        </Text>
      </Box>

      {groups.map(group => (
        <Box key={group.tempo} flexDirection="column" marginTop={1}>
          <Text bold color="secondaryText">
            {' '}
            {GROUP_TITLE[group.tempo]} ({group.items.length})
          </Text>
          {group.items.map(row => {
            flatIndex += 1;
            const sel = flatIndex === selected;
            const ts = TEMPO_STYLE[row.tempo]!;
            return (
              <Box key={row.shortId} paddingLeft={1}>
                <Text color={sel ? 'suggestion' : 'secondaryText'}>{sel ? '❯ ' : '  '}</Text>
                <Text bold={sel}>{padEnd(row.name.slice(0, 24), nameWidth)}</Text>
                <Text> </Text>
                <Text color={ts.color}>{ts.label}</Text>
                {row.blockedNeeds ? <Text color="warning"> — needs {row.blockedNeeds}</Text> : null}
                <Text dimColor>{`  ${row.cwd}`}</Text>
              </Box>
            );
          })}
        </Box>
      ))}

      <Box marginTop={1}>
        <Text dimColor> ↑↓ select · ↵ attach · ctrl+r rename · ctrl+e group · esc quit</Text>
      </Box>
    </Box>
  );
}

/** 从 SessionEntry 装配 FleetRow（tempo 推断：status/waitingFor）。 */
export function toFleetRows(
  sessions: Array<{
    sessionId: string;
    kind: string;
    name?: string;
    cwd: string;
    status?: string;
    waitingFor?: string;
  }>,
): FleetRow[] {
  return sessions.map(s => {
    let tempo: FleetRow['tempo'] = 'running';
    if (s.waitingFor) tempo = 'blocked';
    else if (s.status === 'idle') tempo = 'idle';
    return {
      shortId: s.sessionId.slice(0, 8),
      name: s.name ?? s.sessionId,
      kind: s.kind,
      cwd: s.cwd,
      tempo,
      blockedNeeds: s.waitingFor,
    };
  });
}
