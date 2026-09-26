# Claude Code caller

Use the shared [Gattini caller workflow](workflow.md) for the CLI contract, approval steps, evidence checks, and sandbox limits. Copy [the Claude task template](claude-task.md) into the task file. Keep the task, repository path, checks, and any retained evidence inside paths Claude Code is already allowed to access. Do not ask Claude Code to expand its sandbox or approve a Gattini gate. If Claude Code cannot reach the local CLI or socket, report that limitation for the repository owner to handle.
