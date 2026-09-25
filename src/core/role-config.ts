/** Strict, side-effect-free role configuration for the first OpenCode reviewer. */

export type ReviewerPermission = {
  action: string;
  resource: string;
  effect: "allow" | "deny";
};

export interface ReviewerRoleConfig {
  runtime: "opencode";
  agent: string;
  /** Exact OpenCode provider/model key (for example `openrouter/z-ai/glm-5.3-flash`). */
  model: string;
  directory: string;
  serverUrl: string;
  permissions: ReviewerPermission[];
}

export interface RoleConfig {
  schemaVersion: 1;
  roles: { reviewer: ReviewerRoleConfig };
}

export class RoleConfigError extends TypeError {
  constructor(message: string) {
    super(message);
    this.name = "RoleConfigError";
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function exactKeys(value: Record<string, unknown>, keys: string[], label: string): void {
  for (const key of keys) if (!(key in value)) throw new RoleConfigError(`${label} is missing ${key}`);
  for (const key of Object.keys(value)) if (!keys.includes(key)) throw new RoleConfigError(`${label} has unknown field ${key}`);
}

function nonEmpty(value: unknown, label: string, max = 512): asserts value is string {
  if (typeof value !== "string" || value.trim() === "" || value.length > max || value.includes("\0")) {
    throw new RoleConfigError(`${label} must be a non-empty string of at most ${max} characters`);
  }
}

const credentialLiteral = /(?:sk-[A-Za-z0-9_-]{12,}|(?:api[_-]?key|token|secret|password)\s*[:=]\s*\S{8,}|Bearer\s+[A-Za-z0-9._~-]{12,})/i;

function loopbackUrl(value: unknown): asserts value is string {
  nonEmpty(value, "roles.reviewer.serverUrl", 2_048);
  let url: URL;
  try { url = new URL(value); } catch { throw new RoleConfigError("roles.reviewer.serverUrl must be an explicit loopback URL"); }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]", "::1"].includes(host) ||
      url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new RoleConfigError("roles.reviewer.serverUrl must be a plain HTTP loopback origin without credentials, path, query, or fragment");
  }
}

const expectedPermissions: ReviewerPermission[] = [
  { action: "*", resource: "*", effect: "deny" },
  { action: "read", resource: "*", effect: "allow" },
  { action: "glob", resource: "*", effect: "allow" },
  { action: "grep", resource: "*", effect: "allow" },
];

/** Validate untrusted JSON data. This function performs no filesystem or runtime IO. */
export function parseRoleConfig(value: unknown): RoleConfig {
  if (!isRecord(value)) throw new RoleConfigError("Role config must be an object");
  exactKeys(value, ["schemaVersion", "roles"], "Role config");
  if (value.schemaVersion !== 1) throw new RoleConfigError("Unsupported role config schemaVersion");
  if (!isRecord(value.roles)) throw new RoleConfigError("roles must be an object");
  exactKeys(value.roles, ["reviewer"], "roles");
  const reviewer = value.roles.reviewer;
  if (!isRecord(reviewer)) throw new RoleConfigError("roles.reviewer must be an object");
  exactKeys(reviewer, ["runtime", "agent", "model", "directory", "serverUrl", "permissions"], "roles.reviewer");
  if (reviewer.runtime !== "opencode") throw new RoleConfigError("roles.reviewer.runtime must be opencode");
  nonEmpty(reviewer.agent, "roles.reviewer.agent", 128);
  nonEmpty(reviewer.model, "roles.reviewer.model", 256);
  nonEmpty(reviewer.directory, "roles.reviewer.directory", 4_096);
  if (!reviewer.directory.startsWith("/") || reviewer.directory.startsWith("//")) throw new RoleConfigError("roles.reviewer.directory must be an absolute POSIX path");
  loopbackUrl(reviewer.serverUrl);
  if (!Array.isArray(reviewer.permissions) || reviewer.permissions.length !== expectedPermissions.length) {
    throw new RoleConfigError("roles.reviewer.permissions must contain deny-all followed by read, glob, and grep allows");
  }
  const permissions: ReviewerPermission[] = reviewer.permissions.map((rule, index) => {
    if (!isRecord(rule)) throw new RoleConfigError(`roles.reviewer.permissions[${index}] must be an object`);
    exactKeys(rule, ["action", "resource", "effect"], `roles.reviewer.permissions[${index}]`);
    const expected = expectedPermissions[index]!;
    if (rule.action !== expected.action || rule.resource !== expected.resource || rule.effect !== expected.effect) {
      throw new RoleConfigError("roles.reviewer.permissions must deny * first, then allow read, glob, and grep on * in that order");
    }
    return { action: expected.action, resource: expected.resource, effect: expected.effect };
  });
  const strings = [reviewer.agent, reviewer.model, reviewer.directory, reviewer.serverUrl];
  if (strings.some((entry) => credentialLiteral.test(entry))) throw new RoleConfigError("Role config must not contain credential literals");
  return {
    schemaVersion: 1,
    roles: {
      reviewer: {
        runtime: "opencode",
        agent: reviewer.agent,
        model: reviewer.model,
        directory: reviewer.directory,
        serverUrl: reviewer.serverUrl,
        permissions,
      },
    },
  };
}
