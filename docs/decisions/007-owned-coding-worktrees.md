# ADR 007: Owned coding worktree preparation

Status: accepted for Task 7, 25 September 2026. This is a preparation component; code-worker dispatch and policy enforcement remain later tasks.

## Decision

`WorktreeManager` takes a job UUID, an absolute repository path, and a full commit SHA. It resolves the repository to its canonical Git root and verifies that the SHA names a commit directly. It stores the canonical repository, base SHA, branch, worktree path, and state in a private SQLite database before invoking `git worktree add`. The branch is `codex/gattini-<job UUID>` and the worktree is under the private Gattini state directory. It verifies the created worktree's `HEAD` against the requested SHA. The user's checkout, including dirty and untracked files, is not copied into the new worktree.

A database uniqueness constraint permits one reserved or ready writer per canonical repository. A failed creation is recorded. If a destination exists after a failure, the record stays reserved and blocks another writer pending manual inspection. No branch or worktree is removed automatically. `resolveWorktreePath` accepts clean relative paths only and rejects existing symlink chains that resolve outside the worktree. The SQLite file is user-owned and mode 0600; its parent directories are private.

## Limits

This component is not yet connected to the CLI/daemon job dispatcher. The existing `code` role remains a fake runtime. The record is keyed by a job UUID but is not yet a foreign key to the daemon's job table; that link belongs with code-job dispatch. A crash between reservation and Git completion leaves a reserved record for manual reconciliation. Git worktrees separate changes but do not restrict a worker's host file, network, or process access. Path validation before later use cannot prevent symlink swaps by a concurrent process; Task 8 needs an enforceable runtime or execution boundary before advertising path restrictions as security policy.
