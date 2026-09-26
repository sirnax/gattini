import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import { runReview, runReviewFollowup, type OpenCodeCliEvent, type ReviewRole } from "../src/adapters/opencode-cli.js";
import { runProposal, type CodeCliEvent } from "../src/adapters/opencode-code.js";
import type { CodeRoleConfig } from "../src/core/coding.js";

const SESSION_ID = "ses_timeout123";
// The full suite launches many child processes concurrently; leave startup
// headroom so this checks a streaming timeout, not a delayed process launch.
const TIMEOUT_MS = 5_000;

function fakeOpenCode(): { directory: string; terminationMarker: string; restore(): void } {
  const directory = mkdtempSync(join(tmpdir(), "gattini-runtime-timeout-"));
  const bin = join(directory, "bin");
  const worktree = join(directory, "worktree");
  const terminationMarker = join(directory, "terminated");
  mkdirSync(bin);
  mkdirSync(worktree);
  const executable = join(bin, "opencode");
  writeFileSync(executable, `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "--version") process.stdout.write("opencode v2.0.18\\n");
else if (args[0] === "service") process.stdout.write("http://127.0.0.1:4096\\n");
else if (args[0] === "api") process.stdout.write('{"data":{}}\\n');
else if (args[0] === "debug") process.stdout.write(JSON.stringify([{ id: "reader", permissions: [
  { action: "*", resource: "*", effect: "deny" },
  { action: "read", resource: "*", effect: "allow" },
  { action: "glob", resource: "*", effect: "allow" },
  { action: "grep", resource: "*", effect: "allow" },
]}]) + "\\n");
else if (args[0] === "models") process.stdout.write("provider/model\\n");
else if (args[0] === "run") {
  process.on("SIGTERM", () => {
    fs.writeFileSync(process.env.FAKE_OPEN_CODE_TERMINATION_MARKER, "SIGTERM");
    process.exit(0);
  });
  process.stdout.write('{"type":"step_start","sessionID":"ses_timeout123"}\\n');
  process.stdout.write('{"type":"text","sessionID":"ses_timeout123","part":{"text":"Premature answer"}}\\n');
  setInterval(() => {}, 1000);
} else process.exitCode = 2;
`, { mode: 0o700 });
  chmodSync(executable, 0o700);
  const original = { path: process.env.PATH, marker: process.env.FAKE_OPEN_CODE_TERMINATION_MARKER };
  process.env.PATH = `${bin}${delimiter}${original.path ?? ""}`;
  process.env.FAKE_OPEN_CODE_TERMINATION_MARKER = terminationMarker;
  return { directory: realpathSync(worktree), terminationMarker, restore() {
    if (original.path === undefined) delete process.env.PATH;
    else process.env.PATH = original.path;
    if (original.marker === undefined) delete process.env.FAKE_OPEN_CODE_TERMINATION_MARKER;
    else process.env.FAKE_OPEN_CODE_TERMINATION_MARKER = original.marker;
    rmSync(directory, { recursive: true, force: true });
  } };
}

function reviewRole(directory: string): ReviewRole {
  return { runtime: "opencode", agent: "reader", model: "provider/model", directory,
    serverUrl: "http://127.0.0.1:4096", permissions: [] };
}

function codeRole(): CodeRoleConfig {
  return { runtime: "opencode", agent: "reader", model: "provider/model", serverUrl: "http://127.0.0.1:4096" };
}

test("review timeout terminates a streaming run without accepting its text", async () => {
  const fixture = fakeOpenCode();
  try {
    const events: OpenCodeCliEvent[] = [];
    await assert.rejects(runReview(reviewRole(fixture.directory), "Inspect", event => events.push(event), undefined, TIMEOUT_MS), /runtime timeout/);
    assert.deepEqual(events.map(event => event.type), ["step_start", "text"]);
    assert.equal(events[0]?.sessionID, SESSION_ID);
    assert.equal(readFileSync(fixture.terminationMarker, "utf8"), "SIGTERM");
  } finally { fixture.restore(); }
});

test("exact-session follow-up timeout terminates without accepting streamed text", async () => {
  const fixture = fakeOpenCode();
  try {
    const events: OpenCodeCliEvent[] = [];
    await assert.rejects(runReviewFollowup(reviewRole(fixture.directory), SESSION_ID, "Continue", event => events.push(event), undefined, TIMEOUT_MS), /runtime timeout/);
    assert.deepEqual(events.map(event => event.type), ["step_start", "text"]);
    assert.equal(readFileSync(fixture.terminationMarker, "utf8"), "SIGTERM");
  } finally { fixture.restore(); }
});

test("proposal timeout terminates a streaming run without accepting its text", async () => {
  const fixture = fakeOpenCode();
  try {
    const events: CodeCliEvent[] = [];
    await assert.rejects(runProposal(codeRole(), fixture.directory, "Make proposal", event => events.push(event), undefined, TIMEOUT_MS), /timed out/i);
    assert.deepEqual(events.map(event => event.type), ["step_start", "text"]);
    assert.equal(events[0]?.sessionID, SESSION_ID);
    assert.equal(existsSync(fixture.terminationMarker), true);
    assert.equal(readFileSync(fixture.terminationMarker, "utf8"), "SIGTERM");
  } finally { fixture.restore(); }
});
