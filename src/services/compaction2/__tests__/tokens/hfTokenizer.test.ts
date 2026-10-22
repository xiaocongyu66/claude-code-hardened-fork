import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  byteLevelEncode,
  createHfTokenizer,
  translateHfPattern,
} from '../../tokens/hfTokenizer.js'

const FIXTURES = join(import.meta.dir, '..', 'fixtures')

function load(name: string) {
  return createHfTokenizer(name, readFileSync(join(FIXTURES, name), 'utf8'))
}

describe('HfTokenizer (cl100k-shaped pre-tokenizer)', () => {
  const tokenizer = load('mini-hf.tokenizer.json')

  test('detects the family from the pre_tokenizer pattern', () => {
    expect(tokenizer.family).toBe('cl100k')
  })

  test('runs BPE merges over byte-level symbols', () => {
    expect(tokenizer.encode('abc hello')).toEqual([257, 262])
    expect(tokenizer.count('abc hello')).toBe(2)
  })

  test('merge-unreachable vocab entries are never whole-piece matched', () => {
    expect(tokenizer.encode('zz')).toEqual([122, 122])
    expect(tokenizer.count('zz')).toBe(2)
  })

  test('does not normalize without a normalizer', () => {
    // "e" + combining acute: three byte-level tokens, not the precomposed é.
    expect(tokenizer.count('e\u0301')).toBe(3)
  })
})

describe('HfTokenizer (ignore_merges)', () => {
  const tokenizer = load('mini-hf-ignore.tokenizer.json')

  test('whole-piece vocabulary hits bypass merges', () => {
    expect(tokenizer.family).toBe('glm')
    expect(tokenizer.encode('zz')).toEqual([267])
    expect(tokenizer.count('zz')).toBe(1)
  })

  test('non-vocabulary pieces still merge', () => {
    expect(tokenizer.encode('zzz')).toEqual([122, 122, 122])
  })
})

describe('HfTokenizer (NFC normalizer + qwen pattern)', () => {
  const tokenizer = load('mini-hf-nfc.tokenizer.json')

  test('detects the qwen family', () => {
    expect(tokenizer.family).toBe('qwen')
  })

  test('normalizes before pre-tokenization', () => {
    expect(tokenizer.encode('e\u0301')).toEqual([263])
    expect(tokenizer.count('e\u0301')).toBe(1)
  })
})

describe('HfTokenizer (multi-stage Split chain)', () => {
  test('deepseek digit stage isolates runs of at most three', () => {
    const tokenizer = load('mini-hf-deepseek.tokenizer.json')
    expect(tokenizer.family).toBe('deepseek')
    // Stage 1: "123" | "4" → [12]+3, then 4.
    expect(tokenizer.encode('1234')).toEqual([265, 51, 52])
    expect(tokenizer.count('1234')).toBe(3)
  })

  test('the same text without the digit stage merges across it', () => {
    const tokenizer = load('mini-hf-main-only.tokenizer.json')
    // One gap piece "1234" → 12 + 34.
    expect(tokenizer.encode('1234')).toEqual([265, 266])
    expect(tokenizer.count('1234')).toBe(2)
  })
})

describe('translateHfPattern', () => {
  test('expands inline case-insensitive groups', () => {
    expect(translateHfPattern("(?i:'s|'t)")).toBe("(?:'[sS]|'[tT])")
  })

  test('rewrites Script=Han and class intersection for JS', () => {
    const translated = translateHfPattern(
      String.raw`\p{Han}+|[\p{Lu}\p{Lm}&&[^\p{Han}]]+`,
    )
    expect(translated).toContain(String.raw`\p{Script=Han}+`)
    expect(translated).toContain(
      String.raw`((?!(?:\p{Script=Han}))[\p{Lu}\p{Lm}])+`,
    )
    expect(() => new RegExp(translated, 'gu')).not.toThrow()
  })
})

describe('byteLevelEncode', () => {
  test('maps space and non-ASCII bytes into the GPT-2 alphabet', () => {
    expect(byteLevelEncode(' ')).toBe('Ġ')
    expect(byteLevelEncode('é')).toBe('Ã©')
  })
})

describe('unsupported tokenizer shapes', () => {
  test('rejects non-BPE models', () => {
    expect(() =>
      createHfTokenizer(
        'wordpiece',
        JSON.stringify({
          model: { type: 'WordPiece', vocab: { a: 0 }, merges: [] },
        }),
      ),
    ).toThrow('not BPE')
  })

  test('rejects unsupported pre-tokenizer stages', () => {
    expect(() =>
      createHfTokenizer(
        'metaspace',
        JSON.stringify({
          pre_tokenizer: { type: 'Metaspace' },
          model: {
            type: 'BPE',
            vocab: { a: 0 },
            merges: [['a', 'a']],
          },
        }),
      ),
    ).toThrow('unsupported pre_tokenizer')
  })
})
