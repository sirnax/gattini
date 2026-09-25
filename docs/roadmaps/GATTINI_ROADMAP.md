# Gattini — implementation roadmap

Status: Tasks 1–6 complete; Checkpoint 2 approved on 25 September 2026. Checkpoint 1 was approved on 24 September 2026. Companion specification: `GATTINI_MASTER_PLAN.md`. Build on Nate's Mac using Codex or Claude Code. These Gattini files are the authoritative plan/task targets; do not maintain duplicate checklists in `tasks/plan.md` or `tasks/todo.md`.

## How to execute

Read the master plan, then execute tasks in dependency order. Mark a task complete only after recording test commands, outcomes and evidence. Suggested paths below are proposals until Task 2 establishes the repository. Each task should fit a focused session and approximately 2–5 files; split larger tasks before implementing. Checkpoints require human review. Future expansion milestones require a fresh detailed plan before coding.

Use three release gates: A = useful OpenCode delegation; B = verified runtime neutrality; C = installable/editor-friendly. Browser/desktop/remote expansion follows separately.

## Phase 0 — remove integration uncertainty

### [x] Task 1 — inspect the Mac and runtime interfaces

- Deliver: sanitised inventory of macOS/architecture/RAM, Git, package manager, Node, OpenCode, Codex, Claude, existing agents and relevant versions; list missing prerequisites without installing them.
- Acceptance: exact existing agent names and model IDs are recorded where discoverable; unsupported/unavailable candidates are explicit; read-only version/help/config inspection does not expose secrets or alter settings.
- Verification: compare inventory with installed `--help` and official version-matched documentation. Record candidate start/status/session/cancel/permission interfaces, not guessed flags.
- Dependencies: none. Scope: small. Files: `docs/compatibility.md`, `docs/decisions/001-runtime-boundary.md`.

### [x] Task 2 — bootstrap the Gattini repository and fake-runtime harness

- Deliver: strict TypeScript project targeting Node 24+, scripts for build/typecheck/tests, a fake runtime and single-source agent instructions. Check compatibility on the installed Node 24 and 26 versions.
- Acceptance: a mock task produces valid schema-checked events/results with no provider access; configuration rejects unknown fields and secret literals where credential references are expected.
- Verification: build, typecheck and focused offline tests, including invalid input and paths containing spaces.
- Dependencies: 1. Scope: medium; split scaffolding if it exceeds five files. Files: project manifest/config, `src/core/contracts.ts`, `tests/fake-runtime.test.ts`, agent instruction pointers.

### [x] Task 3 — prove one real OpenCode agent job

- Deliver: a small adapter spike using an explicitly named agent and available model in a disposable repository. The owner approved creating temporary probe agents after discovery found no registered custom agent.
- Acceptance: prove session identity, streamed output, enforced read-only permissions and cancellation semantics; choose CLI/service/API transport based on evidence. If a safeguard cannot be enforced, report that limitation and block corresponding jobs.
- Verification: with approved live spend, run a harmless review, a permission-denial probe and a cancellable long-running job; confirm runtime termination rather than only client termination. Capture sanitised fixtures.
- Dependencies: 1–2. Scope: medium. Files: `src/adapters/opencode.ts`, adapter tests/fixtures, compatibility report and ADR.

### Checkpoint 1 — integration feasibility

- [x] Offline checks pass; real runtime evidence covers identity, permissions and cancellation.
- [x] Select transport and supported version range; unresolved blockers prevent claims of support. ADR 003 selects CLI NDJSON launch plus exact-session V2 API operations for the spike, limited to tested OpenCode 2.0.16. Direct HTTP launch remains unproven.
- [x] Human approves proceeding to durable execution (24 September 2026).

## Phase 1 — durable read-only delegation

### [x] Task 4 — run and retrieve a durable fake job

- Deliver: CLI `start/status/result`, daemon socket and minimal SQLite job/event persistence as one vertical slice.
- Acceptance: submission returns a stable ID; a disconnected client retrieves the result; duplicate idempotency keys do not duplicate dispatch. Socket/state permissions are user-only and protocol mismatches fail clearly.
- Verification: integration test two clients, duplicate submit, daemon restart and invalid protocol requests; test database migrations on empty and existing fixtures.
- Dependencies: 2–3. Scope: medium; split persistence/protocol migration if needed. Files: CLI, daemon, store, protocol and integration test.

