// Ported from oh-my-pi (MIT). See THIRD_PARTY_NOTICES.md in this directory.
import type { CompactionMethod, CompactionMethodName } from '../contracts.js'

/** Default fallback order: server-native first, portable summary last. */
export const DEFAULT_METHOD_ORDER: readonly CompactionMethodName[] = [
  'remote',
  'snapcompact',
  'handoff',
  'shake',
  'soft',
]

const VALID_METHODS: Record<CompactionMethodName, true> = {
  remote: true,
  snapcompact: true,
  handoff: true,
  shake: true,
  soft: true,
}

export function isCompactionMethodName(
  value: unknown,
): value is CompactionMethodName {
  return (
    typeof value === 'string' &&
    Object.hasOwn(VALID_METHODS, value as CompactionMethodName)
  )
}

/**
 * Filter malformed entries, preserve first-occurrence order, and fall back to
 * the default chain when the configured list resolves to nothing.
 */
export function resolveMethodOrder(
  order: readonly unknown[] | undefined,
): CompactionMethodName[] {
  const source = order && order.length > 0 ? order : DEFAULT_METHOD_ORDER
  const resolved: CompactionMethodName[] = []
  for (const entry of source) {
    if (isCompactionMethodName(entry) && !resolved.includes(entry)) {
      resolved.push(entry)
    }
  }
  return resolved.length > 0 ? resolved : [...DEFAULT_METHOD_ORDER]
}

export function indexMethods(
  methods: readonly CompactionMethod[],
): Map<CompactionMethodName, CompactionMethod> {
  const index = new Map<CompactionMethodName, CompactionMethod>()
  for (const method of methods) index.set(method.name, method)
  return index
}
