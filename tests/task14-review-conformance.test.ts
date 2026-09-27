import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { join, delimiter } from "node:path";
import { afterEach, test } from "node:test";
import { parseRuntimeResult } from "../src/core/contracts.js";
import { startDaemon, type RunningDaemon } from "../src/daemon/server.js";

const task = "Review the offline fixture read-only and report one finding.";
const directories: string[] = [];
const daemons: RunningDaemon[] = [];
const originalPath = process.env.PATH;
const originalCalls = process.env.FAKE_TASK14_OPENCODE_CALLS;
const originalMode = process.env.FAKE_TASK14_OPENCODE_MODE;

afterEach(async () => {
  for (const daemon of daemons.splice(0)) await daemon.close();
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
  if (originalCalls === undefined) delete process.env.FAKE_TASK14_OPENCODE_CALLS;
  else process.env.FAKE_TASK14_OPENCODE_CALLS = originalCalls;
  if (originalMode === undefined) delete process.env.FAKE_TASK14_OPENCODE_MODE;
  else process.env.FAKE_TASK14_OPENCODE_MODE = originalMode;
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture(runtime: "opencode" | "codex", mode = "complete") {
  const directory = mkdtempSync(`/private/tmp/gattini-task14-${runtime}-`);
  directories.push(directory);
  const calls = join(directory, "calls.log");
  if (runtime === "opencode") {
    const bin = join(directory, "bin");
    mkdirSync(bin);
    const executable = join(bin, "opencode");
    writeFileSync(executable, `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_TASK14_OPENCODE_CALLS"
case "$1" in
  --version) printf 'opencode v2.0.16\\n' ;;
  service) printf 'http://127.0.0.1:4096\\n' ;;
  debug) printf '[{"id":"reviewer","permissions":[{"action":"*","resource":"*","effect":"deny"},{"action":"read","resource":"*","effect":"allow"},{"action":"glob","resource":"*","effect":"allow"},{"action":"grep","resource":"*","effect":"allow"}]}]\\n' ;;
  models) printf 'provider/reviewer-model\\n' ;;
  run)
    printf '%s\\n' '{"type":"step_start","sessionID":"ses_task14"}'
    if [ "$FAKE_TASK14_OPENCODE_MODE" = "hold" ] || [ "$FAKE_TASK14_OPENCODE_MODE" = "uncertain" ]; then
      while [ ! -f '${directory}/interrupted' ]; do sleep 0.02; done
      exit 1
    fi
    printf '%s\\n' '{"type":"text","sessionID":"ses_task14","part":{"text":"Offline review complete."}}' ;;
  api)
    case "$2" in
      session.active)
        if [ "$FAKE_TASK14_OPENCODE_MODE" = "uncertain" ] || { [ "$FAKE_TASK14_OPENCODE_MODE" = "hold" ] && [ ! -f '${directory}/interrupted' ]; }; then printf '{"data":{"ses_task14":{"id":"ses_task14"}}}\\n';
        else printf '{"data":{}}\\n'; fi ;;
      session.interrupt) touch '${directory}/interrupted'; printf '{"interrupted":true}\\n' ;;
      session.get)
        if [ "$FAKE_TASK14_OPENCODE_MODE" = "uncertain" ]; then outcome=running;
        elif [ -f '${directory}/interrupted' ]; then outcome=interrupted;
        else outcome=succeeded; fi
        printf '{"data":{"id":"ses_task14","agent":"reviewer","model":{"providerID":"provider","id":"reviewer-model"},"outcome":"%s","location":{"directory":"${directory}"}}}\\n' "$outcome" ;;
    esac ;;
  stop) exit 9 ;;
  *) exit 9 ;;
esac
`, { mode: 0o700 });
    chmodSync(executable, 0o700);
    process.env.PATH = `${bin}${delimiter}${originalPath ?? ""}`;
    process.env.FAKE_TASK14_OPENCODE_CALLS = calls;
    process.env.FAKE_TASK14_OPENCODE_MODE = mode;
    writeFileSync(join(directory, "roles.json"), JSON.stringify({ schemaVersion: 1, roles: { reviewer: {
      runtime, agent: "reviewer", model: "provider/reviewer-model", directory,
      serverUrl: "http://127.0.0.1:4096", permissions: [
        { action: "*", resource: "*", effect: "deny" },
        { action: "read", resource: "*", effect: "allow" },
        { action: "glob", resource: "*", effect: "allow" },
        { action: "grep", resource: "*", effect: "allow" },
      ],
    } } }), { mode: 0o600 });
  } else {
    const executable = join(directory, "fake-codex");
    writeFileSync(executable, `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const directory = __dirname;
const mode = ${JSON.stringify(mode)};
if (process.argv.slice(2).join(" ") !== "app-server --listen stdio://") process.exit(9);
let input = "";
const send = value => process.stdout.write(JSON.stringify(value) + "\\n");
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => {
  input += chunk;
  let end;
  while ((end = input.indexOf("\\n")) >= 0) {
    const message = JSON.parse(input.slice(0, end));
    input = input.slice(end + 1);
    fs.appendFileSync(path.join(directory, "calls.log"), JSON.stringify(message) + "\\n");
    if (message.method === "initialize") send({ id: message.id, result: { userAgent: "offline-task14" } });
    if (message.method === "thread/start") {
      const p = message.params;
      send({ id: message.id, result: { thread: { id: "thread-task14", sessionId: "session-task14", cliVersion: "0.157.1",
        model: p.model, modelProvider: p.modelProvider, cwd: p.cwd }, model: p.model, modelProvider: p.modelProvider,
        cwd: p.cwd, approvalPolicy: "on-request", approvalsReviewer: "user", sandbox: { type: "readOnly", networkAccess: false } } });
    }
    if (message.method === "turn/start") {
      send({ id: message.id, result: { turn: { id: "turn-task14", status: "inProgress" } } });
      if (mode === "complete") setTimeout(() => {
        send({ method: "item/completed", params: { threadId: "thread-task14", turnId: "turn-task14", item: { type: "agentMessage", text: "Offline review complete." } } });
        send({ method: "thread/tokenUsage/updated", params: { threadId: "thread-task14", turnId: "turn-task14", tokenUsage: { last: { inputTokens: 11, outputTokens: 7, cachedInputTokens: 2, totalTokens: 18 } } } });
        send({ method: "turn/completed", params: { threadId: "thread-task14", turn: { id: "turn-task14", status: "completed" } } });
      }, 20);
    }
    if (message.method === "thread/turns/list") {
      send({ id: message.id, result: { data: [{ id: mode === "uncertain-wrong" ? "other-turn" : "turn-task14", status: "interrupted" }], nextCursor: null } });
    }
    if (message.method === "turn/interrupt") {
      send({ id: message.id, result: {} });
      if (mode === "hold") send({ method: "turn/completed", params: { threadId: "thread-task14", turn: { id: "turn-task14", status: "interrupted" } } });
      if (mode === "uncertain" || mode === "uncertain-wrong") setTimeout(() => process.exit(0), 20);
    }
  }
});
`, { mode: 0o700 });
    chmodSync(executable, 0o700);
    writeFileSync(join(directory, "roles.json"), JSON.stringify({ schemaVersion: 1, roles: { reviewer: {
      runtime, model: "gpt-6-sol", modelProvider: "openai", directory, executable,
    } } }), { mode: 0o600 });
  }
  return { directory, calls };
}

function wire(requestId: string, method: string, params: object) {
  return { protocolVersion: 1, requestId, method, params };
}

function request(socketPath: string, body: object): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket: Socket = connect(socketPath);
    let data = "";
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(`${JSON.stringify(body)}\n`));
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

async function daemonAt(directory: string) {
  const daemon = await startDaemon(directory);
  daemons.push(daemon);
  return daemon;
}

async function waitFor(socketPath: string, jobId: string, target: string, requireSession = false): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 7_000;
  let latest: Record<string, unknown> | null = null;
  while (Date.now() < deadline) {
    const status = ok(await request(socketPath, wire(`status-${Date.now()}`, "status", { jobId })));
    latest = status;
    if (status.state === target && (!requireSession || typeof status.runtimeSessionId === "string")) return status;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${target} on ${jobId}: ${JSON.stringify(latest)}`);
}

test("identical reviewer request has one common result contract under both private runtime mappings", async () => {
  const observations: Array<{ runtime: string; statusKeys: string[]; resultKeys: string[]; errorKeys: string[] }> = [];
  for (const runtime of ["opencode", "codex"] as const) {
    const { directory, calls } = fixture(runtime);
    const daemon = await daemonAt(directory);
    const params = { task, role: "reviewer", idempotencyKey: "same-review" };
    const first = ok(await request(daemon.socketPath, wire("start-1", "start", params)));
    const duplicate = ok(await request(daemon.socketPath, wire("start-2", "start", params)));
    assert.equal(duplicate.jobId, first.jobId);
    assert.equal(duplicate.deduplicated, true);
    const jobId = String(first.jobId);
    const status = await waitFor(daemon.socketPath, jobId, "completed");
    const fetched = ok(await request(daemon.socketPath, wire("result", "result", { jobId })));
    const output = parseRuntimeResult(fetched.result);
    assert.equal(output.jobId, jobId);
    assert.equal(output.execution, "completed");
    assert.equal(output.acceptance, "unverified");
    assert.equal(output.summary, "Offline review complete.");
    assert.deepEqual(output.changedFiles, []);
    assert.deepEqual(output.verification, []);
    assert.equal(output.usage?.runtime, runtime);
    assert.equal(output.usage?.costUsd, null);
    assert.equal(typeof status.createdAt, "string");
    assert.equal(typeof status.updatedAt, "string");
    assert.equal(fetched.state, "completed");
    const missing = await request(daemon.socketPath, wire("missing", "status", { jobId: "missing-job" }));
    assert.equal(missing.ok, false);
    assert.equal((missing.error as Record<string, unknown>).code, "NOT_FOUND");
    observations.push({ runtime, statusKeys: Object.keys(status).sort(), resultKeys: Object.keys(fetched).sort(),
      errorKeys: Object.keys(missing.error as object).sort() });

    if (runtime === "opencode") {
      assert.equal(status.runtimeSessionId, "ses_task14");
      assert.deepEqual(status.resolved, { runtimeVersion: "2.0.16", agent: "reviewer", model: "provider/reviewer-model" });
      assert.equal(output.usage?.sessionId, "ses_task14");
      assert.equal(output.usage?.inputTokens, null);
      const callsText = readFileSync(calls, "utf8");
      assert.equal(callsText.split("\n").filter(line => line.startsWith("run ")).length, 1);
      assert.match(callsText, /run --agent reviewer --model provider\/reviewer-model/);
      assert.ok(callsText.includes(task));
    } else {
      assert.equal(status.runtimeSessionId, "thread-task14");
      assert.deepEqual(status.resolved, { threadId: "thread-task14", sessionId: "session-task14", turnId: "turn-task14",
        cliVersion: "0.157.1", model: "gpt-6-sol", modelProvider: "openai" });
      assert.equal(output.usage?.sessionId, "session-task14");
      assert.equal(output.usage?.inputTokens, 11);
      assert.equal(output.usage?.outputTokens, 7);
      const messages = readFileSync(calls, "utf8").trim().split("\n").map(line => JSON.parse(line) as Record<string, unknown>);
      assert.equal(messages.filter(message => message.method === "turn/start").length, 1);
      assert.deepEqual(messages.find(message => message.method === "turn/start")?.params,
        { threadId: "thread-task14", input: [{ type: "text", text: task, text_elements: [] }] });
      assert.deepEqual(messages.find(message => message.method === "thread/start")?.params, {
        model: "gpt-6-sol", modelProvider: "openai", cwd: directory, sandbox: "read-only",
        approvalPolicy: "on-request", approvalsReviewer: "user" });
      const followup = await request(daemon.socketPath, wire("followup", "followup", {
        jobId, task: "Continue review.", idempotencyKey: "continue",
      }));
      assert.equal(followup.ok, false);
      assert.equal((followup.error as Record<string, unknown>).code, "UNSUPPORTED_FOLLOWUP");
    }
    daemons.splice(daemons.indexOf(daemon), 1);
    await daemon.close();
    const restarted = await daemonAt(directory);
    assert.deepEqual(ok(await request(restarted.socketPath, wire("restart-status", "status", { jobId }))), status);
    assert.deepEqual(ok(await request(restarted.socketPath, wire("restart-result", "result", { jobId }))), fetched);
  }
  assert.deepEqual(observations[0]?.statusKeys, observations[1]?.statusKeys);
  assert.deepEqual(observations[0]?.resultKeys, observations[1]?.resultKeys);
  assert.deepEqual(observations[0]?.errorKeys, observations[1]?.errorKeys);
});

test("both reviewer mappings cancel only their exact runtime turn or session", async () => {
  for (const runtime of ["opencode", "codex"] as const) {
    const { directory, calls } = fixture(runtime, "hold");
    const daemon = await daemonAt(directory);
    const accepted = ok(await request(daemon.socketPath, wire("start", "start", {
      task, role: "reviewer", idempotencyKey: "cancel-review",
    })));
    const jobId = String(accepted.jobId);
    const running = await waitFor(daemon.socketPath, jobId, "running", true);
    assert.equal(running.runtimeSessionId, runtime === "opencode" ? "ses_task14" : "thread-task14");
    const cancel = ok(await request(daemon.socketPath, wire("cancel", "cancel", { jobId })));
    assert.equal(cancel.state, "cancelling");
    const final = await waitFor(daemon.socketPath, jobId, "cancelled");
    assert.equal(final.runtimeSessionId, running.runtimeSessionId);
    assert.equal(ok(await request(daemon.socketPath, wire("cancel-result", "result", { jobId }))).result, null);
    const callsText = readFileSync(calls, "utf8");
    if (runtime === "opencode") {
      assert.match(callsText, /api session\.interrupt --param sessionID=ses_task14 --param resume=false/);
      assert.match(callsText, /api session\.active/);
      assert.match(callsText, /api session\.get --param sessionID=ses_task14/);
      assert.doesNotMatch(callsText, /(^|\n)stop/);
    } else {
      const messages = callsText.trim().split("\n").map(line => JSON.parse(line) as Record<string, unknown>);
      assert.deepEqual(messages.find(message => message.method === "turn/interrupt")?.params,
        { threadId: "thread-task14", turnId: "turn-task14" });
    }
  }
});

test("an interrupt acknowledgement without runtime completion stays uncertain for either reviewer mapping", async () => {
  for (const runtime of ["opencode", "codex"] as const) {
    const { directory } = fixture(runtime, "uncertain");
    const daemon = await daemonAt(directory);
    const accepted = ok(await request(daemon.socketPath, wire("start", "start", {
      task, role: "reviewer", idempotencyKey: "uncertain-review",
    })));
    const jobId = String(accepted.jobId);
    await waitFor(daemon.socketPath, jobId, "running", true);
    assert.equal(ok(await request(daemon.socketPath, wire("cancel", "cancel", { jobId }))).state, "cancelling");
    const status = await waitFor(daemon.socketPath, jobId, "interrupted");
    assert.equal(status.runtimeSessionId, runtime === "opencode" ? "ses_task14" : "thread-task14");
    assert.equal(ok(await request(daemon.socketPath, wire("result", "result", { jobId }))).result, null);
  }
});

test("Codex uncertain cancellation reconciles only from its exact persisted interrupted turn", async () => {
  for (const [mode, expected] of [["uncertain", "cancelled"], ["uncertain-wrong", "interrupted"]] as const) {
    const { directory, calls } = fixture("codex", mode);
    const daemon = await daemonAt(directory);
    const started = ok(await request(daemon.socketPath, wire(`start-${mode}`, "start", {
      task, role: "reviewer", idempotencyKey: `reconcile-${mode}`,
    })));
    const jobId = String(started.jobId);
    await waitFor(daemon.socketPath, jobId, "running", true);
    assert.equal(ok(await request(daemon.socketPath, wire(`cancel-${mode}`, "cancel", { jobId }))).state, "cancelling");
    await waitFor(daemon.socketPath, jobId, "interrupted");
    daemons.splice(daemons.indexOf(daemon), 1);
    await daemon.close();
    const restarted = await daemonAt(directory);
    await waitFor(restarted.socketPath, jobId, expected);
    const queryDeadline = Date.now() + 7_000;
    while (Date.now() < queryDeadline && !readFileSync(calls, "utf8").includes('"method":"thread/turns/list"')) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    const messages = readFileSync(calls, "utf8").trim().split("\n").map(line => JSON.parse(line) as Record<string, unknown>);
    assert.equal(messages.filter(message => message.method === "turn/start").length, 1);
    assert.equal(messages.filter(message => message.method === "thread/turns/list").length, 1);
    assert.equal(ok(await request(restarted.socketPath, wire(`result-${mode}`, "result", { jobId }))).result, null);
  }
});
