import { describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { Writable } from 'node:stream';
import { useEffect, useLayoutEffect } from 'react';
import type App from '../../components/App.js';
import useApp from '../../hooks/use-app.js';
import useInput from '../../hooks/use-input.js';
import useStdin from '../../hooks/use-stdin.js';
import instances from '../instances.js';
import reconciler from '../reconciler.js';
import { createRoot } from '../root.js';

class InputStream extends EventEmitter {
  isTTY = true;
  isRaw = false;
  referenced = false;
  readableLength = 0;
  calls: string[] = [];
  private chunks: string[] = [];

  setEncoding() {
    return this;
  }

  setRawMode(value: boolean) {
    this.isRaw = value;
    this.calls.push(`raw:${value}`);
    return this;
  }

  ref() {
    this.referenced = true;
    this.calls.push('ref');
    return this;
  }

  unref() {
    this.referenced = false;
    this.calls.push('unref');
    return this;
  }

  read() {
    return this.chunks.shift() ?? null;
  }

  send(value: string) {
    this.chunks.push(value);
    this.emit('readable');
  }
}

function terminal() {
  const input = new InputStream();
  const output = Object.assign(
    new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    }),
    { isTTY: false, columns: 80, rows: 24 },
  );
  return {
    input,
    options: {
      stdin: input as unknown as NodeJS.ReadStream,
      stdout: output as unknown as NodeJS.WriteStream,
      stderr: output as unknown as NodeJS.WriteStream,
      patchConsole: false,
      exitOnCtrlC: false,
    },
  };
}

function expectInput(input: InputStream, active: boolean) {
  expect(input.isRaw).toBe(active);
  expect(input.referenced).toBe(active);
  expect(input.listenerCount('readable')).toBe(active ? 1 : 0);
}

type OwnerSpec = { id: string; active: boolean };

function Owner({ id, active, received }: OwnerSpec & { received: string[] }) {
  useInput(value => received.push(`${id}:${value}`), { isActive: active });
  return null;
}

function Owners({ specs, received }: { specs: OwnerSpec[]; received: string[] }) {
  return specs.map(spec => <Owner key={spec.id} {...spec} received={received} />);
}

const owners = (prefix: string, count: number): OwnerSpec[] =>
  Array.from({ length: count }, (_, index) => ({ id: `${prefix}${index}`, active: true }));

