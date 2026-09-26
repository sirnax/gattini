import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MAX_STREAM_BYTES = 1024 * 1024;

export interface ReviewRole {
  runtime: "opencode";
  agent: string;
  model: string;
  directory: string;
  serverUrl: string;
  permissions: Array<{ action: string; resource: string; effect: "allow" | "deny" }>;
}

export interface OpenCodeCliEvent {
  type: string;
  sessionID?: string;
  id?: string;
  eventID?: string;
  part?: { type?: string; id?: string; tool?: string; state?: { status?: string }; text?: string;
    cost?: number; tokens?: { input?: number; output?: number } };
  error?: { type?: string; message?: string };
}

async function command(args: string[], directory: string): Promise<string> {
  const { stdout } = await execFileAsync("opencode", args, { cwd: directory, env: { ...process.env, PWD: directory }, timeout: 20_000, maxBuffer: MAX_STREAM_BYTES });
  return stdout.trim();
}

/** An explicit process-local opt-in keeps the historical authenticated shared-service path intact. */
function privateServerUrl(role: ReviewRole): string | undefined {
  const configured = process.env.GATTINI_OPENCODE_PRIVATE_SERVER_URL;
  if (configured === undefined) return undefined;
  let requested: URL;
  let expected: URL;
  try {
    requested = new URL(configured);
    expected = new URL(role.serverUrl);
  } catch { throw new Error("Private OpenCode server URL is invalid"); }
  const plainLoopback = (url: URL): boolean => url.protocol === "http:" &&
    ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname.toLowerCase()) &&
    !!url.port && !url.username && !url.password && !url.search && !url.hash && url.pathname === "/";
  if (!plainLoopback(requested) || !plainLoopback(expected) || requested.origin !== expected.origin) {
    throw new Error("Private OpenCode server URL must match the configured loopback role origin");
  }
  return requested.origin;
}

function apiArgs(role: ReviewRole, operation: string, ...args: string[]): string[] {
  const server = privateServerUrl(role);
  return ["api", ...(server ? ["--server", server] : []), operation, ...args];
}

async function targetedCommand(role: ReviewRole, args: string[]): Promise<string> {
  try { return await command(args, role.directory); }
  catch { throw new Error("Private OpenCode service request failed or was not authenticated"); }
}

async function checkService(role: ReviewRole): Promise<string | undefined> {
  const server = privateServerUrl(role);
  if (!server) {
    const serviceUrl = await command(["service", "status"], role.directory);
    if (serviceUrl !== role.serverUrl.replace(/\/$/, "")) throw new Error("Configured OpenCode service is not the active shared service");
    return undefined;
  }
  const raw = await targetedCommand(role, apiArgs(role, "GET", "/api/info"));
  const info = JSON.parse(raw) as { data?: { version?: unknown }; version?: unknown };
  const version = info.data?.version ?? info.version;
  if (version !== "2.0.18" && version !== "opencode v2.0.18") throw new Error("Private OpenCode service version is not V2.0.18");
  return server;
}

