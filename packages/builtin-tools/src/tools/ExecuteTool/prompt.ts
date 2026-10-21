import { CORE_TOOLS } from 'src/constants/tools.js'

export const DESCRIPTION =
  'ExecuteExtraTool — a first-class core tool that is always loaded and available. Execute any deferred tool by name with parameters. Use it after discovering a tool via SearchExtraTools. This is NOT a remote or external tool — it runs locally with full permissions.'

export function getPrompt(): string {
  return `ExecuteExtraTool — always loaded, always available. Runs locally with full permissions — NOT a remote or external tool.

## What it does
Accepts a tool_name and params, looks up the target tool in the registry, and delegates execution to it. The target tool runs with the same permissions as if called directly.

## When to use
ONLY for deferred tools discovered via SearchExtraTools. Core tools (${[...CORE_TOOLS].join(', ')}) are loaded when enabled in this session — call them directly, NOT through ExecuteExtraTool. A core name absent from your actual tool list is unavailable in this session.

## How to call — two-step workflow

Step 1: SearchExtraTools with query "select:<name>" returns the tool's complete schema in a <functions> block.
Step 2: This tool executes it with parameters taken from that schema.

Example — user asks to schedule a cron job:
  SearchExtraTools({"query": "select:CronCreate"})
  → Response: <functions> block with CronCreate's schema (params: cron, prompt, recurring, durable)
  ExecuteExtraTool({"tool_name": "CronCreate", "params": {"cron": "*/5 * * * *", "prompt": "check deploy"}})
  → Response: Cron job created

Example — MCP tool:
  SearchExtraTools({"query": "select:mcp__slack__send_message"})
  → Response: <functions> block with mcp__slack__send_message's schema
  ExecuteExtraTool({"tool_name": "mcp__slack__send_message", "params": {"channel": "C123", "text": "hello"}})

## Inputs
- tool_name: Exact name of the target tool (string, e.g. "CronCreate", "mcp__slack__send_message")
- params: Object with the target tool's parameters. Use the exact parameter names from the SearchExtraTools "select:<name>" schema — do not guess.

## Failure handling
If this tool reports the target "has not been discovered yet", call SearchExtraTools with query "select:<name>" first (that loads its schema), then retry this call once. If the target does not exist at all ("not found"), searching again will not help — report it. For any other error, do not loop — report what failed and suggest alternatives.`
}
