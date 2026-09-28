import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { startDaemon } from "../src/daemon/server.js";
import { RELEASE_VERSION } from "../src/core/release.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

function directory(): string {
  const path = mkdtempSync(join(tmpdir(), "gattini-cli-run-"));
  cleanup.push(async () => rmSync(path, { recursive: true, force: true }));
  writeFileSync(join(path, "task.md"), "Inspect the bounded task.");
  return path;
}

function invoke(path: string, ...args: string[]) {
  const child = spawn(process.execPath, [join(process.cwd(), "dist/src/cli/gattini.js"), ...args], {
    env: { ...process.env, GATTINI_STATE_DIR: path }, stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", chunk => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
  const done = new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", code => resolve({ code, stdout, stderr }));
  });
  return { child, done };
}

test("help succeeds without a running daemon", async () => {
  const path = directory();
  for (const flag of ["--help", "-h", "help"]) {
    const outcome = await invoke(path, flag).done;
    assert.equal(outcome.code, 0);
    assert.equal(outcome.stderr, "");
    assert.match(outcome.stdout, /^Usage:\n/);
    assert.match(outcome.stdout, /gattini run --task-file/);
  }
});

async function mock(path: string, handler: (method: string, params: Record<string, unknown>) => unknown): Promise<void> {
  const server: Server = createServer(socket => {
    let input = "";
    socket.setEncoding("utf8").on("data", chunk => {
      input += chunk;
      if (!input.endsWith("\n")) return;
      const request = JSON.parse(input) as { protocolVersion: number; requestId: string; method: string; params: Record<string, unknown> };
      try {
        const result = request.method === "hello" ? { version: RELEASE_VERSION, protocolVersion: 2, databaseSchemaVersion: 7 } : handler(request.method, request.params);
        socket.end(JSON.stringify({ protocolVersion: 2, requestId: request.requestId, ok: true, result }) + "\n");
      } catch (error) {
        socket.end(JSON.stringify({ protocolVersion: 2, requestId: request.requestId, ok: false,
          error: { code: "NOT_FOUND", message: error instanceof Error ? error.message : "error" } }) + "\n");
      }
    });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(join(path, "gattinid.sock"), resolve); });
  cleanup.push(() => new Promise<void>(resolve => server.close(() => resolve())));
}

test("run returns one terminal JSON envelope from the durable fake job", async () => {
  const path = directory();
  const daemon = await startDaemon(path);
  cleanup.push(() => daemon.close());
  const { code, stdout, stderr } = await invoke(path, "run", "--task-file", join(path, "task.md"), "--idempotency-key", "run-fake", "--json").done;
  assert.equal(code, 0, stderr);
  assert.equal(stderr, "");
  assert.equal(stdout.trim().split("\n").length, 1);
  const envelope = JSON.parse(stdout) as { jobId: string; state: string; result: { acceptance: string } };
  assert.equal(envelope.state, "completed");
  assert.equal(envelope.result.acceptance, "unverified");
  const replay = await invoke(path, "run", "--task-file", join(path, "task.md"), "--idempotency-key", "run-fake", "--json").done;
  assert.equal((JSON.parse(replay.stdout) as { jobId: string }).jobId, envelope.jobId);
});

test("run polls, then returns the final envelope and failed acceptance exit 1", async () => {
  const path = directory();
  let polls = 0;
  await mock(path, method => {
    if (method === "start") return { jobId: "job-1", state: "queued" };
    if (method === "status") return { jobId: "job-1", state: ++polls === 1 ? "running" : "completed" };
    if (method === "result") return { jobId: "job-1", state: "completed", result: { execution: "completed", acceptance: "failed" } };
    throw new Error("unexpected method");
  });
  const outcome = await invoke(path, "run", "--task-file", join(path, "task.md"), "--idempotency-key", "poll", "--poll-ms", "100", "--json").done;
  assert.equal(outcome.code, 1);
  assert.equal(polls, 2);
  assert.equal((JSON.parse(outcome.stdout) as { result: { acceptance: string } }).result.acceptance, "failed");
});

