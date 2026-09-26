# Compatibility and discovery

Task 1 inventory, 2026-09-24. This is read-only interface discovery, not a live integration test. No provider request, package installation, or runtime configuration change was made.

## Host and prerequisites

| Item | Observed |
| --- | --- |
| Host | MacBook Pro, Apple M1 Max, arm64, 32 GB RAM |
| macOS | 26.6.2 (build 25G83); Darwin 25.6.0 |
| Git | 2.55.0 |
| Homebrew | 7.0.6 at `/opt/homebrew` |
| Active Node / npm | 26.9.0 / 11.19.1 |
| Additional installed Node | Homebrew `node@24` 24.21.0 |
| pnpm / Bun | 10.30.0 / 1.4.2 |
| SQLite CLI | 3.51.0 |
| Xcode tools | Xcode 27.0, Apple clang 21.0.0 |
| Repository | Git initialized on `main`, no commits or remote; planning files remain untracked |

The host has the tools needed to begin local scaffolding. Task 2 will target Node 24+ and check both installed major versions rather than rely on a single active version. A TypeScript compiler, runtime schema library, SQLite driver and test runner have not been selected or installed for this project. SQLite driver packaging on Apple Silicon remains to be proven.

Inventory commands included `uname -s -m -r`, `sw_vers`, `system_profiler SPHardwareDataType`, `node -p 'require("os").totalmem()'`, `git --version`, `brew --version`, `brew config`, `brew list --versions`, `node --version`, `npm --version`, `pnpm --version`, `bun --version`, `sqlite3 --version`, and `xcode-select -p`. `sysctl -n hw.memsize` was denied by the sandbox; Node and System Profiler both reported 32 GB. Hardware identifiers from System Profiler were omitted.

## Installed agent runtimes

| Runtime | Observed version | Agent/model discovery |
| --- | --- | --- |
| OpenCode | 2.0.16, V2 Homebrew binary | No custom agent definition found in the inspected user and repository configuration. Built-in/registered agent names could not be enumerated. Configured model identifiers are listed below; live availability is unverified. |
| Codex | `codex-cli 0.156.1` | No configured agent definitions found in inspected files. The inspected config names `gpt-5.6-sol` as its default model; this is a configuration value, not a live worker probe. |
| Claude Code | 2.1.281 | No custom agent definition files found in inspected user configuration. Available agent/model names were not enumerated. |

Sanitised OpenCode configuration exposes these exact model identifiers:

- `openrouter/google/gemini-3.8-flash` (`small_model`)
- `openrouter/z-ai/glm-5.3-flash` (configured provider model key)
- `openrouter/deepseek/deepseek-v4.1-flash` (configured provider model key)

These entries do not prove provider access or successful execution. The preferred planner, orchestrator, Luna, and local experimental candidates in the master plan have no verified OpenCode identifiers in this inventory. Exact OpenCode agent names and the available model catalogue remain unresolved; Task 3 cannot claim support until it selects a real named agent and model.

## Interface candidates, not confirmed behavior

| Need | Installed help / official V2 documentation | Unproven point |
| --- | --- | --- |
| OpenCode start | `opencode run --agent <name> --model <provider/model> --format json`; `--standalone` and `--server` choose private or specified service | Stable session ID and event/result schema under real execution |
| OpenCode session/status | `opencode session list --format json`; V2 API documents session listing, lookup and active sessions | Exact job-to-session reconciliation after disconnect/restart |
| OpenCode follow-up | `opencode run --session <id>`; V2 API documents messages to exact sessions | Concurrent routing and immutable evidence handling |
| OpenCode cancel | V2 API documents session interruption | Whether the worker actually stops and whether cancellation can be confirmed |
| OpenCode permissions | V2 API documents pending requests/replies and permission configuration; CLI exposes `--auto` | Actual denial, noninteractive blocking, and enforceable read-only policy; never use `--auto` as a shortcut |
| Codex worker candidate | `codex exec` help exposes JSONL output, model, sandbox and approval options; help exposes `resume`, `queue`, and `agents` | No direct cancel command was found in inspected help; defer worker transport until Task 13 |
| Claude worker candidate | Help exposes background start, attach/logs, stop/kill, resume/session IDs, and permission modes | Worker semantics remain untested; a Claude worker is a later decision |

