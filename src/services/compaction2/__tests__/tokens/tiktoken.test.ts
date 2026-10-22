import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  PRETOKENIZERS,
  createTiktokenTokenizer,
  parseTiktokenVocab,
  splitByRegex,
  utf8ToLatin1,
} from '../../tokens/tiktoken.js'

const FIXTURES = join(import.meta.dir, '..', 'fixtures')
const CONTENT = readFileSync(join(FIXTURES, 'mini-cl100k.tiktoken'), 'utf8')

describe('parseTiktokenVocab', () => {
  test('decodes base64 token bytes and ranks', () => {
    const ranks = parseTiktokenVocab(CONTENT)
    expect(ranks.size).toBe(273)
    expect(ranks.get('a')).toBe(97)
    expect(ranks.get('abc')).toBe(257)
    expect(ranks.get(utf8ToLatin1('中文'))).toBe(272)
  })
})

describe('TiktokenTokenizer (cl100k)', () => {
  const tokenizer = createTiktokenTokenizer('mini-cl100k', CONTENT, 'cl100k')

  test('merges a whole word', () => {
    expect(tokenizer.encode('abc')).toEqual([257])
    expect(tokenizer.count('abc')).toBe(1)
  })

  test('space-prefixed words are single pieces', () => {
    expect(tokenizer.encode('hello world')).toEqual([261, 267])
    expect(tokenizer.count('hello world')).toBe(2)
  })

  test('unmerged bytes stay separate tokens', () => {
    expect(tokenizer.encode('ab cd')).toEqual([256, 32, 99, 100])
    expect(tokenizer.count('ab cd')).toBe(4)
  })

  test('digits are pre-tokenized in groups of at most three', () => {
    expect(tokenizer.encode('1234')).toEqual([49, 50, 51, 52])
  })

  test('CJK merges across UTF-8 bytes', () => {
    expect(tokenizer.encode('中文')).toEqual([272])
  })

  test('whitespace runs follow the tiktoken trio', () => {
    expect(tokenizer.encode('a  b')).toEqual([97, 32, 32, 98])
  })

  test('empty text has no tokens', () => {
    expect(tokenizer.count('')).toBe(0)
    expect(tokenizer.encode('')).toEqual([])
  })
})

describe('TiktokenTokenizer (kimi)', () => {
  const tokenizer = createTiktokenTokenizer('mini-kimi', CONTENT, 'kimi')

  test('Han runs are isolated before letter runs', () => {
    expect(splitByRegex(PRETOKENIZERS.kimi, '中文abc')).toEqual(['中文', 'abc'])
    expect(splitByRegex(PRETOKENIZERS.cl100k, '中文abc')).toEqual(['中文abc'])
    expect(tokenizer.encode('中文abc')).toEqual([272, 257])
    expect(tokenizer.count('中文abc')).toBe(2)
  })

  test('kimi pattern keeps Han out of the letter cores', () => {
    // U+3007 〇 is Script=Han; it must be its own Han run.
    expect(splitByRegex(PRETOKENIZERS.kimi, 'a〇b')).toEqual(['a', '〇', 'b'])
  })
})

describe('PRETOKENIZERS', () => {
  test('o200k splits case changes like the reference pattern', () => {
    expect(splitByRegex(PRETOKENIZERS.o200k, 'helloWORLD')).toEqual([
      'hello',
      'WORLD',
    ])
  })
})
