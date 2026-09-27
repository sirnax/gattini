# Task 17 protocol version boundary for Checkpoint 6

Status: design boundary only, 27 September 2026. No v2 RPC or editor implementation exists. Checkpoint 6 approval is required before Task 17 implementation. The Task 15 `0.1.0` CLI and daemon speak protocol v1 and require exact release-version agreement through `hello`.

## Frozen v1 surface

The newline-delimited Unix-socket envelope remains `{protocolVersion:1,clientVersion?,requestId,method,params}` with a 1 MiB frame limit and typed `{code,message}` errors. The packaged CLI sends `clientVersion:"0.1.0"`, checks `hello` before a command, and rejects a different daemon release. It has durable `start`, `status`, `result`, `cancel`, `approvals.list`, `approve`, and `deny` calls. `result` rechecks retained snapshot/diff hashes but returns artifact paths and metadata rather than a bounded content stream. The store holds ordered event rows internally; v1 has no public event cursor. Direct v1 clients may omit `clientVersion`, so they must not claim the packaged CLI's release guard.

## Explicit next-version change

Task 17 must introduce **protocol v2 in a future package release**, with a matching CLI and daemon. A v2 editor must negotiate `hello` before submitting or acting; it must reject v1 and unknown versions instead of silently using unversioned additions. Exact wire shapes below are proposal inputs for Task 17 review, not a shipped contract:

- `events.list({jobId,afterSequence,limit})` returns a bounded, redacted page ordered by an integer sequence, with `nextSequence` and `hasMore`. `afterSequence` is exclusive; `0` starts at the beginning. The page limit must have a documented cap and response bytes must remain below 1 MiB. An empty page returns the supplied cursor unchanged. An unknown job, invalid/future cursor, or retention gap must have a typed error. Adapter-specific stored payloads must be projected into one public event shape without raw provider diagnostics, credentials or unbounded text.
- `evidence.read({jobId,attemptId?,kind})` returns a bounded verified projection of the retained diff or snapshot metadata, keyed by exact job and optional historical attempt. It must recheck retained digests before returning bytes, reject paths supplied by clients, enforce an output cap, and return `EVIDENCE_INVALID` on missing or changed artifacts. Raw snapshot contents may include private task data and should not be copied wholesale into an editor view.
- Existing approval/denial/cancellation methods stay exact-ID operations. The editor must refresh `approvals.list` and job status before presenting an action, handle `APPROVAL_STALE`, and render daemon/runtime text as untrusted data. If v2 changes any existing response field, document the replacement rather than assuming v1 clients understand it.

Task 17 verification must cover cursor replay after disconnect and daemon restart, duplicate delivery, missing sequences, malformed/future cursors, bounded output, multi-root paths with spaces, and Workspace Trust. Task 18 must add malicious evidence/rendering, stale approval, exact-ID cancellation and manual editor flow checks. This plan makes the version change explicit for Checkpoint 6; final wire shapes and implementation remain gated.
