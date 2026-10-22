import type { Message } from '../../../types/message.js'
import type { EntryView } from '../contracts.js'

/**
 * Branch summarization: pure budget/selection, prompt construction, and file
 * operation tracking. This module never writes the session; callers commit the
 * returned summary at the navigation target themselves.
 *
 * Budget mirrors the reference implementation:
 *   tokenBudget = (contextWindow || 128000) - reserveTokens   (default 16384)
 * Selection walks entries newest -> oldest so recent context survives.
 */

export const DEFAULT_BRANCH_SUMMARY_RESERVE_TOKENS = 16_384
export const DEFAULT_BRANCH_SUMMARY_CONTEXT_WINDOW = 128_000
export const BRANCH_SUMMARY_MAX_OUTPUT_TOKENS = 2_048
export const SUMMARIZATION_SYSTEM_PROMPT =
  'You summarize conversation branches. Preserve user intent, decisions, ' +
  'open tasks, file paths, commands, and constraints. Return only the summary.'

export const BRANCH_SUMMARY_PREAMBLE =
  'This is a summary of a conversation branch that was abandoned when the ' +
  'session tree was navigated. Use it as context for the new branch.'

export const DEFAULT_BRANCH_SUMMARY_INSTRUCTIONS =
  'Summarize the branch. Preserve decisions, open tasks, file paths, ' +
  'commands, and constraints the user stated.'

export interface BranchSummaryEntry extends EntryView {
  /** Present for `compaction` and `branchSummary` entries. */
  summary?: string
  /** Cumulative file details carried by an earlier branch summary. */
  readFiles?: string[]
  modifiedFiles?: string[]
}

export interface FileOperations {
  read: Set<string>
  edited: Set<string>
}

export interface BranchPreparation {
  messages: Message[]
  fileOps: FileOperations
  totalTokens: number
}

export interface BranchSummaryResult {
  summary?: string
  readFiles?: string[]
  modifiedFiles?: string[]
  aborted?: boolean
  error?: string
  totalTokens?: number
}

export interface GenerateBranchSummaryOptions {
  contextWindow?: number
  reserveTokens?: number
  instructions?: string
  signal?: AbortSignal
  estimateTokens?(message: Message): number
  /**
   * Injected summarization call. No network is performed here; production
   * supplies the provider transport and tests supply a mock.
   */
  complete?(input: {
    system: string
    prompt: string
    maxTokens: number
    signal?: AbortSignal
  }): Promise<string>
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : undefined
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map(block => {
      const record = recordOf(block)
      return record?.type === 'text' && typeof record.text === 'string'
        ? record.text
        : ''
    })
    .join('')
}

/** Strip a `history://` or `path:1-200` selector down to its file path. */
export function stripReadSelector(path: string): string {
  const trimmed = path.trim()
  const colon = trimmed.lastIndexOf(':')
  if (colon > 0 && /^\d+(?:-\d+)?$/.test(trimmed.slice(colon + 1))) {
    return trimmed.slice(0, colon)
  }
  return trimmed
}

export function truncateToolResultForSummary(
  text: string,
  maxChars = 2_000,
): string {
  if (text.length <= maxChars) return text
  return `${text.slice(0, maxChars)}… [truncated]`
}

export function createFileOps(): FileOperations {
  return { read: new Set<string>(), edited: new Set<string>() }
}

function pathFromInput(input: unknown): string | undefined {
  const record = recordOf(input)
  if (!record) return undefined
  const candidate =
    record.file_path ?? record.path ?? record.notebook_path ?? record.filePath
  return typeof candidate === 'string' && candidate.trim().length > 0
    ? candidate.trim()
    : undefined
}

/** Track `read` / `write` / `edit` tool calls from one message. */
export function extractFileOpsFromMessage(
  message: Message,
  fileOps: FileOperations,
): void {
  if (message.type !== 'assistant') return
  const content = message.message?.content
  if (!Array.isArray(content)) return
  for (const item of content) {
    const block = recordOf(item)
    if (block?.type !== 'tool_use') continue
    const name = typeof block.name === 'string' ? block.name.toLowerCase() : ''
    const path = pathFromInput(block.input)
    if (!path) continue
    if (name === 'read') {
      fileOps.read.add(stripReadSelector(path))
    } else if (name === 'write' || name === 'edit' || name === 'notebookedit') {
      fileOps.edited.add(path)
    }
  }
}

