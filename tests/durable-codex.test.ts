import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { connect, type Socket } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { afterEach, test } from "node:test";
import { startDaemon, type RunningDaemon } from "../src/daemon/server.js";

const fixtures: string[] = [];
const daemons: RunningDaemon[] = [];

function fixture(mode: string): { directory: string; executable: string; calls: string } {
  const directory = mkdtempSync("/private/tmp/gattini-codex-durable-");
  fixtures.push(directory);
  const executable = join(directory, "fake-codex");
  const calls = join(directory, "calls.jsonl");
  writeFileSync(join(directory, "mode"), mode);
  writeFileSync(executable, `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const directory = __dirname;
const mode = fs.readFileSync(path.join(directory, "mode"), "utf8");
if (process.argv.slice(2).join(" ") !== "app-server --listen stdio://") process.exit(9);
let input = "";
const send = value => process.stdout.write(JSON.stringify(value) + "\\n");
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => {
  input += chunk;
  let end;
  while ((end = input.indexOf("\\n")) >= 0) {
    const line = input.slice(0, end);
    input = input.slice(end + 1);
    const message = JSON.parse(line);
    fs.appendFileSync(path.join(directory, "calls.jsonl"), JSON.stringify(message) + "\\n");
    if (message.method === "initialize") send({ id: message.id, result: { userAgent: "offline-fixture" } });
    if (message.method === "thread/start") {
      const p = message.params;
      const model = mode === "wrong-model" ? "wrong-model" : p.model;
      const thread = { id: "thread-fixture", sessionId: "session-fixture", cliVersion: "0.157.1", model, modelProvider: p.modelProvider, cwd: p.cwd };
      send({ id: message.id, result: { thread, model, modelProvider: p.modelProvider, cwd: p.cwd,
        approvalPolicy: "on-request", approvalsReviewer: "user", sandbox: { type: "readOnly", networkAccess: false } } });
    }
    if (message.method === "turn/start") {
      send({ id: message.id, result: { turn: { id: "turn-fixture", status: "inProgress" } } });
      if (mode === "complete") setTimeout(() => {
        send({ method: "item/completed", params: { threadId: "thread-fixture", turnId: "turn-fixture", item: { type: "agentMessage", text: "Offline Codex review complete." } } });
        send({ method: "thread/tokenUsage/updated", params: { threadId: "thread-fixture", turnId: "turn-fixture", tokenUsage: { last: { inputTokens: 11, outputTokens: 7, cachedInputTokens: 2, totalTokens: 18 } } } });
        send({ method: "turn/completed", params: { threadId: "thread-fixture", turn: { id: "turn-fixture", status: "completed" } } });
      }, 20);
      if (mode === "reroute") setTimeout(() => send({ method: "model/rerouted", params: { threadId: "thread-fixture", turnId: "turn-fixture", fromModel: "gpt-6-sol", toModel: "wrong-model" } }), 20);
    }
    if (message.method === "turn/interrupt") {
      send({ id: message.id, result: {} });
      if (mode === "confirm-interrupt") send({ method: "turn/completed", params: { threadId: "thread-fixture", turn: { id: "turn-fixture", status: "interrupted" } } });
      else setTimeout(() => process.exit(0), 20);
    }
  }
});
`, { mode: 0o700 });
  chmodSync(executable, 0o700);
  writeFileSync(join(directory, "codex-role.json"), JSON.stringify({ schemaVersion: 1, runtime: "codex",
    model: "gpt-6-sol", modelProvider: "openai", directory, executable }), { mode: 0o600 });
  return { directory, executable, calls };
}

afterEach(async () => {
  for (const daemon of daemons.splice(0)) await daemon.close();
  for (const directory of fixtures.splice(0)) rmSync(directory, { recursive: true, force: true });
});

async function daemonAt(directory: string): Promise<RunningDaemon> {
  const daemon = await startDaemon(directory);
  daemons.push(daemon);
  return daemon;
}

function wire(requestId: string, method: string, params: object) {
  return { protocolVersion: 1, requestId, method, params };
}

function request(socketPath: string, body: object): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket: Socket = connect(socketPath);
    let data = "";
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(JSON.stringify(body) + "\n"));
    socket.on("data", chunk => { data += chunk; });
    socket.on("end", () => {
      try { resolve(JSON.parse(data.trim()) as Record<string, unknown>); }
      catch (error) { reject(error); }
    });
    socket.on("error", reject);
  });
}

function ok(response: Record<string, unknown>): Record<string, unknown> {
  assert.equal(response.ok, true, JSON.stringify(response));
  return response.result as Record<string, unknown>;
}

