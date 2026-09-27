#!/usr/bin/env node
/** CLI client for the local gattinid Unix socket protocol. */
import { randomUUID } from "node:crypto";
import { connect, type Socket } from "node:net";
import { homedir } from "node:os";
import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { RELEASE_VERSION } from "../core/release.js";

const PROTOCOL_VERSION = 2;
const MAX_MESSAGE_BYTES = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 10_000;

type Command = "start" | "run" | "followup" | "review" | "status" | "result" | "cancel" | "cleanup.preview" | "approvals.list" | "approve" | "deny" | "events.list";
type JsonObject = Record<string, unknown>;
interface Response {
  protocolVersion: number;
  requestId: string;
  ok: boolean;
  result?: unknown;
  error?: { code: string; message: string };
}

class CliError extends Error {
  constructor(message: string, readonly exitCode = 2, readonly code = "INVALID_INPUT") {
    super(message);
  }
}

function usage(): string {
  return [
    "Usage:",
    "  gattini start --task-file PATH --idempotency-key KEY [--role ROLE] [--require-approval] [--json]",
    "  gattini run --task-file PATH --idempotency-key KEY [start options] [--poll-ms 100..5000] [--cancel-on-interrupt] [--json]",
    "  gattini start --task-file PATH --idempotency-key KEY --role code --repo PATH --base-sha SHA --checks-file PATH --trusted-local-code --require-approval [--json]",
    "  gattini status JOB_ID [--json]",
    "  gattini events JOB_ID [--after-sequence N] [--limit 1..100] [--json]",
    "  gattini followup JOB_ID --task-file PATH --idempotency-key KEY [--json]",
    "  gattini review JOB_ID --idempotency-key KEY [--json]",
    "  gattini result JOB_ID [--attempt-id ID] [--json]",
    "  gattini cancel JOB_ID [--json]",
    "  gattini cleanup preview [JOB_ID] [--json]",
    "  gattini approvals list [--json]",
    "  gattini approve APPROVAL_ID [--json]",
    "  gattini deny APPROVAL_ID [--json]",
  ].join("\n");
}

function nonEmpty(value: string | undefined, label: string, max = 256): string {
  if (value === undefined || value.trim().length === 0 || value.length > max || value.includes("\0")) {
    throw new CliError(`${label} must be non-empty and at most ${max} characters`);
  }
  return value;
}

