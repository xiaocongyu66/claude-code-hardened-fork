// Tokenizer manifest and data-driven family selection.
//
// A tokenizer data directory (`CCH_TOKENIZER_DIR`) contains `manifest.json`
// plus the vocabulary files. Nothing here knows model names: an entry's
// optional `models` globs are data from the manifest, and an HF tokenizer's
// family is inferred from its own `pre_tokenizer` patterns. Tiktoken files
// carry no metadata, so their family comes from the manifest's
// `pretokenizer` field.
import type { PretokenizerName } from './tiktoken.js'

export type TokenizerFormat = 'tiktoken' | 'hf'

/** Tokenizer families CCH can count exactly. */
export type TokenizerFamily =
  | 'cl100k'
  | 'o200k'
  | 'kimi'
  | 'deepseek'
  | 'qwen'
  | 'glm'
  | 'unknown'

export interface ManifestEntry {
  /** Stable id reported by `estimateTokens`. */
  id: string
  format: TokenizerFormat
  /** Vocabulary file name, relative to the data directory. */
  file: string
  /** Required for tiktoken files; ignored for HF (patterns are in the file). */
  pretokenizer?: PretokenizerName
  /** Optional override; otherwise inferred for HF and copied for tiktoken. */
  family?: TokenizerFamily
  /** Glob patterns matched against the model id (data, not code). */
  models?: string[]
}

export interface TokenizerManifest {
  version: number
  tokenizers: ManifestEntry[]
}

const FORMATS = new Set<string>(['tiktoken', 'hf'])
const PRETOKENIZERS = new Set<string>(['cl100k', 'o200k', 'kimi'])

/** Validate a parsed `manifest.json`. Throws on malformed data. */
export function parseManifest(raw: unknown): TokenizerManifest {
  if (!raw || typeof raw !== 'object') {
    throw new Error('tokenizer manifest: expected an object')
  }
  const doc = raw as Record<string, unknown>
  const version = doc.version
  if (typeof version !== 'number') {
    throw new Error('tokenizer manifest: missing numeric version')
  }
  const entries = doc.tokenizers
  if (!Array.isArray(entries)) {
    throw new Error('tokenizer manifest: missing tokenizers array')
  }
  const tokenizers: ManifestEntry[] = entries.map((value, index) => {
    if (!value || typeof value !== 'object') {
      throw new Error(`tokenizer manifest: entry ${index} is not an object`)
    }
    const entry = value as Record<string, unknown>
    if (typeof entry.id !== 'string' || entry.id.length === 0) {
      throw new Error(`tokenizer manifest: entry ${index} has no id`)
    }
    if (typeof entry.format !== 'string' || !FORMATS.has(entry.format)) {
      throw new Error(`tokenizer manifest: ${entry.id} has bad format`)
    }
    if (typeof entry.file !== 'string' || entry.file.length === 0) {
      throw new Error(`tokenizer manifest: ${entry.id} has no file`)
    }
    if (
      entry.pretokenizer !== undefined &&
      (typeof entry.pretokenizer !== 'string' ||
        !PRETOKENIZERS.has(entry.pretokenizer))
    ) {
      throw new Error(`tokenizer manifest: ${entry.id} has bad pretokenizer`)
    }
    if (entry.format === 'tiktoken' && entry.pretokenizer === undefined) {
      throw new Error(
        `tokenizer manifest: tiktoken entry ${entry.id} needs a pretokenizer`,
      )
    }
    const models = entry.models
    if (
      models !== undefined &&
      (!Array.isArray(models) ||
        models.some(model => typeof model !== 'string'))
    ) {
      throw new Error(`tokenizer manifest: ${entry.id} has bad models`)
    }
    return {
      id: entry.id,
      format: entry.format as TokenizerFormat,
      file: entry.file,
      pretokenizer: entry.pretokenizer as PretokenizerName | undefined,
      family: entry.family as TokenizerFamily | undefined,
      models: models as string[] | undefined,
    }
  })
  return { version, tokenizers }
}

