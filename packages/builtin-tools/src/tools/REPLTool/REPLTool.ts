import { z } from 'zod/v4'
import type { ToolResultBlockParam } from 'src/Tool.js'
import { buildTool } from 'src/Tool.js'
import { lazySchema } from 'src/utils/lazySchema.js'
import { REPL_TOOL_NAME } from './constants.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    code: z
      .string()
      .describe(
        'The code to execute in the REPL. Can call any primitive tool (Read, Write, Edit, Glob, Grep, Bash, NotebookEdit, Agent) via their APIs.',
      ),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>
type REPLInput = z.infer<InputSchema>

type REPLOutput = { result: string; tool_calls: number }

export const REPLTool = buildTool({
  name: REPL_TOOL_NAME,
  searchHint: 'repl execute batch code read write edit glob grep bash',
  maxResultSizeChars: 100_000,
  strict: true,

  get inputSchema(): InputSchema {
    return inputSchema()
  },

  async description() {
    return 'Execute code in the REPL environment with access to all primitive tools'
  },
  async prompt() {
    return `Execute code in the REPL environment when the REPL execution engine is available.

This build does NOT ship the ant-native REPL runtime: calls return an error ("REPL tool is not available in this build"). The tool is only registered for internal (USER_TYPE=ant) sessions or when CLAUDE_REPL_MODE=1, and is not usable for normal model work. Use the primitive tools (Read, Write, Edit, Glob, Grep, Bash, NotebookEdit, Agent) directly instead.`
  },

  isConcurrencySafe() {
    return false
  },
  isReadOnly() {
    return false
  },
  isTransparentWrapper() {
    return true
  },

  userFacingName() {
    return REPL_TOOL_NAME
  },

  renderToolUseMessage(input: Partial<REPLInput>) {
    const code = input.code ?? ''
    const preview = code.length > 80 ? code.slice(0, 77) + '...' : code
    return `REPL: ${preview}`
  },

  mapToolResultToToolResultBlockParam(
    content: REPLOutput,
    toolUseID: string,
  ): ToolResultBlockParam {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: content.result,
    }
  },

  async call(_input: REPLInput) {
    // REPL execution engine is provided by the ant-native runtime.
    // This stub satisfies the tool interface; the actual VM dispatch
    // is wired in the ant build. Without the ant runtime, REPL is
    // not available and callers should be informed.
    return {
      data: {
        result:
          'Error: REPL tool is not available in this build. The REPL execution engine requires the ant-native runtime.',
        tool_calls: 0,
      },
    }
  },
})
