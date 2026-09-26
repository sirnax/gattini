import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile, execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { connect } from "node:net";
import { test } from "node:test";
import { promisify } from "node:util";
import { startDaemon } from "../src/daemon/server.js";

type Reply = { ok: boolean; result?: any; error?: { code: string; message: string } };
const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
const execFileAsync = promisify(execFile);
let sequence = 0;

async function cli(stateDir: string, ...args: string[]): Promise<any> {
  const { stdout } = await execFileAsync(process.execPath, [join(process.cwd(), "dist/src/cli/gattini.js"), ...args, "--json"],
    { env: { ...process.env, GATTINI_STATE_DIR: stateDir }, encoding: "utf8" });
  return JSON.parse(stdout);
}

async function rpc(socketPath: string, method: string, params: unknown): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    let data = "";
    socket.on("connect", () => socket.write(`${JSON.stringify({ protocolVersion: 1, requestId: `task11-${++sequence}`, method, params })}\n`));
    socket.on("data", chunk => { data += String(chunk); });
    socket.on("end", () => { try { resolve(JSON.parse(data.trim()) as Reply); } catch (error) { reject(error); } });
    socket.on("error", reject);
  });
}

async function call(socketPath: string, method: string, params: unknown): Promise<any> {
  const reply = await rpc(socketPath, method, params);
  assert.equal(reply.ok, true, JSON.stringify(reply));
  return reply.result;
}

async function waitState(socketPath: string, jobId: string, wanted: string): Promise<void> {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const status = await call(socketPath, "status", { jobId });
    if (status.state === wanted) return;
    if (["failed", "cancelled", "interrupted"].includes(status.state) && status.state !== wanted) {
      throw new Error(`Job ${jobId} reached ${status.state} before ${wanted}`);
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`Job ${jobId} did not reach ${wanted}`);
}

function reviewerConfig(directory: string) {
  return { schemaVersion: 1, roles: { reviewer: {
    runtime: "opencode", agent: "reviewer", model: "provider/reviewer-model", directory,
    serverUrl: "http://127.0.0.1:4096", permissions: [
      { action: "*", resource: "*", effect: "deny" },
      { action: "read", resource: "*", effect: "allow" },
      { action: "glob", resource: "*", effect: "allow" },
      { action: "grep", resource: "*", effect: "allow" },
    ],
  } } };
}

