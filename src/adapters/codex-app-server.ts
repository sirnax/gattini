/** A single-turn, read-only Codex app-server client for the installed 0.157.1 stdio protocol. */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { isAbsolute } from "node:path";
import { StringDecoder } from "node:string_decoder";

type RecordValue = Record<string, unknown>;
export type CodexReviewStatus = "completed" | "failed" | "interrupted";
export interface CodexReviewIdentity {
  threadId: string;
  sessionId: string;
  turnId: string;
  cliVersion: string;
  model: string;
  modelProvider: string;
}
export interface CodexReviewUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  cachedInputTokens: number | null;
  totalTokens: number | null;
  cost: null;
}
export interface CodexReviewResult {
  identity: CodexReviewIdentity;
  status: CodexReviewStatus;
  text: string;
  usage: CodexReviewUsage;
  deniedRequests: number;
}
export interface CodexInterruptResult {
  confirmed: boolean;
  identity: CodexReviewIdentity | null;
  terminalStatus: CodexReviewStatus | null;
}
export interface CodexReviewInput {
  model: string;
  modelProvider: string;
  cwd: string;
  task: string;
  executable?: string;
}
export interface CodexReviewOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  maxMessageBytes?: number;
  maxTextBytes?: number;
  maxEvents?: number;
  onIdentity?: (identity: CodexReviewIdentity) => void;
  spawn?: (executable: string, args: string[], options: { cwd: string; stdio: "pipe" }) => ChildProcessWithoutNullStreams;
}
export interface CodexReviewHandle {
  result: Promise<CodexReviewResult>;
  interrupt(): Promise<CodexInterruptResult>;
}
export class CodexAppServerError extends Error {
  constructor(readonly code: string, message: string, readonly identity: CodexReviewIdentity | null = null) {
    super(message);
    this.name = "CodexAppServerError";
  }
}
const record = (value: unknown): value is RecordValue => typeof value === "object" && value !== null && !Array.isArray(value);
const str = (value: unknown, name: string): string => {
  if (typeof value !== "string" || value.length === 0 || value.length > 512) throw new Error(`Invalid ${name}`);
  return value;
};
const positiveInt = (value: number | undefined, fallback: number, max: number, name: string): number => {
  const n = value ?? fallback;
  if (!Number.isInteger(n) || n < 1 || n > max) throw new CodexAppServerError("INVALID_INPUT", `Invalid ${name}`);
  return n;
};
export function preflightCodexReview(input: CodexReviewInput): void {
  try { str(input.model, "model"); str(input.modelProvider, "modelProvider"); }
  catch { throw new CodexAppServerError("INVALID_INPUT", "Explicit model and modelProvider are required"); }
  if (typeof input.cwd !== "string" || !isAbsolute(input.cwd) || input.cwd.includes("\0")) throw new CodexAppServerError("INVALID_INPUT", "cwd must be absolute");
  if (typeof input.task !== "string" || input.task.trim() === "" || Buffer.byteLength(input.task) > 65_536) throw new CodexAppServerError("INVALID_INPUT", "task must contain 1 to 65536 bytes");
  if (input.executable !== undefined) {
    try { str(input.executable, "executable"); }
    catch { throw new CodexAppServerError("INVALID_INPUT", "Invalid executable"); }
  }
}

