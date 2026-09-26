import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import test from "node:test";
import { WorktreeManager } from "../src/environments/worktree.js";
import { applyValidatedPatch, validatePatch } from "../src/verification/validated-patch.js";
import { verifySnapshot } from "../src/verification/snapshot.js";

const sha = (value: string): string => createHash("sha256").update(value).digest("hex");
function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}
function fixture(t: { after: (fn: () => void) => void }) {
  const root = mkdtempSync(join(tmpdir(), "gattini-patch-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, "source");
  const state = join(root, "state");
  mkdirSync(source); mkdirSync(state, { mode: 0o700 });
  git(source, "init", "-b", "main");
  git(source, "config", "user.name", "Gattini Test");
  git(source, "config", "user.email", "gattini@example.invalid");
  writeFileSync(join(source, "README.md"), "base\n");
  git(source, "add", "README.md"); git(source, "commit", "-m", "base");
  const baseSha = git(source, "rev-parse", "HEAD");
  writeFileSync(join(source, "README.md"), "dirty source\n");
  writeFileSync(join(source, "untracked.txt"), "keep me\n");
  const manager = new WorktreeManager(state);
  t.after(() => manager.close());
  const owned = manager.prepare({ jobId: randomUUID(), repositoryPath: source, baseSha });
  return { root, source, state, jobId: owned.jobId, worktree: owned.worktreePath, baseSha };
}
function proposal(path = "README.md", before = "base\n", after = "changed\n"): string {
  return JSON.stringify({ path, beforeSha256: sha(before), afterBase64: Buffer.from(after).toString("base64") });
}

test("valid patch applies in owned worktree and verification binds to resulting snapshot", async t => {
  const f = fixture(t);
  const validated = validatePatch(proposal(), f.worktree, f.baseSha);
  assert.deepEqual(applyValidatedPatch(validated), { path: "README.md", sha256: sha("changed\n") });
  assert.equal(readFileSync(join(f.worktree, "README.md"), "utf8"), "changed\n");
  assert.equal(readFileSync(join(f.source, "README.md"), "utf8"), "dirty source\n");
  assert.equal(readFileSync(join(f.source, "untracked.txt"), "utf8"), "keep me\n");
  const pass = await verifySnapshot({ worktreePath: f.worktree, baseSha: f.baseSha,
    commands: [{ argv: [process.execPath, "-e", "if(require('fs').readFileSync('README.md','utf8')!=='changed\\n')process.exit(9)"], timeoutMs: 5000 }] });
  assert.equal(pass.acceptance, "passed");
  assert.deepEqual(pass.changedFiles, ["README.md"]);
  const fail = await verifySnapshot({ worktreePath: f.worktree, baseSha: f.baseSha,
    commands: [{ argv: [process.execPath, "-e", "console.log('worker claims success');process.exit(8)"], timeoutMs: 5000 }] });
  assert.equal(fail.acceptance, "failed");
  assert.equal(fail.snapshotSha, pass.snapshotSha);
  assert.equal(fail.diffSha256, pass.diffSha256);
});

test("malformed, absolute, traversal, nested, and symlink-changing proposals are rejected without mutation", t => {
  const f = fixture(t);
  const outside = join(f.root, "outside.txt");
  writeFileSync(outside, "outside\n");
  symlinkSync(outside, join(f.worktree, "link.txt"));
  mkdirSync(join(f.worktree, "parent"));
  symlinkSync(f.root, join(f.worktree, "parent-link"));
  for (const value of ["{", "[]", proposal(outside), proposal("../outside.txt"), proposal("parent-link/outside.txt"), proposal("parent/nested.txt"), proposal("link.txt")]) {
    assert.throws(() => validatePatch(value, f.worktree, f.baseSha));
  }
  assert.equal(readFileSync(outside, "utf8"), "outside\n");
  assert.equal(readFileSync(join(f.worktree, "README.md"), "utf8"), "base\n");
});

test("changed target between validation and apply fails without partial apply", t => {
  const f = fixture(t);
  const validated = validatePatch(proposal(), f.worktree, f.baseSha);
  writeFileSync(join(f.worktree, "README.md"), "intervening\n");
  assert.throws(() => applyValidatedPatch(validated), /changed between validation and apply/);
  assert.equal(readFileSync(join(f.worktree, "README.md"), "utf8"), "intervening\n");
  assert.equal(readFileSync(join(f.source, "README.md"), "utf8"), "dirty source\n");
  assert.equal(readdirSync(f.worktree).some(name => name.startsWith(".gattini-patch-")), false);
});

test("target replaced by symlink before apply cannot escape to outside file", t => {
  const f = fixture(t);
  const outside = join(f.root, "outside.txt");
  writeFileSync(outside, "outside\n");
  const validated = validatePatch(proposal(), f.worktree, f.baseSha);
  rmSync(join(f.worktree, "README.md"));
  symlinkSync(outside, join(f.worktree, "README.md"));
  assert.throws(() => applyValidatedPatch(validated), /changed between validation and apply/);
  assert.equal(readFileSync(outside, "utf8"), "outside\n");
});

test("offline CLI applies only through a ready ownership record and returns snapshot evidence", t => {
  const f = fixture(t);
  const proposalPath = join(f.root, "proposal.json");
  const checksPath = join(f.root, "checks.json");
  writeFileSync(proposalPath, proposal());
  writeFileSync(checksPath, JSON.stringify([{ argv: [process.execPath, "-e", "if(require('fs').readFileSync('README.md','utf8')!=='changed\\n')process.exit(1)"], timeoutMs: 5000 }]));
  const cli = fileURLToPath(new URL("../src/cli/gattini-apply-patch.js", import.meta.url));
  const output = execFileSync(process.execPath, [cli, f.state, f.jobId, proposalPath, checksPath], { encoding: "utf8" });
  const result = JSON.parse(output) as { applied: { sha256: string }; evidence: { acceptance: string } };
  assert.equal(result.applied.sha256, sha("changed\n"));
  assert.equal(result.evidence.acceptance, "passed");
  assert.equal(readFileSync(join(f.source, "README.md"), "utf8"), "dirty source\n");
});

test("Git pathspec syntax cannot make an untracked patch target look tracked", t => {
  const f = fixture(t);
  const name = ":(glob)README*";
  writeFileSync(join(f.worktree, name), "base\n");
  assert.throws(() => validatePatch(proposal(name), f.worktree, f.baseSha), /tracked/);
  assert.equal(readFileSync(join(f.worktree, name), "utf8"), "base\n");
});

test("mutating exposed proposal bytes cannot change the validated replacement", t => {
  const f = fixture(t);
  const validated = validatePatch(proposal(), f.worktree, f.baseSha);
  validated.after.fill(0);
  applyValidatedPatch(validated);
  assert.equal(readFileSync(join(f.worktree, "README.md"), "utf8"), "changed\n");
});

test("fabricated validated handles cannot bypass the relative path boundary", t => {
  const f = fixture(t);
  const valid = validatePatch(proposal(), f.worktree, f.baseSha);
  // Copy the target identity as well, to exercise the exported apply boundary itself.
  const outside = join(f.state, "worktrees", "outside.txt");
  writeFileSync(outside, "base\n");
  const info = statSync(outside);
  assert.throws(() => applyValidatedPatch({ ...valid, path: "../outside.txt", targetDevice: info.dev,
    targetInode: info.ino, targetMtimeMs: info.mtimeMs, targetCtimeMs: info.ctimeMs }));
  assert.equal(readFileSync(outside, "utf8"), "base\n");
});

test("atomic patch replacement preserves permissions under a restrictive umask", t => {
  const f = fixture(t);
  const beforeMode = statSync(join(f.worktree, "README.md")).mode & 0o777;
  const validated = validatePatch(proposal(), f.worktree, f.baseSha);
  const previous = process.umask(0o077);
  try { applyValidatedPatch(validated); } finally { process.umask(previous); }
  assert.equal(statSync(join(f.worktree, "README.md")).mode & 0o777, beforeMode);
});

test("hardlinked targets, malformed encodings, extra mode fields and replay are refused", t => {
  const f = fixture(t);
  const good = JSON.parse(proposal()) as Record<string, unknown>;
  for (const bad of [ { ...good, mode: "120000" }, { ...good, afterBase64: "not base64!" },
    { ...good, path: "a\\b" }, { ...good, path: ".git" }, { ...good, path: "a/../README.md" } ]) {
    assert.throws(() => validatePatch(JSON.stringify(bad), f.worktree, f.baseSha));
  }
  const linked = join(f.root, "hardlink.txt");
  linkSync(join(f.worktree, "README.md"), linked);
  assert.throws(() => validatePatch(proposal(), f.worktree, f.baseSha), /without links/);
  rmSync(linked);
  const validated = validatePatch(proposal(), f.worktree, f.baseSha);
  applyValidatedPatch(validated);
  assert.throws(() => applyValidatedPatch(validated));
  assert.equal(readFileSync(join(f.worktree, "README.md"), "utf8"), "changed\n");
});

test("patch preflight cannot execute a repository clean filter", t => {
  const f = fixture(t);
  const marker = join(f.root, "filter-ran");
  const script = join(f.root, "filter.cjs");
  writeFileSync(script, `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(marker)},'ran');process.stdout.write(fs.readFileSync(0));`);
  const quote = (v: string) => `'${v.replace(/'/g, "'\\''")}'`;
  git(f.worktree, "config", "filter.probe.clean", `${quote(process.execPath)} ${quote(script)}`);
  writeFileSync(join(f.worktree, ".gitattributes"), "README.md filter=probe\n");
  const validated = validatePatch(proposal(), f.worktree, f.baseSha);
  assert.equal(existsSync(marker), false);
  applyValidatedPatch(validated);
  assert.equal(existsSync(marker), false);
});

test("CLI rejects invalid checks before apply and preserves failed-check work for inspection", t => {
  const f = fixture(t);
  const proposalPath = join(f.root, "proposal.json");
  const checksPath = join(f.root, "checks.json");
  const cli = fileURLToPath(new URL("../src/cli/gattini-apply-patch.js", import.meta.url));
  const run = () => spawnSync(process.execPath, [cli, f.state, f.jobId, proposalPath, checksPath], { encoding: "utf8", timeout: 5000 });
  writeFileSync(proposalPath, proposal());
  writeFileSync(checksPath, "[]");
  assert.equal(run().status, 2);
  assert.equal(readFileSync(join(f.worktree, "README.md"), "utf8"), "base\n");
  writeFileSync(checksPath, JSON.stringify([{ argv: [process.execPath, "-e", "console.log('worker claims success');process.exit(7)"], timeoutMs: 1000 }]));
  const failed = run();
  assert.equal(failed.status, 1);
  const result = JSON.parse(failed.stdout) as { evidence: { acceptance: string; checks: Array<{ exitCode: number }> } };
  assert.equal(result.evidence.acceptance, "failed");
  assert.equal(result.evidence.checks[0]!.exitCode, 7);
  assert.equal(readFileSync(join(f.worktree, "README.md"), "utf8"), "changed\n");
  assert.equal(run().status, 2, "a fresh CLI process must not blindly replay an already applied patch");
  assert.equal(readFileSync(join(f.source, "README.md"), "utf8"), "dirty source\n");
  assert.equal(readFileSync(join(f.source, "untracked.txt"), "utf8"), "keep me\n");
});
