import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { RELEASE_VERSION } from "../src/core/release.js";

const root = mkdtempSync(join(tmpdir(), "gattini-package-"));
const output = join(root, "release one");
const secondOutput = join(root, "release two");
const prefix = join(root, "install prefix");
const state = join(root, "private state");
const npmCache = join(root, "npm cache");
const archive = join(output, `gattini-${RELEASE_VERSION}.tgz`);
const repository = process.cwd();
let daemon: ChildProcess | undefined;

const localEnv = {
  ...process.env,
  GATTINI_STATE_DIR: state,
  npm_config_cache: npmCache,
  npm_config_offline: "true",
  npm_config_audit: "false",
  npm_config_fund: "false",
  npm_config_update_notifier: "false",
};

function command(executable: string, args: string[], cwd = repository): string {
  const result = spawnSync(executable, args, {
    cwd, env: localEnv, encoding: "utf8", timeout: 120_000,
  });
  assert.equal(result.status, 0, `${executable} ${args.join(" ")}\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

function run(executable: string, args: string[], timeoutMs = 15_000): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { env: localEnv, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.setEncoding("utf8").on("data", chunk => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("close", status => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
  });
}

function installedBin(name: "gattini" | "gattinid"): string {
  return join(prefix, "bin", name);
}

function digest(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function install(source: string): void {
  command("npm", ["install", "--global", "--prefix", prefix, "--offline", "--ignore-scripts", "--no-audit", "--no-fund", source]);
}

function olderPackage(): string {
  const directory = join(root, "older package");
  mkdirSync(directory);
  writeFileSync(join(directory, "package.json"), JSON.stringify({
    name: "gattini", version: "0.0.9", private: false, type: "commonjs",
    bin: { gattini: "gattini.cjs", gattinid: "gattinid.cjs" },
    engines: { node: ">=24" },
  }));
  writeFileSync(join(directory, "gattini.cjs"), "#!/usr/bin/env node\nconsole.log('0.0.9');\n");
  writeFileSync(join(directory, "gattinid.cjs"), "#!/usr/bin/env node\nconsole.log('0.0.9');\n");
  command("npm", ["pack", "--offline", "--ignore-scripts", "--pack-destination", root], directory);
  return join(root, "gattini-0.0.9.tgz");
}

async function startInstalledDaemon(): Promise<void> {
  daemon = spawn(installedBin("gattinid"), [], {
    env: localEnv, stdio: ["ignore", "pipe", "pipe"],
  });
  const child = daemon;
  await new Promise<void>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => reject(new Error(`daemon startup timed out: ${stdout}\n${stderr}`)), 10_000);
    const finish = (error?: Error): void => {
      clearTimeout(timer);
      child.stdout?.off("data", onStdout);
      child.stderr?.off("data", onStderr);
      child.off("error", onError);
      child.off("exit", onExit);
      if (error) reject(error); else resolve();
    };
    const onStdout = (chunk: Buffer): void => {
      stdout += chunk.toString();
      if (stdout.includes("gattinid listening at ")) finish();
    };
    const onStderr = (chunk: Buffer): void => { stderr += chunk.toString(); };
    const onError = (error: Error): void => finish(error);
    const onExit = (code: number | null): void => finish(new Error(`daemon exited ${code}: ${stdout}\n${stderr}`));
    child.stdout?.on("data", onStdout);
    child.stderr?.on("data", onStderr);
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

async function stopInstalledDaemon(): Promise<void> {
  const child = daemon;
  daemon = undefined;
  if (!child || child.exitCode !== null) return;
  await new Promise<void>(resolve => {
    const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
    child.once("close", () => { clearTimeout(timer); resolve(); });
    child.kill("SIGTERM");
  });
}

before(() => {
  mkdirSync(output);
  mkdirSync(secondOutput);
  command(process.execPath, ["scripts/package-local.mjs", "--out-dir", output]);
});

after(async () => {
  await stopInstalledDaemon();
  rmSync(root, { recursive: true, force: true });
});

test("local release is reproducible and has a matching checksum manifest", () => {
  command(process.execPath, ["scripts/package-local.mjs", "--out-dir", secondOutput]);
  const hash = digest(archive);
  assert.equal(digest(join(secondOutput, `gattini-${RELEASE_VERSION}.tgz`)), hash);
  assert.equal(readFileSync(join(output, `gattini-${RELEASE_VERSION}.tgz.sha256`), "utf8"), `${hash}  gattini-${RELEASE_VERSION}.tgz\n`);
  const release = JSON.parse(readFileSync(join(output, "release.json"), "utf8")) as Record<string, unknown>;
  assert.equal(release.name, "gattini");
  assert.equal(release.version, RELEASE_VERSION);
  assert.equal(release.sha256, hash);
  assert.equal(release.archive, `gattini-${RELEASE_VERSION}.tgz`);
  assert.equal(release.platform, process.platform);
  assert.equal(release.arch, process.arch);
  assert.equal(release.nodeRange, ">=24");
});

test("local prefix upgrade and uninstall retain isolated jobs and configuration", async () => {
  install(olderPackage());
  assert.equal((await run(installedBin("gattini"), [])).stdout.trim(), "0.0.9");
  mkdirSync(state, { mode: 0o700 });
  const config = join(state, "roles.json");
  writeFileSync(config, "{\"sentinel\":\"preserve\"}\n");
  install(archive);

  const manifest = JSON.parse(readFileSync(join(prefix, "lib", "node_modules", "gattini", "package.json"), "utf8")) as Record<string, unknown>;
  assert.equal(manifest.version, RELEASE_VERSION);
  assert.equal((manifest.engines as Record<string, string>).node, ">=24");
  assert.deepEqual(manifest.os, ["darwin"]);
  assert.deepEqual(manifest.cpu, ["arm64"]);
  assert.deepEqual(manifest.dependencies ?? {}, {});
  assert.deepEqual(manifest.bin, { gattini: "dist/src/cli/gattini.js", gattinid: "dist/src/daemon/gattinid.js" });
  assert.equal(readFileSync(config, "utf8"), "{\"sentinel\":\"preserve\"}\n");

  await startInstalledDaemon();
  const taskFile = join(root, "fake task.txt");
  writeFileSync(taskFile, "Exercise the packaged fake job.\n");
  const started = await run(installedBin("gattini"), ["start", "--task-file", taskFile, "--idempotency-key", "package-lifecycle", "--json"]);
  assert.equal(started.status, 0, started.stderr);
  const job = JSON.parse(started.stdout) as { jobId: string; state: string };
  assert.equal(job.state, "completed");
  assert.ok(job.jobId);
  const retrieved = await run(installedBin("gattini"), ["result", job.jobId, "--json"]);
  assert.equal(retrieved.status, 0, retrieved.stderr);
  assert.equal((JSON.parse(retrieved.stdout) as { jobId: string }).jobId, job.jobId);
  await stopInstalledDaemon();

  const database = join(state, "jobs.sqlite");
  const databaseHash = digest(database);
  command("npm", ["uninstall", "--global", "--prefix", prefix, "--offline", "--ignore-scripts", "--no-audit", "--no-fund", "gattini"]);
  assert.equal(existsSync(installedBin("gattini")), false);
  assert.equal(existsSync(installedBin("gattinid")), false);
  assert.equal(digest(database), databaseHash);
  assert.equal(readFileSync(config, "utf8"), "{\"sentinel\":\"preserve\"}\n");
});

test("packaged client rejects a different daemon version before submitting a job", async () => {
  install(archive);
  mkdirSync(state, { recursive: true });
  const methods: string[] = [];
  const socketPath = join(state, "gattinid.sock");
  const server = createServer(socket => {
    let wire = "";
    socket.setEncoding("utf8").on("data", chunk => {
      wire += chunk;
      if (!wire.includes("\n")) return;
      const request = JSON.parse(wire.slice(0, wire.indexOf("\n"))) as { requestId: string; method: string };
      methods.push(request.method);
      socket.end(`${JSON.stringify({ protocolVersion: 1, requestId: request.requestId, ok: true,
        result: { version: "0.0.9", protocolVersion: 1, databaseSchemaVersion: 7 } })}\n`);
    });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); });
  try {
    const taskFile = join(root, "mismatch task.txt");
    writeFileSync(taskFile, "This must not be submitted.\n");
    const attempt = await run(installedBin("gattini"), ["start", "--task-file", taskFile, "--idempotency-key", "mismatch", "--json"]);
    assert.equal(attempt.status, 3, attempt.stderr);
    assert.equal((JSON.parse(attempt.stderr) as { error: { code: string } }).error.code, "VERSION_MISMATCH");
    assert.deepEqual(methods, ["hello"]);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
