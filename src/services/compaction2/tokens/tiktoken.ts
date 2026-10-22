// tiktoken-format BPE tokenizers (cl100k_base, o200k_base, kimi).
//
// The file format is one `base64(token bytes) rank` pair per line, exactly
// what `openai/tiktoken` downloads and what oh-my-pi ships for Kimi. Merge
// priority is the rank: the tiktoken `byte_pair_merge` algorithm repeatedly
// merges the adjacent pair whose concatenation has the lowest rank.
//
// Pre-tokenization is family-specific and has no representation in the
// tiktoken file, so the family (cl100k / o200k / kimi) is supplied by the
// manifest entry. The patterns below are hand-ports of the reference
// regexes; JavaScript's `u`-flag Unicode property escapes cover them
// directly, including the Kimi Han-set subtraction (rewritten with a
// negative lookahead because JS character classes have no `&&`).

/** Pre-tokenizer families shipped with CCH. */
export type PretokenizerName = 'cl100k' | 'o200k' | 'kimi'

/** Case-insensitive contraction suffix `(?i:'s|'t|'re|'ve|'m|'ll|'d)`. */
const CONTRACTION_CI = `(?:'[sS]|'[tT]|'[rR][eE]|'[vV][eE]|'[mM]|'[lL][lL]|'[dD])`

const UPPER = String.raw`[\p{Lu}\p{Lt}\p{Lm}\p{Lo}\p{M}]`
const LOWER = String.raw`[\p{Ll}\p{Lm}\p{Lo}\p{M}]`

// Kimi's `[\p{Lu}\p{Lt}\p{Lm}\p{Lo}\p{M}&&[^\p{Han}]]` cannot be written as
// a JS character class; a per-codepoint negative lookahead is equivalent.
const UPPER_NO_HAN = String.raw`(?:(?!\p{Script=Han})${UPPER})`
const LOWER_NO_HAN = String.raw`(?:(?!\p{Script=Han})${LOWER})`

const CL100K_PATTERN =
  `${CONTRACTION_CI}` +
  String.raw`|[^\r\n\p{L}\p{N}]?\p{L}+` +
  String.raw`|\p{N}{1,3}` +
  String.raw`| ?[^\s\p{L}\p{N}]+[\r\n]*` +
  String.raw`|\s*[\r\n]+|\s+(?!\S)|\s+`

const O200K_PATTERN =
  String.raw`[^\r\n\p{L}\p{N}]?${UPPER}*${LOWER}+${CONTRACTION_CI}?` +
  String.raw`|[^\r\n\p{L}\p{N}]?${UPPER}+${LOWER}*${CONTRACTION_CI}?` +
  String.raw`|\p{N}{1,3}` +
  String.raw`| ?[^\s\p{L}\p{N}]+[\r\n/]*` +
  String.raw`|\s*[\r\n]+|\s+(?!\S)|\s+`

const KIMI_PATTERN =
  String.raw`\p{Script=Han}+` +
  String.raw`|[^\r\n\p{L}\p{N}]?${UPPER_NO_HAN}*${LOWER_NO_HAN}+${CONTRACTION_CI}?` +
  String.raw`|[^\r\n\p{L}\p{N}]?${UPPER_NO_HAN}+${LOWER_NO_HAN}*${CONTRACTION_CI}?` +
  String.raw`|\p{N}{1,3}` +
  String.raw`| ?[^\s\p{L}\p{N}]+[\r\n]*` +
  String.raw`|\s*[\r\n]+|\s+(?!\S)|\s+`

/** Compiled pre-tokenizer regexes, one per family. */
export const PRETOKENIZERS: Record<PretokenizerName, RegExp> = {
  cl100k: new RegExp(CL100K_PATTERN, 'gu'),
  o200k: new RegExp(O200K_PATTERN, 'gu'),
  kimi: new RegExp(KIMI_PATTERN, 'gu'),
}

/**
 * HF `Split(Isolated)` semantics: every regex match becomes a piece and the
 * unmatched gaps survive as pieces too. Patterns never match the empty
 * string, so an empty match would be a bug; skip it defensively instead of
 * looping forever.
 */
export function splitByRegex(re: RegExp, text: string): string[] {
  const pieces: string[] = []
  let last = 0
  re.lastIndex = 0
  for (;;) {
    const match = re.exec(text)
    if (match === null) break
    if (match[0].length === 0) {
      re.lastIndex += 1
      continue
    }
    if (match.index > last) pieces.push(text.slice(last, match.index))
    pieces.push(match[0])
    last = match.index + match[0].length
  }
  if (last < text.length) pieces.push(text.slice(last))
  return pieces
}

