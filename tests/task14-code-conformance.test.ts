import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { parseRuntimeResult } from "../src/core/contracts.js";
import { startDaemon, type RunningDaemon } from "../src/daemon/server.js";

type Runtime = "opencode" | "codex";
type RecordValue = Record<string, any>;
const taskText = "Replace code.txt with new followed by a newline.";
const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
let requestSequence = 0;

async function call(socketPath: string, method: string, params: object): Promise<RecordValue> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath); let data = "";
    socket.on("connect", () => socket.write(JSON.stringify({ protocolVersion: 1, requestId: `request-${++requestSequence}`, method, params }) + "\n"));
    socket.on("data", chunk => { data += String(chunk); });
    socket.on("end", () => { try { resolve(JSON.parse(data) as RecordValue); } catch (error) { reject(error); } });
    socket.on("error", reject);
  });
}

function ok(response: RecordValue): RecordValue {
  assert.equal(response.ok, true, JSON.stringify(response));
  return response.result as RecordValue;
}

async function waitFor(socketPath: string, jobId: string, wanted: string, predicate: (value: RecordValue) => boolean = () => true): Promise<RecordValue> {
  const deadline = Date.now() + 10_000;
  let latest: RecordValue | undefined;
  while (Date.now() < deadline) {
    latest = ok(await call(socketPath, "status", { jobId }));
    if (latest.state === wanted && predicate(latest)) return latest;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`Job ${jobId} did not reach ${wanted}: ${JSON.stringify(latest)}`);
}

async function waitApply(socketPath: string, jobId: string): Promise<RecordValue> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const approvals = ok(await call(socketPath, "approvals.list", {})) as unknown as RecordValue[];
    const apply = approvals.find(entry => entry.jobId === jobId && entry.state === "pending" && entry.action.kind === "code-apply");
    if (apply) return apply;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`Job ${jobId} has no apply approval`);
}

