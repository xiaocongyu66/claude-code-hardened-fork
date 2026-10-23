import { describe, expect, test } from 'bun:test'
import type { Message } from '../../../../types/message.js'
import type { CompactionSessionEntry } from '../../session/entries.js'
import { rebuildMessagesFromEntries } from '../../session/rebuild.js'

function user(uuid: string, content: unknown): Message {
  return {
    type: 'user',
    uuid,
    timestamp: '2026-01-01T00:00:00.000Z',
    message: { role: 'user', content },
  } as unknown as Message
}

function assistant(uuid: string, content: unknown): Message {
  return {
    type: 'assistant',
    uuid,
    timestamp: '2026-01-01T00:00:00.000Z',
    message: { role: 'assistant', content },
  } as unknown as Message
}

function compaction(
  overrides: Partial<CompactionSessionEntry> = {},
): CompactionSessionEntry {
  return {
    type: 'compaction',
    uuid: 'c1' as never,
    summary: 'the summary',
    firstKeptEntryId: 'u2',
    tokensBefore: 1234,
    method: 'soft',
    timestamp: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

const u1 = user('u1', 'old prompt')
const a1 = assistant('a1', [{ type: 'text', text: 'old reply' }])
const u2 = user('u2', 'recent prompt')
const toolUse = assistant('a2', [
  { type: 'tool_use', id: 'tool-1', name: 'Read', input: {} },
])
const toolResult = user('u3', [
  { type: 'tool_result', tool_use_id: 'tool-1', content: 'file' },
])
const a3 = assistant('a3', [{ type: 'text', text: 'after tool' }])
const u4 = user('u4', 'post-compaction prompt')

describe('rebuildMessagesFromEntries', () => {
  test('emits boundary + summary + messages after firstKeptEntryId', () => {
    const rebuilt = rebuildMessagesFromEntries([
      u1,
      a1,
      u2,
      toolUse,
      toolResult,
      a3,
      compaction(),
      u4,
    ])

    expect(rebuilt).not.toBeNull()
    const [boundary, summary, ...kept] = rebuilt!
    expect(boundary!.type).toBe('system')
    expect((boundary as { subtype?: string }).subtype).toBe('compact_boundary')
    expect(summary!.type).toBe('user')
    expect(summary!.isCompactSummary).toBe(true)
    expect(summary!.message!.content as string).toBe('the summary')
    expect(kept.map(m => String(m.uuid))).toEqual([
      'u2',
      'a2',
      'u3',
      'a3',
      'u4',
    ])
  })

  test('preserves a tool_use/tool_result pair that straddles the kept tail', () => {
    const rebuilt = rebuildMessagesFromEntries([
      u1,
      a1,
      compaction({ firstKeptEntryId: 'a2' }),
      toolUse,
      toolResult,
      a3,
    ])

    const kept = rebuilt!.slice(2)
    expect(kept.map(m => String(m.uuid))).toEqual(['a2', 'u3', 'a3'])
    const resultBlock = (
      kept[1]!.message!.content as Array<{ type: string; tool_use_id: string }>
    )[0]!
    expect(resultBlock.tool_use_id).toBe('tool-1')
  })

  test('drops an orphaned leading tool_result when the cut lands on it', () => {
    const rebuilt = rebuildMessagesFromEntries([
      u1,
      toolUse,
      compaction({ firstKeptEntryId: 'u3' }),
      toolResult,
      a3,
    ])

    const kept = rebuilt!.slice(2)
    expect(kept.map(m => String(m.uuid))).toEqual(['a3'])
    expect(
      kept.some(m =>
        (m.message?.content as Array<{ type?: string }> | undefined)?.some(
          block => block.type === 'tool_result',
        ),
      ),
    ).toBe(false)
  })

  test('empty firstKeptEntryId keeps everything after the compaction row', () => {
    const rebuilt = rebuildMessagesFromEntries([
      u1,
      a1,
      compaction({ firstKeptEntryId: '' }),
      u2,
      a3,
    ])

    expect(rebuilt!.slice(2).map(m => String(m.uuid))).toEqual(['u2', 'a3'])
  })

  test('empty firstKeptEntryId skips a legacy boundary/summary preamble', () => {
    const legacyBoundary: Message = {
      type: 'system',
      subtype: 'compact_boundary',
      uuid: 'old-boundary',
      timestamp: '2026-01-01T00:00:00.000Z',
    } as unknown as Message
    const legacySummary: Message = {
      type: 'user',
      uuid: 'old-summary',
      isCompactSummary: true,
      timestamp: '2026-01-01T00:00:00.000Z',
      message: { role: 'user', content: 'old summary' },
    } as unknown as Message

    const rebuilt = rebuildMessagesFromEntries([
      compaction({ firstKeptEntryId: '' }),
      legacyBoundary,
      legacySummary,
      u2,
      a3,
    ])

    expect(rebuilt!.slice(2).map(m => String(m.uuid))).toEqual(['u2', 'a3'])
  })

  test('returns null when there is no compaction row', () => {
    expect(rebuildMessagesFromEntries([u1, a1])).toBeNull()
    expect(rebuildMessagesFromEntries([])).toBeNull()
  })

  test('returns null for a corrupt latest row', () => {
    const corrupt = {
      type: 'compaction',
      uuid: 'c1',
      summary: 's',
      firstKeptEntryId: 'u1',
      tokensBefore: 'not-a-number',
      method: 'soft',
      timestamp: '2026-01-01T00:00:00.000Z',
    } as unknown as CompactionSessionEntry

    expect(rebuildMessagesFromEntries([u1, corrupt])).toBeNull()
  })

  test('returns null when the cut point no longer resolves', () => {
    expect(
      rebuildMessagesFromEntries([
        u1,
        compaction({ firstKeptEntryId: 'missing-uuid' }),
      ]),
    ).toBeNull()
  })

  test('restores attachments and hook results after the summary, before kept', () => {
    const rebuilt = rebuildMessagesFromEntries([
      compaction({
        attachments: [
          { type: 'file', path: '/repo/a.ts' },
          { type: 'plan_file_reference', path: '/plan.md', text: 'plan body' },
        ],
        hookResults: [
          {
            type: 'hook_additional_context',
            name: 'SessionStart',
            text: 'hook context',
            toolUseId: 'SessionStart',
          },
        ],
      }),
      u2,
      a3,
    ])

    expect(rebuilt).not.toBeNull()
    const rows = rebuilt!.slice(2)
    expect(rows.map(message => message.type)).toEqual([
      'attachment',
      'attachment',
      'attachment',
      'user',
      'assistant',
    ])

    const file = rows[0]!.attachment as Record<string, unknown>
    expect(file.type).toBe('compact_file_reference')
    expect(file.filename).toBe('/repo/a.ts')

    const plan = rows[1]!.attachment as Record<string, unknown>
    expect(plan.type).toBe('plan_file_reference')
    expect(plan.planFilePath).toBe('/plan.md')
    expect(plan.planContent).toBe('plan body')

    const hook = rows[2]!.attachment as Record<string, unknown>
    expect(hook.type).toBe('hook_additional_context')
    expect(hook.content).toEqual(['hook context'])

    // Restored rows never carry tool_result blocks, so the kept tail still
    // starts at firstKeptEntryId with its tool pairing intact.
    expect(String(rows[3]!.uuid)).toBe('u2')
    expect(String(rows[4]!.uuid)).toBe('a3')
  })

  test('old rows without attachments rebuild unchanged', () => {
    const rebuilt = rebuildMessagesFromEntries([
      u1,
      compaction({ firstKeptEntryId: 'u2' }),
      u2,
      a3,
    ])

    expect(rebuilt!.slice(2).map(message => String(message.uuid))).toEqual([
      'u2',
      'a3',
    ])
  })

  test('drops corrupt attachment fields and still rebuilds', () => {
    const rebuilt = rebuildMessagesFromEntries([
      compaction({
        attachments: [
          null,
          { type: 42 },
          { type: 'hook_success', text: 'still here' },
        ] as never,
        hookResults: 'not-an-array' as never,
      }),
      u2,
    ])

    expect(rebuilt).not.toBeNull()
    const rows = rebuilt!.slice(2)
    expect(rows).toHaveLength(2)
    expect((rows[0]!.attachment as Record<string, unknown>).type).toBe(
      'hook_success',
    )
    expect(String(rows[1]!.uuid)).toBe('u2')
  })

  test('rebuilds snapcompact text after frames are stripped', () => {
    const rebuilt = rebuildMessagesFromEntries([
      compaction({
        method: 'snapcompact',
        preserveData: {
          snapcompact: {
            mode: 'image',
            frameCount: 3,
            text: 'archived conversation body',
            summary: 'snap summary',
          },
        },
      }),
      u2,
      a3,
    ])

    const archive = rebuilt![2]!
    expect(archive.type).toBe('user')
    expect(String(archive.message!.content)).toContain(
      'archived conversation body',
    )
    expect(String(rebuilt![3]!.uuid)).toBe('u2')
  })

  test('rebuilds text from head/tail when no full text is stored', () => {
    const rebuilt = rebuildMessagesFromEntries([
      compaction({
        method: 'snapcompact',
        preserveData: {
          snapcompact: {
            mode: 'text',
            textHead: 'HEAD',
            textTail: 'TAIL',
          },
        },
      }),
      u2,
    ])

    const archive = rebuilt![2]!
    expect(String(archive.message!.content)).toContain('HEADTAIL')
  })
})
