# Gattini — master plan

Status: proposed build specification, updated 26 September 2026. Target: Nate's Mac, implemented with Codex or Claude Code.

Read this file first, then `GATTINI_ROADMAP.md` in this directory. These two files supersede the earlier MCP-first plan for this project. They describe the intended system; the roadmap and README distinguish implemented slices from proposals. No published package or unverified integration is implied.

## 1. Outcome

Build Gattini: a local-first agent execution broker that lets a human, Codex, Claude Code, OpenCode, or an editor submit bounded jobs to interchangeable agent runtimes. Start by letting Codex and Claude Code use Nate's existing OpenCode agents. Preserve a premium planner → economical orchestrator → specialised workers workflow.

Gattini owns routing, durable jobs, execution policy, evidence and approvals. Agent runtimes own their agent loops and provider authentication. Editor interfaces remain thin clients. The long-term scope includes coding, shell, browser and desktop work; each capability must have its own implementation and permission boundary.

Success means a caller can submit work, disconnect, reconnect, inspect results, request follow-up, and cancel without losing ownership or mistaking an unverified answer for completed work.

## 2. Non-negotiable decisions

- No MCP server or MCP bridge in Gattini's architecture. This is a design preference, not a claim that MCP is deprecated.
- Separate the caller, runtime, model, role and execution environment. None should be hard-coded as the identity of a job.
- OpenCode is the first worker backend. Codex and Claude Code can be callers immediately through the CLI; using either as a worker requires a separate adapter.
- Reuse existing OpenCode agent definitions by explicit name. Do not overwrite global runtime configuration or duplicate provider credentials.
- Keep agent and model selection explicit. Record what was requested and what actually ran.
- One orchestrator owns a workflow. Workers cannot recursively delegate by default.
- Write jobs use an owned Git worktree for coding tasks. A worktree separates changes; it is not a security sandbox.
- No automatic merge, push, publication, deployment, purchase, message sending, or destructive cleanup.
- Every completed task has evidence. Worker claims and reviewer opinions are not substitutes for executed verification.
- Local-only by default. Remote execution and desktop control are later, separately approved scope.

## 3. Scope and release boundaries

### First useful release

A CLI plus local daemon, OpenCode worker adapter, named role mapping, durable jobs, bounded concurrency, owned worktrees, cancellation, approval blocking, structured results and Codex/Claude caller instructions. Demonstrate one small code change and one read-only review in a disposable repository.

### Runtime-neutral release

Add a Codex worker adapter and run the same contract tests against both real runtimes. Add Claude as a worker only after its installed interface has been validated. A mock adapter proves the abstraction in tests but does not prove production portability.

### Editor and distribution release

Package for macOS, then allow local Homebrew tap validation and a thin VS Code extension to proceed independently once the protocol is stable and the human approves extension work. Tap publication still needs separate approval. Other editors can invoke the CLI from their terminals or tasks; native integrations require explicit compatibility testing.

### Whole-computer expansion

Add browser and desktop executors, resource locks and action-specific approvals. A coding runtime does not automatically provide computer control. GUI work requires a supported tool backend and explicit macOS permissions.

Out of scope initially: remote fleets, multi-user tenancy, distributed scheduling, a custom foundation-model API gateway, automatic self-improvement, a new agent loop, universal editor compatibility, and unrestricted host access.

## 4. Model and role strategy

The names below are user preferences, not verified provider IDs or promises of availability. Discover installed runtime capabilities and provider catalogues before populating configuration. Never silently substitute a different model.

| Role | Preferred candidates | Responsibility |
| --- | --- | --- |
| Planner | Fable / Astra | Scope, architecture, acceptance criteria, difficult decisions |
| Orchestrator | GPT-5.6 Sol / GLM 5.3 | Turn an approved plan into bounded jobs, inspect evidence, escalate |
| Code worker | GLM 5.3 Flash / GPT-6 Luna / DeepSeek Flash V4.1 | Small implementation tasks and tests |
| Reviewer | Independently configured worker or stronger model | Read-only review of exact result snapshot |
| Local experimental worker | prism-ml/ternary-bonsai-2-27b | Low-risk tasks after measured local evaluation |

