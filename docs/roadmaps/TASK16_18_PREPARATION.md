# Tasks 16–18 preparation

Status: preparation only, 27 September 2026. This note records local acceptance requirements and protocol gaps; it is not implementation, test evidence, publication authorization, or approval to begin the extension. The roadmap remains authoritative. Task 16 local work may follow Task 15 while Checkpoint 6 approval is pending. Extension implementation requires explicit human approval at Checkpoint 6.

## Dependencies and scope

```text
Task 15 package and lifecycle evidence
           ├── Task 16 local formula preparation/validation
           └── Checkpoint 6 review/approval
                     └── Task 17 submit/status → Task 18 results/actions
                                                   ↓
                                         Checkpoint 7 / Gate C
```

Task 16 local preparation and validation can run independently once Task 15 is complete, including while Checkpoint 6 approval is pending. Creating an external tap and publishing a release are separate owner-approved actions. Task 17 and Task 18 are sequential; shared protocol, store, migration, and daemon changes stay with the primary unless a later interface assignment names one owner. Preparation and fixture design may happen earlier, but editor implementation waits for Checkpoint 6 approval.

## Task 16 — local Homebrew formula acceptance

The repository currently has no formula or release workflow. Task 15 creates a private-source `0.1.0` npm tarball with a checksum; its `gattini` and `gattinid` commands point at JavaScript under `dist/`, require Node `>=24`, and declare macOS arm64. The package has no production npm dependencies, but the formula must declare a compatible Node runtime. Only the Apple Silicon development Mac has been exercised; do not infer broader platform support.

After Task 15, validate a draft formula in a disposable local tap and controlled Homebrew prefix:

- Run `brew audit --strict --formula` and `brew test` against the local formula; retain command output and Homebrew/macOS/architecture versions.
- Install the exact versioned artifact and verify its recorded SHA-256, source revision, and both CLI/daemon versions. Exercise daemon/client compatibility and a clear mismatch response from the installed package.
- Exercise upgrade and uninstall with disposable state. Verify Gattini binaries are removed on uninstall while user state, jobs, configuration, credentials, worktrees, and any pre-existing service state are preserved. No login service is enabled implicitly.
- Check every advertised architecture with an equivalent install and lifecycle run. Formula dependencies must match the artifact and must not install or authenticate a provider runtime.
- Record owner/repository/formula naming and trademark checks before any external tap is created.

**Acceptance:** strict audit, formula test, clean local install/upgrade/uninstall, checksum/source identity, daemon/client behavior, and dependency/platform claims all pass. Keep external tap creation and publication outside this local gate; each needs owner approval. Before Checkpoint 7, record publication as complete or explicitly deferred by the owner.

## Task 17 — submit and status client

The extension remains a thin caller of the daemon's versioned local protocol. It submits once with an idempotency key, retains the exact returned job ID, displays durable status, and reconnects to the same job. It does not implement scheduling, runtime selection/configuration, or a second job store. Opening a workspace must not launch work. Require VS Code Workspace Trust before task submission and make untrusted workspaces unable to bypass the block. For multi-root workspaces, select the repository explicitly; handle spaces in task and state paths. Report daemon unavailable, restart, protocol mismatch, and typed daemon errors in a useful way.

### Exact event-cursor gap

The project intent calls for versioned RPC, ordered events, cursors, and resumable streaming (master plan §3 and §4). Some underlying pieces exist, but the client contract does not:

| Surface | Existing behavior | Missing for extension reconnect |
| --- | --- | --- |
| Protocol | `PROTOCOL_VERSION = 1`; newline JSON request/response with request IDs, a 1 MiB message limit, a fixed method list, and typed `{code,message}` errors. Task 15 adds `hello` and CLI/daemon release-version checks. | No event method, subscription, cursor parameter, or negotiation for new event methods. Any new surface needs explicit versioning or Checkpoint 6 stability review. |
| Durable rows | SQLite `events` rows are keyed by job and have an integer sequence. Fake events use contract `RuntimeEvent` sequence values; recorded OpenCode events receive `max(sequence)+1`, capped at 1,000. | `JobStore.events(jobId)` returns the entire ordered history internally, but no daemon request exposes it. No bounded page, high-water mark, or resume token is defined. |
| Status/result | `status(jobId)` returns job state, timestamps, runtime session ID, and resolved runtime identity. `result(jobId[,attemptId])` returns the result and validates retained snapshot/diff hashes. | Status has no event sequence/cursor. Result does not substitute for progress retrieval. |
| Runtime event shape | Fake events conform to `RuntimeEvent` (`schemaVersion`, `jobId`, `sequence`, timestamp, type, payload). OpenCode rows instead store an internal projection (`source`, type, tool/status, and selected usage data); these are not the same public schema. | There is no stable client event envelope, public filtering/redaction contract, or rule for gaps and duplicate delivery. |

Before implementing Task 17, specify a bounded polling/page contract or a subscription contract with replay semantics. At minimum define a per-job monotonic cursor, exclusive/inclusive resume behavior, maximum page size, next cursor/high-water mark, empty-page behavior, and typed handling for unknown jobs, invalid/future cursors, and protocol mismatch. A client should persist the last fully processed sequence, request strictly after it, tolerate duplicate delivery, detect a missing sequence instead of silently skipping it, and refresh status after daemon restart. If a bounded retention policy is introduced, return an explicit gap/reset signal. Do not call the existing adapter `event-stream` capability proof of a client-facing event stream.

Offline extension-host checks should cover submit idempotency, status, cursor replay and ordering, duplicate/lost connection cases, daemon absent/restart, protocol mismatch, Workspace Trust, multi-root repository selection, and paths with spaces. A manual VS Code flow must show the same durable job ID and state seen through the CLI. These are proposed checks, not current evidence.

## Task 18 — results, evidence, and actions

Add result/evidence display and exact-ID approval, denial, and cancellation controls only after Task 17. Existing protocol methods already accept `result(jobId, attemptId?)`, `approvals.list`, `approve(approvalId)`, `deny(approvalId)`, and `cancel(jobId)`. Approval decisions are checked against the exact pending approval and current job/action state; stale or expired actions return `APPROVAL_STALE`. The approval list currently returns up to 20 pending approvals globally, so the UI must visibly bind each decision to the returned exact approval ID and associated job/action, and refresh before offering an action. Never infer an approval ID from the job ID or apply a decision to a different row.

`result` exposes structured summaries, changed-file names, verification, limitations, usage, and potentially snapshot artifact paths and hashes. It verifies the saved snapshot and diff bytes on retrieval, but the daemon protocol has no bounded artifact-content read method. Do not let a webview or an untrusted result path cause arbitrary filesystem reads. Decide a narrow, verified evidence-display path (for example, a daemon-returned bounded content projection or a carefully checked extension-host read from the owned artifact location) before implementing diff display. Keep raw provider text and paths out of HTML interpolation; render untrusted output as text with a restrictive webview content security policy. Diagnostic export must omit credentials, private runtime configuration, task content unless explicitly selected, and sensitive absolute paths; add adversarial redaction tests.

Required checks include malicious result markup, path traversal and oversized evidence, exact-job cancellation, stale/expired approval and concurrent refresh, denial, daemon disconnect during action, and no secret disclosure in logs/export. Confirm cancellation state from refreshed durable status; a request acknowledgement alone is not proof that runtime work stopped. Complete one manual VS Code task from submit through result/evidence and any approval state. Document any derivative editor as CLI-compatible or individually tested.

## Checkpoint constraints and evidence

Checkpoint 6 requires Task 15's reproducible local install, upgrade preservation, a stable or explicitly versioned protocol/evidence/approval surface, and human approval for extension work. Tap publication may remain pending at that point. Checkpoint 7 requires the CLI and editor to operate on the same durable jobs and show evidence/approval state correctly, usable fresh-account install/recovery guidance, Task 16 local validation, and the owner's publication-or-deferral decision.

For each task record base revision, owned paths, exact commands and outputs, package/runtime versions, artifact checksums or fixture IDs, and limitations. Keep offline fixture results distinct from installed-package observations and manual editor evidence. Revisit this cursor analysis after any protocol or Task 15 packaging change.
