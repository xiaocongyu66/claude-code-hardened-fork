import React from 'react';
import type { StatsStore } from './context/stats.js';
import type { Root } from '@anthropic/ink';
import type { Props as REPLProps } from './screens/REPL.js';
import type { AppState } from './state/AppStateStore.js';
import { resolveRequestedTuiMode, resolveTuiMode, type TuiMode } from './tui/tuiMode.js';
import type { FpsMetrics } from './utils/fpsTracker.js';
import { loadTuiNative } from './utils/tuiNative.js';

type AppWrapperProps = {
  getFpsMetrics: () => FpsMetrics | undefined;
  stats?: StatsStore;
  initialState: AppState;
};

/**
 * `--tui` override for every launchRepl() call in this process. The CLI action
 * handler sets it once so all REPL entry points (continue, resume, remote,
 * SSH, direct-connect, plain) share the same selection. `undefined` clears it
 * (flag absent), letting CCH_TUI / CCH_TUI_NATIVE apply.
 */
let tuiModeOverride: TuiMode | undefined;

export function setTuiModeOverride(mode: string | undefined): void {
  const normalized = mode?.toLowerCase().trim();
  tuiModeOverride = normalized === 'auto' || normalized === 'native' || normalized === 'ink' ? normalized : undefined;
}

export async function launchRepl(
  root: Root,
  appProps: AppWrapperProps,
  replProps: REPLProps,
  renderAndRun: (root: Root, element: React.ReactNode) => Promise<void>,
): Promise<void> {
  // Native TUI is the default for local interactive sessions (auto). Ink stays
  // reachable via --tui=ink and is the fallback whenever the addon is missing
  // (no vendor/tui/<triple>/tui.node, unsupported platform) or the session is
  // remote/SSH/direct-connect. Resolution order: flag > CCH_TUI >
  // CCH_TUI_NATIVE > auto.
  const stdinIsTTY = Boolean(process.stdin.isTTY);
  const stdoutIsTTY = Boolean(process.stdout.isTTY);
  const remoteSession = Boolean(replProps.remoteSessionConfig || replProps.sshSession || replProps.directConnectConfig);
  // Avoid touching the addon at all when it cannot run (forced Ink, pipes,
  // remote). `auto`/`native` are still fully resolved by resolveTuiMode().
  const requested = resolveRequestedTuiMode({
    flag: tuiModeOverride,
    env: process.env.CCH_TUI,
    legacyEnv: process.env.CCH_TUI_NATIVE,
  });
  const nativeAvailable =
    requested !== 'ink' && stdinIsTTY && stdoutIsTTY && !remoteSession && loadTuiNative() !== null;
  const resolution = resolveTuiMode({
    flag: tuiModeOverride,
    env: process.env.CCH_TUI,
    legacyEnv: process.env.CCH_TUI_NATIVE,
    stdinIsTTY,
    stdoutIsTTY,
    remoteSession,
    nativeAvailable,
  });

  if (resolution.mode === 'native') {
    const { tryRunNativeTui } = await import('./tui/nativeRepl.js');
    if (await tryRunNativeTui({ initialState: appProps.initialState, replProps })) {
      return;
    }
    if (resolution.requested === 'native') {
      process.stderr.write('Native TUI failed to start; falling back to Ink.\n');
    }
  } else if (resolution.requested === 'native' && resolution.fallbackReason) {
    process.stderr.write(`Native TUI unavailable (${resolution.fallbackReason}); falling back to Ink.\n`);
  }

  const { App } = await import('./components/App.js');
  const { SentryErrorBoundary } = await import('./components/SentryErrorBoundary.js');
  const { REPL } = await import('./screens/REPL.js');
  await renderAndRun(
    root,
    <SentryErrorBoundary name="RootREPLBoundary">
      <App {...appProps}>
        <REPL {...replProps} />
      </App>
    </SentryErrorBoundary>,
  );
}
