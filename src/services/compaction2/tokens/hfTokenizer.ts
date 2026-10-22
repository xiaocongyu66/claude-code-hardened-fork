// Ported from oh-my-pi (MIT). See THIRD_PARTY_NOTICES.md in this directory.
// HuggingFace `tokenizer.json` BPE tokenizers (DeepSeek, GLM, Qwen, ...).
//
// Supported shape: `model.type === "BPE"` with byte-level vocabulary keys,
// an optional NFC/NFD/NFKC/NFKD normalizer, and a pre-tokenizer made of
// `Split` stages (HF `Isolated` semantics) optionally followed by
// `ByteLevel`. Vocabulary keys are kept in the GPT-2 byte-level alphabet,
// exactly as HF stores them, so merges run on the same strings the reference
// implementation uses. `ignore_merges` is honoured (GLM-5).
//
// `Split` patterns are read from the file, not hardcoded. They are rewritten
// for JavaScript: `(?i:...)` becomes explicit case pairs, `\p{Han}` becomes
// `\p{Script=Han}`, and class intersection (`&&[^...]`) becomes a negative
// lookahead. Anything outside this subset throws, and the registry falls
// back to the cl100k/adaptive estimator.
import {
  type TokenizerFamily,
  detectFamilyFromTokenizerJson,
  extractSplitPatterns,
} from './manifest.js'
import { splitByRegex } from './tiktoken.js'

const INFINITY = Number.POSITIVE_INFINITY

type NormalizerName = 'NFC' | 'NFD' | 'NFKC' | 'NFKD'

const NORMALIZERS = new Set<string>(['NFC', 'NFD', 'NFKC', 'NFKD'])

interface HfBpeModel {
  type?: unknown
  vocab?: unknown
  merges?: unknown
  ignore_merges?: unknown
}

/** Build the GPT-2 `bytes_to_unicode` table (byte → mapped character). */
function buildBytesToUnicode(): string[] {
  const bytes: number[] = []
  for (let i = 0x21; i <= 0x7e; i++) bytes.push(i)
  for (let i = 0xa1; i <= 0xac; i++) bytes.push(i)
  for (let i = 0xae; i <= 0xff; i++) bytes.push(i)
  const codepoints = bytes.slice()
  const seen = new Set(bytes)
  let n = 0
  for (let b = 0; b < 256; b++) {
    if (!seen.has(b)) {
      bytes.push(b)
      codepoints.push(256 + n)
      n += 1
    }
  }
  const table = new Array<string>(256)
  for (let i = 0; i < bytes.length; i++) {
    table[bytes[i]] = String.fromCodePoint(codepoints[i])
  }
  return table
}

const BYTES_TO_UNICODE = buildBytesToUnicode()

/** Map a text's UTF-8 bytes into the byte-level alphabet. */
export function byteLevelEncode(text: string): string {
  const bytes = Buffer.from(text, 'utf8')
  const chars = new Array<string>(bytes.length)
  for (let i = 0; i < bytes.length; i++) {
    chars[i] = BYTES_TO_UNICODE[bytes[i]]
  }
  return chars.join('')
}

/**
 * Rewrite an HF regex into a JavaScript-compatible one. Only the constructs
 * the supported families use are handled; callers treat a throw as
 * "unsupported tokenizer".
 */
export function translateHfPattern(pattern: string): string {
  let out = pattern.replace(
    /\(\?i:((?:[^()\\]|\\.)*)\)/g,
    (_match, inner: string) => {
      let expanded = ''
      for (const ch of inner) {
        expanded += /[a-zA-Z]/.test(ch)
          ? `[${ch.toLowerCase()}${ch.toUpperCase()}]`
          : ch
      }
      return `(?:${expanded})`
    },
  )
  if (out.includes('(?i:')) {
    throw new Error('hf tokenizer: unsupported nested inline flags')
  }
  out = out.replace(/\\p\{Han\}/g, String.raw`\p{Script=Han}`)
  // `[A&&[^B]]` (single-codepoint class intersection) → `(?:(?!B)[A])`.
  out = out.replace(/\[([^[\]]*)&&\[\^([^[\]]*)\]\]/g, '((?!(?:$2))[$1])')
  return out
}

