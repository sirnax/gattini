import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { JobStore } from "../src/daemon/store.js";
import { WorktreeManager } from "../src/environments/worktree.js";
import { applyValidatedPatch, validatePatch } from "../src/verification/validated-patch.js";
import { verifySnapshot } from "../src/verification/snapshot.js";
import { snapshotFingerprint } from "../src/verification/snapshot.js";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
function setup(t: { after: (callback: () => void) => void }) {
  const root = mkdtempSync(join(tmpdir(), "gattini-code-lifecycle-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, "source"), state = join(root, "state");
  mkdirSync(source); mkdirSync(state, { mode: 0o700 });
  const git = (...args: string[]) => execFileSync("git", ["-C", source, ...args], { encoding: "utf8" }).trim();
  git("init", "-b", "main"); git("config", "user.name", "Gattini Test"); git("config", "user.email", "gattini@example.invalid");
  writeFileSync(join(source, "target.txt"), "old\n"); git("add", "target.txt"); git("commit", "-m", "base");
  const baseSha = git("rev-parse", "HEAD");
  writeFileSync(join(source, "target.txt"), "dirty\n"); writeFileSync(join(source, "unrelated.txt"), "untouched\n");
  const manager = new WorktreeManager(state);
  t.after(() => manager.close());
  const db = join(state, "jobs.sqlite");
  const input = { task: "change target", idempotencyKey: "key", repositoryPath: source, baseSha,
    verificationCommands: [{ argv: [process.execPath, "-e", "process.exit(0)"], timeoutMs: 1000 }], trustedLocal: true as const };
  const config = { runtime: "opencode" as const, agent: "proposal", model: "provider/model", serverUrl: "http://127.0.0.1:4096" };
  const proposal = JSON.stringify({ path: "target.txt", beforeSha256: sha("old\n"), afterBase64: Buffer.from("new\n").toString("base64") });
  return { root, source, state, db, manager, input, config, proposal, baseSha };
}

test("restart queues only unclaimed launch; crash before and after session handle never replays it", t => {
  for (const recordHandle of [false, true]) {
    const f = setup(t); let store = new JobStore(f.db);
    const job = store.enqueueCode(f.input, f.config, f.manager);
    store.decideApproval(job.approvalId!, "approved", "test");
    store.close(); store = new JobStore(f.db);
    assert.equal(store.pendingCodes().length, 1);
    const attempt = store.claimReview(job.jobId);
    if (recordHandle) store.recordReviewEvent(job.jobId, attempt, { type: "step_start", sessionID: "ses_crash" });
    store.close(); store = new JobStore(f.db);
    assert.equal(store.status(job.jobId).state, "interrupted");
    assert.equal(store.status(job.jobId).runtimeSessionId, recordHandle ? "ses_crash" : null);
    assert.equal(store.pendingCodes().length, 0);
    assert.equal(readFileSync(join(f.source, "target.txt"), "utf8"), "dirty\n");
    store.close();
  }
});

test("restart after proposal keeps exact apply approval; crash around apply and verification stays interrupted", async t => {
  const f = setup(t); let store = new JobStore(f.db);
  const job = store.enqueueCode(f.input, f.config, f.manager);
  store.decideApproval(job.approvalId!, "approved", "test");
  const attempt = store.claimReview(job.jobId);
  store.recordReviewEvent(job.jobId, attempt, { type: "step_start", sessionID: "ses_proposed" });
  const patch = validatePatch(f.proposal, job.worktreePath!, f.baseSha);
  const approval = store.completeProposal(job.jobId, attempt, "ses_proposed", f.proposal, await snapshotFingerprint(job.worktreePath!, f.baseSha), patch);
  store.close(); store = new JobStore(f.db);
  assert.equal(store.status(job.jobId).state, "awaiting-approval");
  assert.equal(store.pendingApplies().length, 0);
  store.decideApproval(approval, "approved", "test");
  store.close(); store = new JobStore(f.db);
  assert.equal(store.pendingApplies().length, 1);
  const applyAttempt = store.claimCodeApply(job.jobId, "ses_proposed");
  applyValidatedPatch(validatePatch(f.proposal, job.worktreePath!, f.baseSha));
  const evidence = await verifySnapshot({ worktreePath: job.worktreePath!, baseSha: f.baseSha, commands: f.input.verificationCommands,
    artifactDirectory: join(f.state, "artifacts", job.jobId) });
  assert.equal(evidence.acceptance, "passed");
  store.close(); store = new JobStore(f.db);
  assert.equal(store.status(job.jobId).state, "interrupted");
  assert.equal(store.pendingApplies().length, 0);
  assert.equal(store.result(job.jobId).result, null);
  assert.equal(readFileSync(join(job.worktreePath!, "target.txt"), "utf8"), "new\n");
  assert.equal(readFileSync(join(f.source, "target.txt"), "utf8"), "dirty\n");
  assert.equal(readFileSync(join(f.source, "unrelated.txt"), "utf8"), "untouched\n");
  assert.ok(applyAttempt);
  store.close();
});

test("cancellation before launch is terminal; cancellation during apply never records acceptance", async t => {
  const f = setup(t); const store = new JobStore(f.db);
  const first = store.enqueueCode(f.input, f.config, f.manager);
  assert.equal(store.requestCancel(first.jobId).state, "cancelled");
  assert.equal(store.pendingCodes().length, 0);
  store.close();
  const g = setup(t); const applying = new JobStore(g.db);
  const job = applying.enqueueCode(g.input, g.config, g.manager);
  applying.decideApproval(job.approvalId!, "approved", "test");
  const attempt = applying.claimReview(job.jobId);
  applying.recordReviewEvent(job.jobId, attempt, { type: "step_start", sessionID: "ses_cancel" });
  const approval = applying.completeProposal(job.jobId, attempt, "ses_cancel", g.proposal, await snapshotFingerprint(job.worktreePath!, g.baseSha), validatePatch(g.proposal, job.worktreePath!, g.baseSha));
  applying.decideApproval(approval, "approved", "test");
  applying.claimCodeApply(job.jobId, "ses_cancel");
  assert.equal(applying.requestCancel(job.jobId).state, "cancelling");
  applying.cancelUncertain(job.jobId);
  assert.equal(applying.status(job.jobId).state, "interrupted");
  assert.equal(applying.result(job.jobId).result, null);
  assert.equal(readFileSync(join(job.worktreePath!, "target.txt"), "utf8"), "old\n");
  applying.close();
});
