import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { previewOwnedCleanup } from "../src/environments/cleanup-preview.js";
import { WorktreeManager, newWorktreeJobId } from "../src/environments/worktree.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function fixture(t: { after: (fn: () => void) => void }) {
  const root = mkdtempSync(join(tmpdir(), "gattini cleanup preview "));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, "repo");
  const state = join(root, "private state");
  mkdirSync(repo);
  mkdirSync(state, { mode: 0o700 });
  git(repo, "init", "-b", "main");
  git(repo, "config", "user.name", "Gattini Test");
  git(repo, "config", "user.email", "gattini@example.invalid");
  writeFileSync(join(repo, "tracked.txt"), "base\n");
  git(repo, "add", "tracked.txt");
  git(repo, "commit", "-m", "base");
  const manager = new WorktreeManager(state);
  t.after(() => manager.close());
  return { root, repo, state, manager, baseSha: git(repo, "rev-parse", "HEAD") };
}

function snapshot(f: ReturnType<typeof fixture>, path: string) {
  return {
    repoStatus: git(f.repo, "--no-optional-locks", "status", "--porcelain=v1"),
    treeStatus: git(path, "--no-optional-locks", "status", "--porcelain=v1"),
    branches: git(f.repo, "for-each-ref", "--format=%(refname) %(objectname)", "refs/heads"),
    worktrees: git(f.repo, "worktree", "list", "--porcelain"),
    entries: readdirSync(join(f.state, "worktrees")).sort(),
    sourceIndexMtime: statSync(git(f.repo, "rev-parse", "--path-format=absolute", "--git-path", "index")).mtimeMs,
    ownedIndexMtime: statSync(git(path, "rev-parse", "--path-format=absolute", "--git-path", "index")).mtimeMs,
  };
}

test("clean completed record is eligible; similarly named unowned sibling is absent and preview has no mutation", t => {
  const f = fixture(t);
  const jobId = newWorktreeJobId();
  const owned = f.manager.prepare({ jobId, repositoryPath: f.repo, baseSha: f.baseSha });
  const sibling = join(f.root, "codex", `gattini-${newWorktreeJobId()}`);
  mkdirSync(join(f.root, "codex"));
  git(f.repo, "worktree", "add", "-b", `codex/gattini-${newWorktreeJobId()}`, sibling, f.baseSha);
  const before = snapshot(f, owned.worktreePath);
  const preview = previewOwnedCleanup(f.manager, id => id === jobId ? "completed" : null);
  assert.equal(preview.length, 1);
  assert.equal(preview[0]?.jobId, jobId);
  assert.equal(preview[0]?.eligible, true);
  assert.deepEqual(preview[0]?.reasons, []);
  assert.equal(preview.some(entry => entry.worktreePath === sibling), false);
  assert.deepEqual(snapshot(f, owned.worktreePath), before);
  assert.equal(existsSync(owned.worktreePath), true);
  assert.equal(existsSync(sibling), true);
});

test("dirty and unmerged owned work remains retained", t => {
  const f = fixture(t);
  const owned = f.manager.prepare({ jobId: newWorktreeJobId(), repositoryPath: f.repo, baseSha: f.baseSha });
  writeFileSync(join(owned.worktreePath, "tracked.txt"), "branch change\n");
  git(owned.worktreePath, "add", "tracked.txt");
  git(owned.worktreePath, "commit", "-m", "unmerged work");
  writeFileSync(join(owned.worktreePath, "untracked.txt"), "retain me\n");
  const before = snapshot(f, owned.worktreePath);
  const entry = previewOwnedCleanup(f.manager, () => "completed")[0]!;
  assert.equal(entry.eligible, false);
  assert.ok(entry.reasons.includes("dirty-worktree"));
  assert.ok(entry.reasons.includes("unmerged-branch"));
  assert.deepEqual(snapshot(f, owned.worktreePath), before);
  assert.equal(existsSync(join(owned.worktreePath, "untracked.txt")), true);
});

test("pending, failed preparation, and unknown jobs remain retained; absent ownership is rejected", t => {
  const f = fixture(t);
  const pending = f.manager.prepare({ jobId: newWorktreeJobId(), repositoryPath: f.repo, baseSha: f.baseSha });
  assert.deepEqual(previewOwnedCleanup(f.manager, () => "awaiting-approval")[0]?.reasons, ["job-not-completed"]);
  assert.deepEqual(previewOwnedCleanup(f.manager, () => null)[0]?.reasons, ["job-state-unknown"]);
  assert.equal(existsSync(pending.worktreePath), true);
  assert.throws(() => previewOwnedCleanup(f.manager, () => "completed", newWorktreeJobId()), /No ownership record/);

  const failedId = newWorktreeJobId();
  const branch = `codex/gattini-${failedId}`;
  git(f.repo, "branch", branch, f.baseSha);
  const db = new DatabaseSync(join(f.state, "worktrees.sqlite"));
  db.prepare("INSERT INTO worktrees (job_id,repository_path,base_sha,branch,worktree_path,state,error,created_at) VALUES (?,?,?,?,?,'failed',?,?)")
    .run(failedId, f.repo, f.baseSha, branch, join(f.state, "worktrees", failedId), "preparation failed", new Date().toISOString());
  db.close();
  const failed = previewOwnedCleanup(f.manager, () => "completed", failedId)[0]!;
  assert.equal(failed.eligible, false);
  assert.ok(failed.reasons.includes("record-not-ready"));
  assert.equal(git(f.repo, "rev-parse", branch), f.baseSha);
});

test("recorded path and branch aliases fail exact identity checks", t => {
  const f = fixture(t);
  const owned = f.manager.prepare({ jobId: newWorktreeJobId(), repositoryPath: f.repo, baseSha: f.baseSha });
  const db = new DatabaseSync(join(f.state, "worktrees.sqlite"));
  t.after(() => db.close());
  const alias = join(f.state, "worktrees", "alias");
  symlinkSync(owned.worktreePath, alias);
  db.prepare("UPDATE worktrees SET worktree_path = ? WHERE job_id = ?").run(alias, owned.jobId);
  const pathEntry = previewOwnedCleanup(f.manager, () => "completed")[0]!;
  assert.equal(pathEntry.eligible, false);
  assert.ok(pathEntry.reasons.includes("record-identity-mismatch"));
  db.prepare("UPDATE worktrees SET worktree_path = ?, branch = ? WHERE job_id = ?")
    .run(owned.worktreePath, "codex/gattini-impostor", owned.jobId);
  const branchEntry = previewOwnedCleanup(f.manager, () => "completed")[0]!;
  assert.equal(branchEntry.eligible, false);
  assert.ok(branchEntry.reasons.includes("record-identity-mismatch"));
  assert.equal(git(owned.worktreePath, "symbolic-ref", "HEAD"), `refs/heads/${owned.branch}`);
});
