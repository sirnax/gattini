import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import type { CodeRoleConfig } from "../core/coding.js";
import { canonicalWorktree, matchesCodePermissions, CodePolicyError, CODE_PATH_PERMISSION_SYNTAX_VERIFIED } from "../core/code-policy.js";

const execFileAsync = promisify(execFile);
const MAX_STREAM_BYTES = 1024 * 1024;
const SUPPORTED_VERSION = "opencode v2.0.16";
const PROPOSAL_VERSION = "opencode v2.0.18";

/** A worktree scopes intended edits; this local runtime is not host containment. */
export const CODE_RUNTIME_LIMITATIONS = [
  "OpenCode tool rules are runtime policy, not OS filesystem or network containment.",
  "Read, glob, and grep remain available to the local runtime outside the worktree.",
  "Same-user processes, plugins, and runtime compromise are outside this boundary.",
] as const;

export interface CodeCliEvent {
  type: string;
  sessionID?: string;
  id?: string;
  eventID?: string;
  part?: { type?: string; id?: string; tool?: string; state?: { status?: string }; text?: string;
    cost?: number; tokens?: { input?: number; output?: number } };
  error?: { type?: string; message?: string };
}

async function command(args: string[], directory: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("opencode", args, {
      cwd: directory, env: { ...process.env, PWD: directory }, timeout: 20_000, maxBuffer: MAX_STREAM_BYTES,
    });
    return stdout.trim();
  } catch (error) {
    const message = error instanceof Error ? error.message : "command failed";
    throw new Error(`OpenCode ${args[0] ?? "command"} failed: ${message.slice(0, 500)}`);
  }
}

function modelParts(model: string): { providerID: string; id: string } {
  const slash = model.indexOf("/");
  if (slash < 1 || slash === model.length - 1) throw new CodePolicyError("Code role model must use an exact provider/model identifier");
  return { providerID: model.slice(0, slash), id: model.slice(slash + 1) };
}

function sessionId(value: string): void {
  if (!/^ses_[A-Za-z0-9]+$/.test(value)) throw new CodePolicyError("Invalid OpenCode session ID");
}

/** Read-only runtime checks. Every mismatch refuses before a coding process is spawned. */
export async function preflightCode(role: CodeRoleConfig, worktreePath: string): Promise<void> {
  const directory = canonicalWorktree(worktreePath);
  modelParts(role.model);
  if (!CODE_PATH_PERMISSION_SYNTAX_VERIFIED) {
    throw new CodePolicyError("Coding refused: the tested OpenCode edit policy allowed a symlink write outside the worktree; a stronger write boundary is required");
  }
  const version = await command(["--version"], directory);
  if (version !== SUPPORTED_VERSION) throw new Error(`OpenCode version ${version} is unsupported; tested version is 2.0.16`);
  const serviceUrl = await command(["service", "status"], directory);
  if (serviceUrl !== role.serverUrl.replace(/\/$/, "")) throw new Error("Configured OpenCode service is not the active shared service");
  const active = JSON.parse(await command(["api", "session.active"], directory)) as { data?: unknown };
  if (!active || typeof active !== "object" || !active.data || typeof active.data !== "object") {
    throw new Error("OpenCode shared service did not return an active-session response");
  }
  const agents = JSON.parse(await command(["debug", "agents"], directory)) as Array<{
    id?: string; permissions?: unknown;
  }>;
  const agent = agents.find(item => item.id === role.agent);
  if (!agent || !matchesCodePermissions(agent.permissions, directory)) {
    throw new Error(`OpenCode agent ${role.agent} does not have the exact deny-all, read-only, edit, and external-directory-denying rules; coding refused`);
  }
  const models = (await command(["models"], directory)).split(/\r?\n/);
  if (!models.includes(role.model)) throw new Error(`OpenCode model ${role.model} is unavailable`);
}