function parseArgs(argv: string[]): { command: Command; params: JsonObject; json: boolean; pollMs: number; cancelOnInterrupt: boolean } {
  const command = argv[0] === "approvals" && argv[1] === "list" ? "approvals.list"
    : argv[0] === "cleanup" && argv[1] === "preview" ? "cleanup.preview" : argv[0] === "events" ? "events.list" : argv[0];
  if (command !== "start" && command !== "run" && command !== "followup" && command !== "review" && command !== "status" && command !== "result" && command !== "cancel" && command !== "cleanup.preview" && command !== "approvals.list" && command !== "approve" && command !== "deny" && command !== "events.list") {
    throw new CliError(`Unknown command.\n${usage()}`);
  }
  const args = argv.slice(command === "approvals.list" || command === "cleanup.preview" ? 2 : 1);
  let json = false;
  if (args.includes("--json")) {
    json = true;
    args.splice(args.indexOf("--json"), 1);
  }
  if (command === "start" || command === "run") {
    const cancelOnInterrupt = args.includes("--cancel-on-interrupt");
    if (cancelOnInterrupt) args.splice(args.indexOf("--cancel-on-interrupt"), 1);
    if (cancelOnInterrupt && command !== "run") throw new CliError("--cancel-on-interrupt requires run");
    const requireApproval = args.includes("--require-approval");
    if (requireApproval) args.splice(args.indexOf("--require-approval"), 1);
    const trustedLocal = args.includes("--trusted-local-code");
    if (trustedLocal) args.splice(args.indexOf("--trusted-local-code"), 1);
    const values = new Map<string, string>();
    for (let i = 0; i < args.length; i += 1) {
      const flag = args[i];
      if (flag !== "--task-file" && flag !== "--idempotency-key" && flag !== "--role" && flag !== "--repo" && flag !== "--base-sha" && flag !== "--checks-file" && flag !== "--poll-ms") {
        throw new CliError(`Unexpected argument: ${flag ?? ""}\n${usage()}`);
      }
      if (values.has(flag)) throw new CliError(`Duplicate option: ${flag}`);
      const value = args[++i];
      if (value === undefined || value.startsWith("--")) throw new CliError(`Missing value for ${flag}`);
      values.set(flag, value);
    }
    if (!values.has("--task-file") || !values.has("--idempotency-key")) {
      throw new CliError(`${command} requires --task-file and --idempotency-key\n${usage()}`);
    }
    if (command !== "run" && values.has("--poll-ms")) throw new CliError("--poll-ms requires run");
    const pollText = values.get("--poll-ms") ?? "500";
    if (!/^[0-9]+$/.test(pollText) || Number(pollText) < 100 || Number(pollText) > 5000) throw new CliError("--poll-ms must be an integer from 100 to 5000");
    const pollMs = Number(pollText);
    const taskFile = nonEmpty(values.get("--task-file"), "Task file path", 4096);
    const idempotencyKey = nonEmpty(values.get("--idempotency-key"), "Idempotency key", 128);
    const role = nonEmpty(values.get("--role") ?? "code", "Role", 128);
    if (trustedLocal && (role !== "code" || !requireApproval || !values.has("--repo") || !values.has("--base-sha") || !values.has("--checks-file"))) {
      throw new CliError("Trusted local code requires --role code, --repo, --base-sha, --checks-file, and --require-approval");
    }
    if (!trustedLocal && ["--repo", "--base-sha", "--checks-file"].some(flag => values.has(flag))) {
      throw new CliError("Repository and checks options require --trusted-local-code");
    }
    return { command, params: { taskFile, idempotencyKey, role, ...(requireApproval ? { requireApproval: true } : {}),
      ...(trustedLocal ? { trustedLocal: true, repositoryPath: nonEmpty(values.get("--repo"), "Repository path", 4096),
        baseSha: nonEmpty(values.get("--base-sha"), "Base SHA", 128), checksFile: nonEmpty(values.get("--checks-file"), "Checks file", 4096) } : {}) }, json, pollMs, cancelOnInterrupt };
  }
  if (command === "approvals.list") {
    if (args.length) throw new CliError(`approvals list takes no arguments\n${usage()}`);
    return { command, params: {}, json, pollMs: 500, cancelOnInterrupt: false };
  }
  if (command === "cleanup.preview") {
    if (args.length > 1) throw new CliError(`cleanup preview accepts at most one job ID\n${usage()}`);
    return { command, params: args.length ? { jobId: nonEmpty(args[0], "Job ID", 128) } : {},
      json, pollMs: 500, cancelOnInterrupt: false };
  }
  if (command === "events.list") {
    const jobId = nonEmpty(args.shift(), "Job ID", 128);
    const values = new Map<string, string>();
    for (let i = 0; i < args.length; i += 1) {
      const flag = args[i];
      if ((flag !== "--after-sequence" && flag !== "--limit") || values.has(flag)) throw new CliError(`Unexpected or duplicate argument: ${flag ?? ""}`);
      const value = args[++i];
      if (value === undefined) throw new CliError(`Missing value for ${flag}`);
      values.set(flag, value);
    }
    const cursor = values.get("--after-sequence") ?? "0";
    const limit = values.get("--limit") ?? "100";
    if (!/^(0|[1-9][0-9]*)$/.test(cursor) || !Number.isSafeInteger(Number(cursor))) throw new CliError("--after-sequence must be a nonnegative safe integer");
    if (!/^[1-9][0-9]*$/.test(limit) || Number(limit) > 100) throw new CliError("--limit must be 1..100");
    return { command, params: { jobId, afterSequence: Number(cursor), limit: Number(limit) }, json, pollMs: 500, cancelOnInterrupt: false };
  }
  if (command === "followup" || command === "review" || command === "result") {
    const jobId = nonEmpty(args.shift(), "Job ID", 128);
    const allowed = command === "followup" ? ["--task-file", "--idempotency-key"] : command === "review" ? ["--idempotency-key"] : ["--attempt-id"];
    const values = new Map<string, string>();
    for (let i = 0; i < args.length; i += 1) {
      const flag = args[i];
      if (!flag || !allowed.includes(flag) || values.has(flag)) throw new CliError(`Unexpected or duplicate argument: ${flag ?? ""}`);
      const value = args[++i];
      if (value === undefined || value.startsWith("--")) throw new CliError(`Missing value for ${flag}`);
      values.set(flag, value);
    }
    if (command === "followup" && (!values.has("--task-file") || !values.has("--idempotency-key"))) throw new CliError("followup requires --task-file and --idempotency-key");
    if (command === "review" && !values.has("--idempotency-key")) throw new CliError("review requires --idempotency-key");
    return { command, params: { jobId,
      ...(values.has("--task-file") ? { taskFile: nonEmpty(values.get("--task-file"), "Task file", 4096) } : {}),
      ...(values.has("--idempotency-key") ? { idempotencyKey: nonEmpty(values.get("--idempotency-key"), "Idempotency key", 128) } : {}),
      ...(values.has("--attempt-id") ? { attemptId: nonEmpty(values.get("--attempt-id"), "Attempt ID", 128) } : {}) },
      json, pollMs: 500, cancelOnInterrupt: false };
  }
  if (args.length !== 1) throw new CliError(`${command} requires exactly one ID\n${usage()}`);
  if (command === "approve" || command === "deny") return { command, params: { approvalId: nonEmpty(args[0], "Approval ID", 128) }, json, pollMs: 500, cancelOnInterrupt: false };
  return { command, params: { jobId: nonEmpty(args[0], "Job ID", 128) }, json, pollMs: 500, cancelOnInterrupt: false };
}

