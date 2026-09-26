import { parseCodexRoleConfig, type CodexRoleConfig } from "./codex-role-config.js";
import { parseRoleConfig, type ReviewerRoleConfig } from "./role-config.js";

/** The same caller role may select either installed worker through private state. */
export type WorkerReviewerConfig = ReviewerRoleConfig | CodexRoleConfig;

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function parseWorkerReviewerConfig(value: unknown): WorkerReviewerConfig {
  if (!record(value) || value.schemaVersion !== 1 || !record(value.roles) ||
      Object.keys(value).some(key => !["schemaVersion", "roles"].includes(key)) ||
      Object.keys(value.roles).some(key => key !== "reviewer") || !record(value.roles.reviewer)) {
    throw new TypeError("Invalid worker role mapping");
  }
  if (value.roles.reviewer.runtime === "opencode") return parseRoleConfig(value).roles.reviewer;
  if (value.roles.reviewer.runtime === "codex") {
    if (Object.keys(value.roles.reviewer).some(key => !["runtime", "model", "modelProvider", "directory", "executable"].includes(key))) {
      throw new TypeError("Unknown Codex reviewer role field");
    }
    return parseCodexRoleConfig({ schemaVersion: 1, ...value.roles.reviewer });
  }
  throw new TypeError("Unsupported reviewer runtime");
}
