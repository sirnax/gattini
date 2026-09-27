import assert from "node:assert/strict";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { CodexAppServerError } from "../src/adapters/codex-app-server.js";
import { CodexProposalError, codexProposalPrompt, startCodexProposal, type CodexProposalInput } from "../src/adapters/codex-proposal.js";

type Message = Record<string, unknown>;
const root = realpathSync(mkdtempSync(join(tmpdir(), "gattini-codex-proposal-")));
test.after(() => rmSync(root, { recursive: true, force: true }));
const input: CodexProposalInput = { model: "gpt-6-sol", modelProvider: "openai", executable: "codex", cwd: root, task: "Fix the fixture" };
const proposal = JSON.stringify({ path: "math.mjs", oldText: "return a - b;", newText: "return a + b;" });
const terminal = (status: string): Message => ({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status } } });

class MockServer extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin = new PassThrough();
  readonly sent: Message[] = [];
  private inbound = "";
  constructor(readonly action: (message: Message, server: MockServer) => void = () => {}, readonly threadModel?: string, readonly sandboxType = "readOnly") {
    super();
    this.stdin.on("data", (chunk: Buffer) => {
      this.inbound += chunk.toString();
      let index: number;
      while ((index = this.inbound.indexOf("\n")) >= 0) {
        const message = JSON.parse(this.inbound.slice(0, index)) as Message;
        this.inbound = this.inbound.slice(index + 1);
        this.sent.push(message);
        this.reply(message);
        this.action(message, this);
      }
    });
  }
  emitMessage(message: Message): void { this.stdout.write(JSON.stringify(message) + "\n"); }
  private reply(message: Message): void {
    if (message.method === "initialize") this.emitMessage({ id: message.id, result: {} });
    if (message.method === "thread/start") {
      const params = message.params as Record<string, unknown>;
      this.emitMessage({ id: message.id, result: {
        thread: { id: "thread-1", sessionId: "session-1", cliVersion: "0.157.1", model: this.threadModel ?? params.model, modelProvider: params.modelProvider, cwd: params.cwd },
        model: this.threadModel ?? params.model, modelProvider: params.modelProvider, cwd: params.cwd,
        approvalPolicy: "on-request", approvalsReviewer: "user", sandbox: { type: this.sandboxType, networkAccess: false },
      } });
    }
    if (message.method === "turn/start") this.emitMessage({ id: message.id, result: { turn: { id: "turn-1", status: "inProgress" } } });
    if (message.method === "turn/interrupt") this.emitMessage({ id: message.id, result: {} });
  }
  kill(): boolean { return true; }
  child(): ChildProcessWithoutNullStreams { return this as unknown as ChildProcessWithoutNullStreams; }
}

const opts = (server: MockServer, onIdentity: (identity: unknown) => void = () => {}) => ({ timeoutMs: 500, onIdentity, spawn: () => server.child() });
const code = (expected: string) => (error: unknown): boolean => error instanceof CodexProposalError && error.code === expected;
const completed = (server: MockServer, text: string, status = "completed"): void => {
  server.emitMessage({ method: "item/completed", params: { threadId: "thread-1", turnId: "turn-1", item: { type: "agentMessage", text } } });
  server.emitMessage({ method: "thread/tokenUsage/updated", params: { threadId: "thread-1", turnId: "turn-1", tokenUsage: { last: { inputTokens: 3, outputTokens: 4, cachedInputTokens: 1, totalTokens: 7 } } } });
  server.emitMessage(terminal(status));
};

test("passes a strict raw proposal, exact identity, and usage from a read-only turn", async () => {
  const server = new MockServer();
  let observed: unknown;
  const handle = startCodexProposal(input, opts(server, (identity) => { observed = identity; queueMicrotask(() => completed(server, proposal)); }));
  const result = await handle.result;
  assert.equal(result.proposal, proposal);
  assert.deepEqual(result.identity, observed);
  assert.equal(result.identity.sessionId, "session-1");
  assert.deepEqual(result.usage, { inputTokens: 3, outputTokens: 4, cachedInputTokens: 1, totalTokens: 7, cost: null });
  const thread = server.sent.find((m) => m.method === "thread/start")?.params;
  assert.deepEqual(thread, { model: input.model, modelProvider: input.modelProvider, cwd: root, sandbox: "read-only", approvalPolicy: "on-request", approvalsReviewer: "user" });
  const turn = server.sent.find((m) => m.method === "turn/start")?.params as { input: Array<{ text: string }> };
  assert.equal(turn.input[0]?.text, codexProposalPrompt(input.task));
  assert.match(turn.input[0]?.text ?? "", /Use available read-only tools to inspect the worktree before answering/);
  assert.match(turn.input[0]?.text ?? "", /Read-only inspection commands are allowed/);
  assert.match(turn.input[0]?.text ?? "", /nonempty literal oldText that appears exactly once/);
  assert.match(turn.input[0]?.text ?? "", /Do not calculate a hash or base64-encode replacement bytes/);
  assert.match(turn.input[0]?.text ?? "", /only keys must be path, oldText, and newText/);
  assert.match(turn.input[0]?.text ?? "", /If read-only inspection is unavailable/);
  assert.match(turn.input[0]?.text ?? "", /do not return a proposal-shaped JSON object/);
  assert.match(turn.input[0]?.text ?? "", /Do not edit files, run commands that change state or access the network, request approval, or delegate/);
});

