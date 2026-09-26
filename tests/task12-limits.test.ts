import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { JobStore } from "../src/daemon/store.js";

function fixture(t: { after: (fn: () => void) => void }) {
  const root = mkdtempSync(join(tmpdir(), "gattini-task12-store-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = join(root, "review-source");
  mkdirSync(directory);
  const database = join(root, "jobs.sqlite");
  const config = {
    runtime: "opencode", agent: "reviewer", model: "provider/reviewer-model", directory,
    serverUrl: "http://127.0.0.1:4096", permissions: [
      { action: "*", resource: "*", effect: "deny" },
      { action: "read", resource: "*", effect: "allow" },
      { action: "glob", resource: "*", effect: "allow" },
      { action: "grep", resource: "*", effect: "allow" },
    ],
  };
  return { root, database, config };
}

function attemptCount(database: string, jobId: string): number {
  const db = new DatabaseSync(database);
  try {
    return (db.prepare("SELECT count(*) AS n FROM attempts WHERE job_id=?").get(jobId) as { n: number }).n;
  } finally { db.close(); }
}

test("transient preflight failures survive restart and exhaust one retry without a runtime session", t => {
  const f = fixture(t);
  let store = new JobStore(f.database);
  const queued = store.enqueueReview({ task: "Review locally", idempotencyKey: "retry", role: "reviewer", config: f.config });
  assert.equal(queued.state, "queued");
  const firstId = store.recordTransientPreflightFailure(queued.jobId, false);
  const first = store.result(queued.jobId, firstId);
  assert.equal(first.state, "queued");
  assert.equal(first.result?.execution, "failed");
  assert.equal(first.result?.escalation, undefined);
  assert.equal(store.preflightFailureCount(queued.jobId), 1);
  store.close();

  store = new JobStore(f.database);
  t.after(() => store.close());
  assert.deepEqual(store.result(queued.jobId, firstId).result, first.result);
  const secondId = store.recordTransientPreflightFailure(queued.jobId, true);
  assert.notEqual(secondId, firstId);
  assert.equal(store.preflightFailureCount(queued.jobId), 2);
  assert.equal(store.result(queued.jobId).state, "failed");
  assert.equal(store.result(queued.jobId, secondId).result?.escalation?.code, "RETRY_EXHAUSTED");
  assert.deepEqual(store.result(queued.jobId, firstId).result, first.result);
  assert.throws(() => store.recordTransientPreflightFailure(queued.jobId, true), /not eligible/);
  const db = new DatabaseSync(f.database);
  try {
    const rows = db.prepare("SELECT id,phase,runtime_session_id FROM attempts WHERE job_id=? ORDER BY rowid").all(queued.jobId) as
      Array<{ id: string; phase: string; runtime_session_id: string | null }>;
    assert.deepEqual(rows.map(row => ({ ...row })), [
      { id: firstId, phase: "failed", runtime_session_id: null },
      { id: secondId, phase: "failed", runtime_session_id: null },
    ]);
  } finally { db.close(); }
});

test("approval-waiting reviewer has no attempt, and denial never launches one", t => {
  const f = fixture(t);
  const store = new JobStore(f.database);
  t.after(() => store.close());
  const blocked = store.enqueueReview({ task: "Review after approval", idempotencyKey: "blocked", role: "reviewer",
    config: f.config, requireApproval: true });
  assert.equal(blocked.state, "awaiting-approval");
  assert.ok(blocked.approvalId);
  assert.equal(attemptCount(f.database, blocked.jobId), 0);
  assert.equal(store.pendingReviews().some(item => item.jobId === blocked.jobId), false);
  assert.throws(() => store.recordTransientPreflightFailure(blocked.jobId, false), /not eligible/);
  const denial = store.decideApproval(blocked.approvalId, "denied", "offline-test");
  assert.equal(denial.launch, null);
  assert.equal(store.status(blocked.jobId).state, "failed");
  assert.equal(attemptCount(f.database, blocked.jobId), 0);
});

test("persisted review usage preserves null measures and exact session provenance", t => {
  const f = fixture(t);
  let store = new JobStore(f.database);
  const queued = store.enqueueReview({ task: "Review usage", idempotencyKey: "usage", role: "reviewer", config: f.config });
  const attemptId = store.claimReview(queued.jobId);
  const sessionId = "ses_task12usage";
  store.recordReviewEvent(queued.jobId, attemptId, { type: "step_start", sessionID: sessionId });
  store.recordReviewEvent(queued.jobId, attemptId, { type: "step_finish", sessionID: sessionId, id: "step-one",
    part: { cost: 0.125, tokens: { input: 11, output: 7 } } });
  store.recordReviewEvent(queued.jobId, attemptId, { type: "step_finish", sessionID: sessionId, id: "step-two",
    part: { tokens: { input: 5, output: 3 } } });
  store.completeReview(queued.jobId, attemptId, sessionId, "Review done", {
    runtimeVersion: "2.0.16", agent: "reviewer", model: "provider/reviewer-model",
  });
  const saved = store.result(queued.jobId, attemptId);
  assert.deepEqual(saved.result?.usage, { runtime: "opencode", sessionId, costUsd: null,
    inputTokens: 16, outputTokens: 10 });
  const missing = store.enqueueReview({ task: "Review without metering", idempotencyKey: "missing-usage",
    role: "reviewer", config: f.config });
  const missingAttempt = store.claimReview(missing.jobId);
  const missingSession = "ses_task12missing";
  store.recordReviewEvent(missing.jobId, missingAttempt, { type: "step_start", sessionID: missingSession });
  store.completeReview(missing.jobId, missingAttempt, missingSession, "Review done", {
    runtimeVersion: "2.0.16", agent: "reviewer", model: "provider/reviewer-model",
  });
  const absent = store.result(missing.jobId, missingAttempt);
  assert.deepEqual(absent.result?.usage, { runtime: "opencode", sessionId: missingSession,
    costUsd: null, inputTokens: null, outputTokens: null });
  store.close();
  store = new JobStore(f.database);
  t.after(() => store.close());
  assert.deepEqual(store.result(queued.jobId, attemptId).result, saved.result);
  assert.deepEqual(store.result(missing.jobId, missingAttempt).result, absent.result);
});