describe('raw input ownership with the real React reconciler', () => {
  test.each([0, 1, 3])('releases %i active owners on direct and repeated unmount', async count => {
    const { input, options } = terminal();
    const root = await createRoot(options);
    const exited = root.waitUntilExit();
    try {
      root.render(<Owners specs={owners('a', count)} received={[]} />);
      reconciler.flushPassiveEffects();
      expectInput(input, count > 0);
      expect(input.calls.filter(call => call === 'ref')).toHaveLength(count > 0 ? 1 : 0);
      root.unmount();
      expectInput(input, false);
      const calls = [...input.calls];
      root.unmount();
      reconciler.flushPassiveEffects();
      expect(input.calls).toEqual(calls);
      await exited;
      expectInput(input, false);
    } finally {
      root.unmount();
    }
  });

  test('inactive listeners do not own raw mode; toggles and the last release are paired', async () => {
    const { input, options } = terminal();
    const root = await createRoot(options);
    const received: string[] = [];
    const states: OwnerSpec[][] = [
      [{ id: 'inactive', active: false }],
      [...owners('a', 3), { id: 'inactive', active: false }],
      [
        { id: 'a1', active: true },
        { id: 'inactive', active: false },
      ],
      [
        { id: 'a1', active: false },
        { id: 'inactive', active: false },
      ],
      [
        { id: 'a1', active: true },
        { id: 'inactive', active: false },
      ],
      [{ id: 'inactive', active: false }],
      [],
    ];
    try {
      for (const specs of states) {
        root.render(<Owners specs={specs} received={received} />);
        const active = specs.filter(spec => spec.active);
        // 在 passive cleanup 前检查，防止旧 listener 掩盖最后一次 layout release。
        expectInput(input, active.length > 0);
        reconciler.flushPassiveEffects();
        received.length = 0;
        if (active.length > 0) input.send('x');
        expect(received).toEqual(active.map(spec => `${spec.id}:x`));
      }
      expect(input.calls.filter(call => call === 'raw:true')).toHaveLength(2);
      expect(input.calls.filter(call => call === 'raw:false')).toHaveLength(2);
    } finally {
      root.unmount();
      reconciler.flushPassiveEffects();
    }
  });

  test('repeated keyed 3-to-1, 1-to-3 and 1-to-0 replacements keep only current owners', async () => {
    const { input, options } = terminal();
    const root = await createRoot(options);
    const received: string[] = [];
    try {
      const counts = [3, 1, 3, 1, 0, 1, 3, 1, 0];
      for (const [generation, count] of counts.entries()) {
        const specs = [...owners(`g${generation}-`, count), { id: `off${generation}`, active: false }];
        root.render(<Owners specs={specs} received={received} />);
        expectInput(input, count > 0);
        reconciler.flushPassiveEffects();
        received.length = 0;
        if (count > 0) input.send('k');
        expect(received).toEqual(specs.filter(spec => spec.active).map(spec => `${spec.id}:k`));
      }
    } finally {
      root.unmount();
      reconciler.flushPassiveEffects();
    }
    expectInput(input, false);
  });

  test.each(['exit', 'unmount'])('%s closes input before layout cleanup and allows a fresh root', async mode => {
    const { input, options } = terminal();
    const root = await createRoot(options);
    const exited = root.waitUntilExit();
    let exit = () => {};
    let setRawMode = (_enabled: boolean) => {};
    const cleanup: string[] = [];
    function Probe() {
      const app = useApp();
      const stdin = useStdin();
      useInput(() => {});
      useLayoutEffect(() => {
        exit = app.exit;
        setRawMode = stdin.setRawMode;
        return () => {
          cleanup.push(`layout:${input.isRaw}:${input.referenced}:${input.listenerCount('readable')}`);
        };
      }, [app.exit, stdin.setRawMode]);
      useEffect(
        () => () => {
          cleanup.push(`passive:${input.isRaw}`);
        },
        [],
      );
      return null;
    }
    try {
      root.render(<Probe />);
      reconciler.flushPassiveEffects();
      expectInput(input, true);
      if (mode === 'exit') exit();
      else root.unmount();
      expectInput(input, false);
      await exited;
      reconciler.flushPassiveEffects();
      expect(cleanup).toEqual(['layout:false:false:0', 'passive:false']);
      const calls = [...input.calls];
      setRawMode(false);
      setRawMode(true);
      root.unmount();
      expect(input.calls).toEqual(calls);

      const fresh = await createRoot(options);
      try {
        const received: string[] = [];
        fresh.render(<Owners specs={owners('new', 1)} received={received} />);
        reconciler.flushPassiveEffects();
        expectInput(input, true);
        setRawMode(false);
        setRawMode(true);
        expectInput(input, true);
        input.send('n');
        expect(received).toEqual(['new0:n']);
      } finally {
        fresh.unmount();
        reconciler.flushPassiveEffects();
      }
      expectInput(input, false);
      setRawMode(false);
      expectInput(input, false);
    } finally {
      root.unmount();
    }
  });

  test('suspend and resume restore input, but unmount permanently revokes restoration', async () => {
    const { input, options } = terminal();
    const root = await createRoot(options);
    const ink = instances.get(options.stdout)!;
    const received: string[] = [];
    try {
      root.render(<Owners specs={owners('a', 1)} received={received} />);
      reconciler.flushPassiveEffects();
      expectInput(input, true);
      const readers = input.listeners('readable');
      input.send('a');
      ink.suspendStdin();
      expect(input.isRaw).toBe(false);
      expect(input.referenced).toBe(true);
      expect(input.listenerCount('readable')).toBe(0);
      ink.resumeStdin();
      expectInput(input, true);
      expect(input.listeners('readable')).toEqual(readers);
      input.send('b');
      expect(received).toEqual(['a0:a', 'a0:b']);
      expect(input.calls.filter(call => call.startsWith('raw:'))).toEqual(['raw:true', 'raw:false', 'raw:true']);

      ink.suspendStdin();
      root.unmount();
      expectInput(input, false);
      // 检查保存的资源本身，避免仅靠入口防护掩盖回调泄漏。
      const suspended = ink as unknown as { stdinListeners: unknown[]; wasRawMode: boolean };
      expect(suspended.stdinListeners).toEqual([]);
      expect(suspended.wasRawMode).toBe(false);
      const calls = [...input.calls];
      ink.resumeStdin();
      ink.suspendStdin();
      ink.resumeStdin();
      root.unmount();
      reconciler.flushPassiveEffects();
      input.send('c');
      expectInput(input, false);
      expect(input.calls).toEqual(calls);
      expect(received).toEqual(['a0:a', 'a0:b']);
    } finally {
      root.unmount();
      reconciler.flushPassiveEffects();
    }
  });

  test('input-triggered exit cannot recreate an incomplete escape timer', async () => {
    const { input, options } = terminal();
    const root = await createRoot(options);
    const ink = instances.get(options.stdout)!;
    const received: string[] = [];
    function Probe() {
      const { exit } = useApp();
      useInput(value => {
        received.push(value);
        exit();
      });
      return null;
    }
    try {
      root.render(<Probe />);
      reconciler.flushPassiveEffects();
      // 保留真实挂载的 App 引用，以便卸载后检查同步输入调用栈的尾部。
      const app = (ink as unknown as { appRef: { current: App } }).appRef.current;
      input.send('x\x1b[');
      expect(received).toEqual(['x']);
      expectInput(input, false);
      expect(app.keyParseState.incomplete).toBeTruthy();
      expect(app.incompleteEscapeTimer).toBeNull();
      app.processInput('y\x1b[');
      input.readableLength = 1;
      app.flushIncomplete();
      expect(app.incompleteEscapeTimer).toBeNull();
      expect(received).toEqual(['x']);
    } finally {
      root.unmount();
      reconciler.flushPassiveEffects();
    }
  });

  test('shutdown removes only the Ink reader and also unreferences non-TTY input', async () => {
    for (const tty of [true, false]) {
      const { input, options } = terminal();
      input.isTTY = tty;
      const root = await createRoot(options);
      const otherReader = () => {};
      try {
        root.render(<Owners specs={owners('a', tty ? 1 : 0)} received={[]} />);
        input.on('readable', otherReader);
        root.unmount();
        expect(input.isRaw).toBe(false);
        expect(input.referenced).toBe(false);
        expect(input.listeners('readable')).toEqual([otherReader]);
        expect(input.calls.filter(call => call === 'unref')).toHaveLength(1);
        if (!tty) expect(input.calls).toEqual(['unref']);
      } finally {
        root.unmount();
        input.off('readable', otherReader);
        reconciler.flushPassiveEffects();
      }
    }
  });

  test('signal-exit process.exit callback shuts down synchronously before React cleanup', async () => {
    // 子进程使用真实 signal-exit 注册；不能在测试进程中 emit exit 污染全局退出状态。
    const rootURL = new URL('../root.ts', import.meta.url).href;
    const inputURL = new URL('../../hooks/use-input.ts', import.meta.url).href;
    const source = `
      import { EventEmitter } from 'node:events';
      import { Writable } from 'node:stream';
      import { writeSync } from 'node:fs';
      import { createElement, useLayoutEffect } from 'react';
      import { createRoot } from ${JSON.stringify(rootURL)};
      import useInput from ${JSON.stringify(inputURL)};
      const record = value => writeSync(2, JSON.stringify(value) + '\\n');
      const stdin = Object.assign(new EventEmitter(), {
        isTTY: true, isRaw: false, referenced: false,
        setEncoding() {}, read() { return null; },
        ref() { this.referenced = true; },
        unref() { this.referenced = false; record(['unref', this.isRaw, this.listenerCount('readable')]); },
        setRawMode(value) { this.isRaw = value; record(['raw', value]); },
      });
      const stdout = Object.assign(new Writable({ write(c, e, done) { done(); } }), {
        isTTY: false, columns: 80, rows: 24,
      });
      function Owner() {
        useInput(() => {});
        useLayoutEffect(() => () => record(['cleanup', stdin.isRaw, stdin.referenced]), []);
        return null;
      }
      const root = await createRoot({ stdin, stdout, stderr: stdout, patchConsole: false });
      root.render(createElement(Owner));
      record(['mounted', stdin.isRaw, stdin.referenced]);
      process.exit(0);
    `;
    const child = Bun.spawn([process.execPath, '--no-env-file', '--eval', source], {
      cwd: new URL('../../../../../../', import.meta.url).pathname,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // 独立期限先于测试框架超时触发；超时必须失败，不能当成正常退出。
      const deadline = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('signal-exit child exceeded 10 seconds')), 10_000);
      });
      const [status, stderr] = await Promise.race([
        Promise.all([child.exited, new Response(child.stderr).text(), new Response(child.stdout).text()]),
        deadline,
      ]);
      expect(status).toBe(0);
      const events = stderr
        .trim()
        .split('\n')
        .map(line => JSON.parse(line));
      expect(events.slice(0, 4)).toEqual([
        ['raw', true],
        ['mounted', true, true],
        ['raw', false],
        ['unref', false, 0],
      ]);
      expect(events.filter(event => event[0] === 'raw')).toEqual([
        ['raw', true],
        ['raw', false],
      ]);
      for (const event of events.filter(event => event[0] === 'cleanup')) {
        expect(event).toEqual(['cleanup', false, false]);
      }
    } finally {
      clearTimeout(timer);
      // 只终止并回收本测试创建的直接子进程，不向进程组发送信号。
      try {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      } finally {
        await child.exited;
      }
    }
  }, 15_000);
});
