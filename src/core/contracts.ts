/** Versioned, dependency-free contracts shared by runtime adapters. */
import type { SnapshotEvidence } from "./coding.js";
import type { UsageProvenance } from "./usage.js";

export type Capability =
  | "headless"
  | "explicit-session"
  | "follow-up"
  | "event-stream"
  | "cancellation"
  | "permission-enforcement"
  | "structured-output"
  | "usage-reporting"
  | "execution-containment";

export interface Job {
  schemaVersion: 1;
  id: string;
  parentWorkflowId: string | null;
  role: string;
  task: string;
  acceptanceCriteria: string[];
  capabilities: Capability[];
  inputReferences: string[];
  repository: { path: string; baseSha: string | null } | null;
  allowedScope: string[];
  verificationCommands: string[];
  limits: { timeoutSeconds: number; maxEvents: number };
  approvalPolicy: "manual" | "none";
}

export interface CredentialReference {
  kind: "env" | "keychain";
  name: string;
}

export interface RuntimeConfig {
  runtime: string;
  agent: string;
  model: string | null;
  credential: CredentialReference | null;
  options: Record<string, string | number | boolean>;
}

export type RuntimeEventType = "started" | "progress" | "completed";
export interface RuntimeEvent {
  schemaVersion: 1;
  jobId: string;
  sequence: number;
  timestamp: string;
  type: RuntimeEventType;
  payload: { message: string };
}

export interface RuntimeResult {
  schemaVersion: 1;
  jobId: string;
  execution: "completed" | "failed";
  acceptance: "passed" | "failed" | "unverified";
  summary: string;
  changedFiles: string[];
  verification: Array<{ command: string; exitCode: number | null }>;
  limitations: string[];
  snapshot?: SnapshotEvidence;
  usage?: UsageProvenance;
  escalation?: { code: "RETRY_EXHAUSTED"; reason: string };
}

export class ContractError extends TypeError {
  constructor(message: string) {
    super(message);
    this.name = "ContractError";
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function exactKeys(value: Record<string, unknown>, required: string[], optional: string[] = []): void {
  for (const key of required) if (!(key in value)) throw new ContractError(`Missing field: ${key}`);
  for (const key of Object.keys(value)) {
    if (!required.includes(key) && !optional.includes(key)) throw new ContractError(`Unknown field: ${key}`);
  }
}

function nonEmptyString(value: unknown, label: string, max = 4_096): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > max) {
    throw new ContractError(`${label} must be a non-empty string of at most ${max} characters`);
  }
}

function stringArray(value: unknown, label: string, maxItems = 100): asserts value is string[] {
  if (!Array.isArray(value) || value.length > maxItems) throw new ContractError(`${label} must be an array of at most ${maxItems} strings`);
  value.forEach((item, index) => nonEmptyString(item, `${label}[${index}]`));
}

const capabilities: Capability[] = ["headless", "explicit-session", "follow-up", "event-stream", "cancellation", "permission-enforcement", "structured-output", "usage-reporting", "execution-containment"];

export function parseJob(value: unknown): Job {
  if (!isRecord(value)) throw new ContractError("Job must be an object");
  exactKeys(value, ["schemaVersion", "id", "parentWorkflowId", "role", "task", "acceptanceCriteria", "capabilities", "inputReferences", "repository", "allowedScope", "verificationCommands", "limits", "approvalPolicy"]);
  if (value.schemaVersion !== 1) throw new ContractError("Unsupported job schemaVersion");
  nonEmptyString(value.id, "id", 128);
  if (value.parentWorkflowId !== null) nonEmptyString(value.parentWorkflowId, "parentWorkflowId", 128);
  nonEmptyString(value.role, "role", 128);
  nonEmptyString(value.task, "task", 16_384);
  stringArray(value.acceptanceCriteria, "acceptanceCriteria");
  if (!Array.isArray(value.capabilities) || value.capabilities.some((item) => !capabilities.includes(item as Capability))) throw new ContractError("capabilities contains an unsupported value");
  stringArray(value.inputReferences, "inputReferences");
  if (value.repository !== null) {
    if (!isRecord(value.repository)) throw new ContractError("repository must be an object or null");
    exactKeys(value.repository, ["path", "baseSha"]);
    nonEmptyString(value.repository.path, "repository.path", 4_096);
    if (value.repository.baseSha !== null) nonEmptyString(value.repository.baseSha, "repository.baseSha", 128);
  }
  stringArray(value.allowedScope, "allowedScope");
  stringArray(value.verificationCommands, "verificationCommands");
  if (!isRecord(value.limits)) throw new ContractError("limits must be an object");
  exactKeys(value.limits, ["timeoutSeconds", "maxEvents"]);
  if (!Number.isInteger(value.limits.timeoutSeconds) || (value.limits.timeoutSeconds as number) < 1 || (value.limits.timeoutSeconds as number) > 86_400) throw new ContractError("limits.timeoutSeconds is out of range");
  if (!Number.isInteger(value.limits.maxEvents) || (value.limits.maxEvents as number) < 1 || (value.limits.maxEvents as number) > 10_000) throw new ContractError("limits.maxEvents is out of range");
  if (value.approvalPolicy !== "manual" && value.approvalPolicy !== "none") throw new ContractError("approvalPolicy must be manual or none");
  return value as unknown as Job;
}

