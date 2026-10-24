/**
 * Workspace content search for the native TUI's global-search overlay.
 *
 * Native-first: the in-process `search-napi` engine (same pipeline as
 * GlobalSearchDialog) answers fixed-string, case-insensitive content hits.
 * When the native module is unavailable, a bounded TypeScript walk performs
 * the equivalent literal search so the overlay still works on minimal
 * installs. Results are always bounded (≤ 200 hits); the caller ships them in
 * a `system/workspace_search_results` frame.
 */

import type { Dirent } from 'node:fs'
import * as path from 'node:path'

/** One `path:line  text` hit. */
export interface WorkspaceSearchMatch {
  path: string
  line: number
  text: string
}

export interface WorkspaceSearchResponse {
  matches: WorkspaceSearchMatch[]
  truncated: boolean
}

/** Hard cap on hits returned to the TUI. */
export const MAX_WORKSPACE_MATCHES = 200

/** Escape regex metacharacters for fixed-string (`-F`) semantics. */
export function escapeSearchPattern(query: string): string {
  return query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Replace a leading `..` path with the absolute path (outside the cwd). */
function displayPath(cwd: string, absolute: string): string {
  const relative = path.relative(cwd, absolute)
  return relative.startsWith('..') ? absolute : relative
}

async function searchWithNative(
  query: string,
): Promise<WorkspaceSearchResponse | null> {
  const [{ attachSearchCancel, loadSearchNative }, { getCwd }] =
    await Promise.all([
      import('../../packages/search-napi/src/index.js'),
      import('../utils/cwd.js'),
    ])
  const mod = loadSearchNative()
  if (mod === null) {
    return null
  }
  const cwd = getCwd()
  const controller = new AbortController()
  const cancelKey = `workspace-${Date.now()}-${Math.random()}`
  const cancel = attachSearchCancel(mod, controller.signal, cancelKey)
  try {
    const result = await mod.grepSearch({
      pattern: escapeSearchPattern(query),
      path: cwd,
      ignoreCase: true,
      hidden: true,
      gitignore: true,
      maxColumns: 500,
      mode: 'Content',
      maxCount: MAX_WORKSPACE_MATCHES,
      timeoutMs: 20_000,
      cancelKey,
    })
    const matches: WorkspaceSearchMatch[] = []
    for (const match of result.matches) {
      matches.push({
        path: displayPath(cwd, match.path),
        line: match.lineNumber,
        text:
          match.truncated === true
            ? '[Omitted long matching line]'
            : match.line,
      })
      if (matches.length >= MAX_WORKSPACE_MATCHES) break
    }
    return {
      matches,
      truncated:
        result.limitReached === true || matches.length >= MAX_WORKSPACE_MATCHES,
    }
  } catch {
    // Engine error (bad pattern, aborted session) — report no hits rather
    // than surfacing an internal error in the overlay.
    return { matches: [], truncated: false }
  } finally {
    cancel()
  }
}

const IGNORED_DIRECTORIES = new Set([
  '.git',
  '.svn',
  '.hg',
  '.bzr',
  '.jj',
  '.sl',
  '.bun',
  'node_modules',
])

const MAX_WALK_FILES = 20_000
const MAX_FILE_BYTES = 2 * 1024 * 1024
const WALK_BUDGET_MS = 10_000

/**
 * Bounded TypeScript fallback: walk the workspace, skip VCS/dependency
 * directories, binary files and oversized files, then match line by line.
 * Best effort only — the native engine is the intended path.
 */
async function searchWithTypeScript(
  query: string,
): Promise<WorkspaceSearchResponse> {
  const [{ readdir, readFile, stat }, { getCwd }] = await Promise.all([
    import('node:fs/promises'),
    import('../utils/cwd.js'),
  ])
  const root = getCwd()
  const needle = query.toLowerCase()
  const matches: WorkspaceSearchMatch[] = []
  const started = Date.now()
  const stack = [root]
  let files = 0
  let truncated = false

  while (stack.length > 0) {
    if (
      Date.now() - started > WALK_BUDGET_MS ||
      files >= MAX_WALK_FILES ||
      matches.length >= MAX_WORKSPACE_MATCHES
    ) {
      truncated = true
      break
    }
    const dir = stack.pop()
    if (dir === undefined) break
    let entries: Dirent[]
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(entry.name)) {
          stack.push(path.join(dir, entry.name))
        }
        continue
      }
      if (!entry.isFile()) continue
      files += 1
      if (files > MAX_WALK_FILES) {
        truncated = true
        break
      }
      const absolute = path.join(dir, entry.name)
      try {
        const info = await stat(absolute)
        if (info.size > MAX_FILE_BYTES) continue
        const content = await readFile(absolute, 'utf8')
        if (content.includes('\0')) continue
        const lines = content.split(/\r?\n/)
        for (let index = 0; index < lines.length; index++) {
          const text = lines[index] ?? ''
          if (!text.toLowerCase().includes(needle)) continue
          matches.push({
            path: displayPath(root, absolute),
            line: index + 1,
            text: text.length > 500 ? '[Omitted long matching line]' : text,
          })
          if (matches.length >= MAX_WORKSPACE_MATCHES) {
            truncated = true
            break
          }
        }
      } catch {
        // Unreadable file — skip it.
      }
      if (truncated) break
    }
    if (truncated) break
  }

  return { matches, truncated }
}

/** Search the workspace for `query`, native first, bounded either way. */
export async function searchWorkspace(
  query: string,
): Promise<WorkspaceSearchResponse> {
  const needle = query.trim()
  if (needle.length === 0) {
    return { matches: [], truncated: false }
  }
  const native = await searchWithNative(needle)
  if (native !== null) {
    return native
  }
  return searchWithTypeScript(needle)
}
