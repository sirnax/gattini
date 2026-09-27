import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, type Socket } from "node:net";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { afterEach, test } from "node:test";
import { startDaemon } from "../src/daemon/server.js";
import { RELEASE_VERSION } from "../src/core/release.js";

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
  const events = await invoke("events", job.jobId, "--after-sequence", "1", "--limit", "1");
  assert.equal(events.status, 0, events.stderr);
  const page = JSON.parse(events.stdout) as { jobId: string; nextSequence: number; events: Array<{ sequence: number }> };
  assert.equal(page.jobId, job.jobId);
  assert.equal(page.nextSequence, 2);
  assert.deepEqual(page.events.map(event => event.sequence), [2]);
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

test("daemon release mismatch fails before a job is persisted", async () => {
  const { daemon, path } = await daemonAt();
  const hello = result(await request(daemon.socketPath, { ...wire("hello", "hello", {}), clientVersion: RELEASE_VERSION }));
  assert.deepEqual(hello, { version: RELEASE_VERSION, protocolVersion: 1, databaseSchemaVersion: 7 });
  const mismatch = await request(daemon.socketPath, { ...wire("wrong_release", "start", {
    task: "must not persist", idempotencyKey: "wrong-release", role: "code",
  }), clientVersion: "0.0.9" });
  assert.equal(mismatch.ok, false);
  assert.equal((mismatch.error as Record<string, unknown>).code, "VERSION_MISMATCH");
  const db = new DatabaseSync(join(path, "jobs.sqlite"));
  try { assert.equal(db.prepare("SELECT count(*) AS count FROM jobs").get()?.count, 0); }
  finally { db.close(); }
});

test("empty and existing schema v1 databases migrate to v7; newer schemas are rejected", async () => {
  const emptyPath = tempDirectory();
  const { daemon: emptyDaemon } = await daemonAt(emptyPath);
  const emptyDb = new DatabaseSync(join(emptyPath, "jobs.sqlite"));
  assert.equal((emptyDb.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 7);
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
  assert.equal((migrated.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 7);
  migrated.close();

  const futurePath = tempDirectory();
  const futureDb = new DatabaseSync(join(futurePath, "jobs.sqlite"));
  futureDb.exec("PRAGMA user_version = 8");
  futureDb.close();
  await assert.rejects(startDaemon(futurePath), /Unsupported database schema version 8/);
  // Keep a reference assertion to ensure the empty database daemon remained usable.
  assert.equal((await request(emptyDaemon.socketPath, wire("empty", "status", { jobId: "missing" }))).ok, false);
});

test("schema v3 migration retains existing job, event, and attempt references", async () => {
  const path = tempDirectory();
  const dbPath = join(path, "jobs.sqlite");
  const old = new DatabaseSync(dbPath);
  old.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE jobs (
      id TEXT PRIMARY KEY, idempotency_key TEXT NOT NULL UNIQUE, input_digest TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('queued','running','cancelling','cancelled','completed','failed','interrupted')),
      job_json TEXT NOT NULL, config_json TEXT NOT NULL, result_json TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      runtime_session_id TEXT, resolved_json TEXT, scope_key TEXT
    );
    CREATE TABLE events (job_id TEXT NOT NULL REFERENCES jobs(id), sequence INTEGER NOT NULL,
      event_json TEXT NOT NULL, PRIMARY KEY (job_id, sequence));
    CREATE TABLE attempts (id TEXT PRIMARY KEY, job_id TEXT NOT NULL UNIQUE REFERENCES jobs(id),
      owner_token TEXT NOT NULL, phase TEXT NOT NULL, lease_expires_at TEXT NOT NULL,
      runtime_session_id TEXT, cancel_requested INTEGER NOT NULL DEFAULT 0);
    INSERT INTO jobs VALUES ('old-job','old-key','digest','completed','{}','{}','{}','2026-09-24','2026-09-24',NULL,NULL,NULL);
    INSERT INTO events VALUES ('old-job',1,'{}');
    INSERT INTO attempts VALUES ('old-attempt','old-job','old-owner','completed','2026-09-24',NULL,0);
    PRAGMA user_version = 3;
  `);
  old.close();
  await daemonAt(path);
  const migrated = new DatabaseSync(dbPath);
  assert.equal((migrated.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 7);
  assert.equal(migrated.prepare("SELECT count(*) AS n FROM jobs").get()?.n, 1);
  assert.equal(migrated.prepare("SELECT count(*) AS n FROM events").get()?.n, 1);
  assert.equal(migrated.prepare("SELECT count(*) AS n FROM attempts").get()?.n, 1);
  assert.equal(migrated.prepare("SELECT count(*) AS n FROM turn_results").get()?.n, 1);
  migrated.prepare("INSERT INTO attempts (id,job_id,owner_token,phase,lease_expires_at) VALUES (?,?,?,?,?)")
    .run("later-attempt", "old-job", "", "queued", "2026-09-25");
  assert.equal(migrated.prepare("SELECT count(*) AS n FROM attempts WHERE job_id='old-job'").get()?.n, 2);
  assert.deepEqual(migrated.prepare("PRAGMA foreign_key_check").all(), []);
  migrated.close();
});

test("state directory, database and socket have user-only permissions", async () => {
  const path = tempDirectory();
  const { daemon } = await daemonAt(path);
  assert.equal(statSync(path).mode & 0o777, 0o700);
  assert.equal(statSync(join(path, "jobs.sqlite")).mode & 0o777, 0o600);
  assert.equal(statSync(daemon.socketPath).mode & 0o777, 0o600);
});
