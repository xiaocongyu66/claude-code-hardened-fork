/**
 * CLI adapter: run the native TUI (CCH_TUI_NATIVE=1) on top of a QueryEngine.
 *
 * This is the only place that knows about REPL/session assembly. The actual
 * host loop in `nativeHost.ts` stays dependency-injected and unit-testable.
 * When the native module is unavailable (ordinary builds without the staged
 * `tui.node`, unsupported platform) this returns false and the caller keeps
 * the Ink REPL path.
 */

import { QueryEngine, type QueryEngineConfig } from '../QueryEngine.js'
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
    options: {
      fullscreen: isFullscreenEnvEnabled(),
      theme: getGlobalConfig().theme,
      vim: getGlobalConfig().editorMode === 'vim',
    },
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