function installScript(root: string): { calls: string; prompt: string } {
  const bin = join(root, "bin");
  mkdirSync(bin);
  const calls = join(root, "calls.log");
  const prompt = join(root, "review-prompt.txt");
  const script = `#!/bin/sh
printf '%s\\n' "$PWD :: $*" >> "$TASK11_CALLS"
case "$PWD" in
  */review-a) session=ses_reviewA ;;
  */review-b) session=ses_reviewB ;;
  */review-code) session=ses_pinned ;;
  *) session=ses_code ;;
esac
case "$1" in
  --version)
    if [ "$session" = ses_code ]; then printf 'opencode v2.0.18\\n'; else printf 'opencode v2.0.16\\n'; fi ;;
  service) printf 'http://127.0.0.1:4096\\n' ;;
  debug)
    if [ "$session" = ses_code ]; then
      printf '%s\\n' '[{"id":"proposal","permissions":[{"action":"*","resource":"*","effect":"deny"},{"action":"read","resource":"*","effect":"allow"},{"action":"glob","resource":"*","effect":"allow"},{"action":"grep","resource":"*","effect":"allow"}]}]'
    elif [ "$TASK11_BAD_PERMISSION" = 1 ]; then
      printf '%s\\n' '[{"id":"reviewer","permissions":[{"action":"edit","resource":"*","effect":"allow"}]}]'
    else
      printf '%s\\n' '[{"id":"reviewer","permissions":[{"action":"*","resource":"*","effect":"deny"},{"action":"read","resource":"*","effect":"allow"},{"action":"glob","resource":"*","effect":"allow"},{"action":"grep","resource":"*","effect":"allow"}]}]'
    fi ;;
  models)
    if [ "$session" = ses_code ]; then printf 'provider/model\\n'; else printf 'provider/reviewer-model\\n'; fi ;;
  run)
    if [ "$session" = ses_code ]; then
      printf '%s\\n' '{"type":"step_start","sessionID":"ses_code"}'
      printf '%s\\n' "$TASK11_PROPOSAL_EVENT"
    else
      for arg do last="$arg"; done
      if [ "$session" = ses_pinned ]; then printf '%s' "$last" > "$TASK11_PROMPT"; fi
      case " $* " in
        *' --session '*) summary='Follow-up for exact session.' ;;
        *) summary='First review turn.' ;;
      esac
      printf '{"type":"step_start","sessionID":"%s"}\\n' "$session"
      printf '{"type":"text","sessionID":"%s","part":{"text":"%s"}}\\n' "$session" "$summary"
    fi ;;
  api)
    if [ "$2" = session.active ]; then printf '{"data":{}}\\n';
    elif [ "$session" = ses_code ]; then printf '{"data":{"id":"ses_code","agent":"proposal","model":{"providerID":"provider","id":"model"},"outcome":"succeeded","location":{"directory":"%s"}}}\\n' "$PWD";
    else printf '{"data":{"id":"%s","agent":"reviewer","model":{"providerID":"provider","id":"reviewer-model"},"outcome":"succeeded","location":{"directory":"%s"}}}\\n' "$session" "$PWD"; fi ;;
  *) exit 2 ;;
esac
`;
  writeFileSync(join(bin, "opencode"), script, { mode: 0o700 });
  chmodSync(join(bin, "opencode"), 0o700);
  process.env.PATH = `${bin}${delimiter}${process.env.PATH ?? ""}`;
  process.env.TASK11_CALLS = calls;
  process.env.TASK11_PROMPT = prompt;
  return { calls, prompt };
}

