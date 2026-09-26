# Task 13 proposed live Codex worker check

Prepared and specifically approved 26 September 2026. The one authorized read-only check has run once and is complete; this document does **not** authorize another run. The Checkpoint 4 approval and earlier OpenCode math-fixture consent alone did not cover this different runtime. This was one read-only worker job, not a coding, cancellation, or Task 14 conformance run. Observed results are recorded in the roadmap and compatibility report.

## Exact data and destination

- Destination: installed `/opt/homebrew/bin/codex` (`codex-cli 0.157.1`) app-server stdio, using the user's normal configured Codex authentication and OpenAI model provider. Requested model: `gpt-6-luna`. If unavailable or resolved differently, fail closed; do not substitute.
- Local disposable fixture: `/private/tmp/gattini-task13-live.knW42v`, created without a Git remote. The only file the prompt asks the worker to read is `math.mjs` (SHA-256 `5b63136552577a64d788dc3cd4552739d0d60f9e1adb63ec4dfb6932d56fc75d`):

  ```js
  export function add(a, b) {
    return a + b;
  }
  ```

- Exact task text in `task.txt` (SHA-256 `e5ae842626e88b08798faca67778984d4a532e5b187437814daac1d7e8d7927b`): “Read only the local math.mjs fixture in this directory. State what add(2, 3) returns and why in one sentence. Do not edit files, run network requests, or continue beyond this one answer.”
- The worker process will have its cwd in this private fixture. Codex may also load the user's existing Codex configuration/instructions as part of normal authentication; Gattini will not alter or disclose their contents. No repository source tree or private Task 9/10 evidence is an intended input.

## Boundaries and intended commands

- Before launch, recheck `codex --version`, exact fixture hashes, and the Gattini Git status. Create a private 0700 test state directory under the fixture and a 0600 `codex-role.json` with `{ "schemaVersion":1, "runtime":"codex", "model":"gpt-6-luna", "modelProvider":"openai", "directory":"/private/tmp/gattini-task13-live.knW42v", "executable":"/opt/homebrew/bin/codex" }`. No global runtime configuration changes.
- Start a foreground disposable Gattini daemon with `GATTINI_STATE_DIR=/private/tmp/gattini-task13-live.knW42v/state node dist/src/daemon/gattinid.js`. In a second local client, submit exactly once: `GATTINI_STATE_DIR=/private/tmp/gattini-task13-live.knW42v/state node dist/src/cli/gattini.js run --task-file /private/tmp/gattini-task13-live.knW42v/task.txt --idempotency-key task13-codex-readonly-once --role codex-reviewer --json`.
- The Codex thread is requested with `sandbox: read-only`, `approvalPolicy: on-request`, and `approvalsReviewer: user`. Gattini declines command/file approvals and fails closed on other requests. It records the returned thread/session/turn IDs, model/provider, CLI version, terminal status and token usage. The durable job times out at 60 seconds; text is limited to 4,096 bytes, and protocol messages/events are bounded. A timeout leaves runtime state uncertain rather than claiming cancellation.
- The installed protocol describes thread model fields as configured or persisted model state, not independent per-turn provider telemetry. The test compares Codex's returned resolved model/provider with the request and rejects a `model/rerouted` event, then records that telemetry limit. It will not claim backend model attestation beyond those observations.
- Inspect exact job status/result, attempt rows, app-server identity, fixture file hashes and directory entries after execution. Stop only the disposable foreground Gattini daemon. Preserve its state and the fixture for review; do not delete, merge, push, publish, install or enable a startup service.

## Spend and acceptance

One short read-only model turn is the proposed paid action. The adapter has **no hard provider spend ceiling** and Codex app-server usage may report tokens without USD cost. The best-effort exposure is bounded by one job, one small prompt, 60 seconds and no retries or model fallback. Record any runtime-reported usage and mark USD cost unknown if unavailable. A failed handshake before `turn/start` does not authorize an automatic rerun.

Task 13 completes only if this approved check returns a completed read-only turn with exact model/provider/session identity matching the saved job, the fixture remains unchanged, and the full Node 24/26 typecheck/build/offline suites pass afterward. Otherwise record the observed blocker and keep Task 13 open. Live Codex cancellation, follow-up, coding and Task 14 cross-runtime tests require separate decisions.