### [x] Task 5 — run durable OpenCode review jobs

- Deliver: plug the proven adapter into the job service with role mapping and exact session handles.
- Acceptance: a real read-only job survives caller disconnect; requested and resolved agent/model/version are retained; unavailable models fail before dispatch without silent fallback.
- Verification: offline adapter contract tests plus one approved live review; verify no unexpected repository changes and inspect actual permission configuration.
- Dependencies: 4. Scope: medium. Files: adapter, scheduler, role configuration schema and integration tests.

### [x] Task 6 — cancellation and crash reconciliation

- Deliver: cancellation state, attempt leases and restart reconciliation.
- Acceptance: confirmed cancellation stops execution; unknown runtime status remains uncertain/interrupted and blocks conflicting dispatch; shared runtime services are not killed. A crash after dispatch never triggers blind replay.
- Verification: kill the client, then daemon, during simulated launch/run/cancel windows; inject lost responses, reused PIDs and stale handles; test an approved real cancellation.
- Dependencies: 5. Scope: medium. Files: lifecycle/recovery modules, adapter cancellation and fault tests.

### Checkpoint 2 — durable execution

- [x] No duplicate launches in fault tests; cancellation and uncertain state are represented honestly.
- [x] Real job result is recoverable after caller disconnect.
- [x] Human reviewed lifecycle evidence and local service permissions and explicitly approved proceeding to Task 7 (25 September 2026). No new paid live tests were approved.

## Phase 2 — safe coding and verified results

### [ ] Task 7 — prepare owned coding worktrees

- Deliver: explicit repository/base-SHA resolution and per-job branch/worktree ownership records.
- Acceptance: dirty user checkout remains unchanged; base snapshot is reproducible; invalid paths/symlink escapes are rejected. Worktree isolation is never reported as a sandbox.
- Verification: disposable Git fixture with dirty files, untracked files, spaces, symlinks, failed worktree creation and two competing writers.
- Dependencies: 6. Scope: medium. Files: worktree environment, ownership records, path validation and tests.

### [ ] Task 8 — enforce policy and approval blocking

- Deliver: runtime policy translation plus pending approval records and approve/deny CLI commands.
- Acceptance: unsupported enforcement fails closed; approvals bind to exact actions and expire; noninteractive workers block or fail on approval instead of bypassing it. Repository instructions cannot raise authority.
- Verification: denied shell/network/edit probes appropriate to the selected runtime, altered-action approval replay, symlink tests and malicious prompt fixtures. Document residual same-user/host risks.
- Dependencies: 7. Scope: medium. Files: policy, approvals, adapter mapping and security tests.

### [ ] Task 9 — verify an exact output snapshot

- Deliver: bounded verification runner and structured evidence/result collection.
- Acceptance: execution outcome and acceptance outcome remain separate; approved commands record cwd, exit code and bounded logs; diff, tests and review refer to the same frozen snapshot. Failed checks cannot become accepted solely through model claims.
- Verification: pass/fail/timeout fixtures, output truncation, changed-after-test snapshot and false worker-success report; one approved real code task with tests.
- Dependencies: 7–8. Scope: medium. Files: verification runner, result schema, snapshot collection and tests.

### Checkpoint 3 — first verified code change

- [ ] User checkout preserved; evidence shows precisely what changed and which checks ran.
- [ ] Policy-denial tests pass; unresolved containment limits are visible.
- [ ] Human inspects the worktree/diff. No merge or push is performed automatically.

## Phase 3 — daily-use workflow, release gate A

### [ ] Task 10 — caller integration for Codex and Claude

- Deliver: concise task-file templates and caller instructions, plus blocking `run` and stable JSON/exit-code behaviour.
- Acceptance: both callers can submit and inspect an OpenCode job using the CLI; they use exact IDs and inspect acceptance/evidence before claiming success. Document caller sandbox limitations without bypassing them.
- Verification: scripted machine-output tests and a manual smoke test from each available caller; mark unavailable callers untested rather than passed.
- Dependencies: 9. Scope: medium. Files: caller guide/templates, CLI output handling and tests.

