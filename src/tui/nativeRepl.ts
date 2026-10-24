/**
 * CLI adapter: run the native TUI (default via --tui=auto/native).
 *
 * Backend selection from `replProps`:
 * - local sessions → QueryEngine (existing path)
 * - `claude ssh` / `claude connect` → `NativeSessionBridge`, which drives the
 *   session transport and injects its frames into the same host loop
 * - KAIROS `--remote` → not supported yet; returns false so Ink keeps it
 *
 * This is the only place that knows about REPL/session assembly. The actual
 * host loop in `nativeHost.ts` stays dependency-injected and unit-testable.
 * When the native module is unavailable (ordinary builds without the staged
 * `tui.node`, unsupported platform) this returns false and the caller keeps
 * the Ink REPL path.
 */

import { QueryEngine, type QueryEngineConfig } from '../QueryEngine.js'
import {
  DirectConnectTransport,
  NativeMessageAdapter,
  NativeSessionBridge,
  SSHSessionTransport,
} from '../remote/nativeSession.js'
import type { Props as REPLProps } from '../screens/REPL.js'
import type { AppState } from '../state/AppStateStore.js'
import { createStore } from '../state/store.js'
import type { Message } from '../types/message.js'
import { getGlobalConfig } from '../utils/config.js'
import { getCwd } from '../utils/cwd.js'
import {
  createFileStateCacheWithSizeLimit,
  READ_FILE_STATE_CACHE_SIZE,
} from '../utils/fileStateCache.js'
import { isFullscreenEnvEnabled } from '../utils/fullscreen.js'
import { hasPermissionsToUseTool } from '../utils/permissions/permissions.js'
import { mergeAndFilterTools } from '../utils/toolPool.js'
import { assembleToolPool } from '../tools.js'
import { loadTuiNative } from '../utils/tuiNative.js'
import { runNativeTui } from './nativeHost.js'

export interface NativeReplInput {
  initialState: AppState
  replProps: REPLProps
}

/**
 * Remote-style sessions the native TUI can host. SSH and direct-connect speak
 * plain stream-json, so the bridge injects frames unchanged. The KAIROS
 * `--remote` viewer (`remoteSessionConfig`) is intentionally not listed yet:
 * its echo filter, response timeouts, task counters and lazy history live in
 * the React hook. Returns null for that mode so the caller keeps Ink.
 */
function createSessionBridge(replProps: REPLProps): NativeSessionBridge | null {
  const adapter = new NativeMessageAdapter({
    // Both transports replay the prompt we just sent; the bridge already
    // rendered an optimistic bubble. Tool results still need to reach the TUI.
    userFrames: 'tool-results-only',
    dedupeInit: true,
  })

  if (replProps.sshSession) {
    const session = replProps.sshSession
    return new NativeSessionBridge({
      adapter,
      createTransport: callbacks => new SSHSessionTransport(session, callbacks),
      describeDisconnect: () => session.getStderrTail(),
    })
  }

  if (replProps.directConnectConfig) {
    const config = replProps.directConnectConfig
    return new NativeSessionBridge({
      adapter,
      createTransport: callbacks =>
        new DirectConnectTransport(config, callbacks),
    })
  }

  return null
}

/**
 * Returns true when the native TUI ran (and exited). False means the caller
 * should render the Ink REPL as usual.
 */
export async function tryRunNativeTui({
  initialState,
  replProps,
}: NativeReplInput): Promise<boolean> {
  const nativeModule = loadTuiNative()
  if (!nativeModule) {
    return false
  }

  // KAIROS remote viewer: not ported yet, keep the Ink path.
  if (replProps.remoteSessionConfig) {
    return false
  }
  const sessionBridge = createSessionBridge(replProps)

  const nativeOptions = {
    fullscreen: isFullscreenEnvEnabled(),
    theme: getGlobalConfig().theme,
    vim: getGlobalConfig().editorMode === 'vim',
  }

  // SSH / direct-connect: the transport owns the conversation. Messages are
  // injected through the host controls; prompts are written to the transport.
  if (sessionBridge) {
    const result = await runNativeTui({
      nativeModule,
      options: nativeOptions,
      submitPrompt: text => sessionBridge.submitPrompt(text),
      abort: () => sessionBridge.interrupt(),
      onHostReady: controls => sessionBridge.attach(controls),
      onStop: () => sessionBridge.disconnect(),
    })
    return result.started
  }

  const store = createStore(initialState)
  const appState = () => store.getState()
  const setAppState = (updater: (prev: AppState) => AppState) => {
    store.setState(updater)
  }

  // Same merge the Ink REPL performs (useMergedTools): CLI/MCP initial tools
  // first, then the assembled built-in pool filtered by the permission mode.
  const mergedTools = () =>
    mergeAndFilterTools(
      replProps.initialTools,
      assembleToolPool(appState().toolPermissionContext, appState().mcp.tools),
      appState().toolPermissionContext.mode,
    )

  let engine: QueryEngine | null = null

  const config = (canUseTool: QueryEngineConfig['canUseTool']) =>
    ({
      cwd: getCwd(),
      tools: mergedTools(),
      commands: replProps.commands,
      mcpClients: replProps.mcpClients ?? [],
      agents: appState().agentDefinitions.activeAgents,
      canUseTool,
      getAppState: appState,
      setAppState,
      initialMessages: (replProps.initialMessages ?? []) as Message[],
      readFileCache: createFileStateCacheWithSizeLimit(
        READ_FILE_STATE_CACHE_SIZE,
      ),
      customSystemPrompt: replProps.systemPrompt,
      appendSystemPrompt: replProps.appendSystemPrompt,
      thinkingConfig: replProps.thinkingConfig,
      verbose: true,
      replayUserMessages: true,
      includePartialMessages: true,
    }) satisfies QueryEngineConfig

  const result = await runNativeTui({
    nativeModule,
    options: nativeOptions,
    canUseTool: hasPermissionsToUseTool,
    submitPrompt: (text, canUseTool) => {
      if (!engine) {
        engine = new QueryEngine(config(canUseTool))
      } else if (engine.getAbortSignal().aborted) {
        // The host aborted the previous turn; start the next one clean.
        engine.resetAbortController()
      }
      return engine.submitMessage(text)
    },
    abort: () => {
      engine?.interrupt()
    },
  })

  return result.started
}
