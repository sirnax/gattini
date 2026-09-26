import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { lstat, mkdir, readFile, readdir, readlink, realpath, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { SnapshotEvidence, VerificationCommand, VerificationCheckResult } from "../core/coding.js";
import { inspectionGitCommand } from "../environments/git-inspection.js";

const OUTPUT_LIMIT = 16 * 1024;
const SNAPSHOT_LIMIT = 32 * 1024 * 1024;
const MAX_TIMEOUT_MS = 10 * 60 * 1000;

interface CapturedSnapshot {
  digest: string;
  diffDigest: string;
  changedFiles: string[];
  diff: Buffer;
  entries: Array<{ path: string; mode: number; kind: "file" | "directory" | "link"; content?: string; target?: string }>;
}

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function git(cwd: string, args: string[]): Promise<Buffer> {
  const command = inspectionGitCommand(cwd, args);
  return new Promise((resolve, reject) => {
    const child = spawn("git", command.args, { cwd, env: command.env, stdio: ["ignore", "pipe", "pipe"], shell: false, timeout: 10_000, killSignal: "SIGKILL" });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > SNAPSHOT_LIMIT) child.kill("SIGKILL");
      else stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (Buffer.concat(stderr).length < 2048) stderr.push(chunk.subarray(0, 2048));
    });
    child.once("error", reject);
    child.once("close", code => code === 0
      ? resolve(Buffer.concat(stdout))
      : reject(new Error(bytes > SNAPSHOT_LIMIT ? "Git snapshot output exceeds 32 MiB" : `git ${args[0] ?? ""} failed (${code}): ${Buffer.concat(stderr).toString("utf8").slice(0, 2048)}`)));
  });
}

function splitNul(buffer: Buffer): string[] {
  return buffer.toString("utf8").split("\0").filter(Boolean);
}

async function capture(cwd: string, baseSha: string): Promise<CapturedSnapshot> {
  // The Git diff includes staged and unstaged tracked edits against the requested base.
  const diff = await git(cwd, ["diff", "--binary", "--no-ext-diff", "--no-textconv", "--no-renames", baseSha, "--"]);
  const changedFiles = new Set(splitNul(await git(cwd, ["diff", "--name-only", "-z", "--no-ext-diff", "--no-textconv", "--no-renames", baseSha, "--"])));
  const fileHash = createHash("sha256").update("gattini-tree-v2\0");
  const retained: CapturedSnapshot["entries"] = [];
  let snapshotBytes = 0;
  const walk = async (directory: string, relative = ""): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (!relative && entry.name === ".git") continue;
      const rel = relative ? `${relative}/${entry.name}` : entry.name;
      const absolute = path.join(directory, entry.name);
      const info = await lstat(absolute);
      if (info.isSymbolicLink()) {
        const target = await readlink(absolute);
        fileHash.update(`L\0${rel}\0${info.mode}\0${target}\0`);
        retained.push({ path: rel, mode: info.mode, kind: "link", target });
      } else if (info.isDirectory()) {
        fileHash.update(`D\0${rel}\0${info.mode}\0`);
        retained.push({ path: rel, mode: info.mode, kind: "directory" });
        await walk(absolute, rel);
      } else if (info.isFile()) {
        snapshotBytes += info.size;
        if (snapshotBytes > SNAPSHOT_LIMIT) throw new Error("Worktree snapshot exceeds 32 MiB");
        fileHash.update(`F\0${rel}\0${info.mode}\0${info.size}\0`);
        const content = await readFile(absolute);
        fileHash.update(content);
        fileHash.update("\0");
        retained.push({ path: rel, mode: info.mode, kind: "file", content: content.toString("base64") });
      }
    }
  };
  await walk(cwd);

  // Git's textual diff omits untracked files, so bind each untracked path and its bytes/target.
  const diffHash = createHash("sha256").update("gattini-diff-v2\0").update(diff);
  const untracked = splitNul(await git(cwd, ["ls-files", "--others", "--exclude-standard", "-z"])).sort();
  for (const relative of untracked) {
    changedFiles.add(relative);
    const absolute = path.join(cwd, relative);
    const item = await lstat(absolute);
    diffHash.update(`U\0${relative}\0${item.mode}\0${item.size}\0`);
    if (item.isSymbolicLink()) diffHash.update(`L\0${await readlink(absolute)}\0`);
    else if (item.isFile()) {
      if (item.size > SNAPSHOT_LIMIT) throw new Error("Untracked snapshot file exceeds 32 MiB");
      diffHash.update(await readFile(absolute));
    }
    else diffHash.update(`T\0${item.mode}\0`);
  }
  const diffDigest = diffHash.digest("hex");
  return { digest: sha256(`${diffDigest}\0${fileHash.digest("hex")}`), diffDigest, changedFiles: [...changedFiles].sort(), diff, entries: retained };
}

