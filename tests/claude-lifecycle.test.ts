import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { startDaemon, type RunningDaemon } from "../src/daemon/server.js";
import { JobStore } from "../src/daemon/store.js";

const model = "claude-haiku-4-5-20251001";
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();

function fixture(mode: "complete" | "hold" | "bad-model" | "rate-rejected" | "tool-error" = "complete") {
  const root = mkdtempSync(join(tmpdir(), "gattini-claude-lifecycle-"));
  const state = join(root, "state"), source = join(root, "source"), executable = join(root, "fake-claude");
  mkdirSync(state, { mode: 0o700 }); mkdirSync(source);
  git(source, "init", "-b", "main");
  git(source, "config", "user.name", "Gattini Fixture"); git(source, "config", "user.email", "fixture@example.invalid");
  writeFileSync(join(source, "code.txt"), "old\n");
  git(source, "add", "code.txt"); git(source, "commit", "-m", "base");
  const baseSha = git(source, "rev-parse", "HEAD");
  writeFileSync(join(source, "dirty.txt"), "untracked sentinel\n");
  writeFileSync(executable, `#!/usr/bin/env node
const fs = require('node:fs');
if (process.argv.includes('--version')) { console.log('2.1.283 (Claude Code)'); process.exit(0); }
const arg = name => process.argv[process.argv.indexOf(name) + 1];
const session_id = arg('--session-id');
const model = arg('--model');
fs.appendFileSync(${JSON.stringify(join(root, "launches.jsonl"))}, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }) + '\\n');
let task = '';
process.stdin.on('data', chunk => task += chunk);
process.stdin.on('end', () => {
  const emit = event => process.stdout.write(JSON.stringify(event) + '\\n');
  emit({ type: 'system', subtype: 'init', session_id, model: ${JSON.stringify(mode)} === 'bad-model' ? 'wrong-model' : model, tools: ['Read', 'Glob', 'Grep'] });
  emit({ type: 'rate_limit_event', session_id, rate_limit_info: { status: ${JSON.stringify(mode)} === 'rate-rejected' ? 'rejected' : 'allowed', rateLimitType: 'five_hour' } });
  if (${JSON.stringify(mode)} === 'rate-rejected') return;
  if (${JSON.stringify(mode)} === 'hold') { setInterval(() => {}, 1000); return; }
  emit({ type: 'assistant', session_id, message: { content: [{ type: 'tool_use', id: 'read-1', name: 'Read', input: { file_path: process.cwd() + '/code.txt' } }] } });
  emit({ type: 'user', session_id, message: { content: [{ type: 'tool_result', tool_use_id: 'read-1', content: 'old', is_error: ${JSON.stringify(mode)} === 'tool-error' }] } });
  if (${JSON.stringify(mode)} === 'tool-error') return;
  const proposal = JSON.stringify({ path: 'code.txt', oldText: 'old', newText: 'new' });
  emit({ type: 'result', subtype: 'success', is_error: false, session_id,
    result: task.includes('Prepare one read-only code proposal') ? proposal : 'Offline Claude review.',
    usage: { input_tokens: 12, output_tokens: 6 }, total_cost_usd: 0.001 });
});
`, { mode: 0o700 });
  chmodSync(executable, 0o700);
  const config = { runtime: "claude", model, executable, maxBudgetUsd: 0.02 };
  writeFileSync(join(state, "roles.json"), JSON.stringify({ schemaVersion: 1, roles: { reviewer: { ...config, directory: source } } }), { mode: 0o600 });
  writeFileSync(join(state, "code-role.json"), JSON.stringify(config), { mode: 0o600 });
  return { root, state, source, executable, baseSha };
}

let sequence = 0;
async function call(socketPath: string, method: string, params: object): Promise<any> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath); let data = "";
    socket.on("connect", () => socket.write(JSON.stringify({ protocolVersion: 1, requestId: `claude-${++sequence}`, method, params }) + "\n"));
    socket.on("data", chunk => { data += String(chunk); });
    socket.on("end", () => { try { resolve(JSON.parse(data)); } catch (error) { reject(error); } });
    socket.on("error", reject);
  });
}
function ok(response: any): any { assert.equal(response.ok, true, JSON.stringify(response)); return response.result; }
async function waitFor(socketPath: string, jobId: string, state: string, predicate: (value: any) => boolean = () => true): Promise<any> {
  let latest: any;
  for (let index = 0; index < 400; index++) {
    latest = ok(await call(socketPath, "status", { jobId }));
    if (latest.state === state && predicate(latest)) return latest;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`Expected ${state}: ${JSON.stringify(latest)}`);
}

