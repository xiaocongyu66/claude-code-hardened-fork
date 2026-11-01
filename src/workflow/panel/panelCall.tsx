import type { LocalJSXCommandCall } from '../../types/command.js';
import { SentryErrorBoundary } from '../../components/SentryErrorBoundary.js';
import { WorkflowsPanel } from './WorkflowsPanel.js';
import { getWorkflowService } from '../service.js';

/**
 * local-jsx call for /workflows: builds the panel element and returns it for Ink to render.
 *
 * Wrapped in SentryErrorBoundary: when useSyncExternalStore / listNamed / child components
 * throw, the exception must not break through to the REPL top level and crash the whole session; the boundary falls back to a local error card.
 * With a runId, reads the full historical result without hydrating the live store.
 */
export const call: LocalJSXCommandCall = async (onDone, context, args) => {
  const runId = args.trim();
  if (runId) {
    // This is an ID, not a path. Never let command arguments escape the runs directory.
    if (!/^[a-zA-Z0-9_-]+$/.test(runId)) {
      onDone('Usage: /workflows [runId]');
      return null;
    }
    try {
      const run = await getWorkflowService().getRunAsync(runId);
      onDone(run ? JSON.stringify(run, null, 2) : `Workflow ${runId} not found (or history expired).`);
    } catch (error) {
      onDone(`Unable to read workflow ${runId}: ${error instanceof Error ? error.message : String(error)}`);
    }
    return null;
  }
  return (
    <SentryErrorBoundary name="WorkflowsPanel">
      <WorkflowsPanel onDone={onDone} context={context} />
    </SentryErrorBoundary>
  );
};