### [ ] Task 11 — follow-up and independent review

- Deliver: exact-session follow-up and read-only reviewer role against a pinned result snapshot.
- Acceptance: unsupported follow-up returns a typed error; previous attempt evidence remains immutable; reviewer cannot modify the coding worktree or approve its own external actions.
- Verification: concurrent-session routing test, wrong-ID rejection, immutable evidence test and review write-denial test.
- Dependencies: 10. Scope: medium. Files: follow-up/review service, adapter hooks and tests.

### [ ] Task 12 — limits, escalation and retention

- Deliver: bounded concurrency, timeouts, retry policy, usage provenance and dry-run cleanup.
- Acceptance: default worker limits apply; unknown costs remain unknown; repeated failure escalates without recursive delegation. Cleanup only targets recorded owned resources and protects unmerged changes.
- Verification: queue saturation, timeout, exhausted retry budget, missing usage, blocked approval and cleanup ownership fixtures; inspect dry-run output before any real cleanup.
- Dependencies: 11. Scope: medium. Files: scheduler limits, usage, retention and tests.

### Checkpoint 4 — release gate A

- [ ] Codex/Claude caller → Gattini → existing OpenCode agent → verified code result is demonstrated for each available caller.
- [ ] Follow-up, independent review, cancellation, restart and bounded concurrency pass.
- [ ] Human approves using Gattini for ordinary trusted coding tasks within documented containment limits.

## Phase 4 — prove runtime neutrality, release gate B

### [ ] Task 13 — discover and implement Codex worker transport

- Deliver: version-matched worker adapter using the officially supported interface available on the Mac.
- Acceptance: uses normal configured authentication; maps capabilities honestly; unsupported permission/cancel/continuation requirements are rejected.
- Verification: shared adapter contract suite and approved live read-only task; compare actual runtime model and session identity with saved records.
- Dependencies: 12. Scope: medium. Files: Codex adapter, tests, fixtures and compatibility report. Split discovery from implementation if the interface is unfamiliar.

### [ ] Task 14 — cross-runtime conformance

- Deliver: identical bounded task specifications executed through OpenCode and Codex without caller-specific changes.
- Acceptance: lifecycle/result/error schemas match; cancellation/recovery and policy differences are explicit; no core scheduler branch depends on a particular provider name.
- Verification: offline conformance matrix plus approved live code/review/cancel tests; record versions, costs and unsupported features.
- Dependencies: 13. Scope: medium. Files: shared contract suite, adapter fixes and compatibility matrix.

### Checkpoint 5 — release gate B

- [ ] Two real worker runtimes satisfy the declared common contract.
- [ ] Runtime-specific capabilities stay discoverable; portability claims match observed coverage.
- [ ] Human decides whether a Claude worker adapter is needed now. If so, repeat Tasks 13–14 for it before claiming support.

## Phase 5 — macOS distribution and editors, release gate C

### [ ] Task 15 — reproducible local release packaging

- Deliver: versioned package, checksums and clean-account installation procedure, including daemon lifecycle.
- Acceptance: install/build works on the actual target architecture; versions and dependencies are pinned appropriately; uninstall preserves user state. Startup service registration is opt-in.
- Verification: local install/upgrade/uninstall and client/daemon version mismatch tests; database migration backup/restore rehearsal.
- Dependencies: 14. Scope: medium. Files: packaging script/config, lifecycle tests and installation documentation.

### [ ] Task 16 — Homebrew tap for `gattini`

- Deliver: formula and release workflow after owner/name/publication approval.
- Acceptance: formula installs the exact intended release with checksums; dependencies and platform support are accurate; no implicit provider installation/login or destructive data cleanup.
- Verification: Homebrew formula tests, audit and clean macOS install/upgrade/uninstall. Validate publishing credentials through normal configured tooling; publication is a separate approval.
- Dependencies: 15. Scope: small. Files: tap formula, release workflow and tap README.

### Checkpoint 6 — distributable CLI

- [ ] Reproducible installation works; upgrade preserves jobs/configuration.
- [ ] Published names and supported platforms are real and documented, or publication remains explicitly pending.
- [ ] Human approves extension work on the stable protocol.

