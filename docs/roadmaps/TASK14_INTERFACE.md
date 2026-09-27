# Task 14 cross-runtime interface freeze

Frozen after Task 13 commit `d8623b1` on 26 September 2026. The offline matrix and separately approved live code, review and cancellation checks later satisfied Task 14 within its declared OpenCode/Codex boundary; Checkpoint 5 still awaits human review. The primary owns shared contracts, role configuration, protocol, store, daemon, scheduler integration, and final verification. Workers may own disjoint adapter or test files only. No nested delegation.

Revision for the owner-approved Task 14 follow-up on 27 September 2026: a read-only worker may propose exactly `{path,oldText,newText}` as three strings. `oldText` must be a nonempty, unique literal substring of one tracked root-level regular UTF-8 file; `newText` replaces only that occurrence. Gattini computes the preimage hash and complete replacement bytes locally, converts this to the existing strict `{path,beforeSha256,afterBase64}` patch, then uses the unchanged validator, fingerprint, two exact approvals, atomic apply and snapshot path. Saved strict patch proposals remain valid for recovery and fake fixtures. The worker still has no edit permission. This revision addresses the observed model inability to calculate hashes and base64 with read/glob/grep tools. The [follow-up](TASK14_FOLLOWUP_LIVE.md) and [Codex recheck](TASK14_CODEX_RECHECK.md) document the later live results.

## Common job surfaces

- **Review:** the caller submits the same bounded task with `role: reviewer`, identical task text, idempotency semantics, timeout, result schema and `acceptance: unverified` under either runtime. A private role mapping selects `opencode` or `codex`; the caller does not rewrite the task. Keep `codex-reviewer` as a Task 13 compatibility alias, but it is not the portability demonstration. Reject unsupported follow-up or safeguards before dispatch.
- **Code:** the caller submits the same `role: code`, `trustedLocal: true`, repository/base SHA and verification commands under either runtime. The private code role mapping selects a runtime. Both backends must make a **read-only proposal** in an owned worktree; only Gattini validates and applies the exact patch after two exact approvals. The legacy direct-edit gate stays disabled. The snapshot and acceptance check path stays shared.
- **Cancellation:** request exact job ID; distinguish requested, confirmed, and uncertain. Codex may confirm only from a matching interrupted turn. OpenCode may confirm only from exact-session interruption plus inactive/terminal status. A daemon crash never blindly replays either runtime attempt. Differences are recorded in the compatibility matrix.
- **Evidence:** common status/result/error fields and attempt history remain stable. Runtime-specific identity and limits are preserved in `resolved` and `limitations`. Unknown USD cost is null. No scheduler capacity rule branches on provider names.

## Codex proposal adapter boundary

An isolated adapter wrapper may own `src/adapters/codex-proposal.ts` and `tests/codex-proposal.test.ts`. It accepts explicit model/provider/executable, the canonical owned worktree path, task, timeout, an identity callback and optional cancellation signal. It uses the Task 13 app-server read-only transport to ask for **only** strict JSON `{path,oldText,newText}` and returns the raw bounded proposal, exact identity and usage. It must reject a non-completed turn, empty/oversize proposal, policy/identity mismatch, approval request ambiguity, and model reroute. It never writes or applies files and makes no provider call in fixtures. The primary owns normalization, validation, approval, apply and snapshot binding.

## Offline matrix boundary

Use fake OpenCode and Codex transports in separate private fixture state, with the identical task file and role name. Assert schema-valid lifecycle, exact identity, result/usage provenance, deduplication, restart/uncertainty, policy denial, unsupported continuation, and cancellation confirmation versus uncertainty. Code fixtures must prove source checkout preservation, owned-worktree changes only after exact approvals, and shared snapshot/check evidence. A fake matrix is preparation for live checks, not proof of two real runtimes. Do not run a provider, create external repositories, install, publish, enable services, or alter global runtime configuration.

## Live gate still needed

Present a specific, reviewable plan for the Task 14 live code/review/cancel matrix before provider execution. The Task 13 one-job approval is exhausted. Record exact model/session identities, runtime versions, permission observations, costs or unknown costs, and unsupported capabilities. Checkpoint 5 separately asks the human to decide whether Claude worker support is needed before Gate B.
