/** One-shot acceptance scenario shared by offline replay and explicitly approved live runs. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { connect } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { startDaemon, type RunningDaemon } from "../../src/daemon/server.js";
import { snapshotFingerprint } from "../../src/verification/snapshot.js";
import { inspectCodeTranscript } from "./claude-transcript.js";

const model = "claude-haiku-4-5-20251001";
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
let sequence = 0;
function rpc(socketPath: string, method: string, params: object): Promise<any> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath); let data = "";
    socket.setTimeout(10_000, () => socket.destroy(new Error(`RPC timeout: ${method}`)));
    socket.on("connect", () => socket.end(JSON.stringify({ protocolVersion: 1, requestId: `signoff-${++sequence}`, method, params }) + "\n"));
    socket.on("data", chunk => { data += String(chunk); if (data.length > 2_000_000) socket.destroy(new Error("RPC output limit")); });
    socket.on("error", reject);
    socket.on("end", () => { try { const response = JSON.parse(data); assert.equal(response.ok, true, JSON.stringify(response.error)); resolve(response.result); } catch (error) { reject(error); } });
  });
}
async function until<T>(read: () => Promise<T>, matches: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 60_000;
  do { const value = await read(); if (matches(value)) return value; await new Promise(resolve => setTimeout(resolve, 10)); } while (Date.now() < deadline);
  throw new Error("Sign-off stage exceeded 60 seconds");
}
function inspectDb<T>(state: string, inspect: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(join(state, "jobs.sqlite"), { readOnly: true });
  try { return inspect(db); } finally { db.close(); }
}

export async function runClaudeSignoff(options: { root: string; executable: string; baseSha: string; node: string; projectsDirectory: string }): Promise<any> {
  const root = realpathSync(options.root), codeSource = join(root, "source-code"), cancelSource = join(root, "source-cancel");
  const reportPath = join(root, "signoff-report.json");
  assert.equal(existsSync(reportPath), false, "sign-off report already exists; no replay or retry allowed");
  const codeState = join(root, "state-signoff-code"), cancelState = join(root, "state-signoff-cancel");
  for (const state of [codeState, cancelState]) assert.equal(existsSync(state), false, "sign-off state already exists");
  const report: any = { schemaVersion: 1, outcome: "running", stage: "preflight", executable: options.executable, model, code: null, cancel: null };
  writeFileSync(reportPath, JSON.stringify(report, null, 2), { mode: 0o600, flag: "wx" });
  const save = (stage: string) => { report.stage = stage; writeFileSync(reportPath, JSON.stringify(report, null, 2)); };
  let daemon: RunningDaemon | undefined, activeJob: string | undefined;
  const beforeSource: string[] = [];
  try {
    for (const source of [codeSource, cancelSource]) {
      assert.equal(git(source, "rev-parse", "HEAD"), options.baseSha);
      assert.equal(git(source, "status", "--porcelain"), "M sentinel.txt\n?? untracked-sentinel.txt");
      beforeSource.push(await snapshotFingerprint(source, options.baseSha));
    }
    const before = readFileSync(join(codeSource, "math.mjs"), "utf8");
    assert.equal(before, "export function add(a, b) {\n  return a - b;\n}\n");
    const after = "export function add(a, b) {\n  return a + b;\n}\n";
    const checks = JSON.parse(readFileSync(join(root, "checks.json"), "utf8"));
    assert.deepEqual(checks, [{ argv: [options.node, "--test", "math.test.mjs"], timeoutMs: 10000 }]);
    const baseline = spawnSync(options.node, ["--test", "math.test.mjs"], { cwd: codeSource, encoding: "utf8", timeout: 15000 });
    assert.equal(baseline.status, 1, "baseline must fail");
    assert.match(baseline.stdout + baseline.stderr, /-1 !== 5/);
    const config = { runtime: "claude", model, executable: options.executable, maxBudgetUsd: 0.05 };
    mkdirSync(codeState, { mode: 0o700 });
    writeFileSync(join(codeState, "code-role.json"), JSON.stringify(config), { mode: 0o600, flag: "wx" });
    daemon = await startDaemon(codeState);
    const call = (method: string, params: object) => rpc(daemon!.socketPath, method, params);
    const task = readFileSync(join(root, "code-task.txt"), "utf8");
    save("code-submit");
    const started = await call("start", { role: "code", task, idempotencyKey: "claude-signoff-code-once", trustedLocal: true,
      requireApproval: true, repositoryPath: codeSource, baseSha: options.baseSha, verificationCommands: checks });
    report.code = { ...started }; activeJob = started.jobId; save("launch-approval");
    assert.equal(started.state, "awaiting-approval");
    const launch = (await call("approvals.list", {})).find((a: any) => a.jobId === activeJob);
    assert.ok(launch);
    for (const [key, value] of Object.entries({ kind: "code-proposal-launch", runtime: "claude", model, executable: options.executable,
      maxBudgetUsd: 0.05, policy: "claude-2.1.283-restricted-read-only-cli", task, repositoryPath: codeSource,
      baseSha: options.baseSha, worktreePath: started.worktreePath, trustedLocal: true, verificationCommands: checks })) assert.deepEqual(launch.action[key], value, `launch ${key}`);
    const beforeWorktree = await snapshotFingerprint(started.worktreePath, options.baseSha);
    report.code.launch = launch; save("code-provider-turn");
    await call("approve", { approvalId: launch.id });
    const status = await until(() => call("status", { jobId: activeJob }), s => {
      if (["failed", "interrupted", "cancelled", "completed"].includes(s.state)) throw new Error(`code proposal stopped: ${s.state}`);
      return s.state === "awaiting-approval" && !!s.runtimeSessionId;
    });
    const identity = status.resolved;
    for (const [key, value] of Object.entries({ model, executable: options.executable, cwd: started.worktreePath,
      runtimeVersion: "2.1.283 (Claude Code)", sessionId: status.runtimeSessionId })) assert.equal(identity[key], value, `identity ${key}`);
    report.code.transcript = inspectCodeTranscript(join(options.projectsDirectory, identity.cwd.replace(/[^a-zA-Z0-9]/g, "-"), `${identity.sessionId}.jsonl`), identity);
    const apply = (await call("approvals.list", {})).find((a: any) => a.jobId === activeJob && a.action.kind === "code-apply");
    assert.ok(apply); assert.notEqual(apply.id, launch.id);
    assert.equal(apply.action.inputDigest, launch.action.inputDigest);
    report.code.apply = apply; report.code.identity = identity; save("apply-inspection");
    assert.equal(await snapshotFingerprint(started.worktreePath, options.baseSha), beforeWorktree, "worker mutated worktree");
    for (const [key, value] of Object.entries({ path: "math.mjs", sessionId: identity.sessionId, worktreePath: started.worktreePath,
      baseSha: options.baseSha, beforeSha256: hash(before), afterSha256: hash(after), worktreeSha: beforeWorktree,
      model, runtime: "claude", executable: options.executable, maxBudgetUsd: 0.05, verificationCommands: checks })) assert.deepEqual(apply.action[key], value, `replacement ${key}`);
    const proposal = inspectDb(codeState, db => db.prepare("SELECT proposal_json FROM code_proposals WHERE job_id=?").get(activeJob!) as { proposal_json: string });
    assert.equal(hash(proposal.proposal_json), apply.action.proposalSha256);
    assert.deepEqual(JSON.parse(proposal.proposal_json), { path: "math.mjs", beforeSha256: hash(before), afterBase64: Buffer.from(after).toString("base64") });
    save("code-apply"); await call("approve", { approvalId: apply.id });
    await until(() => call("status", { jobId: activeJob }), s => {
      if (["failed", "interrupted", "cancelled"].includes(s.state)) throw new Error(`code apply stopped: ${s.state}`);
      return s.state === "completed";
    });
    const result = (await call("result", { jobId: activeJob })).result;
    report.code.result = result; save("snapshot-verification");
    assert.equal(result.acceptance, "passed"); assert.deepEqual(result.changedFiles, ["math.mjs"]);
    assert.equal(readFileSync(join(started.worktreePath, "math.mjs"), "utf8"), after);
    const snapshot = result.snapshot;
    assert.equal(snapshot.snapshotSha, await snapshotFingerprint(started.worktreePath, options.baseSha));
    assert.equal(snapshot.baseSha, options.baseSha); assert.deepEqual(snapshot.changedFiles, ["math.mjs"]);
    assert.equal(snapshot.checks.length, 1); assert.equal(snapshot.checks[0].exitCode, 0);
    assert.equal(snapshot.checks[0].timedOut, false); assert.deepEqual(snapshot.checks[0].argv, [options.node, "--test", "math.test.mjs"]);
    assert.equal(hash(readFileSync(snapshot.artifact.path)), snapshot.artifact.sha256);
    assert.equal(hash(readFileSync(snapshot.artifact.diffPath)), snapshot.artifact.diffFileSha256);
    assert.equal(git(started.worktreePath, "ls-files", "--others", "--exclude-standard"), "");
    assert.equal(snapshot.diffSha256, createHash("sha256").update("gattini-diff-v2\0").update(readFileSync(snapshot.artifact.diffPath)).digest("hex"));
    const retained = JSON.parse(readFileSync(snapshot.artifact.path, "utf8"));
    assert.equal(retained.snapshotSha, snapshot.snapshotSha); assert.equal(retained.diffSha256, snapshot.diffSha256);
    for (const key of ["costUsd", "inputTokens", "outputTokens"]) assert.ok(Number.isFinite(result.usage[key]) && result.usage[key] >= 0, `missing usage ${key}`);
    assert.ok(result.usage.costUsd <= 0.05); assert.equal(result.usage.sessionId, identity.sessionId);
    report.code.approvals = inspectDb(codeState, db => db.prepare("SELECT id,state FROM approvals WHERE job_id=?").all(activeJob!));
    assert.equal(report.code.approvals.length, 2); assert.ok(report.code.approvals.every((a: any) => a.state === "approved"));
    await daemon.close(); daemon = await startDaemon(codeState);
    assert.deepEqual((await call("result", { jobId: activeJob })).result, result);
    await daemon.close(); daemon = undefined; activeJob = undefined;
    assert.equal(await snapshotFingerprint(codeSource, options.baseSha), beforeSource[0]);
    save("code-passed");

    mkdirSync(cancelState, { mode: 0o700 });
    writeFileSync(join(cancelState, "roles.json"), JSON.stringify({ schemaVersion: 1, roles: { reviewer: { ...config, maxBudgetUsd: 0.02, directory: cancelSource } } }), { mode: 0o600, flag: "wx" });
    daemon = await startDaemon(cancelState); save("cancel-submit");
    const cancelledJob = await call("start", { role: "reviewer", task: readFileSync(join(root, "cancel-task.txt"), "utf8"), idempotencyKey: "claude-signoff-cancel-once" });
    activeJob = cancelledJob.jobId; report.cancel = { ...cancelledJob }; save("cancel-wait-identity");
    const running = await until(() => call("status", { jobId: activeJob }), s => {
      if (["completed", "failed", "cancelled", "interrupted"].includes(s.state)) throw new Error(`cancellation not exercised: ${s.state}`);
      return s.state === "running" && !!s.runtimeSessionId;
    });
    report.cancel.before = running; save("cancel-request");
    assert.equal(running.resolved.model, model); assert.equal(running.resolved.executable, options.executable);
    assert.equal(running.resolved.cwd, cancelSource); assert.equal(running.resolved.runtimeVersion, "2.1.283 (Claude Code)");
    await call("cancel", { jobId: activeJob });
    const cancelled = await until(() => call("status", { jobId: activeJob }), s => {
      if (["completed", "failed", "interrupted"].includes(s.state)) throw new Error(`cancellation unproven: ${s.state}`);
      return s.state === "cancelled";
    });
    assert.equal(cancelled.runtimeSessionId, running.runtimeSessionId);
    report.cancel.status = cancelled;
    report.cancel.exit = inspectDb(cancelState, db => {
      const rows = db.prepare("SELECT event_json FROM events WHERE job_id=?").all(activeJob!) as Array<{ event_json: string }>;
      return rows.map(row => JSON.parse(row.event_json)).find(event => event.type === "process-exit");
    });
    assert.ok(report.cancel.exit, "owned child exit evidence missing");
    assert.equal(report.cancel.exit.sessionId, running.runtimeSessionId);
    assert.equal(report.cancel.exit.cancelRequested, true); assert.equal(report.cancel.exit.resultSeen, false);
    assert.ok(["SIGTERM", "SIGKILL"].includes(report.cancel.exit.signalSent), "no successful signal delivery");
    assert.ok(Number.isSafeInteger(report.cancel.exit.pid) && report.cancel.exit.pid > 0);
    assert.throws(() => process.kill(report.cancel.exit.pid, 0), { code: "ESRCH" }, "owned child still exists");
    report.cancel.result = await call("result", { jobId: activeJob });
    await daemon.close(); daemon = await startDaemon(cancelState);
    assert.deepEqual(await call("status", { jobId: activeJob }), cancelled);
    assert.deepEqual(await call("result", { jobId: activeJob }), report.cancel.result);
    for (const [index, source] of [codeSource, cancelSource].entries()) assert.equal(await snapshotFingerprint(source, options.baseSha), beforeSource[index]);
    const socketPath = daemon.socketPath;
    await daemon.close(); daemon = undefined; activeJob = undefined;
    assert.equal(existsSync(socketPath), false, "daemon socket remains after stop");
    report.outcome = "passed"; save("code-and-cancel-passed");
    return report;
  } catch (error) {
    report.outcome = "failed"; report.error = error instanceof Error ? error.message.slice(0, 1000) : "Unknown failure"; save(report.stage);
    if (daemon && activeJob) await rpc(daemon.socketPath, "cancel", { jobId: activeJob }).catch(() => undefined);
    throw error;
  } finally { await daemon?.close(); }
}