/** Only this policy may launch a Task 9 proposal. The legacy edit path stays disabled. */
export async function preflightProposal(role: CodeRoleConfig, worktreePath: string): Promise<void> {
  const directory = canonicalWorktree(worktreePath);
  modelParts(role.model);
  if (await command(["--version"], directory) !== PROPOSAL_VERSION) throw new CodePolicyError("Read-only proposal requires tested OpenCode V2.0.18");
  if (await command(["service", "status"], directory) !== role.serverUrl.replace(/\/$/, "")) throw new CodePolicyError("Configured OpenCode service differs from active service");
  const active = JSON.parse(await command(["api", "session.active"], directory)) as { data?: unknown };
  if (!active.data || typeof active.data !== "object") throw new CodePolicyError("OpenCode active-session response is invalid");
  const agents = JSON.parse(await command(["debug", "agents"], directory)) as Array<{ id?: string; permissions?: unknown }>;
  const expected = [
    { action: "*", resource: "*", effect: "deny" },
    { action: "read", resource: "*", effect: "allow" },
    { action: "glob", resource: "*", effect: "allow" },
    { action: "grep", resource: "*", effect: "allow" },
  ];
  const agent = agents.find(item => item.id === role.agent);
  if (!agent || !Array.isArray(agent.permissions) || JSON.stringify(agent.permissions.slice(-4)) !== JSON.stringify(expected)) throw new CodePolicyError("Proposal agent lacks the exact deny-all/read-only permission tail");
  if (!(await command(["models"], directory)).split(/\r?\n/).includes(role.model)) throw new CodePolicyError("Proposal model is unavailable");
}

/** Launch only after policy preflight and require a stable session ID in NDJSON output. */
export async function runCode(
  role: CodeRoleConfig,
  worktreePath: string,
  task: string,
  onEvent: (event: CodeCliEvent) => void,
  signal?: AbortSignal,
): Promise<{ sessionId: string; summary: string }> {
  const directory = canonicalWorktree(worktreePath);
  if (typeof task !== "string" || task.trim() === "" || task.length > 64 * 1024 || task.includes("\0")) {
    throw new CodePolicyError("Coding task must be non-empty and at most 64 KiB");
  }
  await preflightCode(role, directory);
  return new Promise((resolve, reject) => {
    const child = spawn("opencode", ["run", "--agent", role.agent, "--model", role.model, "--format", "json", task], {
      cwd: directory, env: { ...process.env, PWD: directory }, stdio: ["ignore", "pipe", "pipe"], signal,
    });
    let pending = "";
    let totalBytes = 0;
    let stderr = "";
    let id = "";
    let summary = "";
    let streamError: Error | undefined;
    const timer = setTimeout(() => {
      streamError = new Error("OpenCode coding run exceeded five minutes; runtime state requires reconciliation");
      child.kill("SIGTERM");
    }, 300_000);
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
          const event = JSON.parse(line) as CodeCliEvent;
          if (typeof event.type !== "string") throw new Error("Missing OpenCode event type");
          if (event.sessionID) {
            sessionId(event.sessionID);
            if (id && event.sessionID !== id) throw new Error("OpenCode stream changed session ID");
            id = event.sessionID;
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
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("close", code => {
      clearTimeout(timer);
      if (streamError) return reject(streamError);
      if (pending.trim()) return reject(new Error("Incomplete OpenCode event stream"));
      if (code !== 0) return reject(new Error(`OpenCode exited ${code}: ${stderr.slice(-500)}`));
      if (!id || !summary) return reject(new Error("OpenCode run omitted session ID or final text"));
      resolve({ sessionId: id, summary });
    });
  });
}

export async function runProposal(role: CodeRoleConfig, worktreePath: string, task: string,
  onEvent: (event: CodeCliEvent) => void, signal?: AbortSignal, timeoutMs = 300_000): Promise<{ sessionId: string; proposal: string }> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) throw new RangeError("Proposal timeout must be 1..300000 ms");
  await preflightProposal(role, worktreePath);
  const directory = canonicalWorktree(worktreePath);
  const instruction = `${task}\n\nReturn ONLY strict JSON with path, beforeSha256, and afterBase64. Do not edit files.`;
  return new Promise((resolve, reject) => {
    const child = spawn("opencode", ["run", "--agent", role.agent, "--model", role.model, "--format", "json", instruction], {
      cwd: directory, env: { ...process.env, PWD: directory }, stdio: ["ignore", "pipe", "pipe"], signal,
    });
    let pending = "", stderr = "", id = "", proposal = "", bytes = 0, failure: Error | undefined;
    const timer = setTimeout(() => { failure = new Error("Proposal launch timed out; runtime state uncertain"); child.kill("SIGTERM"); }, timeoutMs);
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > MAX_STREAM_BYTES) { failure = new Error("Proposal stream exceeds 1 MiB"); child.kill("SIGTERM"); return; }
      pending += chunk;
      let newline: number;
      while ((newline = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line) as CodeCliEvent;
          if (typeof event.type !== "string") throw new Error("Invalid proposal event");
          if (event.sessionID) { sessionId(event.sessionID); if (id && id !== event.sessionID) throw new Error("Proposal session changed"); id = event.sessionID; }
          if (event.part?.tool && !["read", "glob", "grep"].includes(event.part.tool)) throw new Error("Proposal used an unapproved tool");
          if (event.type === "text" && typeof event.part?.text === "string") proposal = event.part.text;
          onEvent(event);
        } catch (error) { failure = error instanceof Error ? error : new Error("Invalid proposal stream"); child.kill("SIGTERM"); return; }
      }
    });
    child.stderr.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-4096); });
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("close", code => {
      clearTimeout(timer);
      if (failure) return reject(failure);
      if (pending.trim() || code !== 0 || !id || !proposal) return reject(new Error(`Proposal did not finish with exact session and text: ${stderr.slice(-500)}`));
      resolve({ sessionId: id, proposal });
    });
  });
}