const secretLike = /(?:sk-[A-Za-z0-9_-]{12,}|(?:api[_-]?key|token|secret|password)\s*[:=]\s*\S{8,}|Bearer\s+[A-Za-z0-9._~-]{12,})/i;

export function parseRuntimeConfig(value: unknown): RuntimeConfig {
  if (!isRecord(value)) throw new ContractError("Runtime config must be an object");
  exactKeys(value, ["runtime", "agent", "model", "credential", "options"]);
  nonEmptyString(value.runtime, "runtime", 128);
  nonEmptyString(value.agent, "agent", 128);
  if (value.model !== null) nonEmptyString(value.model, "model", 256);
  if (value.credential !== null) {
    if (!isRecord(value.credential)) throw new ContractError("credential must be a reference object or null");
    exactKeys(value.credential, ["kind", "name"]);
    if (value.credential.kind !== "env" && value.credential.kind !== "keychain") throw new ContractError("credential.kind must be env or keychain");
    nonEmptyString(value.credential.name, "credential.name", 256);
    if (secretLike.test(value.credential.name)) throw new ContractError("credential.name must be a reference, not a secret literal");
    if (value.credential.kind === "env" && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(value.credential.name)) throw new ContractError("env credential name must be an environment variable name");
  }
  if (!isRecord(value.options)) throw new ContractError("options must be an object");
  for (const [key, option] of Object.entries(value.options)) {
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(key)) throw new ContractError(`Invalid runtime option name: ${key}`);
    if (!["string", "number", "boolean"].includes(typeof option) || (typeof option === "number" && !Number.isFinite(option))) throw new ContractError(`Runtime option ${key} must be a finite scalar`);
    if (typeof option === "string" && secretLike.test(option)) throw new ContractError(`Runtime option ${key} appears to contain a secret literal`);
  }
  return value as unknown as RuntimeConfig;
}

export function parseRuntimeEvent(value: unknown): RuntimeEvent {
  if (!isRecord(value)) throw new ContractError("Event must be an object");
  exactKeys(value, ["schemaVersion", "jobId", "sequence", "timestamp", "type", "payload"]);
  if (value.schemaVersion !== 1) throw new ContractError("Unsupported event schemaVersion");
  nonEmptyString(value.jobId, "event.jobId", 128);
  if (!Number.isInteger(value.sequence) || (value.sequence as number) < 1) throw new ContractError("event.sequence must be a positive integer");
  nonEmptyString(value.timestamp, "event.timestamp", 64);
  if (Number.isNaN(Date.parse(value.timestamp))) throw new ContractError("event.timestamp must be an ISO-compatible timestamp");
  if (value.type !== "started" && value.type !== "progress" && value.type !== "completed") throw new ContractError("Unsupported event type");
  if (!isRecord(value.payload)) throw new ContractError("event.payload must be an object");
  exactKeys(value.payload, ["message"]);
  nonEmptyString(value.payload.message, "event.payload.message", 1_024);
  return value as unknown as RuntimeEvent;
}