export async function snapshotFingerprint(worktreePath: string, baseSha: string): Promise<string> {
  return (await capture(await realpath(worktreePath), baseSha)).digest;
}

async function retain(captured: CapturedSnapshot, directory: string): Promise<NonNullable<SnapshotEvidence["artifact"]>> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || (process.getuid && info.uid !== process.getuid()) || (info.mode & 0o077)) throw new Error("Artifact directory must be private and user-owned");
  const payload = Buffer.from(JSON.stringify({ schemaVersion: 1, snapshotSha: captured.digest, diffSha256: captured.diffDigest, changedFiles: captured.changedFiles, entries: captured.entries }));
  if (payload.length > SNAPSHOT_LIMIT * 2) throw new Error("Retained snapshot exceeds 64 MiB");
  const artifactPath = path.join(directory, "snapshot.json");
  const diffPath = path.join(directory, "diff.patch");
  await writeFile(`${artifactPath}.tmp`, payload, { mode: 0o600, flag: "wx" });
  await rename(`${artifactPath}.tmp`, artifactPath);
  await writeFile(`${diffPath}.tmp`, captured.diff, { mode: 0o600, flag: "wx" });
  await rename(`${diffPath}.tmp`, diffPath);
  return { path: artifactPath, sha256: sha256(payload), diffPath, diffFileSha256: sha256(captured.diff) };
}

