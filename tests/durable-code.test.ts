import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { connect } from "node:net";
import { test } from "node:test";
import { startDaemon } from "../src/daemon/server.js";

const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
const wire = (method: string, params: unknown) => ({ protocolVersion: 1, requestId: `req-${Date.now()}`, method, params });
async function request(socketPath: string, method: string, params: unknown): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath); let data = "";
    socket.on("connect", () => socket.write(`${JSON.stringify(wire(method, params))}\n`));
    socket.on("data", chunk => { data += String(chunk); });
    socket.on("end", () => { try { const response = JSON.parse(data) as { ok: boolean; result: Record<string, any>; error?: unknown }; assert.equal(response.ok, true, JSON.stringify(response.error)); resolve(response.result); } catch (error) { reject(error); } });
    socket.on("error", reject);
  });
}
async function state(socketPath: string, jobId: string, wanted: string): Promise<void> {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    if ((await request(socketPath, "status", { jobId })).state === wanted) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`Job did not reach ${wanted}`);
}

test("daemon proposes read-only, requires exact patch approval, retains checked bytes and diff across restart", async t => {
  const root = mkdtempSync(join(tmpdir(), "gattini-durable-code-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, "source"), stateDir = join(root, "state"), bin = join(root, "bin");
  mkdirSync(source); mkdirSync(stateDir, { mode: 0o700 }); mkdirSync(bin);
  git(source, "init", "-b", "main"); git(source, "config", "user.name", "Gattini Test"); git(source, "config", "user.email", "gattini@example.invalid");
  writeFileSync(join(source, "code.txt"), "old\n"); git(source, "add", "code.txt"); git(source, "commit", "-m", "base");
  const baseSha = git(source, "rev-parse", "HEAD");
  writeFileSync(join(source, "code.txt"), "dirty\n"); writeFileSync(join(source, "unrelated.txt"), "keep\n");
  const proposal = JSON.stringify({ path: "code.txt", beforeSha256: sha("old\n"), afterBase64: Buffer.from("new\n").toString("base64") });
  const events = [JSON.stringify({ type: "step_start", sessionID: "ses_codefixture" }), JSON.stringify({ type: "text", sessionID: "ses_codefixture", part: { text: proposal } })];
  const script = `#!/bin/sh
case "$1" in
--version) printf 'opencode v2.0.18\\n' ;;
service) printf 'http://127.0.0.1:4096\\n' ;;
debug) printf '%s\\n' '[{"id":"proposal","permissions":[{"action":"*","resource":"*","effect":"deny"},{"action":"read","resource":"*","effect":"allow"},{"action":"glob","resource":"*","effect":"allow"},{"action":"grep","resource":"*","effect":"allow"}]}]' ;;
models) printf 'provider/model\\n' ;;
run) printf '%s\\n' '${events[0]}' '${events[1]}' ;;
api) if [ "$2" = session.active ]; then printf '{"data":{}}\\n'; else printf '{"data":{"id":"ses_codefixture","agent":"proposal","model":{"providerID":"provider","id":"model"},"outcome":"succeeded","location":{"directory":"%s"}}}\\n' "$PWD"; fi ;;
*) exit 2 ;;
esac
`;
  writeFileSync(join(bin, "opencode"), script, { mode: 0o700 }); chmodSync(join(bin, "opencode"), 0o700);
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}${delimiter}${oldPath ?? ""}`;
  t.after(() => { if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath; });
  writeFileSync(join(stateDir, "code-role.json"), JSON.stringify({ runtime: "opencode", agent: "proposal", model: "provider/model", serverUrl: "http://127.0.0.1:4096" }), { mode: 0o600 });
  let daemon = await startDaemon(stateDir);
  t.after(async () => { try { await daemon.close(); } catch { /* The test may already have closed it. */ } });
  const start = await request(daemon.socketPath, "start", { task: "Change code.txt", idempotencyKey: "durable-code", role: "code", requireApproval: true,
    trustedLocal: true, repositoryPath: source, baseSha, verificationCommands: [{ argv: [process.execPath, "-e", "if(require('fs').readFileSync('code.txt','utf8')!=='new\\n')process.exit(9)"], timeoutMs: 2000 }] });
  assert.equal(start.state, "awaiting-approval");
  assert.equal(readFileSync(join(source, "code.txt"), "utf8"), "dirty\n");
  await request(daemon.socketPath, "approve", { approvalId: start.approvalId });
  await state(daemon.socketPath, start.jobId, "awaiting-approval");
  const approvals = await request(daemon.socketPath, "approvals.list", {});
  const applyApproval = approvals.find((entry: { action: { kind: string } }) => entry.action.kind === "code-apply");
  assert.equal(applyApproval.action.path, "code.txt");
  assert.equal(applyApproval.action.afterSha256, sha("new\n"));
  assert.equal(readFileSync(join(start.worktreePath, "code.txt"), "utf8"), "old\n");
  await daemon.close();
  daemon = await startDaemon(stateDir);
  await request(daemon.socketPath, "approve", { approvalId: applyApproval.id });
  await state(daemon.socketPath, start.jobId, "completed");
  const output = await request(daemon.socketPath, "result", { jobId: start.jobId });
  assert.equal(output.result.acceptance, "passed");
  const evidence = output.result.snapshot;
  assert.equal(sha(readFileSync(evidence.artifact.path)), evidence.artifact.sha256);
  assert.equal(sha(readFileSync(evidence.artifact.diffPath)), evidence.artifact.diffFileSha256);
  assert.equal(JSON.parse(readFileSync(evidence.artifact.path, "utf8")).entries.find((entry: { path: string }) => entry.path === "code.txt").content, Buffer.from("new\n").toString("base64"));
  assert.match(readFileSync(evidence.artifact.diffPath, "utf8"), /\+new/);
  assert.equal(readFileSync(join(source, "code.txt"), "utf8"), "dirty\n");
  assert.equal(readFileSync(join(source, "unrelated.txt"), "utf8"), "keep\n");
  assert.equal(existsSync(evidence.artifact.path), true);
  await daemon.close();
  daemon = await startDaemon(stateDir);
  assert.equal((await request(daemon.socketPath, "result", { jobId: start.jobId })).result.snapshot.snapshotSha, evidence.snapshotSha);
  writeFileSync(evidence.artifact.diffPath, "tampered");
  await assert.rejects(request(daemon.socketPath, "result", { jobId: start.jobId }), /EVIDENCE_INVALID/);
  await daemon.close();
});
