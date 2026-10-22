import { getFeatureValue_CACHED_MAY_BE_STALE } from 'src/services/analytics/growthbook.js'
import type { Tool } from 'src/Tool.js'
import { CORE_TOOLS } from 'src/constants/tools.js'

export { SEARCH_EXTRA_TOOLS_TOOL_NAME } from './constants.js'

import { SEARCH_EXTRA_TOOLS_TOOL_NAME } from './constants.js'

const PROMPT_HEAD = `Fetches full schema definitions for deferred tools so they can be called.

LOW PRIORITY — only use this tool when no core tool can accomplish the task. Core tools (${[...CORE_TOOLS].join(', ')}) are loaded when enabled in this session and should be used directly. If a name in that list is NOT in your actual tool list, it is unavailable in this session — do not call it or search for it. This tool is for discovering additional capabilities like MCP tools, cron scheduling, worktree management, agent teams (TeamCreate, TeamDelete, SendMessage), etc.

`

// Matches isDeferredToolsDeltaEnabled in searchExtraTools.ts (not imported —
// searchExtraTools.ts imports from this file). When enabled: tools announced
// via system-reminder attachments. When disabled: prepended
// <available-deferred-tools> block (pre-gate behavior).
function getToolLocationHint(): string {
  const deltaEnabled =
    process.env.USER_TYPE === 'ant' ||
    getFeatureValue_CACHED_MAY_BE_STALE('tengu_glacier_2xr', false)
  return deltaEnabled
    ? 'Deferred tools appear by name in <system-reminder> messages.'
    : 'Deferred tools appear by name in <available-deferred-tools> messages.'
}

const PROMPT_TAIL = ` Until fetched, only the name is known — there is no parameter schema, so it cannot be invoked correctly (ExecuteExtraTool rejects it as "has not been discovered yet"). When any instruction, system reminder, or other tool's description names a deferred tool, fetch it with query "select:<name>" before calling it.

This tool takes a query, matches it against the deferred tool list, and returns the matched tools' complete JSONSchema definitions inside a <functions> block.

Result format: each matched tool appears as one <function>{"description": "...", "name": "...", "parameters": {...}}</function> line inside the <functions> block — the same encoding as the tool list at the top of this prompt. Read the exact parameter names from it; never guess.

Result budget: schema entries are capped at ~40k characters per result. Tools whose schema would overflow are listed in \`schemas_omitted\` — fetch those individually with "select:<name>".

## Query forms
- "select:CronCreate" — fetch these exact tools by name (fastest)
- "select:CronCreate,CronList" — comma-separated multi-select
- "notebook jupyter" — keyword search, up to max_results best matches
- "+slack send" — require "slack" in the name, rank by remaining terms
- "discover:schedule cron job" — CCH extension: keyword search that also returns the complete schemas (same payload as select:)

## Two-step invocation (CCH architecture)

Deferred tools are not in the model's tool list, so they are invoked through ExecuteExtraTool — a CCH architectural difference from official Claude Code, where a fetched tool is called directly.

Step 1 — Fetch: SearchExtraTools({"query": "select:CronCreate"}) → <functions> block with the full schema.
Step 2 — Execute: ExecuteExtraTool({"tool_name": "CronCreate", "params": {...}}) using the parameter names from the schema.

Example — "schedule a cron to check deploy every 5 minutes":
1. SearchExtraTools({"query": "select:CronCreate"}) → schema shows params: cron, prompt, recurring, durable
2. ExecuteExtraTool({"tool_name": "CronCreate", "params": {"cron": "*/5 * * * *", "prompt": "check the deploy"}})

## Failure policy
If ExecuteExtraTool reports the tool is not found, call this tool with query "select:<name>" first (that loads its schema), then retry the ExecuteExtraTool call. Do not retry with guessed parameters — fetch the schema and use its exact names.`

/**
 * Check if a tool should be deferred (requires SearchExtraTools to load).
 * A tool is deferred if it is NOT in CORE_TOOLS and does NOT have alwaysLoad: true.
 * Core tools are always loaded — never deferred.
 * All other tools (non-core built-in + all MCP tools) are deferred
 * and must be discovered via SearchExtraToolsTool / ExecuteExtraTool.
 */
export function isDeferredTool(tool: Tool): boolean {
  // Explicit opt-out via _meta['anthropic/alwaysLoad']
  if (tool.alwaysLoad === true) return false

  // Core tools are always loaded — never deferred
  if (CORE_TOOLS.has(tool.name)) return false

  // Everything else (non-core built-in + all MCP tools) is deferred
  return true
}

/**
 * Format one deferred-tool line for the <available-deferred-tools> user
 * message. Search hints (tool.searchHint) are not rendered — the
 * hints A/B (exp_xenhnnmn0smrx4, stopped Mar 21) showed no benefit.
 */
export function formatDeferredToolLine(tool: Tool): string {
  return tool.name
}

export function getPrompt(): string {
  return PROMPT_HEAD + getToolLocationHint() + PROMPT_TAIL
}