export interface CodeSession {
  agent: string;
  model: { providerID: string; id: string };
  outcome: string;
  directory: string;
}

export async function getCodeSession(role: CodeRoleConfig, worktreePath: string, id: string): Promise<CodeSession> {
  sessionId(id);
  const directory = canonicalWorktree(worktreePath);
  const serviceUrl = await command(["service", "status"], directory);
  if (serviceUrl !== role.serverUrl.replace(/\/$/, "")) throw new Error("Configured shared service changed before session lookup");
  const raw = await command(["api", "session.get", "--param", `sessionID=${id}`], directory);
  const response = JSON.parse(raw) as { data?: { id?: string; agent?: string; model?: { providerID?: string; id?: string }; outcome?: string; location?: { directory?: string } } };
  if (response.data?.id !== id || !response.data.agent || !response.data.model?.providerID || !response.data.model.id ||
      !response.data.outcome || !response.data.location?.directory) throw new Error("OpenCode session lookup returned incomplete or mismatched identity");
  const resolvedModel = modelParts(role.model);
  if (response.data.agent !== role.agent || response.data.model.providerID !== resolvedModel.providerID || response.data.model.id !== resolvedModel.id ||
      response.data.location.directory !== directory) throw new Error("OpenCode session identity does not match the requested agent, model, and worktree");
  return { agent: response.data.agent, model: { providerID: response.data.model.providerID, id: response.data.model.id },
    outcome: response.data.outcome, directory: response.data.location.directory };
}

export async function interruptCode(role: CodeRoleConfig, worktreePath: string, id: string): Promise<boolean> {
  sessionId(id);
  const directory = canonicalWorktree(worktreePath);
  const serviceUrl = await command(["service", "status"], directory);
  if (serviceUrl !== role.serverUrl.replace(/\/$/, "")) throw new Error("Configured shared service changed before cancellation");
  const acknowledgement = JSON.parse(await command(["api", "session.interrupt", "--param", `sessionID=${id}`, "--param", "resume=false"], directory)) as { interrupted?: unknown };
  if (acknowledgement.interrupted !== true) return false;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const active = JSON.parse(await command(["api", "session.active"], directory)) as { data?: Record<string, unknown> };
    if (!active.data || typeof active.data !== "object") throw new Error("OpenCode active-session response is malformed");
    if (!(id in active.data)) {
      try {
        const session = await getCodeSession(role, directory, id);
        if (session.outcome === "interrupted") return true;
        if (session.outcome === "succeeded" || session.outcome === "failed") return false;
      } catch { /* Session finalization can lag behind active-status removal. */ }
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  return false;
}