export async function preflightReview(role: ReviewRole): Promise<void> {
  const server = privateServerUrl(role);
  const version = await command(["--version"], role.directory);
  if (version !== (server ? "opencode v2.0.18" : "opencode v2.0.16")) throw new Error("OpenCode CLI version does not match the selected transport");
  await checkService(role);
  const request = server ? targetedCommand : (r: ReviewRole, args: string[]) => command(args, r.directory);
  const active = JSON.parse(await request(role, apiArgs(role, "session.active"))) as { data?: unknown };
  if (!active || typeof active !== "object" || !active.data || typeof active.data !== "object") {
    throw new Error("OpenCode shared service did not return an active-session response");
  }
  let agents: Array<{
    id?: string; permissions?: Array<{ action: string; resource: string; effect: string }>;
  }> = [];
  for (let attempt = 0; attempt < (server ? 5 : 1); attempt += 1) {
    const agentResponse = JSON.parse(await request(role, server ?
      apiArgs(role, "agent.list", "--param", `location[directory]=${role.directory}`) : ["debug", "agents"])) as
      { data?: unknown } | Array<unknown>;
    const list = server ? (agentResponse as { data?: unknown }).data : agentResponse;
    if (!Array.isArray(list)) throw new Error("OpenCode service did not return an effective agent list");
    agents = list as typeof agents;
    if (agents.some(item => item.id === role.agent)) break;
    if (attempt < 4 && server) await new Promise(resolve => setTimeout(resolve, 250));
  }
  const agent = agents.find(item => item.id === role.agent);
  if (!agent || !Array.isArray(agent.permissions)) throw new Error(`OpenCode agent ${role.agent} is unavailable`);
  const expected = role.permissions;
  const actual = server ? agent.permissions.slice(-expected.length) : agent.permissions;
  if (actual.length !== expected.length || actual.some((rule, index) => {
    const wanted = expected[index];
    return !wanted || rule.action !== wanted.action || rule.resource !== wanted.resource || rule.effect !== wanted.effect;
  })) throw new Error(`OpenCode agent ${role.agent} does not have the required read-only permissions`);
  const models = (await request(role, ["models", ...(server ? ["--server", server] : [])])).split(/\r?\n/);
  if (!models.includes(role.model)) throw new Error(`OpenCode model ${role.model} is unavailable`);
}

export async function runReview(
  role: ReviewRole,
  task: string,
  onEvent: (event: OpenCodeCliEvent) => void,
  signal?: AbortSignal,
  timeoutMs = 300_000,
): Promise<{ sessionId: string; summary: string }> {
  return runReviewStream(role, task, onEvent, signal, undefined, timeoutMs);
}

/** Continue the saved OpenCode session without relying on implicit last-session routing. */
export async function runReviewFollowup(
  role: ReviewRole,
  sessionId: string,
  task: string,
  onEvent: (event: OpenCodeCliEvent) => void,
  signal?: AbortSignal,
  timeoutMs = 300_000,
): Promise<{ sessionId: string; summary: string }> {
  if (!/^ses_[A-Za-z0-9]+$/.test(sessionId)) throw new Error("Invalid OpenCode session ID");
  return runReviewStream(role, task, onEvent, signal, sessionId, timeoutMs);
}

function runReviewStream(
  role: ReviewRole,
  task: string,
  onEvent: (event: OpenCodeCliEvent) => void,
  signal?: AbortSignal,
  expectedSessionId?: string,
  timeoutMs = 300_000,
): Promise<{ sessionId: string; summary: string }> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) throw new RangeError("Review timeout must be 1..300000 ms");
  return new Promise((resolve, reject) => {
    let server: string | undefined;
    try { server = privateServerUrl(role); } catch (error) { reject(error); return; }
    const args = ["run", ...(server ? ["--server", server] : []), ...(expectedSessionId ? ["--session", expectedSessionId] : []), "--agent", role.agent, "--model", role.model, "--format", "json", task];
    const child = spawn("opencode", args, {
      cwd: role.directory, env: { ...process.env, PWD: role.directory }, stdio: ["ignore", "pipe", "pipe"], signal,
    });
    let pending = "";
    let totalBytes = 0;
    let stderr = "";
    let sessionId = "";
    let summary = "";
    let streamError: Error | undefined;
    const timer = setTimeout(() => {
      streamError = new Error("OpenCode review exceeded its runtime timeout; runtime state requires reconciliation");
      child.kill("SIGTERM");
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (streamError) return;
      totalBytes += Buffer.byteLength(chunk);
      if (totalBytes > MAX_STREAM_BYTES) {
        streamError = new Error("OpenCode output exceeds 1 MiB");
        child.kill("SIGTERM");
        return;
      }
      pending += chunk;
      let newline: number;
      while ((newline = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line) as OpenCodeCliEvent;
          if (typeof event.type !== "string") throw new Error("Missing OpenCode event type");
          if (expectedSessionId && event.sessionID !== expectedSessionId) throw new Error("OpenCode follow-up event has missing or mismatched session ID");
          if (event.sessionID) {
            if (sessionId && event.sessionID !== sessionId) throw new Error("OpenCode stream changed session ID");
            sessionId = event.sessionID;
          }
          if (event.type === "text" && typeof event.part?.text === "string") summary = event.part.text.slice(0, 4096);
          onEvent(event);
        } catch (error) {
          streamError = error instanceof Error ? error : new Error("Malformed OpenCode event");
          child.kill("SIGTERM");
          return;
        }
      }
    });
    child.stderr.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-4096); });
    child.once("error", reject);
    child.once("close", code => {
      clearTimeout(timer);
      if (streamError) return reject(streamError);
      if (pending.trim()) return reject(new Error("Incomplete OpenCode event stream"));
      if (code !== 0) return reject(new Error(server ? `Private OpenCode run exited ${code}` : `OpenCode exited ${code}: ${stderr.slice(-500)}`));
      if (!sessionId || !summary) return reject(new Error("OpenCode run omitted session ID or final text"));
      resolve({ sessionId, summary });
    });
  });
}