export function startCodexReview(input: CodexReviewInput, options: CodexReviewOptions = {}): CodexReviewHandle {
  preflightCodexReview(input);
  const timeoutMs = positiveInt(options.timeoutMs, 300_000, 300_000, "timeoutMs");
  const maxMessageBytes = positiveInt(options.maxMessageBytes, 1_000_000, 4_000_000, "maxMessageBytes");
  const maxTextBytes = positiveInt(options.maxTextBytes, 262_144, 1_000_000, "maxTextBytes");
  const maxEvents = positiveInt(options.maxEvents, 10_000, 100_000, "maxEvents");
  const child = (options.spawn ?? ((executable, args, spawnOptions) => spawn(executable, args, spawnOptions)))(input.executable ?? "codex", ["app-server", "--listen", "stdio://"], { cwd: input.cwd, stdio: "pipe" });
  const decoder = new StringDecoder("utf8");
  let buffer = "";
  let stderrBytes = 0;
  let nextId = 1;
  let eventCount = 0;
  let identity: CodexReviewIdentity | null = null;
  let terminal: CodexReviewStatus | null = null;
  let text = "";
  let usage: CodexReviewUsage = { inputTokens: null, outputTokens: null, cachedInputTokens: null, totalTokens: null, cost: null };
  let deniedRequests = 0;
  const earlyEvents: RecordValue[] = [];
  let settled = false;
  let interruptRequested = false;
  let interruptResolve: ((value: CodexInterruptResult) => void) | null = null;
  let interruptGraceTimer: NodeJS.Timeout | null = null;
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  let resolveResult!: (value: CodexReviewResult) => void;
  let rejectResult!: (error: Error) => void;
  const result = new Promise<CodexReviewResult>((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
  const interruptResult = (): CodexInterruptResult => ({ confirmed: terminal === "interrupted", identity, terminalStatus: terminal });
  const cleanup = (): void => {
    clearTimeout(timer);
    if (interruptGraceTimer) clearTimeout(interruptGraceTimer);
    options.signal?.removeEventListener("abort", onAbort);
    for (const request of pending.values()) request.reject(new CodexAppServerError("CLOSED", "Codex app-server closed", identity));
    pending.clear();
    child.stdout.removeAllListeners();
    child.stderr.removeAllListeners();
    child.removeAllListeners();
    child.kill();
  };
  const fail = (code: string, message: string): void => {
    if (settled) return;
    settled = true;
    if (interruptResolve) interruptResolve(interruptResult());
    rejectResult(new CodexAppServerError(code, message, identity));
    cleanup();
  };
  const finish = (status: CodexReviewStatus): void => {
    if (settled || !identity) return;
    terminal = status;
    settled = true;
    if (interruptResolve) interruptResolve(interruptResult());
    resolveResult({ identity, status, text, usage, deniedRequests });
    cleanup();
  };
  const write = (message: RecordValue): void => {
    if (settled) return;
    const line = JSON.stringify(message) + "\n";
    if (Buffer.byteLength(line) > maxMessageBytes) { fail("MESSAGE_TOO_LARGE", "Outbound Codex message too large"); return; }
    child.stdin.write(line, (error) => { if (error) fail("CHILD_LOST", "Codex app-server stdin failed"); });
  };
  const request = (method: string, params: RecordValue): Promise<unknown> => {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      write({ id, method, params });
    });
  };
  const parseTurn = (value: unknown, expectedId?: string): { id: string; status: string } => {
    if (!record(value)) throw new Error("Malformed turn");
    const id = str(value.id, "turn.id");
    if (expectedId && id !== expectedId) throw new Error("Turn ID mismatch");
    const status = str(value.status, "turn.status");
    if (!["inProgress", "completed", "failed", "interrupted"].includes(status)) throw new Error("Invalid turn status");
    return { id, status };
  };
  const handleMessage = (message: unknown): void => {
    if (!record(message)) throw new Error("Malformed Codex message");
    if ("id" in message && !record(message.params) && ("result" in message || "error" in message)) {
      const id = message.id;
      if (typeof id !== "number" || !Number.isInteger(id)) throw new Error("Invalid response ID");
      const waiting = pending.get(id);
      if (!waiting) throw new Error("Unmatched response ID");
      pending.delete(id);
      if ("error" in message) waiting.reject(new CodexAppServerError("RPC_ERROR", "Codex app-server request failed", identity));
      else waiting.resolve(message.result);
      return;
    }
    const method = str(message.method, "method");
    if ("id" in message) {
      const id = message.id;
      if (typeof id !== "number" && typeof id !== "string") throw new Error("Invalid server request ID");
      if (method === "item/commandExecution/requestApproval" || method === "item/fileChange/requestApproval") {
        deniedRequests++;
        write({ id, result: { decision: "decline" } });
      } else if (method === "execCommandApproval" || method === "applyPatchApproval") {
        deniedRequests++;
        write({ id, result: { decision: { denied: { rejection: "Read-only Gattini job" } } } });
      } else {
        deniedRequests++;
        write({ id, error: { code: -32603, message: "Denied by Gattini read-only policy" } });
        fail("UNEXPECTED_REQUEST", `Unexpected Codex request: ${method}`);
      }
      return;
    }
    if (!record(message.params)) return;
    const params = message.params;
    if (method === "model/rerouted") {
      fail("MODEL_REROUTED", "Codex model rerouted");
      return;
    }
    if (!identity && ["item/completed", "thread/tokenUsage/updated", "turn/completed"].includes(method)) {
      if (earlyEvents.length >= 16) throw new Error("Too many early events");
      earlyEvents.push(message);
      return;
    }
    if (method === "item/completed" && identity && params.threadId === identity.threadId && params.turnId === identity.turnId && record(params.item) && params.item.type === "agentMessage") {
      const item = params.item;
      if (typeof item.text !== "string") throw new Error("Malformed agent text");
      if (Buffer.byteLength(text) + Buffer.byteLength(item.text) > maxTextBytes) { fail("TEXT_TOO_LARGE", "Codex assistant text exceeded limit"); return; }
      text += item.text;
      return;
    }
    if (method === "thread/tokenUsage/updated" && identity && params.threadId === identity.threadId && params.turnId === identity.turnId) {
      const totals = record(params.tokenUsage) && params.tokenUsage.last;
      if (!record(totals)) throw new Error("Malformed token usage");
      const tokens = [totals.inputTokens, totals.outputTokens, totals.cachedInputTokens, totals.totalTokens];
      if (!tokens.every((n) => Number.isSafeInteger(n) && (n as number) >= 0)) throw new Error("Malformed token usage");
      usage = { inputTokens: tokens[0] as number, outputTokens: tokens[1] as number, cachedInputTokens: tokens[2] as number, totalTokens: tokens[3] as number, cost: null };
      return;
    }
    if (method === "turn/completed" && identity) {
      if (params.threadId !== identity.threadId) return;
      const turn = parseTurn(params.turn, identity.turnId);
      if (turn.status === "inProgress") throw new Error("Nonterminal turn completion");
      finish(turn.status as CodexReviewStatus);
    }
  };
  child.stdout.on("data", (chunk: Buffer) => {
    if (settled) return;
    buffer += decoder.write(chunk);
    if (Buffer.byteLength(buffer) > maxMessageBytes) { fail("MESSAGE_TOO_LARGE", "Codex message exceeded limit"); return; }
    for (;;) {
      const index = buffer.indexOf("\n");
      if (index < 0 || settled) break;
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (Buffer.byteLength(line) > maxMessageBytes) { fail("MESSAGE_TOO_LARGE", "Codex message exceeded limit"); break; }
      if (++eventCount > maxEvents) { fail("EVENT_LIMIT", "Codex event limit exceeded"); break; }
      try { handleMessage(JSON.parse(line) as unknown); }
      catch { fail("MALFORMED_MESSAGE", "Malformed Codex app-server message"); }
    }
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderrBytes += chunk.length;
    if (stderrBytes > maxMessageBytes) fail("MESSAGE_TOO_LARGE", "Codex diagnostic stream exceeded limit");
  });
  child.on("error", () => fail("CHILD_LOST", "Codex app-server failed to start"));
  child.on("close", () => fail("CHILD_LOST", "Codex app-server exited before terminal confirmation"));
  const onAbort = (): void => { void interrupt(); };
  options.signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => fail("TIMEOUT", "Codex app-server timed out"), timeoutMs);
  const interrupt = (): Promise<CodexInterruptResult> => {
    if (terminal || settled || !identity) return Promise.resolve(interruptResult());
    if (interruptRequested) return new Promise((resolve) => { const previous = interruptResolve; interruptResolve = (value) => { previous?.(value); resolve(value); }; });
    interruptRequested = true;
    const confirmation = new Promise<CodexInterruptResult>((resolve) => { interruptResolve = resolve; });
    void request("turn/interrupt", { threadId: identity.threadId, turnId: identity.turnId }).catch(() => {
      if (settled) return;
      // The runtime can reject the RPC while an exact interrupted-turn
      // notification is still in flight. Keep the child alive briefly so that
      // notification can establish the terminal outcome; the RPC error itself
      // never confirms cancellation.
      interruptGraceTimer = setTimeout(() => fail("INTERRUPT_FAILED", "Codex interrupt request failed without terminal confirmation"), 1_000);
    });
    return confirmation;
  };
  void (async () => {
    try {
      await request("initialize", { clientInfo: { name: "gattini", title: "Gattini", version: "0.0.0" }, capabilities: null });
      write({ method: "initialized" });
      const started = await request("thread/start", { model: input.model, modelProvider: input.modelProvider, cwd: input.cwd, sandbox: "read-only", approvalPolicy: "on-request", approvalsReviewer: "user" });
      if (!record(started) || !record(started.thread)) throw new Error("Malformed thread/start response");
      const thread = started.thread;
      const threadId = str(thread.id, "thread.id");
      const sessionId = str(thread.sessionId, "thread.sessionId");
      const cliVersion = str(thread.cliVersion, "thread.cliVersion");
      if (cliVersion !== "0.157.1") throw new CodexAppServerError("VERSION_MISMATCH", "Codex app-server protocol version differs from 0.157.1");
      if (started.model !== input.model || started.modelProvider !== input.modelProvider || thread.model !== input.model || thread.modelProvider !== input.modelProvider || started.cwd !== input.cwd || thread.cwd !== input.cwd || started.approvalPolicy !== "on-request" || started.approvalsReviewer !== "user" || !record(started.sandbox) || started.sandbox.type !== "readOnly" || started.sandbox.networkAccess !== false) throw new CodexAppServerError("IDENTITY_MISMATCH", "Codex thread identity or read-only policy differed from request");
      const turnStarted = await request("turn/start", { threadId, input: [{ type: "text", text: input.task, text_elements: [] }] });
      if (!record(turnStarted)) throw new Error("Malformed turn/start response");
      const turn = parseTurn(turnStarted.turn);
      if (turn.status !== "inProgress") throw new Error("Turn did not start in progress");
      identity = { threadId, sessionId, turnId: turn.id, cliVersion, model: input.model, modelProvider: input.modelProvider };
      options.onIdentity?.(identity);
      for (const event of earlyEvents) handleMessage(event);
      earlyEvents.length = 0;
      if (options.signal?.aborted) void interrupt();
    } catch (error) {
      if (settled) return;
      if (error instanceof CodexAppServerError) fail(error.code, error.message);
      else fail("PROTOCOL_ERROR", "Codex app-server handshake failed");
    }
  })();
  return { result, interrupt };
}