/**
 * Reject pre-tokenizer stages we cannot reproduce exactly, instead of
 * silently counting with the wrong rules.
 */
function assertSupportedPreTokenizer(node: unknown): void {
  if (node === null || node === undefined) return
  if (typeof node !== 'object') {
    throw new Error('hf tokenizer: malformed pre_tokenizer')
  }
  const stage = node as Record<string, unknown>
  switch (stage.type) {
    case 'Sequence':
      if (!Array.isArray(stage.pretokenizers)) {
        throw new Error('hf tokenizer: malformed Sequence pre_tokenizer')
      }
      for (const child of stage.pretokenizers) {
        assertSupportedPreTokenizer(child)
      }
      return
    case 'Split': {
      if (stage.behavior !== undefined && stage.behavior !== 'Isolated') {
        throw new Error(
          `hf tokenizer: unsupported Split behavior ${String(stage.behavior)}`,
        )
      }
      if (stage.invert === true) {
        throw new Error('hf tokenizer: inverted Split unsupported')
      }
      return
    }
    case 'ByteLevel':
      if (stage.use_regex === true) {
        throw new Error('hf tokenizer: ByteLevel use_regex unsupported')
      }
      return
    default:
      throw new Error(
        `hf tokenizer: unsupported pre_tokenizer ${String(stage.type)}`,
      )
  }
}

function compileSplitters(preTokenizer: unknown): RegExp[] {
  assertSupportedPreTokenizer(preTokenizer)
  const patterns = extractSplitPatterns(preTokenizer)
  const splitters: RegExp[] = []
  for (const pattern of patterns) {
    const translated = translateHfPattern(pattern)
    try {
      splitters.push(new RegExp(translated, 'gu'))
    } catch (error) {
      throw new Error(
        `hf tokenizer: unsupported split pattern ${JSON.stringify(pattern)}`,
        { cause: error },
      )
    }
  }
  return splitters
}

function readNormalizer(node: unknown): NormalizerName | null {
  if (node === null || node === undefined) return null
  if (typeof node !== 'object') {
    throw new Error('hf tokenizer: malformed normalizer')
  }
  const normalizer = node as Record<string, unknown>
  const type = normalizer.type
  if (typeof type !== 'string') {
    throw new Error('hf tokenizer: normalizer without type')
  }
  if (NORMALIZERS.has(type)) return type as NormalizerName
  if (type === 'Sequence' && Array.isArray(normalizer.normalizers)) {
    let found: NormalizerName | null = null
    for (const child of normalizer.normalizers) {
      const childName = readNormalizer(child)
      if (childName === null) continue
      if (found !== null && found !== childName) {
        throw new Error('hf tokenizer: multiple normalizers unsupported')
      }
      found = childName
    }
    return found
  }
  throw new Error(`hf tokenizer: unsupported normalizer ${type}`)
}

function parseMerges(raw: unknown): Array<[string, string]> {
  if (!Array.isArray(raw)) {
    throw new Error('hf tokenizer: model.merges is missing')
  }
  const merges: Array<[string, string]> = []
  for (const merge of raw) {
    if (Array.isArray(merge) && merge.length === 2) {
      const [left, right] = merge
      if (typeof left === 'string' && typeof right === 'string') {
        merges.push([left, right])
        continue
      }
    }
    if (typeof merge === 'string') {
      const space = merge.indexOf(' ')
      if (space > 0) {
        merges.push([merge.slice(0, space), merge.slice(space + 1)])
        continue
      }
    }
    throw new Error('hf tokenizer: malformed merge entry')
  }
  return merges
}

function parseVocab(raw: unknown): Map<string, number> {
  if (!raw || typeof raw !== 'object') {
    throw new Error('hf tokenizer: model.vocab is missing')
  }
  const vocab = new Map<string, number>()
  for (const [token, id] of Object.entries(raw)) {
    if (typeof id !== 'number' || !Number.isInteger(id)) {
      throw new Error(`hf tokenizer: bad id for token ${JSON.stringify(token)}`)
    }
    vocab.set(token, id)
  }
  if (vocab.size === 0) {
    throw new Error('hf tokenizer: empty vocabulary')
  }
  return vocab
}

