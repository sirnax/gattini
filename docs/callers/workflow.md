# Calling Gattini from a coding agent

These instructions cover the durable local CLI workflow shared by Codex and Claude Code. Use the caller-specific guide for a short pointer and copy its task template into a UTF-8 file. Gattini's CLI is installed or built by the repository owner; do not install software or enable a service as part of a task. The daemon must already be running. Gattini does not start or stop the daemon or OpenCode service.

## Submit and follow one job

Give each logical task a unique, stable idempotency key and retain the returned exact job ID. Use the same key only to reconnect to that same submission: resubmitting it observes the existing job and does not create a new attempt. Use a new key for a deliberately new task. Do not guess, shorten, or substitute job and approval IDs.

For ordinary jobs:

```sh
gattini run --task-file task.txt --idempotency-key codex-issue-482 --role reviewer --json
```

`run` submits once, then blocks while the job is active. At terminal state it prints the `result` envelope. Save its `jobId`; after a connection loss, reconnect with `gattini status EXACT_JOB_ID --json` and `gattini result EXACT_JOB_ID --json`. A transient disconnect exits 3; it does not imply the job stopped. `run` waits indefinitely while the daemon remains reachable. Ctrl-C exits 130 and SIGTERM exits 143; neither cancels by default. Add `--cancel-on-interrupt` only when cancellation is intended.

Inspect the result envelope and nested result before reporting success. Require `execution: "completed"` and `acceptance: "passed"` for a success claim. `acceptance: "unverified"` is not a pass. For trusted coding, also inspect `changedFiles`, `verification`, and `snapshot`: check the exact argv, exit codes, timeout/truncation flags, snapshot and diff digests, and retained artifact paths. Read the retained snapshot and diff when accessible. A digest records identity; it does not itself prove the content is correct. Report limitations and any inability to inspect host-local evidence.

## Approval workflow

`--require-approval` creates a durable pending job and does not launch a runtime until an exact approval ID is approved. Approval IDs may be omitted from a later `run` JSON response, so use `gattini approvals list --json` and select the matching job's exact ID. Approve or deny explicitly:

```sh
gattini approvals list --json
gattini approve EXACT_APPROVAL_ID --json
gattini deny EXACT_APPROVAL_ID --json
```

An approval-required `run` exits 4 and leaves the job durable. It never auto-approves. After an authorized approval, call `run` again with the same task file and idempotency key to wait for that job. For trusted local coding, the first approval covers the read-only proposal launch. After it runs, inspect the newly pending `code-apply` approval and proposed change, then require a separate explicit approval for that exact patch. Only then reconnect with the same key and inspect the terminal result/evidence. Each approval expires after 15 minutes. Do not approve on behalf of the repository owner or infer approval from a task prompt.

The trusted coding options require all of `--role code`, `--repo`, `--base-sha`, `--checks-file`, `--trusted-local-code`, and `--require-approval`:

```sh
gattini run --task-file task.txt --idempotency-key codex-change-482 --role code \
  --repo /absolute/path/to/repository --base-sha FULL_COMMIT_SHA \
  --checks-file checks.json --trusted-local-code --require-approval --json
```

Only the opt-in guarded proposal/apply path is available. The legacy direct-edit coding gate remains disabled. Current validation supports one existing tracked root-level regular file; it rejects new files, nested paths, links, mode changes, and multi-file patches. OpenCode's read-only proposal session is not host containment: host reads, plugins, provider access, and verification command host access are not contained. Verification terminates ordinary POSIX process groups, but a process that creates a new session can escape. Retained artifacts and digests detect ordinary changes but are not tamper-proof against the same user. Never ask a caller to bypass its own sandbox, permissions, or approval boundary.

## JSON and exit handling

With `--json`, successful output is one JSON object on stdout. At terminal state `run` and `result` return `{ "jobId", "state", "result" }`; if `run` reaches `awaiting-approval`, it returns `{ "jobId", "state", "approvalId" }` when available and exits 4. CLI validation, daemon, and protocol errors are `{ "error": { "code", "message" } }` on stderr with stdout empty. Parse stdout and stderr separately. Human output is not a machine interface.

| Exit | Meaning | Caller action |
| --- | --- | --- |
| 0 | Command succeeded; for terminal run/result, execution completed without failed acceptance | Still inspect acceptance; `unverified` is not passed |
| 1 | Terminal execution failed, was cancelled/interrupted, or acceptance failed | Report failure and inspect result |
| 2 | Invalid CLI input | Correct arguments; do not retry blindly |
| 3 | Daemon, protocol, or request failure | If a job ID is known, reconnect using that exact ID |
| 4 | Approval is required for progress | Inspect approvals and wait for explicit owner approval |
| 130 / 143 | Run received SIGINT / SIGTERM | Reconnect by exact job ID; cancellation happens only with `--cancel-on-interrupt` |

`start` and `status` exit 0 for successful submission/query regardless of job state. `result` and `run` report terminal outcome. Never treat process exit 0 alone as proof that acceptance passed.

## Caller sandbox limits

The CLI talks to a local Unix socket under the configured Gattini state directory. A caller sandbox may not be able to access the executable, task file, repository, state directory, socket, checks, or retained evidence. Diagnose access using the caller's normal permissions and report the specific unavailable path or operation. Do not widen permissions, disable sandboxing, request macOS permissions, or read another context's files to make the workflow work. Ask the repository owner to run the corresponding local command when the caller cannot access the required resource.

No provider spend is implied by these examples. A real OpenCode run may incur provider cost; obtain fresh owner authorization for every paid/live provider test. Offline fake tests do not count as live caller smoke tests.
