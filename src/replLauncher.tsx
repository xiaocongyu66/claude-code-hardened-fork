import React from 'react';
import type { StatsStore } from './context/stats.js';
import type { Root } from '@anthropic/ink';
import type { Props as REPLProps } from './screens/REPL.js';
import type { AppState } from './state/AppStateStore.js';
import { isEnvTruthy } from './utils/envUtils.js';
import type { FpsMetrics } from './utils/fpsTracker.js';

type AppWrapperProps = {
  getFpsMetrics: () => FpsMetrics | undefined;
  stats?: StatsStore;
  initialState: AppState;
};

export async function launchRepl(
  root: Root,
  appProps: AppWrapperProps,
  replProps: REPLProps,
  renderAndRun: (root: Root, element: React.ReactNode) => Promise<void>,
): Promise<void> {
  // Opt-in native TUI (CCH_TUI_NATIVE=1). Only for a local interactive
  // session — remote/SSH/direct-connect REPLs stay on Ink. Unavailable
  // payloads (no vendor/tui/<triple>/tui.node, unsupported platform) fall
  // through to the Ink renderer unchanged.
  if (
    isEnvTruthy(process.env.CCH_TUI_NATIVE) &&
    process.stdout.isTTY &&
    process.stdin.isTTY &&
    !replProps.remoteSessionConfig &&
    !replProps.sshSession &&
    !replProps.directConnectConfig
  ) {
    const { tryRunNativeTui } = await import('./tui/nativeRepl.js');
    if (await tryRunNativeTui({ initialState: appProps.initialState, replProps })) {
      return;
    }
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