### [ ] Task 17 — VS Code submit/status client

- Deliver: thin extension to submit a task and display durable job status/events.
- Acceptance: extension contains no scheduler or runtime logic; reconnect resumes by event cursor; Workspace Trust prevents execution in untrusted workspaces.
- Verification: extension-host tests, daemon disconnect/reconnect, multiple workspace folders and paths with spaces.
- Dependencies: 15–16. Scope: medium. Files: extension manifest/client/views and tests.

### [ ] Task 18 — VS Code results and approval actions

- Deliver: diff/evidence viewing, approval/denial and cancellation UI.
- Acceptance: actions target exact job/approval IDs; untrusted output renders safely; secrets are not exposed through diagnostic export. Other editors are documented as CLI-compatible or individually tested, never assumed native-compatible.
- Verification: malicious output rendering, stale approval, cancellation and a full manual task in VS Code; test one desired derivative editor if available.
- Dependencies: 17. Scope: medium. Files: extension action/result components and tests, editor compatibility documentation.

### Checkpoint 7 — release gate C

- [ ] CLI and editor operate on the same durable jobs; both show evidence and approval state correctly.
- [ ] Install and recovery guides are usable from a fresh Mac account.
- [ ] Human approves the release and chooses the next capability milestone.

## Later milestones — plan separately before implementation

| Milestone | Prerequisite | Deliverable and acceptance gate |
| --- | --- | --- |
| Claude worker adapter | Gate B | Repeat version discovery, capability mapping and real conformance tests |
| Local model experiment | Gate A | Verify exact model licence/format/runtime; measure memory, tokens/sec, tool-use and task success on the Mac; opt-in only |
| Browser work | Policy/approvals mature | Dedicated browser profile, navigation rules, action approvals and evidence; prove no unauthorised submission/account change |
| Desktop work | Browser safety review | Explicit macOS permissions, exclusive input lock, emergency stop and action-bound approvals; prove interruption stops further actions |
| Unattended orchestration | Reliable evidence and limits | One orchestrator, approved task DAG, bounded fan-out/budgets, durable escalation; no recursive managers |
| Remote/VPS workers | Stable protocol and threat model | Authenticated transport, host-specific policy, reconnect/cancel tests and scoped credentials |
| TeaCake/Brewbug clients | Stable API | Thin client integrations using the same job/approval protocol; no duplicated authority logic |

## Risk register

| Risk | Response / stop condition |
| --- | --- |
| Runtime APIs differ from documentation | Pin tested versions; stop adapter rollout until live conformance passes |
| Cancellation kills only the client | Track runtime sessions; retain uncertain status and resource locks until reconciled |
| Worktree mistaken for sandbox | Disclose containment; require enforceable isolation for untrusted tasks |
| Unsupported desired models | Report unavailable; request an explicit configured alternative |
| Cost estimates incomplete | Show provenance/unknowns; bound time and retries; disclose possible overspend |
| Daemon crash causes duplicate external action | Persist identity before dispatch; reconcile, never blindly replay |
| Too much infrastructure before value | Keep first three checkpoints focused on one end-to-end OpenCode workflow |
| Desktop/remote scope expands prematurely | Require separate plan and human capability approval |

## Evidence log template

Append one entry per task: task ID; date; commit if available; files changed; exact offline checks and results; live checks and approved spend; tested runtime/model versions; limitations; next task. Keep all unchecked tasks honest. Failed or unavailable checks remain unresolved.

### Task 1 evidence — 2026-09-24

- Commit: none; repository bootstrap files are still untracked.
- Files: `docs/compatibility.md`, `docs/decisions/001-runtime-boundary.md`, this roadmap, and the Node 24+ target in the master plan.
- Offline checks: `uname -s -m -r`, `sw_vers`, `system_profiler SPHardwareDataType`, Node OS memory query, `git --version`, `brew --version`, `brew config`, `brew list --versions`, package/runtime version commands, `xcode-select -p`, and runtime `--help` commands. Results and sanitised identifiers are in `docs/compatibility.md`. Installed OpenCode 2.0.16 help matched the official V2 CLI command families. `sysctl` memory lookup was sandbox-denied, so memory was confirmed by two other local tools. OpenCode agent enumeration stalled in an isolated temporary data directory and was interrupted.
- Live checks/spend: none; no provider call. Tested interfaces: OpenCode 2.0.16, Codex CLI 0.156.1, Claude Code 2.1.281. Configured OpenCode model keys were recorded but availability and exact agent names remain unverified.
- Limitation: help and documentation identify candidates only; session identity, read-only enforcement, and cancellation require Task 3's controlled live evidence. The V2 HTTP API is partly experimental.
- Next: Task 2, a minimal Node 24+ strict TypeScript package and offline fake-runtime contract slice.

