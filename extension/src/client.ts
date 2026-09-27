import { randomUUID } from "node:crypto";
import { connect, type Socket } from "node:net";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

export const PROTOCOL_VERSION = 2;
export const RELEASE_VERSION = "0.2.0";
export const MAX_MESSAGE_BYTES = 1024 * 1024;
const TIMEOUT_MS = 10_000;

type ObjectValue = Record<string, unknown>;
export type PublicEvent = { jobId: string; sequence: number; at: string | null; type: string; detail: ObjectValue };
export type EventPage = { jobId: string; events: PublicEvent[]; nextSequence: number; hasMore: boolean };
export type JobStatus = { jobId: string; state: string; createdAt: string; updatedAt: string };
export type JobResult = { jobId: string; state: string; attemptId?: string; result: null | {
  execution: string; acceptance: string; summary: string; changedFiles: string[];
  verification: Array<{ command: string; exitCode: number | null }>; limitations: string[];
} };
export type Evidence = { jobId: string; attemptId?: string; kind: "diff" | "snapshot"; sha256: string; text: string; truncated: boolean };
export type Approval = { id: string; jobId: string; actionKind: string; createdAt: string; expiresAt: string };

export class ClientError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

function object(value: unknown): value is ObjectValue { return typeof value === "object" && value !== null && !Array.isArray(value); }
function boundedText(value: unknown): string { return typeof value === "string" ? value.slice(0, 512).replace(/[\u0000-\u001f\u007f]/g, " ") : "Invalid daemon message"; }
function validId(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 128 && !/[\u0000-\u001f\u007f]/.test(value); }

export function socketPath(env: NodeJS.ProcessEnv = process.env): string {
  const directory = env.GATTINI_STATE_DIR ?? join(homedir(), "Library", "Application Support", "Gattini");
  if (!isAbsolute(directory) || directory.includes("\0")) throw new ClientError("INVALID_STATE_DIR", "GATTINI_STATE_DIR must be an absolute path");
  return join(directory, "gattinid.sock");
}

export async function requestSocket(path: string, method: string, params: ObjectValue): Promise<unknown> {
  const requestId = randomUUID();
  const request = { protocolVersion: PROTOCOL_VERSION, clientVersion: RELEASE_VERSION, requestId, method, params };
  const wire = Buffer.from(JSON.stringify(request) + "\n");
  if (wire.byteLength > MAX_MESSAGE_BYTES) throw new ClientError("REQUEST_TOO_LARGE", "Request exceeds 1 MiB");
  return new Promise((resolve, reject) => {
    const socket: Socket = connect(path);
    let buffer = Buffer.alloc(0);
    let settled = false;
    const finish = (error?: ClientError, result?: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error); else resolve(result);
    };
    const timer = setTimeout(() => finish(new ClientError("DAEMON_UNAVAILABLE", "Timed out waiting for Gattini daemon")), TIMEOUT_MS);
    socket.on("connect", () => socket.write(wire));
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.byteLength > MAX_MESSAGE_BYTES) return finish(new ClientError("PROTOCOL_ERROR", "Daemon response exceeds 1 MiB"));
      const lineEnd = buffer.indexOf(10);
      if (lineEnd < 0) return;
      if (lineEnd !== buffer.length - 1) return finish(new ClientError("PROTOCOL_ERROR", "Daemon sent multiple protocol lines"));
      let value: unknown;
      try { value = JSON.parse(buffer.subarray(0, lineEnd).toString("utf8")) as unknown; }
      catch { return finish(new ClientError("PROTOCOL_ERROR", "Daemon sent invalid JSON")); }
      if (!object(value) || value.requestId !== requestId || typeof value.ok !== "boolean") {
        return finish(new ClientError("PROTOCOL_ERROR", "Daemon response did not match the request"));
      }
      if (value.protocolVersion !== PROTOCOL_VERSION) return finish(new ClientError("VERSION_MISMATCH", "Gattini daemon protocol is incompatible with this extension"));
      if (!value.ok) {
        if (!object(value.error) || typeof value.error.code !== "string") return finish(new ClientError("PROTOCOL_ERROR", "Daemon sent an invalid error"));
        const code = value.error.code;
        return finish(new ClientError(code === "PROTOCOL_MISMATCH" ? "VERSION_MISMATCH" : code, boundedText(value.error.message)));
      }
      finish(undefined, value.result);
    });
    socket.on("error", () => finish(new ClientError("DAEMON_UNAVAILABLE", "Gattini daemon is unavailable")));
    socket.on("end", () => finish(new ClientError("DAEMON_UNAVAILABLE", "Gattini daemon disconnected")));
    socket.on("close", () => finish(new ClientError("DAEMON_UNAVAILABLE", "Gattini daemon disconnected")));
  });
}

