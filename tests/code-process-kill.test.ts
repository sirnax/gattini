import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { connect } from "node:net";
import { afterEach, test } from "node:test";

const roots: string[] = [], children: ChildProcess[] = [];
const originalPath = process.env.PATH;
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "gattini-code-kill-")); roots.push(root);
  const source = join(root, "source"), state = join(root, "state"), bin = join(root, "bin"), flags = join(root, "flags");
  for (const dir of [source, state, bin, flags]) mkdirSync(dir, { mode: 0o700 });
  git(source, "init", "-b", "main"); git(source, "config", "user.name", "Gattini Test"); git(source, "config", "user.email", "gattini@example.invalid");
  writeFileSync(join(source, "target.txt"), "old\n"); git(source, "add", "target.txt"); git(source, "commit", "-m", "base");
  const baseSha = git(source, "rev-parse", "HEAD");
  writeFileSync(join(source, "target.txt"), "dirty\n"); writeFileSync(join(source, "unrelated.txt"), "keep\n");
  const proposal = JSON.stringify({ path: "target.txt", beforeSha256: sha("old\n"), afterBase64: Buffer.from("new\n").toString("base64") });
  const textEvent = JSON.stringify({ type: "text", sessionID: "ses_codekill", part: { text: proposal } });
  const script = `#!/bin/sh
printf '%s\\n' "$*" >> '${root}/calls'
case "$1" in
--version) echo 'opencode v2.0.18' ;;
service) echo 'http://127.0.0.1:4096' ;;
debug) echo '[{"id":"proposal","permissions":[{"action":"*","resource":"*","effect":"deny"},{"action":"read","resource":"*","effect":"allow"},{"action":"glob","resource":"*","effect":"allow"},{"action":"grep","resource":"*","effect":"allow"}]}]' ;;
models) echo 'provider/model' ;;
run)
  touch '${flags}/run-entered'
  while [ -f '${flags}/hold-before-handle' ] && [ ! -f '${flags}/release-handle' ]; do sleep 0.02; done
  echo '{"type":"step_start","sessionID":"ses_codekill"}'
  while [ -f '${flags}/hold-before-text' ] && [ ! -f '${flags}/release-text' ]; do sleep 0.02; done
  printf '%s\\n' '${textEvent}' ;;
api) if [ "$2" = session.active ]; then echo '{"data":{}}'; else printf '{"data":{"id":"ses_codekill","agent":"proposal","model":{"providerID":"provider","id":"model"},"outcome":"succeeded","location":{"directory":"%s"}}}\\n' "$PWD"; fi ;;
*) exit 2 ;;
esac
`;
  writeFileSync(join(bin, "opencode"), script, { mode: 0o700 }); chmodSync(join(bin, "opencode"), 0o700);
  writeFileSync(join(state, "code-role.json"), JSON.stringify({ runtime: "opencode", agent: "proposal", model: "provider/model", serverUrl: "http://127.0.0.1:4096" }), { mode: 0o600 });
  process.env.PATH = `${bin}${delimiter}${originalPath ?? ""}`;
  return { root, source, state, flags, baseSha };
}
function daemon(f: ReturnType<typeof fixture>): ChildProcess {
  const child = spawn(process.execPath, ["dist/src/daemon/gattinid.js"], { env: { ...process.env, GATTINI_STATE_DIR: f.state }, stdio: "ignore" });
  children.push(child); return child;
}
function kill(child: ChildProcess) { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }
async function req(socketPath: string, method: string, params: unknown): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath); let data = "";
    socket.on("connect", () => socket.write(JSON.stringify({ protocolVersion: 1, requestId: `req-${Date.now()}`, method, params }) + "\n"));
    socket.on("data", chunk => { data += String(chunk); });
    socket.on("end", () => { try { resolve(JSON.parse(data) as Record<string, any>); } catch (error) { reject(error); } });
    socket.on("error", reject);
  });
}
async function until<T>(read: () => Promise<T>, predicate: (value: T) => boolean, timeout = 8000): Promise<T> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await read(); if (predicate(value)) return value; await new Promise(resolve => setTimeout(resolve, 20)); }
  throw new Error("Timed out waiting for code process state");
}
async function ready(socketPath: string) { await until(async () => { try { return await req(socketPath, "status", { jobId: "missing" }); } catch { return null; } }, value => value !== null); }
async function submit(f: ReturnType<typeof fixture>, socketPath: string, check: string) {
  const response = await req(socketPath, "start", { task: "change target.txt", idempotencyKey: "code-kill", role: "code", requireApproval: true,
    trustedLocal: true, repositoryPath: f.source, baseSha: f.baseSha,
    verificationCommands: [{ argv: [process.execPath, "-e", check], timeoutMs: 10000 }] });
  assert.equal(response.ok, true, JSON.stringify(response)); return response.result;
}
async function status(socketPath: string, jobId: string) { const response = await req(socketPath, "status", { jobId }); assert.equal(response.ok, true); return response.result; }

