/** Task 9's shared interface. A coding worktree separates changes; it is not host containment. */
export interface VerificationCommand {
  /** Executed directly, without a shell, in the owned worktree. */
  argv: string[];
  timeoutMs: number;
}

export interface CodeJobInput {
  task: string;
  idempotencyKey: string;
  repositoryPath: string;
  baseSha: string;
  verificationCommands: VerificationCommand[];
  /** Explicit opt-in to a local runtime with no host containment. */
  trustedLocal: true;
}

export interface OpenCodeCodeRoleConfig {
  runtime: "opencode";
  agent: string;
  model: string;
  serverUrl: string;
}

export interface CodexCodeRoleConfig {
  runtime: "codex";
  model: string;
  modelProvider: string;
  executable: string;
}

export type CodeRoleConfig = OpenCodeCodeRoleConfig | CodexCodeRoleConfig | import("./claude-role-config.js").ClaudeCodeRoleConfig;

export interface VerificationCheckResult {
  argv: string[];
  cwd: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  timedOut: boolean;
}

export interface SnapshotEvidence {
  worktreePath: string;
  baseSha: string;
  snapshotSha: string;
  diffSha256: string;
  changedFiles: string[];
  checks: VerificationCheckResult[];
  acceptance: "passed" | "failed" | "unverified";
  limitations: string[];
  artifact?: { path: string; sha256: string; diffPath: string; diffFileSha256: string };
}

export function parseVerificationCommands(value: unknown): VerificationCommand[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 16) throw new TypeError("Verification commands must contain 1–16 entries");
  return value.map((item, index) => {
    if (typeof item !== "object" || item === null || Array.isArray(item) || Object.keys(item).some(key => !["argv", "timeoutMs"].includes(key))) {
      throw new TypeError(`Invalid verification command ${index}`);
    }
    const command = item as Record<string, unknown>;
    if (!Array.isArray(command.argv) || command.argv.length < 1 || command.argv.length > 32 ||
        command.argv.some(arg => typeof arg !== "string" || arg.length < 1 || arg.length > 4096 || arg.includes("\0"))) {
      throw new TypeError(`Invalid verification argv ${index}`);
    }
    if (!Number.isInteger(command.timeoutMs) || (command.timeoutMs as number) < 100 || (command.timeoutMs as number) > 60_000) {
      throw new TypeError(`Invalid verification timeout ${index}`);
    }
    return { argv: [...command.argv] as string[], timeoutMs: command.timeoutMs as number };
  });
}
