import { z } from 'zod/v4'

/** Workflow tool input schema. args is any JSON value (object/array/string/etc.). */
export const workflowInputSchema = z.object({
  script: z
    .string()
    .optional()
    .describe('Self-contained workflow script source (inline)'),
  name: z
    .string()
    .optional()
    .describe('Named workflow, resolved to .claude/workflows/<name>.ts|js|mjs'),
  scriptPath: z
    .string()
    .optional()
    .describe(
      'Path to an existing script file — absolute or relative to the session cwd; the resolved path must stay within the session cwd',
    ),
  args: z
    .unknown()
    .optional()
    .describe(
      'The args global variable passed through to the script. Pass a real JSON value (object/array/string), not a JSON string.',
    ),
  resumeFromRunId: z
    .string()
    .optional()
    .describe('Resume the specified run, replaying the journal'),
  description: z
    .string()
    .optional()
    .describe('A short description of this invocation (3-5 words)'),
  title: z.string().optional().describe('Progress viewer title'),
  maxConcurrency: z
    .number()
    .int()
    .min(1)
    .max(16)
    .optional()
    .describe(
      'Concurrency cap for agent(). Defaults to 3 (hard ceiling 16). To use any value other than 3 you MUST first ask the user via AskUserQuestion (propose 3/6/9 with 3 recommended) — unless the user already specified a concurrency number in this session.',
    ),
})

/**
 * Workflow tool input type — derived from the schema to avoid hand-written type/schema drift.
 * In the old implementation {@link WorkflowInput} was hand-written in types.ts and the schema in schema.ts,
 * bridged by a `as unknown as z.ZodType<WorkflowInput>` double assertion — when the schema changed fields
 * but the type did not, TS would not flag it. With z.infer, schema/type stay in sync forever.
 */
export type WorkflowInput = z.infer<typeof workflowInputSchema>

/** typeof type of the schema (used for "schema is the source of truth" precise signatures). */
export type WorkflowInputSchema = typeof workflowInputSchema