export function resolveBranchSummaryBudget(
  contextWindow: number | undefined,
  reserveTokens = DEFAULT_BRANCH_SUMMARY_RESERVE_TOKENS,
): number {
  const window =
    typeof contextWindow === 'number' && contextWindow > 0
      ? contextWindow
      : DEFAULT_BRANCH_SUMMARY_CONTEXT_WINDOW
  return Math.max(0, window - reserveTokens)
}

export function estimateBranchMessageTokens(
  message: Message,
  estimate?: (message: Message) => number,
): number {
  if (estimate) return Math.max(0, estimate(message))
  const content = message.message?.content
  const text = textOf(content)
  const toolResult = Array.isArray(content)
    ? content
        .map(block => {
          const record = recordOf(block)
          return record?.type === 'tool_result'
            ? truncateToolResultForSummary(textOf(record.content))
            : ''
        })
        .join('')
    : ''
  const body = toolResult.length > 0 ? toolResult : text
  if (body.length > 0) return Math.ceil(body.length / 4)
  try {
    const serialized = JSON.stringify(message)
    return serialized ? Math.ceil(serialized.length / 4) : 0
  } catch {
    return 0
  }
}

function messageFromEntry(entry: BranchSummaryEntry): Message | undefined {
  if (entry.message) return entry.message
  if (entry.summary && entry.summary.length > 0) {
    const label =
      entry.kind === 'compaction'
        ? 'Previous compaction summary'
        : 'Previous branch summary'
    return {
      type: 'user',
      uuid: entry.id,
      message: {
        role: 'user',
        content: [{ type: 'text', text: `[${label}]\n${entry.summary}` }],
      },
    } as unknown as Message
  }
  return undefined
}

/**
 * Select entries for summarization.
 *
 * First pass: collect cumulative file operations from every entry (including
 * earlier branch summaries). Second pass: newest -> oldest until the token
 * budget is exhausted; a compaction/branch summary may still be admitted just
 * under the edge because it carries continuity.
 */
export function prepareBranchEntries(
  entries: readonly BranchSummaryEntry[],
  tokenBudget: number,
  estimate?: (message: Message) => number,
): BranchPreparation {
  const fileOps = createFileOps()
  for (const entry of entries) {
    if (entry.kind === 'branchSummary') {
      for (const path of entry.readFiles ?? []) {
        fileOps.read.add(stripReadSelector(path))
      }
      for (const path of entry.modifiedFiles ?? []) {
        fileOps.edited.add(path)
      }
    }
    if (entry.message) extractFileOpsFromMessage(entry.message, fileOps)
  }

  const messages: Message[] = []
  let totalTokens = 0
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]
    const message = messageFromEntry(entry)
    if (!message) continue
    const tokens = estimateBranchMessageTokens(message, estimate)
    if (tokenBudget > 0 && totalTokens + tokens > tokenBudget) {
      const isSummary =
        entry.kind === 'compaction' || entry.kind === 'branchSummary'
      if (isSummary && totalTokens < tokenBudget * 0.9) {
        messages.unshift(message)
        totalTokens += tokens
      }
      break
    }
    messages.unshift(message)
    totalTokens += tokens
  }
  return { messages, fileOps, totalTokens }
}

export interface FileLists {
  readFiles: string[]
  modifiedFiles: string[]
}

export function computeFileLists(fileOps: FileOperations): FileLists {
  const readFiles = [...fileOps.read]
    .filter(path => !fileOps.edited.has(path))
    .sort()
  const modifiedFiles = [...fileOps.edited].sort()
  return { readFiles, modifiedFiles }
}

interface FileLine {
  path: string
  marker: '(Read)' | '(Write)' | '(RW)'
}

function markerFor(path: string, fileOps: FileOperations): FileLine['marker'] {
  const read = fileOps.read.has(path)
  const edited = fileOps.edited.has(path)
  if (read && edited) return '(RW)'
  return edited ? '(Write)' : '(Read)'
}

/** Render the grouped, prefix-folded file tree the reference implementation uses. */
export function formatFileOperations(
  fileOps: FileOperations,
  maxFiles = 20,
): string {
  const paths = new Set<string>([...fileOps.read, ...fileOps.edited])
  if (paths.size === 0) return ''
  const lines: FileLine[] = [...paths]
    .sort()
    .map(path => ({ path, marker: markerFor(path, fileOps) }))
  const shown = lines.slice(0, maxFiles)
  const elided = lines.length - shown.length

  const output: string[] = ['<files>']
  let currentDir: string | undefined
  for (const line of shown) {
    const slash = line.path.lastIndexOf('/')
    const dir = slash >= 0 ? line.path.slice(0, slash) : '.'
    const name = slash >= 0 ? line.path.slice(slash + 1) : line.path
    if (dir !== currentDir) {
      output.push(`# ${dir}/`)
      currentDir = dir
    }
    output.push(`${name} ${line.marker}`)
  }
  if (elided > 0) output.push(`[…${elided} files elided…]`)
  output.push('</files>')
  return output.join('\n')
}

