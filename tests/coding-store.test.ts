import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { JobStore } from "../src/daemon/store.js";
import { WorktreeManager } from "../src/environments/worktree.js";
import type { CodeJobInput, CodeRoleConfig } from "../src/core/coding.js";
import { parseRuntimeResult } from "../src/core/contracts.js";
import { applyValidatedPatch, validatePatch } from "../src/verification/validated-patch.js";
import { verifySnapshot } from "../src/verification/snapshot.js";
import { snapshotFingerprint } from "../src/verification/snapshot.js";

function git(repo: string, ...args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

test("trusted code proposal binds launch, patch apply, and retained snapshot to two approvals", async t => {
  const root = mkdtempSync(join(tmpdir(), "gattini-code-store-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, "source repo");
  const state = join(root, "state");
  mkdirSync(repo);
  mkdirSync(state, { mode: 0o700 });
  git(repo, "init", "-b", "main");
  git(repo, "config", "user.name", "Gattini Test");
  git(repo, "config", "user.email", "gattini@example.invalid");
  writeFileSync(join(repo, "source.txt"), "base\n");
  git(repo, "add", "source.txt");
  git(repo, "commit", "-m", "base");
  const baseSha = git(repo, "rev-parse", "HEAD");
  writeFileSync(join(repo, "source.txt"), "dirty\n");
  writeFileSync(join(repo, "untracked.txt"), "private\n");
  const before = git(repo, "status", "--porcelain=v1");
  const worktrees = new WorktreeManager(state);
  const store = new JobStore(join(state, "jobs.sqlite"));
  t.after(() => { store.close(); worktrees.close(); });
  const input: CodeJobInput = { task: "Change source.txt", idempotencyKey: "code-store-1", repositoryPath: repo,
    baseSha, verificationCommands: [{ argv: ["node", "--version"], timeoutMs: 1000 }], trustedLocal: true };
  const config: CodeRoleConfig = { runtime: "opencode", agent: "bounded-code", model: "provider/model", serverUrl: "http://127.0.0.1:4096/" };
  const proposed = store.enqueueCode(input, config, worktrees);
  assert.equal(proposed.state, "awaiting-approval");
  assert.ok(proposed.approvalId && proposed.worktreePath);
  assert.equal(git(proposed.worktreePath, "rev-parse", "HEAD"), baseSha);
  assert.equal(readFileSync(join(proposed.worktreePath, "source.txt"), "utf8"), "base\n");
  assert.equal(git(repo, "status", "--porcelain=v1"), before);
  assert.equal(store.enqueueCode(input, config, worktrees).jobId, proposed.jobId);
  assert.throws(() => store.enqueueCode({ ...input, task: "different" }, config, worktrees), /Idempotency key/);
  const action = store.approvals()[0]!.action as Record<string, unknown>;
  assert.equal(action.worktreePath, proposed.worktreePath);
  assert.deepEqual(action.verificationCommands, input.verificationCommands);
  const approved = store.decideApproval(proposed.approvalId, "approved", "test");
  assert.equal(approved.codeLaunch?.worktreePath, proposed.worktreePath);
  assert.equal(approved.codeLaunch?.input.task, input.task);
  assert.throws(() => store.decideApproval(proposed.approvalId!, "approved", "test"), /no longer pending/);
  assert.equal(store.pendingReviews().length, 0);
  assert.equal(store.pendingCodes().length, 1);
  const attempt = store.claimReview(proposed.jobId);
  store.recordReviewEvent(proposed.jobId, attempt, { type: "step_start", sessionID: "ses_testcode" });
  const sha = (s: string) => createHash("sha256").update(s).digest("hex");
  const proposalText = JSON.stringify({ path: "source.txt", beforeSha256: sha("base\n"), afterBase64: Buffer.from("changed\n").toString("base64") });
  const patch = validatePatch(proposalText, proposed.worktreePath, baseSha);
  const secondApproval = store.completeProposal(proposed.jobId, attempt, "ses_testcode", proposalText, await snapshotFingerprint(proposed.worktreePath, baseSha), patch);
  assert.equal(store.status(proposed.jobId).state, "awaiting-approval");
  assert.equal((store.approvals()[0]!.action as { afterSha256: string }).afterSha256, sha("changed\n"));
  const applyDecision = store.decideApproval(secondApproval, "approved", "test");
  assert.equal(applyDecision.codeApply?.proposal, proposalText);
  const applyAttempt = store.claimCodeApply(proposed.jobId, "ses_testcode");
  applyValidatedPatch(validatePatch(proposalText, proposed.worktreePath, baseSha));
  const snapshot = await verifySnapshot({ worktreePath: proposed.worktreePath, baseSha,
    commands: [{ argv: [process.execPath, "-e", "process.exit(1)"], timeoutMs: 1000 }],
    artifactDirectory: join(state, "artifacts", proposed.jobId) });
  assert.throws(() => parseRuntimeResult({ schemaVersion: 1, jobId: proposed.jobId, execution: "completed", acceptance: "passed",
    summary: "worker says success", changedFiles: ["source.txt"], verification: [], limitations: [],
    snapshot: { ...snapshot, acceptance: "passed" } }), /successful independent checks/);
  store.completeCode(proposed.jobId, applyAttempt, "ses_testcode", "worker says success",
    { runtimeVersion: "2.0.16", agent: config.agent, model: config.model }, snapshot);
  assert.equal(store.result(proposed.jobId).result?.execution, "completed");
  assert.equal(store.result(proposed.jobId).result?.acceptance, "failed");
});
