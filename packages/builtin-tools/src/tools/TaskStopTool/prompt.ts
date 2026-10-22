export const TASK_STOP_TOOL_NAME = 'TaskStop'

export const DESCRIPTION = `Stops a running background task by its ID.

## When to use
- A long-running task is no longer needed (user cancelled, superseded, or clearly stuck).
- Do NOT use it to "refresh" a task, or on a task you just started and expect to finish.

## Inputs
- task_id (required): the task ID. Task IDs come from task tool results, task notifications, and the /tasks command.

## Behavior
- Only tasks in the \`running\` state can be stopped. A task that is pending, completed, failed, killed, or otherwise not running is rejected (errorCode 3) — check the /tasks command first if unsure.
- An unknown task_id is rejected (errorCode 1).
- Task types that do not support stopping raise an \`unsupported_type\` error.
- Returns a success or failure status; stopping is not instantaneous — the task receives a stop signal. The result reports the task id/type/command, not a post-stop status; use the /tasks command or task notifications to observe the final state.`
