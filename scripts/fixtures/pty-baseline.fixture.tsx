// P0 baseline of the existing React/Ink implementation, not the future Rust API.
// Run only via scripts/ink-pty-baseline.py; stderr is a JSON-lines control pipe.
import { writeSync } from 'node:fs';
import React, { useEffect, useRef } from 'react';
import Text from '../../packages/@ant/ink/src/components/Text.js';
import render from '../../packages/@ant/ink/src/core/root.js';
import useApp from '../../packages/@ant/ink/src/hooks/use-app.js';
import useInput from '../../packages/@ant/ink/src/hooks/use-input.js';
import { useTerminalSize } from '../../packages/@ant/ink/src/hooks/useTerminalSize.js';

function report(message: Record<string, unknown>) {
  writeSync(2, `INK_PTY_V1 ${JSON.stringify(message)}\n`);
}

function Baseline(): React.ReactNode {
  const { exit } = useApp();
  const { columns, rows } = useTerminalSize();
  const mounted = useRef(false);
  useInput((input, key, event) => {
    report({ type: 'input', input, upArrow: key.upArrow, pasted: event.keypress.isPasted });
    // Leave the current input dispatch before unmounting its React tree.
    if (input === 'q') setImmediate(exit);
  });
  // useInput registers its listener in an earlier passive effect. This is a
  // readiness handshake, not a timer guessing when React has committed.
  useEffect(() => {
    report({
      type: mounted.current ? 'resize' : 'ready',
      columns,
      rows,
      stdinTTY: process.stdin.isTTY === true,
      stdoutTTY: process.stdout.isTTY === true,
      raw: process.stdin.isRaw === true,
    });
    mounted.current = true;
  }, [columns, rows]);
  return <Text>INK_PTY_BASELINE</Text>;
}

const instance = await render(<Baseline />, { patchConsole: false });
await instance.waitUntilExit();
report({ type: 'exit', raw: process.stdin.isRaw === true });
// Deliberately no process.exit(): leaked referenced handles must fail the runner.
