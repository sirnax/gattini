import { createHash, randomUUID } from "node:crypto";
import { chmodSync, realpathSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { runFakeTask } from "../adapters/fake.js";
import { parseJob, parseRuntimeConfig, parseRuntimeEvent, parseRuntimeResult, type RuntimeResult } from "../core/contracts.js";
import { ProtocolError } from "../core/protocol.js";

type State = "queued" | "running" | "cancelling" | "cancelled" | "completed" | "failed" | "interrupted";
type JobRow = { id: string; idempotency_key: string; input_digest: string; state: State; created_at: string; updated_at: string; result_json: string | null; runtime_session_id: string | null; resolved_json: string | null; scope_key: string | null; config_json: string; job_json: string };

export class JobStore {
  private readonly db: DatabaseSync;
  private readonly ownerToken = randomUUID();

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    if (path !== ":memory:") chmodSync(path, 0o600);
    this.db.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    const version = (this.db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
    if (version > 3) throw new Error(`Unsupported database schema version ${version}`);
    if (version === 0) {
      this.transaction(() => {
        this.db.exec(`
          CREATE TABLE jobs (
            id TEXT PRIMARY KEY,
            idempotency_key TEXT NOT NULL UNIQUE,
            input_digest TEXT NOT NULL,
            state TEXT NOT NULL CHECK (state IN ('queued','running','completed','failed','interrupted')),
            job_json TEXT NOT NULL,
            config_json TEXT NOT NULL,
            result_json TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          );
          CREATE TABLE events (
            job_id TEXT NOT NULL REFERENCES jobs(id),
            sequence INTEGER NOT NULL,
            event_json TEXT NOT NULL,
            PRIMARY KEY (job_id, sequence)
          );
          PRAGMA user_version = 1;
        `);
      });
    }
    if (version < 2) {
      this.transaction(() => {
        this.db.exec("ALTER TABLE jobs ADD COLUMN runtime_session_id TEXT; ALTER TABLE jobs ADD COLUMN resolved_json TEXT; PRAGMA user_version = 2;");
      });
    }
    if (version < 3) {
      this.db.exec("PRAGMA foreign_keys = OFF");
      try {
        this.transaction(() => {
          this.db.exec(`
            CREATE TABLE jobs_v3 (
              id TEXT PRIMARY KEY, idempotency_key TEXT NOT NULL UNIQUE, input_digest TEXT NOT NULL,
              state TEXT NOT NULL CHECK (state IN ('queued','running','cancelling','cancelled','completed','failed','interrupted')),
              job_json TEXT NOT NULL, config_json TEXT NOT NULL, result_json TEXT,
              created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
              runtime_session_id TEXT, resolved_json TEXT, scope_key TEXT
            );
            INSERT INTO jobs_v3 (id,idempotency_key,input_digest,state,job_json,config_json,result_json,created_at,updated_at,runtime_session_id,resolved_json,scope_key)
              SELECT id,idempotency_key,input_digest,state,job_json,config_json,result_json,created_at,updated_at,runtime_session_id,resolved_json,
                CASE WHEN json_valid(config_json) AND json_extract(config_json,'$.runtime') = 'opencode'
                  THEN json_extract(config_json,'$.directory') ELSE NULL END FROM jobs;
            DROP TABLE jobs;
            ALTER TABLE jobs_v3 RENAME TO jobs;
            CREATE TABLE attempts (
              id TEXT PRIMARY KEY, job_id TEXT NOT NULL UNIQUE REFERENCES jobs(id),
              owner_token TEXT NOT NULL, phase TEXT NOT NULL,
              lease_expires_at TEXT NOT NULL, runtime_session_id TEXT,
              cancel_requested INTEGER NOT NULL DEFAULT 0
            );
            PRAGMA user_version = 3;
          `);
        });
      } finally { this.db.exec("PRAGMA foreign_keys = ON"); }
      if (this.db.prepare("PRAGMA foreign_key_check").all().length) throw new Error("Database migration broke foreign keys");
    }
    // Claimed work from a previous daemon has uncertain external state.
    const now = new Date().toISOString();
    this.transaction(() => {
      this.db.prepare("UPDATE jobs SET state = 'interrupted', updated_at = ? WHERE state IN ('running','cancelling')").run(now);
      this.db.prepare("UPDATE attempts SET phase = 'uncertain' WHERE phase IN ('launching','running','cancelling')").run();
    });
  }

  private transaction<T>(body: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const value = body();
      this.db.exec("COMMIT");
      return value;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private rowById(jobId: string): JobRow {
    const row = this.db.prepare("SELECT * FROM jobs WHERE id = ?").get(jobId) as JobRow | undefined;
    if (!row) throw new ProtocolError("NOT_FOUND", "Job not found");
    return row;
  }

  start(input: { task: string; idempotencyKey: string; role: string }): { jobId: string; state: State; deduplicated: boolean } {
    const digest = createHash("sha256").update(JSON.stringify({ task: input.task, role: input.role })).digest("hex");
    const id = randomUUID();
    const job = parseJob({
      schemaVersion: 1, id, parentWorkflowId: null, role: input.role, task: input.task,
      acceptanceCriteria: [], capabilities: [], inputReferences: [], repository: null,
      allowedScope: [], verificationCommands: [], limits: { timeoutSeconds: 60, maxEvents: 100 }, approvalPolicy: "none",
    });
    const config = parseRuntimeConfig({ runtime: "fake", agent: "deterministic", model: null, credential: null, options: {} });
    const now = new Date().toISOString();
    const existing = this.transaction(() => {
      const prior = this.db.prepare("SELECT * FROM jobs WHERE idempotency_key = ?").get(input.idempotencyKey) as JobRow | undefined;
      if (prior) return prior;
      this.db.prepare("INSERT INTO jobs (id,idempotency_key,input_digest,state,job_json,config_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)")
        .run(id, input.idempotencyKey, digest, "queued", JSON.stringify(job), JSON.stringify(config), now, now);
      return undefined;
    });
    if (existing) {
      if (existing.input_digest !== digest) throw new ProtocolError("IDEMPOTENCY_CONFLICT", "Idempotency key belongs to a different request");
      return { jobId: existing.id, state: existing.state, deduplicated: true };
    }
    this.db.prepare("UPDATE jobs SET state = 'running', updated_at = ? WHERE id = ? AND state = 'queued'").run(new Date().toISOString(), id);
    try {
      const run = runFakeTask(job, config);
      this.transaction(() => {
        const insert = this.db.prepare("INSERT INTO events (job_id,sequence,event_json) VALUES (?,?,?)");
        for (const event of run.events) insert.run(id, event.sequence, JSON.stringify(parseRuntimeEvent(event)));
        const result = parseRuntimeResult(run.result);
        this.db.prepare("UPDATE jobs SET state = 'completed', result_json = ?, updated_at = ? WHERE id = ?")
          .run(JSON.stringify(result), new Date().toISOString(), id);
      });
    } catch (error) {
      this.db.prepare("UPDATE jobs SET state = 'failed', updated_at = ? WHERE id = ?").run(new Date().toISOString(), id);
      throw error;
    }
    return { jobId: id, state: "completed", deduplicated: false };
  }

  enqueueReview(input: { task: string; idempotencyKey: string; role: string; config: unknown }): { jobId: string; state: State; deduplicated: boolean } {
    const digest = createHash("sha256").update(JSON.stringify({ task: input.task, role: input.role, config: input.config })).digest("hex");
    const id = randomUUID();
    const job = parseJob({ schemaVersion: 1, id, parentWorkflowId: null, role: input.role, task: input.task,
      acceptanceCriteria: [], capabilities: ["headless", "explicit-session", "event-stream", "permission-enforcement"],
      inputReferences: [], repository: null, allowedScope: [], verificationCommands: [],
      limits: { timeoutSeconds: 300, maxEvents: 1000 }, approvalPolicy: "none" });
    const now = new Date().toISOString();
    const existing = this.transaction(() => {
      const prior = this.db.prepare("SELECT * FROM jobs WHERE idempotency_key = ?").get(input.idempotencyKey) as JobRow | undefined;
      if (prior) return prior;
      let scope: string;
      try { scope = realpathSync((input.config as { directory: string }).directory); }
      catch { throw new ProtocolError("INVALID_REQUEST", "Review directory is unavailable"); }
      const possibleConflicts = this.db.prepare("SELECT scope_key FROM jobs WHERE scope_key IS NOT NULL AND state IN ('queued','running','cancelling','interrupted')").all() as Array<{ scope_key: string }>;
      if (possibleConflicts.some(row => {
        try { return realpathSync(row.scope_key) === scope; }
        catch { return row.scope_key === scope; }
      })) throw new ProtocolError("SCOPE_BLOCKED", "A job in this directory is active or needs reconciliation");
      this.db.prepare("INSERT INTO jobs (id,idempotency_key,input_digest,state,job_json,config_json,created_at,updated_at,scope_key) VALUES (?,?,?,?,?,?,?,?,?)")
        .run(id, input.idempotencyKey, digest, "queued", JSON.stringify(job), JSON.stringify(input.config), now, now, scope);
      return undefined;
    });
    if (existing) {
      if (existing.input_digest !== digest) throw new ProtocolError("IDEMPOTENCY_CONFLICT", "Idempotency key belongs to a different request");
      return { jobId: existing.id, state: existing.state, deduplicated: true };
    }
    return { jobId: id, state: "queued", deduplicated: false };
  }

  pendingReviews(): Array<{ jobId: string; task: string; config: unknown }> {
    const rows = this.db.prepare("SELECT id,job_json,config_json FROM jobs WHERE state = 'queued' AND scope_key IS NOT NULL AND NOT EXISTS (SELECT 1 FROM attempts WHERE attempts.job_id = jobs.id)").all() as Array<{ id: string; job_json: string; config_json: string }>;
    return rows.map(row => ({ jobId: row.id, task: parseJob(JSON.parse(row.job_json)).task, config: JSON.parse(row.config_json) as unknown }));
  }

  claimReview(jobId: string): string {
    return this.transaction(() => {
      const attemptId = randomUUID();
      const now = new Date();
      const result = this.db.prepare("UPDATE jobs SET state = 'running', updated_at = ? WHERE id = ? AND state = 'queued'").run(now.toISOString(), jobId);
      if (result.changes !== 1) throw new Error("OpenCode job was not queued");
      this.db.prepare("INSERT INTO attempts (id,job_id,owner_token,phase,lease_expires_at) VALUES (?,?,?,?,?)")
        .run(attemptId, jobId, this.ownerToken, "launching", new Date(now.getTime() + 300_000).toISOString());
      return attemptId;
    });
  }

  private assertAttempt(jobId: string, attemptId: string): void {
    const attempt = this.db.prepare("SELECT id FROM attempts WHERE id = ? AND job_id = ? AND owner_token = ?").get(attemptId, jobId, this.ownerToken);
    if (!attempt) throw new Error("Stale or mismatched attempt");
  }

  recordReviewEvent(jobId: string, attemptId: string, event: { type: string; sessionID?: string; part?: { type?: string; tool?: string; state?: { status?: string } } }): void {
    this.transaction(() => {
      this.assertAttempt(jobId, attemptId);
      const row = this.rowById(jobId);
      if (row.state !== "running" && row.state !== "cancelling") throw new Error("OpenCode job is not running or cancelling");
      if (event.sessionID && (!/^ses_[A-Za-z0-9]+$/.test(event.sessionID) || (row.runtime_session_id && row.runtime_session_id !== event.sessionID))) {
        throw new Error("OpenCode event has invalid or changing session ID");
      }
      if (event.sessionID && !row.runtime_session_id) {
        this.db.prepare("UPDATE jobs SET runtime_session_id = ? WHERE id = ?").run(event.sessionID, jobId);
        this.db.prepare("UPDATE attempts SET runtime_session_id = ?, phase = ? WHERE id = ?")
          .run(event.sessionID, row.state === "cancelling" ? "cancelling" : "running", attemptId);
      }
      this.db.prepare("UPDATE attempts SET lease_expires_at = ? WHERE id = ?")
        .run(new Date(Date.now() + 300_000).toISOString(), attemptId);
      const next = this.db.prepare("SELECT coalesce(max(sequence),0)+1 AS sequence FROM events WHERE job_id = ?").get(jobId) as { sequence: number };
      if (next.sequence > 1000) throw new Error("OpenCode event limit exceeded");
      const payload = { source: "opencode", type: event.type, tool: event.part?.tool ?? null, toolStatus: event.part?.state?.status ?? null };
      this.db.prepare("INSERT INTO events (job_id,sequence,event_json) VALUES (?,?,?)").run(jobId, next.sequence, JSON.stringify(payload));
    });
  }

  completeReview(jobId: string, attemptId: string, sessionId: string, summary: string, resolved: { runtimeVersion: string; agent: string; model: string }): void {
    this.assertAttempt(jobId, attemptId);
    const row = this.rowById(jobId);
    if (!["running", "cancelling", "interrupted"].includes(row.state) || row.runtime_session_id !== sessionId) throw new Error("OpenCode session identity was not persisted");
    const result = parseRuntimeResult({ schemaVersion: 1, jobId, execution: "completed", acceptance: "unverified", summary,
      changedFiles: [], verification: [], limitations: ["Read-only OpenCode review; acceptance is not independently verified."] });
    this.transaction(() => {
      this.db.prepare("UPDATE jobs SET state = 'completed', result_json = ?, resolved_json = ?, updated_at = ? WHERE id = ?")
        .run(JSON.stringify(result), JSON.stringify(resolved), new Date().toISOString(), jobId);
      this.db.prepare("UPDATE attempts SET phase = 'completed' WHERE id = ?").run(attemptId);
    });
  }

  failReview(jobId: string, attemptId?: string): void {
    if (attemptId) this.assertAttempt(jobId, attemptId);
    const row = this.rowById(jobId);
    if (row.state !== "queued" && row.state !== "running" && row.state !== "cancelling") return;
    if (row.state === "cancelling" && row.runtime_session_id) return;
    if (attemptId) {
      // After launch begins, even a missing session ID cannot prove nothing ran.
      this.transaction(() => {
        this.db.prepare("UPDATE jobs SET state = 'interrupted', updated_at = ? WHERE id = ?")
          .run(new Date().toISOString(), jobId);
        this.db.prepare("UPDATE attempts SET phase = 'uncertain' WHERE id = ?").run(attemptId);
      });
      return;
    }
    const result = parseRuntimeResult({ schemaVersion: 1, jobId, execution: "failed", acceptance: "unverified",
      summary: "OpenCode review did not complete.", changedFiles: [], verification: [], limitations: ["No verified review result is available."] });
    this.db.prepare("UPDATE jobs SET state = 'failed', result_json = ?, updated_at = ? WHERE id = ? AND state = 'queued'")
      .run(JSON.stringify(result), new Date().toISOString(), jobId);
  }

  requestCancel(jobId: string): { jobId: string; state: State; runtimeSessionId: string | null; config: unknown | null } {
    return this.transaction(() => {
      const row = this.rowById(jobId);
      if (!row.scope_key) throw new ProtocolError("UNSUPPORTED", "Cancellation is only available for OpenCode reviewer jobs");
      if (["completed", "failed", "cancelled"].includes(row.state)) return { jobId, state: row.state, runtimeSessionId: row.runtime_session_id, config: null };
      const attempt = this.db.prepare("SELECT id FROM attempts WHERE job_id = ?").get(jobId);
      if (row.state === "queued" && !attempt) {
        this.db.prepare("UPDATE jobs SET state = 'cancelled', updated_at = ? WHERE id = ?").run(new Date().toISOString(), jobId);
        return { jobId, state: "cancelled", runtimeSessionId: null, config: null };
      }
      if (row.state === "interrupted" && !row.runtime_session_id) {
        return { jobId, state: "interrupted", runtimeSessionId: null, config: null };
      }
      this.db.prepare("UPDATE jobs SET state = 'cancelling', updated_at = ? WHERE id = ?").run(new Date().toISOString(), jobId);
      this.db.prepare("UPDATE attempts SET cancel_requested = 1, phase = 'cancelling' WHERE job_id = ?").run(jobId);
      return { jobId, state: "cancelling", runtimeSessionId: row.runtime_session_id, config: JSON.parse(row.config_json) as unknown };
    });
  }

  cancellationNeeded(jobId: string): boolean { return this.rowById(jobId).state === "cancelling"; }

  confirmCancelled(jobId: string, sessionId: string): void {
    this.transaction(() => {
      const changed = this.db.prepare("UPDATE jobs SET state = 'cancelled', updated_at = ? WHERE id = ? AND state = 'cancelling' AND runtime_session_id = ?")
        .run(new Date().toISOString(), jobId, sessionId);
      if (changed.changes === 1) this.db.prepare("UPDATE attempts SET phase = 'cancelled' WHERE job_id = ? AND runtime_session_id = ?").run(jobId, sessionId);
    });
  }

  cancelUncertain(jobId: string): void {
    this.transaction(() => {
      this.db.prepare("UPDATE jobs SET state = 'interrupted', updated_at = ? WHERE id = ? AND state = 'cancelling'")
        .run(new Date().toISOString(), jobId);
      this.db.prepare("UPDATE attempts SET phase = 'uncertain' WHERE job_id = ? AND phase = 'cancelling'").run(jobId);
    });
  }

  reconciliationCandidates(): Array<{ jobId: string; sessionId: string; config: unknown; cancelRequested: boolean }> {
    const rows = this.db.prepare(`SELECT jobs.id, jobs.runtime_session_id, jobs.config_json,
      coalesce(attempts.cancel_requested,0) AS cancel_requested
      FROM jobs LEFT JOIN attempts ON attempts.job_id = jobs.id
      WHERE jobs.state = 'interrupted' AND jobs.runtime_session_id IS NOT NULL`).all() as Array<{
        id: string; runtime_session_id: string; config_json: string; cancel_requested: number;
      }>;
    return rows.map(row => ({ jobId: row.id, sessionId: row.runtime_session_id,
      config: JSON.parse(row.config_json) as unknown, cancelRequested: row.cancel_requested === 1 }));
  }

  reconcileTerminal(jobId: string, sessionId: string, outcome: "succeeded" | "failed" | "interrupted", cancelRequested: boolean): void {
    const row = this.rowById(jobId);
    if (row.state !== "interrupted" || row.runtime_session_id !== sessionId) return;
    if (outcome === "interrupted" && cancelRequested) {
      this.transaction(() => {
        this.db.prepare("UPDATE jobs SET state = 'cancelled', updated_at = ? WHERE id = ?").run(new Date().toISOString(), jobId);
        this.db.prepare("UPDATE attempts SET phase = 'cancelled' WHERE job_id = ?").run(jobId);
      });
      return;
    }
    if (outcome === "failed" || outcome === "succeeded") {
      const result = parseRuntimeResult({ schemaVersion: 1, jobId, execution: outcome === "failed" ? "failed" : "completed", acceptance: "unverified",
        summary: outcome === "failed" ? "OpenCode session failed before Gattini recorded a verified result." : "OpenCode session succeeded, but Gattini lost the review output before recording a result.",
        changedFiles: [], verification: [],
        limitations: [outcome === "failed" ? "Failure was reconciled from the exact runtime session after interruption." : "Review output is unavailable; the job cannot be accepted as a completed review."] });
      this.transaction(() => {
        this.db.prepare("UPDATE jobs SET state = 'failed', result_json = ?, updated_at = ? WHERE id = ?")
          .run(JSON.stringify(result), new Date().toISOString(), jobId);
        this.db.prepare("UPDATE attempts SET phase = 'failed' WHERE job_id = ?").run(jobId);
      });
    }
  }

  status(jobId: string): { jobId: string; state: State; createdAt: string; updatedAt: string; runtimeSessionId: string | null; resolved: unknown | null } {
    const row = this.rowById(jobId);
    return { jobId: row.id, state: row.state, createdAt: row.created_at, updatedAt: row.updated_at,
      runtimeSessionId: row.runtime_session_id, resolved: row.resolved_json ? JSON.parse(row.resolved_json) as unknown : null };
  }

  result(jobId: string): { jobId: string; state: State; result: RuntimeResult | null } {
    const row = this.rowById(jobId);
    return { jobId: row.id, state: row.state, result: row.result_json ? parseRuntimeResult(JSON.parse(row.result_json)) : null };
  }

  events(jobId: string): unknown[] {
    this.rowById(jobId);
    return this.db.prepare("SELECT event_json FROM events WHERE job_id = ? ORDER BY sequence").all(jobId)
      .map(row => JSON.parse((row as { event_json: string }).event_json) as unknown);
  }

  close(): void { this.db.close(); }
}