export async function getReviewSession(role: ReviewRole, sessionId: string): Promise<{ agent: string; model: { providerID: string; id: string }; outcome: string; directory: string }> {
  if (!/^ses_[A-Za-z0-9]+$/.test(sessionId)) throw new Error("Invalid OpenCode session ID");
  const server = await checkService(role);
  const raw = await (server ? targetedCommand(role, apiArgs(role, "session.get", "--param", `sessionID=${sessionId}`)) :
    command(apiArgs(role, "session.get", "--param", `sessionID=${sessionId}`), role.directory));
  const response = JSON.parse(raw) as { data?: { id?: string; agent?: string; model?: { providerID?: string; id?: string }; outcome?: string; location?: { directory?: string } } };
  if (response.data?.id !== sessionId || !response.data.agent || !response.data.model?.providerID || !response.data.model.id || !response.data.outcome || !response.data.location?.directory) {
    throw new Error("OpenCode session lookup returned incomplete or mismatched identity");
  }
  if (server) {
    const slash = role.model.indexOf("/");
    if (slash < 1 || response.data.agent !== role.agent || response.data.model.providerID !== role.model.slice(0, slash) ||
      response.data.model.id !== role.model.slice(slash + 1) || response.data.location.directory !== role.directory) {
      throw new Error("Private OpenCode session identity does not match the configured role");
    }
  }
  return { agent: response.data.agent, model: { providerID: response.data.model.providerID, id: response.data.model.id }, outcome: response.data.outcome, directory: response.data.location.directory };
}

export async function isReviewSessionActive(role: ReviewRole, sessionId: string): Promise<boolean> {
  if (!/^ses_[A-Za-z0-9]+$/.test(sessionId)) throw new Error("Invalid OpenCode session ID");
  const server = await checkService(role);
  const response = JSON.parse(await (server ? targetedCommand(role, apiArgs(role, "session.active")) :
    command(apiArgs(role, "session.active"), role.directory))) as { data?: Record<string, unknown> };
  if (!response.data || typeof response.data !== "object") throw new Error("OpenCode active-session response is malformed");
  return sessionId in response.data;
}

/** Exact-session interruption. Acknowledgement alone is not confirmation. */
export async function interruptReview(role: ReviewRole, sessionId: string): Promise<boolean> {
  if (!/^ses_[A-Za-z0-9]+$/.test(sessionId)) throw new Error("Invalid OpenCode session ID");
  const server = await checkService(role);
  const request = server ? targetedCommand : (r: ReviewRole, args: string[]) => command(args, r.directory);
  const acknowledgement = JSON.parse(await request(role, apiArgs(role, "session.interrupt", "--param", `sessionID=${sessionId}`, "--param", "resume=false"))) as { interrupted?: unknown };
  if (acknowledgement.interrupted !== true) return false;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const active = JSON.parse(await request(role, apiArgs(role, "session.active"))) as { data?: Record<string, unknown> };
    if (!active.data || typeof active.data !== "object") throw new Error("OpenCode active-session response is malformed");
    if (!(sessionId in active.data)) {
      try {
        const session = await getReviewSession(role, sessionId);
        if (session.outcome === "interrupted" && session.directory === role.directory) return true;
        if (session.outcome === "succeeded" || session.outcome === "failed") return false;
      } catch { /* Session finalization can lag behind active-status removal. */ }
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  return false;
}
