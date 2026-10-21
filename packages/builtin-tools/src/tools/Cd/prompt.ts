export const DESCRIPTION =
  'Change the session working directory. Subsequent tool calls and relative ' +
  'paths resolve from the new directory.'

export const PROMPT = `Changes the session's working directory.

- Accepts absolute paths, paths relative to the current working directory,
  and \`~\`-prefixed paths (expanded to the user's home directory).
- The target must exist and be a directory.
- On success the working directory is updated: file tools, relative paths and
  the persistent shell all resolve from the new directory afterwards.
- Multi-agent isolation: inside a subagent (one running with its own cwd
  override), the change is written to that agent's override layer only — the
  main session's cwd is untouched, and concurrent agents do not overwrite
  each other. Without an override, the change applies to the global session.
- Changing to the session's original working directory while already there is
  a no-op (reported as "Already in ...").
- Directory moves are subject to permission rules: \`Cd\` deny rules block
  matching directories outright, and if \`Cd\` allow rules exist the target's
  realpath must match one of them (realpath escapes outside the rule root are
  refused).`
