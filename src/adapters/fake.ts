import {
  parseJob,
  parseRuntimeConfig,
  parseRuntimeEvent,
  parseRuntimeResult,
  type Job,
  type RuntimeConfig,
  type RuntimeEvent,
  type RuntimeResult,
} from "../core/contracts.js";

export interface FakeRun {
  events: RuntimeEvent[];
  result: RuntimeResult;
}

/**
 * A deterministic, offline adapter for exercising the shared contract.
 * It deliberately has no process, network, filesystem, or provider client.
 */
export function runFakeTask(jobInput: Job | unknown, configInput: RuntimeConfig | unknown): FakeRun {
  const job = parseJob(jobInput);
  const config = parseRuntimeConfig(configInput);
  const at = "2026-01-01T00:00:00.000Z";
  const messages = [
    `Fake runtime ${config.runtime}/${config.agent} accepted job ${job.id}.`,
    "Mock task completed without contacting a provider.",
    "Fake runtime finished the mock task.",
  ] as const;
  const types = ["started", "progress", "completed"] as const;
  const events = messages.slice(0, job.limits.maxEvents).map((message, index) =>
    parseRuntimeEvent({
      schemaVersion: 1,
      jobId: job.id,
      sequence: index + 1,
      timestamp: at,
      type: types[index],
      payload: { message },
    }),
  );
  const result = parseRuntimeResult({
    schemaVersion: 1,
    jobId: job.id,
    execution: "completed",
    acceptance: "unverified",
    summary: "Deterministic fake execution completed; no real work or verification was performed.",
    changedFiles: [],
    verification: [],
    limitations: ["Fake adapter only; no provider access.", "Acceptance remains unverified."],
  });
  return { events, result };
}
