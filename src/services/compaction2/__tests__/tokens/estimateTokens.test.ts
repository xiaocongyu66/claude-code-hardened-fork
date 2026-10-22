import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import {
  TOKENIZER_DIR_ENV,
  contentAdaptiveEstimate,
  estimateTokens,
  resetTokenizerCache,
} from '../../tokens/index.js'
import { resolveTokenizerById } from '../../tokens/registry.js'

const FIXTURES = join(import.meta.dir, '..', 'fixtures')
const originalDir = process.env[TOKENIZER_DIR_ENV]

beforeAll(() => {
  process.env[TOKENIZER_DIR_ENV] = FIXTURES
  resetTokenizerCache()
})

afterAll(() => {
  if (originalDir === undefined) {
    delete process.env[TOKENIZER_DIR_ENV]
  } else {
    process.env[TOKENIZER_DIR_ENV] = originalDir
  }
  resetTokenizerCache()
})

describe('estimateTokens with a tokenizer data directory', () => {
  test('uses the manifest-matched HF tokenizer exactly', () => {
    expect(estimateTokens('abc hello', 'mini/hf-basic-large')).toEqual({
      tokens: 2,
      tokenizer: 'mini-hf',
      exact: true,
    })
  })

  test('uses a tiktoken tokenizer exactly', () => {
    expect(estimateTokens('hello world', 'mini/cl100k-v1')).toEqual({
      tokens: 2,
      tokenizer: 'mini-cl100k',
      exact: true,
    })
  })

  test('selects the kimi pre-tokenizer from manifest metadata', () => {
    expect(estimateTokens('中文abc', 'mini/kimi-k2')).toEqual({
      tokens: 2,
      tokenizer: 'mini-kimi',
      exact: true,
    })
  })

  test('resolves an entry by exact id', () => {
    expect(estimateTokens('abc', 'mini-cl100k').tokenizer).toBe('mini-cl100k')
    expect(resolveTokenizerById('mini-cl100k')).not.toBeNull()
    expect(resolveTokenizerById('does-not-exist')).toBeNull()
  })
})

describe('estimateTokens fallbacks', () => {
  test('missing vocabulary file falls back with exact:false', () => {
    const estimate = estimateTokens('abc', 'mini/missing-model')
    expect(estimate.exact).toBe(false)
    expect(['cl100k-fallback', 'adaptive']).toContain(estimate.tokenizer)
    expect(estimate.tokens).toBeGreaterThan(0)
  })

  test('unmatched model falls back with exact:false', () => {
    const estimate = estimateTokens('abc hello', 'other/model')
    expect(estimate.exact).toBe(false)
    expect(estimate.tokens).toBeGreaterThan(0)
  })

  test('no data directory at all falls back without throwing', () => {
    const saved = process.env[TOKENIZER_DIR_ENV]
    try {
      delete process.env[TOKENIZER_DIR_ENV]
      resetTokenizerCache()
      const estimate = estimateTokens('hello', 'mini/cl100k-v1')
      expect(estimate.exact).toBe(false)
      expect(estimate.tokenizer).not.toBe('mini-cl100k')
    } finally {
      process.env[TOKENIZER_DIR_ENV] = saved
      resetTokenizerCache()
    }
  })

  test('empty text is exactly zero tokens', () => {
    expect(estimateTokens('', 'mini/cl100k-v1')).toEqual({
      tokens: 0,
      tokenizer: 'empty',
      exact: true,
    })
  })
})

describe('contentAdaptiveEstimate', () => {
  test('CJK is denser than ASCII', () => {
    expect(contentAdaptiveEstimate('中文中文')).toBeGreaterThan(
      contentAdaptiveEstimate('abcdefgh'),
    )
  })

  test('returns a positive count for non-empty text', () => {
    expect(contentAdaptiveEstimate('a')).toBeGreaterThan(0)
    expect(contentAdaptiveEstimate('中文')).toBeGreaterThan(0)
  })
})
