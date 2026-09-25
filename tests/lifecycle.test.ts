import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { connect, type Socket } from "node:net";
import { afterEach, test } from "node:test";
import { JobStore } from "../src/daemon/store.js";
import { startDaemon } from "../src/daemon/server.js";

const directories: string[] = [];
const daemons: Array<{ close(): Promise<void> }> = [];
const previousPath = process.env.PATH;
const previousCalls = process.env.FAKE_OPENCODE_CALLS;
const previousMode = process.env.FAKE_LIFECYCLE_MODE;

function tempDirectory(): string {
  const path = mkdtempSync(join(tmpdir(), "gattini-lifecycle-"));
  directories.push(path);
  return path;
}

afterEach(async () => {
  for (const daemon of daemons.splice(0)) await daemon.close();
  if (previousPath === undefined) delete process.env.PATH;
  else process.env.PATH = previousPath;
  for (const [key, value] of [["FAKE_OPENCODE_CALLS", previousCalls], ["FAKE_LIFECYCLE_MODE", previousMode]] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

function fakeOpenCode(directory: string): { calls: string; flags: string } {
  const bin = join(directory, "bin");
  const calls = join(directory, "calls.log");
  const flags = join(directory, "flags");
  const executable = join(bin, "opencode");
  const script = `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_OPENCODE_CALLS"
case "$1" in
  --version) printf 'opencode v2.0.16\\n' ;;
  service) printf 'http://127.0.0.1:4096\\n' ;;
  debug) printf '[{"id":"reviewer","permissions":[{"action":"*","resource":"*","effect":"deny"},{"action":"read","resource":"*","effect":"allow"},{"action":"glob","resource":"*","effect":"allow"},{"action":"grep","resource":"*","effect":"allow"}]}]\\n' ;;
  models) printf 'provider/reviewer-model\\n' ;;
  run)
    printf '%s\\n' '{"type":"step_start","sessionID":"ses_lifecycle123"}'
    while [ ! -f '${flags}/release-run' ] && [ ! -f '${flags}/interrupt-called' ]; do sleep 0.02; done
    if [ -f '${flags}/interrupt-called' ]; then exit 1; fi
    printf '%s\\n' '{"type":"text","sessionID":"ses_lifecycle123","part":{"text":"Offline review complete."}}'
    ;;
  api)
    case "$2" in
      session.active)
        if [ "$FAKE_LIFECYCLE_MODE" = "confirmed" ] && [ -f '${flags}/interrupt-called' ]; then printf '{"data":{}}\\n';
        else printf '{"data":{"ses_lifecycle123":{"id":"ses_lifecycle123"}}}\\n'; fi ;;
      session.interrupt)
        touch '${flags}/interrupt-called'
        printf '{"interrupted":true}\\n' ;;
      session.get)
        if [ "$FAKE_LIFECYCLE_MODE" = "confirmed" ] && [ -f '${flags}/interrupt-called' ]; then outcome=interrupted; else outcome=running; fi
        printf '{"data":{"id":"ses_lifecycle123","agent":"reviewer","model":{"providerID":"provider","id":"reviewer-model"},"outcome":"%s","location":{"directory":"${directory}"}}}\\n' "$outcome" ;;
    esac ;;
  stop) touch '${flags}/unexpected-stop' ;;
  *) printf 'unexpected fake OpenCode arguments: %s\\n' "$*" >&2; exit 2 ;;
esac
`;
  mkdirSync(bin, { recursive: true });
  mkdirSync(flags);
  writeFileSync(executable, script, { mode: 0o700 });
  chmodSync(executable, 0o700);
  process.env.PATH = `${bin}${delimiter}${previousPath ?? ""}`;
  process.env.FAKE_OPENCODE_CALLS = calls;
  return { calls, flags };
}

function reviewerConfig(directory: string) {
  return { schemaVersion: 1, roles: { reviewer: {
    runtime: "opencode", agent: "reviewer", model: "provider/reviewer-model", directory,
    serverUrl: "http://127.0.0.1:4096",
    permissions: [
      { action: "*", resource: "*", effect: "deny" },
      { action: "read", resource: "*", effect: "allow" },
      { action: "glob", resource: "*", effect: "allow" },
      { action: "grep", resource: "*", effect: "allow" },
    ],
  } } };
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

function result(response: Record<string, unknown>): Record<string, unknown> {
  assert.equal(response.ok, true, JSON.stringify(response));
  return response.result as Record<string, unknown>;
}

async function waitFor(path: string, jobId: string, predicate: (status: Record<string, unknown>) => boolean, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const status = result(await request(path, wire(`poll-${Date.now()}`, "status", { jobId })));
    if (predicate(status)) return status;
    await new Promise(resolve => setTimeout(resolve, 15));
  }
  throw new Error(`Timed out waiting for job ${jobId}`);
}

async function daemonAt(directory: string) {
  const daemon = await startDaemon(directory);
  daemons.push(daemon);
  return daemon;
}

async function submit(path: string, key: string): Promise<string> {
  const accepted = result(await request(path, wire(`submit-${key}`, "start", {
    task: "Wait for lifecycle control.", idempotencyKey: key, role: "reviewer",
  })));
  return String(accepted.jobId);
}

test("exact-session cancel is confirmed only after interrupted outcome and inactive V2 session", async () => {
  const directory = tempDirectory();
  const { calls, flags } = fakeOpenCode(directory);
  process.env.FAKE_LIFECYCLE_MODE = "confirmed";
  writeFileSync(join(directory, "roles.json"), JSON.stringify(reviewerConfig(directory)), { mode: 0o600 });
  const daemon = await daemonAt(directory);
  const jobId = await submit(daemon.socketPath, "cancel-confirmed");
  await waitFor(daemon.socketPath, jobId, status => status.state === "running" && status.runtimeSessionId === "ses_lifecycle123");
  const cancel = result(await request(daemon.socketPath, wire("cancel-running", "cancel", { jobId })));
  assert.equal(cancel.state, "cancelling");
  const status = await waitFor(daemon.socketPath, jobId, value => value.state === "cancelled", 5000);
  assert.equal(status.runtimeSessionId, "ses_lifecycle123");
  const invocations = readFileSync(calls, "utf8");
  assert.match(invocations, /api session\.interrupt --param sessionID=ses_lifecycle123 --param resume=false/);
  assert.match(invocations, /api session\.active/);
  assert.match(invocations, /api session\.get --param sessionID=ses_lifecycle123/);
  assert.doesNotMatch(invocations, /(^|\n)stop/);
  assert.equal(await import("node:fs").then(fs => fs.existsSync(join(flags, "unexpected-stop"))), false);
});

test("interrupt acknowledgement with an active session remains interrupted and blocks same scope", async () => {
  const directory = tempDirectory();
  const { calls } = fakeOpenCode(directory);
  process.env.FAKE_LIFECYCLE_MODE = "still-active";
  writeFileSync(join(directory, "roles.json"), JSON.stringify(reviewerConfig(directory)), { mode: 0o600 });
  const daemon = await daemonAt(directory);
  const jobId = await submit(daemon.socketPath, "cancel-uncertain");
  await waitFor(daemon.socketPath, jobId, status => status.state === "running" && status.runtimeSessionId === "ses_lifecycle123");
  result(await request(daemon.socketPath, wire("cancel-uncertain-request", "cancel", { jobId })));
  const status = await waitFor(daemon.socketPath, jobId, value => value.state === "interrupted", 7000);
  assert.equal(status.runtimeSessionId, "ses_lifecycle123");
  const blocked = await request(daemon.socketPath, wire("same-scope", "start", {
    task: "Must not overlap uncertain work.", idempotencyKey: "blocked-scope", role: "reviewer",
  }));
  assert.equal(blocked.ok, false);
  assert.equal((blocked.error as Record<string, unknown>).code, "SCOPE_BLOCKED");
  assert.doesNotMatch(readFileSync(calls, "utf8"), /(^|\n)stop/);
});

test("queued cancellation is terminal without launching OpenCode", async () => {
  const directory = tempDirectory();
  const { calls } = fakeOpenCode(directory);
  const roles = reviewerConfig(directory);
  const store = new JobStore(join(directory, "jobs.sqlite"));
  const job = store.enqueueReview({ task: "queued", idempotencyKey: "queued", role: "reviewer", config: roles.roles.reviewer });
  assert.equal(store.requestCancel(job.jobId).state, "cancelled");
  assert.equal(store.status(job.jobId).state, "cancelled");
  store.close();
  assert.equal(readFileSafe(calls), "");
});

test("daemon restart retains an uncertain exact handle, expires the old lease, and never requeues it", async () => {
  const directory = tempDirectory();
  fakeOpenCode(directory);
  const role = reviewerConfig(directory).roles.reviewer;
  const database = join(directory, "jobs.sqlite");
  const first = new JobStore(database);
  const submitted = first.enqueueReview({ task: "may have reached runtime", idempotencyKey: "restart-uncertain", role: "reviewer", config: role });
  const attemptId = first.claimReview(submitted.jobId);
  first.recordReviewEvent(submitted.jobId, attemptId, { type: "step_start", sessionID: "ses_lifecycle123" });
  first.close();

  const restarted = new JobStore(database);
  assert.equal(restarted.status(submitted.jobId).state, "interrupted");
  assert.equal(restarted.status(submitted.jobId).runtimeSessionId, "ses_lifecycle123");
  assert.deepEqual(restarted.pendingReviews(), []);
  assert.throws(() => restarted.completeReview(submitted.jobId, attemptId, "ses_lifecycle123", "stale completion", {
    runtimeVersion: "2.0.16", agent: "reviewer", model: "provider/reviewer-model",
  }), /Stale or mismatched attempt/);
  assert.throws(() => restarted.enqueueReview({
    task: "conflicting retry", idempotencyKey: "restart-retry", role: "reviewer", config: role,
  }), (error: unknown) => typeof error === "object" && error !== null && "code" in error && error.code === "SCOPE_BLOCKED");
  restarted.close();
});

test("restart recovers untouched queued work but interrupts an unbound launch without replay", async () => {
  const queuedDirectory = tempDirectory();
  fakeOpenCode(queuedDirectory);
  const queuedRole = reviewerConfig(queuedDirectory).roles.reviewer;
  const queuedDb = join(queuedDirectory, "jobs.sqlite");
  const queuedStore = new JobStore(queuedDb);
  const queued = queuedStore.enqueueReview({ task: "not yet claimed", idempotencyKey: "queued-restart", role: "reviewer", config: queuedRole });
  queuedStore.close();
  const queuedRestart = new JobStore(queuedDb);
  assert.equal(queuedRestart.status(queued.jobId).state, "queued");
  assert.deepEqual(queuedRestart.pendingReviews().map(item => item.jobId), [queued.jobId]);
  queuedRestart.close();

  const launchingDirectory = tempDirectory();
  fakeOpenCode(launchingDirectory);
  const launchRole = reviewerConfig(launchingDirectory).roles.reviewer;
  const launchDb = join(launchingDirectory, "jobs.sqlite");
  const launchingStore = new JobStore(launchDb);
  const launching = launchingStore.enqueueReview({ task: "launch may have escaped", idempotencyKey: "launch-restart", role: "reviewer", config: launchRole });
  const oldAttempt = launchingStore.claimReview(launching.jobId);
  launchingStore.close();

  const launchingRestart = new JobStore(launchDb);
  assert.equal(launchingRestart.status(launching.jobId).state, "interrupted");
  assert.equal(launchingRestart.status(launching.jobId).runtimeSessionId, null);
  assert.deepEqual(launchingRestart.pendingReviews(), []);
  assert.throws(() => launchingRestart.completeReview(launching.jobId, oldAttempt, "ses_lifecycle123", "stale PID/session reuse", {
    runtimeVersion: "2.0.16", agent: "reviewer", model: "provider/reviewer-model",
  }), /Stale or mismatched attempt/);
  assert.equal(launchingRestart.requestCancel(launching.jobId).state, "interrupted");
  launchingRestart.close();
});

test("a successful review can finish while cancellation is in flight", () => {
  const directory = tempDirectory();
  const store = new JobStore(join(directory, "jobs.sqlite"));
  const role = reviewerConfig(directory).roles.reviewer;
  const job = store.enqueueReview({ task: "racing completion", idempotencyKey: "completion-race", role: "reviewer", config: role });
  const attempt = store.claimReview(job.jobId);
  store.recordReviewEvent(job.jobId, attempt, { type: "step_start", sessionID: "ses_lifecycle123" });
  assert.equal(store.requestCancel(job.jobId).state, "cancelling");
  store.cancelUncertain(job.jobId);
  store.completeReview(job.jobId, attempt, "ses_lifecycle123", "The review finished before interrupt.", {
    runtimeVersion: "2.0.16", agent: "reviewer", model: "provider/reviewer-model",
  });
  store.confirmCancelled(job.jobId, "ses_lifecycle123");
  assert.equal(store.status(job.jobId).state, "completed");
  assert.equal(store.result(job.jobId).result?.summary, "The review finished before interrupt.");
  store.close();
});

test("exact-session success after a crash releases the scope without inventing review output", () => {
  const directory = tempDirectory();
  const database = join(directory, "jobs.sqlite");
  const role = reviewerConfig(directory).roles.reviewer;
  const first = new JobStore(database);
  const job = first.enqueueReview({ task: "lost output", idempotencyKey: "success-reconcile", role: "reviewer", config: role });
  const attempt = first.claimReview(job.jobId);
  first.recordReviewEvent(job.jobId, attempt, { type: "step_start", sessionID: "ses_lifecycle123" });
  first.close();
  const restarted = new JobStore(database);
  restarted.reconcileTerminal(job.jobId, "ses_lifecycle123", "succeeded", false);
  assert.equal(restarted.status(job.jobId).state, "failed");
  assert.equal(restarted.result(job.jobId).result?.execution, "completed");
  assert.equal(restarted.result(job.jobId).result?.acceptance, "unverified");
  assert.ok(restarted.enqueueReview({ task: "next review", idempotencyKey: "after-reconcile", role: "reviewer", config: role }).jobId);
  restarted.close();
});

test("a directory alias cannot bypass an active scope lock", () => {
  const directory = tempDirectory();
  const alias = join(tempDirectory(), "alias");
  symlinkSync(directory, alias, "dir");
  const store = new JobStore(join(directory, "jobs.sqlite"));
  const role = reviewerConfig(directory).roles.reviewer;
  store.enqueueReview({ task: "first review", idempotencyKey: "canonical", role: "reviewer", config: role });
  assert.throws(() => store.enqueueReview({
    task: "aliased review", idempotencyKey: "alias", role: "reviewer", config: { ...role, directory: alias },
  }), (error: unknown) => typeof error === "object" && error !== null && "code" in error && error.code === "SCOPE_BLOCKED");
  store.close();
});

function readFileSafe(path: string): string {
  try { return readFileSync(path, "utf8"); } catch { return ""; }
}
