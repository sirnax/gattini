# ADR 006: Exact-session cancellation and uncertain recovery

Status: accepted for Task 6, 24 September 2026. Offline fault tests and one approved real Gattini cancellation passed; Checkpoint 2 awaits human review.

## Decision

Persist an attempt ID, daemon owner token, phase, lease expiry, exact runtime session ID, and cancellation intent in SQLite schema version 3. A queued review without a claimed attempt may resume after daemon restart. A launch that may have reached OpenCode becomes `interrupted` after restart and is never automatically replayed. Stale attempt callbacks are rejected by attempt ID and owner token; no PID is used as job identity.

A cancellation request enters `cancelling` before making an external call. If a queued job has no attempt, cancellation is immediately `cancelled`. Once an exact session ID exists, Gattini calls OpenCode V2 `session.interrupt` for that ID through the authenticated CLI connection. It marks the job `cancelled` only after the runtime reports that session inactive with outcome `interrupted` in the configured repository. An acknowledgement with continued activity, lost response, changed service, or unmatched identity leaves the job `interrupted`. Uncertain jobs retain their directory lock so a new job cannot overlap them. Gattini may stop its own CLI child after a cancellation decision; it never stops the shared OpenCode service.

On daemon restart, exact known sessions are inspected read-only. A terminal failed session becomes a failed job, and a terminal interrupted session with saved cancellation intent becomes cancelled. A terminal successful session whose output was lost becomes a failed Gattini job with `execution: completed` and `acceptance: unverified`; its scope lock is released without inventing review text. Active, unknown, or unbound sessions remain interrupted for manual reconciliation.

## Limits

The launch-to-first-session-event window still lacks a runtime handle. A crash there can leave an unlinked session, so the directory stays blocked instead of retrying. Leases fence callbacks and record ownership, but the current single-daemon scheduler does not use lease expiry to dispatch from another process. Graceful daemon shutdown waits for active work; force termination is recovered conservatively on restart. The five-minute CLI deadline is not a hard provider spend limit.