async function waitForState(socketPath: string, jobId: string, states: string[]): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const status = ok(await request(socketPath, wire("status", "status", { jobId })));
    if (states.includes(String(status.state))) return status;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${jobId}: ${states.join(", ")}`);
}

async function submit(socketPath: string, idempotencyKey: string): Promise<string> {
  const accepted = ok(await request(socketPath, wire("submit", "start", { task: "Review the offline fixture.", idempotencyKey, role: "codex-reviewer" })));
  return String(accepted.jobId);
}

test("Codex review stores exact identity, result and unknown cost across daemon restart", async () => {
  const { directory, calls } = fixture("complete");
  const daemon = await daemonAt(directory);
  const jobId = await submit(daemon.socketPath, "complete");
  const status = await waitForState(daemon.socketPath, jobId, ["completed"]);
  assert.equal(status.runtimeSessionId, "thread-fixture");
  assert.deepEqual(status.resolved, { threadId: "thread-fixture", sessionId: "session-fixture", turnId: "turn-fixture",
    cliVersion: "0.157.1", model: "gpt-6-sol", modelProvider: "openai" });
  const fetched = ok(await request(daemon.socketPath, wire("result", "result", { jobId })));
  assert.equal(fetched.state, "completed");
  assert.deepEqual(fetched.result, { schemaVersion: 1, jobId, execution: "completed", acceptance: "unverified",
    summary: "Offline Codex review complete.", changedFiles: [], verification: [],
    limitations: ["Codex read-only worker policy is not host containment; output has no independent acceptance checks."],
    usage: { runtime: "codex", sessionId: "session-fixture", costUsd: null, inputTokens: 11, outputTokens: 7 } });
  const db = new DatabaseSync(join(directory, "jobs.sqlite"));
  try {
    const attempt = db.prepare("SELECT runtime_session_id,phase FROM attempts WHERE job_id=?").get(jobId) as { runtime_session_id: string; phase: string };
    assert.equal(attempt.runtime_session_id, "thread-fixture");
    assert.equal(attempt.phase, "completed");
  } finally { db.close(); }
  const messages = readFileSync(calls, "utf8").trim().split("\n").map(line => JSON.parse(line) as Record<string, unknown>);
  assert.deepEqual((messages.find(message => message.method === "thread/start")?.params as Record<string, unknown>), {
    model: "gpt-6-sol", modelProvider: "openai", cwd: directory, sandbox: "read-only",
    approvalPolicy: "on-request", approvalsReviewer: "user" });
  assert.equal(messages.filter(message => message.method === "turn/start").length, 1);
  assert.equal(messages.filter(message => message.method === "turn/interrupt").length, 0);
  daemons.splice(daemons.indexOf(daemon), 1);
  await daemon.close();
  const restarted = await daemonAt(directory);
  assert.deepEqual(ok(await request(restarted.socketPath, wire("restart-status", "status", { jobId }))).resolved, status.resolved);
  assert.deepEqual(ok(await request(restarted.socketPath, wire("restart-result", "result", { jobId }))).result, fetched.result);
  const duplicate = ok(await request(restarted.socketPath, wire("duplicate", "start", {
    task: "Review the offline fixture.", idempotencyKey: "complete", role: "codex-reviewer" })));
  assert.equal(duplicate.jobId, jobId);
  assert.equal(duplicate.deduplicated, true);
  assert.equal(readFileSync(calls, "utf8").trim().split("\n").filter(line => JSON.parse(line).method === "turn/start").length, 1);
  const followup = await request(restarted.socketPath, wire("followup", "followup", { jobId, task: "Continue", idempotencyKey: "followup" }));
  assert.equal(followup.ok, false);
  assert.equal((followup.error as Record<string, unknown>).code, "UNSUPPORTED_FOLLOWUP");
});

test("mismatched model and reroute fail closed with no accepted result", async () => {
  for (const mode of ["wrong-model", "reroute"]) {
    const { directory } = fixture(mode);
    const daemon = await daemonAt(directory);
    const jobId = await submit(daemon.socketPath, mode);
    const status = await waitForState(daemon.socketPath, jobId, ["interrupted", "failed"]);
    assert.equal(status.state, "interrupted", mode);
    const fetched = ok(await request(daemon.socketPath, wire(`result-${mode}`, "result", { jobId })));
    assert.equal(fetched.result, null);
    const db = new DatabaseSync(join(directory, "jobs.sqlite"));
    try {
      assert.equal((db.prepare("SELECT phase FROM attempts WHERE job_id=?").get(jobId) as { phase: string }).phase, "uncertain");
    } finally { db.close(); }
  }
});

test("cancellation requires matching interrupted turn confirmation", async () => {
  for (const [mode, expected] of [["confirm-interrupt", "cancelled"], ["unconfirmed-interrupt", "interrupted"]] as const) {
    const { directory, calls } = fixture(mode);
    const daemon = await daemonAt(directory);
    const jobId = await submit(daemon.socketPath, mode);
    await waitForState(daemon.socketPath, jobId, ["running"]);
    const cancelled = ok(await request(daemon.socketPath, wire(`cancel-${mode}`, "cancel", { jobId })));
    assert.equal(cancelled.state, "cancelling");
    const status = await waitForState(daemon.socketPath, jobId, [expected]);
    assert.equal(status.runtimeSessionId, "thread-fixture");
    const messages = readFileSync(calls, "utf8").trim().split("\n").map(line => JSON.parse(line) as Record<string, unknown>);
    assert.deepEqual(messages.find(message => message.method === "turn/interrupt")?.params,
      { threadId: "thread-fixture", turnId: "turn-fixture" });
    assert.equal(ok(await request(daemon.socketPath, wire(`result-${mode}`, "result", { jobId }))).result, null);
  }
});