function fixture(runtime: Runtime, mode: "complete" | "bad-proposal" | "hold-confirm" | "hold-uncertain" = "complete") {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `gattini-task14-code-${runtime}-`)));
  const source = join(root, "source"), state = join(root, "state"), bin = join(root, "bin");
  mkdirSync(source); mkdirSync(state, { mode: 0o700 }); mkdirSync(bin);
  git(source, "init", "-b", "main");
  git(source, "config", "user.name", "Gattini Test");
  git(source, "config", "user.email", "gattini@example.invalid");
  writeFileSync(join(source, "code.txt"), "old\n");
  git(source, "add", "code.txt"); git(source, "commit", "-m", "base");
  const baseSha = git(source, "rev-parse", "HEAD");
  writeFileSync(join(source, "code.txt"), "dirty\n");
  writeFileSync(join(source, "untracked.txt"), "preserved\n");
  const proposal = JSON.stringify({ path: mode === "bad-proposal" ? "../escape" : "code.txt", oldText: "old", newText: "new" });
  const calls = join(root, "calls.log");
  if (runtime === "opencode") {
    const script = `#!/bin/sh
printf '%s\\n' "$*" >> '${calls}'
case "$1" in
  --version) printf 'opencode v2.0.18\\n' ;;
  service) printf 'http://127.0.0.1:4096\\n' ;;
  debug) printf '%s\\n' '[{"id":"proposal","permissions":[{"action":"*","resource":"*","effect":"deny"},{"action":"read","resource":"*","effect":"allow"},{"action":"glob","resource":"*","effect":"allow"},{"action":"grep","resource":"*","effect":"allow"}]}]' ;;
  models) printf 'provider/model\\n' ;;
  run) printf '%s\\n' '{"type":"step_start","sessionID":"ses_task14code"}' '{"type":"text","sessionID":"ses_task14code","part":{"text":${JSON.stringify(proposal)}}}' ;;
  api) if [ "$2" = session.active ]; then printf '{"data":{}}\\n'; else printf '{"data":{"id":"ses_task14code","agent":"proposal","model":{"providerID":"provider","id":"model"},"outcome":"succeeded","location":{"directory":"%s"}}}\\n' "$PWD"; fi ;;
  *) exit 9 ;;
esac
`;
    writeFileSync(join(bin, "opencode"), script, { mode: 0o700 });
    chmodSync(join(bin, "opencode"), 0o700);
    writeFileSync(join(state, "code-role.json"), JSON.stringify({ runtime, agent: "proposal", model: "provider/model", serverUrl: "http://127.0.0.1:4096" }), { mode: 0o600 });
  } else {
    const executable = join(bin, "fake-codex");
    writeFileSync(executable, `#!/usr/bin/env node
const fs = require("node:fs");
let input = "";
const send = value => process.stdout.write(JSON.stringify(value) + "\\n");
if (process.argv.slice(2).join(" ") !== "app-server --listen stdio://") process.exit(9);
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => {
  input += chunk;
  let end;
  while ((end = input.indexOf("\\n")) >= 0) {
    const message = JSON.parse(input.slice(0, end)); input = input.slice(end + 1);
    fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(message) + "\\n");
    if (message.method === "initialize") send({ id: message.id, result: { userAgent: "task14-fixture" } });
    if (message.method === "thread/start") {
      const p = message.params;
      send({ id: message.id, result: { thread: { id: "thread-task14code", sessionId: "session-task14code", cliVersion: "0.157.1", model: p.model, modelProvider: p.modelProvider, cwd: p.cwd }, model: p.model, modelProvider: p.modelProvider, cwd: p.cwd, approvalPolicy: "on-request", approvalsReviewer: "user", sandbox: { type: "readOnly", networkAccess: false } } });
    }
    if (message.method === "turn/start") {
      send({ id: message.id, result: { turn: { id: "turn-task14code", status: "inProgress" } } });
      if (${JSON.stringify(mode)} !== "hold-confirm" && ${JSON.stringify(mode)} !== "hold-uncertain") setTimeout(() => {
        send({ method: "item/completed", params: { threadId: "thread-task14code", turnId: "turn-task14code", item: { type: "agentMessage", text: ${JSON.stringify(proposal)} } } });
        send({ method: "thread/tokenUsage/updated", params: { threadId: "thread-task14code", turnId: "turn-task14code", tokenUsage: { last: { inputTokens: 13, outputTokens: 8, cachedInputTokens: 0, totalTokens: 21 } } } });
        send({ method: "turn/completed", params: { threadId: "thread-task14code", turn: { id: "turn-task14code", status: "completed" } } });
      }, 20);
    }
    if (message.method === "turn/interrupt") {
      send({ id: message.id, result: {} });
      if (${JSON.stringify(mode)} === "hold-confirm") send({ method: "turn/completed", params: { threadId: "thread-task14code", turn: { id: "turn-task14code", status: "interrupted" } } });
      if (${JSON.stringify(mode)} === "hold-uncertain") {
        send({ method: "turn/completed", params: { threadId: "thread-task14code", turn: { id: "wrong-turn", status: "interrupted" } } });
        setTimeout(() => process.exit(0), 20);
      }
    }
  }
});
`, { mode: 0o700 });
    chmodSync(executable, 0o700);
    writeFileSync(join(state, "code-role.json"), JSON.stringify({ runtime, model: "gpt-6-sol", modelProvider: "openai", executable }), { mode: 0o600 });
  }
  const params = { task: taskText, idempotencyKey: "same-code-task", role: "code", requireApproval: true,
    trustedLocal: true, repositoryPath: source, baseSha,
    verificationCommands: [{ argv: [process.execPath, "-e", "if(require('node:fs').readFileSync('code.txt','utf8')!=='new\\n')process.exit(9)"], timeoutMs: 3000 }] };
  return { root, source, state, bin, calls, params };
}

