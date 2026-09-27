import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { CodexAppServerError, preflightCodexReview, readCodexTurnStatus, startCodexReview, type CodexReviewInput } from "../src/adapters/codex-app-server.js";

const input: CodexReviewInput = { model: "gpt-6-sol", modelProvider: "openai", cwd: "/tmp", task: "Review this fixture" };
const thread = { id: "thread-1", sessionId: "session-1", cliVersion: "0.157.1", model: input.model, modelProvider: input.modelProvider, cwd: input.cwd };
const start = { thread, model: input.model, modelProvider: input.modelProvider, cwd: input.cwd, approvalPolicy: "on-request", approvalsReviewer: "user", sandbox: { type: "readOnly", networkAccess: false } };
const terminal = (status: string) => ({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status } } });
type Message = Record<string, unknown>;
class MockServer extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin = new PassThrough();
  readonly sent: Message[] = [];
  private inbound = "";
  constructor(readonly onRequest: (message: Message, server: MockServer) => void = defaultReply) {
    super();
    this.stdin.on("data", (data: Buffer) => {
      this.inbound += data.toString();
      let index: number;
      while ((index = this.inbound.indexOf("\n")) >= 0) {
        const message = JSON.parse(this.inbound.slice(0, index)) as Message;
        this.inbound = this.inbound.slice(index + 1);
        this.sent.push(message);
        this.onRequest(message, this);
      }
    });
  }
  emitMessage(message: Message): void { this.stdout.write(JSON.stringify(message) + "\n"); }
  reply(message: Message, result: unknown): void { this.emitMessage({ id: message.id, result }); }
  kill(): boolean { return true; }
  lose(): void { this.emit("close", 1, null); }
  child(): ChildProcessWithoutNullStreams { return this as unknown as ChildProcessWithoutNullStreams; }
}
function defaultReply(message: Message, server: MockServer): void {
  if (message.method === "initialize") server.reply(message, { userAgent: "codex" });
  if (message.method === "thread/start") server.reply(message, start);
  if (message.method === "turn/start") server.reply(message, { turn: { id: "turn-1", status: "inProgress" } });
  if (message.method === "turn/interrupt") { server.reply(message, {}); server.emitMessage(terminal("interrupted")); }
}
const options = (server: MockServer) => ({ spawn: () => server.child(), timeoutMs: 500 });
const errorCode = (code: string) => (error: unknown): boolean => error instanceof CodexAppServerError && error.code === code;

 test("preflight rejects missing explicit identity", () => {
  assert.throws(() => preflightCodexReview({ ...input, cwd: "relative" }));
  assert.throws(() => preflightCodexReview({ ...input, task: "" }));
 });
 test("run pins identity and collects bounded text and usage", async () => {
  const server = new MockServer();
  let observed: unknown;
  const handle = startCodexReview(input, { ...options(server), onIdentity: (identity) => { observed = identity; queueMicrotask(() => {
    server.emitMessage({ method: "item/completed", params: { threadId: "thread-1", turnId: "turn-1", item: { type: "agentMessage", text: "Review complete" } } });
    server.emitMessage({ method: "thread/tokenUsage/updated", params: { threadId: "thread-1", turnId: "turn-1", tokenUsage: { last: { inputTokens: 4, outputTokens: 5, cachedInputTokens: 1, totalTokens: 9 } } } });
    server.emitMessage(terminal("completed"));
  }); } });
  const result = await handle.result;
  assert.deepEqual(observed, result.identity);
  assert.equal(result.identity.sessionId, "session-1");
  assert.equal(result.text, "Review complete");
  assert.deepEqual(result.usage, { inputTokens: 4, outputTokens: 5, cachedInputTokens: 1, totalTokens: 9, cost: null });
  const threadRequest = server.sent.find((message) => message.method === "thread/start");
  assert.deepEqual(threadRequest?.params, { model: input.model, modelProvider: input.modelProvider, cwd: input.cwd, sandbox: "read-only", approvalPolicy: "on-request", approvalsReviewer: "user" });
 });
 test("rejects identity mismatch, version mismatch, reroute, malformed and oversized frames", async () => {
  for (const [caseName, override, code] of [
    ["model", { model: "other" }, "IDENTITY_MISMATCH"],
    ["sandbox", { sandbox: { type: "workspaceWrite" } }, "IDENTITY_MISMATCH"],
    ["version", { thread: { ...thread, cliVersion: "0.158.0" } }, "VERSION_MISMATCH"],
  ] as const) {
    const server = new MockServer((message, mock) => {
      if (message.method === "thread/start") mock.reply(message, { ...start, ...override });
      else defaultReply(message, mock);
    });
    await assert.rejects(startCodexReview(input, options(server)).result, errorCode(code), caseName);
  }
  const reroute = new MockServer();
  await assert.rejects(startCodexReview(input, { ...options(reroute), onIdentity: () => queueMicrotask(() => reroute.emitMessage({ method: "model/rerouted", params: { threadId: "thread-1", turnId: "turn-1", fromModel: input.model, toModel: "other" } })) }).result, errorCode("MODEL_REROUTED"));
  const malformed = new MockServer();
  await assert.rejects(startCodexReview(input, { ...options(malformed), onIdentity: () => queueMicrotask(() => malformed.stdout.write("{bad}\n")) }).result, errorCode("MALFORMED_MESSAGE"));
  const oversized = new MockServer();
  await assert.rejects(startCodexReview(input, { ...options(oversized), maxMessageBytes: 1024, onIdentity: () => queueMicrotask(() => oversized.stdout.write("x".repeat(1025))) }).result, errorCode("MESSAGE_TOO_LARGE"));
 });
 test("denies approval families and fails closed on unexpected requests", async () => {
  const server = new MockServer();
  const handle = startCodexReview(input, { ...options(server), onIdentity: () => queueMicrotask(() => {
    for (const method of ["item/commandExecution/requestApproval", "item/fileChange/requestApproval", "execCommandApproval", "applyPatchApproval"]) server.emitMessage({ id: method, method, params: {} });
    setImmediate(() => server.emitMessage(terminal("completed")));
  }) });
  const result = await handle.result;
  assert.equal(result.deniedRequests, 4);
  const answers = server.sent.filter((m) => typeof m.id === "string");
  assert.equal(answers.length, 4);
  assert(answers.every((m) => m.error || JSON.stringify(m.result).includes("decline") || JSON.stringify(m.result).includes("denied")));
  for (const method of ["item/permissions/requestApproval", "mcpServer/elicitation/request", "item/tool/call"]) {
    const unknown = new MockServer();
    await assert.rejects(startCodexReview(input, { ...options(unknown), onIdentity: () => queueMicrotask(() => unknown.emitMessage({ id: "bad", method, params: {} })) }).result, errorCode("UNEXPECTED_REQUEST"));
    assert.equal(unknown.sent.find((message) => message.id === "bad")?.error !== undefined, true);
  }
 });
 test("interrupt requires exact IDs and terminal interrupted confirmation", async () => {
  const server = new MockServer();
  let confirmation!: Promise<unknown>;
  const handle = startCodexReview(input, { ...options(server), onIdentity: () => { confirmation = handle.interrupt(); } });
  const [result, cancelled] = await Promise.all([handle.result, new Promise((resolve) => setImmediate(() => resolve(confirmation))).then((p) => p)]);
  assert.equal(result.status, "interrupted");
  assert.deepEqual(cancelled, { confirmed: true, identity: result.identity, terminalStatus: "interrupted" });
  assert.deepEqual(server.sent.find((m) => m.method === "turn/interrupt")?.params, { threadId: "thread-1", turnId: "turn-1" });
  const noTerminal = new MockServer((message, mock) => {
    if (message.method === "turn/interrupt") mock.reply(message, {});
    else defaultReply(message, mock);
  });
  let unconfirmed!: Promise<unknown>;
  const pending = startCodexReview(input, { ...options(noTerminal), onIdentity: () => { unconfirmed = pending.interrupt(); setImmediate(() => noTerminal.lose()); } });
  await assert.rejects(pending.result, errorCode("CHILD_LOST"));
  assert.deepEqual(await unconfirmed, { confirmed: false, identity: { threadId: "thread-1", sessionId: "session-1", turnId: "turn-1", cliVersion: "0.157.1", model: input.model, modelProvider: input.modelProvider }, terminalStatus: null });
 });
 test("interrupt RPC error allows a delayed exact terminal confirmation", async () => {
  const server = new MockServer((message, mock) => {
    if (message.method === "turn/interrupt") {
      mock.emitMessage({ id: message.id, error: { code: -32000, message: "Turn already stopping" } });
      setTimeout(() => mock.emitMessage(terminal("interrupted")), 25);
    } else defaultReply(message, mock);
  });
  let confirmation!: Promise<unknown>;
  const handle = startCodexReview(input, { ...options(server), onIdentity: () => { confirmation = handle.interrupt(); } });
  const result = await handle.result;
  assert.equal(result.status, "interrupted");
  assert.deepEqual(await confirmation, { confirmed: true, identity: result.identity, terminalStatus: "interrupted" });
  assert.deepEqual(server.sent.find(message => message.method === "turn/interrupt")?.params,
    { threadId: "thread-1", turnId: "turn-1" });
 });
 test("interrupt RPC error without exact confirmation remains uncertain", async () => {
  for (const [kind, expected] of [["missing", "INTERRUPT_FAILED"], ["wrong-turn", "MALFORMED_MESSAGE"], ["child-loss", "CHILD_LOST"]] as const) {
    const server = new MockServer((message, mock) => {
      if (message.method === "turn/interrupt") {
        mock.emitMessage({ id: message.id, error: { code: -32000, message: "Turn already stopping" } });
        if (kind === "wrong-turn") setTimeout(() => mock.emitMessage({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "wrong-turn", status: "interrupted" } } }), 20);
        if (kind === "child-loss") setTimeout(() => mock.lose(), 20);
      } else defaultReply(message, mock);
    });
    let confirmation!: Promise<unknown>;
    const handle = startCodexReview(input, { ...options(server), timeoutMs: 2_000, onIdentity: () => { confirmation = handle.interrupt(); } });
    await assert.rejects(handle.result, errorCode(expected), kind);
    assert.deepEqual(await confirmation, { confirmed: false, identity: { threadId: "thread-1", sessionId: "session-1", turnId: "turn-1", cliVersion: "0.157.1", model: input.model, modelProvider: input.modelProvider }, terminalStatus: null }, kind);
  }
 });
 test("timeout and child loss remain uncertain", async () => {
  const timeout = new MockServer((message, mock) => { if (message.method === "initialize") mock.reply(message, {}); });
  await assert.rejects(startCodexReview(input, { ...options(timeout), timeoutMs: 20 }).result, errorCode("TIMEOUT"));
  const loss = new MockServer();
  await assert.rejects(startCodexReview(input, { ...options(loss), onIdentity: () => queueMicrotask(() => loss.lose()) }).result, errorCode("CHILD_LOST"));
 });
 test("bounds assistant text and notification count", async () => {
  const textServer = new MockServer();
  await assert.rejects(startCodexReview(input, { ...options(textServer), maxTextBytes: 3, onIdentity: () => queueMicrotask(() => textServer.emitMessage({ method: "item/completed", params: { threadId: "thread-1", turnId: "turn-1", item: { type: "agentMessage", text: "long" } } })) }).result, errorCode("TEXT_TOO_LARGE"));
  const eventServer = new MockServer();
  await assert.rejects(startCodexReview(input, { ...options(eventServer), maxEvents: 4, onIdentity: () => queueMicrotask(() => {
    for (let i = 0; i < 5; i++) eventServer.emitMessage({ method: "warning", params: {} });
  }) }).result, errorCode("EVENT_LIMIT"));
 });
 test("accepts exact terminal notification delivered before turn response", async () => {
  const server = new MockServer((message, mock) => {
    if (message.method === "turn/start") { mock.emitMessage(terminal("completed")); mock.reply(message, { turn: { id: "turn-1", status: "inProgress" } }); }
    else defaultReply(message, mock);
  });
  const result = await startCodexReview(input, options(server)).result;
  assert.equal(result.status, "completed");
  assert.equal(result.usage.inputTokens, null);
 });
 test("read-only turn lookup confirms only the exact persisted interrupted turn", async () => {
  const server = new MockServer((message, mock) => {
    if (message.method === "thread/turns/list") mock.reply(message, { data: [{ id: "another-turn", status: "completed" }, { id: "turn-1", status: "interrupted" }], nextCursor: null });
    else defaultReply(message, mock);
  });
  const status = await readCodexTurnStatus({ threadId: "thread-1", turnId: "turn-1", cwd: "/tmp" }, { ...options(server), timeoutMs: 1_000 });
  assert.equal(status, "interrupted");
  assert.deepEqual(server.sent.find(message => message.method === "thread/turns/list")?.params,
    { threadId: "thread-1", limit: 50, sortDirection: "desc" });
  assert.equal(server.sent.some(message => message.method === "thread/start" || message.method === "turn/start" || message.method === "thread/resume"), false);
 });
 test("turn lookup reports wrong or in-progress ID as unconfirmed", async () => {
  for (const turn of [{ id: "other-turn", status: "interrupted" }, { id: "turn-1", status: "inProgress" }]) {
    const server = new MockServer((message, mock) => {
      if (message.method === "thread/turns/list") mock.reply(message, { data: [turn], nextCursor: null });
      else defaultReply(message, mock);
    });
    assert.equal(await readCodexTurnStatus({ threadId: "thread-1", turnId: "turn-1", cwd: "/tmp" }, { ...options(server), timeoutMs: 1_000 }), null);
  }
 });
 test("turn lookup rejects malformed responses, RPC errors and timeouts", async () => {
  for (const [reply, expected] of [
    [{ data: [{ status: "interrupted" }], nextCursor: null }, "PROTOCOL_ERROR"],
    [{ data: [{ id: "turn-1", status: "bogus" }], nextCursor: null }, "PROTOCOL_ERROR"],
    [{ data: "invalid", nextCursor: null }, "PROTOCOL_ERROR"],
  ] as const) {
    const server = new MockServer((message, mock) => {
      if (message.method === "thread/turns/list") mock.reply(message, reply);
      else defaultReply(message, mock);
    });
    await assert.rejects(readCodexTurnStatus({ threadId: "thread-1", turnId: "turn-1", cwd: "/tmp" }, { ...options(server), timeoutMs: 1_000 }), errorCode(expected));
  }
  const error = new MockServer((message, mock) => {
    if (message.method === "thread/turns/list") mock.emitMessage({ id: message.id, error: { code: -32000, message: "Unavailable" } });
    else defaultReply(message, mock);
  });
  await assert.rejects(readCodexTurnStatus({ threadId: "thread-1", turnId: "turn-1", cwd: "/tmp" }, { ...options(error), timeoutMs: 1_000 }), errorCode("RPC_ERROR"));
  const timeout = new MockServer((message, mock) => { if (message.method === "initialize") mock.reply(message, {}); });
  await assert.rejects(readCodexTurnStatus({ threadId: "thread-1", turnId: "turn-1", cwd: "/tmp" }, { ...options(timeout), timeoutMs: 20 }), errorCode("TIMEOUT"));
 });