test("follow-up keeps exact sessions and immutable prior attempt results across two jobs", async t => {
  const root = mkdtempSync(join(tmpdir(), "gattini-task11-followup-"));
  const oldPath = process.env.PATH;
  const { calls } = installScript(root);
  const stateDir = join(root, "state");
  const dirA = join(root, "review-a"), dirB = join(root, "review-b");
  mkdirSync(stateDir, { mode: 0o700 }); mkdirSync(dirA); mkdirSync(dirB);
  let daemon = await startDaemon(stateDir);
  t.after(async () => { await daemon.close(); process.env.PATH = oldPath; delete process.env.TASK11_CALLS; delete process.env.TASK11_PROMPT; rmSync(root, { recursive: true, force: true }); });

  writeFileSync(join(stateDir, "roles.json"), JSON.stringify(reviewerConfig(dirA)));
  const a = await call(daemon.socketPath, "start", { task: "First A", idempotencyKey: "first-a", role: "reviewer" });
  await waitState(daemon.socketPath, a.jobId, "completed");
  writeFileSync(join(stateDir, "roles.json"), JSON.stringify(reviewerConfig(dirB)));
  const b = await call(daemon.socketPath, "start", { task: "First B", idempotencyKey: "first-b", role: "reviewer" });
  await waitState(daemon.socketPath, b.jobId, "completed");
  const firstA = await call(daemon.socketPath, "result", { jobId: a.jobId });
  const firstB = await call(daemon.socketPath, "result", { jobId: b.jobId });
  assert.notEqual(firstA.attemptId, firstB.attemptId);
  assert.equal((await call(daemon.socketPath, "status", { jobId: a.jobId })).runtimeSessionId, "ses_reviewA");
  assert.equal((await call(daemon.socketPath, "status", { jobId: b.jobId })).runtimeSessionId, "ses_reviewB");

  const wrong = await rpc(daemon.socketPath, "followup", { jobId: "missing-job", task: "Continue", idempotencyKey: "wrong" });
  assert.equal(wrong.error?.code, "NOT_FOUND");
  const taskFile = join(root, "follow-a.txt");
  writeFileSync(taskFile, "Continue A");
  const [followA, followB] = await Promise.all([
    cli(stateDir, "followup", a.jobId, "--task-file", taskFile, "--idempotency-key", "follow-a"),
    call(daemon.socketPath, "followup", { jobId: b.jobId, task: "Continue B", idempotencyKey: "follow-b" }),
  ]);
  assert.notEqual(followA.attemptId, firstA.attemptId);
  assert.notEqual(followB.attemptId, firstB.attemptId);
  await Promise.all([waitState(daemon.socketPath, a.jobId, "completed"), waitState(daemon.socketPath, b.jobId, "completed")]);
  const latestA = await call(daemon.socketPath, "result", { jobId: a.jobId });
  const latestB = await call(daemon.socketPath, "result", { jobId: b.jobId });
  assert.equal(latestA.attemptId, followA.attemptId);
  assert.equal(latestB.attemptId, followB.attemptId);
  assert.equal(latestA.result.summary, "Follow-up for exact session.");
  assert.equal(latestB.result.summary, "Follow-up for exact session.");
  assert.deepEqual((await call(daemon.socketPath, "result", { jobId: a.jobId, attemptId: firstA.attemptId })).result, firstA.result);
  assert.deepEqual((await cli(stateDir, "result", a.jobId, "--attempt-id", firstA.attemptId)).result, firstA.result);
  assert.deepEqual((await call(daemon.socketPath, "result", { jobId: b.jobId, attemptId: firstB.attemptId })).result, firstB.result);
  assert.equal((await rpc(daemon.socketPath, "result", { jobId: a.jobId, attemptId: firstB.attemptId })).error?.code, "NOT_FOUND");
  const log = readFileSync(calls, "utf8");
  assert.match(log, /review-a :: run --session ses_reviewA --agent reviewer --model provider\/reviewer-model/);
  assert.match(log, /review-b :: run --session ses_reviewB --agent reviewer --model provider\/reviewer-model/);
  assert.doesNotMatch(log, /--continue|--last/);
  const replay = await call(daemon.socketPath, "followup", { jobId: a.jobId, task: "Continue A", idempotencyKey: "follow-a" });
  assert.equal(replay.deduplicated, true);
  assert.equal(replay.attemptId, followA.attemptId);
  assert.equal((await rpc(daemon.socketPath, "followup", { jobId: a.jobId, task: "Changed", idempotencyKey: "follow-a" })).error?.code, "IDEMPOTENCY_CONFLICT");
  await daemon.close();
  daemon = await startDaemon(stateDir);
  assert.deepEqual((await call(daemon.socketPath, "result", { jobId: a.jobId, attemptId: firstA.attemptId })).result, firstA.result);
  assert.equal((await call(daemon.socketPath, "result", { jobId: a.jobId })).attemptId, followA.attemptId);
  const fake = await call(daemon.socketPath, "start", { task: "Fake task", idempotencyKey: "fake-task", role: "code" });
  assert.equal((await rpc(daemon.socketPath, "followup", { jobId: fake.jobId, task: "Continue", idempotencyKey: "fake-follow" })).error?.code, "UNSUPPORTED_FOLLOWUP");
});

