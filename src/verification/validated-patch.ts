/** Narrow Task 9 write boundary for a read-only runtime's untrusted proposal.
 * One existing, tracked, root-level regular file is replaced atomically.
 * Nested paths and file creation need a separate boundary design.
 */
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { closeSync, fchmodSync, fsyncSync, lstatSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import { inspectionGitCommand } from "../environments/git-inspection.js";

const MAX_PROPOSAL_BYTES = 1024 * 1024;
const hash = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

export class PatchBoundaryError extends Error {
  constructor(message: string) { super(message); this.name = "PatchBoundaryError"; }
}

export interface ValidatedPatch {
  readonly worktreePath: string;
  readonly baseSha: string;
  readonly path: string;
  readonly beforeSha256: string;
  readonly afterSha256: string;
  readonly after: Buffer;
  readonly rootDevice: number;
  readonly rootInode: number;
  readonly targetDevice: number;
  readonly targetInode: number;
  readonly targetMtimeMs: number;
  readonly targetCtimeMs: number;
}

// The caller's inspection object is never itself write authority. Keep a private
// copy of the validated bytes and consume the handle once, including on failure.
const validatedPatches = new WeakMap<ValidatedPatch, ValidatedPatch>();

function git(cwd: string, args: string[]): string {
  const command = inspectionGitCommand(cwd, args);
  return execFileSync("git", command.args, { encoding: "utf8", timeout: 10_000, maxBuffer: MAX_PROPOSAL_BYTES, env: command.env, stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function safeRoot(worktreePath: string, baseSha: string): string {
  if (!isAbsolute(worktreePath) || worktreePath.includes("\0") || !/^[0-9a-f]{40}$|^[0-9a-f]{64}$/i.test(baseSha)) throw new PatchBoundaryError("Canonical worktree and full base SHA required");
  const root = realpathSync(worktreePath);
  if (root !== worktreePath || !lstatSync(root).isDirectory()) throw new PatchBoundaryError("Worktree path must be canonical");
  if (realpathSync(git(root, ["rev-parse", "--show-toplevel"])) !== root || git(root, ["rev-parse", "HEAD"]).toLowerCase() !== baseSha.toLowerCase()) {
    throw new PatchBoundaryError("Worktree root or HEAD differs from approved base");
  }
  return root;
}

/** Strict JSON wire format; no Git patch syntax, modes, links, or multiple paths. */
export function validatePatch(proposal: string, worktreePath: string, baseSha: string): ValidatedPatch {
  if (Buffer.byteLength(proposal) > MAX_PROPOSAL_BYTES) throw new PatchBoundaryError("Patch proposal exceeds 1 MiB");
  let parsed: unknown;
  try { parsed = JSON.parse(proposal) as unknown; } catch { throw new PatchBoundaryError("Malformed patch JSON"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new PatchBoundaryError("Patch must be an object");
  const patch = parsed as Record<string, unknown>;
  if (Object.keys(patch).sort().join(",") !== "afterBase64,beforeSha256,path") throw new PatchBoundaryError("Patch fields must be exactly path, beforeSha256, afterBase64");
  if (typeof patch.path !== "string" || !patch.path || patch.path === ".git" || patch.path === "." || patch.path === ".." ||
      basename(patch.path) !== patch.path || /[/\\\0]/.test(patch.path) || isAbsolute(patch.path)) {
    throw new PatchBoundaryError("Patch path must be one root-level filename");
  }
  if (typeof patch.beforeSha256 !== "string" || !/^[0-9a-f]{64}$/i.test(patch.beforeSha256)) throw new PatchBoundaryError("Invalid preimage hash");
  if (typeof patch.afterBase64 !== "string" || patch.afterBase64.length > MAX_PROPOSAL_BYTES * 2 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(patch.afterBase64)) {
    throw new PatchBoundaryError("Invalid replacement encoding");
  }
  const after = Buffer.from(patch.afterBase64, "base64");
  if (after.length > MAX_PROPOSAL_BYTES || after.toString("base64") !== patch.afterBase64) throw new PatchBoundaryError("Invalid replacement bytes");
  const root = safeRoot(worktreePath, baseSha);
  const target = join(root, patch.path);
  const rootInfo = lstatSync(root);
  const info = lstatSync(target);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > MAX_PROPOSAL_BYTES) throw new PatchBoundaryError("Patch target must be a bounded regular file without links");
  try { git(root, ["ls-files", "--error-unmatch", "--", patch.path]); }
  catch { throw new PatchBoundaryError("Patch target must be tracked"); }
  if (git(root, ["status", "--porcelain=v1", "--untracked-files=all", "--", patch.path])) throw new PatchBoundaryError("Patch target differs from base");
  const before = readFileSync(target);
  if (hash(before) !== patch.beforeSha256.toLowerCase()) throw new PatchBoundaryError("Patch preimage hash differs from target");
  if (before.equals(after)) throw new PatchBoundaryError("Patch makes no change");
  const validated = { worktreePath: root, baseSha, path: patch.path, beforeSha256: hash(before), afterSha256: hash(after), after,
    rootDevice: rootInfo.dev, rootInode: rootInfo.ino, targetDevice: info.dev, targetInode: info.ino,
    targetMtimeMs: info.mtimeMs, targetCtimeMs: info.ctimeMs };
  const handle = Object.freeze({ ...validated, after: Buffer.from(after) });
  validatedPatches.set(handle, validated);
  return handle;
}

/** All rejection checks precede the single atomic rename. A failed apply leaves target bytes intact. */
export function applyValidatedPatch(handle: ValidatedPatch): { path: string; sha256: string } {
  const patch = validatedPatches.get(handle);
  if (!patch) throw new PatchBoundaryError("A fresh validated patch handle is required");
  validatedPatches.delete(handle);
  const root = safeRoot(patch.worktreePath, patch.baseSha);
  const target = join(root, patch.path);
  const temp = join(root, `.gattini-patch-${randomUUID()}`);
  let staged = false;
  try {
    const current = lstatSync(target);
    const fd = openSync(temp, "wx", 0o600);
    staged = true;
    try { writeFileSync(fd, patch.after); fchmodSync(fd, current.mode & 0o777); fsyncSync(fd); } finally { closeSync(fd); }
    const rootNow = lstatSync(root);
    const targetNow = lstatSync(target);
    if (rootNow.dev !== patch.rootDevice || rootNow.ino !== patch.rootInode ||
        !targetNow.isFile() || targetNow.isSymbolicLink() || targetNow.nlink !== 1 ||
        targetNow.dev !== patch.targetDevice || targetNow.ino !== patch.targetInode ||
        targetNow.mtimeMs !== patch.targetMtimeMs || targetNow.ctimeMs !== patch.targetCtimeMs ||
        hash(readFileSync(target)) !== patch.beforeSha256) {
      throw new PatchBoundaryError("Patch target changed between validation and apply");
    }
    renameSync(temp, target);
    staged = false;
    return { path: patch.path, sha256: patch.afterSha256 };
  } finally {
    if (staged) rmSync(temp, { force: true });
  }
}
