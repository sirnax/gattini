# ADR 004: Durable fake job slice

Status: accepted for Task 4, 24 September 2026. Revisit storage and scheduling before real worker launch.

## Decision

Use Node's built-in `node:sqlite` `DatabaseSync` for the first local SQLite store. It is available on the installed Node 24.21.0 and 26.9.0 builds, but remains an experimental Node API. Keep this dependency-free slice small and test both versions. Store versioned job and event JSON with a unique idempotency key, and migrate schema version 0 to 1 transactionally. Reject a database from a newer schema version. Task 5 adds a version 1 to 2 migration for OpenCode session and resolved-identity fields.

The daemon serves one bounded, versioned JSON request and response per Unix socket connection. The CLI supports `start`, `status`, and `result`; it never owns job execution. State defaults to `~/Library/Application Support/Gattini`, with an absolute `GATTINI_STATE_DIR` override for isolated use. The directory must be owned by the current user with mode 0700; the database and socket use mode 0600. The socket is local access control, not isolation from a hostile process running as the same user.

For the fake adapter, the daemon transactionally stores the parsed job, resolved fake runtime config, and idempotency key before running it. A repeated key with the same task and role returns the original job ID; conflicting reuse fails. Results and ordered events are committed together. On startup, unfinished `queued` or `running` jobs become `interrupted` and are never automatically relaunched. Real runtime work will need a persisted exact session handle and reconciliation before retry; this slice does not claim exactly-once external effects.

## Consequences

The synchronous SQLite calls and fake execution briefly block the daemon event loop. That is acceptable for the deterministic fake slice and must be revisited before concurrent real jobs. The CLI result reports `acceptance: unverified` because no real task or verification ran. There is no startup service, provider call, automatic cleanup, or OpenCode dispatch in this decision.