test("Claude reviewer persists exact identity and bounded usage across restart", async () => {
  const f = fixture(); let daemon: RunningDaemon | undefined;
  try {
    daemon = await startDaemon(f.state);
    const started = ok(await call(daemon.socketPath, "start", { role: "reviewer", task: "Review code.txt", idempotencyKey: "claude-review" }));
    const status = await waitFor(daemon.socketPath, started.jobId, "completed");
    assert.equal(status.resolved.model, model);
    assert.equal(status.resolved.sessionId, status.runtimeSessionId);
    const fetched = ok(await call(daemon.socketPath, "result", { jobId: started.jobId }));
    assert.equal(fetched.result.acceptance, "unverified");
    assert.deepEqual(fetched.result.usage, { runtime: "claude", sessionId: status.runtimeSessionId,
      costUsd: 0.001, inputTokens: 12, outputTokens: 6 });
    await daemon.close(); daemon = await startDaemon(f.state);
    assert.deepEqual(ok(await call(daemon.socketPath, "result", { jobId: started.jobId })).result, fetched.result);
    const duplicate = ok(await call(daemon.socketPath, "start", { role: "reviewer", task: "Review code.txt", idempotencyKey: "claude-review" }));
    assert.equal(duplicate.deduplicated, true);
    assert.equal(readFileSync(join(f.root, "launches.jsonl"), "utf8").trim().split("\n").length, 1);
    const followup = await call(daemon.socketPath, "followup", { jobId: started.jobId, task: "Continue", idempotencyKey: "claude-followup" });
    assert.equal(followup.error.code, "UNSUPPORTED_FOLLOWUP");
  } finally { await daemon?.close(); rmSync(f.root, { recursive: true, force: true }); }
});