Default workflow: the interactive Codex or Claude session acts as orchestrator and calls Gattini. A later unattended orchestrator can use the same job API. The daemon is a deterministic scheduler, not another LLM manager.

Route by required capability, policy, availability and configured preference. Initially use explicit role mappings rather than opaque automatic routing. Unknown cost stays unknown, never zero. A monetary ceiling is only enforceable as a hard limit when the provider/runtime offers reliable metering or reservation; otherwise disclose best-effort cancellation and possible in-flight overspend.

Start with one write worker and one read-only worker maximum, subject to the Mac's measured resources. Permit one configured retry for a transient failure; require escalation after that. Do not retry potentially side-effecting work automatically.

## 5. Architecture

| Component | Owns | Must not own |
| --- | --- | --- |
| `gattini` CLI | Validated requests, human/JSON output, watching jobs | Background agent lifetime |
| `gattinid` daemon | Queue, durable state, policy, runtime handles, recovery | Provider credential harvesting or an LLM loop |
| Runtime adapters | Start, events, status, cancellation, follow-up, result collection | Global workflow policy |
| Execution environments | Workspace preparation, containment, resource locks | Model selection |
| Verification runner | Explicit checks against the exact output snapshot | Accepting arbitrary worker claims as proof |
| Editor clients | Submission, progress, approvals, diffs | A second scheduler or job database |

Proposed implementation: TypeScript with strict checking, compatible with Node.js 24 and newer (check the installed 24 and 26 versions), SQLite for job state and ordered events, and a Unix-domain socket for local RPC. Validate SQLite packaging on Apple Silicon before committing to a driver. Record stack choices in an ADR. Use a small repository with `src/cli`, `src/daemon`, `src/core`, `src/adapters`, `src/environments`, `src/verification` and `tests`; split packages only when distribution requires it.

Use a versioned request/response protocol with request IDs, typed errors, event cursors and bounded payloads. Socket directory permissions must restrict access to the user. Same-user hostile processes are outside this initial security boundary. Avoid a public listener; any later loopback HTTP transport needs authentication and origin checks.

Store state under a documented per-user macOS application-support directory, with restrictive permissions. Keep repository configuration separate from private state. The daemon runs as the logged-in user, never root. Login startup is opt-in; install must not silently enable a service.

### Runtime adapter contract

Specify operations before implementation:

- Discover runtime version, available agents/models and supported capabilities.
- Start a job with an immutable resolved configuration and an idempotency token.
- Report/reconcile runtime status and stream resumable events where supported.
- Route permission requests without auto-approving them.
- Follow up on an exact session or return `unsupported`.
- Cancel and report whether termination is confirmed.
- Collect a structured result and evidence references.

Capabilities include headless execution, explicit session identity, follow-up, event streaming, cancellation, permission enforcement, structured output, usage reporting and execution containment. Unsupported capabilities must be explicit. Refuse a job when its required safeguards cannot be enforced.

### OpenCode integration

Start with its documented non-interactive interface against a controlled local service when available. The discovery spike must prove exact agent/model selection, session identity, permissions and cancellation. If CLI-only access cannot satisfy those requirements, use the supported local API/client inside the adapter before expanding the product. An embedded SDK is an alternative requiring a lifecycle/isolation decision, not an obligatory migration.

Version-gate the adapter. Do not mix OpenCode V1 and V2 SDKs, configuration keys or flags. NDJSON output is an event stream to parse, not automatically a valid Gattini result. Never resume the ambiguous “last session” in concurrent operation.

Gattini may attach to a user-owned service only with an explicit configuration choice. It must not stop that service when cancelling one job. Owned processes/services and shared processes/services need different shutdown handling.

## 6. Job and result contracts

Define and validate schemas for these records:

| Record | Required contents |
| --- | --- |
| Job | Schema version, ID, parent workflow, role, task, acceptance criteria, capabilities, input references, repository/base SHA if relevant, allowed scope, verification commands, limits, approval policy |
| Attempt | Attempt ID, resolved runtime/version/agent/model, configuration digest, worktree, exact runtime session handle, timestamps, process ownership, usage provenance |
| Event | Job/attempt IDs, monotonic sequence, timestamp, event type, bounded/redacted payload |
| Result | Execution outcome, acceptance outcome, summary, changed files, diff/snapshot reference, verification commands and exit codes, artefacts, review findings, usage, limitations |
| Approval | Job/attempt, exact proposed action and parameters, scope, expiry, decision and actor |

Persist input and resolved configuration before launch. Bind evidence to the exact result snapshot. Separate `execution: completed` from `acceptance: passed|failed|unverified`. A zero process exit code does not mean acceptance passed.

Proposed lifecycle: queued → preparing → running → verifying → completed. Jobs may enter awaiting-approval while preparing/running; terminal alternatives are failed, cancelled and interrupted. Cancellation goes through cancelling and becomes cancelled only after confirmed termination. A lost connection is not proof of termination. Represent uncertain runtime state explicitly and block conflicting work pending reconciliation.

Use transactionally allocated leases to prevent duplicate dispatch. Submission idempotency keys deduplicate client retries, but cannot guarantee exactly-once external side effects. After a crash, reconcile the saved runtime handle before deciding whether a new attempt is safe. A follow-up creates a tracked turn/attempt and preserves earlier evidence.

## 7. CLI design

These are proposed Gattini commands to implement, not commands currently available:

```sh
gattini doctor
gattini agents
gattini models --runtime opencode
gattini run --role reviewer --task-file review.md --json
gattini start --role code --task-file task.md --repo /absolute/repo --json
gattini status JOB_ID --json
gattini logs JOB_ID --follow --after EVENT_CURSOR
gattini result JOB_ID --json
gattini followup JOB_ID --task-file followup.md
gattini cancel JOB_ID
gattini review JOB_ID
gattini approvals list
gattini approve APPROVAL_ID
gattini deny APPROVAL_ID
```

Also provide daemon lifecycle commands and explicit retention/cleanup commands. Machine output goes to stdout; diagnostics go to stderr. Define stable exit codes for success, task failure, invalid input, unavailable capability and approval required. Blocking `run` watches a durable job; a client disconnect does not silently kill it. Document interrupt behaviour and offer explicit cancel-on-disconnect only when requested.

Caller instructions must teach exact-ID follow-ups, bounded task files, evidence inspection and escalation. Store substantive instructions once, with short `AGENTS.md` and `CLAUDE.md` pointers. Keep runtime installation/authentication separate from Gattini configuration.

## 8. Workspace and security policy

For coding, resolve repository identity and explicit base commit. Preserve the user's dirty checkout; refuse implicit incorporation of uncommitted changes. Create job-owned branches/worktrees outside the source checkout where practical. Record ownership before cleanup. Pin reviewer input to a finished snapshot and prevent concurrent writer changes.

Allowed-path rules must be backed by an enforceable runtime or execution boundary where they are advertised as security guarantees. A post-run diff check detects violations but cannot prevent secret reads, network calls or external writes. Label containment accurately. Untrusted tasks require a stronger isolated environment; defer them if the first release cannot provide it.

Policy covers filesystem reads/writes, shell execution, network access, secrets, browser profile and desktop permissions. Arbitrary shell commands cannot be made safe by a simplistic allowlist. Execute argument arrays without shell interpolation, validate paths and defend against symlink escapes. Verification commands execute code too and require an approved environment.

Treat repositories, prompts, pages and model output as untrusted data. They cannot grant permissions or change policy. Require human approval for external side effects. Scope approvals to the exact action and invalidate them when parameters change. Do not forward runtime secrets through job prompts, artefacts or logs. Redaction is defence in depth, not a guarantee that arbitrary transcripts contain no secrets.

Set limits on runtime, attempts, child jobs, log volume and concurrency. Retain artefacts on failure. Cleanup is a dry-run-first action limited to validated Gattini-owned resources, with a retention policy and explicit confirmation for removing unmerged work.

