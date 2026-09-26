# Task 13 Codex worker interface freeze

Frozen on 26 September 2026 against installed `codex-cli 0.157.1` generated app-server types. Task 13 is open until an approved live read-only run confirms this offline contract. The adapter owns only `src/adapters/codex-app-server.ts` and its focused tests; the primary owns role configuration, protocol, store, daemon, CLI, integration, and final verification.

## Narrow first capability

- A `codex-reviewer` job is a single read-only turn in an explicit Codex thread. It uses normal configured Codex authentication and an explicit configured model. The job's task is untrusted input. No Gattini-managed credentials or global Codex config changes.
- Start an app-server child on stdio using installed `codex`. Send `initialize`, `initialized`, `thread/start` with exact `model`, `cwd`, `sandbox: "read-only"`, `approvalPolicy: "on-request"`, and `approvalsReviewer: "user"`; then `turn/start` with the returned thread ID and text input. Require returned model/provider/cwd/policy/sandbox to match the request. Capture thread ID, session ID, turn ID, CLI version, model/provider, terminal status, bounded assistant text, and usage when present. A model reroute is an identity failure.
- Deny every app-server approval request. A read-only job cannot grant command, file, permission, network, or tool escalation from within the worker. Unexpected server requests fail closed. Do not infer containment beyond Codex's tested read-only policy.
- `turn/interrupt` must target the exact saved thread and turn. A response alone is not terminal confirmation: consume a matching completed/failed/interrupted turn or leave the job uncertain. A missing turn ID cannot be cancelled as confirmed. Child process exit alone cannot establish successful cancellation.
- Continuation is unsupported in Task 13. Gattini `followup` returns `UNSUPPORTED_FOLLOWUP` for this role. Coding and review of a pinned snapshot through Codex are outside this first adapter; Task 14 must test those separately before a portability claim.
- The adapter takes a configured executable path (default `codex`) and a mockable child transport for offline tests. It does not inspect or persist auth secrets. Protocol messages, event text, and usage are bounded. Unknown cost remains null.

## Offline acceptance boundary

Mock stdio fixtures cover initialize, thread/start identity, turn/start/completion, denial of every approval family, unexpected request, reroute, malformed/oversize framing, timeout, child loss, exact-ID interruption, and missing interruption confirmation. The primary then integrates the role with durable store/daemon dispatch and runs the full Node 24 and 26 suites. Neither fixture success nor app-server type generation marks Task 13 complete; the live read-only test needs specific owner approval and recorded model/session identity.