function socketPath(): string {
  const override = process.env.GATTINI_STATE_DIR;
  if (override !== undefined) {
    if (!isAbsolute(override) || override.includes("\0")) {
      throw new CliError("GATTINI_STATE_DIR must be an absolute path");
    }
    return join(override, "gattinid.sock");
  }
  return join(homedir(), "Library", "Application Support", "Gattini", "gattinid.sock");
}

function requestSocket(path: string, request: JsonObject): Promise<Response> {
  return new Promise((resolve, reject) => {
    let socket: Socket;
    try {
      socket = connect(path);
    } catch {
      reject(new CliError("Could not connect to gattinid", 3, "DAEMON_UNAVAILABLE"));
      return;
    }
    let buffer = Buffer.alloc(0);
    let settled = false;
    const fail = (error: CliError): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      reject(error);
    };
    const timer = setTimeout(() => fail(new CliError("Timed out waiting for gattinid", 3, "DAEMON_UNAVAILABLE")), REQUEST_TIMEOUT_MS);
    socket.on("connect", () => {
      const wire = Buffer.from(`${JSON.stringify(request)}\n`, "utf8");
      if (wire.byteLength > MAX_MESSAGE_BYTES) {
        fail(new CliError("Request exceeds the 1 MiB protocol limit", 2, "REQUEST_TOO_LARGE"));
        return;
      }
      socket.write(wire);
    });
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.byteLength > MAX_MESSAGE_BYTES) {
        fail(new CliError("Daemon response exceeds the 1 MiB protocol limit", 3, "PROTOCOL_ERROR"));
        return;
      }
      if (buffer.includes(10)) {
        const lineEnd = buffer.indexOf(10);
        if (lineEnd !== buffer.byteLength - 1) {
          fail(new CliError("Daemon sent more than one protocol line", 3, "PROTOCOL_ERROR"));
          return;
        }
        let value: unknown;
        try {
          value = JSON.parse(buffer.subarray(0, lineEnd).toString("utf8")) as unknown;
        } catch {
          fail(new CliError("Daemon returned malformed JSON", 3, "PROTOCOL_ERROR"));
          return;
        }
        if (typeof value !== "object" || value === null || Array.isArray(value)) {
          fail(new CliError("Daemon returned an invalid protocol response", 3, "PROTOCOL_ERROR"));
          return;
        }
        const response = value as Response;
        if (response.protocolVersion !== PROTOCOL_VERSION) {
          fail(new CliError("Daemon protocol version is incompatible with this client", 3, "VERSION_MISMATCH"));
          return;
        }
        if (response.requestId !== request.requestId || typeof response.ok !== "boolean") {
          fail(new CliError("Daemon protocol version or request ID did not match", 3, "PROTOCOL_ERROR"));
          return;
        }
        if (!response.ok && (typeof response.error?.code !== "string" || typeof response.error.message !== "string")) {
          fail(new CliError("Daemon returned an invalid error response", 3, "PROTOCOL_ERROR"));
          return;
        }
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        resolve(response);
      }
    });
    socket.on("error", () => fail(new CliError("Could not communicate with gattinid", 3, "DAEMON_UNAVAILABLE")));
    socket.on("end", () => {
      if (!settled) fail(new CliError("Daemon closed the connection without a complete response", 3, "PROTOCOL_ERROR"));
    });
    socket.on("close", () => {
      if (!settled) fail(new CliError("Daemon closed the connection without a complete response", 3, "PROTOCOL_ERROR"));
    });
  });
}

