import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { connect, type Socket } from "node:net";
import { afterEach, test } from "node:test";
import { startDaemon } from "../src/daemon/server.js";

const directories: string[] = [];
const daemons: Array<{ close(): Promise<void> }> = [];
const previousPath = process.env.PATH;

function tempDirectory(): string {
  const path = mkdtempSync(join(tmpdir(), "gattini-opencode-integration-"));
  directories.push(path);
  return path;
}

afterEach(async () => {
  for (const daemon of daemons.splice(0)) await daemon.close();
  if (previousPath === undefined) delete process.env.PATH;
  else process.env.PATH = previousPath;
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

function fakeOpenCode(directory: string): { bin: string; calls: string } {
  const bin = join(directory, "bin");
  const calls = join(directory, "opencode-calls.log");
  const executable = join(bin, "opencode");
  // This fixture emulates only the documented CLI/API responses consumed by
  // the adapter; it never contacts a provider or starts a real OpenCode server.
const script = `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_OPENCODE_CALLS"
printf 'ENV_PWD=%s ACTUAL_PWD=%s\\n' "$PWD" "$(pwd)" >> "$FAKE_OPENCODE_CALLS"
case "$1" in
  --version) printf 'opencode v2.0.16\\n' ;;
  service)
    if [ "$2" = "status" ]; then printf 'http://127.0.0.1:4096\\n'; else exit 2; fi ;;
  debug)
    if [ "$FAKE_OPENCODE_MODE" = "bad-permission" ]; then
      printf '[{"id":"reviewer","permissions":[{"action":"edit","resource":"*","effect":"allow"}]}]\\n'
    else
      printf '[{"id":"reviewer","permissions":[{"action":"*","resource":"*","effect":"deny"},{"action":"read","resource":"*","effect":"allow"},{"action":"glob","resource":"*","effect":"allow"},{"action":"grep","resource":"*","effect":"allow"}]}]\\n'
    fi ;;
  models)
    if [ "$FAKE_OPENCODE_MODE" = "missing-model" ]; then printf 'provider/other-model\\n';
    else printf 'provider/reviewer-model\\n'; fi ;;
  run)
    sleep 0.15
    printf '%s\\n' '{"type":"step_start","sessionID":"ses_fixture123"}'
    printf '%s\\n' '{"type":"text","sessionID":"ses_fixture123","part":{"text":"Offline review complete."}}' ;;
  api)
    if [ "$2" = "session.active" ]; then printf '%s\\n' '{"data":{}}';
    else printf '%s\\n' '{"data":{"id":"ses_fixture123","agent":"reviewer","model":{"providerID":"provider","id":"reviewer-model"},"outcome":"succeeded","location":{"directory":"${directory}"}}}'; fi ;;
  stop) printf 'unexpected stop\\n' >> "$FAKE_OPENCODE_CALLS" ;;
  *) printf 'unexpected fake OpenCode arguments: %s\\n' "$*" >&2; exit 2 ;;
esac
`;
  mkdirSync(bin, { recursive: true });
  writeFileSync(executable, script, { mode: 0o700 });
  chmodSync(executable, 0o700);
  process.env.PATH = `${bin}${delimiter}${previousPath ?? ""}`;
  process.env.FAKE_OPENCODE_CALLS = calls;
  return { bin, calls };
}

function reviewerConfig(directory: string) {
  return {
    schemaVersion: 1,
    roles: { reviewer: {
      runtime: "opencode",
      agent: "reviewer",
      model: "provider/reviewer-model",
      directory,
      serverUrl: "http://127.0.0.1:4096",
      permissions: [
        { action: "*", resource: "*", effect: "deny" },
        { action: "read", resource: "*", effect: "allow" },
        { action: "glob", resource: "*", effect: "allow" },
        { action: "grep", resource: "*", effect: "allow" },
      ],
    } },
  };
}

async function daemonAt(directory: string) {
  const daemon = await startDaemon(directory);
  daemons.push(daemon);
  return daemon;
}

function wire(requestId: string, method: string, params: unknown) {
  return { protocolVersion: 1, requestId, method, params };
}

function request(path: string, body: unknown): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket: Socket = connect(path);
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

function disconnectAfterSubmit(path: string, body: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = connect(path);
    socket.on("connect", () => socket.write(`${JSON.stringify(body)}\n`));
    socket.on("data", () => { socket.destroy(); resolve(); });
    socket.on("error", reject);
  });
}