const globCache = new Map<string, RegExp>()

function globToRegExp(glob: string): RegExp {
  const cached = globCache.get(glob)
  if (cached) return cached
  const source = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.')
  const re = new RegExp(`^${source}$`, 'i')
  globCache.set(glob, re)
  return re
}

/**
 * Pick the first manifest entry whose `models` globs match `model` (full id
 * or the segment after the last `/`), or whose id is exactly `model`.
 */
export function selectManifestEntry(
  manifest: TokenizerManifest,
  model: string,
): ManifestEntry | null {
  const slash = model.lastIndexOf('/')
  const short = slash >= 0 ? model.slice(slash + 1) : model
  for (const entry of manifest.tokenizers) {
    if (entry.id === model) return entry
    if (!entry.models || entry.models.length === 0) continue
    for (const pattern of entry.models) {
      const re = globToRegExp(pattern)
      if (re.test(model) || re.test(short)) return entry
    }
  }
  return null
}

interface HfPreTokenizerNode {
  type?: unknown
  pattern?: unknown
  pretokenizers?: unknown
  normalizers?: unknown
  use_regex?: unknown
}

function asNode(value: unknown): HfPreTokenizerNode | null {
  if (!value || typeof value !== 'object') return null
  return value as HfPreTokenizerNode
}

function splitPattern(node: HfPreTokenizerNode): string | null {
  const pattern = node.pattern
  if (typeof pattern === 'string') return pattern
  if (pattern && typeof pattern === 'object') {
    const regex = (pattern as Record<string, unknown>).Regex
    if (typeof regex === 'string') return regex
  }
  return null
}

/** Flatten the `Split` regexes of an HF `pre_tokenizer` tree. */
export function extractSplitPatterns(preTokenizer: unknown): string[] {
  const node = asNode(preTokenizer)
  if (!node) return []
  if (node.type === 'Sequence' && Array.isArray(node.pretokenizers)) {
    return node.pretokenizers.flatMap(child => extractSplitPatterns(child))
  }
  if (node.type === 'Split') {
    const pattern = splitPattern(node)
    return pattern === null ? [] : [pattern]
  }
  return []
}

/**
 * Infer the family from the pre-tokenizer's regex shapes. This is the
 * data-driven half of family selection: no model names, only the patterns
 * the tokenizer file itself declares.
 */
export function detectFamilyFromPatterns(
  patterns: readonly string[],
  ignoreMerges: boolean,
): TokenizerFamily {
  const joined = patterns.join('\n')
  if (patterns.length >= 3) {
    const [digits, cjk] = patterns
    if (
      digits !== undefined &&
      cjk !== undefined &&
      /\\p\{N\}\{1,3\}/.test(digits) &&
      cjk.includes('一-龥')
    ) {
      return 'deepseek'
    }
  }
  if (/\[\\p\{L\}\\p\{M\}\]\+/.test(joined) && /\\p\{N\}(?!\{)/.test(joined)) {
    return 'qwen'
  }
  if (joined.includes('\\p{Han}') || joined.includes('一-龥')) {
    return 'kimi'
  }
  if (/\[\\p\{Lu\}\\p\{Lt\}\\p\{Lm\}\\p\{Lo\}\\p\{M\}\]/.test(joined)) {
    return 'o200k'
  }
  if (joined.includes('\\p{L}+') && joined.includes('\\p{N}{1,3}')) {
    return ignoreMerges ? 'glm' : 'cl100k'
  }
  return 'unknown'
}

/** Infer the family of a parsed `tokenizer.json` document. */
export function detectFamilyFromTokenizerJson(json: unknown): TokenizerFamily {
  if (!json || typeof json !== 'object') return 'unknown'
  const doc = json as Record<string, unknown>
  const model = asNode(doc.model)
  const ignoreMerges =
    model !== null && (model as Record<string, unknown>).ignore_merges === true
  return detectFamilyFromPatterns(
    extractSplitPatterns(doc.pre_tokenizer),
    ignoreMerges,
  )
}
