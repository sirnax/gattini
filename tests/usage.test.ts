import assert from "node:assert/strict";
import test from "node:test";
import { OpenCodeUsageAccumulator } from "../src/core/usage.js";

const sessionId = "ses_usage123";

test("usage reports observed totals with OpenCode session provenance", () => {
  const usage = new OpenCodeUsageAccumulator(sessionId);
  assert.equal(usage.add({
    type: "step_finish", sessionID: sessionId,
    part: { type: "step-finish", cost: 0.25, tokens: { input: 100, output: 20, reasoning: 5 } },
  }), true);
  assert.deepEqual(usage.snapshot(), {
    runtime: "opencode", sessionId, costUsd: 0.25, inputTokens: 100, outputTokens: 20,
  });
});

test("missing and invalid measures stay null rather than inventing totals", () => {
  const usage = new OpenCodeUsageAccumulator(sessionId);
  usage.add({ type: "step_finish", sessionID: sessionId, part: { cost: 0, tokens: { input: 4, output: "8" } } });
  usage.add({ type: "step_finish", sessionID: sessionId, part: { cost: -1, tokens: { input: 2, output: 3 } } });
  assert.deepEqual(usage.snapshot(), {
    runtime: "opencode", sessionId, costUsd: null, inputTokens: 6, outputTokens: null,
  });
});

test("wrong-session and non-finish events do not contribute", () => {
  const usage = new OpenCodeUsageAccumulator(sessionId);
  assert.equal(usage.add({ type: "step_finish", sessionID: "ses_other123", part: { cost: 2 } }), false);
  assert.equal(usage.add({ type: "text", sessionID: sessionId, part: { cost: 2 } }), false);
  assert.deepEqual(usage.snapshot(), {
    runtime: "opencode", sessionId, costUsd: null, inputTokens: null, outputTokens: null,
  });
});

test("duplicate event identities are counted once; unidentified events remain observable", () => {
  const usage = new OpenCodeUsageAccumulator(sessionId);
  const event = { type: "step_finish", sessionID: sessionId, id: "evt-1", part: { cost: 0.5, tokens: { input: 5, output: 2 } } };
  assert.equal(usage.add(event), true);
  assert.equal(usage.add({ ...event }), false);
  assert.equal(usage.add({ type: "step_finish", sessionID: sessionId, part: { cost: 0.25, tokens: { input: 1, output: 1 } } }), true);
  assert.deepEqual(usage.snapshot(), {
    runtime: "opencode", sessionId, costUsd: 0.75, inputTokens: 6, outputTokens: 3,
  });
});

test("constructor requires an explicit session ID", () => {
  assert.throws(() => new OpenCodeUsageAccumulator(""), /exact session ID/);
});
