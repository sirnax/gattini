#!/usr/bin/env node
/** CLI client for the local gattinid Unix socket protocol. */
import { randomUUID } from "node:crypto";
import { connect, type Socket } from "node:net";
import { homedir } from "node:os";
import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

const PROTOCOL_VERSION = 1;
const MAX_MESSAGE_BYTES = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 10_000;

type Command = "start" | "status" | "result" | "cancel";
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
    "  gattini start --task-file PATH --idempotency-key KEY [--role ROLE] [--json]",
    "  gattini status JOB_ID [--json]",
    "  gattini result JOB_ID [--json]",
    "  gattini cancel JOB_ID [--json]",
  ].join("\n");
}

function nonEmpty(value: string | undefined, label: string, max = 256): string {
  if (value === undefined || value.trim().length === 0 || value.length > max || value.includes("\0")) {
    throw new CliError(`${label} must be non-empty and at most ${max} characters`);
  }
  return value;
}

function parseArgs(argv: string[]): { command: Command; params: JsonObject; json: boolean } {
  const command = argv[0];
  if (command !== "start" && command !== "status" && command !== "result" && command !== "cancel") {
    throw new CliError(`Unknown command.\n${usage()}`);
  }
  const args = argv.slice(1);
  let json = false;
  if (args.includes("--json")) {
    json = true;
    args.splice(args.indexOf("--json"), 1);
  }
  if (command === "start") {
    const values = new Map<string, string>();
    for (let i = 0; i < args.length; i += 1) {
      const flag = args[i];
      if (flag !== "--task-file" && flag !== "--idempotency-key" && flag !== "--role") {
        throw new CliError(`Unexpected argument: ${flag ?? ""}\n${usage()}`);
      }
      if (values.has(flag)) throw new CliError(`Duplicate option: ${flag}`);
      const value = args[++i];
      if (value === undefined || value.startsWith("--")) throw new CliError(`Missing value for ${flag}`);
      values.set(flag, value);
    }
    if (!values.has("--task-file") || !values.has("--idempotency-key")) {
      throw new CliError(`start requires --task-file and --idempotency-key\n${usage()}`);
    }
    const taskFile = nonEmpty(values.get("--task-file"), "Task file path", 4096);
    const idempotencyKey = nonEmpty(values.get("--idempotency-key"), "Idempotency key", 128);
    const role = nonEmpty(values.get("--role") ?? "code", "Role", 128);
    return { command, params: { taskFile, idempotencyKey, role }, json };
  }
  if (args.length !== 1) throw new CliError(`${command} requires exactly one JOB_ID\n${usage()}`);
  return { command, params: { jobId: nonEmpty(args[0], "Job ID", 128) }, json };
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
        if (response.protocolVersion !== PROTOCOL_VERSION || response.requestId !== request.requestId || typeof response.ok !== "boolean") {
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

async function main(): Promise<void> {
  let json = process.argv.includes("--json");
  try {
    const parsed = parseArgs(process.argv.slice(2));
    json = parsed.json;
    if (parsed.command === "start") {
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
      Object.assign(params, { task });
      parsed.params = params;
    }
    const requestId = randomUUID();
    const response = await requestSocket(socketPath(), {
      protocolVersion: PROTOCOL_VERSION,
      requestId,
      method: parsed.command,
      params: parsed.params,
    });
    if (!response.ok) {
      const message = response.error?.message ?? "Daemon request failed";
      if (json) process.stdout.write(`${JSON.stringify({ error: response.error })}\n`);
      else process.stderr.write(`${safeText(message)}\n`);
      process.exitCode = response.error?.code === "TASK_FAILED" ? 1 : response.error?.code === "APPROVAL_REQUIRED" ? 4 : 3;
      return;
    }
    if (json) process.stdout.write(`${JSON.stringify(response.result)}\n`);
    else if (parsed.command === "cancel" && typeof response.result === "object" && response.result !== null) {
      const result = response.result as JsonObject;
      const state = typeof result.state === "string" ? result.state : "unknown";
      process.stdout.write(`Job ${safeText(parsed.params.jobId)}: ${safeText(state)}\n`);
    } else process.stdout.write(`${safeText(response.result)}\n`);
    if (parsed.command === "result" && typeof response.result === "object" && response.result !== null) {
      const envelope = response.result as JsonObject;
      const result = typeof envelope.result === "object" && envelope.result !== null
        ? envelope.result as JsonObject
        : envelope;
      if (envelope.state === "failed" || result.execution === "failed" || result.acceptance === "failed") process.exitCode = 1;
    }
  } catch (error) {
    const failure = error instanceof CliError ? error : new CliError("Unexpected CLI error", 3, "INTERNAL_ERROR");
    if (json) process.stderr.write(`${JSON.stringify({ error: { code: failure.code, message: failure.message } })}\n`);
    else process.stderr.write(`${failure.message}\n`);
    process.exitCode = failure.exitCode;
  }
}

void main();
