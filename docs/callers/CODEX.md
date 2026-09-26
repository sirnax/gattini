# Codex caller

Use the shared [Gattini caller workflow](workflow.md) for the CLI contract, approval steps, evidence checks, and sandbox limits. Copy [the Codex task template](codex-task.md) into the task file. Keep the task, repository path, checks, and any retained evidence inside paths Codex is already allowed to access. Do not ask Codex to expand its sandbox or approve a Gattini gate. If Codex cannot reach the local CLI or socket, report that limitation for the repository owner to handle.
