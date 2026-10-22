import { describe, expect, test } from 'bun:test'
import type { Message } from '../../../types/message.js'
import {
  BRANCH_SUMMARY_PREAMBLE,
  buildBranchSummaryPrompt,
  computeFileLists,
  createFileOps,
  extractFileOpsFromMessage,
  formatFileOperations,
  generateBranchSummary,
  prepareBranchEntries,
  resolveBranchSummaryBudget,
  serializeConversationForSummary,
  stripReadSelector,
  upsertFileOperations,
  type BranchSummaryEntry,
} from '../methods/branchSummary.js'

function user(uuid: string, text: string): Message {
  return {
    type: 'user',
    uuid,
    message: { role: 'user', content: text },
  } as unknown as Message
}

function assistant(uuid: string, blocks: unknown[]): Message {
  return {
    type: 'assistant',
    uuid,
    message: { role: 'assistant', content: blocks },
  } as unknown as Message
}

describe('budget and selection', () => {
  test('tokenBudget = contextWindow - reserve', () => {
    expect(resolveBranchSummaryBudget(100_000)).toBe(100_000 - 16_384)
    expect(resolveBranchSummaryBudget(100_000, 1_000)).toBe(99_000)
    expect(resolveBranchSummaryBudget(undefined)).toBe(128_000 - 16_384)
  })

  test('walks newest to oldest until the budget is exhausted', () => {
    const entries: BranchSummaryEntry[] = [
      { id: 'e1', kind: 'message', message: user('e1', 'one') },
      { id: 'e2', kind: 'message', message: user('e2', 'two') },
      { id: 'e3', kind: 'message', message: user('e3', 'three') },
    ]
    const tokens: Record<string, number> = { e1: 500, e2: 300, e3: 200 }
    const prepared = prepareBranchEntries(
      entries,
      600,
      message => tokens[message.uuid] ?? 0,
    )
    expect(prepared.messages.map(message => message.uuid)).toEqual(['e2', 'e3'])
    expect(prepared.totalTokens).toBe(500)
  })

  test('admits a summary entry near the budget edge for continuity', () => {
    const entries: BranchSummaryEntry[] = [
      {
        id: 'c1',
        kind: 'compaction',
        summary: 'previous summary',
      },
      { id: 'e2', kind: 'message', message: user('e2', 'two') },
    ]
    const tokens: Record<string, number> = { c1: 600, e2: 100 }
    const prepared = prepareBranchEntries(
      entries,
      650,
      message => tokens[message.uuid] ?? 0,
    )
    expect(prepared.messages).toHaveLength(2)
    expect(prepared.totalTokens).toBe(700)
  })

  test('collects cumulative file ops from earlier branch summaries', () => {
    const entries: BranchSummaryEntry[] = [
      {
        id: 'b1',
        kind: 'branchSummary',
        summary: 'old branch',
        readFiles: ['/old/read.ts'],
        modifiedFiles: ['/old/edit.ts'],
      },
      { id: 'e2', kind: 'message', message: user('e2', 'two') },
    ]
    const prepared = prepareBranchEntries(entries, 0)
    expect([...prepared.fileOps.read]).toContain('/old/read.ts')
    expect([...prepared.fileOps.edited]).toContain('/old/edit.ts')
  })
})

describe('file operations', () => {
  test('extracts read/write/edit tool calls and strips selectors', () => {
    expect(stripReadSelector('/a.ts:10-20')).toBe('/a.ts')
    const ops = createFileOps()
    extractFileOpsFromMessage(
      assistant('a1', [
        {
          type: 'tool_use',
          id: '1',
          name: 'Read',
          input: { file_path: '/a.ts' },
        },
        {
          type: 'tool_use',
          id: '2',
          name: 'Read',
          input: { file_path: '/b.ts:1-5' },
        },
        {
          type: 'tool_use',
          id: '3',
          name: 'Edit',
          input: { file_path: '/b.ts' },
        },
        {
          type: 'tool_use',
          id: '4',
          name: 'Write',
          input: { file_path: '/c.ts' },
        },
      ]),
      ops,
    )
    const lists = computeFileLists(ops)
    expect(lists.readFiles).toEqual(['/a.ts'])
    expect(lists.modifiedFiles).toEqual(['/b.ts', '/c.ts'])
  })

  test('renders markers and elides beyond the cap', () => {
    const ops = createFileOps()
    ops.read.add('/src/a.ts')
    ops.read.add('/src/b.ts')
    ops.edited.add('/src/b.ts')
    ops.edited.add('/src/c.ts')
    const text = formatFileOperations(ops)
    expect(text).toContain('<files>')
    expect(text).toContain('# /src/')
    expect(text).toContain('a.ts (Read)')
    expect(text).toContain('b.ts (RW)')
    expect(text).toContain('c.ts (Write)')

    for (let i = 0; i < 25; i++) ops.read.add(`/many/f${i}.ts`)
    expect(formatFileOperations(ops)).toContain('[…8 files elided…]')
  })

  test('upsert replaces stale file tags', () => {
    const summary = 'summary\n\n<files>\nold (Read)\n</files>'
    const updated = upsertFileOperations(summary, ['/new.ts'], [])
    expect(updated).not.toContain('old (Read)')
    expect(updated).toContain('new.ts (Read)')
  })
})

describe('prompt and generation', () => {
  test('serializes conversation text and wraps it in <conversation>', () => {
    const text = serializeConversationForSummary([
      user('u1', 'hello'),
      assistant('a1', [
        { type: 'text', text: 'sure' },
        { type: 'tool_use', id: 't', name: 'Read', input: { file_path: '/a' } },
      ]),
    ])
    expect(text).toContain('User: hello')
    expect(text).toContain('Assistant: sure')
    expect(text).toContain('[tool Read]')
    const prompt = buildBranchSummaryPrompt(text, 'focus')
    expect(prompt).toContain('<conversation>')
    expect(prompt.endsWith('focus')).toBe(true)
  })

  test('generates through the injected completion and appends files', async () => {
    const entries: BranchSummaryEntry[] = [
      {
        id: 'a1',
        kind: 'message',
        message: assistant('a1', [
          {
            type: 'tool_use',
            id: 't',
            name: 'Read',
            input: { file_path: '/a.ts' },
          },
        ]),
      },
      { id: 'u1', kind: 'message', message: user('u1', 'done') },
    ]
    let seenPrompt = ''
    const result = await generateBranchSummary(entries, {
      contextWindow: 100_000,
      complete: async input => {
        seenPrompt = input.prompt
        return 'branch summary'
      },
    })
    expect(seenPrompt).toContain('<conversation>')
    expect(result.summary?.startsWith(BRANCH_SUMMARY_PREAMBLE)).toBe(true)
    expect(result.summary).toContain('branch summary')
    expect(result.summary).toContain('<files>')
    expect(result.readFiles).toEqual(['/a.ts'])
  })

  test('returns selection metadata without a completion hook', async () => {
    const result = await generateBranchSummary(
      [{ id: 'u1', kind: 'message', message: user('u1', 'hello') }],
      {},
    )
    expect(result.summary).toBeUndefined()
    expect(result.totalTokens).toBeGreaterThan(0)
  })

  test('reports aborts through the injected signal', async () => {
    const controller = new AbortController()
    controller.abort()
    const result = await generateBranchSummary(
      [{ id: 'u1', kind: 'message', message: user('u1', 'hello') }],
      {
        signal: controller.signal,
        complete: async () => {
          throw new Error('aborted')
        },
      },
    )
    expect(result.aborted).toBe(true)
  })
})