function runCheck(cwd: string, command: VerificationCommand, signal?: AbortSignal): Promise<VerificationCheckResult> {
  const timeoutMs = Math.min(command.timeoutMs, MAX_TIMEOUT_MS);
  if (process.platform === "win32") {
    return Promise.resolve({ argv: [...command.argv], cwd, exitCode: null, stdout: "", stderr: "Verification requires POSIX process-group cleanup", truncated: false, timedOut: false });
  }
  return new Promise(resolve => {
    // A new POSIX group lets us stop ordinary descendants, including children whose parent exits.
    const child = spawn(command.argv[0]!, command.argv.slice(1), { cwd, shell: false, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let truncated = false;
    let timedOut = false;
    let settled = false;
    let descendantsSurvived = false;
    let drainTimer: NodeJS.Timeout | undefined;
    const collect = (current: Buffer<ArrayBufferLike>, chunk: Buffer<ArrayBufferLike>): Buffer<ArrayBufferLike> => {
      const remaining = Math.max(0, OUTPUT_LIMIT - current.length);
      if (chunk.length > remaining) truncated = true;
      return Buffer.concat([current, chunk.subarray(0, remaining)]);
    };
    child.stdout.on("data", (chunk: Buffer) => { stdout = collect(stdout, chunk); });
    child.stderr.on("data", (chunk: Buffer) => { stderr = collect(stderr, chunk); });
    const stopGroup = (): boolean => {
      if (child.pid === undefined) return false;
      try { process.kill(-child.pid, "SIGKILL"); return true; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
          stderr = collect(stderr, Buffer.from("Could not terminate verification process group\n"));
          descendantsSurvived = true;
        }
        return false;
      }
    };
    // Detached descendants can escape a group and retain pipes. Bound the drain as well.
    const boundDrain = (): void => {
      if (drainTimer) return;
      drainTimer = setTimeout(() => {
        stderr = collect(stderr, Buffer.from("Verification output pipes remained open after process termination\n"));
        child.stdout.destroy();
        child.stderr.destroy();
        finish(null);
      }, 250);
    };
    const timer = setTimeout(() => { timedOut = true; stopGroup(); boundDrain(); }, timeoutMs);
    const abort = (): void => { timedOut = true; stopGroup(); boundDrain(); };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    const finish = (exitCode: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (drainTimer) clearTimeout(drainTimer);
      resolve({ argv: [...command.argv], cwd, exitCode: descendantsSurvived ? null : exitCode, stdout: stdout.toString("utf8"), stderr: stderr.toString("utf8"), truncated, timedOut });
    };
    child.once("exit", () => {
      if (!timedOut && stopGroup()) {
        descendantsSurvived = true;
        stderr = collect(stderr, Buffer.from("Verification left background processes running; process group terminated\n"));
      }
      boundDrain();
    });
    child.once("error", error => { stderr = collect(stderr, Buffer.from(error.message)); finish(null); });
    child.once("close", code => finish(code));
  });
}

export async function verifySnapshot(input: { worktreePath: string; baseSha: string; commands: VerificationCommand[]; artifactDirectory?: string; signal?: AbortSignal; onCaptured?: (artifact: NonNullable<SnapshotEvidence["artifact"]>) => void }): Promise<SnapshotEvidence> {
  const requestedPath = path.resolve(input.worktreePath);
  const canonicalPath = await realpath(requestedPath);
  const info = await lstat(canonicalPath);
  if (!info.isDirectory()) throw new Error("worktreePath must resolve to a directory");
  if (!/^[0-9a-f]{7,64}$/i.test(input.baseSha)) throw new Error("baseSha must be a Git commit identifier");
  for (const command of input.commands) {
    if (!Array.isArray(command.argv) || command.argv.length === 0 || command.argv.some(arg => typeof arg !== "string" || arg.length === 0 || arg.includes("\0"))) throw new Error("verification argv must contain non-empty strings");
    if (!Number.isFinite(command.timeoutMs) || command.timeoutMs < 1) throw new Error("verification timeoutMs must be positive");
  }

  const before = await capture(canonicalPath, input.baseSha);
  const artifact = input.artifactDirectory ? await retain(before, input.artifactDirectory) : undefined;
  if (artifact) input.onCaptured?.(artifact);
  const checks: VerificationCheckResult[] = [];
  for (const command of input.commands) {
    if (input.signal?.aborted) break;
    checks.push(await runCheck(canonicalPath, command, input.signal));
  }
  let after: CapturedSnapshot;
  try {
    after = await capture(canonicalPath, input.baseSha);
  } catch {
    after = { ...before, digest: "" };
  }
  const checksPassed = checks.length === input.commands.length && checks.length > 0 && checks.every(check => check.exitCode === 0 && !check.timedOut) && !input.signal?.aborted;
  const unchanged = before.digest === after.digest;
  const limitations = [
    "A worktree is a Git checkout, not host containment; verification commands can access other host resources.",
    "Commands are launched without a shell, but a command may itself invoke a shell or modify files outside this worktree.",
    "Verification terminates ordinary POSIX process groups; descendants that create a new session can escape and are not contained.",
    "The snapshot hashes worktree entries and bytes while excluding Git metadata; concurrent mutation during capture cannot be ruled out.",
  ];
  if (!unchanged) limitations.push("Worktree changed during verification; snapshot evidence is invalid");
  return {
    worktreePath: canonicalPath,
    baseSha: input.baseSha,
    snapshotSha: before.digest,
    diffSha256: before.diffDigest,
    changedFiles: before.changedFiles,
    checks,
    acceptance: checksPassed && unchanged ? "passed" : "failed",
    limitations,
    ...(artifact ? { artifact } : {}),
  };
}