function safeText(value: unknown): string {
  return (typeof value === "string" ? value : JSON.stringify(value))
    .replace(/[\u0000-\u001f\u007f]/g, " ");
}

async function callDaemon(path: string, method: string, params: JsonObject): Promise<unknown> {
  const response = await requestSocket(path, { protocolVersion: PROTOCOL_VERSION, clientVersion: RELEASE_VERSION, requestId: randomUUID(), method, params });
  if (!response.ok) {
    const code = response.error?.code ?? "PROTOCOL_ERROR";
    throw new CliError(response.error?.message ?? "Daemon request failed", code === "INVALID_REQUEST" ? 2 : code === "APPROVAL_REQUIRED" ? 4 : 3, code);
  }
  return response.result;
}

function record(value: unknown): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new CliError("Daemon returned an invalid result", 3, "PROTOCOL_ERROR");
  return value as JsonObject;
}

function resultExitCode(value: unknown): number {
  const envelope = record(value);
  const result = envelope.result && typeof envelope.result === "object" && !Array.isArray(envelope.result) ? envelope.result as JsonObject : null;
  return envelope.state === "failed" || envelope.state === "cancelled" || envelope.state === "interrupted" ||
    result?.execution === "failed" || result?.acceptance === "failed" ? 1 : 0;
}

async function runJob(path: string, startedValue: unknown, pollMs: number, cancelOnInterrupt: boolean): Promise<{ value: unknown; exitCode: number } | null> {
  const started = record(startedValue);
  const jobId = started.jobId;
  if (typeof jobId !== "string" || !jobId) throw new CliError("Daemon did not return a job ID", 3, "PROTOCOL_ERROR");
  let interrupted: NodeJS.Signals | null = null;
  let wake: (() => void) | undefined;
  let cancelPromise: Promise<unknown> | undefined;
  const onSignal = (signal: NodeJS.Signals): void => {
    if (interrupted) return;
    interrupted = signal;
    if (cancelOnInterrupt) cancelPromise = callDaemon(path, "cancel", { jobId }).catch(error => {
      process.stderr.write(`Could not cancel job ${safeText(jobId)}: ${safeText(error instanceof Error ? error.message : "unknown error")}\n`);
    });
    wake?.();
  };
  const onInt = (): void => onSignal("SIGINT");
  const onTerm = (): void => onSignal("SIGTERM");
  process.on("SIGINT", onInt);
  process.on("SIGTERM", onTerm);
  try {
    let state = started.state;
    while (!interrupted) {
      if (typeof state !== "string" || !["queued", "awaiting-approval", "running", "cancelling", "cancelled", "completed", "failed", "interrupted"].includes(state)) {
        throw new CliError(`Daemon returned an invalid state for job ${jobId}`, 3, "PROTOCOL_ERROR");
      }
      if (state === "awaiting-approval") return { value: { jobId, state, ...(typeof started.approvalId === "string" ? { approvalId: started.approvalId } : {}) }, exitCode: 4 };
      if (state === "completed" || state === "failed" || state === "cancelled" || state === "interrupted") {
        const value = await callDaemon(path, "result", { jobId });
        if (record(value).jobId !== jobId) throw new CliError(`Daemon returned a different result ID for job ${jobId}`, 3, "PROTOCOL_ERROR");
        return { value, exitCode: resultExitCode(value) };
      }
      await new Promise<void>(resolve => {
        const timer = setTimeout(() => { wake = undefined; resolve(); }, pollMs);
        wake = () => { clearTimeout(timer); wake = undefined; resolve(); };
      });
      if (interrupted) break;
      try {
        const status = record(await callDaemon(path, "status", { jobId }));
        if (status.jobId !== jobId) throw new CliError("Daemon returned a different status ID", 3, "PROTOCOL_ERROR");
        state = status.state;
      } catch (error) {
        throw new CliError(`Job ${jobId} remains durable; status request failed: ${error instanceof Error ? error.message : "unknown error"}`, 3, error instanceof CliError ? error.code : "DAEMON_UNAVAILABLE");
      }
    }
    if (cancelPromise) await cancelPromise;
    process.stderr.write(`Job ${safeText(jobId)} ${cancelOnInterrupt ? "cancellation requested" : "continues"}; inspect it with status/result.\n`);
    process.exitCode = interrupted === "SIGTERM" ? 143 : 130;
    return null;
  } finally {
    process.off("SIGINT", onInt);
    process.off("SIGTERM", onTerm);
  }
}