### Task 2 evidence — 2026-09-24

- Commit: none; initial repository files remain untracked.
- Files: `package.json`, `package-lock.json`, `tsconfig.json`, `src/core/contracts.ts`, `src/adapters/fake.ts`, `tests/fake-runtime.test.ts`, `CLAUDE.md`, `docs/decisions/002-bootstrap-stack.md`, and README/contributing/agent-instruction updates.
- Dependencies: project-local pinned TypeScript 5.9.3 and Node types 24.13.3 installed with `npm install --ignore-scripts --no-audit --no-fund --fetch-retries=0 --fetch-timeout=10000`; no global package change. An offline npm install first failed because cached package metadata was incomplete.
- Offline checks: `npm run build`, `npm run typecheck`, and `npm test` passed on active Node 26.9.0. `env PATH=/opt/homebrew/opt/node@24/bin:$PATH npm run typecheck` and `env PATH=/opt/homebrew/opt/node@24/bin:$PATH npm test` passed on Node 24.21.0. Five focused tests passed on each version, covering schema-checked fake events/result, event bounds, invalid job fields, configuration unknown fields and credential literals, malformed output, and a path containing spaces.
- Live checks/spend: none. The fake adapter has no provider/process/network/filesystem access; acceptance remains `unverified` by design.
- Limitation: runtime permissions, session identity and cancellation remain unproven. Contracts are a prototype and will evolve before durable production use.
- Next: Task 3, a controlled OpenCode adapter spike in a disposable repository, with explicit agent/model discovery and bounded live probes after spend approval.

### Task 3 evidence — 2026-09-24

- Commit: none; repository bootstrap files remain untracked. Files: `src/adapters/opencode.ts`, `tests/opencode-adapter.test.ts`, sanitised `tests/fixtures/opencode-live-*.ndjson`, `docs/compatibility.md`, `docs/decisions/003-opencode-v2-transport.md`, and this roadmap.
- Offline checks: `npm run typecheck` passed; `npm test` passed 14 tests on Node 26.9.0 and Node 24.21.0. The adapter checks exact agent/model/session identity, uses a loopback service, requires explicit permission rules, and treats the interrupt response as an acknowledgement rather than proof of termination.
- Live preflight: installed OpenCode V2.0.16 accepted empty session creation and prompt admission in a disposable Git repository. A private loopback service was stopped after each probe. The project agent list initially appeared empty while configuration loaded, then included the temporary agent. A free OpenCode model and a zero-price OpenRouter model both failed before producing review output; exact provider errors and limitations are in `docs/compatibility.md`.
- Approved live checks: the owner authorised a temporary probe agent, up to three four-step paid probes using `openrouter/z-ai/glm-5.3-flash`, and attachment to the existing user-owned OpenCode service without stopping it. Three probes were run. Read-only review produced a stable exact session ID, completed `read` event and streamed final text. An explicit edit request exposed only read tools and left the tracked sentinel unchanged. An active `sleep 37` job was interrupted by exact session ID; the runtime recorded interruption, removed it from active sessions, and its shell process was gone. OpenCode reported USD 0.00069645 + 0.00090435 + 0.00055885 = **USD 0.00215965**. Full IDs, commands, event details and limitations are in `docs/compatibility.md`.
- Transport decision: [ADR 003](../decisions/003-opencode-v2-transport.md) selects CLI NDJSON launch and exact-session V2 API operations for OpenCode 2.0.16. The typed loopback HTTP adapter has offline coverage but no successful live authenticated launch. The tested read-only policy is a runtime tool policy, not host containment. Cancellation was observed for one shell command, not every possible tool. Keep unsupported safeguards explicit.
- Next: Checkpoint 1 human review before Task 4 durable execution, as required by the master plan's build-agent agreement.