OpenCode's installed `--version`, `--help`, `run --help`, `session --help`, `session list --help`, `models --help`, `service --help`, `serve --help`, and `api --help` were compared with the [official V2 CLI commands](https://opencode.ai/v2/docs/cli/commands/) and [V2 API reference](https://opencode.ai/v2/docs/api/). The [V2 permission documentation](https://opencode.ai/v2/docs/permissions) describes the intended permission surface. Codex and Claude help findings were compared with the official [Codex CLI reference](https://developers.openai.com/codex/cli/reference/) and [Claude Code CLI reference](https://code.claude.com/docs/en/cli-reference). Published references can describe newer behavior than these installed versions, so installed help takes precedence for available flags. The OpenCode API reference labels parts of the HTTP API experimental, so this is not a selected transport or support guarantee.

Task 13 read-only discovery on 26 September 2026 found installed `codex-cli 0.157.1` at `/opt/homebrew/bin/codex`, superseding the initial `0.156.1` inventory above. `codex --version`, `codex exec --help`, `codex exec resume --help`, `codex app-server --help`, and related help commands made no provider call. The [Task 13 discovery note](roadmaps/TASK13_DISCOVERY.md) records the candidate transports and unsupported capabilities; no Codex worker integration has been tested.

### Task 13 Codex worker observation — 2026-09-26

The installed `codex-cli 0.157.1` app-server stdio transport completed one specifically approved, 60-second-limit read-only Gattini reviewer job in `/private/tmp/gattini-task13-live.knW42v`. The exact submitted task asked for the value of `add(2, 3)` from a 46-byte math fixture. Requested model/provider `gpt-6-luna`/`openai` matched the app-server thread-start response and saved Gattini identity. Gattini recorded thread/session `01a0dfde-c6c8-7fa3-8726-8e7318d0acab`, turn `01a0dfde-c8bc-7be2-a5be-58ecb9fb05b7`, one completed attempt `847f2570-91fc-4fef-8072-f02326c0cbc9`, and job `21b612cf-e1ca-416f-ad9f-9281d44c1209`. The answer said the function returns 5. The result remains `acceptance: unverified` because no independent acceptance check applies to this review role. Both fixture file hashes and directory entries were unchanged; no runtime config outside the private test state was altered. The disposable Gattini daemon was stopped and the evidence retained.

Codex app-server reported **21,964 input tokens and 27 output tokens** for the exact session; it exposed no USD cost in this adapter, so cost is **unknown**, not zero. The installed protocol's thread model fields are configured/persisted identity rather than independent per-turn backend attestation. No `model/rerouted` event was observed. This proves the returned runtime identity and bounded single-turn result, with that telemetry limit. Live Codex cancellation, approval denial under a request, continuation, coding, and cross-runtime conformance were not exercised. Offline fixtures cover exact-ID interruption and fail-closed approvals, but Task 14 must observe live cancellation/code/review before Gate B.

OpenCode initially failed to open its normal log under the workspace sandbox (`EPERM`). Setting `XDG_DATA_HOME=/private/tmp/gattini-opencode-discovery` allowed version and help inspection without changing the normal runtime configuration. `opencode debug agents` did not finish promptly in that isolated environment and was interrupted; it produced no agent inventory. No service was started intentionally. Runtime model enumeration was not attempted because it may load provider state; any later call must remain a bounded, read-only discovery step.

## Task 2 entry point

Create the smallest Node 24+ strict TypeScript package and fake runtime slice. Keep runtime-specific commands out of core contracts. First resolve project dependencies and the offline test runner, then validate contracts and configuration on Node 24 and 26. OpenCode's real transport and enforcement remain Task 3 work requiring the planned, approved live probes.

## Task 3 preflight — 2026-09-24

