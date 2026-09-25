import test from "node:test";
import assert from "node:assert/strict";
import { parseRoleConfig, RoleConfigError, type RoleConfig } from "../src/core/role-config.js";

const valid: RoleConfig = {
  schemaVersion: 1,
  roles: {
    reviewer: {
      runtime: "opencode",
      agent: "reviewer",
      model: "openrouter/z-ai/glm-5.3-flash",
      directory: "/tmp/review repo",
      serverUrl: "http://127.0.0.1:4096",
      permissions: [
        { action: "*", resource: "*", effect: "deny" },
        { action: "read", resource: "*", effect: "allow" },
        { action: "glob", resource: "*", effect: "allow" },
        { action: "grep", resource: "*", effect: "allow" },
      ],
    },
  },
};

test("parses an explicit OpenCode reviewer role without changing its exact IDs", () => {
  assert.deepEqual(parseRoleConfig(valid), valid);
  assert.equal(parseRoleConfig(valid).roles.reviewer.model, "openrouter/z-ai/glm-5.3-flash");
});

test("rejects unknown or missing fields at each configuration level", () => {
  const extra = structuredClone(valid) as unknown as Record<string, unknown>;
  extra.fallback = "other-model";
  assert.throws(() => parseRoleConfig(extra), RoleConfigError);
  const extraRole = structuredClone(valid);
  (extraRole.roles as Record<string, unknown>).writer = {};
  assert.throws(() => parseRoleConfig(extraRole), /unknown field writer/);
  const missing = structuredClone(valid) as unknown as { roles: { reviewer: Record<string, unknown> } };
  delete missing.roles.reviewer.model;
  assert.throws(() => parseRoleConfig(missing), /missing model/);
});

test("requires an absolute directory and explicit HTTP loopback URL", () => {
  for (const serverUrl of ["https://localhost:4096", "http://example.com", "http://127.0.0.1:4096/path", "http://user:pass@localhost:4096", "http://localhost:4096?x=1"]) {
    const candidate = structuredClone(valid);
    candidate.roles.reviewer.serverUrl = serverUrl;
    assert.throws(() => parseRoleConfig(candidate), RoleConfigError, serverUrl);
  }
  const candidate = structuredClone(valid);
  candidate.roles.reviewer.directory = "relative/path";
  assert.throws(() => parseRoleConfig(candidate), /absolute POSIX path/);
});

test("requires deny-all first and only the three ordered read-only tool allows", () => {
  for (const permissions of [
    valid.roles.reviewer.permissions.slice(1),
    [...valid.roles.reviewer.permissions].reverse(),
    [...valid.roles.reviewer.permissions, { action: "edit", resource: "*", effect: "allow" as const }],
    [valid.roles.reviewer.permissions[0]!, ...valid.roles.reviewer.permissions.slice(1).map((rule) => ({ ...rule, resource: "src/**" }))],
  ]) {
    const candidate = structuredClone(valid);
    candidate.roles.reviewer.permissions = permissions;
    assert.throws(() => parseRoleConfig(candidate), RoleConfigError);
  }
});

test("rejects unsupported runtime, empty IDs, unsupported schema, and credential literals", () => {
  const badRuntime = structuredClone(valid);
  (badRuntime.roles.reviewer as { runtime: string }).runtime = "other";
  assert.throws(() => parseRoleConfig(badRuntime), /runtime must be opencode/);
  const badModel = structuredClone(valid);
  badModel.roles.reviewer.model = " ";
  assert.throws(() => parseRoleConfig(badModel), /model must be a non-empty/);
  const badVersion = structuredClone(valid);
  (badVersion as { schemaVersion: number }).schemaVersion = 2;
  assert.throws(() => parseRoleConfig(badVersion), /Unsupported role config schemaVersion/);
  const secret = structuredClone(valid);
  secret.roles.reviewer.serverUrl = "http://localhost:4096?token=abcdefghijklmno";
  assert.throws(() => parseRoleConfig(secret), RoleConfigError);
});
