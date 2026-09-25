# ADR 001: Runtime boundary for the first adapter

Status: provisional, pending the Task 3 live OpenCode spike  
Date: 2026-09-24

## Context

Gattini needs durable job identity, resumable events, exact agent and model selection, permission enforcement, and cancellation. A caller's process lifetime cannot be the sole record of a job. The initial worker runtime is OpenCode; Codex and Claude Code are callers through Gattini's future CLI until separate worker adapters are proven.

## Decision

Keep the Gattini job store and scheduler independent of the worker runtime. Define an adapter around capability discovery, explicit start, status and reconciliation, events, exact-session follow-up, cancellation confirmation, and structured result collection. Persist the requested and resolved runtime, agent, model, and session handle before treating a launch as owned. Reject a job when its required capability cannot be enforced.

Investigate OpenCode's documented noninteractive CLI against a controlled local service first. The CLI and service API are candidates, not selected transports. Task 3 must establish which interface exposes stable session identity, permission behavior, and confirmed cancellation on the installed version. Do not infer those guarantees from `--help` output alone. A private owned service and an explicitly attached user service need different lifecycle rules; cancelling one job must never stop a shared service.

## Consequences

- The fake adapter in Task 2 can establish Gattini contracts without claiming production runtime neutrality.
- OpenCode transport choice, supported version range, and actual safeguards remain pending live evidence at Checkpoint 1.
- Unsupported safeguards are represented as unavailable capabilities and block affected jobs.
- Global runtime agent definitions and provider credentials stay with the runtime; Gattini records names and references, not copied secrets.

## Evidence and follow-up

See [compatibility inventory](../compatibility.md) for Task 1's read-only discovery. Update this ADR after Task 3's approved probes and record the selected transport and tested version range.
