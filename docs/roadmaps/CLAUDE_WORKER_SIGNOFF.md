# Claude worker sign-off — approved live code and cancellation passed

27 September 2026. This replaces the manual execution procedure in [the code recheck](CLAUDE_WORKER_CODE_RECHECK.md). It keeps its exact model, disposable input, two-turn ceiling and CLI usage thresholds. It does not repeat the already successful direct probe or durable reviewer.

## Diagnosis grounded in retained evidence

| Explanation | Evidence and conclusion |
| --- | --- |
| Claude cannot authenticate or access the model | The task shell initially could not see the existing login. Reviewed local auth checks resolved that access difference. The later direct CLI and durable reviewer both completed using the exact requested model. This does not explain the code failure. |
| The allowance is too small | The failed code turn's local estimate was USD 0.0063698 under a USD 0.05 CLI threshold. No budget error was observed. Max subscription usage and CLI dollar estimates must be distinguished from additional charges. Increasing the threshold would not repair the observed parser failure. |
| Our protocol assumptions reject legitimate output | Confirmed: the earlier adapter rejected a `rate_limit_event`; after its narrow repair the direct stream and Gattini reviewer passed. Confirmed separately: the retained code response contained the correct literal patch inside a Markdown `json` fence; `normalizeProposal` rejected that wrapper. The existing Claude-only wrapper repair preserves strict inner patch validation. |
| Read-only tools prevent this task | The installed CLI successfully used `Read` and produced the required one-file patch. No write tool is needed because Gattini performs the approved replacement. Keep these permissions. |
| Cancellation can produce a misleading green result | Two new offline reproductions failed before repair: a terminal answer followed by a lingering CLI process, and a failed signal syscall followed by natural child exit. The old adapter confirmed both. It now refuses interruption after a terminal answer, and requires successful signal delivery followed by owned-child close. Bounded PID/session/signal/exit metadata is retained before confirmation. Storage failure keeps cancellation unconfirmed. These were offline discoveries, not observed live cancellation failures. |
| The previous fixtures were too unlike the actual task | The original lifecycle test replaced `old` with `new` in `code.txt`. The new scenario replays the exact non-secret fenced `math.mjs` proposal, requires a genuinely failing baseline Node test, and runs the real daemon, SQLite store, Git worktree, approvals, patch validator and snapshot check. Only the provider process is replaced offline. |

The first interrupted review lacked enough diagnostics to assign its precise cause retrospectively. Do not claim every earlier failure had the same cause. The remaining unproven behavior is the installed CLI's complete guarded-code path and active cancellation; a new offline pass cannot supply that evidence.

## Executable acceptance scenario

`tests/helpers/claude-signoff.ts` is shared by the offline suite and `scripts/claude-signoff.mjs`. The live entry point is fixed to the already prepared non-secret root `/private/tmp/gattini-claude-live.BxPN3R`. It checks Node **24.21.0**, Claude **2.1.283**, first-party `claude.ai` **Max** authentication, absence of named credential/routing overrides, and the exact committed fixture/task/check/sentinel hashes before provider work. It requires an explicit `--approved-live` argument. That argument does not replace owner consent or automatic tool approval.

After specific approval, the exact command is:

```sh
/opt/homebrew/opt/node@24/bin/node scripts/claude-signoff.mjs --approved-live
```

The script creates new private 0700 `state-signoff-code` and `state-signoff-cancel` directories and a 0600 `signoff-report.json` under the fixture root. An existing report or state directory causes refusal, so rerunning cannot silently resume or create another provider turn. It retains old and new evidence. Neither normal `npm test` nor invoking this script without its opt-in starts a provider.

1. **One guarded code turn**, `claude-haiku-4-5-20251001`, `maxBudgetUsd: 0.05`. Before launch, inspect the exact task, runtime, policy, repository, base, worktree and Node check in the first approval. Before apply, inspect only the exact owned session transcript for a matched successful `Read` of `math.mjs`, and reject unmatched, failed or disallowed tools. Require a distinct second approval bound to the same input/session/worktree, unchanged pre-proposal snapshot, exact `math.mjs` preimage and exact replacement bytes for `return a - b;` → `return a + b;`. Reject any other patch before applying. Verify the Node test changed from failure to success, only `math.mjs` changed, retained artifact and diff digests match, known usage is within the CLI threshold, both approvals persisted as approved, source and sentinels are unchanged, and the result survives daemon restart.
2. **One cancellation turn**, only after code passes, same model with `maxBudgetUsd: 0.02` and unchanged `cancel-task.txt`. Poll the local daemon every 10 ms and send cancellation as soon as the exact running session is persisted. Accept only that session reaching `cancelled` with a retained process-exit event showing successful SIGTERM/SIGKILL delivery, no prior terminal answer, matching session and vanished owned PID, with identical state/result after restart and unchanged source/sentinels. A completed or uncertain turn is a failed/inconclusive cancellation row, never a pass. Do not retry. This establishes local child termination; it does not prove cancellation of remote provider computation.

The inherited CLI flags allow only `Read,Glob,Grep`, use `--restricted --safe-mode --strict-mcp-config --permission-mode dontAsk --permission-prompts none`, and pin a fresh session. Each observation stage has a 60-second deadline; failure requests cancellation of the owned active job, retains evidence and stops. A stage deadline is not a guaranteed upper bound on daemon shutdown when runtime termination is uncertain. No permission expansion or provider fallback is permitted.

