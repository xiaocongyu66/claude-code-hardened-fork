import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { getProjectRoot } from '../bootstrap/state.js'
import { logForDebugging } from '../utils/debug.js'
import type { ProgressBus } from './progress/bus.js'
import type { ProgressStore, RunProgress } from './progress/store.js'

/** Current schema version of state.json; introduces a migration chain on upgrade. */
const SCHEMA_VERSION = 1
const STATE_FILE = 'state.json'
const STATE_TMP = 'state.json.tmp'

/**
 * Hard ceiling on persisted run directories on disk. Beyond this, the oldest runs (by updatedAt)
 * are pruned by cleanupOldRuns. Set generously above LOAD_PERSISTED_LIMIT so runs hidden from the
 * panel can still be resumed manually before aging out.
 */
const KEEP_MAX_RUNS = 50

/**
 * Single source for runsDir: shares the same root as ports.ts journalStore (${projectRoot}/.claude/workflow-runs).
 * Extracted as a function: eliminates duplicated path concatenation between ports.ts and persistence logic, staying in the same root when entering worktree/subdirectory.
 * Tests monkey-patch this function to point at a tmpdir.
 */
export function getRunsDir(): string {
  return join(getProjectRoot(), '.claude', 'workflow-runs')
}

type StateFile = {
  schemaVersion: number
  run: RunProgress
}

// Process-local ownership includes pre-start/resume IO and terminal writes. GC claims a
// directory before issuing rm, so registration cannot race an already-dispatched removal.
const activeDirectories = new Set<string>()
const deletingDirectories = new Set<string>()
const pendingWrites = new Map<string, Promise<void>>()
// Invalidate stale scans even after a claim/write has finished. A single revision
// avoids retaining an unbounded generation index for historical run IDs.
let directoryRevision = 0

export function isRunDirectoryActive(runsDir: string, runId: string): boolean {
  return activeDirectories.has(resolve(runsDir, runId))
}

export function claimRunDirectory(runsDir: string, runId: string): () => void {
  const key = resolve(runsDir, runId)
  if (
    activeDirectories.has(key) ||
    pendingWrites.has(key) ||
    deletingDirectories.has(key)
  ) {
    throw new Error(
      `Workflow ${runId} is active, persisting, or being cleaned up`,
    )
  }
  directoryRevision++
  activeDirectories.add(key)
  let released = false
  return () => {
    if (released) return
    released = true
    directoryRevision++
    activeDirectories.delete(key)
  }
}

/**
 * Atomically overwrite the terminal RunProgress to <runsDir>/<runId>/state.json.
 * Atomicity: writeFile(tmp) → rename(tmp, target), rename is atomic; worst case leaves tmp, next write overwrites it.
 * Rejects on failure: callers must not treat a failed write as permission to evict.
 * Serialize before any IO, then queue per directory to avoid overlapping tmp writes.
 */
export async function writeRunState(
  runsDir: string,
  run: RunProgress,
): Promise<void> {
  const dir = join(runsDir, run.runId)
  const target = join(dir, STATE_FILE)
  const tmp = join(dir, STATE_TMP)
  const payload: StateFile = { schemaVersion: SCHEMA_VERSION, run }
  const serialized = JSON.stringify(payload)
  const key = resolve(dir)
  if (deletingDirectories.has(key))
    throw new Error(`Workflow ${run.runId} is being cleaned up`)
  const previous = pendingWrites.get(key) ?? Promise.resolve()
  const pending = previous
    .catch(() => {})
    .then(async () => {
      await mkdir(dir, { recursive: true })
      await writeFile(tmp, serialized, 'utf-8')
      await rename(tmp, target)
    })
  directoryRevision++
  pendingWrites.set(key, pending)
  try {
    await pending
  } finally {
    directoryRevision++
    if (pendingWrites.get(key) === pending) pendingWrites.delete(key)
  }
}

/**
 * Read <runsDir>/<runId>/state.json with fault tolerance:
 * - File does not exist → null (caller treats it as a miss)
 * - JSON parse failure / schema structure mismatch / schemaVersion mismatch → null (log warn, do not crash)
 */
export async function readRunState(
  runsDir: string,
  runId: string,
): Promise<RunProgress | null> {
  const target = join(runsDir, runId, STATE_FILE)
  let raw: string
  try {
    raw = await readFile(target, 'utf-8')
  } catch {
    return null
  }
  try {
    const parsed = JSON.parse(raw) as Partial<StateFile>
    if (parsed.schemaVersion !== SCHEMA_VERSION) return null
    const run = parsed.run
    if (!run || typeof run !== 'object') return null
    if (typeof run.runId !== 'string') return null
    if (typeof run.status !== 'string') return null
    return run as RunProgress
  } catch (e) {
    logForDebugging(
      `[workflow warn] readRunState parse failed for ${runId}: ${(e as Error).message}`,
    )
    return null
  }
}