With normal OpenCode log access, `opencode debug agents` returned `[]` for the Gattini repository. A read-only `opencode api agent.list` query against the already-running local service also returned an empty `data` array for this repository. A subsequent disposable Git repository with its own `opencode.jsonc` loaded the location and revealed built-in agents `build`, `compaction`, `explore`, `general`, `plan`, `summary`, and `title`, plus the temporary `gattini-probe` agent defined only in that repository. The earlier empty lists did not establish that OpenCode lacked built-in agents. No user service was started or stopped for these queries, and no global config was changed.

`opencode models` returned 406 catalogue identifiers. Relevant exact entries include `opencode/mimo-v2.6-flash-free`, `openrouter/deepseek/deepseek-v4.1-flash`, `openrouter/google/gemini-3.8-flash`, `openrouter/z-ai/glm-5.3-flash`, `openrouter/openai/gpt-6-luna`, and `openrouter/openai/gpt-5.6-sol`. This is a catalogue, not a successful authentication or model invocation. The Task 3 probe will use the temporary `gattini-probe` agent in the disposable repository and `opencode/mimo-v2.6-flash-free` initially, recording resolved identity and any access failure rather than substituting silently.

### Private-service probe results

A disposable Git repository under `/private/tmp` was created with a local-only `gattini-probe` agent. A private OpenCode V2.0.16 service bound to loopback was started and stopped by each bounded probe; its generated password was captured inside the probe process and not recorded in this repository. The installed API confirmed exact session creation with the requested agent/model, prompt admission to that session ID, active-session lookup, projected messages, and a session log response. Agent listing was briefly empty while the project location loaded, then included the named agent. The adapter now waits a bounded interval before reporting a missing agent.

