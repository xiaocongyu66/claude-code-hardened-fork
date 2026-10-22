import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  detectFamilyFromPatterns,
  detectFamilyFromTokenizerJson,
  extractSplitPatterns,
  parseManifest,
  selectManifestEntry,
} from '../../tokens/manifest.js'

const FIXTURES = join(import.meta.dir, '..', 'fixtures')

function readJson(name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURES, name), 'utf8'))
}

const MANIFEST = parseManifest(readJson('manifest.json'))

describe('parseManifest', () => {
  test('accepts the fixture manifest', () => {
    expect(MANIFEST.version).toBe(1)
    expect(MANIFEST.tokenizers.length).toBe(8)
  })

  test('rejects a manifest without a version', () => {
    expect(() => parseManifest({ tokenizers: [] })).toThrow('version')
  })

  test('requires a pretokenizer for tiktoken entries', () => {
    expect(() =>
      parseManifest({
        version: 1,
        tokenizers: [{ id: 'x', format: 'tiktoken', file: 'x.tiktoken' }],
      }),
    ).toThrow('pretokenizer')
  })

  test('rejects unknown formats', () => {
    expect(() =>
      parseManifest({
        version: 1,
        tokenizers: [{ id: 'x', format: 'sentencepiece', file: 'x' }],
      }),
    ).toThrow('format')
  })
})

describe('selectManifestEntry', () => {
  test('matches model globs (data-driven)', () => {
    expect(selectManifestEntry(MANIFEST, 'mini/hf-basic-large')?.id).toBe(
      'mini-hf',
    )
    expect(selectManifestEntry(MANIFEST, 'mini/cl100k-test')?.id).toBe(
      'mini-cl100k',
    )
  })

  test('matches the short model segment after a provider prefix', () => {
    const manifest = parseManifest({
      version: 1,
      tokenizers: [
        {
          id: 'kimi',
          format: 'tiktoken',
          file: 'kimi.tiktoken',
          pretokenizer: 'kimi',
          models: ['kimi-*'],
        },
      ],
    })
    expect(selectManifestEntry(manifest, 'provider/kimi-v2')?.id).toBe('kimi')
  })

  test('matches an exact tokenizer id', () => {
    expect(selectManifestEntry(MANIFEST, 'mini-hf-nfc')?.id).toBe('mini-hf-nfc')
  })

  test('returns null when nothing matches', () => {
    expect(selectManifestEntry(MANIFEST, 'other/model')).toBeNull()
  })
})

describe('extractSplitPatterns', () => {
  test('flattens Sequence/Split nodes', () => {
    const doc = readJson('mini-hf-deepseek.tokenizer.json') as {
      pre_tokenizer: unknown
    }
    const patterns = extractSplitPatterns(doc.pre_tokenizer)
    expect(patterns.length).toBe(3)
    expect(patterns[0]).toBe(String.raw`\p{N}{1,3}`)
    expect(patterns[1]).toContain('一-龥')
  })
})

describe('detectFamilyFromPatterns', () => {
  const cl100k = String.raw`(?i:'s|'t)|[^\r\n\p{L}\p{N}]?\p{L}+|\p{N}{1,3}| ?[^\s\p{L}\p{N}]+|\s+`
  const o200k = String.raw`[^\r\n\p{L}\p{N}]?[\p{Lu}\p{Lt}\p{Lm}\p{Lo}\p{M}]*[\p{Ll}\p{Lm}\p{Lo}\p{M}]+|\p{N}{1,3}`
  const qwen = String.raw`[^\r\n\p{L}\p{N}]?[\p{L}\p{M}]+|\p{N}| ?[^\s\p{L}\p{M}\p{N}]+`
  const kimi = String.raw`[\p{Han}]+|\p{N}{1,3}`

  test('classifies the known pattern shapes', () => {
    expect(detectFamilyFromPatterns([cl100k], false)).toBe('cl100k')
    expect(detectFamilyFromPatterns([cl100k], true)).toBe('glm')
    expect(detectFamilyFromPatterns([o200k], false)).toBe('o200k')
    expect(detectFamilyFromPatterns([qwen], false)).toBe('qwen')
    expect(detectFamilyFromPatterns([kimi], false)).toBe('kimi')
  })

  test('deepseek is the three-stage chain, not just its main pattern', () => {
    const deepseek = [
      String.raw`\p{N}{1,3}`,
      '[一-龥぀-ゟ゠-ヿ]+',
      String.raw`[^\r\n\p{L}\p{P}\p{S}]?[\p{L}\p{M}]+|\s+`,
    ]
    expect(detectFamilyFromPatterns(deepseek, false)).toBe('deepseek')
    expect(detectFamilyFromPatterns([deepseek[2]!], false)).toBe('unknown')
  })

  test('falls back to unknown for unrecognized shapes', () => {
    expect(detectFamilyFromPatterns([String.raw`\S+`], false)).toBe('unknown')
  })
})

describe('detectFamilyFromTokenizerJson', () => {
  test('reads the family from fixture tokenizer files', () => {
    expect(
      detectFamilyFromTokenizerJson(readJson('mini-hf.tokenizer.json')),
    ).toBe('cl100k')
    expect(
      detectFamilyFromTokenizerJson(readJson('mini-hf-ignore.tokenizer.json')),
    ).toBe('glm')
    expect(
      detectFamilyFromTokenizerJson(readJson('mini-hf-nfc.tokenizer.json')),
    ).toBe('qwen')
    expect(
      detectFamilyFromTokenizerJson(
        readJson('mini-hf-deepseek.tokenizer.json'),
      ),
    ).toBe('deepseek')
  })
})
