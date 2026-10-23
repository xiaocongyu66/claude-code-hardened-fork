// Ported from oh-my-pi (MIT). See THIRD_PARTY_NOTICES.md in this directory.
// Tokenizer data-directory registry.
//
// Vocabularies are never bundled: they are loaded from `CCH_TOKENIZER_DIR`
// (a directory containing `manifest.json` and the vocabulary files). When
// the directory, the manifest, the matching entry, or the file is missing
// (or the file is malformed), resolution returns `null` and the caller falls
// back to the cl100k native counter / content-adaptive estimate.
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { type HfTokenizer, createHfTokenizer } from './hfTokenizer.js'
import {
  type ManifestEntry,
  type TokenizerFamily,
  type TokenizerManifest,
  parseManifest,
  selectManifestEntry,
} from './manifest.js'
import {
  type PretokenizerName,
  type TiktokenTokenizer,
  createTiktokenTokenizer,
} from './tiktoken.js'

/** Environment variable naming the tokenizer data directory. */
export const TOKENIZER_DIR_ENV = 'CCH_TOKENIZER_DIR'

/** A loaded tokenizer, independent of its on-disk format. */
export interface LoadedTokenizer {
  readonly id: string
  readonly family: TokenizerFamily
  count(text: string): number
  encode(text: string): number[]
}

type Loaded = TiktokenTokenizer | HfTokenizer

const tokenizerCache = new Map<string, LoadedTokenizer | null>()
const manifestCache = new Map<string, TokenizerManifest | null>()

/** The configured data directory, or `null` when unset. */
export function getTokenizerDir(): string | null {
  const raw = process.env[TOKENIZER_DIR_ENV]
  if (raw === undefined) return null
  const trimmed = raw.trim()
  return trimmed.length > 0 ? resolve(trimmed) : null
}

/** Drop all caches (tests, or after changing the data directory). */
export function resetTokenizerCache(): void {
  tokenizerCache.clear()
  manifestCache.clear()
}

/** Load and validate `<dir>/manifest.json`, or `null` when unavailable. */
export function loadManifest(dir: string): TokenizerManifest | null {
  const cached = manifestCache.get(dir)
  if (cached !== undefined) return cached
  let manifest: TokenizerManifest | null = null
  const path = join(dir, 'manifest.json')
  try {
    if (existsSync(path)) {
      manifest = parseManifest(JSON.parse(readFileSync(path, 'utf8')))
    }
  } catch {
    manifest = null
  }
  manifestCache.set(dir, manifest)
  return manifest
}

function loadEntry(dir: string, entry: ManifestEntry): LoadedTokenizer | null {
  const cacheKey = `${dir}\u0000${entry.id}\u0000${entry.format}\u0000${entry.file}\u0000${entry.pretokenizer ?? ''}`
  const cached = tokenizerCache.get(cacheKey)
  if (cached !== undefined) return cached

  let loaded: Loaded | null = null
  try {
    // Manifest paths are untrusted input; never read outside the data dir.
    const root = resolve(dir)
    const filePath = resolve(dir, entry.file)
    if (filePath !== root && !filePath.startsWith(root + sep)) {
      tokenizerCache.set(cacheKey, null)
      return null
    }
    const content = readFileSync(filePath, 'utf8')
    if (entry.format === 'hf') {
      const tokenizer = createHfTokenizer(entry.id, content)
      loaded = tokenizer
    } else {
      const pretokenizer: PretokenizerName = entry.pretokenizer ?? 'cl100k'
      loaded = createTiktokenTokenizer(entry.id, content, pretokenizer)
    }
  } catch {
    loaded = null
  }

  if (loaded === null) {
    tokenizerCache.set(cacheKey, null)
    return null
  }
  const wrapped: LoadedTokenizer = {
    id: entry.id,
    family: entry.family ?? loaded.family,
    count: (text: string) => loaded.count(text),
    encode: (text: string) => loaded.encode(text),
  }
  tokenizerCache.set(cacheKey, wrapped)
  return wrapped
}

/**
 * Resolve the tokenizer for `model` from the configured data directory.
 * Returns `null` whenever any piece is missing; callers must fall back.
 */
export function resolveTokenizer(model: string): LoadedTokenizer | null {
  const dir = getTokenizerDir()
  if (dir === null) return null
  const manifest = loadManifest(dir)
  if (manifest === null) return null
  const entry = selectManifestEntry(manifest, model)
  if (entry === null) return null
  return loadEntry(dir, entry)
}

/** Resolve a manifest entry by tokenizer id (used by tests/tools). */
export function resolveTokenizerById(id: string): LoadedTokenizer | null {
  const dir = getTokenizerDir()
  if (dir === null) return null
  const manifest = loadManifest(dir)
  if (manifest === null) return null
  const entry = manifest.tokenizers.find(candidate => candidate.id === id)
  if (entry === undefined) return null
  return loadEntry(dir, entry)
}
