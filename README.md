# Gattini

Gattini is a local-first tool in early development for coordinating AI coding agents through durable jobs, runtime adapters, and verifiable results. The initial target is a macOS CLI and daemon; OpenCode is the first worker runtime to investigate.

**Project status: Tasks 1–13 complete; Checkpoint 4 accepted.** Task 10's blocking CLI and caller guides passed offline verification, and an authorized disposable Codex/Claude caller check inspected one exact OpenCode code job with passed snapshot evidence. Task 11 added offline-verified exact-session reviewer follow-up, historical attempt results, and independent review against retained code evidence. Task 12 added bounded read/write admission, timeouts, narrow prelaunch retry, usage provenance, and cleanup preview. Task 13 added a single-turn read-only Codex worker path and one approved live observation with matching returned model/session identity; cancellation, follow-up, coding and cross-runtime conformance remain unverified. This repository has a strict TypeScript package, a local CLI and daemon, approved live OpenCode read-only review and cancellation evidence, and the guarded proposal/apply path. The default CLI `code` role still runs the fake adapter; trusted coding requires explicit opt-in and two approvals. The legacy direct-edit coding gate remains disabled.

## Project documents

- [Master plan](docs/roadmaps/GATTINI_MASTER_PLAN.md) — product goals, architecture, safety boundaries, and decisions to validate.
- [Implementation roadmap](docs/roadmaps/GATTINI_ROADMAP.md) — sequenced tasks, acceptance criteria, and review checkpoints.

The roadmap is the authoritative task list. Runtime discovery and Task 3's bounded live OpenCode probes are recorded in [the compatibility inventory](docs/compatibility.md). Do not assume proposed Gattini commands or integrations already exist.

## Development

Use Node 24 or newer. The installed Node 24 and 26 versions have both been checked.

```sh
npm ci
npm run build
npm run typecheck
npm test
```

`npm test` runs offline fake-runtime, daemon, CLI, role mapping, and OpenCode adapter tests. It does not contact a model provider or exercise a live OpenCode service. The contracts are in [`src/core/contracts.ts`](src/core/contracts.ts), with the fake adapter in [`src/adapters/fake.ts`](src/adapters/fake.ts).

To try the durable fake slice, build the project, then run the daemon in one terminal and the CLI in another:

```sh
node dist/src/daemon/gattinid.js
node dist/src/cli/gattini.js start --task-file task.txt --idempotency-key example-1 --json
node dist/src/cli/gattini.js status JOB_ID --json
node dist/src/cli/gattini.js result JOB_ID --json
```

`gattini run --task-file task.txt --idempotency-key KEY --json` submits a durable job and waits for its final result. It exits 4 if an approval is needed and leaves the job pending. See the [frozen CLI contract](docs/cli-contract.md) and [Codex/Claude caller workflow](docs/callers/workflow.md) for JSON, exit codes, reconnection, and evidence inspection.

`gattini followup JOB_ID --task-file task.txt --idempotency-key KEY --json` continues a completed OpenCode reviewer job on its exact saved session. `gattini result JOB_ID --attempt-id ID --json` retrieves a prior completed turn. `gattini review CODE_JOB_ID --idempotency-key KEY --json` submits a separate read-only review from retained, passed code evidence. `gattini cleanup preview [JOB_ID] --json` reports recorded owned worktrees and retention reasons without deleting anything. These Task 11–12 paths have offline fixture evidence; the installed OpenCode V2.0.18 follow-up/review path has not had a paid live check. See the [Task 11 interface](docs/roadmaps/TASK11_INTERFACE.md), [Task 12 interface](docs/roadmaps/TASK12_INTERFACE.md), and roadmap for limits.

`task.txt` is a UTF-8 task description. The fake job completes without a provider and reports acceptance as `unverified`. Local state defaults to `~/Library/Application Support/Gattini`; set `GATTINI_STATE_DIR` to an absolute private directory to isolate a disposable run. The daemon is started manually and does not register a login service. See [ADR 004](docs/decisions/004-durable-fake-slice.md) for persistence and restart behavior.

