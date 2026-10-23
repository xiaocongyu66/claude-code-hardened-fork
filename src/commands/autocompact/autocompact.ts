/**
 * `/autocompact` — show or change the V2 automatic compaction policy.
 *
 * This command only edits `settings.compaction`; it does not run compaction.
 * The policy is consumed by the COMPACTION_V2 orchestrator, so every
 * user-facing message says the change applies only when that feature is on.
 *
 * Writes go through updateSettingsForSource (the same persistence path as
 * /advisor and /effort), which merges into the existing settings file instead
 * of rewriting it, preserving unrelated fields.
 */

import type {
  LocalCommandCall,
  LocalCommandResult,
} from '../../types/command.js'
import type {
  CompactionMethodNameSetting,
  SettingsJson,
} from '../../utils/settings/types.js'
import {
  AUTOCOMPACT_METHOD_NAMES,
  type AutocompactAction,
  parseAutocompactArgs,
} from './args.js'

const V2_NOTE = 'Only applies when COMPACTION_V2 is enabled.'

type PatchAction = Exclude<
  AutocompactAction,
  { kind: 'status' } | { kind: 'invalid' }
>

type CompactionPatch = NonNullable<SettingsJson['compaction']>

function boolLabel(value: boolean | undefined, fallback: boolean): string {
  const effective = value ?? fallback
  return `${effective ? 'on' : 'off'}${value === undefined ? ' (default)' : ''}`
}

function thresholdLabel(
  settings: NonNullable<SettingsJson['compaction']>,
): string {
  if (settings.thresholdTokens !== undefined) {
    const ignoredPercent =
      settings.thresholdPercent !== undefined
        ? ` (thresholdPercent ${settings.thresholdPercent}% ignored)`
        : ''
    return `${settings.thresholdTokens} tokens${ignoredPercent}`
  }
  if (settings.thresholdPercent !== undefined) {
    return `${settings.thresholdPercent}% of the context window`
  }
  return 'default (context window - reserve)'
}

function reserveLabel(
  settings: NonNullable<SettingsJson['compaction']>,
): string {
  return settings.reserveTokens !== undefined
    ? `${settings.reserveTokens} tokens`
    : 'default (max(15% of window, 16384))'
}

function keepRecentLabel(
  settings: NonNullable<SettingsJson['compaction']>,
): string {
  return settings.keepRecentTokens !== undefined
    ? `${settings.keepRecentTokens} tokens`
    : '20000 tokens (default)'
}

/**
 * Filter the configured method order down to known names. An empty (or
 * entirely unknown) list falls back to the built-in default order, matching
 * the orchestrator's sanitizeMethodOrder behavior.
 */
export function resolveDisplayMethodOrder(
  value: unknown,
): CompactionMethodNameSetting[] {
  const filtered = Array.isArray(value)
    ? value.filter(
        (item): item is CompactionMethodNameSetting =>
          typeof item === 'string' &&
          (AUTOCOMPACT_METHOD_NAMES as readonly string[]).includes(item),
      )
    : []
  return filtered.length > 0 ? filtered : [...AUTOCOMPACT_METHOD_NAMES]
}

export function formatStatus(settings: SettingsJson['compaction']): string {
  const s: NonNullable<SettingsJson['compaction']> = settings ?? {}
  return [
    'Automatic compaction (settings.compaction)',
    V2_NOTE,
    `  enabled:     ${boolLabel(s.enabled, true)}`,
    `  threshold:   ${thresholdLabel(s)}`,
    `  reserve:     ${reserveLabel(s)}`,
    `  keepRecent:  ${keepRecentLabel(s)}`,
    `  methodOrder: ${resolveDisplayMethodOrder(s.methodOrder).join(', ')}`,
    `  midTurn:     ${boolLabel(s.midTurnEnabled, true)}`,
    `  async:       ${boolLabel(s.asyncEnabled, true)}`,
    `  idle:        ${boolLabel(s.idleEnabled, false)}`,
  ].join('\n')
}

/**
 * Translate a parsed action into the nested `compaction` patch. Setting a
 * threshold explicitly clears the other threshold form so only one applies.
 */
export function buildCompactionPatch(action: PatchAction): CompactionPatch {
  switch (action.kind) {
    case 'setEnabled':
      return { enabled: action.enabled }
    case 'setThresholdTokens':
      return {
        thresholdTokens: action.tokens,
        thresholdPercent: undefined,
      }
    case 'setThresholdPercent':
      return {
        thresholdPercent: action.percent,
        thresholdTokens: undefined,
      }
    case 'setReserveTokens':
      return { reserveTokens: action.tokens }
    case 'setKeepRecentTokens':
      return { keepRecentTokens: action.tokens }
    case 'setMethodOrder':
      return { methodOrder: action.methods }
  }
}

export function buildConfirmation(action: PatchAction): string {
  switch (action.kind) {
    case 'setEnabled':
      return action.enabled
        ? 'Automatic compaction enabled.'
        : 'Automatic compaction disabled.'
    case 'setThresholdTokens':
      return `Compaction threshold set to ${action.tokens} tokens (thresholdPercent cleared).`
    case 'setThresholdPercent':
      return `Compaction threshold set to ${action.percent}% of the context window (thresholdTokens cleared).`
    case 'setReserveTokens':
      return `Compaction reserve set to ${action.tokens} tokens.`
    case 'setKeepRecentTokens':
      return `Compaction keepRecent set to ${action.tokens} tokens.`
    case 'setMethodOrder':
      return `Compaction method order set to: ${action.methods.join(', ')}.`
  }
}

export type AutocompactDeps = {
  getCompactionSettings: () => SettingsJson['compaction']
  updateSettingsForSource: (
    source: 'userSettings',
    patch: SettingsJson,
  ) => { error: Error | null }
}

/**
 * Dependency-injected implementation. Kept separate from `call` so tests can
 * exercise persistence without loading the settings module's heavy import
 * chain (telemetry, axios, …).
 */
export async function runAutocompact(
  args: string,
  deps: AutocompactDeps,
): Promise<LocalCommandResult> {
  const action = parseAutocompactArgs(args)

  if (action.kind === 'invalid') {
    return { type: 'text', value: action.error }
  }
  if (action.kind === 'status') {
    return { type: 'text', value: formatStatus(deps.getCompactionSettings()) }
  }

  const { error } = deps.updateSettingsForSource('userSettings', {
    compaction: buildCompactionPatch(action),
  })
  if (error) {
    return {
      type: 'text',
      value: `Failed to update compaction settings: ${error.message}`,
    }
  }

  return {
    type: 'text',
    value: `${buildConfirmation(action)}\nSaved to user settings. ${V2_NOTE}`,
  }
}

export const call: LocalCommandCall = async args => {
  // Lazy: the settings module pulls in telemetry/network dependencies that
  // should not load until the command is actually invoked.
  const settings = await import('../../utils/settings/settings.js')
  return runAutocompact(args, {
    getCompactionSettings: () => settings.getCompactionSettings(),
    updateSettingsForSource: (source, patch) =>
      settings.updateSettingsForSource(source, patch),
  })
}