test("Claude guarded code needs two exact approvals and retains passing snapshot", async () => {
  const f = fixture(); let daemon: RunningDaemon | undefined;
  try {
    daemon = await startDaemon(f.state);
    const started = ok(await call(daemon.socketPath, "start", { role: "code", task: "Change code.txt from old to new", idempotencyKey: "claude-code",
      trustedLocal: true, requireApproval: true, repositoryPath: f.source, baseSha: f.baseSha,
      verificationCommands: [{ argv: [process.execPath, "-e", "if(require('node:fs').readFileSync('code.txt','utf8')!=='new\\n')process.exit(9)"], timeoutMs: 3000 }] }));
    assert.equal(started.state, "awaiting-approval");
    assert.equal(existsSync(join(f.root, "launches.jsonl")), false);
    const launch = ok(await call(daemon.socketPath, "approvals.list", {})).find((entry: any) => entry.jobId === started.jobId);
    assert.equal(launch.action.kind, "code-proposal-launch");
    assert.equal(launch.action.model, model);
    assert.equal(launch.action.maxBudgetUsd, 0.02);
    ok(await call(daemon.socketPath, "approve", { approvalId: launch.id }));
    let apply: any;
    for (let index = 0; index < 400; index++) {
      apply = ok(await call(daemon.socketPath, "approvals.list", {})).find((entry: any) => entry.jobId === started.jobId && entry.action.kind === "code-apply");
      if (apply) break;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.ok(apply);
    assert.equal(apply.action.path, "code.txt");
    assert.equal(readFileSync(join(started.worktreePath, "code.txt"), "utf8"), "old\n");
    ok(await call(daemon.socketPath, "approve", { approvalId: apply.id }));
    await waitFor(daemon.socketPath, started.jobId, "completed");
    const result = ok(await call(daemon.socketPath, "result", { jobId: started.jobId })).result;
    assert.equal(result.acceptance, "passed");
    assert.equal(result.snapshot.checks[0].exitCode, 0);
    assert.deepEqual(result.changedFiles, ["code.txt"]);
    assert.equal(result.usage.runtime, "claude");
    assert.equal(result.usage.costUsd, 0.001);
    assert.equal(readFileSync(join(started.worktreePath, "code.txt"), "utf8"), "new\n");
    assert.equal(readFileSync(join(f.source, "code.txt"), "utf8"), "old\n");
    assert.equal(readFileSync(join(f.source, "dirty.txt"), "utf8"), "untracked sentinel\n");
    await daemon.close(); daemon = await startDaemon(f.state);
    assert.deepEqual(ok(await call(daemon.socketPath, "result", { jobId: started.jobId })).result, result);
  } finally { await daemon?.close(); rmSync(f.root, { recursive: true, force: true }); }
});

test("denied Claude proposal launch makes no provider process", async () => {
  const f = fixture(); let daemon: RunningDaemon | undefined;
  try {
    daemon = await startDaemon(f.state);
    const started = ok(await call(daemon.socketPath, "start", { role: "code", task: "Change code.txt from old to new",
      idempotencyKey: "claude-denied", trustedLocal: true, requireApproval: true,
      repositoryPath: f.source, baseSha: f.baseSha,
      verificationCommands: [{ argv: [process.execPath, "--version"], timeoutMs: 3000 }] }));
    const launch = ok(await call(daemon.socketPath, "approvals.list", {})).find((entry: any) => entry.jobId === started.jobId);
    ok(await call(daemon.socketPath, "deny", { approvalId: launch.id }));
    assert.equal(ok(await call(daemon.socketPath, "status", { jobId: started.jobId })).state, "failed");
    assert.equal(existsSync(join(f.root, "launches.jsonl")), false);
    assert.equal(readFileSync(join(started.worktreePath, "code.txt"), "utf8"), "old\n");
  } finally { await daemon?.close(); rmSync(f.root, { recursive: true, force: true }); }
});

test("Claude cancellation is confirmed only for an identified exiting child; mismatch stays uncertain", async () => {
  for (const mode of ["hold", "bad-model"] as const) {
    const f = fixture(mode); let daemon: RunningDaemon | undefined;
    try {
      daemon = await startDaemon(f.state);
      const started = ok(await call(daemon.socketPath, "start", { role: "reviewer", task: "Review code.txt", idempotencyKey: `claude-${mode}` }));
      if (mode === "hold") {
        await waitFor(daemon.socketPath, started.jobId, "running", value => !!value.runtimeSessionId);
        ok(await call(daemon.socketPath, "cancel", { jobId: started.jobId }));
        await waitFor(daemon.socketPath, started.jobId, "cancelled");
      } else {
        await waitFor(daemon.socketPath, started.jobId, "interrupted");
        assert.equal(ok(await call(daemon.socketPath, "result", { jobId: started.jobId })).result, null);
        const db = new DatabaseSync(join(f.state, "jobs.sqlite"));
        try {
          const row = db.prepare("SELECT event_json FROM events WHERE job_id=? ORDER BY sequence DESC LIMIT 1").get(started.jobId) as { event_json: string } | undefined;
          assert.deepEqual(JSON.parse(row!.event_json), { source: "claude", type: "diagnostic", code: "PROTOCOL_ERROR", eventType: "system/init" });
        } finally { db.close(); }
      }
    } finally { await daemon?.close(); rmSync(f.root, { recursive: true, force: true }); }
  }
});

test("Claude rejected rate notice retains a bounded diagnostic without an accepted review", async () => {
  const f = fixture("rate-rejected"); let daemon: RunningDaemon | undefined;
  try {
    daemon = await startDaemon(f.state);
    const started = ok(await call(daemon.socketPath, "start", { role: "reviewer", task: "Review code.txt", idempotencyKey: "claude-rate-rejected" }));
    const status = await waitFor(daemon.socketPath, started.jobId, "interrupted");
    assert.equal(status.resolved.model, model);
    assert.equal(ok(await call(daemon.socketPath, "result", { jobId: started.jobId })).result, null);
    const db = new DatabaseSync(join(f.state, "jobs.sqlite"));
    try {
      const row = db.prepare("SELECT event_json FROM events WHERE job_id=? ORDER BY sequence DESC LIMIT 1").get(started.jobId) as { event_json: string } | undefined;
      assert.deepEqual(JSON.parse(row!.event_json), { source: "claude", type: "diagnostic", code: "RATE_LIMITED", eventType: "rate_limit_event/none" });
    } finally { db.close(); }
  } finally { await daemon?.close(); rmSync(f.root, { recursive: true, force: true }); }
});

test("Claude failed Read tool result never becomes an accepted review", async () => {
  const f = fixture("tool-error"); let daemon: RunningDaemon | undefined;
  try {
    daemon = await startDaemon(f.state);
    const started = ok(await call(daemon.socketPath, "start", { role: "reviewer", task: "Review code.txt", idempotencyKey: "claude-tool-error" }));
    await waitFor(daemon.socketPath, started.jobId, "interrupted");
    assert.equal(ok(await call(daemon.socketPath, "result", { jobId: started.jobId })).result, null);
    const db = new DatabaseSync(join(f.state, "jobs.sqlite"));
    try {
      const row = db.prepare("SELECT event_json FROM events WHERE job_id=? ORDER BY sequence DESC LIMIT 1").get(started.jobId) as { event_json: string } | undefined;
      assert.deepEqual(JSON.parse(row!.event_json), { source: "claude", type: "diagnostic", code: "PROTOCOL_ERROR", eventType: "user/none" });
    } finally { db.close(); }
  } finally { await daemon?.close(); rmSync(f.root, { recursive: true, force: true }); }
});

test("restart does not replay a claimed Claude session or confirm its cancellation", async () => {
  const f = fixture(); let daemon: RunningDaemon | undefined;
  try {
    const store = new JobStore(join(f.state, "jobs.sqlite"));
    const config = { runtime: "claude" as const, model, executable: f.executable, maxBudgetUsd: 0.02, directory: f.source };
    const queued = store.enqueueClaudeReview({ task: "Review code.txt", idempotencyKey: "claude-crashed", config });
    const attemptId = store.claimReview(queued.jobId);
    const sessionId = "00000000-0000-4000-8000-000000000001";
    store.recordClaudeIdentity(queued.jobId, attemptId, { sessionId, model, runtimeVersion: "2.1.283 (Claude Code)",
      executable: f.executable, cwd: f.source });
    store.close();
    daemon = await startDaemon(f.state);
    assert.equal(ok(await call(daemon.socketPath, "status", { jobId: queued.jobId })).state, "interrupted");
    assert.equal(existsSync(join(f.root, "launches.jsonl")), false);
    ok(await call(daemon.socketPath, "cancel", { jobId: queued.jobId }));
    await waitFor(daemon.socketPath, queued.jobId, "interrupted");
    assert.equal(ok(await call(daemon.socketPath, "result", { jobId: queued.jobId })).result, null);
  } finally { await daemon?.close(); rmSync(f.root, { recursive: true, force: true }); }
});
