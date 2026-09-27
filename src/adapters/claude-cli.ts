/** Bounded, single-turn Claude Code transport. This module never resumes a session. */
import { spawn, execFile, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const VERSION = "2.1.283 (Claude Code)";
const TOOLS = ["Read", "Glob", "Grep"] as const;
const MAX_STREAM_BYTES = 4_000_000;
const MAX_LINE_BYTES = 1_000_000;
const MAX_EVENTS = 10_000;
const MAX_STDERR_BYTES = 65_536;
type JsonRecord = Record<string, unknown>;
const record = (value: unknown): value is JsonRecord => !!value && typeof value === "object" && !Array.isArray(value);

export interface ClaudeTurnConfig {
  model: string;
  executable: string;
  cwd: string;
  task: string;
  maxBudgetUsd: number;
}
export interface ClaudeTurnIdentity {
  sessionId: string;
  model: string;
  runtimeVersion: string;
  executable: string;
  cwd: string;
}
export type ClaudeIdentity = ClaudeTurnIdentity;
export type ClaudeUsage = ClaudeTurnResult["usage"];
export interface ClaudeTurnResult {
  identity: ClaudeTurnIdentity;
  text: string;
  usage: { inputTokens: number | null; outputTokens: number | null; costUsd: number | null };
}
export interface ClaudeTurnOptions {
  timeoutMs?: number;
  maxTextBytes?: number;
  onIdentity?: (identity: ClaudeTurnIdentity) => void;
  onDiagnostic?: (diagnostic: { code: string; eventType: string }) => void;
}
export interface ClaudeTurnHandle {
  result: Promise<ClaudeTurnResult>;
  interrupt(): Promise<{ confirmed: boolean; sessionId: string | null }>;
}
export class ClaudeCliError extends Error {
  constructor(readonly code: string, message: string, readonly identity: ClaudeTurnIdentity | null = null) {
    super(message);
    this.name = "ClaudeCliError";
  }
}

function validate(config: ClaudeTurnConfig): void {
  if (typeof config.model !== "string" || !/^claude-[a-z0-9][a-z0-9.-]{2,127}$/.test(config.model)) throw new ClaudeCliError("INVALID_INPUT", "A full Claude model ID is required");
  if (typeof config.executable !== "string" || (config.executable !== "claude" && !isAbsolute(config.executable)) || config.executable.includes("\0")) throw new ClaudeCliError("INVALID_INPUT", "Claude executable must be claude or an absolute path");
  if (typeof config.cwd !== "string" || !isAbsolute(config.cwd) || config.cwd.includes("\0")) throw new ClaudeCliError("INVALID_INPUT", "Claude cwd must be absolute");
  if (typeof config.task !== "string" || !config.task.trim() || Buffer.byteLength(config.task) > 65_536) throw new ClaudeCliError("INVALID_INPUT", "Claude task must contain 1 to 65536 bytes");
  if (typeof config.maxBudgetUsd !== "number" || !Number.isFinite(config.maxBudgetUsd) || config.maxBudgetUsd <= 0 || config.maxBudgetUsd > 1000) throw new ClaudeCliError("INVALID_INPUT", "Claude budget must be positive and at most $1000");
}

/** Local version check only. This neither authenticates nor spends provider tokens. */
export async function preflightClaudeTurn(config: ClaudeTurnConfig): Promise<string> {
  validate(config);
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(config.executable, ["--version"], { cwd: config.cwd, timeout: 10_000, maxBuffer: 4096 }));
  } catch { throw new ClaudeCliError("PREFLIGHT_FAILED", "Claude executable version check failed"); }
  if (stdout.trim() !== VERSION) throw new ClaudeCliError("VERSION_MISMATCH", `Claude CLI version must be ${VERSION}`);
  return VERSION;
}

function nonnegativeInt(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error("Invalid Claude token usage");
  return value as number;
}
function nonnegativeCost(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error("Invalid Claude cost");
  return value;
}

