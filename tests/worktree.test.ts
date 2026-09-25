import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync, existsSync, rmSync, realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { WorktreeError, WorktreeManager, newWorktreeJobId, resolveWorktreePath } from "../src/environments/worktree.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function fixture(t: { after: (fn: () => void) => void }) {
  const root = mkdtempSync(join(tmpdir(), "gattini worktree "));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, "source repo");
  const state = join(root, "private state");
  mkdirSync(repo);
  mkdirSync(state, { mode: 0o700 });
  git(repo, "init", "-b", "main");
  git(repo, "config", "user.name", "Gattini Test");
  git(repo, "config", "user.email", "gattini@example.invalid");
  writeFileSync(join(repo, "tracked file.txt"), "base\n");
  git(repo, "add", "tracked file.txt");
  git(repo, "commit", "-m", "base");
  return { root, repo, state, baseSha: git(repo, "rev-parse", "HEAD") };
}

test("owned worktree pins an explicit base while dirty and untracked user files remain untouched", t => {
  const f = fixture(t);
  writeFileSync(join(f.repo, "tracked file.txt"), "new head\n");
  git(f.repo, "add", "tracked file.txt");
  git(f.repo, "commit", "-m", "later head");
  writeFileSync(join(f.repo, "tracked file.txt"), "dirty\n");
  writeFileSync(join(f.repo, "untracked file.txt"), "private\n");
  const before = git(f.repo, "status", "--porcelain=v1");
  const manager = new WorktreeManager(f.state);
  const jobId = newWorktreeJobId();
  const oldGitDir = process.env.GIT_DIR;
  process.env.GIT_DIR = join(f.root, "wrong git dir");
  let prepared: ReturnType<WorktreeManager["prepare"]>;
  try { prepared = manager.prepare({ jobId, repositoryPath: f.repo, baseSha: f.baseSha }); }
  finally {
    if (oldGitDir === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = oldGitDir;
  }
  assert.equal(prepared.state, "ready");
  assert.equal(prepared.baseSha, f.baseSha);
  assert.equal(prepared.branch, `codex/gattini-${jobId}`);
  assert.equal(git(prepared.worktreePath, "rev-parse", "HEAD"), f.baseSha);
  assert.equal(readFileSync(join(prepared.worktreePath, "tracked file.txt"), "utf8"), "base\n");
  assert.equal(existsSync(join(prepared.worktreePath, "untracked file.txt")), false);
  assert.equal(readFileSync(join(f.repo, "tracked file.txt"), "utf8"), "dirty\n");
  assert.equal(readFileSync(join(f.repo, "untracked file.txt"), "utf8"), "private\n");
  assert.equal(git(f.repo, "status", "--porcelain=v1"), before);
  manager.close();
  const reopened = new WorktreeManager(f.state);
  t.after(() => reopened.close());
  assert.deepEqual(reopened.get(jobId), prepared);
  assert.equal(statSync(join(f.state, "worktrees.sqlite")).mode & 0o777, 0o600);
});

test("invalid repository, missing or abbreviated base, and symlink escape are rejected", t => {
  const f = fixture(t);
  const manager = new WorktreeManager(f.state);
  t.after(() => manager.close());
  assert.throws(() => manager.prepare({ jobId: newWorktreeJobId(), repositoryPath: join(f.repo, "missing"), baseSha: f.baseSha }), WorktreeError);
  assert.throws(() => manager.prepare({ jobId: newWorktreeJobId(), repositoryPath: f.root, baseSha: f.baseSha }), WorktreeError);
  assert.throws(() => manager.prepare({ jobId: newWorktreeJobId(), repositoryPath: f.repo, baseSha: f.baseSha.slice(0, 8) }), WorktreeError);
  assert.throws(() => manager.prepare({ jobId: newWorktreeJobId(), repositoryPath: f.repo, baseSha: "f".repeat(40) }), WorktreeError);
  const prepared = manager.prepare({ jobId: newWorktreeJobId(), repositoryPath: f.repo, baseSha: f.baseSha });
  symlinkSync(f.root, join(prepared.worktreePath, "outside"));
  assert.equal(resolveWorktreePath(prepared.worktreePath, "tracked file.txt"), join(prepared.worktreePath, "tracked file.txt"));
  assert.throws(() => resolveWorktreePath(prepared.worktreePath, "../outside"), WorktreeError);
  assert.throws(() => resolveWorktreePath(prepared.worktreePath, "outside/new.txt"), WorktreeError);
  assert.throws(() => resolveWorktreePath(prepared.worktreePath, "outside"), WorktreeError);
  symlinkSync(join(f.root, "missing"), join(prepared.worktreePath, "broken"));
  assert.throws(() => resolveWorktreePath(prepared.worktreePath, "broken/new.txt"), WorktreeError);
});

test("failed Git creation remains recorded and does not remove an unrelated branch", t => {
  const f = fixture(t);
  const manager = new WorktreeManager(f.state);
  t.after(() => manager.close());
  const jobId = newWorktreeJobId();
  const branch = `codex/gattini-${jobId}`;
  git(f.repo, "branch", branch, f.baseSha);
  assert.throws(() => manager.prepare({ jobId, repositoryPath: f.repo, baseSha: f.baseSha }), WorktreeError);
  assert.equal(manager.get(jobId)?.state, "failed");
  assert.equal(git(f.repo, "rev-parse", branch), f.baseSha);
  assert.equal(existsSync(join(f.state, "worktrees", jobId)), false);
});

test("two managers cannot prepare competing writers for the same canonical repository", t => {
  const f = fixture(t);
  const a = new WorktreeManager(f.state);
  const b = new WorktreeManager(f.state);
  t.after(() => { a.close(); b.close(); });
  const alias = join(f.root, "repo alias");
  symlinkSync(f.repo, alias);
  const first = a.prepare({ jobId: newWorktreeJobId(), repositoryPath: alias, baseSha: f.baseSha });
  assert.equal(first.repositoryPath, realpathSync(f.repo));
  const secondJobId = newWorktreeJobId();
  assert.throws(() => b.prepare({ jobId: secondJobId, repositoryPath: f.repo, baseSha: f.baseSha }), WorktreeError);
  assert.equal(b.get(secondJobId), null);
  assert.equal(git(f.repo, "worktree", "list", "--porcelain").match(/^worktree /gm)?.length, 2);
});