async function main(): Promise<void> {
  let json = process.argv.includes("--json");
  try {
    const parsed = parseArgs(process.argv.slice(2));
    json = parsed.json;
    if (parsed.command === "start" || parsed.command === "run" || parsed.command === "followup") {
      const path = parsed.params.taskFile as string;
      let task: string;
      try {
        const bytes = await readFile(path);
        if (bytes.byteLength > MAX_MESSAGE_BYTES) throw new CliError("Task file exceeds the 1 MiB protocol limit");
        task = bytes.toString("utf8");
      } catch (error) {
        if (error instanceof CliError) throw error;
        throw new CliError("Could not read task file");
      }
      if (task.trim().length === 0) throw new CliError("Task file must not be empty");
      if (task.length > 16_384) throw new CliError("Task file exceeds the 16,384 character task limit");
      const { taskFile: _taskFile, ...params } = parsed.params;
      if (typeof params.checksFile === "string") {
        try {
          const bytes = await readFile(params.checksFile);
          if (bytes.byteLength > 16_384) throw new CliError("Checks file exceeds 16 KiB");
          params.verificationCommands = JSON.parse(bytes.toString("utf8")) as unknown;
        } catch (error) {
          if (error instanceof CliError) throw error;
          throw new CliError("Could not read a JSON checks file");
        }
        delete params.checksFile;
      }
      Object.assign(params, { task });
      parsed.params = params;
    }
    const path = socketPath();
    let hello: JsonObject;
    try {
      hello = record(await callDaemon(path, "hello", {}));
    } catch (error) {
      if (error instanceof CliError && (error.code === "INVALID_REQUEST" || error.code === "PROTOCOL_MISMATCH")) {
        throw new CliError("Daemon does not support this release handshake; stop it and start the matching gattinid", 3, "VERSION_MISMATCH");
      }
      throw error;
    }
    if (hello.version !== RELEASE_VERSION || hello.protocolVersion !== PROTOCOL_VERSION) {
      throw new CliError(`Client ${RELEASE_VERSION} is incompatible with daemon ${safeText(hello.version)}`, 3, "VERSION_MISMATCH");
    }
    let value = await callDaemon(path, parsed.command === "run" ? "start" : parsed.command, parsed.params);
    if (parsed.command === "run") {
      const outcome = await runJob(path, value, parsed.pollMs, parsed.cancelOnInterrupt);
      if (!outcome) return;
      value = outcome.value;
      process.exitCode = outcome.exitCode;
    }
    if (json) process.stdout.write(`${JSON.stringify(value)}\n`);
    else if (parsed.command === "cancel" && typeof value === "object" && value !== null) {
      const result = value as JsonObject;
      const state = typeof result.state === "string" ? result.state : "unknown";
      process.stdout.write(`Job ${safeText(parsed.params.jobId)}: ${safeText(state)}\n`);
    } else process.stdout.write(`${safeText(value)}\n`);
    if (parsed.command === "result") process.exitCode = resultExitCode(value);
  } catch (error) {
    const failure = error instanceof CliError ? error : new CliError("Unexpected CLI error", 3, "INTERNAL_ERROR");
    if (json) process.stderr.write(`${JSON.stringify({ error: { code: failure.code, message: failure.message } })}\n`);
    else process.stderr.write(`${failure.message}\n`);
    process.exitCode = failure.exitCode;
  }
}

void main();
