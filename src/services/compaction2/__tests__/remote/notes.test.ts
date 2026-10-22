import { describe, expect, test } from 'bun:test'
import {
  buildContextNotesInjection,
  CONTEXT_NOTES_MAX_BYTES,
  createContextNotesStore,
  createNewContextController,
  renderContextNotesInjection,
  utf8ByteLength,
} from '../../session/notes.js'

describe('context notes store', () => {
  test('caps a replacement at 16,384 UTF-8 bytes', () => {
    const store = createContextNotesStore()
    expect(CONTEXT_NOTES_MAX_BYTES).toBe(16_384)
    expect(store.write('x'.repeat(16_384)).ok).toBe(true)
    const tooLarge = store.write('x'.repeat(16_385))
    expect(tooLarge).toEqual({
      ok: false,
      reason: 'context-notes-too-large',
      bytes: 16_385,
    })
    // The failed write did not replace the previous notes.
    expect(store.visibleText()).toBe('x'.repeat(16_384))
  })

  test('counts multi-byte text in bytes, not characters', () => {
    const store = createContextNotesStore()
    const text = '你'.repeat(5_462) // 16,386 bytes
    expect(utf8ByteLength(text)).toBe(16_386)
    expect(store.write(text).ok).toBe(false)
  })

  test('only the latest revision is visible', () => {
    const store = createContextNotesStore()
    store.write('first')
    store.write('second')
    expect(store.revisions()).toHaveLength(2)
    expect(store.visibleText()).toBe('second')
    const injection = buildContextNotesInjection(store)
    expect(injection?.visibleRevision).toBe(2)
    expect(injection?.block).toContain('second')
    expect(injection?.block).not.toContain('first')
  })

  test('an empty write clears the visible notebook', () => {
    const store = createContextNotesStore()
    store.write('notes')
    expect(store.write('').ok).toBe(true)
    expect(store.visibleText()).toBeUndefined()
    expect(buildContextNotesInjection(store)).toBeUndefined()
  })

  test('renders no injection for empty notes', () => {
    expect(renderContextNotesInjection(undefined)).toBe('')
    expect(renderContextNotesInjection('')).toBe('')
    expect(renderContextNotesInjection('hello')).toBe(
      '<context_notes>\nhello\n</context_notes>',
    )
  })
})

describe('new_context controller', () => {
  test('holds one pending rollover request and consumes it', () => {
    const controller = createNewContextController(() => 123)
    expect(controller.pending()).toBeUndefined()
    expect(controller.request('threshold')).toEqual({
      requestedAt: 123,
      reason: 'threshold',
    })
    expect(controller.pending()?.reason).toBe('threshold')
    expect(controller.consume()?.reason).toBe('threshold')
    expect(controller.consume()).toBeUndefined()
  })
})
