# Task 12 interface freeze — 26 September 2026

Task 11 passed the full 107-test offline suite on Node 24 and 26. The coordinator owns scheduler admission, store/protocol changes, and final verification. Task 12 introduces default capacity of one read-only OpenCode reviewer and one guarded code job. An approval-waiting job consumes no runtime slot. A claimed job holds its class slot until its exact runtime termination is known; uncertain jobs retain their scope lock and are not automatically replayed.

The result may include `usage` with explicit runtime/session provenance and nullable `costUsd`, `inputTokens`, and `outputTokens`. Missing measures stay `null`, including cost. An OpenCode `step_finish` event may contribute observed values only when finite and nonnegative. Aggregation across attempts is not invented from missing data.

The default retry budget is one retry for a proven transient, read-only prelaunch failure. Any claimed runtime attempt, code proposal/apply, check execution, or ambiguous failure is never automatically retried. Exhaustion produces a typed escalation status. The retry must keep each prior attempt result or failure record addressable by attempt ID. The scheduler deadline is bounded and distinguishes a request to stop from confirmed exact-session termination.

Cleanup is a preview-only command in this task. It reads Gattini ownership records and observed Git state, returns exact owned paths/branches with eligibility and retention reasons, and makes no filesystem or Git mutation. Unmerged or uncertain work is retained. Actual deletion remains outside this task and requires a separate explicit confirmation and revalidation.
