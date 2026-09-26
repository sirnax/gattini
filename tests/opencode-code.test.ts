import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { preflightCode } from "../src/adapters/opencode-code.js";
import { parseCodeRoleConfig } from "../src/core/code-policy.js";

test("code role config accepts only exact fields and a plain loopback service", () => {
  const value = { runtime: "opencode", agent: "trusted-code", model: "provider/model-v1", serverUrl: "http://127.0.0.1:49374" };
  assert.deepEqual(parseCodeRoleConfig(value), value);
  assert.throws(() => parseCodeRoleConfig({ ...value, extra: true }), /unknown field/);
  assert.throws(() => parseCodeRoleConfig({ ...value, serverUrl: "https://127.0.0.1:49374" }), /loopback origin/);
  assert.throws(() => parseCodeRoleConfig({ ...value, model: "api_key=abcdefghijklm" }), /credential literals/);
});

test("code preflight refuses unverified path rules before invoking OpenCode", async () => {
  const directory = mkdtempSync(join(tmpdir(), "gattini-code-preflight-"));
  const bin = join(directory, "bin");
  const worktree = join(directory, "worktree");
  const marker = join(directory, "invoked");
  const oldPath = process.env.PATH;
  try {
    const { mkdirSync } = await import("node:fs");
    mkdirSync(bin);
    mkdirSync(worktree);
    const executable = join(bin, "opencode");
    writeFileSync(executable, `#!/bin/sh\nprintf invoked > '${marker}'\n`, { mode: 0o700 });
    chmodSync(executable, 0o700);
    process.env.PATH = bin;
    const role = parseCodeRoleConfig({ runtime: "opencode", agent: "trusted-code", model: "provider/model-v1", serverUrl: "http://127.0.0.1:49374" });
    await assert.rejects(preflightCode(role, realpathSync(worktree)), /symlink write outside the worktree/);
    assert.throws(() => readFileSync(marker), { code: "ENOENT" });
  } finally {
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    rmSync(directory, { recursive: true, force: true });
  }
});
