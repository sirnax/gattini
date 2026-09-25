# ADR 003: OpenCode V2 transport for the first worker

Status: accepted for the Task 3 spike, 24 September 2026. Revisit when Task 5 integrates durable jobs.

## Decision

Target installed OpenCode V2.0.16 first. Launch a named agent with an explicit model through `opencode run --agent ... --model ... --format json`, capture its session ID and NDJSON events, and use the session-specific V2 API for status and interruption. A user-owned OpenCode service is shared: Gattini may attach only by explicit configuration, and cancelling a job must never stop that service. Keep the loopback HTTP client in `src/adapters/opencode.ts` as a typed spike, not a claim that direct authenticated HTTP launch has passed a live conformance test.

The daemon should persist the exact session ID and requested/resolved agent and model before treating a job as running. An interrupt acknowledgement alone is insufficient; reconcile the session outcome and active status. Refuse operation when the runtime version or required permissions do not match the proven surface. The initial supported version range is exactly 2.0.16 until another version passes the same checks.

## Evidence

In a disposable Git repository, three bounded runs of temporary named agents using `openrouter/z-ai/glm-5.3-flash` produced stable session IDs and NDJSON events through the already-running service. The review streamed a completed `read` tool event and final text. The denial agent exposed only read tools and did not change the tracked sentinel despite an explicit edit request. During an active `sleep 37` shell tool, the exact-session interrupt returned `interrupted: true`; the session then reported outcome `interrupted`, no active session remained, the tool reported interruption, and no `sleep 37` process remained. Sanitised event projections are in `tests/fixtures/opencode-live-*.ndjson`; full cost and limitations are in the roadmap and compatibility report.

## Limits

The three runs used CLI launch plus session API operations. The HTTP client has offline contract tests, but its direct authenticated launch path has not been exercised against the shared service. The denial check proves tool exposure for the tested agent configuration, not host-level containment against arbitrary same-user processes or plugins. Cancellation was observed for one shell command; later versions and other tools need separate conformance checks. Provider costs reported by OpenCode are observations, not a hard spend limit.
