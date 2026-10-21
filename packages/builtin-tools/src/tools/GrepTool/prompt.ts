import { AGENT_TOOL_NAME } from '../AgentTool/constants.js'
import { BASH_TOOL_NAME } from '../BashTool/toolName.js'

export const GREP_TOOL_NAME = 'Grep'

export function getDescription(): string {
  return `A powerful search tool built on ripgrep

  Usage:
  - ALWAYS use ${GREP_TOOL_NAME} for search tasks. NEVER invoke \`grep\` or \`rg\` as a ${BASH_TOOL_NAME} command. The ${GREP_TOOL_NAME} tool has been optimized for correct permissions and access.
  - Supports full regex syntax (e.g., "log.*Error", "function\\s+\\w+"); PCRE2 fallback makes lookaround work too (e.g., \`(?<=fn )\\w+\`)
  - Filter files with glob parameter (e.g., "*.js", "**/*.tsx") or type parameter (e.g., "js", "py", "rust")
  - Output modes: "content" shows matching lines, "files_with_matches" shows only file paths (default), "count" shows match counts
  - only_matching (ugrep -o): print only the matched part, not the whole line — ideal for extraction and token-frugal output
  - files_without_match (ugrep -L): invert the file selection — with output_mode "count", list files that contain NO matches. Mutually exclusive with output_mode "files_with_matches" (that combination is an error); no effect in "content" mode.
  - binary_skip (ugrep -I): skip binary files entirely (8KiB NUL probe) instead of stopping at the first match
  - max_columns truncates over-wide matched lines measured in BYTES (default 500 — CJK lines hit the cap ~3x sooner than their character count); omitted match lines are reported as "[Omitted long matching line]" and omitted context lines as "[Omitted long context line]"
  - Use ${AGENT_TOOL_NAME} tool for open-ended searches requiring multiple rounds
  - Pattern syntax: Uses ripgrep (not grep) - literal braces need escaping (use \`interface\\{\\}\` to find \`interface{}\` in Go code)
  - Multiline matching: By default patterns match within single lines only. For cross-line patterns like \`struct \\{[\\S\\s]*?field\`, use \`multiline: true\`
`
}