The `reviewer` role uses a private `roles.json` in the state directory. Its `roles.reviewer` entry selects either OpenCode (named agent, exact model, working directory, loopback service and deny-all/read-only rules) or Codex (exact model/provider, directory and executable). The same `--role reviewer` request works with either mapping; `codex-reviewer` remains a compatibility alias with separate `codex-role.json`. The OpenCode reviewer adapter still pins its tested 2.0.16 CLI and currently refuses the installed 2.0.18 CLI until that pairing is validated. The daemon does not start or stop the shared OpenCode service. See [ADR 005](docs/decisions/005-durable-opencode-review.md), the [compatibility report](docs/compatibility.md), and the [Task 14 interface](docs/roadmaps/TASK14_INTERFACE.md) for limits.

`gattini cancel JOB_ID --json` requests cancellation of a reviewer job. A queued job with no runtime attempt is cancelled immediately. A running job is marked `cancelled` only when its exact OpenCode session is inactive and reports interruption; otherwise it remains `interrupted` and blocks another review in the same directory until reconciliation. See [ADR 006](docs/decisions/006-cancellation-and-recovery.md).

The internal [worktree manager](src/environments/worktree.ts) prepares a job-owned branch and worktree from an explicit full commit SHA and records ownership before creation. It preserves dirty and untracked files in the source checkout and blocks competing writers for the same repository. It is not yet exposed through `gattini start`; no coding worker or host containment is implied. See [ADR 007](docs/decisions/007-owned-coding-worktrees.md).

For a separately gated reviewer launch, use `gattini start --role reviewer --task-file task.txt --idempotency-key KEY --require-approval --json`. The returned approval ID stays pending for 15 minutes. Inspect it with `gattini approvals list --json`, then use `gattini approve APPROVAL_ID --json` or `gattini deny APPROVAL_ID --json`. A pending job makes no runtime call and remains blocked across daemon restart. This gate applies to the exact reviewer launch, not individual OpenCode tool calls. The reviewer policy allows broad read tools but denies other runtime tools; it is not host containment. See [ADR 008](docs/decisions/008-policy-and-approval-gate.md).

Task 9's opt-in daemon path prepares an owned worktree from a full base commit, requests approval for an exact read-only OpenCode V2.0.18 proposal launch, validates the returned single-file patch, then requests a second approval for that exact patch before applying it. It retains the tested snapshot bytes and diff with digests in private state and runs the approved direct-argv checks. **The direct-edit adapter remains disabled:** an approved V2.0.18 probe showed its `edit` tool followed an in-tree symlink and wrote outside the worktree. The durable path has offline fake OpenCode tests; the separately approved real proposal/apply result was run before this daemon integration and has not been repeated. Checkpoint 3 was accepted with those limits. See [ADR 009](docs/decisions/009-guarded-coding-and-snapshot-evidence.md).

The opt-in request is `gattini start --role code --task-file task.txt --idempotency-key KEY --repo REPO --base-sha FULL_SHA --checks-file checks.json --trusted-local-code --require-approval --json`. Private `code-role.json` selects either `runtime: "opencode"` with exact `agent`, `model`, and loopback `serverUrl`, or `runtime: "codex"` with exact `model`, `modelProvider`, and `executable`. The OpenCode agent must have deny-all followed only by read/glob/grep permissions. Codex uses a read-only app-server turn. `checks.json` is an array of direct-argv commands with `argv` and `timeoutMs`. Inspect `gattini approvals list --json` and approve the proposal launch, then inspect the later `code-apply` approval before approving the patch. Each approval expires after 15 minutes. No provider call is made until the first approval; a new paid run needs fresh owner authorization. Task 14 cross-runtime evidence is still offline only.

The narrow proposal validator in [`src/verification/validated-patch.ts`](src/verification/validated-patch.ts) accepts strict JSON containing one root-level tracked regular filename, its SHA-256 preimage, and base64 replacement bytes. The daemon and independent `node dist/src/cli/gattini-apply-patch.js PRIVATE_STATE_DIR OWNED_JOB_ID PROPOSAL_JSON_FILE CHECKS_JSON_FILE` command recheck path and preimage immediately before one atomic replacement. Nested paths, new files, links, mode changes, and multiple-file patches are refused. The standalone command remains an offline tool and creates no approval.

The offline adversarial pass covers Git filter execution, forged/mutated patch handles, file-mode drift, verification descendants, restart, and cancellation. Checks terminate ordinary POSIX process groups and fail on lingering background work; processes that create a new session can escape. Retained artifact digests are rechecked when results are retrieved. Node 24 testing and remaining limits are recorded in the roadmap.

See [CONTRIBUTING.md](CONTRIBUTING.md) for how to propose and record changes.

## License

This project is licensed under the MIT License. See [LICENSE](LICENSE).