function result(response: Record<string, unknown>): Record<string, unknown> {
  assert.equal(response.ok, true, JSON.stringify(response));
  return response.result as Record<string, unknown>;
}

async function waitForResult(socketPath: string, jobId: string): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const status = result(await request(socketPath, wire(`status-${Date.now()}`, "status", { jobId })));
    if (status.state === "completed" || status.state === "failed") {
      return result(await request(socketPath, wire(`result-${Date.now()}`, "result", { jobId })));
    }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for job ${jobId}`);
}

test("reviewer job is daemon owned, persists exact OpenCode identity and result after client disconnect", async () => {
  const directory = tempDirectory();
  const { calls } = fakeOpenCode(directory);
  process.env.FAKE_OPENCODE_MODE = "ok";
  writeFileSync(join(directory, "roles.json"), JSON.stringify(reviewerConfig(directory)), { mode: 0o600 });
  const daemon = await daemonAt(directory);

  await disconnectAfterSubmit(daemon.socketPath, wire("review-submit", "start", {
    task: "Review the fixture repository read-only.", idempotencyKey: "review-job-1", role: "reviewer",
  }));
  const acceptedAgain = result(await request(daemon.socketPath, wire("review-reconnect", "start", {
    task: "Review the fixture repository read-only.", idempotencyKey: "review-job-1", role: "reviewer",
  })));
  const completed = await waitForResult(daemon.socketPath, String(acceptedAgain.jobId));
  const status = result(await request(daemon.socketPath, wire("review-status", "status", { jobId: acceptedAgain.jobId })));
  assert.equal(status.state, "completed", readFileSync(calls, "utf8"));
  assert.equal(status.runtimeSessionId, "ses_fixture123");
  assert.deepEqual(status.resolved, { runtimeVersion: "2.0.16", agent: "reviewer", model: "provider/reviewer-model" });
  const output = completed;
  assert.deepEqual(output.result, {
    schemaVersion: 1,
    jobId: status.jobId,
    execution: "completed",
    acceptance: "unverified",
    summary: "Offline review complete.",
    changedFiles: [],
    verification: [],
    limitations: ["Read-only OpenCode review; acceptance is not independently verified."],
  });
  const invocations = readFileSync(calls, "utf8");
  assert.match(invocations, /run --agent reviewer --model provider\/reviewer-model/);
  assert.match(invocations, /api session\.get --param sessionID=ses_fixture123/);
  assert.ok(invocations.includes(`ENV_PWD=${directory} ACTUAL_PWD=${directory}`));
  assert.doesNotMatch(invocations, /stop/);
});

test("reviewer model and permission preflight failures happen before runtime run", async () => {
  for (const mode of ["missing-model", "bad-permission"]) {
    const directory = tempDirectory();
    const { calls } = fakeOpenCode(directory);
    process.env.FAKE_OPENCODE_MODE = mode;
    writeFileSync(join(directory, "roles.json"), JSON.stringify(reviewerConfig(directory)), { mode: 0o600 });
    const daemon = await daemonAt(directory);
    const submitted = result(await request(daemon.socketPath, wire(`submit-${mode}`, "start", {
      task: "Reject during preflight.", idempotencyKey: `preflight-${mode}`, role: "reviewer",
    })));
    const fetched = await waitForResult(daemon.socketPath, String(submitted.jobId));
    assert.equal(fetched.state, "failed");
    assert.doesNotMatch(readFileSync(calls, "utf8"), /\nrun /, mode);
  }
});

test("duplicate reviewer idempotency key returns one durable job", async () => {
  const directory = tempDirectory();
  fakeOpenCode(directory);
  process.env.FAKE_OPENCODE_MODE = "ok";
  writeFileSync(join(directory, "roles.json"), JSON.stringify(reviewerConfig(directory)), { mode: 0o600 });
  const daemon = await daemonAt(directory);
  const submit = (requestId: string) => request(daemon.socketPath, wire(requestId, "start", {
    task: "Same review.", idempotencyKey: "duplicate-review", role: "reviewer",
  }));
  const first = result(await submit("dup-first"));
  const second = result(await submit("dup-second"));
  assert.equal(first.jobId, second.jobId);
  assert.equal(second.deduplicated, true);
});
