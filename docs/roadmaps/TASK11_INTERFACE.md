# Task 11 interface freeze — 26 September 2026

This contract applies to the existing protocol version 1 and the current dirty checkout. The coordinator owns protocol, store, daemon dispatch, CLI integration, and migrations. Adapter and pinned-input helpers may be implemented independently against this document.

## Exact-session follow-up

`followup` accepts `{jobId, task, idempotencyKey}`. It accepts a completed OpenCode reviewer job with a saved exact session ID and matching resolved agent, model, and directory. It rejects fake jobs, guarded code jobs, absent handles, active jobs, and unsupported runtimes with typed `UNSUPPORTED_FOLLOWUP`; a wrong job ID returns `NOT_FOUND`. The follow-up is a new durable turn of the same job, with a new attempt ID and the same exact OpenCode session ID. Idempotency keys bind to the job and task. The adapter invokes `opencode run --session <saved-id>` with explicit agent and model, verifies every event's session ID, then checks the resolved session identity and outcome. It must never use implicit last-session routing.

Each completed turn gets an immutable result record indexed by attempt ID. Existing `result JOB_ID` returns the latest turn and includes its `attemptId`; `result JOB_ID --attempt-id ID` retrieves a specific completed turn. An earlier record and its retained artifact hashes never change when a later turn completes. The job's latest result may change only after the new turn completes. A failed or uncertain follow-up preserves the previous completed result and exposes the current job state. The new attempt is persisted before launch; a claimed attempt is never replayed after restart without reconciliation.

## Independent review

`review` accepts `{jobId, idempotencyKey}` for a completed guarded code job with a passed retained snapshot. It creates a distinct reviewer job linked to the source job and exact source attempt. The daemon validates the retained snapshot and diff file digests before constructing a bounded review prompt solely from those retained bytes and their digests. The reviewer uses the configured deny-all/read/glob/grep policy. Its configured directory must be outside the coding worktree, and the prompt must not include the mutable worktree path. If retained content exceeds the bounded review input, return `SNAPSHOT_TOO_LARGE`; if a digest fails, return `EVIDENCE_INVALID`. A review result reports its pinned source job/attempt and snapshot/diff digests. Review cannot approve actions or change the source job's acceptance. The coding worktree is fingerprinted before and after reviewer execution and a change fails the review.

Both commands are offline-testable with a scripted OpenCode CLI. No live provider call or code direct-edit gate change is part of this interface freeze.