/** Merge key: byte-level symbols never contain U+0000, so it is a safe separator. */
function pairKey(left: string, right: string): string {
  return `${left}\u0000${right}`
}

/**
 * HF BPE merge loop: repeatedly merge every occurrence of the adjacent pair
 * with the lowest merge rank, then return the final symbols.
 */
function mergeSymbols(
  mapped: string,
  pairRanks: Map<string, number>,
): string[] {
  let symbols = Array.from(mapped)
  while (symbols.length > 1) {
    let bestRank = INFINITY
    let bestLeft = ''
    let bestRight = ''
    for (let i = 0; i + 1 < symbols.length; i++) {
      const rank = pairRanks.get(pairKey(symbols[i], symbols[i + 1]))
      if (rank !== undefined && rank < bestRank) {
        bestRank = rank
        bestLeft = symbols[i]
        bestRight = symbols[i + 1]
      }
    }
    if (bestRank === INFINITY) break

    const merged = bestLeft + bestRight
    const next: string[] = []
    for (let i = 0; i < symbols.length; ) {
      if (
        i + 1 < symbols.length &&
        symbols[i] === bestLeft &&
        symbols[i + 1] === bestRight
      ) {
        next.push(merged)
        i += 2
      } else {
        next.push(symbols[i])
        i += 1
      }
    }
    symbols = next
  }
  return symbols
}

interface HfTokenizerJson {
  normalizer?: unknown
  pre_tokenizer?: unknown
  model?: HfBpeModel
}

/** A loaded HuggingFace BPE tokenizer. */
export class HfTokenizer {
  readonly family: TokenizerFamily
  private readonly vocab: Map<string, number>
  private readonly pairRanks = new Map<string, number>()
  private readonly splitters: RegExp[]
  private readonly normalizer: NormalizerName | null
  private readonly ignoreMerges: boolean

  constructor(
    readonly id: string,
    json: HfTokenizerJson,
  ) {
    const model = json.model
    if (!model || model.type !== 'BPE') {
      throw new Error(
        `hf tokenizer: ${id} model.type is not BPE (${String(model?.type)})`,
      )
    }
    this.vocab = parseVocab(model.vocab)
    parseMerges(model.merges).forEach(([left, right], rank) => {
      this.pairRanks.set(pairKey(left, right), rank)
    })
    this.splitters = compileSplitters(json.pre_tokenizer)
    this.normalizer = readNormalizer(json.normalizer)
    this.ignoreMerges = model.ignore_merges === true
    this.family = detectFamilyFromTokenizerJson(json)
  }

  private split(text: string): string[] {
    const normalized = this.normalizer ? text.normalize(this.normalizer) : text
    let pieces = [normalized]
    for (const splitter of this.splitters) {
      const next: string[] = []
      for (const piece of pieces) {
        next.push(...splitByRegex(splitter, piece))
      }
      pieces = next
    }
    return pieces
  }

  private symbols(piece: string): string[] {
    const mapped = byteLevelEncode(piece)
    if (this.ignoreMerges && this.vocab.has(mapped)) {
      return [mapped]
    }
    return mergeSymbols(mapped, this.pairRanks)
  }

  /** Token ids for `text` (ordinary encoding, no added/special tokens). */
  encode(text: string): number[] {
    const ids: number[] = []
    for (const piece of this.split(text)) {
      for (const symbol of this.symbols(piece)) {
        const id = this.vocab.get(symbol)
        if (id === undefined) {
          throw new Error(
            `hf tokenizer ${this.id}: symbol ${JSON.stringify(symbol)} not in vocab`,
          )
        }
        ids.push(id)
      }
    }
    return ids
  }

  /** Token count for `text`. */
  count(text: string): number {
    let total = 0
    for (const piece of this.split(text)) {
      total += this.symbols(piece).length
    }
    return total
  }
}

/** Build a tokenizer from the raw contents of a `tokenizer.json` file. */
export function createHfTokenizer(id: string, content: string): HfTokenizer {
  return new HfTokenizer(id, JSON.parse(content) as HfTokenizerJson)
}
