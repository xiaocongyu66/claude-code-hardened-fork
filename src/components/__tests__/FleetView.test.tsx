import { afterAll, afterEach, describe, expect, mock, test } from 'bun:test';
import { PassThrough } from 'node:stream';
import { createElement } from 'react';
import { Ink, getTheme } from '@anthropic/ink';
import type { DOMElement, DOMNode } from '../../../packages/@ant/ink/src/core/dom.js';
import type { FleetRow } from '../FleetView.js';

// Replace telemetry and filesystem-backed locale settings only. React, Ink,
// input parsing and theme resolution execute for real. Missing deps fail.
mock.module('../../services/analytics/index.js', () => ({ logEvent() {} }));
mock.module('../../utils/settings/settings.js', () => ({ getInitialSettings: () => ({ uiLocale: 'en' }) }));
// MACRO must exist BEFORE the module graph loads: transitive module-level
// reads of MACRO.VERSION throw (empty render tree) if it's assigned later.
Object.assign(globalThis, { MACRO: { VERSION: 'test' } });
const { FleetView, toFleetRows } = await import('../FleetView.js');

const cleanups: Array<() => void> = [];
const allStderr: string[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});
afterAll(() => {
  // Empty render trees swallow React errors into stderr — dump at the end so
  // CI log tails (which only keep the last lines) actually show the cause.
  if (allStderr.length) console.error('[FV-STDERR-DUMP]\n' + allStderr.join('\n---\n').slice(0, 4000));
});
const settle = () => new Promise(resolve => setTimeout(resolve, 60));
function text(node: DOMNode): string {
  return node.nodeName === '#text' ? node.nodeValue : node.childNodes.map(text).join('');
}
function elements(node: DOMNode): DOMElement[] {
  return node.nodeName === '#text' ? [] : [node, ...node.childNodes.flatMap(elements)];
}
function row(tempo: FleetRow['tempo'], id: string = tempo): FleetRow {
  return { sessionId: `session-${id}`, shortId: id, name: `job-${id}`, kind: 'local', cwd: '/tmp', tempo };
}
async function mount(rows: FleetRow[], columns = 100, terminalRows = 30) {
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {} });
  const stdout = Object.assign(new PassThrough(), { isTTY: true, columns, rows: terminalRows });
  stdout.resume();
  const stderr = new PassThrough();
  const stderrChunks: Buffer[] = [];
  stderr.on('data', (c: Buffer) => stderrChunks.push(c));
  stderr.resume();
  const attached: FleetRow[] = [];
  const killed: FleetRow[] = [];
  const dispatched: string[] = [];
  const renamed: string[] = [];
  const ink = new Ink({
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
    stderr: stderr as unknown as NodeJS.WriteStream,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  cleanups.push(() => {
    ink.unmount();
    stdin.destroy();
    stdout.destroy();
    stderr.destroy();
  });
  ink.render(
    createElement(FleetView, {
      rows,
      onAttach: r => {
        attached.push(r);
      },
      onKill: r => {
        killed.push(r);
      },
      onDispatch: task => {
        dispatched.push(task);
      },
      onRename: (_r, name) => {
        renamed.push(name);
      },
    }),
  );
  await settle();
  const root = (ink as unknown as { rootNode: DOMElement }).rootNode;
  // CI runners can be slow: poll until the tree has content (max 2s) instead
  // of a fixed settle — an empty tree here means React bailed, not "too fast".
  const deadline = Date.now() + 2000;
  while (text(root) === '' && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 50));
  }
  const stderrText = () => Buffer.concat(stderrChunks).toString('utf8');
  // Empty tree means React bailed during render — surface the swallowed error.
  if (text(root) === '') allStderr.push(stderrText().slice(0, 2000));
  return {
    attached,
    killed,
    dispatched,
    renamed,
    stderrText,
    text: () => text(root),
    nodes: () => elements(root),
    async key(sequence: string) {
      stdin.write(sequence);
      await settle();
    },
  };
}
function composer(nodes: DOMElement[]) {
  return nodes.find(n => n.style.borderStyle === 'round' && n.style.borderLeft === false);
}

