import { describe, expect, test } from 'bun:test'
import type { Message } from '../../../../types/message.js'
import {
  collectToolUsesById,
  getReadToolPath,
  getToolName,
  getToolResultEntries,
  getToolResultText,
  isArtifactRecoveryToolResult,
  isProtectedToolResult,
  isSkillReadToolResult,
  isToolResultBlock,
  isToolUseBlock,
  replaceToolResultText,
  type ToolResultBlock,
} from '../../reducers/toolProtection.js'

function assistantToolUse(
  id: string,
  name: string,
  input: Record<string, unknown>,
): Message {
  return {
    type: 'assistant',
    uuid: `asst-${id}`,
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', id, name, input }],
    },
  } as unknown as Message
}

function userToolResult(
  id: string,
  content: string | Array<Record<string, unknown>>,
): Message {
  return {
    type: 'user',
    uuid: `user-${id}`,
    message: {
      role: 'user',
      content: [
        { type: 'text', text: 'note' },
        { type: 'tool_result', tool_use_id: id, content },
      ],
    },
  } as unknown as Message
}

describe('block guards', () => {
  test('recognize tool_use and tool_result blocks', () => {
    expect(
      isToolUseBlock({ type: 'tool_use', id: 'x', name: 'Read', input: {} }),
    ).toBe(true)
    expect(isToolUseBlock({ type: 'tool_use', id: 'x' })).toBe(false)
    expect(isToolResultBlock({ type: 'tool_result', tool_use_id: 'x' })).toBe(
      true,
    )
    expect(isToolResultBlock({ type: 'text', text: 'x' })).toBe(false)
  })
})

describe('collectToolUsesById', () => {
  test('indexes tool calls by id', () => {
    const messages = [
      assistantToolUse('t1', 'Read', { file_path: '/tmp/a.ts' }),
      userToolResult('t1', 'body'),
    ]
    const map = collectToolUsesById(messages)
    expect(map.get('t1')?.name).toBe('Read')
  })
})

describe('getToolResultEntries / getToolResultText', () => {
  test('reports content indices and joins text fragments', () => {
    const message = userToolResult('t1', [
      { type: 'text', text: 'one' },
      { type: 'image', source: { type: 'base64', data: 'AAAA' } },
      { type: 'text', text: 'two' },
    ])
    const entries = getToolResultEntries(message)
    expect(entries).toHaveLength(1)
    expect(entries[0].index).toBe(1)
    expect(getToolResultText(entries[0].block)).toBe('one\ntwo')
  })

  test('string content is returned verbatim', () => {
    const block = {
      type: 'tool_result',
      tool_use_id: 't1',
      content: 'plain',
    } as unknown as ToolResultBlock
    expect(getToolResultText(block)).toBe('plain')
  })
})

describe('protection matchers', () => {
  test('skill:// reads are protected', () => {
    const toolResult = {
      type: 'tool_result',
      tool_use_id: 't1',
      content: 'x',
    } as unknown as ToolResultBlock
    const toolCall = collectToolUsesById([
      assistantToolUse('t1', 'Read', { file_path: 'skill://demo' }),
    ]).get('t1')
    expect(isSkillReadToolResult({ toolResult, toolCall })).toBe(true)
    expect(isArtifactRecoveryToolResult({ toolResult, toolCall })).toBe(false)
    expect(getReadToolPath({ toolResult, toolCall })).toBe('skill://demo')
  })

  test('artifact:// reads are artifact-recovery reads', () => {
    const toolResult = {
      type: 'tool_result',
      tool_use_id: 't1',
      content: 'x',
    } as unknown as ToolResultBlock
    const toolCall = collectToolUsesById([
      assistantToolUse('t1', 'Read', { file_path: 'artifact://x' }),
    ]).get('t1')
    expect(isArtifactRecoveryToolResult({ toolResult, toolCall })).toBe(true)
  })

  test('string matchers are case-insensitive and predicates see the call', () => {
    const toolResult = {
      type: 'tool_result',
      tool_use_id: 't1',
      content: 'x',
    } as unknown as ToolResultBlock
    const toolCall = collectToolUsesById([
      assistantToolUse('t1', 'Skill', {}),
    ]).get('t1')
    expect(isProtectedToolResult(toolResult, toolCall, ['skill'])).toBe(true)
    expect(isProtectedToolResult(toolResult, toolCall, ['read'])).toBe(false)
    expect(
      isProtectedToolResult(toolResult, toolCall, [
        ctx => getToolName(ctx.toolResult, ctx.toolCall) === 'Skill',
      ]),
    ).toBe(true)
  })

  test('getReadToolPath accepts the oh-my-pi `path` spelling', () => {
    const toolResult = {
      type: 'tool_result',
      tool_use_id: 't1',
      content: 'x',
    } as unknown as ToolResultBlock
    const toolCall = collectToolUsesById([
      assistantToolUse('t1', 'read', { path: '/tmp/a.ts' }),
    ]).get('t1')
    expect(getReadToolPath({ toolResult, toolCall })).toBe('/tmp/a.ts')
    expect(isSkillReadToolResult({ toolResult, toolCall })).toBe(false)
  })
})

describe('replaceToolResultText', () => {
  test('replaces text in place and preserves non-text blocks', () => {
    const block = {
      type: 'tool_result',
      tool_use_id: 't1',
      content: [
        { type: 'image', source: { type: 'base64', data: 'AAAA' } },
        { type: 'text', text: 'old' },
        { type: 'text', text: 'dropped' },
      ],
    } as unknown as ToolResultBlock
    const replaced = replaceToolResultText(block, 'notice')
    const content = replaced.content as unknown as Array<
      Record<string, unknown>
    >
    expect(content).toHaveLength(2)
    expect(content[0].type).toBe('image')
    expect(content[1]).toEqual({ type: 'text', text: 'notice' })
    // Original untouched.
    expect(
      (block.content as unknown as Array<Record<string, unknown>>)[1].text,
    ).toBe('old')
  })

  test('prepends the notice when the result has no text block', () => {
    const block = {
      type: 'tool_result',
      tool_use_id: 't1',
      content: [{ type: 'image', source: {} }],
    } as unknown as ToolResultBlock
    const replaced = replaceToolResultText(block, 'notice')
    const content = replaced.content as unknown as Array<
      Record<string, unknown>
    >
    expect(content[0]).toEqual({ type: 'text', text: 'notice' })
    expect(content[1].type).toBe('image')
  })
})
