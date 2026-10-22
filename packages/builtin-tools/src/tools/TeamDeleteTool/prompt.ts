export function getPrompt(): string {
  return `
# TeamDelete

Remove team and task directories when the swarm work is complete.

This operation:
- Removes the team directory (\`~/.claude/teams/{team-name}/\`)
- Removes the task directory (\`~/.claude/tasks/{team-name}/\`)
- Clears team context from the current session

**IMPORTANT**: TeamDelete fails while the team still has active members. It automatically sends shutdown/terminate to active members; wait_ms controls how long it waits for them to exit.

Inputs:
- wait_ms (optional, 0-30000): time to wait for active members to exit after TeamDelete requests shutdown. Without it the call fails immediately when members are still active.

Use this when all teammates have finished their work and you want to clean up the team resources. The team name is automatically determined from the current session's team context.
`.trim()
}
