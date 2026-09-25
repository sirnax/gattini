/**
 * Small offline-spike client for OpenCode's documented V2 HTTP API.
 * The HTTP API and durable session log are experimental in OpenCode's docs.
 * No permission-enforcement or runtime-isolation guarantee is inferred here.
 */

type JsonRecord = Record<string, unknown>;

export class OpenCodeApiError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "OpenCodeApiError";
  }
}

export interface OpenCodeModelRef {
  providerID: string;
  modelID: string;
}

export interface OpenCodeSession {
  id: string;
  agent: string;
  model: OpenCodeModelRef;
}

export interface OpenCodeOptions {
  /** Must be a loopback HTTP URL; HTTPS and remote hosts are intentionally unsupported. */
  baseUrl: string;
  /** Absolute directory of the repository whose agent configuration is used. */
  directory: string;
  /** Password printed by an owned local service; never embed it in baseUrl. */
  password?: string;
  fetch?: typeof fetch;
  requestTimeoutMs?: number;
  maxResponseBytes?: number;
}

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function requiredString(value: unknown, label: string, max = 512): string {
  if (typeof value !== "string" || value.trim() === "" || value.length > max) {
    throw new OpenCodeApiError(`Invalid ${label} in OpenCode response`);
  }
  return value;
}

function decodeJson(text: string, label: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new OpenCodeApiError(`OpenCode returned invalid JSON for ${label}`);
  }
}

function dataField(value: unknown, label: string): unknown {
  if (!isRecord(value) || !("data" in value)) throw new OpenCodeApiError(`Malformed ${label} response: missing data`);
  return value.data;
}

function responseModel(value: unknown, label: string): OpenCodeModelRef {
  if (!isRecord(value)) throw new OpenCodeApiError(`Malformed ${label}: expected model object`);
  return {
    providerID: requiredString(value.providerID, `${label}.providerID`),
    modelID: requiredString(value.modelID ?? value.id, `${label}.modelID`),
  };
}

function parseSession(value: unknown): OpenCodeSession {
  if (!isRecord(value)) throw new OpenCodeApiError("Malformed session response: expected object");
  const id = requiredString(value.id, "session.id");
  if (!id.startsWith("ses")) throw new OpenCodeApiError("Malformed session response: id is not an OpenCode session ID");
  return {
    id,
    agent: requiredString(value.agent, "session.agent"),
    model: responseModel(value.model, "session.model"),
  };
}

function modelKey(model: OpenCodeModelRef): string {
  return `${model.providerID}\0${model.modelID}`;
}

function loopbackBase(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new OpenCodeApiError("OpenCode baseUrl must be a valid loopback URL");
  }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]", "::1"].includes(host) || url.username || url.password || url.search || url.hash) {
    throw new OpenCodeApiError("OpenCode adapter only permits an HTTP loopback base URL without embedded credentials");
  }
  url.pathname = `${url.pathname.replace(/\/$/, "")}/`;
  return url;
}

/** A private, loopback-only client. It never starts or stops the OpenCode service. */
export class OpenCodeV2Client {
  private readonly baseUrl: URL;
  private readonly directory: string;
  private readonly fetchImpl: typeof fetch;
  private readonly requestTimeoutMs: number;
  private readonly maxResponseBytes: number;

  constructor(options: OpenCodeOptions) {
    this.baseUrl = loopbackBase(options.baseUrl);
    if (typeof options.directory !== "string" || !options.directory.startsWith("/") || options.directory.includes("\0")) {
      throw new OpenCodeApiError("OpenCode directory must be an absolute path");
    }
    this.directory = options.directory;
    this.fetchImpl = options.fetch ?? fetch;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    this.maxResponseBytes = options.maxResponseBytes ?? 2_000_000;
    if (!Number.isInteger(this.requestTimeoutMs) || this.requestTimeoutMs < 1 || this.requestTimeoutMs > 300_000) {
      throw new OpenCodeApiError("requestTimeoutMs must be an integer from 1 to 300000");
    }
    if (!Number.isInteger(this.maxResponseBytes) || this.maxResponseBytes < 1 || this.maxResponseBytes > 16_000_000) {
      throw new OpenCodeApiError("maxResponseBytes must be an integer from 1 to 16000000");
    }
    this.password = options.password;
  }

  private readonly password: string | undefined;

