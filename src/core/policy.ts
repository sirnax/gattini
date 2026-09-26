import { createHash } from "node:crypto";
import type { Capability } from "./contracts.js";
import { ProtocolError } from "./protocol.js";
import { parseRoleConfig, type ReviewerRoleConfig } from "./role-config.js";

/** This is a runtime tool policy, not filesystem or host containment. */
export function enforceReviewerPolicy(config: unknown, required: Capability[] = []): ReviewerRoleConfig {
  const role = parseRoleConfig({ schemaVersion: 1, roles: { reviewer: config } }).roles.reviewer;
  const supported: Capability[] = ["headless", "explicit-session", "event-stream", "cancellation", "permission-enforcement"];
  for (const capability of required) {
    if (!supported.includes(capability)) throw new ProtocolError("UNSUPPORTED_POLICY", `OpenCode reviewer cannot enforce ${capability}`);
  }
  return role;
}

export interface ReviewLaunchAction {
  kind: "review-launch";
  inputDigest: string;
  task: string;
  directory: string;
  agent: string;
  model: string;
}

export function reviewLaunchAction(inputDigest: string, task: string, config: ReviewerRoleConfig): ReviewLaunchAction {
  return { kind: "review-launch", inputDigest, task, directory: config.directory, agent: config.agent, model: config.model };
}

export function actionDigest(action: ReviewLaunchAction): string {
  return createHash("sha256").update(JSON.stringify(action)).digest("hex");
}