### Task 4 evidence — 2026-09-24

- Approval: owner approved Checkpoint 1 and Task 4. Commit: none; bootstrap files remain untracked. Files: `src/core/protocol.ts`, `src/daemon/store.ts`, `src/daemon/server.ts`, `src/daemon/gattinid.ts`, `src/cli/gattini.ts`, `tests/durable-fake.test.ts`, `docs/decisions/004-durable-fake-slice.md`, package manifest/lock, README, and this roadmap.
- Design: versioned, 1 MiB bounded JSON over a Unix socket; SQLite schema version 1 with unique idempotency key, ordered event rows, stored job/config/result, and no automatic replay of unfinished jobs. Default state lives under the user's macOS Application Support directory; a private absolute override supports isolated runs. Built-in `node:sqlite` works on installed Node 24.21.0 and 26.9.0 but is still an experimental Node API. See [ADR 004](../decisions/004-durable-fake-slice.md).
- Offline verification: `npm run typecheck && npm test` passed 21/21 tests on Node 26.9.0; the same commands with `PATH=/opt/homebrew/opt/node@24/bin:$PATH` passed 21/21 on Node 24.21.0. Seven new integration tests cover two socket clients, one persisted job/event set after duplicate submission, conflicting key reuse, CLI submission and retrieval, daemon restart, protocol mismatch and malformed JSON, empty/existing/future schema versions, and user-only file permissions.
- Manual disposable run: `node dist/src/daemon/gattinid.js` with `GATTINI_STATE_DIR=/private/tmp/gattini-task4.6Bp8S6`; `gattini start --task-file ... --idempotency-key task4-smoke --json` returned job `16fc4e18-576e-4e0f-aa01-bf5c1c2a23ea` completed. A separate client retrieved status/result, a repeated submit returned the same ID with `deduplicated: true`, and the result remained available after daemon shutdown/restart. `stat` showed directory 0700, database 0600, socket 0600. The disposable daemon was stopped cleanly. No provider call or live cost.
- Limitations: only the deterministic fake adapter runs. Acceptance is always `unverified`; no OpenCode job is durable yet. Synchronous SQLite is suitable for this small slice, not a concurrency or host isolation guarantee. Interrupted work is retained for reconciliation and never blindly relaunched. Next: Task 5, connect the proven OpenCode runtime path to durable read-only jobs with explicit role mapping and exact session handles.

### Task 5 evidence — 2026-09-24

- Commit: none; bootstrap files remain untracked. Files: `src/core/role-config.ts`, `src/adapters/opencode-cli.ts`, SQLite/store and daemon updates, `tests/role-config.test.ts`, `tests/durable-opencode.test.ts`, [ADR 005](../decisions/005-durable-opencode-review.md), compatibility report, and this roadmap.
- Offline checks: `npm run typecheck && npm test` passed 29/29 tests on Node 26.9.0 and Node 24.21.0. A fake OpenCode executable verified daemon-owned reviewer execution after client disconnect, exact session and resolved identity retention, duplicate-key deduplication, and rejection of missing models or changed permissions before runtime launch. SQLite schema version 1 migrates to 2 and retains older fake jobs.
- Read-only live preflight: installed `opencode v2.0.16`, the already-running service address, authenticated `session.active`, the temporary agent's effective deny-all/read-only rules, and `openrouter/z-ai/glm-5.3-flash` catalogue entry all matched. Direct `--server` access returned HTTP 401 at the Basic Auth health check, so the integration uses the authenticated automatic CLI connection observed in Task 3. No new model run or provider cost was incurred.
- Approved live check: the owner separately approved one paid review. The first Gattini submission failed before model execution (USD 0, zero tokens) because the spawned CLI inherited the daemon's `PWD`; it created an exact session in the wrong directory. The runner now sets both `cwd` and `PWD` and validates the resolved session directory. A corrected submission returned queued job `93b34c54-669e-4e2d-9c4f-6d890630f1ac`, then a separate client observed and retrieved the completed result from exact session `ses_f2bd47b28ffeqrcHn9cxtlCXsS`. The requested and resolved agent/model/version were retained, OpenCode's outcome was `succeeded`, and five projected events were persisted. After a clean daemon restart, the result remained retrievable. The tracked sentinel hash was unchanged. OpenCode reported USD **0.00079485** for the successful run; details are in `docs/compatibility.md`.
- Limitations: acceptance remains `unverified` because Task 9's independent snapshot verification does not exist yet. The failed pre-execution session remains `interrupted` with its handle for Task 6 reconciliation. CLI process loss after a session starts is uncertain, not proof of runtime termination. The user-owned OpenCode service was not stopped. Next: Task 6 cancellation, attempt leases, and crash reconciliation.

