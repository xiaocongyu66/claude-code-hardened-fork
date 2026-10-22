// Tool-result protection helpers for the local compaction reducers.
//
// This is the CCH adaptation of oh-my-pi's `compaction/tool-protection.ts`.
// CCH carries tool calls as `tool_use` blocks on assistant messages and tool
// results as `tool_result` blocks on user messages, so the pairing is resolved
// through `tool_use_id` rather than through one message per result.
//
// Pure: no I/O, no settings, no provider access.
import type { Message } from '../../../types/message.js'

export interface ToolUseBlock {
  type: 'tool_use'
  id: string
  name: string
  input: Record<string, unknown>
}

export interface ToolResultBlock {
  type: 'tool_result'
  tool_use_id: string
  content?: string | unknown[]
  is_error?: boolean
  /** Set by the tool when the result carried no useful information. */
  useless?: boolean
  /** Set by the reducers once the text was blanked. */
  pruned?: boolean
  /** Optional tool name (CCH normally resolves it from the paired tool_use). */
  tool_name?: string
  [key: string]: unknown
}

export interface TextBlockLike {
  type: 'text'
  text: string
  [key: string]: unknown
}

export interface ProtectedToolContext {
  readonly toolResult: ToolResultBlock
  readonly toolCall: ToolUseBlock | undefined
  readonly message?: Message
}

/**
 * String entries protect every result of that tool (case-insensitive, so CCH's
 * `Read`/`Skill` names match oh-my-pi's lowercase names). Predicates may inspect
 * the paired tool call.
 */
export type ProtectedToolMatcher =
  | string
  | ((context: ProtectedToolContext) => boolean)

const SKILL_INTERNAL_URL_PREFIX = 'skill://'
const ARTIFACT_INTERNAL_URL_PREFIX = 'artifact://'

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function isTextBlock(value: unknown): value is TextBlockLike {
  return (
    isRecord(value) && value.type === 'text' && typeof value.text === 'string'
  )
}

export function isToolUseBlock(value: unknown): value is ToolUseBlock {
  if (!isRecord(value) || value.type !== 'tool_use') return false
  return (
    typeof value.id === 'string' &&
    typeof value.name === 'string' &&
    isRecord(value.input)
  )
}

export function isToolResultBlock(value: unknown): value is ToolResultBlock {
  return (
    isRecord(value) &&
    value.type === 'tool_result' &&
    typeof value.tool_use_id === 'string'
  )
}

/** Content blocks of a message, or `undefined` when content is a string. */
export function getContentArray(message: Message): unknown[] | undefined {
  const content = message.message?.content
  return Array.isArray(content) ? content : undefined
}

/** Map every tool-call id to its `tool_use` block across `messages[start, end)`. */
export function collectToolUsesById(
  messages: readonly Message[],
  start = 0,
  end = messages.length,
): Map<string, ToolUseBlock> {
  const toolCalls = new Map<string, ToolUseBlock>()
  for (let i = start; i < end; i++) {
    const content = getContentArray(messages[i])
    if (!content) continue
    for (const block of content) {
      if (isToolUseBlock(block)) toolCalls.set(block.id, block)
    }
  }
  return toolCalls
}

/** Every `tool_result` block of a message, in content order. */
export function getToolResultBlocks(message: Message): ToolResultBlock[] {
  const content = getContentArray(message)
  if (!content) return []
  const out: ToolResultBlock[] = []
  for (const block of content) {
    if (isToolResultBlock(block)) out.push(block)
  }
  return out
}

/** `tool_result` blocks together with their index in the content array. */
export function getToolResultEntries(
  message: Message,
): Array<{ block: ToolResultBlock; index: number }> {
  const content = getContentArray(message)
  if (!content) return []
  const out: Array<{ block: ToolResultBlock; index: number }> = []
  for (let i = 0; i < content.length; i++) {
    const block = content[i]
    if (isToolResultBlock(block)) out.push({ block, index: i })
  }
  return out
}

/**
 * Text carried by a tool result: the string form, or every text block of the
 * array form joined with newlines. Non-text blocks (images, documents) are
 * ignored.
 */
export function getToolResultText(block: ToolResultBlock): string | undefined {
  if (typeof block.content === 'string') {
    return block.content.length > 0 ? block.content : undefined
  }
  if (!Array.isArray(block.content)) return undefined
  const fragments: string[] = []
  for (const item of block.content) {
    if (isTextBlock(item) && item.text.length > 0) fragments.push(item.text)
  }
  return fragments.length > 0 ? fragments.join('\n') : undefined
}

/** Resolve a result's tool name from its paired call (or a block override). */
export function getToolName(
  toolResult: ToolResultBlock,
  toolCall: ToolUseBlock | undefined,
): string | undefined {
  if (toolCall) return toolCall.name
  return typeof toolResult.tool_name === 'string'
    ? toolResult.tool_name
    : undefined
}

/**
 * Path argument of a `Read`/`read` call paired with this result. CCH's Read
 * tool uses `file_path`; oh-my-pi uses `path` — accept both.
 */
export function getReadToolPath({
  toolResult,
  toolCall,
}: ProtectedToolContext): string | undefined {
  if (getToolName(toolResult, toolCall)?.toLowerCase() !== 'read') {
    return undefined
  }
  if (!toolCall) return undefined
  const path = toolCall.input.file_path ?? toolCall.input.path
  return typeof path === 'string' && path.length > 0 ? path : undefined
}

/** `read` results of `skill://` paths are protected from every reducer. */
export function isSkillReadToolResult(context: ProtectedToolContext): boolean {
  return (
    getReadToolPath(context)?.startsWith(SKILL_INTERNAL_URL_PREFIX) ?? false
  )
}

/**
 * Recovery reads of session artifacts (`artifact://`): eliding one only mints
 * another artifact and can repeat indefinitely.
 */
export function isArtifactRecoveryToolResult(
  context: ProtectedToolContext,
): boolean {
  return (
    getReadToolPath(context)?.startsWith(ARTIFACT_INTERNAL_URL_PREFIX) ?? false
  )
}

/** True when any matcher claims the result. */
export function isProtectedToolResult(
  toolResult: ToolResultBlock,
  toolCall: ToolUseBlock | undefined,
  matchers: readonly ProtectedToolMatcher[],
): boolean {
  for (const matcher of matchers) {
    if (typeof matcher === 'string') {
      const name = getToolName(toolResult, toolCall)
      if (name !== undefined && name.toLowerCase() === matcher.toLowerCase()) {
        return true
      }
      continue
    }
    if (matcher({ toolResult, toolCall })) return true
  }
  return false
}

/**
 * Return a copy of `block` whose text is replaced by `replacement`, preserving
 * every non-text block (images, documents) in its original order. The first
 * text block is replaced in place and any other text blocks are dropped; when
 * the result had no text block the notice is prepended.
 */
export function replaceToolResultText(
  block: ToolResultBlock,
  replacement: string,
): ToolResultBlock {
  if (typeof block.content === 'string') {
    return { ...block, content: replacement }
  }
  if (!Array.isArray(block.content)) {
    return { ...block, content: [{ type: 'text', text: replacement }] }
  }
  const kept: unknown[] = []
  let replaced = false
  for (const item of block.content) {
    if (isTextBlock(item)) {
      if (!replaced) {
        kept.push({ type: 'text', text: replacement })
        replaced = true
      }
      continue
    }
    kept.push(item)
  }
  if (!replaced) kept.unshift({ type: 'text', text: replacement })
  return { ...block, content: kept }
}
