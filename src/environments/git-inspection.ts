import { execFileSync } from "node:child_process";

/** Read-only Git inspection must not run repository conversion or monitor commands.
 * These overrides are per invocation; user and repository configuration is untouched.
 */
export function inspectionGitCommand(cwd: string, args: string[]): { args: string[]; env: NodeJS.ProcessEnv } {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
  const prefix = ["--no-pager", "--literal-pathspecs", "--no-optional-locks", "-C", cwd,
    "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null"];
  let filterKeys: string[];
  try {
    filterKeys = execFileSync("git", [...prefix, "config", "--null", "--name-only", "--get-regexp", "^filter\\..*\\.(clean|smudge|process|required)$"],
      { encoding: "utf8", env, timeout: 5000, maxBuffer: 64 * 1024, stdio: ["ignore", "pipe", "pipe"] }).split("\0").filter(Boolean);
  } catch (error) {
    if ((error as { status?: number }).status !== 1) throw error;
    filterKeys = [];
  }
  for (const key of new Set(filterKeys)) prefix.push("-c", `${key}=${key.endsWith(".required") ? "false" : ""}`);
  return { args: [...prefix, ...args], env };
}
