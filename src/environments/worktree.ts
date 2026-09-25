/** Durable, job-owned Git worktree preparation. Worktrees separate changes; they are not sandboxes. */
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { relative, resolve, join, isAbsolute, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type WorktreeState = "reserved" | "ready" | "failed";
export interface WorktreeRecord {
  jobId: string;
  repositoryPath: string;
  baseSha: string;
  branch: string;
  worktreePath: string;
  state: WorktreeState;
  error: string | null;
}

export class WorktreeError extends Error {
  constructor(message: string) { super(message); this.name = "WorktreeError"; }
}

function git(cwd: string, args: string[]): string {
  const env = { ...process.env };
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_NAMESPACE"]) {
    delete env[key];
  }
  try {
    return execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30_000, env,
    }).trim();
  } catch {
    throw new WorktreeError(`Git operation failed: ${args[0] ?? "unknown"}`);
  }
}

function privateDirectory(path: string): string {
  if (!isAbsolute(path) || path.includes("\0")) throw new WorktreeError("State directory must be absolute");
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) {
    throw new WorktreeError("State directory must be a private user-owned directory");
  }
  return realpathSync(path);
}

function repository(path: string): string {
  if (!isAbsolute(path) || path.includes("\0")) throw new WorktreeError("Repository path must be absolute");
  let canonical: string;
  try { canonical = realpathSync(path); }
  catch { throw new WorktreeError("Repository path does not exist"); }
  if (!lstatSync(canonical).isDirectory()) throw new WorktreeError("Repository path is not a directory");
  if (git(canonical, ["rev-parse", "--is-bare-repository"]) !== "false" ||
      realpathSync(git(canonical, ["rev-parse", "--show-toplevel"])) !== canonical) {
    throw new WorktreeError("Repository path must name a non-bare Git worktree root");
  }
  return canonical;
}

function fullCommitSha(repo: string, sha: string): string {
  if (!/^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/.test(sha)) throw new WorktreeError("Base SHA must be a full commit hash");
  const resolved = git(repo, ["rev-parse", "--verify", `${sha}^{commit}`]);
  if (resolved.toLowerCase() !== sha.toLowerCase()) throw new WorktreeError("Base SHA must name a commit directly");
  return resolved;
}

function within(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function pathExists(path: string): boolean {
  try { lstatSync(path); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** Resolve a requested file within a prepared worktree, rejecting traversal and symlink escapes. */
export function resolveWorktreePath(worktreePath: string, requestedPath: string): string {
  if (!requestedPath || requestedPath.includes("\0") || isAbsolute(requestedPath) ||
      requestedPath.split(/[\\/]/).some(part => part === ".." || part === "." || part === "")) {
    throw new WorktreeError("Workspace path must be a clean relative path");
  }
  const root = realpathSync(worktreePath);
  const target = resolve(root, requestedPath);
  if (!within(root, target)) throw new WorktreeError("Workspace path escapes the worktree");
  let ancestor = target;
  while (!pathExists(ancestor)) {
    const parent = resolve(ancestor, "..");
    if (parent === ancestor) throw new WorktreeError("Workspace path has no existing parent");
    ancestor = parent;
  }
  let realAncestor: string;
  try { realAncestor = realpathSync(ancestor); }
  catch { throw new WorktreeError("Workspace path contains an unresolved symlink"); }
  if (!within(root, realAncestor)) throw new WorktreeError("Workspace path follows a symlink outside the worktree");
  return target;
}

type Row = { job_id: string; repository_path: string; base_sha: string; branch: string; worktree_path: string; state: WorktreeState; error: string | null };
function record(row: Row): WorktreeRecord {
  return { jobId: row.job_id, repositoryPath: row.repository_path, baseSha: row.base_sha,
    branch: row.branch, worktreePath: row.worktree_path, state: row.state, error: row.error };
}

/** Owns preparation records in a private SQLite database; never removes branches or worktrees. */
export class WorktreeManager {
  private readonly db: DatabaseSync;
  private readonly root: string;

  constructor(stateDirectory: string) {
    const state = privateDirectory(stateDirectory);
    this.root = join(state, "worktrees");
    privateDirectory(this.root);
    const dbPath = join(state, "worktrees.sqlite");
    if (pathExists(dbPath)) {
      const stat = lstatSync(dbPath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid?.()) {
        throw new WorktreeError("Worktree database must be a user-owned regular file");
      }
    }
    this.db = new DatabaseSync(dbPath);
    chmodSync(dbPath, 0o600);
    this.db.exec(`
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS worktrees (
        job_id TEXT PRIMARY KEY, repository_path TEXT NOT NULL, base_sha TEXT NOT NULL,
        branch TEXT NOT NULL UNIQUE, worktree_path TEXT NOT NULL UNIQUE,
        state TEXT NOT NULL CHECK (state IN ('reserved','ready','failed')),
        error TEXT, created_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS one_active_writer_per_repository
        ON worktrees(repository_path) WHERE state IN ('reserved','ready');
    `);
  }

  get(jobId: string): WorktreeRecord | null {
    const row = this.db.prepare("SELECT * FROM worktrees WHERE job_id = ?").get(jobId) as Row | undefined;
    return row ? record(row) : null;
  }

  prepare(input: { jobId: string; repositoryPath: string; baseSha: string }): WorktreeRecord {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.jobId)) {
      throw new WorktreeError("Job ID must be a UUID");
    }
    const repo = repository(input.repositoryPath);
    const base = fullCommitSha(repo, input.baseSha);
    const branch = `codex/gattini-${input.jobId.toLowerCase()}`;
    const path = join(this.root, input.jobId.toLowerCase());
    if (pathExists(path)) throw new WorktreeError("Owned worktree destination already exists");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (this.get(input.jobId)) throw new WorktreeError("Job already has a worktree ownership record");
      this.db.prepare("INSERT INTO worktrees (job_id,repository_path,base_sha,branch,worktree_path,state,created_at) VALUES (?,?,?,?,?,'reserved',?)")
        .run(input.jobId, repo, base, branch, path, new Date().toISOString());
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      if ((error as { code?: string }).code === "ERR_SQLITE_ERROR") throw new WorktreeError("Repository already has an owned coding worktree");
      throw error;
    }
    try {
      git(repo, ["worktree", "add", "--no-track", "-b", branch, path, base]);
      if (git(path, ["rev-parse", "HEAD"]) !== base || realpathSync(path) !== path) {
        throw new WorktreeError("Created worktree does not match the requested base or destination");
      }
      this.db.prepare("UPDATE worktrees SET state = 'ready' WHERE job_id = ? AND state = 'reserved'").run(input.jobId);
    } catch (error) {
      // A partial destination may contain work. Retain the writer lock for manual inspection.
      const state: WorktreeState = pathExists(path) ? "reserved" : "failed";
      this.db.prepare("UPDATE worktrees SET state = ?, error = ? WHERE job_id = ? AND state = 'reserved'")
        .run(state, error instanceof WorktreeError ? error.message : "Worktree preparation failed", input.jobId);
      throw error;
    }
    return this.get(input.jobId)!;
  }

  close(): void { this.db.close(); }
}

export function newWorktreeJobId(): string { return randomUUID(); }