test("approval pauses run with exact job and approval IDs and exit 4", async () => {
  const path = directory();
  await mock(path, method => {
    assert.equal(method, "start");
    return { jobId: "job-approval", state: "awaiting-approval", approvalId: "approval-1" };
  });
  const outcome = await invoke(path, "run", "--task-file", join(path, "task.md"), "--idempotency-key", "approve", "--json").done;
  assert.equal(outcome.code, 4);
  assert.deepEqual(JSON.parse(outcome.stdout), { jobId: "job-approval", state: "awaiting-approval", approvalId: "approval-1" });
  assert.equal(outcome.stderr, "");
});

test("daemon errors and invalid input use stderr JSON with empty stdout", async () => {
  const path = directory();
  await mock(path, () => { throw new Error("Job not found"); });
  const missing = await invoke(path, "result", "wrong-id", "--json").done;
  assert.equal(missing.code, 3);
  assert.equal(missing.stdout, "");
  assert.equal((JSON.parse(missing.stderr) as { error: { code: string } }).error.code, "NOT_FOUND");
  const invalid = await invoke(path, "run", "--task-file", join(path, "task.md"), "--idempotency-key", "x", "--poll-ms", "99", "--json").done;
  assert.equal(invalid.code, 2);
  assert.equal(invalid.stdout, "");
  assert.equal((JSON.parse(invalid.stderr) as { error: { code: string } }).error.code, "INVALID_INPUT");
});

test("SIGINT leaves a waiting job running by default", async () => {
  const path = directory();
  let statusSeen!: () => void;
  const seen = new Promise<void>(resolve => { statusSeen = resolve; });
  let cancelled = false;
  await mock(path, method => {
    if (method === "start") return { jobId: "job-wait", state: "queued" };
    if (method === "status") { statusSeen(); return { jobId: "job-wait", state: "running" }; }
    if (method === "cancel") cancelled = true;
    return {};
  });
  const running = invoke(path, "run", "--task-file", join(path, "task.md"), "--idempotency-key", "signal", "--poll-ms", "100", "--json");
  await seen;
  running.child.kill("SIGINT");
  const outcome = await running.done;
  assert.equal(outcome.code, 130);
  assert.equal(outcome.stdout, "");
  assert.match(outcome.stderr, /job-wait continues/);
  assert.equal(cancelled, false);
});

test("explicit cancel-on-interrupt sends cancellation for the exact job", async () => {
  const path = directory();
  let statusSeen!: () => void;
  const seen = new Promise<void>(resolve => { statusSeen = resolve; });
  const cancelled: unknown[] = [];
  await mock(path, (method, params) => {
    if (method === "start") return { jobId: "job-cancel", state: "queued" };
    if (method === "status") { statusSeen(); return { jobId: "job-cancel", state: "running" }; }
    if (method === "cancel") { cancelled.push(params.jobId); return { jobId: "job-cancel", state: "cancelling" }; }
    throw new Error("unexpected method");
  });
  const running = invoke(path, "run", "--task-file", join(path, "task.md"), "--idempotency-key", "cancel", "--poll-ms", "100", "--cancel-on-interrupt", "--json");
  await seen;
  running.child.kill("SIGINT");
  const outcome = await running.done;
  assert.equal(outcome.code, 130);
  assert.equal(outcome.stdout, "");
  assert.deepEqual(cancelled, ["job-cancel"]);
});

test("daemon loss reports a durable exact job ID without a second submission", async () => {
  const path = directory();
  let starts = 0;
  await mock(path, method => {
    if (method === "start") { starts++; return { jobId: "job-disconnect", state: "queued" }; }
    throw new Error("Job not found");
  });
  const outcome = await invoke(path, "run", "--task-file", join(path, "task.md"), "--idempotency-key", "disconnect", "--poll-ms", "100", "--json").done;
  assert.equal(outcome.code, 3);
  assert.equal(outcome.stdout, "");
  assert.match((JSON.parse(outcome.stderr) as { error: { message: string } }).error.message, /job-disconnect remains durable/);
  assert.equal(starts, 1);
});