export function parseRuntimeResult(value: unknown): RuntimeResult {
  if (!isRecord(value)) throw new ContractError("Result must be an object");
  exactKeys(value, ["schemaVersion", "jobId", "execution", "acceptance", "summary", "changedFiles", "verification", "limitations"], ["snapshot", "usage", "escalation"]);
  if (value.schemaVersion !== 1) throw new ContractError("Unsupported result schemaVersion");
  nonEmptyString(value.jobId, "result.jobId", 128);
  if (value.execution !== "completed" && value.execution !== "failed") throw new ContractError("Invalid execution outcome");
  if (!["passed", "failed", "unverified"].includes(value.acceptance as string)) throw new ContractError("Invalid acceptance outcome");
  nonEmptyString(value.summary, "result.summary", 4_096);
  stringArray(value.changedFiles, "changedFiles");
  stringArray(value.limitations, "limitations");
  if (!Array.isArray(value.verification) || value.verification.length > 100) throw new ContractError("verification must contain at most 100 entries");
  for (const [index, item] of value.verification.entries()) {
    if (!isRecord(item)) throw new ContractError(`verification[${index}] must be an object`);
    exactKeys(item, ["command", "exitCode"]);
    nonEmptyString(item.command, `verification[${index}].command`, 4_096);
    if (item.exitCode !== null && (!Number.isInteger(item.exitCode) || (item.exitCode as number) < 0)) throw new ContractError(`verification[${index}].exitCode must be non-negative or null`);
  }
  if (value.snapshot !== undefined) {
    if (!isRecord(value.snapshot)) throw new ContractError("snapshot must be an object");
    exactKeys(value.snapshot, ["worktreePath", "baseSha", "snapshotSha", "diffSha256", "changedFiles", "checks", "acceptance", "limitations"], ["artifact"]);
    for (const key of ["worktreePath", "baseSha", "snapshotSha", "diffSha256"]) nonEmptyString(value.snapshot[key], `snapshot.${key}`, 4_096);
    stringArray(value.snapshot.changedFiles, "snapshot.changedFiles");
    stringArray(value.snapshot.limitations, "snapshot.limitations");
    if (value.snapshot.artifact !== undefined) {
      if (!isRecord(value.snapshot.artifact)) throw new ContractError("snapshot.artifact must be an object");
      exactKeys(value.snapshot.artifact, ["path", "sha256", "diffPath", "diffFileSha256"]);
      for (const key of ["path", "sha256", "diffPath", "diffFileSha256"]) nonEmptyString(value.snapshot.artifact[key], `snapshot.artifact.${key}`, 4096);
    }
    if (!["passed", "failed", "unverified"].includes(value.snapshot.acceptance as string)) throw new ContractError("Invalid snapshot acceptance");
    if (!Array.isArray(value.snapshot.checks) || value.snapshot.checks.length > 100) throw new ContractError("snapshot.checks must contain at most 100 entries");
    for (const [index, check] of value.snapshot.checks.entries()) {
      if (!isRecord(check)) throw new ContractError(`snapshot.checks[${index}] must be an object`);
      exactKeys(check, ["argv", "cwd", "exitCode", "stdout", "stderr", "truncated", "timedOut"]);
      stringArray(check.argv, `snapshot.checks[${index}].argv`, 32);
      nonEmptyString(check.cwd, `snapshot.checks[${index}].cwd`, 4_096);
      if (check.exitCode !== null && (!Number.isInteger(check.exitCode) || (check.exitCode as number) < 0)) throw new ContractError(`snapshot.checks[${index}].exitCode is invalid`);
      for (const key of ["stdout", "stderr"]) if (typeof check[key] !== "string" || check[key].length > 16_384) throw new ContractError(`snapshot.checks[${index}].${key} is too large`);
      if (typeof check.truncated !== "boolean" || typeof check.timedOut !== "boolean") throw new ContractError(`snapshot.checks[${index}] flags are invalid`);
    }
    if (value.snapshot.acceptance === "passed" && (value.snapshot.checks.length === 0 ||
        value.snapshot.checks.some(check => !isRecord(check) || check.exitCode !== 0 || check.timedOut === true))) {
      throw new ContractError("Passed acceptance requires successful independent checks");
    }
    if (value.acceptance !== value.snapshot.acceptance || JSON.stringify(value.changedFiles) !== JSON.stringify(value.snapshot.changedFiles)) {
      throw new ContractError("Result and snapshot acceptance or changed files differ");
    }
  }
  if (value.usage !== undefined) {
    if (!isRecord(value.usage)) throw new ContractError("usage must be an object");
    exactKeys(value.usage, ["runtime", "sessionId", "costUsd", "inputTokens", "outputTokens"]);
    if (value.usage.runtime !== "opencode" && value.usage.runtime !== "codex" && value.usage.runtime !== "claude") throw new ContractError("usage.runtime is unsupported");
    nonEmptyString(value.usage.sessionId, "usage.sessionId", 128);
    for (const key of ["costUsd", "inputTokens", "outputTokens"] as const) {
      const measure = value.usage[key];
      if (measure !== null && (typeof measure !== "number" || !Number.isFinite(measure) || measure < 0 ||
          (key !== "costUsd" && !Number.isSafeInteger(measure)))) throw new ContractError(`usage.${key} is invalid`);
    }
  }
  if (value.escalation !== undefined) {
    if (!isRecord(value.escalation)) throw new ContractError("escalation must be an object");
    exactKeys(value.escalation, ["code", "reason"]);
    if (value.escalation.code !== "RETRY_EXHAUSTED") throw new ContractError("escalation.code is unsupported");
    nonEmptyString(value.escalation.reason, "escalation.reason", 512);
  }
  return value as unknown as RuntimeResult;
}
