# Claude worker interface freeze

Frozen on 27 September 2026 from read-only `claude --version` and `claude --help` on installed Claude Code 2.1.283. This is an offline implementation contract, not live Claude conformance.

## Launch and identity

- `roles.json` may select `runtime: "claude"` for a reviewer. `code-role.json` may select the same runtime for guarded proposals. Both require an explicit full model ID, an executable (`claude` or absolute path), and a positive per-invocation `maxBudgetUsd`; reviewer also requires an absolute directory. The budget is a provider-side best-effort limit, not a proven aggregate spend ceiling.
- Launch one foreground `claude --print --output-format stream-json --verbose` process with an explicit model, working directory and generated UUID session ID. Use `--restricted --safe-mode --strict-mcp-config --tools Read,Glob,Grep --permission-mode dontAsk --permission-prompts none --max-budget-usd` and no permission bypass, fallback, resume, background, worktree, or write tool. The user's existing authentication remains with Claude Code. The task is supplied as a single stdin prompt, never interpolated into a shell command.
- Require one bounded `system/init` event with the exact session ID, requested model and available read tools, followed by one matching terminal `result` event. Refuse missing, conflicting or malformed identities, an unexpected tool use, permission denial, error result, nonzero exit, oversized output, or a changed coding worktree. The process working directory and local `claude --version` are recorded separately; CLI output does not independently attest the backend provider or filesystem containment.
- Capture bounded final text, input/output tokens and reported USD cost when present; unknown measures remain null. Code text is normalized through the existing one-file literal/strict patch validator. The first Gattini approval binds the read-only proposal launch, and the second binds the exact validated replacement, session, fingerprint and checks. Gattini alone applies it and verifies the retained snapshot. The direct-edit gate remains disabled.

## Cancellation and recovery

- A live handle may cancel only its matching persisted session. Terminate its owned child/process group and require observed process exit before confirming `cancelled`; a signal request alone does not confirm it. If identity was not recorded, the child is lost, or exit cannot be confirmed, retain `interrupted` and the held scheduler slot.
- After daemon restart, a claimed Claude turn is never replayed or resumed automatically. CLI help exposes session resume, but no local read-only exact-session terminal-status protocol was established for this adapter. Restarted cancellation therefore remains uncertain and requires manual inspection. Queued unclaimed jobs and approved local applies retain the existing recovery rules.
- Reviewer follow-up is unsupported. No Claude provider turn, macOS permission request, install, runtime configuration edit, or paid test is part of this interface freeze.