export class GattiniClient {
  constructor(readonly path = socketPath(), private readonly request = requestSocket) {}

  async hello(): Promise<void> {
    let value: unknown;
    try { value = await this.request(this.path, "hello", {}); }
    catch (error) {
      if (error instanceof ClientError && (error.code === "INVALID_REQUEST" || error.code === "PROTOCOL_MISMATCH")) {
        throw new ClientError("VERSION_MISMATCH", "Gattini daemon does not support protocol v2");
      }
      throw error;
    }
    if (!object(value) || value.version !== RELEASE_VERSION || value.protocolVersion !== PROTOCOL_VERSION) {
      throw new ClientError("VERSION_MISMATCH", "Gattini daemon release or protocol does not match 0.2.0 / v2");
    }
  }

  private async call(method: string, params: ObjectValue): Promise<unknown> { await this.hello(); return this.request(this.path, method, params); }

  async start(task: string, idempotencyKey: string): Promise<{ jobId: string; state: string; deduplicated: boolean }> {
    if (!task.trim() || task.length > 16_384) throw new ClientError("INVALID_TASK", "Task must be 1 to 16,384 characters");
    if (!validId(idempotencyKey)) throw new ClientError("INVALID_IDEMPOTENCY_KEY", "Invalid idempotency key");
    const value = await this.call("start", { task, role: "code", idempotencyKey });
    if (!object(value) || !validId(value.jobId) || typeof value.state !== "string" || typeof value.deduplicated !== "boolean") {
      throw new ClientError("PROTOCOL_ERROR", "Daemon sent an invalid start response");
    }
    return { jobId: value.jobId, state: value.state, deduplicated: value.deduplicated };
  }

  async status(jobId: string): Promise<JobStatus> {
    if (!validId(jobId)) throw new ClientError("INVALID_JOB_ID", "Invalid job ID");
    const value = await this.call("status", { jobId });
    if (!object(value) || value.jobId !== jobId || typeof value.state !== "string" || typeof value.createdAt !== "string" || typeof value.updatedAt !== "string") {
      throw new ClientError("PROTOCOL_ERROR", "Daemon sent an invalid job status");
    }
    return { jobId, state: value.state, createdAt: value.createdAt, updatedAt: value.updatedAt };
  }