describe('FleetView real Ink component', () => {
  test('renders all seven tempos, group counts and resolved selection/status colors', async () => {
    const tempos: FleetRow['tempo'][] = ['running', 'idle', 'booked', 'blocked', 'done', 'failed', 'stopped'];
    const view = await mount(tempos.map(tempo => ({ ...row(tempo), name: tempo })));
    for (const tempo of tempos) expect(view.text()).toContain(tempo);
    expect(view.text()).toContain('Working (3)');
    expect(view.text()).toContain('Completed (3)');
    const theme = getTheme('dark');
    expect(view.nodes().some(n => n.style.backgroundColor === theme.userMessageBackground)).toBe(true);
    for (const [word, color] of [
      ['Done', theme.success],
      ['Failed', theme.error],
      ['Stopped', theme.inactive],
    ] as const) {
      expect(view.nodes().some(n => text(n) === word && n.textStyles?.color === color)).toBe(true);
    }
  });

  test('keeps dim horizontal composer borders in empty/narrow and populated/wide views', async () => {
    for (const columns of [45, 120]) {
      const view = await mount(columns === 45 ? [] : [row('idle')], columns);
      const box = composer(view.nodes());
      expect(box).toBeDefined();
      expect(box!.style.borderRight).toBe(false);
      expect(box!.style.borderDimColor).toBe(true);
      expect(box!.style.borderColor).toBeUndefined();
      if (columns === 45) expect(view.text()).toContain('Nothing running in the background.');
      await view.key('?');
      expect(view.text()).toContain('move selection');
      expect(view.nodes().some(n => n.style.borderColor === getTheme('dark').promptBorder)).toBe(true);
      await view.key('\x1b');
      await view.key('hello');
      expect(text(composer(view.nodes())!)).toContain('hello');
      expect(composer(view.nodes())!.style.borderDimColor).toBe(true);
    }
  });

  test('help matches navigation while printable former shortcuts enter text', async () => {
    const view = await mount([row('idle', 'a')], 45);
    expect(view.text()).toContain('type a task');
    expect(view.text()).not.toContain('n dispatch');
    await view.key('?');
    expect(view.text()).toContain('home / end');
    expect(view.text()).toContain('ctrl+n / ctrl+p');
    expect(view.text()).not.toContain('j k');
    expect(view.text()).not.toContain('g / G');
    expect(view.text()).not.toContain('esc / q');
    expect(view.text()).not.toContain('focus dispatch input');
    await view.key('\x1b');
    await view.key('jkgGnq');
    expect(text(composer(view.nodes())!)).toContain('jkgGnq');
    await view.key('\r');
    expect(view.dispatched).toEqual(['jkgGnq']);
    expect(view.attached).toEqual([]);
  });

  test('expands completed fold and counts only hidden failures', async () => {
    const view = await mount([row('failed', 'a'), row('done', 'b'), row('stopped', 'c'), row('failed', 'd')]);
    expect(view.text()).toContain('Completed (4)');
    expect(view.text()).toContain('show all (1 more · 1 failed)');
    await view.key('\x1b[B');
    await view.key('\x1b[B');
    await view.key('\x1b[B');
    await view.key('\r');
    expect(view.text()).toContain('job-d');
    expect(view.text()).not.toContain('show all');
  });

  test('Ctrl+n/p navigate without dispatch and Enter attaches the full identity', async () => {
    const rows = [row('idle', 'a'), row('idle', 'b')];
    rows[0]!.shortId = rows[1]!.shortId = 'collision';
    const view = await mount(rows);
    await view.key('\x0e');
    await view.key('\x10');
    await view.key('\x0e');
    await view.key('\x18');
    await view.key('\x18');
    expect(view.killed[0]?.sessionId).toBe('session-b');
    await view.key('\r');
    expect(view.attached[0]?.sessionId).toBe('session-b');
    expect(view.dispatched).toEqual([]);
  });

  test('accepts text immediately and dispatches instead of attaching', async () => {
    const view = await mount([row('idle', 'a')]);
    await view.key('hello');
    await view.key('\r');
    expect(view.dispatched).toEqual(['hello']);
    expect(view.attached).toEqual([]);
  });

  test('Escape cancels stop confirmation before another Ctrl+x', async () => {
    const view = await mount([row('idle', 'a')]);
    await view.key('\x18');
    await view.key('\x1b');
    await view.key('\x18');
    expect(view.killed).toEqual([]);
    await view.key('\x18');
    expect(view.killed[0]?.sessionId).toBe('session-a');
  });

  test('navigation works with a draft and Ctrl+c clears it', async () => {
    const view = await mount([row('idle', 'a'), row('idle', 'b')]);
    await view.key('hello');
    await view.key('\x0e');
    await view.key('\x10');
    await view.key('\x0e');
    await view.key('\x03');
    await view.key('\r');
    expect(view.dispatched).toEqual([]);
    expect(view.attached[0]?.sessionId).toBe('session-b');
  });

  test('page distance uses terminal rows rather than a fixed six entries', async () => {
    const view = await mount([row('idle', 'a'), row('idle', 'b'), row('idle', 'c')], 80, 7);
    await view.key('\x1b[6~');
    await view.key('\r');
    expect(view.attached[0]?.sessionId).toBe('session-b');
  });

  test('accepts bracketed paste and removes a whole emoji grapheme', async () => {
    const view = await mount([row('idle', 'a')]);
    await view.key('\x1b[200~hello world\r\nnext\x1b[201~');
    await view.key('👩‍💻');
    await view.key('\x7f');
    await view.key('\r');
    expect(view.dispatched).toEqual(['hello world next']);
    await view.key('\x12');
    await view.key('👩‍💻');
    await view.key('\x7f');
    await view.key('\r');
    expect(view.renamed).toEqual(['job-a']);
  });

  test('empty composer Enter opens the selected job and conversion preserves sessionId', async () => {
    const rows = toFleetRows([{ sessionId: 'abcdefgh-full-identity', kind: 'local', cwd: '/tmp', status: 'idle' }]);
    expect(rows[0]?.shortId).toBe('abcdefgh');
    const view = await mount(rows);
    await view.key('\r');
    expect(view.attached[0]?.sessionId).toBe('abcdefgh-full-identity');
  });
});
