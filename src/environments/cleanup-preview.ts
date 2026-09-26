/** Read-only cleanup planning for exact Gattini-owned coding worktrees. */
import { spawnSync } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import { WorktreeError, WorktreeManager, type WorktreeRecord } from "./worktree.js";
import { inspectionGitCommand } from "./git-inspection.js";

export type CleanupRetentionReason =
  | "record-not-ready" | "job-not-completed" | "job-state-unknown"
  | "record-identity-mismatch" | "path-missing-or-aliased"
  | "repository-identity-mismatch" | "worktree-identity-mismatch"
  | "branch-mismatch" | "dirty-worktree" | "unmerged-branch"
  | "git-inspection-failed";

export interface CleanupPreviewEntry extends WorktreeRecord {
  eligible: boolean;
  reasons: CleanupRetentionReason[];
}

function git(cwd: string, ...args: string[]): { ok: boolean; output: string; status: number | null } {
  const safe = inspectionGitCommand(cwd, args);
  const result = spawnSync("git", safe.args, {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30_000,
    env: { ...safe.env, GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0" },
  });
  return { ok: result.status === 0 && !result.error, output: result.stdout?.trim() ?? "", status: result.status };
}

function canonicalDirectory(path: string): string | null {
  try {
    const stat = lstatSync(path);
    return stat.isDirectory() && !stat.isSymbolicLink() ? realpathSync(path) : null;
  } catch { return null; }
}

function commonDirectory(path: string): string | null {
  const result = git(path, "rev-parse", "--path-format=absolute", "--git-common-dir");
  if (!result.ok) return null;
  return canonicalDirectory(result.output);
}

function isRegistered(repo: string, value: WorktreeRecord): boolean | null {
  const result = git(repo, "worktree", "list", "--porcelain");
  if (!result.ok) return null;
  const entries = result.output.split(/\n\s*\n/);
  return entries.some(entry => {
    const lines = entry.split("\n");
    return lines.includes(`worktree ${value.worktreePath}`) &&
      lines.includes(`branch refs/heads/${value.branch}`);
  });
}

function inspect(value: WorktreeRecord, reasons: CleanupRetentionReason[]): void {
  if (canonicalDirectory(value.repositoryPath) !== value.repositoryPath) {
    reasons.push("repository-identity-mismatch");
    return;
  }
  if (canonicalDirectory(value.worktreePath) !== value.worktreePath) {
    reasons.push("path-missing-or-aliased");
    return;
  }
  const repoTop = git(value.repositoryPath, "rev-parse", "--show-toplevel");
  const treeTop = git(value.worktreePath, "rev-parse", "--show-toplevel");
  const repoCommon = commonDirectory(value.repositoryPath);
  const treeCommon = commonDirectory(value.worktreePath);
  const registered = isRegistered(value.repositoryPath, value);
  if (!repoTop.ok || !treeTop.ok || !repoCommon || !treeCommon || registered === null) {
    reasons.push("git-inspection-failed");
    return;
  }
  if (repoTop.output !== value.repositoryPath || treeTop.output !== value.worktreePath ||
      repoCommon !== treeCommon || !registered) {
    reasons.push("worktree-identity-mismatch");
    return;
  }
  const branch = git(value.worktreePath, "symbolic-ref", "--quiet", "HEAD");
  const head = git(value.worktreePath, "rev-parse", "--verify", "HEAD");
  const ref = git(value.repositoryPath, "rev-parse", "--verify", `refs/heads/${value.branch}`);
  if (!branch.ok || !head.ok || !ref.ok || branch.output !== `refs/heads/${value.branch}` || head.output !== ref.output) {
    reasons.push("branch-mismatch");
    return;
  }
  const status = git(value.worktreePath, "status", "--porcelain=v1", "--untracked-files=all", "--ignore-submodules=none");
  if (!status.ok) reasons.push("git-inspection-failed");
  else if (status.output !== "") reasons.push("dirty-worktree");
  const merged = git(value.repositoryPath, "merge-base", "--is-ancestor", `refs/heads/${value.branch}`, "HEAD");
  if (merged.status === 1) reasons.push("unmerged-branch");
  else if (!merged.ok) reasons.push("git-inspection-failed");
}

/** Preview only. The callback must return the durable job state, or null when unavailable. */
export function previewOwnedCleanup(
  worktrees: WorktreeManager,
  jobState: (jobId: string) => string | null,
  requestedJobId?: string,
): CleanupPreviewEntry[] {
  const records = worktrees.listRecords().filter(value => requestedJobId === undefined || value.jobId === requestedJobId);
  if (requestedJobId !== undefined && records.length === 0) throw new WorktreeError("No ownership record exists for the requested job");
  return records.map(value => {
    const reasons: CleanupRetentionReason[] = [];
    if (!worktrees.matchesExpectedIdentity(value)) reasons.push("record-identity-mismatch");
    if (value.state !== "ready") reasons.push("record-not-ready");
    let state: string | null;
    try { state = jobState(value.jobId); }
    catch { state = null; }
    if (state === null) reasons.push("job-state-unknown");
    else if (state !== "completed") reasons.push("job-not-completed");
    if (!reasons.includes("record-identity-mismatch") && value.state === "ready") inspect(value, reasons);
    return { ...value, eligible: reasons.length === 0, reasons };
  });
}
