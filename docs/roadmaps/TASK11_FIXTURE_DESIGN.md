# Task 11 fixture preparation

Status: read-only design prepared during Task 10; Task 11 was subsequently implemented and verified offline on 26 September 2026. The actual interface is recorded in [TASK11_INTERFACE.md](TASK11_INTERFACE.md), with commands and results in the roadmap.

The primary agent should freeze the follow-up and review contract before parallel implementation. Decide how a follow-up is represented in durable attempt history and how an independent reviewer consumes a pinned, retained snapshot. Current results expose one job-level result; existing review jobs use a configured directory. Preserve prior attempt evidence as separately addressable, immutable records.

| Requirement | Offline fixture and assertion | Likely ownership area |
| --- | --- | --- |
| Exact-session follow-up | Script a fake OpenCode runtime with a first exact session ID, then follow up on that job. Assert the adapter targets that ID and records the linked attempt. Return a different session ID and require typed rejection without recording follow-up output. | Adapter hook plus focused adapter tests; primary owns store/protocol. |
| Pinned-snapshot review | Complete a guarded code job and retain its snapshot and diff. Mutate the live worktree after pinning. Review must read the retained snapshot identity and bytes, never silently switch to the mutable worktree. | Snapshot/review service and tests, after the primary freezes its interface. |
| Wrong ID and concurrent routing | Interleave two fake sessions and jobs behind barriers. Reject a wrong job/session ID and show that each event, follow-up and result stays with its exact handle. | Durable daemon fixture, coordinated with the store writer. |
| Immutable prior evidence | Save prior result JSON, artifact bytes and digests; complete a later attempt; show the earlier evidence remains independently retrievable and unchanged. Tampering must still return `EVIDENCE_INVALID`. | Store migration and lifecycle tests, primary-owned. |
| Review write denial | Use the existing deny-all/read/glob/grep reviewer policy. Attempt a write in the fake runtime and verify denial, unchanged retained snapshot, and unchanged coding worktree. | Policy/adapter fixture. |
| Unsupported follow-up | Request follow-up from a runtime with no follow-up capability. Require a stable typed error and no new attempt, session or mutation. | Contract/protocol tests. |

Reuse a disposable Git repository with one tracked file and Task 9 style retained snapshot. A scripted fake OpenCode CLI can emit deterministic session IDs and interleaved events; no live provider is needed for these fixtures. Existing foundations include persisted exact session identity, mismatch rejection in adapter tests, read-only reviewer policy, and digest checking on result retrieval. Those foundations do not themselves prove Task 11.
