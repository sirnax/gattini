# ADR 008 — reviewer policy and exact launch approvals

Status: accepted for the Task 8 offline slice, 25 September 2026.

## Decision

Gattini accepts only the existing OpenCode 2.0.16 reviewer permission shape: deny all tools, then allow `read`, `glob`, and `grep`. Before a reviewer launch, the adapter compares the complete effective agent permission list with that shape. Shell, edit, and network tool grants fail preflight. The policy module rejects requested capabilities that this path cannot enforce, including execution containment. Repository text and model output never populate the role policy.

`gattini start --role reviewer --require-approval` persists an `awaiting-approval` job and a 15-minute pending approval before any runtime preflight or model call. The record shows the exact task, agent, model, directory, and digest of the task/configuration. `gattini approvals list` returns the newest 20 pending records; `gattini approve ID` and `gattini deny ID` use the local Unix socket. Approval revalidates the saved job, configuration, action, and expiry in a transaction. A changed action, repeated decision, or expired record fails closed. A daemon restart leaves pending work blocked; an approved queued job can resume under the existing claim/recovery rules. Denial or expiry makes the job failed; cancellation invalidates a pending approval.

The existing `start` command is itself an explicit human request to launch a reviewer job. `--require-approval` adds a separate gate for queued or delegated work. There is no automatic approval of runtime permission requests. The current CLI exposes no coding worker; the `code` role remains fake and rejects `--require-approval` because it has no real action to gate.

## Limits

The OpenCode permission list is a runtime tool policy, not OS containment. Read tools still have broad filesystem visibility and may read secrets; a same-user process or a compromised runtime can access the host. The shared OpenCode service and provider connection are outside Gattini's isolation boundary. This slice cannot guarantee network denial at the operating-system layer or safely execute arbitrary shell commands. It has no dynamic per-tool approval callback, path-level write boundary, or trusted code worker; such requests must remain unsupported. A worktree alone does not provide those guarantees. No paid or live OpenCode run was made for this decision.
