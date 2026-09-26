/** Private, narrowly scoped Codex worker configuration. No credential material. */
export interface CodexRoleConfig {
  schemaVersion: 1;
  runtime: "codex";
  model: string;
  modelProvider: string;
  directory: string;
  executable: string;
}

export class CodexRoleConfigError extends TypeError {
  constructor(message: string) { super(message); this.name = "CodexRoleConfigError"; }
}

const secretLike = /(?:sk-[A-Za-z0-9_-]{12,}|(?:api[_-]?key|token|secret|password)\s*[:=]\s*\S{8,}|Bearer\s+[A-Za-z0-9._~-]{12,})/i;
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function parseCodexRoleConfig(value: unknown): CodexRoleConfig {
  if (!record(value)) throw new CodexRoleConfigError("Codex role must be an object");
  const keys = ["schemaVersion", "runtime", "model", "modelProvider", "directory", "executable"];
  if (keys.some(key => !(key in value)) || Object.keys(value).some(key => !keys.includes(key))) {
    throw new CodexRoleConfigError("Codex role fields are missing or unknown");
  }
  if (value.schemaVersion !== 1 || value.runtime !== "codex") throw new CodexRoleConfigError("Unsupported Codex role schema or runtime");
  for (const key of ["model", "modelProvider", "directory", "executable"] as const) {
    const field = value[key];
    if (typeof field !== "string" || !field.trim() || field.length > 4096 || field.includes("\0") || secretLike.test(field)) {
      throw new CodexRoleConfigError(`Invalid Codex role ${key}`);
    }
  }
  if (!(value.directory as string).startsWith("/") || (value.directory as string).startsWith("//")) {
    throw new CodexRoleConfigError("Codex directory must be absolute");
  }
  if (value.executable !== "codex" && (!(value.executable as string).startsWith("/") || (value.executable as string).startsWith("//"))) {
    throw new CodexRoleConfigError("Codex executable must be codex or an absolute path");
  }
  return value as unknown as CodexRoleConfig;
}
