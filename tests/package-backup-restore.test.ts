import assert from "node:assert/strict";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { startDaemon } from "../src/daemon/server.js";

test("stopped-state backup restores jobs, configuration and evidence after migration", async () => {
  const root = mkdtempSync(join(tmpdir(), "gattini-release-migration-"));
  const state = join(root, "state");
  const backup = join(root, "backup");
  const restored = join(root, "restored");
  mkdirSync(join(state, "artifacts", "old-job"), { recursive: true, mode: 0o700 });
  const config = '{"schemaVersion":1,"roles":{}}\n';
  const evidence = "retained-evidence\n";
  writeFileSync(join(state, "roles.json"), config, { mode: 0o600 });
  writeFileSync(join(state, "artifacts", "old-job", "snapshot.json"), evidence, { mode: 0o600 });
  const old = new DatabaseSync(join(state, "jobs.sqlite"));
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
  try {
    // Rehearse a cold copy, then migrate only the working state.
    cpSync(state, backup, { recursive: true });
    const daemon = await startDaemon(state);
    await daemon.close();
    const migrated = new DatabaseSync(join(state, "jobs.sqlite"));
    assert.equal((migrated.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 7);
    assert.equal(migrated.prepare("SELECT count(*) AS n FROM turn_results").get()?.n, 1);
    assert.deepEqual(migrated.prepare("PRAGMA foreign_key_check").all(), []);
    migrated.close();
    assert.equal(readFileSync(join(state, "roles.json"), "utf8"), config);
    assert.equal(readFileSync(join(state, "artifacts", "old-job", "snapshot.json"), "utf8"), evidence);

    // Restore the untouched pre-migration copy and verify a second migration.
    cpSync(backup, restored, { recursive: true });
    chmodSync(restored, 0o700);
    const again = await startDaemon(restored);
    await again.close();
    const restoredDb = new DatabaseSync(join(restored, "jobs.sqlite"));
    assert.equal((restoredDb.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 7);
    assert.equal(restoredDb.prepare("SELECT count(*) AS n FROM jobs WHERE id='old-job'").get()?.n, 1);
    assert.equal(restoredDb.prepare("SELECT count(*) AS n FROM events WHERE job_id='old-job'").get()?.n, 1);
    assert.equal(restoredDb.prepare("SELECT count(*) AS n FROM turn_results WHERE job_id='old-job'").get()?.n, 1);
    assert.deepEqual(restoredDb.prepare("PRAGMA foreign_key_check").all(), []);
    restoredDb.close();
    assert.equal(readFileSync(join(restored, "roles.json"), "utf8"), config);
    assert.equal(readFileSync(join(restored, "artifacts", "old-job", "snapshot.json"), "utf8"), evidence);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
