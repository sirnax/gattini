import assert from "node:assert/strict";
import test from "node:test";
import { runFakeTask } from "../src/adapters/fake.js";
import {
  ContractError,
  parseJob,
  parseRuntimeConfig,
  parseRuntimeEvent,
  parseRuntimeResult,
  type Job,
  type RuntimeConfig,
} from "../src/core/contracts.js";

const job: Job = {
  schemaVersion: 1,
  id: "job_example",
  parentWorkflowId: null,
  role: "reviewer",
  task: "Review a mock task without provider access.",
  acceptanceCriteria: ["Produce a structured result"],
  capabilities: ["headless", "structured-output"],
  inputReferences: [],
  repository: { path: "/tmp/Gattini example repo", baseSha: null },
  allowedScope: ["/tmp/Gattini example repo"],
  verificationCommands: [],
  limits: { timeoutSeconds: 30, maxEvents: 10 },
  approvalPolicy: "none",
};

const config: RuntimeConfig = {
  runtime: "fake",
  agent: "mock-reviewer",
  model: null,
  credential: { kind: "env", name: "FAKE_PROVIDER_TOKEN" },
  options: { deterministic: true },
};

test("fake task emits schema-checked events and keeps acceptance unverified", () => {
  const run = runFakeTask(job, config);
  assert.deepEqual(run.events.map((event) => event.sequence), [1, 2, 3]);
  assert.deepEqual(run.events.map((event) => event.type), ["started", "progress", "completed"]);
  assert.equal(run.result.jobId, job.id);
  assert.equal(run.result.execution, "completed");
  assert.equal(run.result.acceptance, "unverified");
  assert.deepEqual(run.result.changedFiles, []);
  assert.deepEqual(run.result.verification, []);
  assert.equal(parseJob(job).repository?.path, "/tmp/Gattini example repo");
  run.events.forEach((event) => assert.deepEqual(parseRuntimeEvent(event), event));
  assert.deepEqual(parseRuntimeResult(run.result), run.result);
});

test("fake task respects its bounded event limit", () => {
  const bounded = { ...job, limits: { ...job.limits, maxEvents: 2 } };
  assert.deepEqual(runFakeTask(bounded, config).events.map((event) => event.sequence), [1, 2]);
});

test("job schema rejects unknown fields, invalid paths, and unsupported capabilities", () => {
  assert.throws(() => parseJob({ ...job, extra: true }), ContractError);
  assert.throws(() => parseJob({ ...job, repository: { path: "", baseSha: null } }), ContractError);
  assert.throws(() => parseJob({ ...job, capabilities: ["telepathy"] }), ContractError);
  assert.throws(() => parseJob({ ...job, schemaVersion: 2 }), ContractError);
});

test("runtime configuration requires references and rejects unknown fields or secret literals", () => {
  assert.deepEqual(parseRuntimeConfig(config), config);
  assert.throws(() => parseRuntimeConfig({ ...config, surprise: "field" }), ContractError);
  assert.throws(() => parseRuntimeConfig({ ...config, credential: "sk-example1234567890123" }), ContractError);
  assert.throws(() => parseRuntimeConfig({ ...config, credential: { kind: "env", name: "sk-example1234567890123" } }), ContractError);
  assert.throws(() => parseRuntimeConfig({ ...config, credential: { kind: "env", name: "NOT AN ENV VAR" } }), ContractError);
  assert.throws(() => parseRuntimeConfig({ ...config, options: { apiKey: "Bearer abcdefghijklmnop" } }), ContractError);
});

test("event and result parsers reject malformed provider output", () => {
  const { events, result } = runFakeTask(job, config);
  assert.throws(() => parseRuntimeEvent({ ...events[0], sequence: 0 }), ContractError);
  assert.throws(() => parseRuntimeEvent({ ...events[0], payload: { message: "ok", extra: true } }), ContractError);
  assert.throws(() => parseRuntimeResult({ ...result, acceptance: "passed", unexpected: true }), ContractError);
  assert.throws(() => parseRuntimeResult({ ...result, verification: [{ command: "check", exitCode: -1 }] }), ContractError);
});