export function startClaudeTurn(config: ClaudeTurnConfig, options: ClaudeTurnOptions = {}): ClaudeTurnHandle {
  validate(config);
  const timeoutMs = options.timeoutMs ?? 300_000;
  const maxTextBytes = options.maxTextBytes ?? 262_144;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) throw new ClaudeCliError("INVALID_INPUT", "Claude timeout must be 1..300000 ms");
  if (!Number.isSafeInteger(maxTextBytes) || maxTextBytes < 1 || maxTextBytes > 1_000_000) throw new ClaudeCliError("INVALID_INPUT", "Claude text limit must be 1..1000000 bytes");
  const expectedSessionId = randomUUID();
  let child: ChildProcessWithoutNullStreams | null = null;
  let identity: ClaudeTurnIdentity | null = null;
  let settled = false;
  let closeObserved = false;
  let cancelling = false;
  let cancelResolve: ((result: { confirmed: boolean; sessionId: string | null }) => void) | null = null;
  const resolveCancel = (confirmed: boolean): void => {
    const callback = cancelResolve;
    cancelResolve = null;
    if (callback) callback({ confirmed, sessionId: identity?.sessionId ?? null });
  };
  let streamError: ClaudeCliError | null = null;
  let rejectedEventType = "none";
  let initSeen = false;
  let resultSeen = false;
  let eventCount = 0;
  let streamBytes = 0;
  let stderrBytes = 0;
  let pending = "";
  const decoder = new StringDecoder("utf8");
  let finalText = "";
  let usage: ClaudeTurnResult["usage"] = { inputTokens: null, outputTokens: null, costUsd: null };
  let resolveResult!: (value: ClaudeTurnResult) => void;
  let rejectResult!: (error: ClaudeCliError) => void;
  const result = new Promise<ClaudeTurnResult>((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
  let timer: NodeJS.Timeout | null = null;
  let killTimer: NodeJS.Timeout | null = null;
  const clearTimers = (): void => { if (timer) clearTimeout(timer); if (killTimer) clearTimeout(killTimer); };
  const finishError = (error: ClaudeCliError): void => {
    if (settled) return;
    settled = true;
    clearTimers();
    try { options.onDiagnostic?.({ code: error.code, eventType: rejectedEventType }); }
    catch { /* A diagnostic storage failure must not leave the turn unresolved. */ }
    rejectResult(error);
  };
  const signalOwned = (signal: NodeJS.Signals): void => {
    if (!child || closeObserved) return;
    try {
      if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch { /* Exit is observed separately; failed signalling never confirms cancellation. */ }
  };
  const terminate = (error: ClaudeCliError): void => {
    if (streamError || settled) return;
    streamError = error;
    signalOwned("SIGTERM");
    killTimer = setTimeout(() => {
      signalOwned("SIGKILL");
      // A missing close leaves cancellation uncertain. Do not report success.
      finishError(streamError ?? error);
      resolveCancel(false);
    }, 2_000);
  };
  const parseEvent = (line: string): void => {
    const event = JSON.parse(line) as unknown;
    if (!record(event) || typeof event.type !== "string") throw new Error("Malformed Claude event");
    if (event.type === "system" && event.subtype === "init") {
      if (initSeen || resultSeen || event.session_id !== expectedSessionId || event.model !== config.model || !Array.isArray(event.tools)) throw new Error("Claude init identity mismatch");
      const tools = event.tools;
      if (tools.length !== TOOLS.length || !TOOLS.every(name => tools.includes(name)) || tools.some(name => typeof name !== "string" || !TOOLS.includes(name as typeof TOOLS[number]))) throw new Error("Claude read-only tool list mismatch");
      initSeen = true;
      identity = { sessionId: expectedSessionId, model: config.model, runtimeVersion: VERSION, executable: config.executable, cwd: config.cwd };
      options.onIdentity?.(identity);
      return;
    }
    if (!initSeen) throw new Error("Claude event preceded init");
    if (event.session_id !== undefined && event.session_id !== expectedSessionId) throw new Error("Claude stream changed session ID");
    if (event.model !== undefined && event.model !== config.model) throw new Error("Claude stream changed model");
    if (resultSeen) throw new Error("Claude event followed terminal result");
    if (event.type === "result") {
      if (event.session_id !== expectedSessionId || event.is_error !== false || event.subtype !== "success" || typeof event.result !== "string" ||
        (event.permission_denials !== undefined && (!Array.isArray(event.permission_denials) || event.permission_denials.length > 0))) throw new Error("Claude result denied, failed or changed identity");
      if (Buffer.byteLength(event.result) > maxTextBytes) throw new Error("Claude text exceeded limit");
      const rawUsage = event.usage;
      if (rawUsage !== undefined && !record(rawUsage)) throw new Error("Malformed Claude usage");
      const inputTokens = nonnegativeInt(rawUsage?.input_tokens);
      const outputTokens = nonnegativeInt(rawUsage?.output_tokens);
      const costUsd = nonnegativeCost(event.total_cost_usd);
      usage = { inputTokens, outputTokens, costUsd };
      finalText = event.result;
      resultSeen = true;
      return;
    }
    if (event.type === "assistant") {
      if (!record(event.message) || !Array.isArray(event.message.content)) throw new Error("Malformed Claude assistant message");
      for (const block of event.message.content) {
        if (!record(block) || typeof block.type !== "string") throw new Error("Malformed Claude content");
        if (block.type === "tool_use") {
          if (typeof block.name !== "string" || !TOOLS.includes(block.name as typeof TOOLS[number])) throw new Error("Unexpected Claude tool use");
        } else if (block.type !== "text" && block.type !== "thinking") throw new Error("Unexpected Claude content type");
      }
      return;
    }
    if (event.type === "user") {
      if (record(event.message) && Array.isArray(event.message.content) && event.message.content.some(block => record(block) && block.type === "tool_result" && block.is_error === true)) throw new Error("Claude tool or permission failed");
      return;
    }
    if (event.type === "system") {
      if (typeof event.subtype === "string" && /permission|error|fail|denied/i.test(event.subtype)) throw new Error("Claude system reported a failure");
      return;
    }
    throw new Error("Unexpected Claude event type");
  };
  void (async () => {
    try {
      await preflightClaudeTurn(config);
      if (cancelling) { finishError(new ClaudeCliError("INTERRUPTED", "Claude turn interrupted before launch")); resolveCancel(false); return; }
      const args = ["--print", "--output-format", "stream-json", "--verbose", "--model", config.model,
        "--session-id", expectedSessionId, "--restricted", "--safe-mode", "--strict-mcp-config",
        "--tools", TOOLS.join(","), "--permission-mode", "dontAsk", "--permission-prompts", "none",
        "--max-budget-usd", String(config.maxBudgetUsd)];
      child = spawn(config.executable, args, { cwd: config.cwd, stdio: "pipe", detached: process.platform !== "win32" });
      child.stdout.on("data", (chunk: Buffer) => {
        if (settled || streamError) return;
        streamBytes += chunk.length;
        if (streamBytes > MAX_STREAM_BYTES) { terminate(new ClaudeCliError("OUTPUT_TOO_LARGE", "Claude stream exceeded limit", identity)); return; }
        pending += decoder.write(chunk);
        for (;;) {
          const index = pending.indexOf("\n");
          if (index < 0 || streamError) break;
          const line = pending.slice(0, index);
          pending = pending.slice(index + 1);
          if (Buffer.byteLength(line) > MAX_LINE_BYTES) { terminate(new ClaudeCliError("OUTPUT_TOO_LARGE", "Claude event exceeded limit", identity)); break; }
          if (!line.trim()) continue;
          if (++eventCount > MAX_EVENTS) { terminate(new ClaudeCliError("EVENT_LIMIT", "Claude event count exceeded limit", identity)); break; }
          try { parseEvent(line); }
          catch {
            try {
              const rejected = JSON.parse(line) as unknown;
              if (record(rejected) && typeof rejected.type === "string") {
                const kind = /^[a-z_]{1,48}$/.test(rejected.type) ? rejected.type : "other";
                const subtype = typeof rejected.subtype === "string" && /^[a-z_]{1,48}$/.test(rejected.subtype) ? rejected.subtype : "none";
                rejectedEventType = `${kind}/${subtype}`;
              } else rejectedEventType = "malformed";
            } catch { rejectedEventType = "malformed"; }
            terminate(new ClaudeCliError("PROTOCOL_ERROR", "Malformed or unsafe Claude stream event", identity));
          }
        }
        if (!streamError && Buffer.byteLength(pending) > MAX_LINE_BYTES) terminate(new ClaudeCliError("OUTPUT_TOO_LARGE", "Claude event exceeded limit", identity));
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderrBytes += chunk.length;
        if (stderrBytes > MAX_STDERR_BYTES) terminate(new ClaudeCliError("OUTPUT_TOO_LARGE", "Claude diagnostic stream exceeded limit", identity));
      });
      child.once("error", () => terminate(new ClaudeCliError("CHILD_LOST", "Claude process failed to start", identity)));
      child.once("close", (code, signal) => {
        closeObserved = true;
        clearTimers();
        resolveCancel(cancelling && identity !== null);
        if (settled) return;
        if (streamError) { finishError(streamError); return; }
        if (cancelling) { finishError(new ClaudeCliError("INTERRUPTED", "Claude turn was interrupted", identity)); return; }
        if (pending.trim()) { finishError(new ClaudeCliError("PROTOCOL_ERROR", "Incomplete Claude event stream", identity)); return; }
        if (code !== 0 || signal) { finishError(new ClaudeCliError("RUNTIME_FAILED", "Claude process exited unsuccessfully or permission was denied", identity)); return; }
        if (!identity || !resultSeen) { finishError(new ClaudeCliError("PROTOCOL_ERROR", "Claude omitted init or terminal result", identity)); return; }
        settled = true;
        resolveResult({ identity, text: finalText, usage });
      });
      timer = setTimeout(() => terminate(new ClaudeCliError("TIMEOUT", "Claude turn exceeded its timeout", identity)), timeoutMs);
      child.stdin.end(config.task, "utf8");
    } catch (error) {
      finishError(error instanceof ClaudeCliError ? error : new ClaudeCliError("PREFLIGHT_FAILED", "Claude launch preflight failed"));
      resolveCancel(false);
    }
  })();
  const interrupt = (): Promise<{ confirmed: boolean; sessionId: string | null }> => {
    if (closeObserved || settled) return Promise.resolve({ confirmed: false, sessionId: identity?.sessionId ?? null });
    if (cancelResolve) return new Promise(resolve => { const previous = cancelResolve; cancelResolve = value => { previous?.(value); resolve(value); }; });
    cancelling = true;
    const confirmation = new Promise<{ confirmed: boolean; sessionId: string | null }>(resolve => { cancelResolve = resolve; });
    if (child) terminate(new ClaudeCliError("INTERRUPTED", "Claude turn interrupted", identity));
    return confirmation;
  };
  return { result, interrupt };
}