## 9. Whole-computer capability path

Model capabilities from day one, implement them incrementally:

1. Code: worktree, tools, tests and diff evidence.
2. Host shell: explicitly trusted jobs with clear filesystem/network access.
3. Browser: dedicated profile/session, navigation policy, screenshot evidence, approval before submission or account changes.
4. Desktop: explicit Accessibility/Screen Recording permission, visible session ownership, exclusive input lock, emergency stop, approval before consequential actions.
5. Remote worker: authenticated transport, scoped credentials, separate host policy and tested disconnection semantics.

Browser and desktop jobs need resource locks instead of Git assumptions. A desktop action may be irreversible; cancellation stops further actions but does not undo earlier ones. Local models are an optional worker backend reached through a supported runtime/provider interface after measuring memory, speed, tool-use reliability and task quality on the actual Mac.

## 10. Distribution and compatibility

Use Gattini as the project, package and CLI name; the daemon is `gattinid`. Nate reports that `gattini.dev` is available to register, but no registration or name reservation has been performed. Choose the repository owner and verify package, tap and trade-mark availability before publishing. A future install target could be `brew install <owner>/tap/gattini`; it is not an existing published formula. Ship checksummed release artefacts or a tested formula with declared dependencies. Test Apple Silicon first and advertise Intel support only after testing.

Homebrew installation must preserve runtime configs, credentials and user data. Test install, upgrade, daemon version mismatch and uninstall. Remove binaries without silently deleting jobs or worktrees. Any service definition must launch the correct installed version and handle upgrades safely.

VS Code follows the stable protocol: submit, list jobs, inspect logs/diffs, approve and cancel. Respect Workspace Trust; opening a repository must not execute its tasks. Validate each VS Code-derived editor separately. ACP can be considered later for compatible editor clients; it is not required for the core protocol.

## 11. Definition of done

Every implemented slice has focused tests, type checking, a build and an observed acceptance result. Live provider tests are opt-in and bounded by an approved spend limit. Fixtures cover malformed/partial events, missing models, denied permissions, process crashes, duplicate submissions, daemon restart and failed cancellation.

Release readiness requires a real Codex or Claude caller → Gattini → existing OpenCode agent → verified result demonstration; an independently tested second worker runtime for runtime-neutral claims; and an installation test from a clean macOS account or controlled equivalent. Record tested versions and unsupported features explicitly.

## 12. Build-agent working agreement

1. Read both documents and inspect the Mac/repository before changing anything.
2. Own the earliest ready task on the roadmap's critical path. Delegate independent, bounded preparation asynchronously as described in the roadmap, but integrate each task only after its dependencies and required checkpoint approval. Record evidence and status for the combined result; preparation alone never completes a task.
3. Preserve unrelated changes and existing runtime agents/authentication.
4. At each checkpoint summarise files changed, tests, live costs, unresolved risks and next tasks; wait for human review.
5. Ask before installing software, creating external repositories, publishing, enabling startup services, spending on live tests or requesting macOS control permissions unless already explicitly authorised.
6. Keep discovered commands and versions in the repository's compatibility report. Record architecture changes as ADRs and update these plans when approved.

Suggested skills, if installed: planning/task breakdown before changing scope, API/interface design for contracts, test-driven development for each slice, security review before host/browser/desktop execution. These plans must remain usable without a particular skill package.

## 13. Sources and validation boundary

Official pages checked on 23 September 2026:

- [OpenCode V2 commands](https://opencode.ai/v2/docs/cli/commands/): non-interactive runs, JSON events, agent/model flags, service management and discovery commands.
- [OpenCode V2 SDK](https://opencode.ai/v2/docs/build/sdk/): alternative embedded integration to evaluate if required.
- [Homebrew tap guide](https://docs.brew.sh/How-to-Create-and-Maintain-a-Tap): tap packaging reference.

Validate all runtime-specific APIs against the versions installed on the Mac. Codex/Claude worker interfaces, editor APIs, model IDs and local-model hardware suitability remain discovery work. No existing third-party wrapper has been audited or selected as a dependency.