test("extracts one terminal proposal after a preliminary assistant message", async () => {
  const server = new MockServer();
  const handle = startCodexProposal(input, opts(server, () => queueMicrotask(() => {
    server.emitMessage({ method: "item/completed", params: { threadId: "thread-1", turnId: "turn-1", item: { type: "agentMessage", text: "I inspected the tracked fixture. " } } });
    completed(server, proposal);
  })));
  assert.equal((await handle.result).proposal, proposal);
});

test("rejects denied approval, noncompleted turn, and malformed JSON", async () => {
  const denied = new MockServer();
  await assert.rejects(startCodexProposal(input, opts(denied, () => queueMicrotask(() => {
    denied.emitMessage({ id: "approval-1", method: "item/fileChange/requestApproval", params: {} });
    setImmediate(() => completed(denied, proposal));
  }))).result, code("APPROVAL_REQUESTED"));
  assert.deepEqual(denied.sent.find((m) => m.id === "approval-1")?.result, { decision: "decline" });
  const commandApproval = new MockServer();
  await assert.rejects(startCodexProposal(input, opts(commandApproval, () => queueMicrotask(() => {
    commandApproval.emitMessage({ id: "approval-2", method: "item/commandExecution/requestApproval", params: {} });
    setImmediate(() => completed(commandApproval, proposal));
  }))).result, code("APPROVAL_REQUESTED"));
  assert.deepEqual(commandApproval.sent.find((m) => m.id === "approval-2")?.result, { decision: "decline" });
  const interrupted = new MockServer();
  await assert.rejects(startCodexProposal(input, opts(interrupted, () => queueMicrotask(() => completed(interrupted, proposal, "interrupted")))).result, code("NONCOMPLETED_TURN"));
  for (const bad of [
    "",
    "Cannot prepare a verified proposal: read-only tools unavailable.",
    "```json\n" + proposal + "\n```",
    "{bad}",
    JSON.stringify({ ...JSON.parse(proposal) as object, extra: true }),
    JSON.stringify({ path: "x", beforeSha256: "a".repeat(64), afterBase64: "eA==" }),
    JSON.stringify({ path: "math.mjs", oldText: "", newText: "fixed" }),
    JSON.stringify({ path: "math.mjs", oldText: "return a - b;", newText: "return a - b;" }),
    JSON.stringify({ path: "", oldText: "before", newText: "after" }),
    JSON.stringify({ path: "math.mjs", oldText: "before", newText: null }),
    proposal + "Trailing commentary",
    proposal + proposal,
    JSON.stringify({ path: "math.mjs", oldText: "", newText: "placeholder" }) + proposal,
    proposal + JSON.stringify({ note: "another object" }),
  ]) {
    const server = new MockServer();
    await assert.rejects(startCodexProposal(input, opts(server, () => queueMicrotask(() => completed(server, bad)))).result, code("INVALID_PROPOSAL"));
  }
});

test("rejects oversized text, timeout, reroute, model mismatch, and policy mismatch", async () => {
  const oversized = new MockServer();
  await assert.rejects(startCodexProposal(input, opts(oversized, () => queueMicrotask(() => {
    for (let n = 0; n < 2; n++) oversized.emitMessage({ method: "item/completed", params: { threadId: "thread-1", turnId: "turn-1", item: { type: "agentMessage", text: "x".repeat(600_000) } } });
  }))).result,
    (error: unknown) => error instanceof CodexAppServerError && error.code === "TEXT_TOO_LARGE");
  const timeout = new MockServer();
  await assert.rejects(startCodexProposal(input, { ...opts(timeout), timeoutMs: 20 }).result,
    (error: unknown) => error instanceof CodexAppServerError && error.code === "TIMEOUT");
  const reroute = new MockServer();
  await assert.rejects(startCodexProposal(input, opts(reroute, () => queueMicrotask(() => reroute.emitMessage({ method: "model/rerouted", params: { threadId: "thread-1", turnId: "turn-1", toModel: "other" } })))).result,
    (error: unknown) => error instanceof CodexAppServerError && error.code === "MODEL_REROUTED");
  const mismatch = new MockServer(() => {}, "other-model");
  await assert.rejects(startCodexProposal(input, opts(mismatch)).result,
    (error: unknown) => error instanceof CodexAppServerError && error.code === "IDENTITY_MISMATCH");
  const policy = new MockServer(() => {}, undefined, "workspaceWrite");
  await assert.rejects(startCodexProposal(input, opts(policy)).result,
    (error: unknown) => error instanceof CodexAppServerError && error.code === "IDENTITY_MISMATCH");
});

test("preflight requires explicit executable and canonical cwd before spawn", () => {
  let spawned = false;
  const options = { timeoutMs: 500, onIdentity: () => {}, spawn: () => { spawned = true; throw new Error("unexpected spawn"); } };
  assert.throws(() => startCodexProposal({ ...input, executable: "" }, options), code("INVALID_INPUT"));
  assert.throws(() => startCodexProposal({ ...input, cwd: join(root, "missing") }, options), code("INVALID_INPUT"));
  assert.throws(() => startCodexProposal(input, { ...options, timeoutMs: 0 }), code("INVALID_INPUT"));
  assert.equal(spawned, false);
});