const LEGACY_FILE_TAGS = /<(?:files|read-files|modified-files)>[\s\S]*?<\/(?:files|read-files|modified-files)>/g

/** Replace any stale file list and append the current one. */
export function upsertFileOperations(
  summary: string,
  readFiles: readonly string[],
  modifiedFiles: readonly string[],
  fileOps?: FileOperations,
): string {
  const cleaned = summary.replace(LEGACY_FILE_TAGS, '').trimEnd()
  const ops =
    fileOps ??
    ({
      read: new Set(readFiles),
      edited: new Set(modifiedFiles),
    } satisfies FileOperations)
  const block = formatFileOperations(ops)
  if (!block) return cleaned
  return cleaned.length > 0 ? `${cleaned}\n\n${block}` : block
}

/** Serialize selected messages as text so the model does not continue them. */
export function serializeConversationForSummary(
  messages: readonly Message[],
): string {
  const lines: string[] = []
  for (const message of messages) {
    const role =
      message.type === 'assistant'
        ? 'Assistant'
        : message.type === 'user'
          ? 'User'
          : undefined
    if (!role) continue
    const content = message.message?.content
    if (typeof content === 'string') {
      if (content.trim().length > 0) lines.push(`${role}: ${content}`)
      continue
    }
    if (!Array.isArray(content)) continue
    for (const item of content) {
      const block = recordOf(item)
      if (!block) continue
      if (block.type === 'text' && typeof block.text === 'string') {
        lines.push(`${role}: ${block.text}`)
      } else if (block.type === 'tool_use') {
        const name = typeof block.name === 'string' ? block.name : 'tool'
        lines.push(
          `${role} [tool ${name}]: ${JSON.stringify(block.input ?? {})}`,
        )
      } else if (block.type === 'tool_result') {
        lines.push(
          `Tool result: ${truncateToolResultForSummary(textOf(block.content))}`,
        )
      }
    }
  }
  return lines.join('\n\n')
}

export function buildBranchSummaryPrompt(
  conversationText: string,
  instructions = DEFAULT_BRANCH_SUMMARY_INSTRUCTIONS,
): string {
  return `<conversation>\n${conversationText}\n</conversation>\n\n${instructions}`
}

/**
 * Generate a branch summary through the injected completion. Never writes the
 * session: the caller decides where the returned summary is attached.
 */
export async function generateBranchSummary(
  entries: readonly BranchSummaryEntry[],
  options: GenerateBranchSummaryOptions = {},
): Promise<BranchSummaryResult> {
  const tokenBudget = resolveBranchSummaryBudget(
    options.contextWindow,
    options.reserveTokens ?? DEFAULT_BRANCH_SUMMARY_RESERVE_TOKENS,
  )
  const prepared = prepareBranchEntries(
    entries,
    tokenBudget,
    options.estimateTokens,
  )
  if (prepared.messages.length === 0) {
    return { summary: 'No content to summarize', totalTokens: 0 }
  }

  const conversationText = serializeConversationForSummary(prepared.messages)
  const prompt = buildBranchSummaryPrompt(
    conversationText,
    options.instructions ?? DEFAULT_BRANCH_SUMMARY_INSTRUCTIONS,
  )
  if (!options.complete) {
    return {
      summary: undefined,
      totalTokens: prepared.totalTokens,
    }
  }

  let text: string
  try {
    text = await options.complete({
      system: SUMMARIZATION_SYSTEM_PROMPT,
      prompt,
      maxTokens: BRANCH_SUMMARY_MAX_OUTPUT_TOKENS,
      signal: options.signal,
    })
  } catch (error) {
    if (options.signal?.aborted) return { aborted: true }
    return {
      error: error instanceof Error ? error.message : String(error),
      totalTokens: prepared.totalTokens,
    }
  }

  const { readFiles, modifiedFiles } = computeFileLists(prepared.fileOps)
  const body = text.trim().length > 0 ? text : 'No summary generated'
  const summary = upsertFileOperations(
    `${BRANCH_SUMMARY_PREAMBLE}\n\n${body}`,
    readFiles,
    modifiedFiles,
    prepared.fileOps,
  )
  return {
    summary,
    readFiles,
    modifiedFiles,
    totalTokens: prepared.totalTokens,
  }
}
