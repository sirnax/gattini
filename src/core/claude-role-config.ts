/** Private Claude worker configuration; credentials stay with the installed CLI. */
export interface ClaudeRoleConfig {
  runtime: "claude";
  model: string;
  executable: string;
  directory: string;
  maxBudgetUsd: number;
}

export interface ClaudeCodeRoleConfig extends Omit<ClaudeRoleConfig, "directory"> {}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function parseClaudeRoleConfig(value: unknown, code = false): ClaudeRoleConfig | ClaudeCodeRoleConfig {
  if (!record(value)) throw new TypeError("Claude role must be an object");
  const keys = code ? ["runtime", "model", "executable", "maxBudgetUsd"] :
    ["runtime", "model", "executable", "directory", "maxBudgetUsd"];
  if (value.runtime !== "claude" || keys.some(key => !(key in value)) ||
      Object.keys(value).some(key => !keys.includes(key))) throw new TypeError("Invalid Claude role fields");
  if (typeof value.model !== "string" || !/^claude-[a-z0-9-]+-\d{8}$/.test(value.model) || value.model.length > 256) {
    throw new TypeError("Claude model must be a full dated model ID");
  }
  if (typeof value.executable !== "string" || (value.executable !== "claude" &&
      (!value.executable.startsWith("/") || value.executable.startsWith("//"))) ||
      value.executable.length > 4096 || value.executable.includes("\0")) throw new TypeError("Invalid Claude executable");
  if (!code && (typeof value.directory !== "string" || !value.directory.startsWith("/") ||
      value.directory.startsWith("//") || value.directory.includes("\0") || value.directory.length > 4096)) {
    throw new TypeError("Invalid Claude directory");
  }
  if (typeof value.maxBudgetUsd !== "number" || !Number.isFinite(value.maxBudgetUsd) ||
      value.maxBudgetUsd <= 0 || value.maxBudgetUsd > 1) throw new TypeError("Claude invocation budget must be in (0, 1] USD");
  return value as unknown as ClaudeRoleConfig | ClaudeCodeRoleConfig;
}
