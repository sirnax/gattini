import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { connect, type Socket } from "node:net";
import { afterEach, test } from "node:test";

const dirs: string[] = [];
const children: ChildProcess[] = [];
const originalPath = process.env.PATH;
const originalState = process.env.GATTINI_STATE_DIR;
const originalCalls = process.env.FAKE_PROCESS_CALLS;

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "gattini-process-kill-")); dirs.push(dir);
  const bin = join(dir, "bin"); const flags = join(dir, "flags"); mkdirSync(bin); mkdirSync(flags);
  const calls = join(dir, "calls");
  const script = `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_PROCESS_CALLS"
case "$1" in
 --version) echo 'opencode v2.0.16' ;;
 service) echo 'http://127.0.0.1:4096' ;;
 debug) echo '[{"id":"reviewer","permissions":[{"action":"*","resource":"*","effect":"deny"},{"action":"read","resource":"*","effect":"allow"},{"action":"glob","resource":"*","effect":"allow"},{"action":"grep","resource":"*","effect":"allow"}]}]' ;;
 models) echo 'provider/reviewer-model' ;;
 run)
   touch '${flags}/run-entered'
   if [ -f '${flags}/hold-launch' ]; then while [ ! -f '${flags}/release-launch' ]; do sleep 0.02; done; fi
   echo '{"type":"step_start","sessionID":"ses_processkill123"}'
   while [ ! -f '${flags}/release' ] && [ ! -f '${flags}/interrupt' ]; do sleep 0.02; done
   if [ -f '${flags}/interrupt' ]; then exit 1; fi
   echo '{"type":"text","sessionID":"ses_processkill123","part":{"text":"done"}}' ;;
 api)
   case "$2" in
    session.active) if [ -f '${flags}/interrupted' ]; then echo '{"data":{}}'; else echo '{"data":{"ses_processkill123":{"id":"ses_processkill123"}}}'; fi ;;
    session.interrupt) touch '${flags}/interrupt'; while [ ! -f '${flags}/allow-confirm' ]; do sleep 0.02; done; touch '${flags}/interrupted'; echo '{"interrupted":true}' ;;
    session.get) if [ -f '${flags}/interrupted' ]; then outcome=interrupted; elif [ -f '${flags}/release' ]; then outcome=succeeded; else outcome=running; fi; echo '{"data":{"id":"ses_processkill123","agent":"reviewer","model":{"providerID":"provider","id":"reviewer-model"},"outcome":"'"$outcome"'","location":{"directory":"${dir}"}}}' ;;
   esac ;;
 stop) touch '${flags}/unexpected-stop' ;;
 *) exit 2 ;;
esac
`;
  const exe = join(bin, "opencode"); writeFileSync(exe, script, { mode: 0o700 }); chmodSync(exe, 0o700);
  process.env.PATH = `${bin}${delimiter}${originalPath ?? ""}`; process.env.FAKE_PROCESS_CALLS = calls;
  writeFileSync(join(dir, "roles.json"), JSON.stringify({ schemaVersion: 1, roles: { reviewer: {
    runtime: "opencode", agent: "reviewer", model: "provider/reviewer-model", directory: dir,
    serverUrl: "http://127.0.0.1:4096", permissions: [
      { action: "*", resource: "*", effect: "deny" }, { action: "read", resource: "*", effect: "allow" },
      { action: "glob", resource: "*", effect: "allow" }, { action: "grep", resource: "*", effect: "allow" },
    ],
  } } }), { mode: 0o600 });
  return { dir, flags, calls };
}

function child(cmd: string, args: string[], env: NodeJS.ProcessEnv): ChildProcess {
  const p = spawn(cmd, args, { env, stdio: "ignore" }); children.push(p); return p;
}
function daemon(f: ReturnType<typeof fixture>) {
  return child(process.execPath, ["dist/src/daemon/gattinid.js"], { ...process.env, GATTINI_STATE_DIR: f.dir });
}
function req(path: string, method: string, params: unknown): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    const s: Socket = connect(path); let data = ""; s.setEncoding("utf8");
    s.on("connect", () => s.write(JSON.stringify({ protocolVersion: 1, requestId: `${method}-${Date.now()}`, method, params }) + "\n"));
    s.on("data", chunk => data += chunk); s.on("end", () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } }); s.on("error", reject);
  });
}
async function until<T>(read: () => Promise<T>, yes: (v: T) => boolean, timeout = 8000): Promise<T> {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await read(); if (yes(value)) return value; await new Promise(r => setTimeout(r, 20)); }
  throw new Error("Timed out waiting for process lifecycle state");
}
async function ready(path: string) { await until(async () => { try { return await req(path, "status", { jobId: "missing" }); } catch { return null; } }, v => v !== null); }
async function submit(path: string, key: string) {
  const r = await req(path, "start", { task: "Wait for fake process control", idempotencyKey: key, role: "reviewer" });
  assert.equal(r.ok, true, JSON.stringify(r)); return r.result.jobId as string;
}
async function status(path: string, id: string) { const r = await req(path, "status", { jobId: id }); assert.equal(r.ok, true); return r.result; }
function kill(p: ChildProcess) { if (p.exitCode === null && p.signalCode === null) p.kill("SIGKILL"); }