  private endpoint(path: string): URL {
    return new URL(path.replace(/^\//, ""), this.baseUrl);
  }

  private locationQuery(): string {
    return new URLSearchParams({ "location[directory]": this.directory }).toString();
  }

  private async request(path: string, init: RequestInit = {}): Promise<{ status: number; body: string }> {
    const headers = new Headers(init.headers);
    headers.set("accept", "application/json");
    if (init.body !== undefined) headers.set("content-type", "application/json");
    if (this.password !== undefined) {
      if (this.password.length === 0 || this.password.length > 4096) throw new OpenCodeApiError("OpenCode password has invalid length");
      headers.set("authorization", `Basic ${btoa(`opencode:${this.password}`)}`);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    try {
      const response = await this.fetchImpl(this.endpoint(path), { ...init, headers, signal: controller.signal, redirect: "error" });
      const reader = response.body?.getReader();
      if (!reader) return { status: response.status, body: "" };
      const parts: Uint8Array[] = [];
      let size = 0;
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > this.maxResponseBytes) {
          await reader.cancel();
          throw new OpenCodeApiError("OpenCode response exceeded configured byte limit", response.status);
        }
        parts.push(chunk.value);
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const part of parts) {
        bytes.set(part, offset);
        offset += part.byteLength;
      }
      return { status: response.status, body: new TextDecoder().decode(bytes) };
    } catch (error) {
      if (error instanceof OpenCodeApiError) throw error;
      throw new OpenCodeApiError(error instanceof Error && error.name === "AbortError" ? "OpenCode request timed out" : "OpenCode request failed");
    } finally {
      clearTimeout(timer);
    }
  }

  private async json(path: string, init?: RequestInit): Promise<unknown> {
    const response = await this.request(path, init);
    if (response.status < 200 || response.status >= 300) throw new OpenCodeApiError(`OpenCode HTTP request failed with status ${response.status}`, response.status);
    return decodeJson(response.body, path);
  }

  async listAgents(): Promise<string[]> {
    const data = dataField(await this.json(`api/agent?${this.locationQuery()}`), "agent list");
    if (!Array.isArray(data)) throw new OpenCodeApiError("Malformed agent list: data must be an array");
    return data.map((agent, index) => {
      if (!isRecord(agent)) throw new OpenCodeApiError(`Malformed agent list entry ${index}`);
      return requiredString(agent.id, `agent[${index}].id`);
    });
  }

  private async waitForAgent(agent: string): Promise<boolean> {
    // The installed V2 service can return an empty list while a project location loads.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      if ((await this.listAgents()).includes(agent)) return true;
      if (attempt < 4) await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return false;
  }

  async listModels(): Promise<OpenCodeModelRef[]> {
    const data = dataField(await this.json("api/model"), "model list");
    if (!Array.isArray(data)) throw new OpenCodeApiError("Malformed model list: data must be an array");
    return data.map((model, index) => {
      if (!isRecord(model)) throw new OpenCodeApiError(`Malformed model list entry ${index}`);
      return {
        providerID: requiredString(model.providerID, `model[${index}].providerID`),
        modelID: requiredString(model.modelID, `model[${index}].modelID`),
      };
    });
  }

  /** Creates a fresh session only after exact agent and model discovery succeeds. */
  async createSession(input: { agent: string; model: OpenCodeModelRef; permissions: Array<{ action: string; resource: string; effect: "allow" | "deny" | "ask" }>; title?: string }): Promise<OpenCodeSession> {
    const agent = requiredString(input.agent, "requested agent");
    const requestedModel = responseModel(input.model, "requested model");
    if (!Array.isArray(input.permissions) || input.permissions.length === 0 || input.permissions.length > 100) {
      throw new OpenCodeApiError("Explicit non-empty permission rules are required to create an OpenCode session");
    }
    const permissions = input.permissions.map((rule, index) => {
      if (!isRecord(rule) || typeof rule.action !== "string" || !rule.action || typeof rule.resource !== "string" || !rule.resource || !["allow", "deny", "ask"].includes(rule.effect)) {
        throw new OpenCodeApiError(`Invalid permission rule at index ${index}`);
      }
      return { action: rule.action, resource: rule.resource, effect: rule.effect };
    });
    const [agentAvailable, models] = await Promise.all([this.waitForAgent(agent), this.listModels()]);
    if (!agentAvailable) throw new OpenCodeApiError(`Requested OpenCode agent is unavailable: ${agent}`);
    if (!models.some((model) => modelKey(model) === modelKey(requestedModel))) {
      throw new OpenCodeApiError(`Requested OpenCode model is unavailable: ${requestedModel.providerID}/${requestedModel.modelID}`);
    }

    const body = {
      id: null,
      title: input.title ?? null,
      agent,
      model: { providerID: requestedModel.providerID, id: requestedModel.modelID },
      location: { directory: this.directory },
      metadata: null,
      permissions,
    };
    const created = parseSession(dataField(await this.json("api/session", { method: "POST", body: JSON.stringify(body) }), "session create"));
    if (created.agent !== agent || modelKey(created.model) !== modelKey(requestedModel)) {
      throw new OpenCodeApiError("OpenCode created a session with an identity different from the requested agent/model");
    }
    return created;
  }

  /** Reads exact session metadata; status stays unknown until runtime semantics are live-verified. */
  async getSession(sessionId: string): Promise<{ session: OpenCodeSession; status: "unknown" }> {
    const id = this.sessionId(sessionId);
    const session = parseSession(dataField(await this.json(`api/session/${encodeURIComponent(id)}`), "session get"));
    if (session.id !== id) throw new OpenCodeApiError("OpenCode returned a different session ID than requested");
    return { session, status: "unknown" };
  }

  /** OpenCode reports active drains owned by this service; absence means inactive there. */
  async isSessionActive(sessionId: string): Promise<boolean> {
    const id = this.sessionId(sessionId);
    const active = dataField(await this.json("api/session/active"), "active sessions");
    if (!isRecord(active)) throw new OpenCodeApiError("Malformed active-session response");
    return Object.hasOwn(active, id);
  }

  /** Returns bounded projected messages so callers can inspect execution outcome separately. */
  async listMessages(sessionId: string): Promise<Array<{ id: string; type: string; agent?: string; finish?: string; error?: unknown; content?: unknown; text?: string }>> {
    const id = this.sessionId(sessionId);
    const body = await this.json(`api/session/${encodeURIComponent(id)}/message`);
    const data = dataField(body, "session messages");
    if (!Array.isArray(data) || data.length > 1000) throw new OpenCodeApiError("Malformed or oversized session message list");
    return data.map((message, index) => {
      if (!isRecord(message)) throw new OpenCodeApiError(`Malformed message ${index}`);
      const parsed: { id: string; type: string; agent?: string; finish?: string; error?: unknown; content?: unknown; text?: string } = {
        id: requiredString(message.id, `message[${index}].id`),
        type: requiredString(message.type, `message[${index}].type`),
      };
      if (typeof message.agent === "string") parsed.agent = message.agent;
      if (typeof message.finish === "string") parsed.finish = message.finish;
      if ("error" in message) parsed.error = message.error;
      if ("content" in message) parsed.content = message.content;
      if (typeof message.text === "string") parsed.text = message.text;
      return parsed;
    });
  }

  /** Fetches bounded historical SSE records (follow=false); SSE payloads remain untrusted strings. */
  async readLog(sessionId: string, options: { after?: string; maxRecords?: number } = {}): Promise<string[]> {
    const id = this.sessionId(sessionId);
    const maxRecords = options.maxRecords ?? 100;
    if (!Number.isInteger(maxRecords) || maxRecords < 1 || maxRecords > 1000) throw new OpenCodeApiError("maxRecords must be an integer from 1 to 1000");
    const url = this.endpoint(`api/experimental/session/${encodeURIComponent(id)}/log`);
    url.searchParams.set("follow", "false");
    if (options.after !== undefined) url.searchParams.set("after", requiredString(options.after, "log cursor", 128));
    const response = await this.request(`${url.pathname}${url.search}`);
    if (response.status !== 200) throw new OpenCodeApiError(`OpenCode log request failed with status ${response.status}`, response.status);
    const records: string[] = [];
    let current: string[] = [];
    for (const line of response.body.split(/\r?\n/)) {
      if (line === "") {
        if (current.length > 0) records.push(current.join("\n"));
        current = [];
        if (records.length >= maxRecords) break;
      } else if (!line.startsWith(":")) current.push(line.slice(0, 16_384));
    }
    if (current.length > 0 && records.length < maxRecords) records.push(current.join("\n"));
    return records;
  }

  /** Sends one prompt to the exact session and verifies the returned session identity. */
  async sendPrompt(sessionId: string, text: string): Promise<{ sessionId: string; admitted: true }> {
    const id = this.sessionId(sessionId);
    if (typeof text !== "string" || text.trim() === "" || text.length > 100_000) throw new OpenCodeApiError("Prompt must be non-empty and at most 100000 characters");
    const result = await this.json(`api/session/${encodeURIComponent(id)}/prompt`, { method: "POST", body: JSON.stringify({ text }) });
    const admittedData = isRecord(result) && "data" in result ? result.data : result;
    if (!isRecord(admittedData)) throw new OpenCodeApiError("Malformed prompt response");
    const admittedSession = requiredString(admittedData.sessionID, "prompt.sessionID");
    if (admittedSession !== id) throw new OpenCodeApiError("OpenCode admitted prompt to a different session");
    return { sessionId: id, admitted: true };
  }

  /** Acknowledges interruption of active work; callers must observe subsequent inactivity. */
  async interrupt(sessionId: string): Promise<{ sessionId: string; interrupted: boolean }> {
    const id = this.sessionId(sessionId);
    const response = await this.json(`api/session/${encodeURIComponent(id)}/interrupt?resume=false`, { method: "POST" });
    const data = isRecord(response) && "data" in response ? response.data : response;
    if (!isRecord(data) || typeof data.interrupted !== "boolean") throw new OpenCodeApiError("Malformed interrupt response: missing boolean interrupted");
    return { sessionId: id, interrupted: data.interrupted };
  }

  private sessionId(value: string): string {
    const id = requiredString(value, "session ID", 256);
    if (!/^ses[A-Za-z0-9_-]+$/.test(id)) throw new OpenCodeApiError("Invalid OpenCode session ID");
    return id;
  }
}
