import { describe, expect, test } from 'bun:test'
import type { CompactionResult } from '../../../../services/compact/compact.js'
import type {
  Message,
  SystemCompactBoundaryMessage,
} from '../../../../types/message.js'
import {
  annotateCompactionResult,
  createCompactionBoundaryMessage,
  createReducedNoticeMessage,
  createReducedNoticeState,
  takeReducedNotice,
  withCompactionMethod,
} from '../../session/display.js'

const timestamp = '2026-01-01T00:00:00.000Z'

function legacyBoundary(): Message {
  return {
    type: 'system',
    subtype: 'compact_boundary',
    content: 'Conversation compacted',
    isMeta: false,
    timestamp,
    uuid: 'legacy-boundary' as never,
    level: 'info',
    compactMetadata: {
      trigger: 'auto',
      preTokens: 1234,
      preservedSegment: {
        headUuid: 'h',
        anchorUuid: 'a',
        tailUuid: 't',
      },
    },
  } as unknown as Message
}

function legacyResult(): CompactionResult {
  return {
    boundaryMarker: legacyBoundary() as CompactionResult['boundaryMarker'],
    summaryMessages: [],
    attachments: [],
    hookResults: [],
  }
}

describe('createCompactionBoundaryMessage', () => {
  test('carries method, trigger, and token counts', () => {
    const boundary = createCompactionBoundaryMessage({
      method: 'remote',
      trigger: 'threshold',
      preTokens: 900,
      tokensSaved: 400,
      uuid: 'b1' as never,
      timestamp,
    })

    expect(boundary.type).toBe('system')
    expect(boundary.subtype).toBe('compact_boundary')
    expect(boundary.uuid).toBe('b1' as never)
    expect(boundary.timestamp).toBe(timestamp)
    expect(boundary.compactMetadata).toMatchObject({
      trigger: 'auto',
      preTokens: 900,
      method: 'remote',
      tokensSaved: 400,
    })
  })

  test('maps the manual trigger and omits unknown token savings', () => {
    const boundary = createCompactionBoundaryMessage({
      method: 'soft',
      trigger: 'manual',
      preTokens: 10,
      timestamp,
    })

    expect(boundary.compactMetadata.trigger).toBe('manual')
    expect(boundary.compactMetadata.preTokens).toBe(10)
    expect(boundary.compactMetadata.method).toBe('soft')
    expect('tokensSaved' in boundary.compactMetadata).toBe(false)
  })
})

describe('withCompactionMethod', () => {
  test('adds method without dropping legacy metadata', () => {
    const annotated = withCompactionMethod(
      legacyBoundary() as unknown as SystemCompactBoundaryMessage,
      'snapcompact',
      { tokensSaved: 250 },
    )

    expect(annotated.uuid).toBe('legacy-boundary' as never)
    expect(annotated.compactMetadata).toMatchObject({
      trigger: 'auto',
      preTokens: 1234,
      method: 'snapcompact',
      tokensSaved: 250,
      preservedSegment: {
        headUuid: 'h',
        anchorUuid: 'a',
        tailUuid: 't',
      },
    })
  })

  test('annotateCompactionResult clones the boundary without mutating input', () => {
    const result = legacyResult()
    const annotated = annotateCompactionResult(result, 'soft', {
      tokensSaved: 500,
    })

    expect(annotated).not.toBe(result)
    expect(annotated.boundaryMarker).not.toBe(result.boundaryMarker)
    expect((annotated.boundaryMarker as Message).compactMetadata).toMatchObject(
      {
        method: 'soft',
        tokensSaved: 500,
      },
    )
    expect(
      (result.boundaryMarker as Message).compactMetadata,
    ).not.toHaveProperty('method')
  })

  test('leaves a non-boundary marker untouched', () => {
    const marker = { type: 'system', uuid: 'x' } as unknown as Message
    const result = {
      ...legacyResult(),
      boundaryMarker: marker as CompactionResult['boundaryMarker'],
    }

    expect(annotateCompactionResult(result, 'soft')).toBe(result)
  })
})

describe('reduced notice', () => {
  test('builds an informational message with the saved token count', () => {
    const notice = createReducedNoticeMessage({
      method: 'shake',
      tokensSaved: 3210,
      uuid: 'n1' as never,
      timestamp,
    })

    expect(notice.type).toBe('system')
    expect(notice.subtype).toBe('informational')
    expect(notice.content).toBe('Context reduced by 3210 tokens (shake)')
    expect(notice.level).toBe('notice')
    expect(notice.uuid).toBe('n1' as never)
    expect(notice.timestamp).toBe(timestamp)
  })

  test('takeReducedNotice emits at most once per turn', () => {
    const state = createReducedNoticeState()

    const first = takeReducedNotice(state, {
      method: 'shake',
      tokensSaved: 100,
      uuid: 'n1' as never,
      timestamp,
    })
    const second = takeReducedNotice(state, {
      method: 'shake',
      tokensSaved: 200,
      uuid: 'n2' as never,
      timestamp,
    })

    expect(first?.content).toBe('Context reduced by 100 tokens (shake)')
    expect(second).toBeUndefined()
    expect(state.emitted).toBe(true)
  })

  test('a fresh state emits again on the next turn', () => {
    const first = takeReducedNotice(createReducedNoticeState(), {
      method: 'shake',
      tokensSaved: 1,
      timestamp,
    })
    const next = takeReducedNotice(createReducedNoticeState(), {
      method: 'shake',
      tokensSaved: 2,
      timestamp,
    })

    expect(first).toBeDefined()
    expect(next).toBeDefined()
  })
})