### Task 6 evidence — 2026-09-24

- Commit: none; bootstrap files remain untracked. Files: `src/core/protocol.ts`, `src/cli/gattini.ts`, `src/adapters/opencode-cli.ts`, `src/daemon/store.ts`, `src/daemon/server.ts`, `tests/lifecycle.test.ts`, `tests/process-kill.test.ts`, migration assertions in `tests/durable-fake.test.ts`, and [ADR 006](../decisions/006-cancellation-and-recovery.md).
- Offline checks: `npm run typecheck && npm test` passed 41/41 on Node 26.9.0 and Node 24.21.0. Fault fixtures cover exact-session interrupt acknowledgement followed by inactive/interrupted confirmation, acknowledgement while still active remaining uncertain, scope blocking (including a symlink alias), queued cancellation, restart with queued/no attempt versus launching/no handle, attached handle retention, stale attempt rejection, a cancel-versus-success race, and a terminal runtime success whose Gattini output was lost. `tests/process-kill.test.ts` terminates the submitting client during a fake run and kills the daemon in launch-before-handle, running, and cancelling windows. Restart preserves an exact known handle, never blindly relaunches, and reconciles a confirmed interruption without stopping the shared-service fixture. PID reuse is addressed by never using PID identity; no PID is treated as a job handle.
- Read-only live reconciliation: a copy of the Task 5 SQLite database migrated from schema 2 to 3 with its stored events and completed result intact. On startup, exact-session inspection reconciled the zero-cost failed Task 5 session from `interrupted` to `failed` without provider work. The original evidence database was not modified.
- Approved live check: the owner authorised up to two paid attempts. The first submission (`265a323a-e197-4207-94ac-24157bba4068`) failed before attempt claim/model execution; the transient preflight cause was not captured. The second (`7b7af040-71c4-4938-9fd6-c9056385e291`) reached exact OpenCode session `ses_f2b60f2c3ffeglSnKZwfZzVHlQ`; Gattini cancelled that session. OpenCode 2.0.16 reported `interrupted`, the exact ID was absent from active sessions, and Gattini persisted `cancelled` across a clean daemon restart. The disposable `README.md` hash remained `5746640d8ef710122ff5e3181d5b992f29afb648`, its diff was empty, and the shared OpenCode service stayed running. OpenCode reported USD **0.00080625** for the interrupted model run. The private directory/database/socket were 0700/0600/0600. See [the compatibility record](../compatibility.md) for exact agent/model and limits.
- Limitation: preflight failures currently leave only a generic failed result; the first attempt's exact error was not persisted. The launch-to-first-handle crash window blocks the scope for manual reconciliation. Real cancellation was exercised on one read-only session, not every OpenCode tool operation. Next: Checkpoint 2 human review before Task 7.

## Starting prompt for Codex or Claude Code

> Read `docs/roadmaps/GATTINI_MASTER_PLAN.md` and `docs/roadmaps/GATTINI_ROADMAP.md` completely. Build Gattini on this Mac incrementally, beginning with Task 1. Use `gattini` for the CLI and `gattinid` for the daemon. Treat these files as the authoritative design and task list. Inspect the existing repository and runtime versions first, preserve my current OpenCode agents and authentication, and report prerequisite gaps before installing anything. Use no MCP layer. Validate exact model IDs and runtime interfaces instead of guessing. Implement the next task, test it, and record evidence in `docs/roadmaps/GATTINI_ROADMAP.md`. Review progress at each checkpoint. Ask before publication, startup-service registration, or new OS permissions. Start by giving me the discovery findings and the smallest next implementation step.