test("same guarded code request conforms under OpenCode and Codex private mappings", async () => {
  const originalPath = process.env.PATH;
  for (const runtime of ["opencode", "codex"] as const) {
    const f = fixture(runtime);
    let daemon: RunningDaemon | undefined;
    try {
      if (runtime === "opencode") process.env.PATH = `${f.bin}${delimiter}${originalPath ?? ""}`;
      daemon = await startDaemon(f.state);
      const first = ok(await call(daemon.socketPath, "start", f.params));
      const duplicate = ok(await call(daemon.socketPath, "start", f.params));
      assert.equal(duplicate.jobId, first.jobId);
      assert.equal(duplicate.deduplicated, true);
      assert.equal(first.state, "awaiting-approval");
      assert.equal(readFileSync(join(first.worktreePath, "code.txt"), "utf8"), "old\n");
      assert.equal(readFileSync(join(f.source, "code.txt"), "utf8"), "dirty\n");
      assert.equal(existsSync(f.calls), false); // launch cannot happen before approval
      await call(daemon.socketPath, "approve", { approvalId: first.approvalId }).then(ok);
      const apply = await waitApply(daemon.socketPath, first.jobId);
      assert.equal(apply.action.path, "code.txt");
      assert.equal(apply.action.afterSha256, sha("new\n"));
      assert.equal(apply.action.worktreePath, first.worktreePath);
      assert.equal(readFileSync(join(first.worktreePath, "code.txt"), "utf8"), "old\n");
      assert.equal(readFileSync(join(f.source, "code.txt"), "utf8"), "dirty\n");
      const status = await waitFor(daemon.socketPath, first.jobId, "awaiting-approval", value => typeof value.runtimeSessionId === "string");
      if (runtime === "opencode") {
        assert.equal(status.runtimeSessionId, "ses_task14code");
        assert.equal(status.resolved, null);
      } else {
        assert.equal(status.runtimeSessionId, "thread-task14code");
        assert.equal(status.resolved.threadId, "thread-task14code");
        assert.equal(status.resolved.sessionId, "session-task14code");
        assert.equal(status.resolved.turnId, "turn-task14code");
        assert.equal(status.resolved.model, "gpt-6-sol");
        assert.equal(status.resolved.modelProvider, "openai");
        assert.equal(status.resolved.usage.inputTokens, 13);
      }
      await daemon.close(); daemon = await startDaemon(f.state);
      assert.equal((await waitApply(daemon.socketPath, first.jobId)).id, apply.id);
      assert.equal(readFileSync(join(first.worktreePath, "code.txt"), "utf8"), "old\n");
      ok(await call(daemon.socketPath, "approve", { approvalId: apply.id }));
      const completed = await waitFor(daemon.socketPath, first.jobId, "completed");
      if (runtime === "opencode") assert.deepEqual(completed.resolved, { runtimeVersion: "2.0.18", agent: "proposal", model: "provider/model" });
      const fetched = ok(await call(daemon.socketPath, "result", { jobId: first.jobId }));
      const result = parseRuntimeResult(fetched.result);
      assert.equal(result.execution, "completed");
      assert.equal(result.acceptance, "passed");
      assert.deepEqual(result.changedFiles, ["code.txt"]);
      assert.equal(result.verification.length, 1);
      assert.equal(result.verification[0]?.exitCode, 0);
      assert.equal(result.usage?.runtime, runtime);
      assert.equal(result.usage?.costUsd, null);
      assert.equal(result.usage?.sessionId, runtime === "codex" ? "session-task14code" : "ses_task14code");
      if (runtime === "codex") {
        assert.equal(result.usage?.inputTokens, 13);
        assert.equal(result.usage?.outputTokens, 8);
      }
      const artifact = result.snapshot?.artifact;
      assert.ok(artifact);
      assert.equal(sha(readFileSync(artifact.path)), artifact.sha256);
      assert.equal(sha(readFileSync(artifact.diffPath)), artifact.diffFileSha256);
      assert.match(readFileSync(artifact.diffPath, "utf8"), /\+new/);
      assert.equal(readFileSync(join(first.worktreePath, "code.txt"), "utf8"), "new\n");
      assert.equal(readFileSync(join(f.source, "code.txt"), "utf8"), "dirty\n");
      assert.equal(readFileSync(join(f.source, "untracked.txt"), "utf8"), "preserved\n");
      const followup = await call(daemon.socketPath, "followup", { jobId: first.jobId, task: "Continue", idempotencyKey: "unsupported" });
      assert.equal(followup.ok, false);
      assert.equal(followup.error.code, "UNSUPPORTED_FOLLOWUP");
      const calls = readFileSync(f.calls, "utf8");
      if (runtime === "opencode") assert.equal(calls.split("\n").filter(line => line.startsWith("run ")).length, 1);
      else {
        const messages = calls.trim().split("\n").map(line => JSON.parse(line) as RecordValue);
        assert.equal(messages.filter(message => message.method === "turn/start").length, 1);
        assert.deepEqual(messages.find(message => message.method === "thread/start")?.params,
          { model: "gpt-6-sol", modelProvider: "openai", cwd: first.worktreePath, sandbox: "read-only", approvalPolicy: "on-request", approvalsReviewer: "user" });
      }
    } finally {
      if (daemon) await daemon.close();
      process.env.PATH = originalPath;
      rmSync(f.root, { recursive: true, force: true });
    }
  }
});