export interface CodexTurnStatusInput {
  threadId: string;
  turnId: string;
  cwd: string;
  executable?: string;
}

/** Read a persisted turn through a new, bounded app-server connection. Never resumes it. */
export function readCodexTurnStatus(
  input: CodexTurnStatusInput,
  options: Pick<CodexReviewOptions, "timeoutMs" | "maxMessageBytes" | "maxEvents" | "spawn"> = {},
): Promise<CodexReviewStatus | null> {
  try { str(input.threadId, "threadId"); str(input.turnId, "turnId"); }
  catch { throw new CodexAppServerError("INVALID_INPUT", "Exact thread and turn IDs are required"); }
  if (typeof input.cwd !== "string" || !isAbsolute(input.cwd) || input.cwd.includes("\0")) throw new CodexAppServerError("INVALID_INPUT", "cwd must be absolute");
  if (input.executable !== undefined) {
    try { str(input.executable, "executable"); }
    catch { throw new CodexAppServerError("INVALID_INPUT", "Invalid executable"); }
  }
  const timeoutMs = positiveInt(options.timeoutMs, 10_000, 30_000, "timeoutMs");
  const maxMessageBytes = positiveInt(options.maxMessageBytes, 1_000_000, 4_000_000, "maxMessageBytes");
  const maxEvents = positiveInt(options.maxEvents, 1_000, 10_000, "maxEvents");
  const child = (options.spawn ?? ((executable, args, spawnOptions) => spawn(executable, args, spawnOptions)))(input.executable ?? "codex", ["app-server", "--listen", "stdio://"], { cwd: input.cwd, stdio: "pipe" });
  const decoder = new StringDecoder("utf8");
  let buffer = "";
  let eventCount = 0;
  let stderrBytes = 0;
  let nextId = 1;
  let settled = false;
  let waiting: { id: number; resolve: (value: unknown) => void; reject: (error: Error) => void } | null = null;
  let resolveResult!: (value: CodexReviewStatus | null) => void;
  let rejectResult!: (error: Error) => void;
  const result = new Promise<CodexReviewStatus | null>((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
  const cleanup = (): void => {
    clearTimeout(timer);
    if (waiting) waiting.reject(new CodexAppServerError("CLOSED", "Codex app-server closed"));
    waiting = null;
    child.stdout.removeAllListeners();
    child.stderr.removeAllListeners();
    child.removeAllListeners();
    child.kill();
  };
  const fail = (code: string, message: string): void => {
    if (settled) return;
    settled = true;
    rejectResult(new CodexAppServerError(code, message));
    cleanup();
  };
  const finish = (status: CodexReviewStatus | null): void => {
    if (settled) return;
    settled = true;
    resolveResult(status);
    cleanup();
  };
  const request = (method: string, params: RecordValue): Promise<unknown> => {
    if (waiting) return Promise.reject(new CodexAppServerError("PROTOCOL_ERROR", "Concurrent status request"));
    const id = nextId++;
    return new Promise((resolve, reject) => {
      waiting = { id, resolve, reject };
      const line = JSON.stringify({ id, method, params }) + "\n";
      if (Buffer.byteLength(line) > maxMessageBytes) { fail("MESSAGE_TOO_LARGE", "Outbound Codex message too large"); return; }
      child.stdin.write(line, error => { if (error) fail("CHILD_LOST", "Codex app-server stdin failed"); });
    });
  };
  child.stdout.on("data", (chunk: Buffer) => {
    if (settled) return;
    buffer += decoder.write(chunk);
    if (Buffer.byteLength(buffer) > maxMessageBytes) { fail("MESSAGE_TOO_LARGE", "Codex status message exceeded limit"); return; }
    for (;;) {
      const index = buffer.indexOf("\n");
      if (index < 0 || settled) break;
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (Buffer.byteLength(line) > maxMessageBytes) { fail("MESSAGE_TOO_LARGE", "Codex status message exceeded limit"); break; }
      if (++eventCount > maxEvents) { fail("EVENT_LIMIT", "Codex status event limit exceeded"); break; }
      try {
        const message = JSON.parse(line) as unknown;
        if (!record(message)) throw new Error("Malformed response");
        if ("id" in message && ("result" in message || "error" in message)) {
          if (!waiting || message.id !== waiting.id) throw new Error("Unmatched response ID");
          const request = waiting;
          waiting = null;
          if ("error" in message) request.reject(new CodexAppServerError("RPC_ERROR", "Codex status request failed"));
          else request.resolve(message.result);
        } else if ("id" in message) {
          // Status lookup has no reason to approve or answer server requests.
          fail("UNEXPECTED_REQUEST", "Unexpected Codex request during status lookup");
        }
      } catch { fail("MALFORMED_MESSAGE", "Malformed Codex status message"); }
    }
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderrBytes += chunk.length;
    if (stderrBytes > maxMessageBytes) fail("MESSAGE_TOO_LARGE", "Codex status diagnostic stream exceeded limit");
  });
  child.on("error", () => fail("CHILD_LOST", "Codex app-server failed to start"));
  child.on("close", () => fail("CHILD_LOST", "Codex app-server exited before status reply"));
  const timer = setTimeout(() => fail("TIMEOUT", "Codex turn status lookup timed out"), timeoutMs);
  void (async () => {
    try {
      await request("initialize", { clientInfo: { name: "gattini", title: "Gattini", version: "0.0.0" }, capabilities: null });
      child.stdin.write(JSON.stringify({ method: "initialized" }) + "\n", error => { if (error) fail("CHILD_LOST", "Codex app-server stdin failed"); });
      const cursors = new Set<string>();
      let cursor: string | null = null;
      for (let page = 0; page < 4; page += 1) {
        const response = await request("thread/turns/list", { threadId: input.threadId, limit: 50, sortDirection: "desc", ...(cursor ? { cursor } : {}) });
        if (!record(response) || !Array.isArray(response.data) || !(response.nextCursor === null || typeof response.nextCursor === "string")) throw new Error("Malformed turn list");
        let found: CodexReviewStatus | null = null;
        for (const value of response.data) {
          if (!record(value)) throw new Error("Malformed turn");
          const id = str(value.id, "turn.id");
          const status = str(value.status, "turn.status");
          if (!["inProgress", "completed", "failed", "interrupted"].includes(status)) throw new Error("Invalid turn status");
          if (id === input.turnId) {
            if (found !== null) throw new Error("Duplicate turn ID");
            found = status === "inProgress" ? null : status as CodexReviewStatus;
            if (status === "inProgress") { finish(null); return; }
          }
        }
        if (found) { finish(found); return; }
        if (response.nextCursor === null) { finish(null); return; }
        if (response.nextCursor.length === 0 || cursors.has(response.nextCursor)) throw new Error("Invalid turn cursor");
        cursor = response.nextCursor;
        cursors.add(cursor);
      }
      finish(null);
    } catch (error) {
      if (settled) return;
      if (error instanceof CodexAppServerError) fail(error.code, error.message);
      else fail("PROTOCOL_ERROR", "Codex turn status lookup failed");
    }
  })();
  return result;
}