afterEach(async () => {
  for (const root of roots) for (const name of ["release-handle", "release-text", "release-check"]) writeFileSync(join(root, "flags", name), "");
  for (const child of children.splice(0)) kill(child);
  await new Promise(resolve => setTimeout(resolve, 150));
  process.env.PATH = originalPath;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

for (const withHandle of [false, true]) {
  test(`daemon kill during proposal launch ${withHandle ? "with" : "before"} exact handle never replays`, async () => {
    const f = fixture(); writeFileSync(join(f.flags, withHandle ? "hold-before-text" : "hold-before-handle"), "");
    let process = daemon(f), socketPath = join(f.state, "gattinid.sock"); await ready(socketPath);
    const job = await submit(f, socketPath, "process.exit(0)");
    const approval = await req(socketPath, "approve", { approvalId: job.approvalId }); assert.equal(approval.ok, true);
    await until(async () => existsSync(join(f.flags, "run-entered")), Boolean);
    if (withHandle) await until(() => status(socketPath, job.jobId), value => value.runtimeSessionId === "ses_codekill");
    kill(process); await new Promise(resolve => process.once("exit", resolve));
    process = daemon(f); await ready(socketPath);
    const stopped = await until(() => status(socketPath, job.jobId), value => value.state === "interrupted");
    assert.equal(stopped.runtimeSessionId, withHandle ? "ses_codekill" : null);
    assert.equal((readFileSync(join(f.root, "calls"), "utf8").match(/^run /gm) ?? []).length, 1);
    assert.equal(readFileSync(join(f.source, "target.txt"), "utf8"), "dirty\n");
    assert.equal(readFileSync(join(job.worktreePath, "target.txt"), "utf8"), "old\n");
  });
}

test("daemon kill during verification retains applied work and snapshot without accepted result", async () => {
  const f = fixture(); let process = daemon(f), socketPath = join(f.state, "gattinid.sock"); await ready(socketPath);
  const check = `require('fs').writeFileSync(${JSON.stringify(join(f.flags, "check-started"))},'1');const fs=require('fs');const p=${JSON.stringify(join(f.flags, "release-check"))};const timer=setInterval(()=>{if(fs.existsSync(p)){clearInterval(timer);process.exit(0)}},20);`;
  const job = await submit(f, socketPath, check);
  assert.equal((await req(socketPath, "approve", { approvalId: job.approvalId })).ok, true);
  await until(() => status(socketPath, job.jobId), value => value.state === "awaiting-approval" && value.runtimeSessionId === "ses_codekill");
  const listed = await req(socketPath, "approvals.list", {}); assert.equal(listed.ok, true);
  const apply = listed.result.find((entry: { action: { kind: string } }) => entry.action.kind === "code-apply");
  assert.ok(apply);
  assert.equal((await req(socketPath, "approve", { approvalId: apply.id })).ok, true);
  await until(async () => existsSync(join(f.flags, "check-started")), Boolean);
  kill(process); await new Promise(resolve => process.once("exit", resolve));
  writeFileSync(join(f.flags, "release-check"), "");
  process = daemon(f); await ready(socketPath);
  const stopped = await until(() => status(socketPath, job.jobId), value => value.state === "interrupted");
  assert.equal(stopped.runtimeSessionId, "ses_codekill");
  const output = await req(socketPath, "result", { jobId: job.jobId }); assert.equal(output.ok, true); assert.equal(output.result.result, null);
  assert.equal(readFileSync(join(job.worktreePath, "target.txt"), "utf8"), "new\n");
  assert.equal(readFileSync(join(f.source, "target.txt"), "utf8"), "dirty\n");
  assert.equal(readFileSync(join(f.source, "unrelated.txt"), "utf8"), "keep\n");
  assert.equal(existsSync(join(f.state, "artifacts", job.jobId, "snapshot.json")), true);
  assert.equal((readFileSync(join(f.root, "calls"), "utf8").match(/^run /gm) ?? []).length, 1);
});