test("denied proposal launch never invokes either runtime", async () => {
  const originalPath = process.env.PATH;
  for (const runtime of ["opencode", "codex"] as const) {
    const f = fixture(runtime);
    let daemon: RunningDaemon | undefined;
    try {
      if (runtime === "opencode") process.env.PATH = `${f.bin}${delimiter}${originalPath ?? ""}`;
      daemon = await startDaemon(f.state);
      const started = ok(await call(daemon.socketPath, "start", f.params));
      ok(await call(daemon.socketPath, "deny", { approvalId: started.approvalId }));
      await waitFor(daemon.socketPath, started.jobId, "failed");
      assert.equal(existsSync(f.calls), false);
      assert.equal(readFileSync(join(started.worktreePath, "code.txt"), "utf8"), "old\n");
      const result = parseRuntimeResult(ok(await call(daemon.socketPath, "result", { jobId: started.jobId })).result);
      assert.equal(result.execution, "failed");
      assert.equal(result.acceptance, "unverified");
      assert.deepEqual(result.changedFiles, []);
    } finally {
      if (daemon) await daemon.close();
      process.env.PATH = originalPath;
      rmSync(f.root, { recursive: true, force: true });
    }
  }
});

test("unsafe proposal from either runtime fails closed before apply", async () => {
  const originalPath = process.env.PATH;
  for (const runtime of ["opencode", "codex"] as const) {
    const f = fixture(runtime, "bad-proposal");
    let daemon: RunningDaemon | undefined;
    try {
      if (runtime === "opencode") process.env.PATH = `${f.bin}${delimiter}${originalPath ?? ""}`;
      daemon = await startDaemon(f.state);
      const started = ok(await call(daemon.socketPath, "start", f.params));
      ok(await call(daemon.socketPath, "approve", { approvalId: started.approvalId }));
      await waitFor(daemon.socketPath, started.jobId, "interrupted");
      const approvals = ok(await call(daemon.socketPath, "approvals.list", {})) as unknown as RecordValue[];
      assert.equal(approvals.some(entry => entry.jobId === started.jobId && entry.action.kind === "code-apply"), false);
      assert.equal(readFileSync(join(started.worktreePath, "code.txt"), "utf8"), "old\n");
      assert.equal(readFileSync(join(f.source, "code.txt"), "utf8"), "dirty\n");
      await daemon.close(); daemon = await startDaemon(f.state);
      const afterRestart = ok(await call(daemon.socketPath, "status", { jobId: started.jobId }));
      assert.equal(afterRestart.state, "interrupted");
      assert.equal(readFileSync(join(started.worktreePath, "code.txt"), "utf8"), "old\n");
    } finally {
      if (daemon) await daemon.close();
      process.env.PATH = originalPath;
      rmSync(f.root, { recursive: true, force: true });
    }
  }
});

