import { createHash, randomUUID } from "node:crypto";
import { chmodSync, readFileSync, realpathSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { runFakeTask } from "../adapters/fake.js";
import { parseJob, parseRuntimeConfig, parseRuntimeEvent, parseRuntimeResult, type RuntimeResult } from "../core/contracts.js";
import { ProtocolError } from "../core/protocol.js";
import { actionDigest, enforceReviewerPolicy, reviewLaunchAction } from "../core/policy.js";
import { parseVerificationCommands, type CodeJobInput, type CodeRoleConfig, type SnapshotEvidence } from "../core/coding.js";
import { WorktreeManager } from "../environments/worktree.js";
import { OpenCodeUsageAccumulator } from "../core/usage.js";
import { parseCodexRoleConfig, type CodexRoleConfig } from "../core/codex-role-config.js";
import { parseWorkerCodeRoleConfig } from "../core/code-policy.js";
import { parseClaudeRoleConfig, type ClaudeRoleConfig } from "../core/claude-role-config.js";

type State = "queued" | "awaiting-approval" | "running" | "cancelling" | "cancelled" | "completed" | "failed" | "interrupted";
type JobRow = { id: string; idempotency_key: string; input_digest: string; state: State; created_at: string; updated_at: string; result_json: string | null; runtime_session_id: string | null; resolved_json: string | null; scope_key: string | null; config_json: string; job_json: string };
type ApprovalRow = { id: string; job_id: string; action_json: string; action_digest: string; state: "pending" | "approved" | "denied" | "expired"; created_at: string; expires_at: string; decided_at: string | null; actor: string | null };
type CodeRow = { job_id: string; input_json: string; worktree_path: string | null; state: "preparing" | "ready" | "failed" };

function savedCodeConfig(value: unknown): CodeRoleConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Saved code role config is invalid");
  const saved = value as Record<string, unknown>;
  if (!["opencode-code", "codex-code", "claude-code"].includes(saved.runtime as string)) throw new Error("Saved code runtime is unsupported");
  return parseWorkerCodeRoleConfig({ ...saved, runtime: (saved.runtime as string).replace(/-code$/, "") });
}

function codeActionProfile(config: CodeRoleConfig): Record<string, unknown> {
  return config.runtime === "opencode"
    ? { agent: config.agent, model: config.model, serverUrl: config.serverUrl, policy: "opencode-v2.0.18-deny-all-read-glob-grep" }
    : config.runtime === "codex"
      ? { runtime: "codex", model: config.model, modelProvider: config.modelProvider,
          executable: config.executable, policy: "codex-0.157.1-read-only-app-server" }
      : { runtime: "claude", model: config.model, executable: config.executable,
          maxBudgetUsd: config.maxBudgetUsd, policy: "claude-2.1.283-restricted-read-only-cli" };
}

