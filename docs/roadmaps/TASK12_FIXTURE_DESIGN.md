# Task 12 offline fixture design

Status: fixture preparation written before Task 12 integration. Task 11 was verified first, and Task 12's implemented offline evidence is now recorded in the roadmap. This document remains the fixture design, not the acceptance record.

## Contract to preserve

The master plan sets one write worker and one read-only worker maximum, one configured retry only for transient failure, escalation after that retry, and no automatic retry of potentially side-effecting work. Unknown cost remains unknown. Cleanup starts with a dry run, selects only recorded Gattini-owned resources, retains artefacts on failure, and requires explicit confirmation before removing unmerged work. Approval-waiting jobs must not occupy a runtime slot or launch a worker.

Task 11 changed attempt history and review inputs. The primary verified its exact attempt identity, pinned snapshot reference, and immutable prior evidence contracts before Task 12 integration. Any shared schema, protocol, scheduler, or store change has one primary owner.

## Offline fixture matrix

| Case | Deterministic setup | Required assertions | Likely seam |
| --- | --- | --- | --- |
| Queue saturation | Start a daemon with a fake runtime that blocks each claimed attempt on a test-controlled barrier. Submit more eligible read jobs than the configured read limit and, separately, more write jobs than the write limit. | At most one read-only and one write attempt are active (per the default limits); excess jobs remain durably queued; releasing one barrier admits exactly one eligible queued job; no duplicate claim occurs across concurrent submissions or daemon restart. Verify role classes have independent limits. | Scheduler admission/claim boundary plus durable store claim; fake adapter barrier. |
| Runtime timeout | Fake adapter signals that its session is active, then withholds completion beyond the configured job deadline. Use a deterministic clock/timer seam or a short bounded test deadline. | The attempt reaches a timeout outcome, cancellation is directed to its exact session, the slot is not released until terminal/cancellation reconciliation is known, and late events cannot turn timed-out evidence into success. Unknown cancellation remains interrupted/uncertain and blocks unsafe replay. | Scheduler deadline, adapter cancellation hook, persisted attempt/session state. |
| Exhausted retry | Configure exactly one retry; scripted fake outcomes return transient failure twice. Also provide a non-transient or side-effecting failure case. | Initial attempt plus at most one retry are recorded with distinct immutable attempt IDs; the next failure enters an explicit escalation state/result with a typed reason; side-effecting work is never automatically retried; the original attempt evidence remains retrievable unchanged. | Retry classifier/policy and Task 11 attempt history; injected deterministic backoff/clock. |
| Missing usage | Fake adapter returns a valid successful result with no usage fields; another result reports partial usage without cost. | Missing cost is represented as unknown/absent with provenance, never `0`; partial measures retain which fields were reported and by which runtime/session; aggregation does not invent a total. Job completion and verification remain independent of usage availability. | Adapter result normalization and persisted usage provenance. |
| Blocked approval | Submit an approval-required read or code job and leave its exact approval pending while other eligible jobs run. Then deny it and, in a separate fixture, allow it to expire. | No runtime attempt/session is created while blocked; it consumes no worker slot; unrelated jobs continue within limits; denial/expiry launches no worker and leaves a durable typed terminal state. For code jobs, the recorded owned worktree remains retained and cleanup preview identifies its ownership and unmerged status. | Existing approval state machine plus scheduler eligibility query. Avoid sleeping 15 minutes; use an injected clock or store-level expiry seam. |
| Cleanup ownership and dry run | Build a disposable repository and private Gattini state containing: a completed owned worktree with no changes, a failed/preparation-incomplete owned record, an unmerged owned worktree with a change, a pending-approval worktree, and an unowned sibling directory/branch with similar names. Request cleanup preview only. | Preview lists only paths/branches whose ownership record matches the exact job and canonical resource identity, states why each is eligible or retained, flags unmerged changes for explicit confirmation, and never proposes deleting pending, uncertain, failed-partial, or unowned resources. Preview performs no filesystem/Git mutation. Recompute/revalidate ownership and cleanliness before any separately confirmed deletion. | Worktree ownership records, Git inspection, cleanup planner/pure selection function; destructive executor is outside this fixture. |

## Fixture construction guidance

- Use only local fake adapters and disposable repositories; no provider, runtime service, install, or external destination is needed.
- Prefer barriers and injected clocks to timing races and long waits. Assert persisted state after reopening the store/daemon where the case concerns durability.
- Record active-attempt counts at the adapter launch boundary, not merely queued-job state. Test two concurrent submits to expose claim races.
- Keep timeout, retry, and approval outcomes distinct. A timeout with an uncertain runtime session is not evidence that the worker stopped; it must not enable overlapping writes.
- Treat usage as attributed data: runtime, attempt/session, reported fields, and source. Absence is meaningful and must survive serialization.
- Cleanup preparation must be a pure preview over ownership records plus observed Git state. The fixture should snapshot directory entries, branch refs, and worktree list before and after preview and prove equality.
- Never invoke cleanup's real deletion path in this preparation. Any later removal of unmerged work remains a separate explicit confirmation and must recheck the exact resource immediately before removal.

## Current implementation seams and limits

At the time of this design, the daemon scheduled review, proposal, and apply work with `queueMicrotask` and had no central capacity counter/queue. Task 12 subsequently added the scheduler, narrow prelaunch retry, bounded runtime timer, and usage provenance; the roadmap records the exact tested behavior and limits. The fake role continues to complete through the store path, while scripted OpenCode executables support deterministic adapter tests.

`WorktreeManager` persists job ID, canonical repository path, base SHA, branch, worktree path, and preparation state. Its documented behavior is to never remove branches or worktrees. It is a suitable ownership source for a future preview planner, but is not itself a cleanup implementation. Existing approval rows are durable, and expiry is evaluated from persisted timestamps; tests should not depend on wall-clock sleeps.

The Task 11 attempt/result interface became the fixture seam. This note alone does not complete Task 12 or Checkpoint 4; the roadmap holds acceptance evidence and Checkpoint 4 remains with the human.
