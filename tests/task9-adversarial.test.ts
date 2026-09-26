import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { verifySnapshot } from "../src/verification/snapshot.js";
import type { VerificationCommand } from "../src/core/coding.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function fixture(t: { after: (fn: () => void) => void }) {
  const root = mkdtempSync(join(tmpdir(), "gattini task9 "));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, "repo");
  mkdirSync(repo);
  git(repo, "init", "-b", "main");
  git(repo, "config", "user.name", "Gattini Test");
  git(repo, "config", "user.email", "gattini@example.invalid");
  writeFileSync(join(repo, "tracked.txt"), "base\n");
  git(repo, "add", "tracked.txt");
  git(repo, "commit", "-m", "base");
  const baseSha = git(repo, "rev-parse", "HEAD");
  writeFileSync(join(repo, "tracked.txt"), "candidate\n");
  return { repo, baseSha };
}

const node = process.execPath;
const command = (argv: string[], timeoutMs = 5_000): VerificationCommand => ({ argv, timeoutMs });

test("snapshot acceptance comes from a passing check, not a worker success claim", async t => {
  const f = fixture(t);
  const evidence = await verifySnapshot({
    worktreePath: f.repo,
    baseSha: f.baseSha,
    // Deliberately print a success claim while returning failure, as a worker may do.
    commands: [command([node, "-e", "console.log('worker says tests passed'); process.exit(7)"])],
  });
  assert.equal(evidence.checks[0]?.exitCode, 7);
  assert.equal(evidence.acceptance, "failed");
  assert.equal(readFileSync(join(f.repo, "tracked.txt"), "utf8"), "candidate\n");
});

test("passing and failing commands produce separate, structured verification evidence", async t => {
  const f = fixture(t);
  const pass = await verifySnapshot({ worktreePath: f.repo, baseSha: f.baseSha, commands: [command([node, "-e", "process.stdout.write('ok')"])] });
  assert.equal(pass.acceptance, "passed");
  assert.equal(pass.checks[0]?.cwd, await realpath(f.repo));
  assert.equal(pass.checks[0]?.exitCode, 0);

  const fail = await verifySnapshot({ worktreePath: f.repo, baseSha: f.baseSha, commands: [command([node, "-e", "process.stderr.write('bad'); process.exit(3)"]) ] });
  assert.equal(fail.acceptance, "failed");
  assert.equal(fail.checks[0]?.exitCode, 3);
  assert.equal(fail.checks[0]?.stderr, "bad");
});

test("timed out checks cannot be accepted", async t => {
  const f = fixture(t);
  const evidence = await verifySnapshot({
    worktreePath: f.repo,
    baseSha: f.baseSha,
    commands: [command([node, "-e", "setTimeout(() => {}, 30000)"], 100)],
  });
  assert.equal(evidence.acceptance, "failed");
  assert.equal(evidence.checks[0]?.timedOut, true);
  assert.notEqual(evidence.checks[0]?.exitCode, 0);
});

test("verification logs are bounded and report truncation", async t => {
  const f = fixture(t);
  const evidence = await verifySnapshot({
    worktreePath: f.repo,
    baseSha: f.baseSha,
    commands: [command([node, "-e", "process.stdout.write('x'.repeat(200000))"])],
  });
  const check = evidence.checks[0];
  assert.ok(check);
  assert.equal(check.truncated, true);
  assert.ok(check.stdout.length < 200_000);
  assert.equal(evidence.acceptance, "passed");
});

test("a check that changes the tested tree invalidates snapshot acceptance", async t => {
  const f = fixture(t);
  const evidence = await verifySnapshot({
    worktreePath: f.repo,
    baseSha: f.baseSha,
    commands: [command([node, "-e", "const fs=require('node:fs'); fs.writeFileSync('tracked.txt', 'changed after test\\n')"])],
  });
  assert.notEqual(evidence.acceptance, "passed");
  assert.equal(readFileSync(join(f.repo, "tracked.txt"), "utf8"), "changed after test\n");
  assert.ok(evidence.limitations.some(item => /worktree changed during verification/i.test(item)));
});