export class JobStore {
  private readonly db: DatabaseSync;
  private readonly ownerToken = randomUUID();

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    if (path !== ":memory:") chmodSync(path, 0o600);
    this.db.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    const version = (this.db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
    if (version > 7) throw new Error(`Unsupported database schema version ${version}`);
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
    if (version < 4) {
      this.db.exec("PRAGMA foreign_keys = OFF");
      try {
        this.transaction(() => {
          this.db.exec(`
            CREATE TABLE jobs_v4 (
              id TEXT PRIMARY KEY, idempotency_key TEXT NOT NULL UNIQUE, input_digest TEXT NOT NULL,
              state TEXT NOT NULL CHECK (state IN ('queued','awaiting-approval','running','cancelling','cancelled','completed','failed','interrupted')),
              job_json TEXT NOT NULL, config_json TEXT NOT NULL, result_json TEXT,
              created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
              runtime_session_id TEXT, resolved_json TEXT, scope_key TEXT
            );
            INSERT INTO jobs_v4 SELECT * FROM jobs;
            DROP TABLE jobs;
            ALTER TABLE jobs_v4 RENAME TO jobs;
            CREATE TABLE approvals (
              id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES jobs(id),
              action_json TEXT NOT NULL, action_digest TEXT NOT NULL,
              state TEXT NOT NULL CHECK (state IN ('pending','approved','denied','expired')),
              created_at TEXT NOT NULL, expires_at TEXT NOT NULL, decided_at TEXT, actor TEXT
            );
            CREATE INDEX approvals_state_idx ON approvals(state, expires_at);
            PRAGMA user_version = 4;
          `);
        });
      } finally { this.db.exec("PRAGMA foreign_keys = ON"); }
      if (this.db.prepare("PRAGMA foreign_key_check").all().length) throw new Error("Database migration broke foreign keys");
    }
    if (version < 5) {
      this.transaction(() => {
        this.db.exec(`CREATE TABLE code_jobs (
          job_id TEXT PRIMARY KEY REFERENCES jobs(id), input_json TEXT NOT NULL,
          worktree_path TEXT, state TEXT NOT NULL CHECK (state IN ('preparing','ready','failed'))
        ); PRAGMA user_version = 5;`);
      });
    }
    if (version < 6) {
      this.transaction(() => this.db.exec(`CREATE TABLE code_proposals (
        job_id TEXT PRIMARY KEY REFERENCES jobs(id), proposal_json TEXT NOT NULL,
        path TEXT NOT NULL, before_sha TEXT NOT NULL, after_sha TEXT NOT NULL, worktree_sha TEXT NOT NULL,
        session_id TEXT NOT NULL, state TEXT NOT NULL CHECK (state IN ('proposed','approved','applying'))
      ); PRAGMA user_version = 6;`));
    }
    if (version < 7) {
      this.transaction(() => {
        this.db.exec(`
          CREATE TABLE attempts_v7 (
            id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES jobs(id),
            owner_token TEXT NOT NULL, phase TEXT NOT NULL,
            lease_expires_at TEXT NOT NULL, runtime_session_id TEXT,
            cancel_requested INTEGER NOT NULL DEFAULT 0
          );
          INSERT INTO attempts_v7 SELECT * FROM attempts;
          DROP TABLE attempts;
          ALTER TABLE attempts_v7 RENAME TO attempts;
          CREATE INDEX attempts_job_idx ON attempts(job_id);
          CREATE TABLE turn_results (
            attempt_id TEXT PRIMARY KEY REFERENCES attempts(id),
            job_id TEXT NOT NULL REFERENCES jobs(id), result_json TEXT NOT NULL,
            result_sha256 TEXT NOT NULL, created_at TEXT NOT NULL
          );
          CREATE TABLE followups (
            idempotency_key TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES jobs(id),
            attempt_id TEXT NOT NULL UNIQUE REFERENCES attempts(id), task TEXT NOT NULL,
            task_sha256 TEXT NOT NULL
          );
          CREATE TABLE pinned_reviews (
            review_job_id TEXT PRIMARY KEY REFERENCES jobs(id),
            source_job_id TEXT NOT NULL REFERENCES jobs(id), source_attempt_id TEXT NOT NULL,
            snapshot_sha TEXT NOT NULL, diff_sha TEXT NOT NULL
          );
          ALTER TABLE events ADD COLUMN attempt_id TEXT;
          PRAGMA user_version = 7;
        `);
        const historical = this.db.prepare(`SELECT attempts.id AS attempt_id,jobs.id AS job_id,jobs.result_json,jobs.updated_at
          FROM attempts JOIN jobs ON jobs.id=attempts.job_id
          WHERE jobs.result_json IS NOT NULL AND attempts.phase='completed'`).all() as Array<{ attempt_id: string; job_id: string; result_json: string; updated_at: string }>;
        for (const row of historical) this.db.prepare("INSERT INTO turn_results VALUES (?,?,?,?,?)")
          .run(row.attempt_id, row.job_id, row.result_json, createHash("sha256").update(row.result_json).digest("hex"), row.updated_at);
      });
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

  enqueueReview(input: { task: string; idempotencyKey: string; role: string; config: unknown; requireApproval?: boolean;
    pinnedSource?: { jobId: string; attemptId: string; snapshotSha: string; diffSha256: string } }): { jobId: string; state: State; deduplicated: boolean; approvalId?: string } {
    const config = enforceReviewerPolicy(input.config, ["headless", "explicit-session", "event-stream", "permission-enforcement"]);
    const requireApproval = input.requireApproval === true;
    const digest = createHash("sha256").update(JSON.stringify({ task: input.task, role: input.role, config, requireApproval,
      ...(input.pinnedSource ? { pinnedSource: input.pinnedSource } : {}) })).digest("hex");
    const id = randomUUID();
    const job = parseJob({ schemaVersion: 1, id, parentWorkflowId: null, role: input.role, task: input.task,
      acceptanceCriteria: [], capabilities: ["headless", "explicit-session", "event-stream", "permission-enforcement"],
      inputReferences: [], repository: null, allowedScope: [], verificationCommands: [],
      limits: { timeoutSeconds: 300, maxEvents: 1000 }, approvalPolicy: requireApproval ? "manual" : "none" });
    const now = new Date().toISOString();
    const existing = this.transaction(() => {
      const prior = this.db.prepare("SELECT * FROM jobs WHERE idempotency_key = ?").get(input.idempotencyKey) as JobRow | undefined;
      if (prior) return prior;
      let scope: string;
      try { scope = realpathSync((input.config as { directory: string }).directory); }
      catch { throw new ProtocolError("INVALID_REQUEST", "Review directory is unavailable"); }
      const possibleConflicts = this.db.prepare("SELECT scope_key FROM jobs WHERE scope_key IS NOT NULL AND state IN ('queued','awaiting-approval','running','cancelling','interrupted')").all() as Array<{ scope_key: string }>;
      if (possibleConflicts.some(row => {
        try { return realpathSync(row.scope_key) === scope; }
        catch { return row.scope_key === scope; }
      })) throw new ProtocolError("SCOPE_BLOCKED", "A job in this directory is active or needs reconciliation");
      const state = requireApproval ? "awaiting-approval" : "queued";
      this.db.prepare("INSERT INTO jobs (id,idempotency_key,input_digest,state,job_json,config_json,created_at,updated_at,scope_key) VALUES (?,?,?,?,?,?,?,?,?)")
        .run(id, input.idempotencyKey, digest, state, JSON.stringify(job), JSON.stringify(config), now, now, scope);
      if (input.pinnedSource) this.db.prepare("INSERT INTO pinned_reviews VALUES (?,?,?,?,?)")
        .run(id, input.pinnedSource.jobId, input.pinnedSource.attemptId, input.pinnedSource.snapshotSha, input.pinnedSource.diffSha256);
      if (requireApproval) {
        const action = reviewLaunchAction(digest, input.task, config);
        this.db.prepare("INSERT INTO approvals (id,job_id,action_json,action_digest,state,created_at,expires_at) VALUES (?,?,?,?,?,?,?)")
          .run(randomUUID(), id, JSON.stringify(action), actionDigest(action), "pending", now, new Date(Date.now() + 15 * 60_000).toISOString());
      }
      return undefined;
    });
    if (existing) {
      if (existing.input_digest !== digest) throw new ProtocolError("IDEMPOTENCY_CONFLICT", "Idempotency key belongs to a different request");
      const approval = this.db.prepare("SELECT id FROM approvals WHERE job_id = ?").get(existing.id) as { id: string } | undefined;
      return { jobId: existing.id, state: existing.state, deduplicated: true, ...(approval ? { approvalId: approval.id } : {}) };
    }
    const approval = this.db.prepare("SELECT id FROM approvals WHERE job_id = ?").get(id) as { id: string } | undefined;
    return { jobId: id, state: requireApproval ? "awaiting-approval" : "queued", deduplicated: false, ...(approval ? { approvalId: approval.id } : {}) };
  }

  enqueueCodexReview(input: { task: string; idempotencyKey: string; role: "reviewer" | "codex-reviewer"; config: CodexRoleConfig }): { jobId: string; state: State; deduplicated: boolean } {
    const config = parseCodexRoleConfig(input.config);
    const digest = createHash("sha256").update(JSON.stringify({ task: input.task, role: input.role, config })).digest("hex");
    const id = randomUUID();
    const now = new Date().toISOString();
    const job = parseJob({ schemaVersion: 1, id, parentWorkflowId: null, role: input.role, task: input.task,
      acceptanceCriteria: [], capabilities: ["headless", "explicit-session", "event-stream", "cancellation", "permission-enforcement"],
      inputReferences: [], repository: null, allowedScope: [], verificationCommands: [],
      limits: { timeoutSeconds: 60, maxEvents: 1000 }, approvalPolicy: "none" });
    const existing = this.transaction(() => {
      const prior = this.db.prepare("SELECT * FROM jobs WHERE idempotency_key = ?").get(input.idempotencyKey) as JobRow | undefined;
      if (prior) return prior;
      let scope: string;
      try { scope = realpathSync(config.directory); }
      catch { throw new ProtocolError("INVALID_REQUEST", "Codex review directory is unavailable"); }
      const conflicts = this.db.prepare("SELECT scope_key FROM jobs WHERE scope_key IS NOT NULL AND state IN ('queued','awaiting-approval','running','cancelling','interrupted')").all() as Array<{ scope_key: string }>;
      if (conflicts.some(row => {
        try { return realpathSync(row.scope_key) === scope; }
        catch { return row.scope_key === scope; }
      })) throw new ProtocolError("SCOPE_BLOCKED", "A job in this directory is active or needs reconciliation");
      this.db.prepare("INSERT INTO jobs (id,idempotency_key,input_digest,state,job_json,config_json,created_at,updated_at,scope_key) VALUES (?,?,?,?,?,?,?,?,?)")
        .run(id, input.idempotencyKey, digest, "queued", JSON.stringify(job), JSON.stringify(config), now, now, scope);
      return undefined;
    });
    if (existing) {
      if (existing.input_digest !== digest) throw new ProtocolError("IDEMPOTENCY_CONFLICT", "Idempotency key belongs to a different request");
      return { jobId: existing.id, state: existing.state, deduplicated: true };
    }
    return { jobId: id, state: "queued", deduplicated: false };
  }

  pendingCodexReviews(): Array<{ jobId: string; task: string; config: CodexRoleConfig }> {
    const rows = this.db.prepare("SELECT id,job_json,config_json FROM jobs WHERE state='queued' AND json_extract(config_json,'$.runtime')='codex' AND NOT EXISTS (SELECT 1 FROM attempts WHERE attempts.job_id=jobs.id)").all() as Array<{ id: string; job_json: string; config_json: string }>;
    return rows.map(row => ({ jobId: row.id, task: parseJob(JSON.parse(row.job_json)).task,
      config: parseCodexRoleConfig(JSON.parse(row.config_json)) }));
  }

  recordCodexIdentity(jobId: string, attemptId: string, identity: { threadId: string; sessionId: string; turnId: string; cliVersion: string; model: string; modelProvider: string }): void {
    this.transaction(() => {
      this.assertAttempt(jobId, attemptId);
      const row = this.rowById(jobId);
      const storedConfig = JSON.parse(row.config_json) as { runtime?: string };
      const config = storedConfig.runtime === "codex-code"
        ? savedCodeConfig(storedConfig)
        : parseCodexRoleConfig(storedConfig);
      if (config.runtime !== "codex") throw new Error("Saved Codex runtime is invalid");
      if (!["running", "cancelling"].includes(row.state) || row.runtime_session_id || identity.model !== config.model || identity.modelProvider !== config.modelProvider ||
          !identity.threadId || !identity.turnId || !identity.sessionId || identity.threadId.length > 128 || identity.turnId.length > 128 || identity.sessionId.length > 128) {
        throw new Error("Codex runtime identity does not match the claimed job");
      }
      this.db.prepare("UPDATE jobs SET runtime_session_id=?, resolved_json=?, updated_at=? WHERE id=?")
        .run(identity.threadId, JSON.stringify(identity), new Date().toISOString(), jobId);
      this.db.prepare("UPDATE attempts SET runtime_session_id=?, phase=? WHERE id=?")
        .run(identity.threadId, row.state === "cancelling" ? "cancelling" : "running", attemptId);
    });
  }

  completeCodexReview(jobId: string, attemptId: string, identity: { threadId: string; sessionId: string; turnId: string; cliVersion: string; model: string; modelProvider: string },
    summary: string, usage: { inputTokens: number | null; outputTokens: number | null }): void {
    this.assertAttempt(jobId, attemptId);
    const row = this.rowById(jobId);
    if (row.state !== "running" || row.runtime_session_id !== identity.threadId || row.resolved_json !== JSON.stringify(identity)) {
      throw new Error("Codex result identity or state differs from the claimed turn");
    }
    const result = parseRuntimeResult({ schemaVersion: 1, jobId, execution: "completed", acceptance: "unverified",
      summary: summary || "Codex read-only turn completed without final text.", changedFiles: [], verification: [],
      limitations: ["Codex read-only worker policy is not host containment; output has no independent acceptance checks."],
      usage: { runtime: "codex", sessionId: identity.sessionId, costUsd: null, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens } });
    this.transaction(() => {
      this.db.prepare("UPDATE jobs SET state='completed',result_json=?,updated_at=? WHERE id=?")
        .run(JSON.stringify(result), new Date().toISOString(), jobId);
      this.db.prepare("UPDATE attempts SET phase='completed' WHERE id=?").run(attemptId);
      this.recordTurnResult(jobId, attemptId, result);
    });
  }

  enqueueClaudeReview(input: { task: string; idempotencyKey: string; config: ClaudeRoleConfig;
    pinnedSource?: { jobId: string; attemptId: string; snapshotSha: string; diffSha256: string } }): { jobId: string; state: State; deduplicated: boolean } {
    const config = parseClaudeRoleConfig(input.config) as ClaudeRoleConfig;
    const digest = createHash("sha256").update(JSON.stringify({ task: input.task, role: "reviewer", config,
      ...(input.pinnedSource ? { pinnedSource: input.pinnedSource } : {}) })).digest("hex");
    const existing = this.db.prepare("SELECT * FROM jobs WHERE idempotency_key=?").get(input.idempotencyKey) as JobRow | undefined;
    if (existing) {
      if (existing.input_digest !== digest) throw new ProtocolError("IDEMPOTENCY_CONFLICT", "Idempotency key belongs to a different request");
      return { jobId: existing.id, state: existing.state, deduplicated: true };
    }
    const id = randomUUID();
    const now = new Date().toISOString();
    const job = parseJob({ schemaVersion: 1, id, parentWorkflowId: null, role: "reviewer", task: input.task,
      acceptanceCriteria: [], capabilities: ["headless", "explicit-session", "event-stream", "cancellation", "permission-enforcement"],
      inputReferences: [], repository: null, allowedScope: [], verificationCommands: [],
      limits: { timeoutSeconds: 60, maxEvents: 1000 }, approvalPolicy: "none" });
    let scope: string;
    try { scope = realpathSync(config.directory); }
    catch { throw new ProtocolError("INVALID_REQUEST", "Claude review directory is unavailable"); }
    const conflicts = this.db.prepare("SELECT scope_key FROM jobs WHERE scope_key IS NOT NULL AND state IN ('queued','awaiting-approval','running','cancelling','interrupted')").all() as Array<{ scope_key: string }>;
    if (conflicts.some(row => {
      try { return realpathSync(row.scope_key) === scope; }
      catch { return row.scope_key === scope; }
    })) throw new ProtocolError("SCOPE_BLOCKED", "A job in this directory is active or needs reconciliation");
    this.db.prepare("INSERT INTO jobs (id,idempotency_key,input_digest,state,job_json,config_json,created_at,updated_at,scope_key) VALUES (?,?,?,?,?,?,?,?,?)")
      .run(id, input.idempotencyKey, digest, "queued", JSON.stringify(job), JSON.stringify(config), now, now, scope);
    if (input.pinnedSource) this.db.prepare("INSERT INTO pinned_reviews VALUES (?,?,?,?,?)")
      .run(id, input.pinnedSource.jobId, input.pinnedSource.attemptId, input.pinnedSource.snapshotSha, input.pinnedSource.diffSha256);
    return { jobId: id, state: "queued", deduplicated: false };
  }

  pendingClaudeReviews(): Array<{ jobId: string; task: string; config: ClaudeRoleConfig }> {
    const rows = this.db.prepare("SELECT id,job_json,config_json FROM jobs WHERE state='queued' AND json_extract(config_json,'$.runtime')='claude' AND NOT EXISTS (SELECT 1 FROM attempts WHERE attempts.job_id=jobs.id)").all() as Array<{ id: string; job_json: string; config_json: string }>;
    return rows.map(row => ({ jobId: row.id, task: parseJob(JSON.parse(row.job_json)).task,
      config: parseClaudeRoleConfig(JSON.parse(row.config_json)) as ClaudeRoleConfig }));
  }

  recordClaudeIdentity(jobId: string, attemptId: string, identity: { sessionId: string; model: string; runtimeVersion: string; executable: string; cwd: string }): void {
    this.transaction(() => {
      this.assertAttempt(jobId, attemptId);
      const row = this.rowById(jobId);
      const saved = JSON.parse(row.config_json) as { runtime?: string };
      const code = saved.runtime === "claude-code";
      const config = code ? savedCodeConfig(saved) : parseClaudeRoleConfig(saved) as ClaudeRoleConfig;
      const cwd = code ? (this.db.prepare("SELECT worktree_path FROM code_jobs WHERE job_id=?").get(jobId) as { worktree_path: string } | undefined)?.worktree_path :
        (config as ClaudeRoleConfig).directory;
      if (config.runtime !== "claude" || !["running", "cancelling"].includes(row.state) || row.runtime_session_id ||
          identity.model !== config.model || identity.executable !== config.executable || identity.cwd !== cwd ||
          identity.runtimeVersion !== "2.1.283 (Claude Code)" || !/^[0-9a-f-]{36}$/.test(identity.sessionId)) {
        throw new Error("Claude runtime identity does not match the claimed job");
      }
      this.db.prepare("UPDATE jobs SET runtime_session_id=?,resolved_json=?,updated_at=? WHERE id=?")
        .run(identity.sessionId, JSON.stringify(identity), new Date().toISOString(), jobId);
      this.db.prepare("UPDATE attempts SET runtime_session_id=?,phase=? WHERE id=?")
        .run(identity.sessionId, row.state === "cancelling" ? "cancelling" : "running", attemptId);
    });
  }

  recordClaudeDiagnostic(jobId: string, attemptId: string, diagnostic: { code: string; eventType: string }): void {
    this.transaction(() => {
      this.assertAttempt(jobId, attemptId);
      const safe = (value: string): string => /^[a-zA-Z_]+(?:\/[a-zA-Z_]+)?$/.test(value) && value.length <= 100 ? value : "other";
      const next = this.db.prepare("SELECT coalesce(max(sequence),0)+1 AS sequence FROM events WHERE job_id=?").get(jobId) as { sequence: number };
      this.db.prepare("INSERT INTO events (job_id,sequence,event_json,attempt_id) VALUES (?,?,?,?)")
        .run(jobId, next.sequence, JSON.stringify({ source: "claude", type: "diagnostic", code: safe(diagnostic.code), eventType: safe(diagnostic.eventType) }), attemptId);
    });
  }

  completeClaudeReview(jobId: string, attemptId: string,
    identity: { sessionId: string; model: string; runtimeVersion: string; executable: string; cwd: string },
    summary: string, usage: { inputTokens: number | null; outputTokens: number | null; costUsd: number | null }): void {
    this.assertAttempt(jobId, attemptId);
    const row = this.rowById(jobId);
    if (row.state !== "running" || row.runtime_session_id !== identity.sessionId || row.resolved_json !== JSON.stringify(identity)) {
      throw new Error("Claude result identity or state differs from the claimed turn");
    }
    const result = parseRuntimeResult({ schemaVersion: 1, jobId, execution: "completed", acceptance: "unverified",
      summary: summary || "Claude read-only turn completed without final text.", changedFiles: [], verification: [],
      limitations: ["Claude read-only tool policy is not host containment; output has no independent acceptance checks."],
      usage: { runtime: "claude", sessionId: identity.sessionId, ...usage } });
    this.transaction(() => {
      this.db.prepare("UPDATE jobs SET state='completed',result_json=?,updated_at=? WHERE id=?")
        .run(JSON.stringify(result), new Date().toISOString(), jobId);
      this.db.prepare("UPDATE attempts SET phase='completed' WHERE id=?").run(attemptId);
      this.recordTurnResult(jobId, attemptId, result);
    });
  }

  sourceSnapshotForReview(jobId: string): { attemptId: string; snapshot: SnapshotEvidence } {
    const row = this.rowById(jobId);
    if (row.state !== "completed" || !this.db.prepare("SELECT 1 FROM code_jobs WHERE job_id = ?").get(jobId)) {
      throw new ProtocolError("UNSUPPORTED_REVIEW", "Source is not a completed guarded code job");
    }
    const value = this.result(jobId);
    if (!value.attemptId || value.result?.acceptance !== "passed" || !value.result.snapshot?.artifact) {
      throw new ProtocolError("UNSUPPORTED_REVIEW", "Source lacks a passed retained snapshot");
    }
    return { attemptId: value.attemptId, snapshot: value.result.snapshot };
  }

  pinnedReviewSnapshot(reviewJobId: string): SnapshotEvidence | null {
    const link = this.db.prepare("SELECT source_job_id,source_attempt_id,snapshot_sha,diff_sha FROM pinned_reviews WHERE review_job_id = ?")
      .get(reviewJobId) as { source_job_id: string; source_attempt_id: string; snapshot_sha: string; diff_sha: string } | undefined;
    if (!link) return null;
    const source = this.result(link.source_job_id, link.source_attempt_id).result?.snapshot;
    if (!source || source.snapshotSha !== link.snapshot_sha || source.diffSha256 !== link.diff_sha) {
      throw new ProtocolError("EVIDENCE_INVALID", "Pinned review source changed");
    }
    return source;
  }

  enqueueCode(input: CodeJobInput, config: CodeRoleConfig, worktrees: WorktreeManager): { jobId: string; state: State; deduplicated: boolean; approvalId?: string; worktreePath?: string } {
    if (input.trustedLocal !== true || !input.repositoryPath.startsWith("/") || !/^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/.test(input.baseSha)) {
      throw new ProtocolError("INVALID_REQUEST", "Trusted code requires an absolute repository and full base commit SHA");
    }
    const commands = parseVerificationCommands(input.verificationCommands);
    const normalized = { ...input, verificationCommands: commands };
    const digest = createHash("sha256").update(JSON.stringify({ input: normalized, config })).digest("hex");
    const existing = this.db.prepare("SELECT * FROM jobs WHERE idempotency_key = ?").get(input.idempotencyKey) as JobRow | undefined;
    if (existing) {
      if (existing.input_digest !== digest) throw new ProtocolError("IDEMPOTENCY_CONFLICT", "Idempotency key belongs to a different request");
      const approval = this.db.prepare("SELECT id FROM approvals WHERE job_id = ?").get(existing.id) as { id: string } | undefined;
      const code = this.db.prepare("SELECT worktree_path FROM code_jobs WHERE job_id = ?").get(existing.id) as { worktree_path: string | null } | undefined;
      return { jobId: existing.id, state: existing.state, deduplicated: true,
        ...(approval ? { approvalId: approval.id } : {}), ...(code?.worktree_path ? { worktreePath: code.worktree_path } : {}) };
    }
    const id = randomUUID();
    const now = new Date().toISOString();
    const job = parseJob({ schemaVersion: 1, id, parentWorkflowId: null, role: "code", task: input.task,
      acceptanceCriteria: [], capabilities: ["headless", "explicit-session", "event-stream", "permission-enforcement"],
      inputReferences: [], repository: { path: input.repositoryPath, baseSha: input.baseSha },
      allowedScope: [], verificationCommands: commands.map(command => JSON.stringify(command)),
      limits: { timeoutSeconds: 300, maxEvents: 1000 }, approvalPolicy: "manual" });
    this.transaction(() => {
      this.db.prepare("INSERT INTO jobs (id,idempotency_key,input_digest,state,job_json,config_json,created_at,updated_at,scope_key) VALUES (?,?,?,?,?,?,?,?,?)")
        .run(id, input.idempotencyKey, digest, "awaiting-approval", JSON.stringify(job), JSON.stringify({ ...config, runtime: `${config.runtime}-code` }), now, now, input.repositoryPath);
      this.db.prepare("INSERT INTO code_jobs (job_id,input_json,state) VALUES (?,?,?)").run(id, JSON.stringify(normalized), "preparing");
    });
    let worktreePath: string;
    try {
      worktreePath = worktrees.prepare({ jobId: id, repositoryPath: input.repositoryPath, baseSha: input.baseSha }).worktreePath;
    } catch {
      this.transaction(() => {
        this.db.prepare("UPDATE code_jobs SET state = 'failed' WHERE job_id = ?").run(id);
        this.db.prepare("UPDATE jobs SET state = 'failed', updated_at = ? WHERE id = ?").run(new Date().toISOString(), id);
      });
      throw new ProtocolError("WORKTREE_PREPARATION_FAILED", "Owned coding worktree preparation failed; inspect retained ownership evidence");
    }
    const action = { kind: "code-proposal-launch", inputDigest: digest, task: input.task,
      repositoryPath: input.repositoryPath, baseSha: input.baseSha, worktreePath,
      ...codeActionProfile(config),
      verificationCommands: commands, trustedLocal: true };
    this.transaction(() => {
      this.db.prepare("UPDATE code_jobs SET state = 'ready', worktree_path = ? WHERE job_id = ?").run(worktreePath, id);
      this.db.prepare("INSERT INTO approvals (id,job_id,action_json,action_digest,state,created_at,expires_at) VALUES (?,?,?,?,?,?,?)")
        .run(randomUUID(), id, JSON.stringify(action), createHash("sha256").update(JSON.stringify(action)).digest("hex"), "pending", now, new Date(Date.now() + 15 * 60_000).toISOString());
    });
    const approval = this.db.prepare("SELECT id FROM approvals WHERE job_id = ?").get(id) as { id: string };
    return { jobId: id, state: "awaiting-approval", deduplicated: false, approvalId: approval.id, worktreePath };
  }

  pendingCodes(): Array<{ jobId: string; input: CodeJobInput; config: CodeRoleConfig; worktreePath: string }> {
    const rows = this.db.prepare(`SELECT jobs.id, jobs.config_json, code_jobs.input_json, code_jobs.worktree_path
      FROM jobs JOIN code_jobs ON code_jobs.job_id = jobs.id
      WHERE jobs.state = 'queued' AND code_jobs.state = 'ready' AND code_jobs.worktree_path IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM attempts WHERE attempts.job_id = jobs.id)`).all() as Array<{ id: string; config_json: string; input_json: string; worktree_path: string }>;
    return rows.map(row => ({ jobId: row.id, input: JSON.parse(row.input_json) as CodeJobInput,
      config: savedCodeConfig(JSON.parse(row.config_json)), worktreePath: row.worktree_path }));
  }

  pendingReviews(): Array<{ jobId: string; task: string; config: unknown }> {
    const rows = this.db.prepare("SELECT id,job_json,config_json FROM jobs WHERE state = 'queued' AND scope_key IS NOT NULL AND json_extract(config_json,'$.runtime') = 'opencode' AND NOT EXISTS (SELECT 1 FROM attempts WHERE attempts.job_id = jobs.id AND attempts.phase != 'failed')").all() as Array<{ id: string; job_json: string; config_json: string }>;
    return rows.map(row => ({ jobId: row.id, task: parseJob(JSON.parse(row.job_json)).task, config: JSON.parse(row.config_json) as unknown }));
  }

  enqueueFollowup(jobId: string, task: string, idempotencyKey: string): { jobId: string; state: State; attemptId: string; deduplicated: boolean } {
    return this.transaction(() => {
      const taskSha = createHash("sha256").update(task).digest("hex");
      const prior = this.db.prepare("SELECT * FROM followups WHERE idempotency_key = ?").get(idempotencyKey) as
        { job_id: string; attempt_id: string; task_sha256: string } | undefined;
      if (prior) {
        if (prior.job_id !== jobId || prior.task_sha256 !== taskSha) throw new ProtocolError("IDEMPOTENCY_CONFLICT", "Follow-up key belongs to another request");
        return { jobId, state: this.rowById(jobId).state, attemptId: prior.attempt_id, deduplicated: true };
      }
      const row = this.rowById(jobId);
      const config = JSON.parse(row.config_json) as { runtime?: string };
      if (row.state !== "completed" || config.runtime !== "opencode" || !row.runtime_session_id || !row.resolved_json ||
          this.db.prepare("SELECT 1 FROM code_jobs WHERE job_id = ?").get(jobId)) {
        throw new ProtocolError("UNSUPPORTED_FOLLOWUP", "This job has no supported completed OpenCode review session");
      }
      const resolved = JSON.parse(row.resolved_json) as { agent?: string; model?: string };
      const reviewConfig = config as { agent?: string; model?: string };
      if (resolved.agent !== reviewConfig.agent || resolved.model !== reviewConfig.model) {
        throw new ProtocolError("UNSUPPORTED_FOLLOWUP", "Saved session identity differs from the configured reviewer");
      }
      const attemptId = randomUUID();
      const now = new Date().toISOString();
      this.db.prepare("INSERT INTO attempts (id,job_id,owner_token,phase,lease_expires_at,runtime_session_id) VALUES (?,?,?,?,?,?)")
        .run(attemptId, jobId, "", "queued", now, row.runtime_session_id);
      this.db.prepare("INSERT INTO followups VALUES (?,?,?,?,?)").run(idempotencyKey, jobId, attemptId, task, taskSha);
      this.db.prepare("UPDATE jobs SET state = 'queued', updated_at = ? WHERE id = ?").run(now, jobId);
      return { jobId, state: "queued", attemptId, deduplicated: false };
    });
  }

  pendingFollowups(): Array<{ jobId: string; attemptId: string; task: string; sessionId: string; config: unknown }> {
    const rows = this.db.prepare(`SELECT followups.job_id,followups.attempt_id,followups.task,attempts.runtime_session_id,jobs.config_json
      FROM followups JOIN attempts ON attempts.id=followups.attempt_id JOIN jobs ON jobs.id=followups.job_id
      WHERE jobs.state='queued' AND attempts.phase='queued'`).all() as Array<{
      job_id: string; attempt_id: string; task: string; runtime_session_id: string; config_json: string }>;
    return rows.map(row => ({ jobId: row.job_id, attemptId: row.attempt_id, task: row.task,
      sessionId: row.runtime_session_id, config: JSON.parse(row.config_json) as unknown }));
  }

  reviewConfig(jobId: string): unknown {
    return JSON.parse(this.rowById(jobId).config_json) as unknown;
  }

  runtimeTimeoutMs(jobId: string): number {
    return Math.min(parseJob(JSON.parse(this.rowById(jobId).job_json)).limits.timeoutSeconds * 1000, 300_000);
  }

  preflightFailureCount(jobId: string): number {
    this.rowById(jobId);
    return (this.db.prepare("SELECT count(*) AS n FROM attempts WHERE job_id=? AND phase='failed' AND runtime_session_id IS NULL")
      .get(jobId) as { n: number }).n;
  }

  recordTransientPreflightFailure(jobId: string, exhausted: boolean): string {
    return this.transaction(() => {
      const row = this.rowById(jobId);
      if (row.state !== "queued" || this.db.prepare("SELECT 1 FROM code_jobs WHERE job_id=?").get(jobId)) {
        throw new Error("Transient reviewer preflight failure is not eligible for retry");
      }
      const attemptId = randomUUID();
      const now = new Date().toISOString();
      const result = parseRuntimeResult({ schemaVersion: 1, jobId, execution: "failed", acceptance: "unverified",
        summary: "OpenCode reviewer preflight could not reach the local runtime.", changedFiles: [], verification: [],
        limitations: ["No runtime session was launched for this attempt."],
        ...(exhausted ? { escalation: { code: "RETRY_EXHAUSTED", reason: "Two transient preflight attempts failed; manual inspection is required." } } : {}) });
      this.db.prepare("INSERT INTO attempts (id,job_id,owner_token,phase,lease_expires_at) VALUES (?,?,?,?,?)")
        .run(attemptId, jobId, this.ownerToken, "failed", now);
      this.recordTurnResult(jobId, attemptId, result);
      if (exhausted) this.db.prepare("UPDATE jobs SET state='failed',result_json=?,updated_at=? WHERE id=?")
        .run(JSON.stringify(result), now, jobId);
      return attemptId;
    });
  }

  uncertainCapacity(): Array<{ jobId: string; workerClass: "read" | "write" }> {
    const rows = this.db.prepare(`SELECT jobs.id,CASE WHEN code_jobs.job_id IS NULL THEN 'read' ELSE 'write' END AS worker_class
      FROM jobs LEFT JOIN code_jobs ON code_jobs.job_id=jobs.id
      WHERE jobs.state IN ('interrupted','cancelling') AND jobs.scope_key IS NOT NULL`).all() as
      Array<{ id: string; worker_class: "read" | "write" }>;
    return rows.map(row => ({ jobId: row.id, workerClass: row.worker_class }));
  }

  claimFollowup(jobId: string, attemptId: string, sessionId: string): void {
    this.transaction(() => {
      const row = this.rowById(jobId);
      if (row.state !== "queued" || row.runtime_session_id !== sessionId) throw new Error("Follow-up job or session changed");
      const attempt = this.db.prepare("SELECT phase,runtime_session_id FROM attempts WHERE id = ? AND job_id = ?").get(attemptId, jobId) as
        { phase: string; runtime_session_id: string } | undefined;
      if (attempt?.phase !== "queued" || attempt.runtime_session_id !== sessionId) throw new Error("Follow-up attempt changed");
      const now = new Date();
      this.db.prepare("UPDATE attempts SET owner_token=?,phase='launching',lease_expires_at=? WHERE id=?")
        .run(this.ownerToken, new Date(now.getTime() + 300_000).toISOString(), attemptId);
      this.db.prepare("UPDATE jobs SET state='running',updated_at=? WHERE id=?").run(now.toISOString(), jobId);
    });
  }

  failQueuedFollowup(jobId: string, attemptId: string): void {
    this.transaction(() => {
      const changed = this.db.prepare("UPDATE attempts SET phase='failed' WHERE id=? AND job_id=? AND phase='queued'").run(attemptId, jobId);
      if (changed.changes === 1) this.db.prepare("UPDATE jobs SET state='failed',updated_at=? WHERE id=? AND state='queued'")
        .run(new Date().toISOString(), jobId);
    });
  }

  private expireApprovals(): void {
    this.transaction(() => {
      const now = new Date().toISOString();
      const rows = this.db.prepare("SELECT id,job_id FROM approvals WHERE state = 'pending' AND expires_at <= ?").all(now) as Array<{ id: string; job_id: string }>;
      for (const row of rows) {
        this.db.prepare("UPDATE approvals SET state = 'expired', decided_at = ? WHERE id = ?").run(now, row.id);
        this.db.prepare("UPDATE jobs SET state = 'failed', updated_at = ? WHERE id = ? AND state = 'awaiting-approval'").run(now, row.job_id);
        if (this.db.prepare("SELECT 1 FROM code_jobs WHERE job_id = ?").get(row.job_id)) {
          const result = parseRuntimeResult({ schemaVersion: 1, jobId: row.job_id, execution: "failed", acceptance: "unverified",
            summary: "Coding approval expired before the proposed action ran.", changedFiles: [], verification: [], limitations: ["The owned worktree is retained for inspection."] });
          this.db.prepare("UPDATE jobs SET result_json = ? WHERE id = ?").run(JSON.stringify(result), row.job_id);
        }
      }
    });
  }

  approvals(): Array<{ id: string; jobId: string; action: unknown; state: string; createdAt: string; expiresAt: string; decidedAt: string | null; actor: string | null }> {
    this.expireApprovals();
    const rows = this.db.prepare("SELECT * FROM approvals WHERE state = 'pending' ORDER BY created_at DESC, id DESC LIMIT 20").all() as ApprovalRow[];
    return rows.map(row => ({ id: row.id, jobId: row.job_id, action: JSON.parse(row.action_json) as unknown,
      state: row.state, createdAt: row.created_at, expiresAt: row.expires_at, decidedAt: row.decided_at, actor: row.actor }));
  }

  decideApproval(approvalId: string, decision: "approved" | "denied", actor: string): { approvalId: string; jobId: string; state: string; launch: { task: string; config: unknown } | null; codeLaunch?: { input: CodeJobInput; config: CodeRoleConfig; worktreePath: string }; codeApply?: { input: CodeJobInput; config: CodeRoleConfig; worktreePath: string; proposal: string; sessionId: string } } {
    this.expireApprovals();
    return this.transaction(() => {
      const approval = this.db.prepare("SELECT * FROM approvals WHERE id = ?").get(approvalId) as ApprovalRow | undefined;
      if (!approval) throw new ProtocolError("NOT_FOUND", "Approval not found");
      if (approval.state !== "pending") throw new ProtocolError("APPROVAL_STALE", "Approval is no longer pending");
      const row = this.rowById(approval.job_id);
      if (row.state !== "awaiting-approval") throw new ProtocolError("APPROVAL_STALE", "Job is no longer awaiting approval");
      const code = this.db.prepare("SELECT * FROM code_jobs WHERE job_id = ?").get(row.id) as CodeRow | undefined;
      if (code) {
        if (code.state !== "ready" || !code.worktree_path) throw new ProtocolError("APPROVAL_STALE", "Coding worktree is not ready");
        const input = JSON.parse(code.input_json) as CodeJobInput;
        const config = savedCodeConfig(JSON.parse(row.config_json));
        const proposed = this.db.prepare("SELECT * FROM code_proposals WHERE job_id = ?").get(row.id) as { proposal_json: string; path: string; before_sha: string; after_sha: string; worktree_sha: string; session_id: string; state: string } | undefined;
        if (proposed) {
          if (proposed.state !== "proposed" || row.runtime_session_id !== proposed.session_id) throw new ProtocolError("APPROVAL_STALE", "Proposed patch or session changed");
          const action = { kind: "code-apply", inputDigest: row.input_digest, worktreePath: code.worktree_path,
            baseSha: input.baseSha, ...codeActionProfile(config), attemptId: (this.db.prepare("SELECT id FROM attempts WHERE job_id = ?").get(row.id) as { id: string }).id,
            sessionId: proposed.session_id,
            path: proposed.path, beforeSha256: proposed.before_sha, afterSha256: proposed.after_sha, worktreeSha: proposed.worktree_sha,
            proposalSha256: createHash("sha256").update(proposed.proposal_json).digest("hex"), verificationCommands: input.verificationCommands };
          if (approval.action_json !== JSON.stringify(action) || approval.action_digest !== createHash("sha256").update(JSON.stringify(action)).digest("hex")) throw new ProtocolError("APPROVAL_STALE", "Proposed patch action changed");
          const now = new Date().toISOString();
          this.db.prepare("UPDATE approvals SET state = ?, decided_at = ?, actor = ? WHERE id = ?").run(decision, now, actor, approvalId);
          this.db.prepare("UPDATE jobs SET state = ?, updated_at = ? WHERE id = ?").run(decision === "approved" ? "queued" : "failed", now, row.id);
          if (decision === "denied") {
            const result = parseRuntimeResult({ schemaVersion: 1, jobId: row.id, execution: "failed", acceptance: "unverified",
              summary: "Validated patch apply was denied.", changedFiles: [], verification: [], limitations: ["The owned worktree and proposal are retained for inspection."] });
            this.db.prepare("UPDATE jobs SET result_json = ? WHERE id = ?").run(JSON.stringify(result), row.id);
          }
          if (decision === "approved") this.db.prepare("UPDATE code_proposals SET state = 'approved' WHERE job_id = ?").run(row.id);
          return { approvalId, jobId: row.id, state: decision, launch: null,
            ...(decision === "approved" ? { codeApply: { input, config, worktreePath: code.worktree_path, proposal: proposed.proposal_json, sessionId: proposed.session_id } } : {}) };
        }
        const job = parseJob(JSON.parse(row.job_json));
        const digest = createHash("sha256").update(JSON.stringify({ input, config })).digest("hex");
        const action = { kind: "code-proposal-launch", inputDigest: digest, task: input.task,
          repositoryPath: input.repositoryPath, baseSha: input.baseSha, worktreePath: code.worktree_path,
          ...codeActionProfile(config),
          verificationCommands: parseVerificationCommands(input.verificationCommands), trustedLocal: true };
        if (digest !== row.input_digest || job.task !== input.task || job.repository?.baseSha !== input.baseSha ||
            approval.action_json !== JSON.stringify(action) ||
            approval.action_digest !== createHash("sha256").update(JSON.stringify(action)).digest("hex")) {
          throw new ProtocolError("APPROVAL_STALE", "Saved coding job differs from proposed action");
        }
        const now = new Date().toISOString();
        this.db.prepare("UPDATE approvals SET state = ?, decided_at = ?, actor = ? WHERE id = ?").run(decision, now, actor, approvalId);
        this.db.prepare("UPDATE jobs SET state = ?, updated_at = ? WHERE id = ?").run(decision === "approved" ? "queued" : "failed", now, row.id);
        if (decision === "denied") {
          const result = parseRuntimeResult({ schemaVersion: 1, jobId: row.id, execution: "failed", acceptance: "unverified",
            summary: "Read-only proposal launch was denied.", changedFiles: [], verification: [], limitations: ["No coding runtime was launched; the owned worktree is retained."] });
          this.db.prepare("UPDATE jobs SET result_json = ? WHERE id = ?").run(JSON.stringify(result), row.id);
        }
        return { approvalId, jobId: row.id, state: decision, launch: null,
          ...(decision === "approved" ? { codeLaunch: { input, config, worktreePath: code.worktree_path } } : {}) };
      }
      const config = enforceReviewerPolicy(JSON.parse(row.config_json) as unknown);
      const job = parseJob(JSON.parse(row.job_json));
      const currentInputDigest = createHash("sha256").update(JSON.stringify({ task: job.task, role: job.role, config, requireApproval: true })).digest("hex");
      if (job.id !== row.id || job.approvalPolicy !== "manual" || currentInputDigest !== row.input_digest) {
        throw new ProtocolError("APPROVAL_STALE", "Saved job differs from the proposed action");
      }
      const action = reviewLaunchAction(row.input_digest, job.task, config);
      if (actionDigest(action) !== approval.action_digest || JSON.stringify(action) !== approval.action_json) {
        throw new ProtocolError("APPROVAL_STALE", "Proposed action changed");
      }
      const now = new Date().toISOString();
      this.db.prepare("UPDATE approvals SET state = ?, decided_at = ?, actor = ? WHERE id = ?").run(decision, now, actor, approvalId);
      this.db.prepare("UPDATE jobs SET state = ?, updated_at = ? WHERE id = ?")
        .run(decision === "approved" ? "queued" : "failed", now, row.id);
      return { approvalId, jobId: row.id, state: decision,
        launch: decision === "approved" ? { task: job.task, config } : null };
    });
  }

  completeProposal(jobId: string, attemptId: string, sessionId: string, proposal: string, worktreeSha: string,
    patch: { path: string; beforeSha256: string; afterSha256: string },
    workerUsage?: { inputTokens: number | null; outputTokens: number | null; costUsd?: number | null }): string {
    this.assertAttempt(jobId, attemptId);
    return this.transaction(() => {
      const row = this.rowById(jobId);
      const code = this.db.prepare("SELECT * FROM code_jobs WHERE job_id = ?").get(jobId) as CodeRow;
      if (row.state !== "running" || row.runtime_session_id !== sessionId || !code?.worktree_path) throw new Error("Proposal session or worktree is not claimed");
      const input = JSON.parse(code.input_json) as CodeJobInput;
      const config = savedCodeConfig(JSON.parse(row.config_json));
      const action = { kind: "code-apply", inputDigest: row.input_digest, worktreePath: code.worktree_path,
        baseSha: input.baseSha, ...codeActionProfile(config), attemptId, sessionId,
        path: patch.path, beforeSha256: patch.beforeSha256, afterSha256: patch.afterSha256, worktreeSha,
        proposalSha256: createHash("sha256").update(proposal).digest("hex"), verificationCommands: input.verificationCommands };
      const now = new Date().toISOString();
      const approvalId = randomUUID();
      this.db.prepare("INSERT INTO code_proposals (job_id,proposal_json,path,before_sha,after_sha,worktree_sha,session_id,state) VALUES (?,?,?,?,?,?,?,?)")
        .run(jobId, proposal, patch.path, patch.beforeSha256, patch.afterSha256, worktreeSha, sessionId, "proposed");
      this.db.prepare("INSERT INTO approvals (id,job_id,action_json,action_digest,state,created_at,expires_at) VALUES (?,?,?,?,?,?,?)")
        .run(approvalId, jobId, JSON.stringify(action), createHash("sha256").update(JSON.stringify(action)).digest("hex"), "pending", now, new Date(Date.now() + 15 * 60_000).toISOString());
      this.db.prepare("UPDATE attempts SET phase = 'proposed' WHERE id = ?").run(attemptId);
      if (config.runtime === "codex" || config.runtime === "claude") {
        const identity = row.resolved_json ? JSON.parse(row.resolved_json) as Record<string, unknown> : null;
        if (!identity || (config.runtime === "codex" ? identity.threadId : identity.sessionId) !== sessionId || !workerUsage) throw new Error("Worker proposal identity or usage is missing");
        this.db.prepare("UPDATE jobs SET resolved_json = ? WHERE id = ?")
          .run(JSON.stringify({ ...identity, usage: workerUsage }), jobId);
      }
      this.db.prepare("UPDATE jobs SET state = 'awaiting-approval', updated_at = ? WHERE id = ?").run(now, jobId);
      return approvalId;
    });
  }

  pendingApplies(): Array<{ jobId: string; input: CodeJobInput; config: CodeRoleConfig; worktreePath: string; proposal: string; sessionId: string }> {
    const rows = this.db.prepare(`SELECT jobs.id, jobs.config_json, code_jobs.input_json, code_jobs.worktree_path,
      code_proposals.proposal_json, code_proposals.session_id FROM jobs
      JOIN code_jobs ON code_jobs.job_id = jobs.id JOIN code_proposals ON code_proposals.job_id = jobs.id
      WHERE jobs.state = 'queued' AND code_proposals.state = 'approved'`).all() as Array<{ id: string; config_json: string; input_json: string; worktree_path: string; proposal_json: string; session_id: string }>;
    return rows.map(row => ({ jobId: row.id, input: JSON.parse(row.input_json) as CodeJobInput,
      config: savedCodeConfig(JSON.parse(row.config_json)), worktreePath: row.worktree_path,
      proposal: row.proposal_json, sessionId: row.session_id }));
  }

  claimCodeApply(jobId: string, sessionId: string): string {
    return this.transaction(() => {
      const row = this.rowById(jobId);
      const proposal = this.db.prepare("SELECT state,session_id FROM code_proposals WHERE job_id = ?").get(jobId) as { state: string; session_id: string } | undefined;
      if (row.state !== "queued" || row.runtime_session_id !== sessionId || proposal?.state !== "approved" || proposal.session_id !== sessionId) throw new Error("Approved proposal is stale");
      const attempt = this.db.prepare("SELECT id FROM attempts WHERE job_id = ?").get(jobId) as { id: string };
      this.db.prepare("UPDATE attempts SET owner_token = ?, phase = 'applying' WHERE id = ?").run(this.ownerToken, attempt.id);
      this.db.prepare("UPDATE code_proposals SET state = 'applying' WHERE job_id = ?").run(jobId);
      this.db.prepare("UPDATE jobs SET state = 'running', updated_at = ? WHERE id = ?").run(new Date().toISOString(), jobId);
      return attempt.id;
    });
  }

  codeApplying(jobId: string): boolean {
    const row = this.db.prepare("SELECT state FROM code_proposals WHERE job_id = ?").get(jobId) as { state: string } | undefined;
    return row?.state === "applying";
  }

  codeProposalFingerprint(jobId: string): string {
    const row = this.db.prepare("SELECT worktree_sha FROM code_proposals WHERE job_id = ? AND state = 'applying'").get(jobId) as { worktree_sha: string } | undefined;
    if (!row) throw new Error("Approved patch proposal is unavailable");
    return row.worktree_sha;
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

  recordReviewEvent(jobId: string, attemptId: string, event: { type: string; sessionID?: string; id?: string; eventID?: string;
    part?: { type?: string; id?: string; tool?: string; state?: { status?: string }; cost?: number; tokens?: { input?: number; output?: number } } }): void {
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
      const measure = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
      const usageEvent = event.type === "step_finish" ? { type: event.type, sessionID: event.sessionID,
        ...(typeof event.id === "string" && event.id.length <= 128 ? { id: event.id } : {}),
        ...(typeof event.eventID === "string" && event.eventID.length <= 128 ? { eventID: event.eventID } : {}),
        part: { ...(typeof event.part?.id === "string" && event.part.id.length <= 128 ? { id: event.part.id } : {}),
          cost: measure(event.part?.cost), tokens: { input: measure(event.part?.tokens?.input), output: measure(event.part?.tokens?.output) } } } : null;
      const payload = { source: "opencode", type: event.type, tool: event.part?.tool ?? null,
        toolStatus: event.part?.state?.status ?? null, usageEvent };
      this.db.prepare("INSERT INTO events (job_id,sequence,event_json,attempt_id) VALUES (?,?,?,?)").run(jobId, next.sequence, JSON.stringify(payload), attemptId);
    });
  }

  completeReview(jobId: string, attemptId: string, sessionId: string, summary: string, resolved: { runtimeVersion: string; agent: string; model: string }): void {
    this.assertAttempt(jobId, attemptId);
    const row = this.rowById(jobId);
    if (!["running", "cancelling", "interrupted"].includes(row.state) || row.runtime_session_id !== sessionId) throw new Error("OpenCode session identity was not persisted");
    const result = parseRuntimeResult({ schemaVersion: 1, jobId, execution: "completed", acceptance: "unverified", summary,
      changedFiles: [], verification: [], limitations: ["Read-only OpenCode review; acceptance is not independently verified."],
      usage: this.usageForAttempt(attemptId, sessionId) });
    this.transaction(() => {
      this.db.prepare("UPDATE jobs SET state = 'completed', result_json = ?, resolved_json = ?, updated_at = ? WHERE id = ?")
        .run(JSON.stringify(result), JSON.stringify(resolved), new Date().toISOString(), jobId);
      this.db.prepare("UPDATE attempts SET phase = 'completed' WHERE id = ?").run(attemptId);
      this.recordTurnResult(jobId, attemptId, result);
    });
  }

  private recordTurnResult(jobId: string, attemptId: string, result: RuntimeResult): void {
    const encoded = JSON.stringify(result);
    this.db.prepare("INSERT INTO turn_results (attempt_id,job_id,result_json,result_sha256,created_at) VALUES (?,?,?,?,?)")
      .run(attemptId, jobId, encoded, createHash("sha256").update(encoded).digest("hex"), new Date().toISOString());
  }

  private usageForAttempt(attemptId: string, sessionId: string): ReturnType<OpenCodeUsageAccumulator["snapshot"]> {
    const usage = new OpenCodeUsageAccumulator(sessionId);
    const rows = this.db.prepare("SELECT event_json FROM events WHERE attempt_id = ? ORDER BY sequence").all(attemptId) as Array<{ event_json: string }>;
    for (const row of rows) {
      const payload = JSON.parse(row.event_json) as { usageEvent?: unknown };
      if (payload.usageEvent) usage.add(payload.usageEvent);
    }
    return usage.snapshot();
  }

  completeCode(jobId: string, attemptId: string, sessionId: string, summary: string,
    resolved: { runtimeVersion: string; agent: string; model: string }, snapshot: SnapshotEvidence): void {
    this.assertAttempt(jobId, attemptId);
    const row = this.rowById(jobId);
    const code = this.db.prepare("SELECT * FROM code_jobs WHERE job_id = ?").get(jobId) as CodeRow | undefined;
    if (!code || code.state !== "ready" || code.worktree_path !== snapshot.worktreePath ||
        row.state !== "running" || row.runtime_session_id !== sessionId) throw new Error("Coding result is not bound to the claimed worktree and session");
    const job = parseJob(JSON.parse(row.job_json));
    if (job.repository?.baseSha !== snapshot.baseSha) throw new Error("Coding snapshot base differs from the job");
    if (!snapshot.artifact || createHash("sha256").update(readFileSync(snapshot.artifact.path)).digest("hex") !== snapshot.artifact.sha256 ||
        createHash("sha256").update(readFileSync(snapshot.artifact.diffPath)).digest("hex") !== snapshot.artifact.diffFileSha256) throw new Error("Retained snapshot or diff is missing or changed");
    const proposal = this.db.prepare("SELECT path,after_sha,state FROM code_proposals WHERE job_id = ?").get(jobId) as { path: string; after_sha: string; state: string } | undefined;
    const applyApproval = this.db.prepare("SELECT state,action_json FROM approvals WHERE job_id = ? AND json_extract(action_json,'$.kind') = 'code-apply'").get(jobId) as { state: string; action_json: string } | undefined;
    const approvedAction = applyApproval ? JSON.parse(applyApproval.action_json) as { kind?: string; attemptId?: string; sessionId?: string } : null;
    const artifact = JSON.parse(readFileSync(snapshot.artifact.path, "utf8")) as { snapshotSha?: string; diffSha256?: string; changedFiles?: string[]; entries?: Array<{ path: string; kind: string; content?: string }> };
    const replacement = artifact.entries?.find(entry => entry.path === proposal?.path && entry.kind === "file");
    if (proposal?.state !== "applying" || applyApproval?.state !== "approved" || approvedAction?.kind !== "code-apply" || approvedAction.attemptId !== attemptId || approvedAction.sessionId !== sessionId ||
        artifact.snapshotSha !== snapshot.snapshotSha || artifact.diffSha256 !== snapshot.diffSha256 ||
        JSON.stringify(artifact.changedFiles) !== JSON.stringify(snapshot.changedFiles) || !replacement?.content ||
        createHash("sha256").update(Buffer.from(replacement.content, "base64")).digest("hex") !== proposal.after_sha ||
        !snapshot.changedFiles.includes(proposal.path)) throw new Error("Retained snapshot differs from the approved patch or checks");
    const config = savedCodeConfig(JSON.parse(row.config_json));
    const codexResolved = config.runtime === "codex" && row.resolved_json
      ? JSON.parse(row.resolved_json) as { sessionId?: string; model?: string; modelProvider?: string; cliVersion?: string; usage?: { inputTokens: number | null; outputTokens: number | null } }
      : null;
    const claudeResolved = config.runtime === "claude" && row.resolved_json
      ? JSON.parse(row.resolved_json) as { sessionId?: string; model?: string; runtimeVersion?: string; usage?: { inputTokens: number | null; outputTokens: number | null; costUsd: number | null } }
      : null;
    if (config.runtime === "codex" && (!codexResolved?.sessionId || codexResolved.model !== config.model || codexResolved.modelProvider !== config.modelProvider || !codexResolved.usage)) {
      throw new Error("Codex proposal result lost exact identity or usage");
    }
    if (config.runtime === "claude" && (claudeResolved?.sessionId !== sessionId || claudeResolved.model !== config.model || !claudeResolved.usage)) {
      throw new Error("Claude proposal result lost exact identity or usage");
    }
    const usage = codexResolved?.sessionId && codexResolved.usage
      ? { runtime: "codex" as const, sessionId: codexResolved.sessionId, costUsd: null,
          inputTokens: codexResolved.usage.inputTokens, outputTokens: codexResolved.usage.outputTokens }
      : claudeResolved?.sessionId && claudeResolved.usage
        ? { runtime: "claude" as const, sessionId: claudeResolved.sessionId, ...claudeResolved.usage }
      : this.usageForAttempt(attemptId, sessionId);
    const result = parseRuntimeResult({ schemaVersion: 1, jobId, execution: "completed", acceptance: snapshot.acceptance,
      summary, changedFiles: snapshot.changedFiles,
      verification: snapshot.checks.map(check => ({ command: JSON.stringify(check.argv), exitCode: check.exitCode })),
      limitations: ["Trusted local coding runtime and verification have no host containment.", ...snapshot.limitations], snapshot,
      usage });
    this.transaction(() => {
      this.db.prepare("UPDATE jobs SET state = 'completed', result_json = ?, resolved_json = ?, updated_at = ? WHERE id = ?")
        .run(JSON.stringify(result), config.runtime === "codex" || config.runtime === "claude" ? row.resolved_json : JSON.stringify(resolved), new Date().toISOString(), jobId);
      this.db.prepare("UPDATE attempts SET phase = 'completed' WHERE id = ?").run(attemptId);
      this.recordTurnResult(jobId, attemptId, result);
    });
  }

  failCodeVerification(jobId: string, attemptId: string, summary: string): void {
    this.assertAttempt(jobId, attemptId);
    const row = this.rowById(jobId);
    if (row.state !== "running" && row.state !== "cancelling") return;
    const result = parseRuntimeResult({ schemaVersion: 1, jobId, execution: "failed", acceptance: "unverified",
      summary, changedFiles: [], verification: [], limitations: ["Apply or snapshot verification is uncertain; inspect retained worktree and artifacts. No result is accepted."] });
    this.transaction(() => {
      this.db.prepare("UPDATE jobs SET state = 'interrupted', result_json = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(result), new Date().toISOString(), jobId);
      this.db.prepare("UPDATE attempts SET phase = 'uncertain' WHERE id = ?").run(attemptId);
    });
  }

  failCodePreflight(jobId: string): void {
    const result = parseRuntimeResult({ schemaVersion: 1, jobId, execution: "failed", acceptance: "unverified",
      summary: "Coding runtime policy or configuration preflight failed.", changedFiles: [], verification: [],
      limitations: ["No coding runtime launch was claimed; inspect the configured worker policy before retrying with a new job."] });
    this.db.prepare("UPDATE jobs SET state = 'failed', result_json = ?, updated_at = ? WHERE id = ? AND state = 'queued' AND NOT EXISTS (SELECT 1 FROM attempts WHERE job_id = ?)")
      .run(JSON.stringify(result), new Date().toISOString(), jobId, jobId);
  }

  codeWorktreePath(jobId: string): string | null {
    const row = this.db.prepare("SELECT worktree_path FROM code_jobs WHERE job_id = ?").get(jobId) as { worktree_path: string | null } | undefined;
    return row?.worktree_path ?? null;
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

  failCodexReview(jobId: string, attemptId?: string): void {
    if (attemptId) this.assertAttempt(jobId, attemptId);
    const row = this.rowById(jobId);
    if (!["queued", "running", "cancelling"].includes(row.state)) return;
    const now = new Date().toISOString();
    if (attemptId) {
      this.transaction(() => {
        this.db.prepare("UPDATE jobs SET state='interrupted',updated_at=? WHERE id=?").run(now, jobId);
        this.db.prepare("UPDATE attempts SET phase='uncertain' WHERE id=?").run(attemptId);
      });
      return;
    }
    const result = parseRuntimeResult({ schemaVersion: 1, jobId, execution: "failed", acceptance: "unverified",
      summary: "Codex worker preflight did not complete.", changedFiles: [], verification: [], limitations: ["No Codex runtime turn was claimed."] });
    this.db.prepare("UPDATE jobs SET state='failed',result_json=?,updated_at=? WHERE id=? AND state='queued'")
      .run(JSON.stringify(result), now, jobId);
  }

  failClaudeReview(jobId: string, attemptId?: string): void {
    if (attemptId) this.assertAttempt(jobId, attemptId);
    const row = this.rowById(jobId);
    if (!["queued", "running", "cancelling"].includes(row.state)) return;
    if (row.state === "cancelling" && row.runtime_session_id) return;
    const now = new Date().toISOString();
    if (attemptId) {
      this.transaction(() => {
        this.db.prepare("UPDATE jobs SET state='interrupted',updated_at=? WHERE id=?").run(now, jobId);
        this.db.prepare("UPDATE attempts SET phase='uncertain' WHERE id=?").run(attemptId);
      });
      return;
    }
    const result = parseRuntimeResult({ schemaVersion: 1, jobId, execution: "failed", acceptance: "unverified",
      summary: "Claude worker preflight did not complete.", changedFiles: [], verification: [],
      limitations: ["No Claude runtime turn was claimed."] });
    this.db.prepare("UPDATE jobs SET state='failed',result_json=?,updated_at=? WHERE id=? AND state='queued'")
      .run(JSON.stringify(result), now, jobId);
  }

  requestCancel(jobId: string): { jobId: string; state: State; runtimeSessionId: string | null; config: unknown | null } {
    return this.transaction(() => {
      const row = this.rowById(jobId);
      if (!row.scope_key) throw new ProtocolError("UNSUPPORTED", "Cancellation is only available for scoped runtime jobs");
      if (["completed", "failed", "cancelled"].includes(row.state)) return { jobId, state: row.state, runtimeSessionId: row.runtime_session_id, config: null };
      const attempt = this.db.prepare("SELECT id,phase FROM attempts WHERE job_id = ? ORDER BY rowid DESC LIMIT 1").get(jobId) as { id: string; phase: string } | undefined;
      if (row.state === "queued" && attempt?.phase === "queued" && this.db.prepare("SELECT 1 FROM followups WHERE attempt_id = ?").get(attempt.id)) {
        const now = new Date().toISOString();
        this.db.prepare("UPDATE attempts SET phase='cancelled' WHERE id=?").run(attempt.id);
        this.db.prepare("UPDATE jobs SET state='cancelled',updated_at=? WHERE id=?").run(now, jobId);
        return { jobId, state: "cancelled", runtimeSessionId: null, config: null };
      }
      // A finished read-only proposal has no live turn to interrupt. Stop the
      // pending apply action locally, including the small queued-before-apply window.
      const proposal = this.db.prepare("SELECT state FROM code_proposals WHERE job_id = ?").get(jobId) as { state: string } | undefined;
      if ((row.state === "awaiting-approval" || row.state === "queued") &&
          (proposal?.state === "proposed" || proposal?.state === "approved")) {
        const now = new Date().toISOString();
        this.db.prepare("UPDATE jobs SET state = 'cancelled', updated_at = ? WHERE id = ?").run(now, jobId);
        this.db.prepare("UPDATE approvals SET state = 'denied', decided_at = ?, actor = 'cancellation' WHERE job_id = ? AND state = 'pending'").run(now, jobId);
        if (attempt) this.db.prepare("UPDATE attempts SET phase = 'cancelled' WHERE id = ?").run(attempt.id);
        return { jobId, state: "cancelled", runtimeSessionId: row.runtime_session_id, config: null };
      }
      if ((row.state === "queued" || row.state === "awaiting-approval") && !attempt) {
        this.db.prepare("UPDATE jobs SET state = 'cancelled', updated_at = ? WHERE id = ?").run(new Date().toISOString(), jobId);
        this.db.prepare("UPDATE approvals SET state = 'denied', decided_at = ?, actor = 'cancellation' WHERE job_id = ? AND state = 'pending'").run(new Date().toISOString(), jobId);
        return { jobId, state: "cancelled", runtimeSessionId: null, config: null };
      }
      if (row.state === "interrupted" && !row.runtime_session_id) {
        return { jobId, state: "interrupted", runtimeSessionId: null, config: null };
      }
      this.db.prepare("UPDATE jobs SET state = 'cancelling', updated_at = ? WHERE id = ?").run(new Date().toISOString(), jobId);
      this.db.prepare("UPDATE attempts SET cancel_requested = 1, phase = 'cancelling' WHERE id = ?").run(attempt?.id ?? "");
      return { jobId, state: "cancelling", runtimeSessionId: row.runtime_session_id, config: JSON.parse(row.config_json) as unknown };
    });
  }

  cancellationNeeded(jobId: string): boolean { return this.rowById(jobId).state === "cancelling"; }

  confirmCancelled(jobId: string, sessionId: string): void {
    this.transaction(() => {
      const changed = this.db.prepare("UPDATE jobs SET state = 'cancelled', updated_at = ? WHERE id = ? AND state = 'cancelling' AND runtime_session_id = ?")
        .run(new Date().toISOString(), jobId, sessionId);
      if (changed.changes === 1) this.db.prepare("UPDATE attempts SET phase = 'cancelled' WHERE id = (SELECT id FROM attempts WHERE job_id = ? AND runtime_session_id = ? ORDER BY rowid DESC LIMIT 1)").run(jobId, sessionId);
    });
  }

  cancelUncertain(jobId: string): void {
    this.transaction(() => {
      this.db.prepare("UPDATE jobs SET state = 'interrupted', updated_at = ? WHERE id = ? AND state = 'cancelling'")
        .run(new Date().toISOString(), jobId);
      this.db.prepare("UPDATE attempts SET phase = 'uncertain' WHERE id = (SELECT id FROM attempts WHERE job_id = ? AND phase = 'cancelling' ORDER BY rowid DESC LIMIT 1)").run(jobId);
    });
  }

  reconciliationCandidates(): Array<{ jobId: string; sessionId: string; config: unknown; cancelRequested: boolean }> {
    const rows = this.db.prepare(`SELECT jobs.id, jobs.runtime_session_id, jobs.config_json,
      coalesce((SELECT attempts.cancel_requested FROM attempts WHERE attempts.job_id=jobs.id ORDER BY attempts.rowid DESC LIMIT 1),0) AS cancel_requested
      FROM jobs
      WHERE jobs.state = 'interrupted' AND jobs.runtime_session_id IS NOT NULL
      AND json_extract(jobs.config_json,'$.runtime') = 'opencode'`).all() as Array<{
        id: string; runtime_session_id: string; config_json: string; cancel_requested: number;
      }>;
    return rows.map(row => ({ jobId: row.id, sessionId: row.runtime_session_id,
      config: JSON.parse(row.config_json) as unknown, cancelRequested: row.cancel_requested === 1 }));
  }

  codexCancellationCandidates(): Array<{ jobId: string; threadId: string; turnId: string; model: string; modelProvider: string; config: unknown }> {
    const rows = this.db.prepare(`SELECT jobs.id, jobs.runtime_session_id, jobs.resolved_json, jobs.config_json
      FROM jobs LEFT JOIN code_jobs ON code_jobs.job_id = jobs.id
      WHERE jobs.state = 'interrupted' AND jobs.runtime_session_id IS NOT NULL
      AND jobs.resolved_json IS NOT NULL AND code_jobs.job_id IS NULL
      AND json_extract(jobs.config_json,'$.runtime') = 'codex'
      AND coalesce((SELECT attempts.cancel_requested FROM attempts WHERE attempts.job_id=jobs.id ORDER BY attempts.rowid DESC LIMIT 1),0) = 1`).all() as Array<{
        id: string; runtime_session_id: string; resolved_json: string; config_json: string;
      }>;
    return rows.flatMap(row => {
      const resolved = JSON.parse(row.resolved_json) as { threadId?: unknown; turnId?: unknown; model?: unknown; modelProvider?: unknown };
      if (resolved.threadId !== row.runtime_session_id || typeof resolved.turnId !== "string" || !resolved.turnId ||
          typeof resolved.model !== "string" || typeof resolved.modelProvider !== "string") return [];
      return [{ jobId: row.id, threadId: row.runtime_session_id, turnId: resolved.turnId,
        model: resolved.model, modelProvider: resolved.modelProvider,
        config: JSON.parse(row.config_json) as unknown }];
    });
  }

  reconcileCodexCancelled(jobId: string, threadId: string, turnId: string): void {
    this.transaction(() => {
      const row = this.rowById(jobId);
      if (row.state !== "interrupted" || row.runtime_session_id !== threadId || !row.resolved_json) return;
      if ((JSON.parse(row.config_json) as { runtime?: unknown }).runtime !== "codex" ||
          this.db.prepare("SELECT 1 FROM code_jobs WHERE job_id = ?").get(jobId)) return;
      const identity = JSON.parse(row.resolved_json) as { threadId?: unknown; turnId?: unknown };
      if (identity.threadId !== threadId || identity.turnId !== turnId) return;
      const latest = this.db.prepare("SELECT id,cancel_requested FROM attempts WHERE job_id = ? ORDER BY rowid DESC LIMIT 1")
        .get(jobId) as { id: string; cancel_requested: number } | undefined;
      if (latest?.cancel_requested !== 1) return;
      this.db.prepare("UPDATE jobs SET state = 'cancelled', updated_at = ? WHERE id = ?")
        .run(new Date().toISOString(), jobId);
      this.db.prepare("UPDATE attempts SET phase = 'cancelled' WHERE id = ?").run(latest.id);
    });
  }

  reconcileTerminal(jobId: string, sessionId: string, outcome: "succeeded" | "failed" | "interrupted", cancelRequested: boolean): void {
    const row = this.rowById(jobId);
    if (row.state !== "interrupted" || row.runtime_session_id !== sessionId) return;
    if (outcome === "interrupted" && cancelRequested) {
      this.transaction(() => {
        this.db.prepare("UPDATE jobs SET state = 'cancelled', updated_at = ? WHERE id = ?").run(new Date().toISOString(), jobId);
        this.db.prepare("UPDATE attempts SET phase = 'cancelled' WHERE id = (SELECT id FROM attempts WHERE job_id = ? ORDER BY rowid DESC LIMIT 1)").run(jobId);
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
        this.db.prepare("UPDATE attempts SET phase = 'failed' WHERE id = (SELECT id FROM attempts WHERE job_id = ? ORDER BY rowid DESC LIMIT 1)").run(jobId);
      });
    }
  }

  status(jobId: string): { jobId: string; state: State; createdAt: string; updatedAt: string; runtimeSessionId: string | null; resolved: unknown | null } {
    this.expireApprovals();
    const row = this.rowById(jobId);
    return { jobId: row.id, state: row.state, createdAt: row.created_at, updatedAt: row.updated_at,
      runtimeSessionId: row.runtime_session_id, resolved: row.resolved_json ? JSON.parse(row.resolved_json) as unknown : null };
  }

  result(jobId: string, attemptId?: string): { jobId: string; state: State; attemptId?: string; result: RuntimeResult | null; pinnedSource?: unknown } {
    this.expireApprovals();
    const row = this.rowById(jobId);
    const turn = attemptId
      ? this.db.prepare("SELECT * FROM turn_results WHERE job_id = ? AND attempt_id = ?").get(jobId, attemptId) as { attempt_id: string; result_json: string; result_sha256: string } | undefined
      : this.db.prepare("SELECT * FROM turn_results WHERE job_id = ? ORDER BY created_at DESC,rowid DESC LIMIT 1").get(jobId) as { attempt_id: string; result_json: string; result_sha256: string } | undefined;
    if (attemptId && !turn) throw new ProtocolError("NOT_FOUND", "Completed attempt result not found");
    if (turn && createHash("sha256").update(turn.result_json).digest("hex") !== turn.result_sha256) {
      throw new ProtocolError("EVIDENCE_INVALID", "Saved attempt result changed");
    }
    const result = turn ? parseRuntimeResult(JSON.parse(turn.result_json)) : row.result_json ? parseRuntimeResult(JSON.parse(row.result_json)) : null;
    if (result?.snapshot?.artifact) {
      const artifact = result.snapshot.artifact;
      try {
        if (createHash("sha256").update(readFileSync(artifact.path)).digest("hex") !== artifact.sha256 ||
            createHash("sha256").update(readFileSync(artifact.diffPath)).digest("hex") !== artifact.diffFileSha256) throw new Error("changed");
      } catch { throw new ProtocolError("EVIDENCE_INVALID", "Retained snapshot or diff is missing or changed"); }
    }
    const pinned = this.db.prepare("SELECT source_job_id,source_attempt_id,snapshot_sha,diff_sha FROM pinned_reviews WHERE review_job_id = ?")
      .get(jobId) as { source_job_id: string; source_attempt_id: string; snapshot_sha: string; diff_sha: string } | undefined;
    return { jobId: row.id, state: row.state, ...(turn ? { attemptId: turn.attempt_id } : {}), result,
      ...(pinned ? { pinnedSource: { jobId: pinned.source_job_id, attemptId: pinned.source_attempt_id,
        snapshotSha: pinned.snapshot_sha, diffSha256: pinned.diff_sha } } : {}) };
  }

  events(jobId: string): unknown[] {
    this.rowById(jobId);
    return this.db.prepare("SELECT event_json FROM events WHERE job_id = ? ORDER BY sequence").all(jobId)
      .map(row => JSON.parse((row as { event_json: string }).event_json) as unknown);
  }

  close(): void { this.db.close(); }
}