test("Codex proposal cancellation requires its exact interrupted turn", async () => {
  for (const [mode, expected] of [["hold-confirm", "cancelled"], ["hold-uncertain", "interrupted"]] as const) {
    const f = fixture("codex", mode);
    let daemon: RunningDaemon | undefined;
    try {
      daemon = await startDaemon(f.state);
      const started = ok(await call(daemon.socketPath, "start", f.params));
      ok(await call(daemon.socketPath, "approve", { approvalId: started.approvalId }));
      await waitFor(daemon.socketPath, started.jobId, "running", value => value.runtimeSessionId === "thread-task14code");
      const requested = ok(await call(daemon.socketPath, "cancel", { jobId: started.jobId }));
      assert.equal(requested.state, "cancelling");
      const terminal = await waitFor(daemon.socketPath, started.jobId, expected);
      assert.equal(terminal.runtimeSessionId, "thread-task14code");
      const messages = readFileSync(f.calls, "utf8").trim().split("\n").map(line => JSON.parse(line) as RecordValue);
      assert.deepEqual(messages.find(message => message.method === "turn/interrupt")?.params,
        { threadId: "thread-task14code", turnId: "turn-task14code" });
      assert.equal(ok(await call(daemon.socketPath, "result", { jobId: started.jobId })).result, null);
      assert.equal(readFileSync(join(started.worktreePath, "code.txt"), "utf8"), "old\n");
      await daemon.close(); daemon = await startDaemon(f.state);
      assert.equal(ok(await call(daemon.socketPath, "status", { jobId: started.jobId })).state, expected);
    } finally {
      if (daemon) await daemon.close();
      rmSync(f.root, { recursive: true, force: true });
    }
  }
});

test("cancelling a Codex code job awaiting apply approval stays local", async () => {
  const f = fixture("codex");
  let daemon: RunningDaemon | undefined;
  try {
    daemon = await startDaemon(f.state);
    const started = ok(await call(daemon.socketPath, "start", f.params));
    ok(await call(daemon.socketPath, "approve", { approvalId: started.approvalId }));
    const apply = await waitApply(daemon.socketPath, started.jobId);
    const cancelled = ok(await call(daemon.socketPath, "cancel", { jobId: started.jobId }));
    assert.equal(cancelled.state, "cancelled");
    await waitFor(daemon.socketPath, started.jobId, "cancelled");
    const approval = await call(daemon.socketPath, "approve", { approvalId: apply.id });
    assert.equal(approval.ok, false);
    assert.equal(approval.error.code, "APPROVAL_STALE");
    const messages = readFileSync(f.calls, "utf8").trim().split("\n").map(line => JSON.parse(line) as RecordValue);
    assert.equal(messages.some(message => message.method === "turn/interrupt"), false);
    assert.equal(readFileSync(join(started.worktreePath, "code.txt"), "utf8"), "old\n");
    assert.equal(ok(await call(daemon.socketPath, "result", { jobId: started.jobId })).result, null);
  } finally {
    if (daemon) await daemon.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("cancelling during Codex patch verification cannot produce accepted evidence", async () => {
  const f = fixture("codex");
  let daemon: RunningDaemon | undefined;
  try {
    const marker = join(f.root, "verification-started");
    f.params.verificationCommands = [{ argv: [process.execPath, "-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)},'started');setTimeout(()=>{},1500)`], timeoutMs: 3000 }];
    daemon = await startDaemon(f.state);
    const started = ok(await call(daemon.socketPath, "start", f.params));
    ok(await call(daemon.socketPath, "approve", { approvalId: started.approvalId }));
    const apply = await waitApply(daemon.socketPath, started.jobId);
    ok(await call(daemon.socketPath, "approve", { approvalId: apply.id }));
    const deadline = Date.now() + 10_000;
    while (!existsSync(marker) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(existsSync(marker), true, "verification command did not start");
    const requested = ok(await call(daemon.socketPath, "cancel", { jobId: started.jobId }));
    assert.equal(requested.state, "cancelling");
    await waitFor(daemon.socketPath, started.jobId, "interrupted");
    await daemon.close(); daemon = await startDaemon(f.state);
    const status = ok(await call(daemon.socketPath, "status", { jobId: started.jobId }));
    assert.equal(status.state, "interrupted");
    const fetched = ok(await call(daemon.socketPath, "result", { jobId: started.jobId }));
    assert.notEqual(fetched.result?.acceptance, "passed");
    assert.equal(readFileSync(join(f.source, "code.txt"), "utf8"), "dirty\n");
  } finally {
    if (daemon) await daemon.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});
