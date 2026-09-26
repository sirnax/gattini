# Tasks 14–17 preparation

Status: preparation only, 26 September 2026. This document proposes offline checks and dependency gates; it is not implementation or acceptance evidence. It does not authorize provider calls, software installation, service registration, external tap creation, or publication. The roadmap remains authoritative.

## Dependency sequence

```text
Task 13 + Gate A / Checkpoint 4
        ↓
Task 14 offline matrix → approved live conformance → Checkpoint 5 / Gate B
        ↓
Task 15 package and lifecycle checks → Checkpoint 6 approval
        ├── Task 16 local formula validation (publication separately approved)
        └── Task 17 VS Code submit/status client → Task 18 results/actions
                                      ↓
                             Checkpoint 7 / Gate C
```

Task 14's fixtures and matrix can be prepared while Task 13 owns the Codex adapter, but integration waits for its contract. Task 15 follows Gate B. Task 16 and Task 17 can proceed independently after Task 15; Task 17 also requires explicit Checkpoint 6 approval. Task 16 publication is separate from local formula validation. Gate C requires integrated CLI/editor evidence and an explicit publication-or-deferral decision for Task 16.

## Task 14 — cross-runtime conformance matrix

Use identical bounded job specifications and common contract assertions for OpenCode and Codex. Drive the offline suite with deterministic adapter fakes and recorded/sanitised event fixtures; fake success establishes contract behavior only, not support by either real runtime. Assert the core scheduler selects by declared capabilities and policy, without branching on provider names.

| Contract area | Offline assertion for each adapter fixture | Live evidence still required |
| --- | --- | --- |
| Discovery and identity | Runtime/version, resolved agent/model, session handle, and supported/unsupported capabilities are explicit; missing required capabilities reject before launch. | Installed versions and exact resolved runtime/session identity are recorded. |
| Start and lifecycle | Same bounded input yields schema-valid events and result, monotonic event sequence/cursor, typed errors, and valid terminal state transitions. | Approved code and read-only review jobs complete through both runtimes. |
| Idempotency and recovery | Duplicate submission does not create a second attempt; disconnect/restart reconciles the saved exact session and never blindly relaunches uncertain work. | Restart and reconnect behavior observed for both actual runtime handles. |
| Follow-up and evidence | Follow-up targets the exact session or returns typed `unsupported`; earlier attempt evidence remains immutable and bound to its snapshot. | Any claimed continuation capability demonstrated; unsupported status recorded otherwise. |
| Cancellation and policy | Cancellation distinguishes request acknowledgement from confirmed termination; permission denial and unsupported safeguards are represented explicitly. | Approved active-job cancellation confirms runtime termination, plus a policy-denial check per runtime. |
| Usage and errors | Missing usage remains unknown; malformed/partial events, timeout, runtime failure, and invalid result map to stable typed outcomes. | Record observed cost/provenance and actual unsupported features. |

**Task 14 gate:** offline matrix passes for both adapters; then separately approved live code, review, and cancellation checks pass for each. Record runtime versions, model identity, costs and limitations. Checkpoint 5 requires two real runtimes to satisfy the declared common contract and portability claims to match observed coverage. Offline fixtures alone cannot pass Gate B. Any Claude worker claim requires repeating discovery and conformance for Claude.

## Task 15 — reproducible local release package

Keep a release manifest tying the version to source revision, Node support range, dependency lockfile, target architecture, artifact names, and SHA-256 checksums. Build from a clean checkout using the lockfile; compare repeat builds or document any unavoidable nondeterministic fields. Verify the produced CLI and daemon entry points from the package, not only from `dist/` in the repository. Check the actual target Mac architecture first; advertise other architectures only after equivalent checks.

Offline/local acceptance checks:

- Clean dependency install from the lockfile and build with supported Node 24 and 26 versions; capture exact versions and commands.
- Rebuild from the same revision and compare artifact contents/checksums; checksum verification must reject a modified artifact.
- Install into an isolated local prefix/account, invoke both binaries, and check daemon/client version compatibility and mismatch errors.
- Exercise upgrade with existing jobs and configuration; rehearse a database migration backup, restore, and retrieval of the same job/evidence.
- Exercise uninstall and verify binaries are removed while user state, credentials, jobs, worktrees, and configuration remain. Login startup stays opt-in and is absent unless explicitly enabled.

**Task 15 gate:** repeatable package provenance and checksums, install/upgrade/uninstall and daemon lifecycle evidence on the target architecture, and migration backup/restore evidence. Checkpoint 6 additionally requires preserved jobs/configuration and a stable or explicitly versioned protocol/evidence/approval surface. Extension implementation waits for human approval at that checkpoint.

## Task 16 — local Homebrew tap validation

Preparation can draft a formula against the exact Task 15 versioned artifact and checksum, then validate it using a disposable local tap directory. The formula must declare its actual runtime dependencies and supported architecture, install only Gattini, and avoid provider installation/login, credential edits, service enablement, and state deletion. Formula metadata must identify the project source and release accurately; owner, repository, package-name, and trademark checks precede any external tap.

Local checks after Task 15:

- Run `brew audit --strict --formula` and `brew test` against the local formula.
- Install from the local tap in a controlled prefix and verify binary versions, checksum/source identity, and daemon/client behavior.
- Exercise upgrade and uninstall against disposable state, proving user state is preserved and any service remains opt-in.
- Record Homebrew/macOS/architecture versions and formula output. Test each advertised architecture rather than inferring support.

**Task 16 gate:** local audit, formula test, clean local install/upgrade/uninstall, and dependency/platform claims pass. Publishing credentials may be checked through configured tooling only when publication work is authorized. External tap creation and publication each require the owner's approval. Record publication as complete or explicitly deferred for Checkpoint 7.

## Task 17 — VS Code submit/status client

After Task 15 and Checkpoint 6 approval, keep the extension a client of the existing versioned daemon protocol: submit a bounded task, show durable status/events, and resume from the saved event cursor after disconnect. It must not schedule work, own runtime configuration, or maintain a second job database. Do not begin result/evidence viewing or approval/cancel controls here; those belong to Task 18 and its exact-ID safety checks.

Offline/extension-host checks:

- Manifest contribution and activation are limited to the intended commands/views; no task, shell, or workspace code runs merely because a folder opens.
- Workspace Trust blocks submission in untrusted workspaces and never offers a bypass that launches a job.
- Submit/status/event requests use the frozen protocol and typed errors; reconnect reuses the exact job ID and cursor without duplicate submission or skipped/duplicated events.
- Cover daemon unavailable/restart, multiple workspace folders with explicit repository selection, and task/state paths containing spaces.
- Confirm the extension contains no scheduler/runtime implementation and reports daemon/client protocol mismatch clearly.

**Task 17 gate:** extension-host checks pass for trusted/untrusted workspace behavior, reconnect, multiple folders, and spaced paths; a manual VS Code submission/status/reconnect flow uses the same durable job shown by the CLI. Task 18 must then add safe result/evidence and approval actions before Checkpoint 7 can pass. Checkpoint 7 also requires fresh-account install/recovery guidance and Task 16's publication or explicit deferral decision.

## Evidence and handoff

For each task, record base revision, owned paths, exact commands and outputs, package/runtime versions, checksums or fixture identifiers, live spend if authorized, limitations, and the dependency that remains. Preserve a clear label between offline fake/fixture evidence and observed live behavior. Revisit any prepared assumptions after shared protocol or package interfaces change.
