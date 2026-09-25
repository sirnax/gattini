# ADR 005: Durable OpenCode review handoff

Status: accepted for Task 5, 24 September 2026. One approved paid end-to-end review passed.

## Decision

A `reviewer` job requires a private `roles.json` in the Gattini state directory. Its strict versioned mapping names one OpenCode agent, exact provider/model, absolute working directory, current loopback service address, and ordered deny-all/read-only permissions. Gattini checks the installed OpenCode version (exactly 2.0.16), the already-running service, the agent's effective permission tail, and the model catalogue before invoking `opencode run --agent ... --model ... --format json`.

The CLI's authenticated automatic service connection is the tested path. An explicit `--server` URL received HTTP 401 from the user's Basic Auth service, even though the automatic connection worked. Gattini therefore verifies that `opencode service status` matches the configured address and that `opencode api session.active` succeeds before using the automatic connection. It does not start or stop the shared service. A service change between preflight and launch remains a race to address in later lifecycle work.

The daemon transactionally stores the job, resolved role configuration, and idempotency key before acknowledging submission. A daemon-owned asynchronous supervisor launches the review after the client can disconnect. The first NDJSON event's session ID is persisted, subsequent events must keep it, and a final exact-session API lookup must match the requested agent/model with outcome `succeeded`. The result keeps acceptance `unverified`; independent review verification is a later task. If communication fails after a session ID exists, the job is `interrupted` and is never automatically relaunched. Schema version 2 added the exact runtime session ID and resolved identity to the original SQLite store; Task 6 adds version 3 attempt leases and cancellation state.

## Live evidence and limits

An approved four-step review from a private Gattini state directory returned a queued job ID, then completed after the submitting CLI disconnected. A second client and a restarted daemon retrieved its result. The exact OpenCode session reported the requested `gattini-probe` agent, `openrouter/z-ai/glm-5.3-flash` model, disposable repository directory, and `succeeded` outcome. The tracked sentinel hash did not change. OpenCode reported USD 0.00079485. Full commands and session IDs are in the compatibility report and roadmap.

The first Gattini submission failed before model execution with USD 0 reported because the spawned CLI inherited the daemon's `PWD` environment despite a different process working directory. Setting both `cwd` and `PWD` to the configured repository resolved it. The failed job remains `interrupted` with its exact session handle, rather than being silently retried.

The agent policy restricts OpenCode tools in the tested configuration; it is not host isolation. A daemon crash between external launch and the first persisted session event can leave an unlinked runtime session. Task 6 must reconcile exact handles and uncertain state before retries. The five-minute CLI timeout bounds Gattini's wait, not provider spend or the shared runtime's lifetime. Further paid verification remains opt-in.
