import assert from "node:assert/strict";
import test from "node:test";
import { parseClaudeRoleConfig } from "../src/core/claude-role-config.js";
import { parseWorkerReviewerConfig } from "../src/core/worker-role-config.js";
import { parseWorkerCodeRoleConfig } from "../src/core/code-policy.js";
import { parseRuntimeResult } from "../src/core/contracts.js";

const code = { runtime: "claude", model: "claude-haiku-4-5-20251001", executable: "claude", maxBudgetUsd: 0.02 };
const reviewer = { ...code, directory: "/private/tmp/claude-review" };

test("Claude private mappings require exact model, budget, path and known fields", () => {
  assert.deepEqual(parseWorkerCodeRoleConfig(code), code);
  assert.deepEqual(parseWorkerReviewerConfig({ schemaVersion: 1, roles: { reviewer } }), reviewer);
  for (const bad of [
    { ...code, model: "haiku" }, { ...code, maxBudgetUsd: 0 }, { ...code, maxBudgetUsd: 2 },
    { ...code, executable: "./claude" }, { ...code, extra: true },
  ]) assert.throws(() => parseWorkerCodeRoleConfig(bad));
  assert.throws(() => parseClaudeRoleConfig({ ...reviewer, directory: "./relative" }));
});

test("common result contract accepts nullable Claude usage", () => {
  const result = parseRuntimeResult({ schemaVersion: 1, jobId: "fixture", execution: "completed", acceptance: "unverified",
    summary: "reviewed", changedFiles: [], verification: [], limitations: [],
    usage: { runtime: "claude", sessionId: "00000000-0000-4000-8000-000000000001", costUsd: null, inputTokens: 10, outputTokens: null } });
  assert.equal(result.usage?.runtime, "claude");
});
