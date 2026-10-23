/**
 * Argument parsing for `/autocompact`.
 *
 * Pure (no settings I/O) so the grammar and validation rules can be tested
 * without touching disk. The caller turns a valid action into a settings
 * patch and persists it through updateSettingsForSource.
 */

import type { CompactionMethodNameSetting } from '../../utils/settings/types.js'

/**
 * Valid V2 method names. Mirrors COMPACTION_METHOD_NAMES in
 * utils/settings/types.ts and CompactionMethodName in
 * services/compaction2/contracts.ts. Kept local so this command (and its
 * tests) do not pull in the settings schema's heavy import chain.
 */
export const AUTOCOMPACT_METHOD_NAMES = [
  'remote',
  'snapcompact',
  'handoff',
  'shake',
  'soft',
] as const satisfies readonly CompactionMethodNameSetting[]

export const AUTOCOMPACT_USAGE =
  'Usage: /autocompact [on|off|threshold <tokens>|percent <1-99>|reserve <tokens>|keep <tokens>|methods <a,b,c>]'

export type AutocompactAction =
  | { kind: 'status' }
  | { kind: 'setEnabled'; enabled: boolean }
  | { kind: 'setThresholdTokens'; tokens: number }
  | { kind: 'setThresholdPercent'; percent: number }
  | { kind: 'setReserveTokens'; tokens: number }
  | { kind: 'setKeepRecentTokens'; tokens: number }
  | { kind: 'setMethodOrder'; methods: CompactionMethodNameSetting[] }
  | { kind: 'invalid'; error: string }

const VALID_METHODS = AUTOCOMPACT_METHOD_NAMES.join(', ')

function invalid(message: string): AutocompactAction {
  return { kind: 'invalid', error: `${message}\n${AUTOCOMPACT_USAGE}` }
}

/** Parse a non-negative decimal integer (no sign, no exponent, no decimals). */
function parseInteger(raw: string): number | null {
  if (!/^\d+$/.test(raw)) return null
  const value = Number(raw)
  return Number.isSafeInteger(value) ? value : null
}

function parsePositiveInteger(
  raw: string,
  label: string,
): number | AutocompactAction {
  const value = parseInteger(raw)
  if (value === null || value <= 0) {
    return invalid(`Invalid ${label} "${raw}": expected a positive integer.`)
  }
  return value
}

function parseMethods(raw: string): AutocompactAction {
  const parts = raw
    .split(',')
    .map(part => part.trim())
    .filter(part => part.length > 0)
  if (parts.length === 0) {
    return invalid(`Missing method names. Valid methods: ${VALID_METHODS}.`)
  }
  const methods: CompactionMethodNameSetting[] = []
  for (const part of parts) {
    if (!(AUTOCOMPACT_METHOD_NAMES as readonly string[]).includes(part)) {
      return invalid(
        `Unknown compaction method "${part}". Valid methods: ${VALID_METHODS}.`,
      )
    }
    const method = part as CompactionMethodNameSetting
    if (!methods.includes(method)) methods.push(method)
  }
  return { kind: 'setMethodOrder', methods }
}

/**
 * Parse the raw slash-command argument string.
 *
 * `""` (or whitespace) means "show status". Every malformed invocation
 * returns `{ kind: 'invalid' }` so the caller can refuse to write settings.
 */
export function parseAutocompactArgs(args: string): AutocompactAction {
  const trimmed = args.trim()
  if (trimmed === '') return { kind: 'status' }

  const separator = trimmed.search(/\s/)
  const verb = (
    separator === -1 ? trimmed : trimmed.slice(0, separator)
  ).toLowerCase()
  const rest = separator === -1 ? '' : trimmed.slice(separator).trim()

  switch (verb) {
    case 'on':
    case 'off': {
      if (rest !== '') {
        return invalid(`Unexpected argument after "${verb}": ${rest}`)
      }
      return { kind: 'setEnabled', enabled: verb === 'on' }
    }
    case 'threshold': {
      if (rest === '') {
        return invalid('Missing token count for "threshold".')
      }
      const tokens = parsePositiveInteger(rest, 'threshold token count')
      if (typeof tokens !== 'number') return tokens
      return { kind: 'setThresholdTokens', tokens }
    }
    case 'percent': {
      if (rest === '') {
        return invalid('Missing percentage for "percent".')
      }
      const percent = parsePositiveInteger(rest, 'threshold percentage')
      if (typeof percent !== 'number') return percent
      if (percent < 1 || percent > 99) {
        return invalid(
          `Invalid threshold percentage "${rest}": expected an integer between 1 and 99.`,
        )
      }
      return { kind: 'setThresholdPercent', percent }
    }
    case 'reserve': {
      if (rest === '') {
        return invalid('Missing token count for "reserve".')
      }
      const tokens = parsePositiveInteger(rest, 'reserve token count')
      if (typeof tokens !== 'number') return tokens
      return { kind: 'setReserveTokens', tokens }
    }
    case 'keep': {
      if (rest === '') {
        return invalid('Missing token count for "keep".')
      }
      const tokens = parseInteger(rest)
      if (tokens === null) {
        return invalid(
          `Invalid keep token count "${rest}": expected a non-negative integer.`,
        )
      }
      return { kind: 'setKeepRecentTokens', tokens }
    }
    case 'methods':
      if (rest === '') {
        return invalid(`Missing method names. Valid methods: ${VALID_METHODS}.`)
      }
      return parseMethods(rest)
    default:
      return invalid(`Unknown subcommand "${verb}".`)
  }
}