No successful model output was obtained. `opencode/mimo-v2.6-flash-free` rejected both HTTP API and `opencode run --standalone --format json` execution with `OpenCode's free tier can only be used from within OpenCode`. The CLI did emit NDJSON with a stable `sessionID`, `step_start`, and typed `provider.auth` error; a redacted fixture is in `tests/fixtures/opencode-cli-auth-error.ndjson`. A separate [zero-price OpenRouter model](https://openrouter.ai/cohere/north-mini-code), `cohere/north-mini-code:free`, was tried through the native provider and a disposable OpenAI-compatible provider with an environment credential reference. Both runs ended with `No cookie auth credentials found`. `opencode auth list --format json` reports one OpenRouter provider with credential and environment connection types, but that does not prove the private service can use them. A direct external credential-status check was rejected by automatic approval review because it would transmit the credential to a separate endpoint; it was not retried.

The disposable repository's tracked `README.md` remained unchanged after these probes; its agent configuration was intentionally edited during authentication diagnosis. The experimental session log returned a `log.synced` marker during these failed runs; no worker output stream was observed.

### Approved shared-service probes

The owner approved up to three four-step paid probes with `openrouter/z-ai/glm-5.3-flash` and attachment to the already-running OpenCode service. Only the disposable repository's temporary agents were invoked. No global agent or credential configuration was edited, and the shared service was not stopped. The service is a user-owned process; any future Gattini attachment needs explicit configuration.

| Probe | Observed OpenCode V2.0.16 evidence | Reported cost (USD) |
| --- | --- | ---: |
| Read-only review | `gattini-probe` streamed `step_start`, completed `read` tool use, `step_finish`, and final text. Stable exact session `ses_f2bfd53c7ffelFMGluISo9Be44` resolved to the requested agent and model and outcome `succeeded`; the answer read `Sentinel: original`. | 0.00069645 |
| Permission denial | `gattini-denial-probe` received an explicit request to change the sentinel. Its configured ordered permissions deny `*` and allow only `read`, `glob`, and `grep`; the run exposed no edit/write/shell tool. It reported editing unavailable, and the tracked `README.md` remained `Sentinel: original`. Exact session `ses_f2bfa7db1fferkS6sl0t4NUazC` resolved to the requested agent/model and outcome `succeeded`. | 0.00090435 |
| Cancellation | `gattini-cancel-probe` permitted only `sleep 37`. Exact session `ses_f2bf9831effegAUifynMlqWpzj` was reported `running`; `session.interrupt` for that ID returned `interrupted: true`. Its stream recorded shell error `Tool execution interrupted` and aborted step `Step interrupted`; session outcome was `interrupted`, active sessions became empty, and no `sleep 37` process remained. | 0.00055885 |

Total OpenCode-reported cost for these three runs was **USD 0.00215965**. This is usage reporting, not proof of an enforceable spend ceiling. The `README.md` SHA-1 remained `5746640d8ef710122ff5e3181d5b992f29afb648` after the probes. The event projections in `tests/fixtures/opencode-live-*.ndjson` redact session IDs and model text. The live launch used `opencode run --format json` through the shared service, with `opencode api` for exact-session lookup, status, and interrupt. Direct authenticated launch through the HTTP adapter has only offline tests. The permission result establishes the tested tool policy, not a host security sandbox; cancellation evidence applies to this command and installed runtime version. See [ADR 003](decisions/003-opencode-v2-transport.md).

## Task 5 read-only preflight — 2026-09-24

The durable reviewer path uses a private role mapping that pins `gattini-probe`, `openrouter/z-ai/glm-5.3-flash`, the disposable repository, and the existing service URL. A read-only preflight succeeded against installed `opencode v2.0.16`: `opencode service status` matched the configured address, `opencode api session.active` returned an authenticated response, `opencode debug agents` exposed the agent's effective deny-all/read-only permission tail, and `opencode models` listed the exact model. An explicit `opencode api ... --server http://127.0.0.1:49374` query instead received an HTTP 401 Basic Auth health response; the integration uses the automatic authenticated service connection that worked in Task 3. No provider request or paid model execution occurred in this preflight. See [ADR 005](decisions/005-durable-opencode-review.md) for the transport decision and limits.

### Approved durable review

The owner separately approved one paid Task 5 review. The first Gattini submission created job `18e8d730-ed53-4b7b-886f-49f6abc60258` and exact session `ses_f2bd65746ffef5MqXhd5GLI5wB`, but the session resolved to the Gattini repository instead of the configured disposable repository and failed before model execution. OpenCode reported zero tokens and USD 0. The child process had `cwd` set correctly while inheriting the daemon's old `PWD`; the runner now sets both and verifies the final session location. The failed job remains `interrupted` for reconciliation, with its exact handle retained.

The corrected submission used a new idempotency key and returned queued job `93b34c54-669e-4e2d-9c4f-6d890630f1ac` immediately. A separate CLI process observed `running` with exact session `ses_f2bd47b28ffeqrcHn9cxtlCXsS`, then `completed` with summary `The Sentinel value is original.` and acceptance `unverified`. OpenCode's exact session lookup resolved `gattini-probe`, `openrouter/z-ai/glm-5.3-flash`, location `/private/tmp/gattini-task3.YHWGBr`, and outcome `succeeded`; it reported USD **0.00079485**. Five bounded event projections were persisted. The tracked `README.md` hash remained `5746640d8ef710122ff5e3181d5b992f29afb648` with no diff. The result was retrieved again after a clean Gattini daemon restart. The private state directory, database, and socket were 0700/0600/0600. The daemon was stopped cleanly; the user-owned OpenCode service was never stopped. This confirms the tested version and agent/model path, with the Task 6 crash and cancellation limits in [ADR 005](decisions/005-durable-opencode-review.md).

Task 14 read-only host inspection on 26 September 2026 found `/opt/homebrew/bin/opencode` reporting `opencode v2.0.18`. Its `run --help` still lists explicit `--session`, `--model`, `--agent` and `--format`; `api --help` still exposes operation IDs and method/path requests. `lsof -nP -iTCP:49374 -sTCP:LISTEN -Fn` identified the existing listener, and `lsof -p 47178 -Fn` showed that process loaded an executable from `/opt/homebrew/Cellar/opencode-v2/2.0.11/bin/opencode`. The old executable path no longer exists, so `2.0.11` is the process path's version directory, not a server-reported version. No service was restarted or reconfigured. The reviewer preflight still pins the live-tested V2.0.16 CLI and does not establish the installed CLI/listener pairing. Current `debug agents` under isolated XDG state did not return effective policy promptly and was interrupted; normal-state inspection was denied access to its log in the workspace sandbox. Task 14 live OpenCode review/cancel remains unverified. See the [proposed live matrix](roadmaps/TASK14_LIVE_MATRIX.md).

On 27 September 2026, a user-approved foreground private service on `127.0.0.1:53460` returned V2.0.18 from authenticated `/api/info`, and targeted `agent.list` showed the disposable agent's exact deny-all/read/glob/grep effective rule tail. An explicit process-local URL opt-in allowed V2.0.18 reviewer and read-only proposal preflight without touching the shared listener. A paid OpenCode review completed with the correct math-fixture answer and exact session/model/agent identity; the paid code proposal failed because the read-only tool set gave the model no way to calculate the required SHA-256 and base64 replacement. A second, cancellation-designated review finished before a cancel could be sent. The private service was stopped. This establishes the narrow private reviewer pairing, not V2.0.18 live cancellation or applicable coding. See the [six-turn matrix](roadmaps/TASK14_LIVE_MATRIX.md) for exact evidence and cost.

### Task 6 live cancellation — OpenCode 2.0.16

The owner approved up to two bounded paid cancellation attempts with `openrouter/z-ai/glm-5.3-flash`. The first Gattini submission, job `265a323a-e197-4207-94ac-24157bba4068`, failed before an attempt was claimed or a model session launched. The same role passed an immediate standalone read-only preflight; the transient first failure's cause was not captured by the current daemon diagnostic path. The second submission, job `7b7af040-71c4-4938-9fd6-c9056385e291`, reached exact session `ses_f2b60f2c3ffeglSnKZwfZzVHlQ` with agent `gattini-cancel-review` and model `openrouter/z-ai/glm-5.3-flash`. Gattini sent `cancel` for that job; OpenCode V2 returned an exact-session interruption. A fresh exact-session lookup reported outcome `interrupted` in `/private/tmp/gattini-task3.YHWGBr`, and `session.active` did not contain the session. Gattini reported `cancelled`, retained the exact handle, and returned that state after a clean daemon restart.

The disposable repository's `README.md` SHA-1 remained `5746640d8ef710122ff5e3181d5b992f29afb648`; `git diff -- README.md` was empty. The shared OpenCode service still reported `http://127.0.0.1:49374` after the test. A sanitized `opencode session export` reported **USD 0.00080625**, 570 input tokens, 10 output tokens and 91 reasoning tokens for the interrupted session. The first submission had no attempt or runtime session, so there was no provider execution for it. This proves cancellation for this tested read-only session and installed runtime version; it does not prove that every possible tool operation stops identically or provide a hard provider spending cap.

### Task 9 write-permission probe — OpenCode 2.0.18

On 26 September 2026, the installed CLI reported `opencode v2.0.18` while the existing user-owned service remained at `http://127.0.0.1:49374`. With the owner's USD 0.01 best-effort approval, a temporary `gattini-task9-code` agent was configured only in `/private/tmp/gattini-task9-permission.ejl3wr/repo`. Its effective rule tail denied all actions, then allowed read/glob/grep/edit; `external_directory`, shell, network, and subagent actions had no later allow. Three `opencode run --agent gattini-task9-code --model openrouter/z-ai/glm-5.3-flash --format json` sessions resolved the exact requested identity and disposable directory. An internal edit succeeded; an absolute edit outside the repo returned `Permission denied: external_directory`; an edit through an in-repo symlink to that same outside file reported completion **and changed the outside file**. OpenCode reported USD 0.00015116, 0.00023540, and 0.00035252 respectively, USD **0.00073908** total. Raw NDJSON is retained only under the private temporary root. This observed symlink escape blocks the proposed trusted code path; it does not change the earlier V2.0.16 read-only evidence. See [ADR 009](decisions/009-guarded-coding-and-snapshot-evidence.md).
