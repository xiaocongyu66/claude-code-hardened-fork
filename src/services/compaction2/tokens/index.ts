// Real-tokenizer layer for compaction v2.
//
// `estimateTokens` uses an exact tokenizer from `CCH_TOKENIZER_DIR` when the
// model resolves through the manifest. Otherwise it degrades gracefully:
// first to the existing native cl100k BPE (`token-counter-napi`, the same
// engine behind `countTokensPrecise`), then to a content-adaptive estimate.
// Both fallbacks report `exact: false`.
import { createRequire } from 'node:module'
import { resolveTokenizer } from './registry.js'

export { resetTokenizerCache, TOKENIZER_DIR_ENV } from './registry.js'
export type { LoadedTokenizer } from './registry.js'
export type {
  ManifestEntry,
  TokenizerFamily,
  TokenizerFormat,
  TokenizerManifest,
} from './manifest.js'
export { parseManifest, selectManifestEntry } from './manifest.js'
export type { PretokenizerName } from './tiktoken.js'
export { TiktokenTokenizer, createTiktokenTokenizer } from './tiktoken.js'
export { HfTokenizer, createHfTokenizer } from './hfTokenizer.js'

export interface TokenEstimate {
  tokens: number
  /** Tokenizer id, or the fallback strategy name. */
  tokenizer: string
  /** True only when a real vocabulary was used. */
  exact: boolean
}

/**
 * Content-adaptive fallback used when neither a data-directory tokenizer nor
 * the native cl100k module is available. Latin text averages ~4 characters
 * per token; CJK is closer to 1.5; everything else sits in between.
 */
export function contentAdaptiveEstimate(text: string): number {
  let ascii = 0
  let cjk = 0
  let other = 0
  for (const char of text) {
    const codePoint = char.codePointAt(0) ?? 0
    if (codePoint < 0x80) {
      ascii += 1
    } else if (isCjk(codePoint)) {
      cjk += 1
    } else {
      other += 1
    }
  }
  const estimate = ascii / 4 + cjk / 1.5 + other / 3
  return Math.max(1, Math.round(estimate))
}

type NativeCountTokens = (text: string) => number | null

let nativeCountTokens: NativeCountTokens | null | undefined

/**
 * Lazily resolve `token-counter-napi` (the cl100k engine behind
 * `countTokensPrecise`). The require is dynamic so this module stays
 * loadable in environments where the workspace package is not installed;
 * the fallback chain simply continues to the adaptive estimate.
 */
function getNativeCountTokens(): NativeCountTokens | null {
  if (nativeCountTokens !== undefined) return nativeCountTokens
  let resolved: NativeCountTokens | null = null
  try {
    const specifier = 'token-counter-napi'
    const mod = createRequire(import.meta.url)(specifier) as {
      nativeCountTokens?: NativeCountTokens
    }
    if (typeof mod.nativeCountTokens === 'function') {
      resolved = mod.nativeCountTokens
    }
  } catch {
    resolved = null
  }
  nativeCountTokens = resolved
  return resolved
}

function isCjk(codePoint: number): boolean {
  return (
    (codePoint >= 0x3000 && codePoint <= 0x30ff) ||
    (codePoint >= 0x3400 && codePoint <= 0x4dbf) ||
    (codePoint >= 0x4e00 && codePoint <= 0x9fff) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7af) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0x20000 && codePoint <= 0x2fa1f)
  )
}

/**
 * Estimate the token count of `text` for `model`.
 *
 * When a tokenizer is configured for the model, the count is exact for that
 * vocabulary (`exact: true`). Otherwise the cl100k native counter or the
 * content-adaptive estimate is returned with `exact: false`.
 */
export function estimateTokens(text: string, model: string): TokenEstimate {
  if (text.length === 0) {
    return { tokens: 0, tokenizer: 'empty', exact: true }
  }

  const tokenizer = resolveTokenizer(model)
  if (tokenizer !== null) {
    return {
      tokens: tokenizer.count(text),
      tokenizer: tokenizer.id,
      exact: true,
    }
  }

  const nativeCounter = getNativeCountTokens()
  if (nativeCounter !== null) {
    let native: number | null = null
    try {
      native = nativeCounter(text)
    } catch {
      native = null
    }
    if (native !== null) {
      return { tokens: native, tokenizer: 'cl100k-fallback', exact: false }
    }
  }

  return {
    tokens: contentAdaptiveEstimate(text),
    tokenizer: 'adaptive',
    exact: false,
  }
}