/**
 * Scan all subdirectories under runsDir, read each state.json, return a list of non-null RunProgress.
 * - runsDir does not exist → empty array
 * - A subdirectory without state.json (half-written run) → skip
 * - A subdirectory whose state.json is corrupted → skip that single one, keep scanning the rest
 * - Sort by updatedAt descending (consistent with store.list() ordering)
 * - Optional limit: keep only the first N newest (used by loadPersistedRuns so the panel
 *   doesn't drown under months of history; full scan stays available by omitting the arg).
 */
export async function listPersistedRuns(
  runsDir: string,
  limit?: number,
): Promise<RunProgress[]> {
  let entries: string[]
  try {
    entries = await readdir(runsDir)
  } catch {
    return []
  }
  const runs: RunProgress[] = []
  for (const name of entries) {
    const run = await readRunState(runsDir, name)
    if (run) runs.push(run)
  }
  runs.sort((a, b) => b.updatedAt - a.updatedAt)
  return limit !== undefined && limit >= 0 ? runs.slice(0, limit) : runs
}

/**
 * Garbage-collect stale run directories: sort subdirs of runsDir by their state.json.updatedAt
 * (newest first), then remove terminal history past keepMax. Unknown/running directories
 * are not evidence of abandoned runs and must not be pruned. Process-owned directories
 * are protected even when their state.json still describes an earlier terminal generation.
 *
 * Best-effort: per-dir failures only log, do not abort the sweep. Safe to call repeatedly
 * (idempotent — once under the cap, it's a no-op).
 *
 * @returns number of directories actually removed.
 */
export async function cleanupOldRuns(
  runsDir: string,
  keepMax: number = KEEP_MAX_RUNS,
): Promise<number> {
  const scanRevision = directoryRevision
  let entries: string[]
  try {
    entries = await readdir(runsDir)
  } catch {
    return 0
  }
  type Candidate = { name: string; updatedAt: number }
  const candidates: Candidate[] = []
  for (const name of entries) {
    const run = await readRunState(runsDir, name)
    if (!run || !['completed', 'failed', 'killed'].includes(run.status))
      continue
    candidates.push({ name, updatedAt: run.updatedAt })
  }
  // Newest terminal history first.
  candidates.sort((a, b) => b.updatedAt - a.updatedAt)
  // Guard against negative keepMax: slice(-N) would invert semantics and keep N newest instead of
  // pruning them, which contradicts the contract. Clamp to 0 so a bad caller at worst wipes everything.
  const cap = Math.max(0, Math.trunc(keepMax))
  const victims = candidates.slice(cap)
  let removed = 0
  for (const v of victims) {
    // Claims/writes during any await invalidate the ordering and generation.
    // Defer collection to a fresh sweep rather than deleting from stale evidence.
    if (directoryRevision !== scanRevision) break
    const key = resolve(runsDir, v.name)
    if (
      activeDirectories.has(key) ||
      pendingWrites.has(key) ||
      deletingDirectories.has(key)
    )
      continue
    deletingDirectories.add(key)
    try {
      await rm(join(runsDir, v.name), { recursive: true, force: true })
      removed++
    } catch (e) {
      logForDebugging(
        `[workflow warn] cleanupOldRuns failed to remove ${v.name}: ${(e as Error).message}`,
      )
    } finally {
      deletingDirectories.delete(key)
    }
  }
  return removed
}

/**
 * Subscribe to the bus's run_done event and write the terminal RunProgress to state.json on disk.
 * Covers all three terminal states (completed/failed/killed; shutdown-kill also routes to run_done killed).
 * The store registers to the bus before this subscription, so when the listener runs store.get(runId) is already terminal.
 * Returns an unsubscribe function (for test cleanup).
 *
 * The listener handles rejection without interrupting other subscribers. Only a successful
 * write acknowledges the exact store generation as safe to evict.
 *
 * Also fires-and-forgets cleanupOldRuns so the runs directory stays bounded across long-lived
 * sessions (KEEP_MAX_RUNS). The cleanup runs *after* the new state is written, guaranteeing the
 * just-finished run is already on disk and counted as newest — never swept out from under itself.
 *
 * @param runsDirProvider Optional runsDir resolver (defaults to getRunsDir).
 *   Production path uses the default; tests inject a tmpdir to avoid writing to the real project directory (Bun ESM module namespace is read-only,
 *   cannot monkey-patch getRunsDir itself).
 */
export function attachRunStatePersistence(
  bus: ProgressBus,
  store: ProgressStore,
  runsDirProvider: () => string = getRunsDir,
): () => void {
  return bus.subscribe(event => {
    if (event.type !== 'run_done') return
    const run = store.get(event.runId)
    if (!run) return
    const dir = runsDirProvider()
    void writeRunState(dir, run)
      .then(() => {
        store.markPersisted(run)
        return cleanupOldRuns(dir)
      })
      .catch(e => {
        logForDebugging(
          `[workflow warn] terminal persistence for ${run.runId} failed: ${(e as Error).message}`,
        )
      })
  })
}