test("independent review reads pinned code evidence after worktree mutation and denies write-capable role", async t => {
  const root = mkdtempSync(join(tmpdir(), "gattini-task11-pinned-"));
  const oldPath = process.env.PATH;
  const { calls, prompt } = installScript(root);
  const source = join(root, "source"), stateDir = join(root, "state"), reviewDir = join(root, "review-code");
  mkdirSync(source); mkdirSync(stateDir, { mode: 0o700 }); mkdirSync(reviewDir);
  git(source, "init", "-b", "main"); git(source, "config", "user.name", "Gattini Test"); git(source, "config", "user.email", "gattini@example.invalid");
  writeFileSync(join(source, "code.txt"), "old\n"); git(source, "add", "code.txt"); git(source, "commit", "-m", "base");
  const baseSha = git(source, "rev-parse", "HEAD");
  const proposal = JSON.stringify({ path: "code.txt", beforeSha256: hash("old\n"), afterBase64: Buffer.from("new\n").toString("base64") });
  process.env.TASK11_PROPOSAL_EVENT = JSON.stringify({ type: "text", sessionID: "ses_code", part: { text: proposal } });
  writeFileSync(join(stateDir, "code-role.json"), JSON.stringify({ runtime: "opencode", agent: "proposal", model: "provider/model", serverUrl: "http://127.0.0.1:4096" }));
  writeFileSync(join(stateDir, "roles.json"), JSON.stringify(reviewerConfig(reviewDir)));
  const daemon = await startDaemon(stateDir);
  t.after(async () => { await daemon.close(); process.env.PATH = oldPath; delete process.env.TASK11_CALLS; delete process.env.TASK11_PROMPT; delete process.env.TASK11_PROPOSAL_EVENT; delete process.env.TASK11_BAD_PERMISSION; rmSync(root, { recursive: true, force: true }); });

  const code = await call(daemon.socketPath, "start", { task: "Change code.txt", idempotencyKey: "code", role: "code", requireApproval: true,
    trustedLocal: true, repositoryPath: source, baseSha, verificationCommands: [{ argv: [process.execPath, "-e", "if(require('fs').readFileSync('code.txt','utf8')!=='new\\n')process.exit(9)"], timeoutMs: 2000 }] });
  await call(daemon.socketPath, "approve", { approvalId: code.approvalId });
  const deadline = Date.now() + 8_000;
  let apply: any;
  while (Date.now() < deadline) {
    const approvals = await call(daemon.socketPath, "approvals.list", {});
    apply = approvals.find((item: any) => item.action.kind === "code-apply");
    if (apply) break;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.ok(apply, "Code apply approval was not created");
  await call(daemon.socketPath, "approve", { approvalId: apply.id });
  await waitState(daemon.socketPath, code.jobId, "completed");
  const codeResult = await call(daemon.socketPath, "result", { jobId: code.jobId });
  assert.equal(codeResult.result.acceptance, "passed");
  assert.equal(readFileSync(join(code.worktreePath, "code.txt"), "utf8"), "new\n");
  writeFileSync(join(code.worktreePath, "code.txt"), "later mutable value\n");
  const nestedReviewerDirectory = join(code.worktreePath, "nested-reviewer");
  mkdirSync(nestedReviewerDirectory);
  writeFileSync(join(stateDir, "roles.json"), JSON.stringify(reviewerConfig(nestedReviewerDirectory)));
  assert.equal((await rpc(daemon.socketPath, "review", { jobId: code.jobId, idempotencyKey: "nested-review" })).error?.code, "UNSUPPORTED_REVIEW");
  writeFileSync(join(stateDir, "roles.json"), JSON.stringify(reviewerConfig(reviewDir)));

  const review = await call(daemon.socketPath, "review", { jobId: code.jobId, idempotencyKey: "pinned-review" });
  assert.notEqual(review.jobId, code.jobId);
  assert.equal(review.sourceAttemptId, codeResult.attemptId);
  await waitState(daemon.socketPath, review.jobId, "completed");
  const reviewed = await call(daemon.socketPath, "result", { jobId: review.jobId });
  assert.deepEqual(reviewed.pinnedSource, { jobId: code.jobId, attemptId: codeResult.attemptId,
    snapshotSha: codeResult.result.snapshot.snapshotSha, diffSha256: codeResult.result.snapshot.diffSha256 });
  const input = readFileSync(prompt, "utf8");
  assert.match(input, /Snapshot digest:/);
  assert.match(input, /Diff digest:/);
  assert.match(input, new RegExp(Buffer.from("new\n").toString("base64")));
  assert.doesNotMatch(input, /later mutable value/);
  assert.equal(input.includes(code.worktreePath), false);
  assert.equal((await call(daemon.socketPath, "result", { jobId: code.jobId })).result.acceptance, "passed");

  process.env.TASK11_BAD_PERMISSION = "1";
  const denied = await call(daemon.socketPath, "review", { jobId: code.jobId, idempotencyKey: "write-capable-review" });
  await waitState(daemon.socketPath, denied.jobId, "failed");
  const runCalls = readFileSync(calls, "utf8").split("\n").filter(line => line.includes("review-code :: run"));
  assert.equal(runCalls.length, 1, "Write-capable reviewer was launched");
});