  async events(jobId: string, afterSequence: number, limit = 100): Promise<EventPage> {
    if (!validId(jobId)) throw new ClientError("INVALID_JOB_ID", "Invalid job ID");
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new ClientError("INVALID_CURSOR", "Invalid event cursor or page limit");
    }
    const value = await this.call("events.list", { jobId, afterSequence, limit });
    if (!object(value) || value.jobId !== jobId || !Array.isArray(value.events) || typeof value.hasMore !== "boolean" || !Number.isSafeInteger(value.nextSequence)) {
      throw new ClientError("PROTOCOL_ERROR", "Daemon sent an invalid event page");
    }
    const events: PublicEvent[] = [];
    let cursor = afterSequence;
    for (const event of value.events) {
      if (!object(event) || event.jobId !== jobId || !Number.isSafeInteger(event.sequence) || typeof event.type !== "string" ||
          (event.at !== null && typeof event.at !== "string") || !object(event.detail)) {
        throw new ClientError("PROTOCOL_ERROR", "Daemon sent an invalid event");
      }
      if ((event.sequence as number) <= cursor) continue; // replay of an already committed event
      if (event.sequence !== cursor + 1) throw new ClientError("EVENT_GAP", `Expected event ${cursor + 1}`);
      cursor = event.sequence as number;
      events.push(event as PublicEvent);
    }
    if (value.nextSequence !== cursor || (events.length === 0 && value.hasMore)) {
      throw new ClientError("PROTOCOL_ERROR", "Daemon event cursor did not match the page");
    }
    return { jobId, events, nextSequence: cursor, hasMore: value.hasMore };
  }

  async result(jobId: string): Promise<JobResult> {
    if (!validId(jobId)) throw new ClientError("INVALID_JOB_ID", "Invalid job ID");
    const value = await this.call("result", { jobId });
    if (!object(value) || value.jobId !== jobId || typeof value.state !== "string" ||
        (value.attemptId !== undefined && !validId(value.attemptId))) throw new ClientError("PROTOCOL_ERROR", "Invalid result response");
    if (value.result === null) return { jobId, state: value.state, ...(value.attemptId ? { attemptId: value.attemptId } : {}), result: null };
    const result = value.result;
    if (!object(result) || result.jobId !== jobId || typeof result.execution !== "string" || typeof result.acceptance !== "string" ||
        typeof result.summary !== "string" || result.summary.length > 8192 || !Array.isArray(result.changedFiles) ||
        result.changedFiles.length > 100 || result.changedFiles.some(item => typeof item !== "string" || item.length > 4096) ||
        !Array.isArray(result.limitations) || result.limitations.length > 100 || result.limitations.some(item => typeof item !== "string" || item.length > 4096) ||
        !Array.isArray(result.verification) || result.verification.length > 100 || result.verification.some(item =>
          !object(item) || typeof item.command !== "string" || item.command.length > 4096 ||
          (item.exitCode !== null && !Number.isSafeInteger(item.exitCode)))) {
      throw new ClientError("PROTOCOL_ERROR", "Invalid result projection");
    }
    return { jobId, state: value.state, ...(value.attemptId ? { attemptId: value.attemptId } : {}),
      result: { execution: result.execution, acceptance: result.acceptance, summary: result.summary,
        changedFiles: result.changedFiles as string[], verification: result.verification as Array<{ command: string; exitCode: number | null }>,
        limitations: result.limitations as string[] } };
  }

  async evidence(jobId: string, attemptId: string | undefined, kind: "diff" | "snapshot"): Promise<Evidence> {
    if (!validId(jobId) || (attemptId !== undefined && !validId(attemptId))) throw new ClientError("INVALID_JOB_ID", "Invalid job or attempt ID");
    const value = await this.call("evidence.read", { jobId, ...(attemptId ? { attemptId } : {}), kind });
    if (!object(value) || value.jobId !== jobId || (value.attemptId !== undefined && !validId(value.attemptId)) ||
        (attemptId && value.attemptId !== attemptId) || value.kind !== kind ||
        typeof value.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.sha256) ||
        typeof value.text !== "string" || Buffer.byteLength(value.text, "utf8") > 64 * 1024 || typeof value.truncated !== "boolean") {
      throw new ClientError("PROTOCOL_ERROR", "Invalid evidence response");
    }
    return value as Evidence;
  }

  async approvals(): Promise<Approval[]> {
    const value = await this.call("approvals.list", {});
    if (!Array.isArray(value) || value.length > 20) throw new ClientError("PROTOCOL_ERROR", "Invalid approval list");
    return value.map(item => {
      if (!object(item) || !validId(item.id) || !validId(item.jobId) || item.state !== "pending" ||
          typeof item.createdAt !== "string" || typeof item.expiresAt !== "string" || !object(item.action) ||
          typeof item.action.kind !== "string" || item.action.kind.length > 128) {
        throw new ClientError("PROTOCOL_ERROR", "Invalid approval entry");
      }
      return { id: item.id, jobId: item.jobId, actionKind: item.action.kind, createdAt: item.createdAt, expiresAt: item.expiresAt };
    });
  }

  async decide(approvalId: string, decision: "approve" | "deny"): Promise<{ approvalId: string; jobId: string; state: string }> {
    if (!validId(approvalId)) throw new ClientError("INVALID_APPROVAL_ID", "Invalid approval ID");
    const value = await this.call(decision, { approvalId });
    if (!object(value) || value.approvalId !== approvalId || !validId(value.jobId) || typeof value.state !== "string") {
      throw new ClientError("PROTOCOL_ERROR", "Invalid approval decision response");
    }
    return { approvalId, jobId: value.jobId, state: value.state };
  }

  async cancel(jobId: string): Promise<{ jobId: string; state: string }> {
    if (!validId(jobId)) throw new ClientError("INVALID_JOB_ID", "Invalid job ID");
    const value = await this.call("cancel", { jobId });
    if (!object(value) || value.jobId !== jobId || typeof value.state !== "string") {
      throw new ClientError("PROTOCOL_ERROR", "Invalid cancellation response");
    }
    return { jobId, state: value.state };
  }
}
