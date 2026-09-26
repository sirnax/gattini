import assert from "node:assert/strict";
import test from "node:test";
import { parseCodexRoleConfig } from "../src/core/codex-role-config.js";

const valid = { schemaVersion: 1, runtime: "codex", model: "gpt-6-luna", modelProvider: "openai",
  directory: "/private/tmp/review fixture", executable: "/opt/homebrew/bin/codex" };

test("Codex role requires exact model, provider, directory, and executable", () => {
  assert.deepEqual(parseCodexRoleConfig(valid), valid);
  for (const change of [
    { model: " " }, { modelProvider: "" }, { directory: "relative" }, { executable: "./codex" },
    { runtime: "opencode" }, { extra: true }, { model: "sk-abcdefghijklmnopqrstuvwxyz" },
  ]) assert.throws(() => parseCodexRoleConfig({ ...valid, ...change }));
  const missing = { ...valid } as Partial<typeof valid>;
  delete missing.model;
  assert.throws(() => parseCodexRoleConfig(missing));
});