Nominal per-invocation thresholds total **USD 0.07 of CLI cost-equivalent usage** through the existing Max login. No extra charge is inferred from these values. Optional account usage-credit settings and actual billing remain uninspected; the accounting clarification is in the roadmap. This plan authorizes at most two invocations only when specifically approved.

## What earns sign-off

The report's code/cancel `passed` result must be combined with the already retained direct CLI and durable reviewer passes in [the definitive matrix](CLAUDE_WORKER_DEFINITIVE_MATRIX.md). It records the code transcript path/digest and matched read metadata, exact approvals, snapshot/result and cancellation PID/signal/exit evidence. Review those records and retain exact job/attempt/session IDs and usage or unknown. Run full Node 24 and 26 typecheck, build and offline suites after the live result. Record the observed limits before marking Claude conformance complete. The report alone does not attest backend model identity or host containment.

Offline tests also require rejection of a different but syntactically valid replacement before apply, refusal to rerun existing state, actual exit of the signalled fixture child, and rejection of a turn that finishes before cancellation. A nested Node-test-runner environment initially caused the baseline child check to return success without executing the intended failing test; the offline scenario now runs in a normal subprocess with `NODE_TEST_CONTEXT` omitted. The deliberately failing baseline is asserted in both offline and live modes so this cannot produce a silent green result.

At preparation time, the direct-edit gate remained disabled, Phase 5 integration remained gated, and no new live Claude provider turn had been performed. The approved execution below records the subsequent result.

## Approved live execution — 27 September 2026

The owner explicitly approved this two-turn plan. On commit `d638919`, command `/opt/homebrew/opt/node@24/bin/node scripts/claude-signoff.mjs --approved-live` passed automatic approval review and exited **0** with `outcome: passed`. Preflight verified installed Claude **2.1.283**, Node **24.21.0**, exact fixture hashes and the existing first-party Max login. There were exactly two invocations, no retry or fallback.

| Evidence | Observed value |
| --- | --- |
| Code job / attempt | `26aa3412-04e8-4d50-93d3-c6d7a970dc23` / `16add14a-3d6e-457e-b8e9-7dcd0d665dc8` |
| Code session / model | `22b8a9fd-46d4-4d77-b826-7343101c6d01` / `claude-haiku-4-5-20251001` |
| Launch / apply approval | `0f06990e-5fc8-46c4-8922-abcb64c97e44` / `804aeb4f-155b-48bd-be89-87371704d2d2`, both persisted `approved` |
| Tool evidence | Matched successful `Glob` and `Read`; one successful read of owned `math.mjs`; no failed, unmatched or disallowed tools |
| Code result | `completed`, `acceptance: passed`; only `math.mjs` changed from subtraction to addition; baseline exit 1, post-apply Node check exit 0 (1/1) |
| Snapshot digest | `03ba5e34906f9832eb4ba67061837e4fda3ced93414323600d9829ce94dcd750` |
| Domain-separated diff digest | `bc9b1af8b886d0f16bb086b1776e80acd1b80a205a6859cd5be2563772e6e4af` |
| Snapshot artifact / raw diff SHA-256 | `a7706e6d96a36c1be027d8fbc738ff70a7fc5c64407921472644a8723e25420a` / `b4537e9fbc3926322fd6232b75556a6d679805bb7edb6c2814635ce18a469b51` |
| Code usage | 26 input / 532 output tokens; CLI cost-equivalent estimate **USD 0.0082507** |
| Cancel job / attempt | `3b89c0c5-bcfb-486b-8b50-45e8ae95abd8` / `de423f73-a4f2-445b-a8f8-0697d8895fd6` |
| Cancel session | `5c61b9ea-6f12-42b5-869d-ecd7ee0b3142`, exact same pinned model/version |
| Cancel process evidence | Owned PID `40547`, successful `SIGTERM` delivery, exit code **143**, `resultSeen: false`, `cancelRequested: true`, PID absent afterward |
| Cancel result | `cancelled`, result null, no terminal usage; tokens and cost **unknown**, not zero |

The code result and cancelled state/result remained identical after their daemon restarts. Both source snapshots, dirty tracked sentinels and untracked sentinels were preserved. Daemons were closed and the final socket was absent. The report's initial `code.state`, `cancel.state` and approval objects are submission/pre-decision snapshots; `code.result`, `code.approvals` and `cancel.status` contain the terminal evidence.

Private report: `/private/tmp/gattini-claude-live.BxPN3R/signoff-report.json`, SHA-256 `7e63d15b5b77eb53cf37d20d5126d60d0bd2640210979b3fe1a9cc96fe9ee1ed`. Owned code transcript SHA-256 `2eb85f29b952223a85157d1cffe1a055aa3645b7e122cb6ec8b6ab0bab255542`; its exact path is retained in the private report. Old evidence remains intact. Known estimates across prior turns plus this code turn sum to **USD 0.0393008**, with the cancellation estimate unavailable; this is not an actual bill or a complete usage total.

Combined with the earlier live direct probe and durable review, these results satisfy the declared Claude single-turn reviewer, guarded code and local cancellation boundary. Permission/error and uncertain-recovery cases also have offline conformance coverage. No claim is made for remote computation cancellation, host containment, backend identity attestation, automatic resumed sessions, reviewer follow-up, arbitrary models or direct edit. Post-live full-suite results are recorded in the roadmap. Phase 5 implementation was not started.
