import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { verifySnapshot } from "../src/verification/snapshot.js";

const roots: string[] = [];

async function repository(): Promise<{ root: string; baseSha: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "gattini-snapshot-"));
  roots.push(root);
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "snapshot@example.invalid"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Snapshot Test"], { cwd: root });
  await writeFile(path.join(root, "tracked.txt"), "baseline\n");
  execFileSync("git", ["add", "tracked.txt"], { cwd: root });
  execFileSync("git", ["commit", "-qm", "baseline"], { cwd: root });
  return { root, baseSha: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim() };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

test("verifySnapshot reports a successful unchanged snapshot and untracked files", async () => {
  const { root, baseSha } = await repository();
  await writeFile(path.join(root, "new.txt"), "untracked evidence\n");
  const result = await verifySnapshot({
    worktreePath: root,
    baseSha,
    commands: [{ argv: [process.execPath, "-e", "process.stdout.write('ok')"], timeoutMs: 2_000 }],
  });

  assert.equal(result.acceptance, "passed");
  assert.deepEqual(result.changedFiles, ["new.txt"]);
  assert.equal(result.checks[0]?.stdout, "ok");
  assert.equal(result.checks[0]?.cwd, await realpath(root));
  assert.match(result.snapshotSha, /^[0-9a-f]{64}$/);
  assert.match(result.diffSha256, /^[0-9a-f]{64}$/);
});

test("verifySnapshot refuses acceptance when a verification command changes a file", async () => {
  const { root, baseSha } = await repository();
  const result = await verifySnapshot({
    worktreePath: root,
    baseSha,
    commands: [{ argv: [process.execPath, "-e", "require('node:fs').writeFileSync('tracked.txt', 'changed by check\\n')"], timeoutMs: 2_000 }],
  });

  assert.equal(result.acceptance, "failed");
  assert.equal(result.checks[0]?.exitCode, 0);
  assert.notEqual(result.snapshotSha, "");
});

test("verifySnapshot refuses acceptance when a check fails", async () => {
  const { root, baseSha } = await repository();
  const result = await verifySnapshot({
    worktreePath: root,
    baseSha,
    commands: [{ argv: [process.execPath, "-e", "process.exit(7)"], timeoutMs: 2_000 }],
  });

  assert.equal(result.acceptance, "failed");
  assert.equal(result.checks[0]?.exitCode, 7);
});

test("cancelling a running verification stops its process group and retains failed evidence", async () => {
  const { root, baseSha } = await repository();
  const controller = new AbortController();
  const running = verifySnapshot({ worktreePath: root, baseSha, signal: controller.signal,
    artifactDirectory: path.join(root, ".git", "gattini-test-artifact"),
    commands: [{ argv: [process.execPath, "-e", "require('fs').writeFileSync('.git/verification-started','1');setTimeout(()=>{},5000)"], timeoutMs: 6000 }] });
  const marker = path.join(root, ".git", "verification-started");
  const deadline = Date.now() + 3000;
  while (!existsSync(marker) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(existsSync(marker), true);
  controller.abort();
  const result = await running;
  assert.equal(result.acceptance, "failed");
  assert.equal(result.checks[0]?.timedOut, true);
  assert.ok(result.artifact?.sha256);
});

test("snapshot rejects permission-only changes to an untracked file", async () => {
  const { root, baseSha } = await repository();
  await writeFile(path.join(root, "new.txt"), "same bytes\n");
  await chmod(path.join(root, "new.txt"), 0o644);
  const result = await verifySnapshot({ worktreePath: root, baseSha,
    commands: [{ argv: [process.execPath, "-e", "require('node:fs').chmodSync('new.txt',0o755)"], timeoutMs: 2000 }] });
  assert.equal(result.acceptance, "failed");
});

for (const mechanism of ["textconv", "clean"] as const) {
  test(`snapshot inspection does not execute repository ${mechanism} commands`, async () => {
    const { root, baseSha } = await repository();
    const scratch = await mkdtemp(path.join(os.tmpdir(), "gattini-config-probe-"));
    roots.push(scratch);
    const marker = path.join(scratch, "executed");
    const script = path.join(scratch, "probe.cjs");
    await writeFile(script, `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(marker)},'executed');process.stdout.write(fs.readFileSync(${mechanism === "clean" ? "0" : "process.argv[2]"}));`);
    await writeFile(path.join(root, ".gitattributes"), `tracked.txt ${mechanism === "textconv" ? "diff" : "filter"}=probe\n`);
    const quote = (v: string) => `'${v.replace(/'/g, "'\\''")}'`;
    execFileSync("git", ["config", mechanism === "textconv" ? "diff.probe.textconv" : "filter.probe.clean", `${quote(process.execPath)} ${quote(script)}`], { cwd: root });
    await writeFile(path.join(root, "tracked.txt"), "candidate\n");
    const result = await verifySnapshot({ worktreePath: root, baseSha,
      commands: [{ argv: [process.execPath, "-e", "process.exit(0)"], timeoutMs: 2000 }] });
    assert.equal(existsSync(marker), false, `${mechanism} must not execute during evidence capture`);
    assert.equal(result.acceptance, "passed");
    assert.ok(result.changedFiles.includes("tracked.txt"));
  });
}

test("Git environment overrides cannot redirect evidence capture to another repository", async () => {
  const { root, baseSha } = await repository();
  await writeFile(path.join(root, "tracked.txt"), "candidate\n");
  const previous = process.env.GIT_DIR;
  process.env.GIT_DIR = path.join(root, "nonexistent-git-dir");
  try {
    const result = await verifySnapshot({ worktreePath: root, baseSha,
      commands: [{ argv: [process.execPath, "-e", "process.exit(0)"], timeoutMs: 2000 }] });
    assert.equal(result.acceptance, "passed");
    assert.deepEqual(result.changedFiles, ["tracked.txt"]);
  } finally { if (previous === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = previous; }
});

test("later edits produce a different snapshot and diff instead of reusing earlier acceptance", async () => {
  const { root, baseSha } = await repository();
  const commands = [{ argv: [process.execPath, "-e", "process.exit(0)"], timeoutMs: 2000 }];
  await writeFile(path.join(root, "tracked.txt"), "first\n");
  const first = await verifySnapshot({ worktreePath: root, baseSha, commands });
  await writeFile(path.join(root, "tracked.txt"), "second\n");
  const second = await verifySnapshot({ worktreePath: root, baseSha, commands });
  assert.equal(first.acceptance, "passed");
  assert.equal(second.acceptance, "passed");
  assert.notEqual(first.snapshotSha, second.snapshotSha);
  assert.notEqual(first.diffSha256, second.diffSha256);
});