/** UTF-8 encode and view the bytes as one latin-1 character per byte. */
export function utf8ToLatin1(text: string): string {
  return Buffer.from(text, 'utf8').toString('latin1')
}

/** Decode a tiktoken vocabulary file into a token-bytes → rank map. */
export function parseTiktokenVocab(content: string): Map<string, number> {
  const ranks = new Map<string, number>()
  for (const line of content.split('\n')) {
    if (line.length === 0) continue
    const space = line.indexOf(' ')
    if (space <= 0) continue
    const rank = Number(line.slice(space + 1))
    if (!Number.isInteger(rank) || rank < 0) continue
    const token = Buffer.from(line.slice(0, space), 'base64').toString('latin1')
    ranks.set(token, rank)
  }
  return ranks
}

const INFINITY = Number.POSITIVE_INFINITY

/**
 * tiktoken's `byte_pair_merge`: repeatedly merge the adjacent pair with the
 * lowest rank, then return the final `[start, end)` spans. The linear rescan
 * is the reference algorithm; pre-tokenized pieces are short, so it is the
 * right trade-off here.
 */
function mergeSpans(
  piece: string,
  rankOf: (span: string) => number | undefined,
): Array<[number, number]> {
  const len = piece.length
  if (len === 0) return []
  if (len === 1) return [[0, 1]]

  // parts[k] = (start offset, rank of merging part k with part k+1).
  const parts: Array<[number, number]> = []
  let minRank = INFINITY
  let minIndex = -1
  for (let i = 0; i < len - 1; i++) {
    const rank = rankOf(piece.slice(i, i + 2)) ?? INFINITY
    if (rank < minRank) {
      minRank = rank
      minIndex = i
    }
    parts.push([i, rank])
  }
  parts.push([len - 1, INFINITY])
  parts.push([len, INFINITY])

  const getRank = (k: number): number => {
    if (k + 3 >= parts.length) return INFINITY
    return rankOf(piece.slice(parts[k][0], parts[k + 3][0])) ?? INFINITY
  }

  while (minRank !== INFINITY) {
    const i = minIndex
    if (i > 0) parts[i - 1][1] = getRank(i - 1)
    parts[i][1] = getRank(i)
    parts.splice(i + 1, 1)

    minRank = INFINITY
    minIndex = -1
    for (let k = 0; k < parts.length - 1; k++) {
      if (parts[k][1] < minRank) {
        minRank = parts[k][1]
        minIndex = k
      }
    }
  }

  const spans: Array<[number, number]> = []
  for (let k = 0; k + 1 < parts.length; k++) {
    spans.push([parts[k][0], parts[k + 1][0]])
  }
  return spans
}

/**
 * A loaded tiktoken-format tokenizer. `encode` returns the token ranks (the
 * vocabulary ids) for debugging/fixtures; `count` avoids materializing ids.
 */
export class TiktokenTokenizer {
  constructor(
    readonly id: string,
    readonly family: PretokenizerName,
    private readonly ranks: Map<string, number>,
  ) {}

  private rankOf = (span: string): number | undefined => this.ranks.get(span)

  private encodePiece(piece: string): number[] {
    const bytes = utf8ToLatin1(piece)
    const ids: number[] = []
    for (const [start, end] of mergeSpans(bytes, this.rankOf)) {
      const rank = this.ranks.get(bytes.slice(start, end))
      if (rank !== undefined) ids.push(rank)
    }
    return ids
  }

  /** Token ids for `text` (ordinary encoding, no special tokens). */
  encode(text: string): number[] {
    const ids: number[] = []
    for (const piece of splitByRegex(PRETOKENIZERS[this.family], text)) {
      ids.push(...this.encodePiece(piece))
    }
    return ids
  }

  /** Token count for `text`, without materializing the id list. */
  count(text: string): number {
    let total = 0
    for (const piece of splitByRegex(PRETOKENIZERS[this.family], text)) {
      total += mergeSpans(utf8ToLatin1(piece), this.rankOf).length
    }
    return total
  }
}

/** Build a tokenizer from the raw contents of a `.tiktoken` file. */
export function createTiktokenTokenizer(
  id: string,
  content: string,
  pretokenizer: PretokenizerName,
): TiktokenTokenizer {
  const ranks = parseTiktokenVocab(content)
  if (ranks.size === 0) {
    throw new Error(`tiktoken: ${id} has no vocabulary entries`)
  }
  return new TiktokenTokenizer(id, pretokenizer, ranks)
}