afterEach(async () => {
  for (const d of dirs) {
    const flags = join(d, "flags");
    if (existsSync(flags)) for (const name of ["release-launch", "release", "allow-confirm"]) writeFileSync(join(flags, name), "");
  }
  for (const p of children.splice(0)) { kill(p); }
  await new Promise(r => setTimeout(r, 150));
  process.env.PATH = originalPath;
  for (const [k, v] of [["GATTINI_STATE_DIR", originalState], ["FAKE_PROCESS_CALLS", originalCalls]] as const) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

test("killing the submitting client during fake run leaves daemon-owned job running to completion", async () => {
  const f = fixture(); const d = daemon(f); const sock = join(f.dir, "gattinid.sock"); await ready(sock);
  const client = child(process.execPath, ["-e", `const net=require('node:net');const s=net.createConnection(${JSON.stringify(sock)},()=>s.write(JSON.stringify({protocolVersion:1,requestId:'child',method:'start',params:{task:'client loss',idempotencyKey:'client-kill',role:'reviewer'}})+'\\n'));s.on('data',()=>{});setInterval(()=>{},1000);`], process.env);
  await until(async () => existsSync(join(f.flags, "run-entered")), Boolean).catch(error => { throw new Error(`${error}; calls=${readFileSync(f.calls, "utf8")}`); }); kill(client);
  // The daemon owns execution after acceptance; release the fake adapter and verify terminal persistence.
  writeFileSync(join(f.flags, "release"), "");
  // Recover the accepted ID from durable store through the daemon's job list is not exposed; use a known idempotent resubmit.
  const accepted = await req(sock, "start", { task: "client loss", idempotencyKey: "client-kill", role: "reviewer" });
  assert.equal(accepted.ok, true);
  await until(() => status(sock, accepted.result.jobId), s => s.state === "completed");
  kill(d); assert.equal(existsSync(join(f.flags, "unexpected-stop")), false);
});

test("killing daemon during fake run preserves uncertain handle and restart does not relaunch", async () => {
  const f = fixture(); let d = daemon(f); const sock = join(f.dir, "gattinid.sock"); await ready(sock);
  const id = await submit(sock, "daemon-kill"); await until(async () => existsSync(join(f.flags, "run-entered")), Boolean).catch(error => { throw new Error(`${error}; calls=${readFileSync(f.calls, "utf8")}`); });
  kill(d); await new Promise(r => d.once("exit", r));
  // The fake runtime still reports an active session, so restart must retain uncertainty and avoid replay.
  d = daemon(f); await ready(sock);
  const s = await until(() => status(sock, id), v => v.state === "interrupted");
  assert.equal(s.runtimeSessionId, "ses_processkill123");
  assert.equal((readFileSync(f.calls, "utf8").match(/run --/g) ?? []).length, 1);
  assert.equal(existsSync(join(f.flags, "unexpected-stop")), false);
});

test("killing daemon after launch but before the first session event leaves an unbound interrupted job", async () => {
  const f = fixture();
  writeFileSync(join(f.flags, "hold-launch"), "");
  let d = daemon(f); const sock = join(f.dir, "gattinid.sock"); await ready(sock);
  const id = await submit(sock, "launch-kill");
  await until(async () => existsSync(join(f.flags, "run-entered")), Boolean);
  kill(d); await new Promise(r => d.once("exit", r));
  d = daemon(f); await ready(sock);
  const s = await until(() => status(sock, id), v => v.state === "interrupted");
  assert.equal(s.runtimeSessionId, null);
  assert.equal((readFileSync(f.calls, "utf8").match(/run --/g) ?? []).length, 1);
  const blocked = await req(sock, "start", { task: "must wait for manual reconciliation", idempotencyKey: "launch-blocked", role: "reviewer" });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.error.code, "SCOPE_BLOCKED");
  assert.equal(existsSync(join(f.flags, "unexpected-stop")), false);
});

test("killing daemon after cancel dispatch leaves restart to reconcile exact session", async () => {
  const f = fixture(); let d = daemon(f); const sock = join(f.dir, "gattinid.sock"); await ready(sock);
  const id = await submit(sock, "cancel-kill"); await until(async () => existsSync(join(f.flags, "run-entered")), Boolean);
  await req(sock, "cancel", { jobId: id }); await until(async () => existsSync(join(f.flags, "interrupt")), Boolean);
  kill(d); await new Promise(r => d.once("exit", r));
  writeFileSync(join(f.flags, "allow-confirm"), "");
  d = daemon(f); await ready(sock);
  const s = await until(() => status(sock, id), v => v.state === "cancelled");
  assert.equal(s.state, "cancelled");
  assert.equal((readFileSync(f.calls, "utf8").match(/run --/g) ?? []).length, 1);
  assert.equal(existsSync(join(f.flags, "unexpected-stop")), false);
});
