import assert from "node:assert/strict";
import test from "node:test";
import { parseWorkerReviewerConfig } from "../src/core/worker-role-config.js";

const opencode = { schemaVersion: 1, roles: { reviewer: { runtime: "opencode", agent: "reader", model: "provider/model",
  directory: "/private/tmp/review", serverUrl: "http://127.0.0.1:4096", permissions: [
    { action: "*", resource: "*", effect: "deny" }, { action: "read", resource: "*", effect: "allow" },
    { action: "glob", resource: "*", effect: "allow" }, { action: "grep", resource: "*", effect: "allow" },
  ] } } };
const codex = { schemaVersion: 1, roles: { reviewer: { runtime: "codex", model: "gpt-6-luna",
  modelProvider: "openai", directory: "/private/tmp/review", executable: "codex" } } };

test("same reviewer role maps to either strict private runtime configuration", () => {
  assert.equal(parseWorkerReviewerConfig(opencode).runtime, "opencode");
  assert.deepEqual(parseWorkerReviewerConfig(codex), { schemaVersion: 1, ...codex.roles.reviewer });
  assert.throws(() => parseWorkerReviewerConfig({ ...codex, roles: { reviewer: { ...codex.roles.reviewer, executable: "./codex" } } }));
  assert.throws(() => parseWorkerReviewerConfig({ ...codex, roles: { ...codex.roles, writer: {} } }));
  assert.throws(() => parseWorkerReviewerConfig({ ...codex, roles: { reviewer: { ...codex.roles.reviewer, runtime: "other" } } }));
});
