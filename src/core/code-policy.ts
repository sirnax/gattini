import { realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";
import type { CodeRoleConfig, CodexCodeRoleConfig, OpenCodeCodeRoleConfig } from "./coding.js";

export class CodePolicyError extends Error {
  constructor(message: string) { super(message); this.name = "CodePolicyError"; }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function exactKeys(value: Record<string, unknown>, keys: string[], label: string): void {
  for (const key of keys) if (!(key in value)) throw new CodePolicyError(`${label} is missing ${key}`);
  for (const key of Object.keys(value)) if (!keys.includes(key)) throw new CodePolicyError(`${label} has unknown field ${key}`);
}

function nonEmpty(value: unknown, label: string, max: number): asserts value is string {
  if (typeof value !== "string" || value.trim() === "" || value.length > max || value.includes("\0")) {
    throw new CodePolicyError(`${label} must be a non-empty string of at most ${max} characters`);
  }
}

const credentialLiteral = /(?:sk-[A-Za-z0-9_-]{12,}|(?:api[_-]?key|token|secret|password)\s*[:=]\s*\S{8,}|Bearer\s+[A-Za-z0-9._~-]{12,})/i;

/** Parse private code-role JSON without filesystem or runtime side effects. */
export function parseCodeRoleConfig(value: unknown): OpenCodeCodeRoleConfig {
  if (!isRecord(value)) throw new CodePolicyError("Code role config must be an object");
  exactKeys(value, ["runtime", "agent", "model", "serverUrl"], "Code role config");
  if (value.runtime !== "opencode") throw new CodePolicyError("Code role runtime must be opencode");
  nonEmpty(value.agent, "Code role agent", 128);
  nonEmpty(value.model, "Code role model", 256);
  nonEmpty(value.serverUrl, "Code role serverUrl", 2_048);
  let url: URL;
  try { url = new URL(value.serverUrl); } catch { throw new CodePolicyError("Code role serverUrl must be an explicit loopback URL"); }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]", "::1"].includes(host) ||
      url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new CodePolicyError("Code role serverUrl must be a plain HTTP loopback origin without credentials, path, query, or fragment");
  }
  if ([value.agent, value.model, value.serverUrl].some(entry => credentialLiteral.test(entry))) {
    throw new CodePolicyError("Code role config must not contain credential literals");
  }
  return { runtime: "opencode", agent: value.agent, model: value.model, serverUrl: value.serverUrl };
}

/** Exact private role mapping for either guarded proposal backend. */
export function parseWorkerCodeRoleConfig(value: unknown): CodeRoleConfig {
  if (!isRecord(value)) throw new CodePolicyError("Code role config must be an object");
  if (value.runtime === "opencode") return parseCodeRoleConfig(value);
  exactKeys(value, ["runtime", "model", "modelProvider", "executable"], "Codex code role config");
  if (value.runtime !== "codex") throw new CodePolicyError("Unsupported code role runtime");
  nonEmpty(value.model, "Codex code model", 256);
  nonEmpty(value.modelProvider, "Codex code modelProvider", 128);
  nonEmpty(value.executable, "Codex code executable", 4_096);
  if (value.executable !== "codex" && (!value.executable.startsWith("/") || value.executable.startsWith("//"))) {
    throw new CodePolicyError("Codex code executable must be codex or an absolute path");
  }
  if ([value.model, value.modelProvider, value.executable].some(entry => credentialLiteral.test(entry))) {
    throw new CodePolicyError("Code role config must not contain credential literals");
  }
  return value as unknown as CodexCodeRoleConfig;
}

export interface CodePermissionRule { action: string; resource: string; effect: "allow" | "deny" }

/** The approved V2.0.18 probe wrote outside the worktree through an in-tree symlink. */
export const CODE_PATH_PERMISSION_SYNTAX_VERIFIED = false;

/**
 * Proposed effective V2 rules for a trusted local coding run. In V2, `edit`
 * covers edit/write/patch and internal paths are location-relative. The
 * deny-all rule also denies `external_directory`. These semantics still need
 * a stronger write boundary before this matcher can enable launch. The
 * installed V2.0.18 edit tool followed an in-tree symlink outside the root.
 * OpenCode tool permissions are not OS filesystem or network containment.
 */
export function expectedCodePermissions(worktreePath: string): CodePermissionRule[] {
  canonicalWorktree(worktreePath);
  return [
    { action: "*", resource: "*", effect: "deny" },
    { action: "read", resource: "*", effect: "allow" },
    { action: "glob", resource: "*", effect: "allow" },
    { action: "grep", resource: "*", effect: "allow" },
    { action: "edit", resource: "*", effect: "allow" },
  ];
}

/** Require a canonical existing worktree directory and reject a symlink alias. */
export function canonicalWorktree(worktreePath: string): string {
  if (!isAbsolute(worktreePath) || worktreePath.includes("\0")) throw new CodePolicyError("Coding worktree path must be absolute");
  let root: string;
  try { root = realpathSync(worktreePath); } catch { throw new CodePolicyError("Coding worktree path does not exist"); }
  const stat = statSync(root);
  if (!stat.isDirectory() || root !== worktreePath) throw new CodePolicyError("Coding worktree path must be a canonical directory path");
  const rel = relative(root, worktreePath);
  if (rel === ".." || rel.startsWith(`..${sep}`)) throw new CodePolicyError("Coding worktree path is invalid");
  return root;
}

export function matchesCodePermissions(actual: unknown, worktreePath: string): boolean {
  const expected = expectedCodePermissions(worktreePath);
  if (!Array.isArray(actual) || actual.length !== expected.length) return false;
  return actual.every((value, index) => {
    if (!isRecord(value)) return false;
    const wanted = expected[index]!;
    return value.action === wanted.action && value.resource === wanted.resource && value.effect === wanted.effect &&
      Object.keys(value).every(key => ["action", "resource", "effect"].includes(key));
  });
}
