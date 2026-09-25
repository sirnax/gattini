import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, type Socket } from "node:net";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { afterEach, test } from "node:test";
import { startDaemon } from "../src/daemon/server.js";

const directories: string[] = [];
const daemons: Array<{ close(): Promise<void> }> = [];

function tempDirectory(): string {
  const path = mkdtempSync(join(tmpdir(), "gattini-durable-test-"));
  directories.push(path);
  return path;
}

afterEach(async () => {
  for (const daemon of daemons.splice(0)) await daemon.close();
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

async function daemonAt(path = tempDirectory()) {
  const daemon = await startDaemon(path);
  daemons.push(daemon);
  return { daemon, path };
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

function wire(requestId: string, method: string, params: unknown, protocolVersion = 1) {
  return { protocolVersion, requestId, method, params };
}

function result(response: Record<string, unknown>): Record<string, unknown> {
  assert.equal(response.ok, true, JSON.stringify(response));
  return response.result as Record<string, unknown>;
}

test("two socket clients deduplicate the same request and persist one event set", async () => {
  const { daemon, path } = await daemonAt();
  const submission = () => request(daemon.socketPath, wire("start_req", "start", {
    task: "inspect the local contract", idempotencyKey: "duplicate-key", role: "code",
  }));
  const [first, second] = await Promise.all([submission(), submission()]);
  const firstJob = result(first);
  const secondJob = result(second);
  assert.equal(firstJob.jobId, secondJob.jobId);
  assert.equal(firstJob.state, "completed");
  assert.equal(secondJob.deduplicated, true);

  const db = new DatabaseSync(join(path, "jobs.sqlite"));
  try {
    const jobs = db.prepare("SELECT count(*) AS count FROM jobs").get() as { count: number };
    const events = db.prepare("SELECT count(*) AS count FROM events WHERE job_id = ?").get(String(firstJob.jobId)) as { count: number };
    assert.equal(jobs.count, 1);
    assert.ok(events.count > 0);
    assert.equal(db.prepare("SELECT count(*) AS count FROM events").get()?.count, events.count);
  } finally { db.close(); }
});

test("CLI submits and retrieves a fake job through the daemon", async () => {
  const { daemon, path } = await daemonAt();
  const taskFile = join(path, "task file.md");
  writeFileSync(taskFile, "Summarize the offline contract.");
  const cli = join(process.cwd(), "dist/src/cli/gattini.js");
  const invoke = (...args: string[]) => new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args, "--json"], {
      env: { ...process.env, GATTINI_STATE_DIR: path }, stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", chunk => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", status => resolve({ status, stdout, stderr }));
  });
  const start = await invoke("start", "--task-file", taskFile, "--idempotency-key", "cli-key");
  assert.equal(start.status, 0, start.stderr);
  const job = JSON.parse(start.stdout) as { jobId: string; state: string };
  assert.equal(job.state, "completed");
  const retrieved = await invoke("result", job.jobId);
  assert.equal(retrieved.status, 0, retrieved.stderr);
  assert.equal((JSON.parse(retrieved.stdout) as { jobId: string }).jobId, job.jobId);
  assert.ok(daemon.socketPath);
});

test("same idempotency key with a different payload returns a conflict", async () => {
  const { daemon } = await daemonAt();
  const submit = (task: string, requestId: string) => request(daemon.socketPath, wire(requestId, "start", {
    task, idempotencyKey: "same-key", role: "code",
  }));
  const created = result(await submit("first payload", "first"));
  const conflict = await submit("changed payload", "second");
  assert.equal(conflict.ok, false);
  assert.equal((conflict.error as Record<string, unknown>).code, "IDEMPOTENCY_CONFLICT");
  const persisted = result(await request(daemon.socketPath, wire("retrieve", "result", { jobId: created.jobId })));
  assert.equal(persisted.jobId, created.jobId);
});

test("completed jobs remain retrievable after daemon close and restart", async () => {
  const { daemon, path } = await daemonAt();
  const started = result(await request(daemon.socketPath, wire("start", "start", {
    task: "survive restart", idempotencyKey: "restart-key", role: "code",
  })));
  daemons.splice(daemons.indexOf(daemon), 1);
  await daemon.close();
  const restarted = await daemonAt(path);
  const retrieved = result(await request(restarted.daemon.socketPath, wire("result", "result", { jobId: started.jobId })));
  assert.equal(retrieved.jobId, started.jobId);
  assert.equal(retrieved.state, "completed");
  assert.ok(retrieved.result);
});

test("protocol mismatch and malformed JSON return typed request errors", async () => {
  const { daemon } = await daemonAt();
  const mismatch = await request(daemon.socketPath, wire("wrong_version", "status", { jobId: "unused" }, 99));
  assert.equal(mismatch.ok, false);
  assert.equal((mismatch.error as Record<string, unknown>).code, "PROTOCOL_MISMATCH");

  const malformed = await new Promise<Record<string, unknown>>((resolve, reject) => {
    const socket = connect(daemon.socketPath);
    let data = "";
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write("{broken json}\n"));
    socket.on("data", chunk => { data += chunk; });
    socket.on("end", () => {
      try { resolve(JSON.parse(data.trim()) as Record<string, unknown>); }
      catch (error) { reject(error); }
    });
    socket.on("error", reject);
  });
  assert.equal(malformed.ok, false);
  assert.equal((malformed.error as Record<string, unknown>).code, "INVALID_REQUEST");
});

test("empty and existing schema v1 databases migrate to v3; newer schemas are rejected", async () => {
  const emptyPath = tempDirectory();
  const { daemon: emptyDaemon } = await daemonAt(emptyPath);
  const emptyDb = new DatabaseSync(join(emptyPath, "jobs.sqlite"));
  assert.equal((emptyDb.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 3);
  emptyDb.close();

  const v1Path = tempDirectory();
  const v1Db = new DatabaseSync(join(v1Path, "jobs.sqlite"));
  v1Db.exec(`
    CREATE TABLE jobs (
      id TEXT PRIMARY KEY, idempotency_key TEXT NOT NULL UNIQUE, input_digest TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('queued','running','completed','failed','interrupted')),
      job_json TEXT NOT NULL, config_json TEXT NOT NULL, result_json TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE events (
      job_id TEXT NOT NULL REFERENCES jobs(id), sequence INTEGER NOT NULL,
      event_json TEXT NOT NULL, PRIMARY KEY (job_id, sequence)
    );
    PRAGMA user_version = 1;
  `);
  v1Db.close();
  await daemonAt(v1Path);
  const migrated = new DatabaseSync(join(v1Path, "jobs.sqlite"));
  assert.equal((migrated.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 3);
  migrated.close();

  const futurePath = tempDirectory();
  const futureDb = new DatabaseSync(join(futurePath, "jobs.sqlite"));
  futureDb.exec("PRAGMA user_version = 4");
  futureDb.close();
  await assert.rejects(startDaemon(futurePath), /Unsupported database schema version 4/);
  // Keep a reference assertion to ensure the empty database daemon remained usable.
  assert.equal((await request(emptyDaemon.socketPath, wire("empty", "status", { jobId: "missing" }))).ok, false);
});

test("state directory, database and socket have user-only permissions", async () => {
  const path = tempDirectory();
  const { daemon } = await daemonAt(path);
  assert.equal(statSync(path).mode & 0o777, 0o700);
  assert.equal(statSync(join(path, "jobs.sqlite")).mode & 0o777, 0o600);
  assert.equal(statSync(daemon.socketPath).mode & 0o777, 0o600);
});
