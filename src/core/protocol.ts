export const PROTOCOL_VERSION = 1;
export const MAX_MESSAGE_BYTES = 1024 * 1024;

export type Method = "start" | "followup" | "review" | "status" | "result" | "cancel" | "cleanup.preview" | "approvals.list" | "approve" | "deny";

export interface Request {
  protocolVersion: 1;
  requestId: string;
  method: Method;
  params: Record<string, unknown>;
}

export type Response =
  | { protocolVersion: 1; requestId: string; ok: true; result: unknown }
  | { protocolVersion: 1; requestId: string; ok: false; error: { code: string; message: string } };

export class ProtocolError extends Error {
  constructor(public readonly code: string, message: string, public readonly requestId = "") {
    super(message);
    this.name = "ProtocolError";
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseRequest(value: unknown): Request {
  if (!isRecord(value)) throw new ProtocolError("INVALID_REQUEST", "Request must be an object");
  const requestId = typeof value.requestId === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value.requestId) ? value.requestId : "";
  if (value.protocolVersion !== PROTOCOL_VERSION) throw new ProtocolError("PROTOCOL_MISMATCH", "Unsupported protocol version; expected 1", requestId);
  if (!requestId) throw new ProtocolError("INVALID_REQUEST", "Invalid request ID");
  if (Object.keys(value).some(key => !["protocolVersion", "requestId", "method", "params"].includes(key))) throw new ProtocolError("INVALID_REQUEST", "Unknown request field", requestId);
  if (value.method !== "start" && value.method !== "followup" && value.method !== "review" && value.method !== "status" && value.method !== "result" && value.method !== "cancel" && value.method !== "cleanup.preview" && value.method !== "approvals.list" && value.method !== "approve" && value.method !== "deny") throw new ProtocolError("INVALID_REQUEST", "Unsupported method", requestId);
  if (!isRecord(value.params)) throw new ProtocolError("INVALID_REQUEST", "Params must be an object", requestId);
  return value as unknown as Request;
}

export function stringParam(params: Record<string, unknown>, key: string, max: number): string {
  const value = params[key];
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new ProtocolError("INVALID_REQUEST", `Invalid ${key}`);
  return value;
}
