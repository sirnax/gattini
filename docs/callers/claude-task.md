# Claude Code task template for Gattini

```text
Task: <one bounded change or review>

Repository: <absolute repository path>
Base commit: <full commit SHA>
Allowed scope: <exact files or directories>
Acceptance criteria:
- <observable requirement>

Checks: <direct argv commands from the owner's checks.json>
Limits: do not edit outside the allowed scope; do not bypass sandbox, permissions, approvals, or repository policy. Report uncertainty and blockers instead of guessing.

Return: concise change summary, exact files changed, checks run and outcomes, and any limitations. Do not claim acceptance passed unless Gattini's result says passed and its snapshot/evidence has been inspected.
```

For review-only work, omit trusted coding options and use the `reviewer` role. For a trusted code task, the owner supplies `checks.json`, full base SHA, and the explicit two-approval workflow described in [workflow.md](workflow.md).
