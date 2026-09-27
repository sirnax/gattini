#!/usr/bin/env node
// Exercise checked release archives with Homebrew-style libexec wrappers in a disposable directory.
// This is not a substitute for `brew install`, `brew test`, or `brew audit`.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, renameSync, symlinkSync, writeFileSync, unlinkSync } from "node:fs";
import { isAbsolute, join, basename } from "node:path";

const args = process.argv.slice(2);
const flags = ["--old-archive", "--old-release", "--new-archive", "--new-release", "--node", "--work-dir"];
if (args.length !== flags.length * 2 || flags.some((flag, index) => args[index * 2] !== flag)) {
  throw new Error(`Usage: node scripts/verify-local-release-stage.mjs ${flags.map(flag => `${flag} ABS_PATH`).join(" ")}`);
}
const values = Object.fromEntries(flags.map((flag, index) => [flag, args[index * 2 + 1]]));
for (const [flag, path] of Object.entries(values)) {
  if (!isAbsolute(path)) throw new Error(`${flag} must be absolute`);
}
const workDir = values["--work-dir"];
if (existsSync(workDir)) throw new Error("Work directory already exists; refusing to overwrite it");
const nodePath = values["--node"];
assert.match(nodePath, /\/node$/);
assert.equal(spawnSync(nodePath, ["--version"], { encoding: "utf8" }).status, 0);

function verifyArchive(archive, releasePath) {
  const release = JSON.parse(readFileSync(releasePath, "utf8"));
  assert.equal(release.name, "gattini");
  assert.equal(release.platform, "darwin");
  assert.equal(release.arch, "arm64");
  assert.equal(release.nodeRange, ">=24");
  assert.equal(basename(archive), release.archive);
  assert.equal(createHash("sha256").update(readFileSync(archive)).digest("hex"), release.sha256);
  return release;
}
const oldRelease = verifyArchive(values["--old-archive"], values["--old-release"]);
const newRelease = verifyArchive(values["--new-archive"], values["--new-release"]);
assert.notEqual(oldRelease.version, newRelease.version);

mkdirSync(workDir, { mode: 0o700, recursive: false });
const kegs = join(workDir, "kegs");
const prefix = join(workDir, "prefix");
const bin = join(prefix, "bin");
const state = join(workDir, "state with spaces");
const socket = join(state, "gattinid.sock");
mkdirSync(kegs);
mkdirSync(bin, { recursive: true });

function stage(archive, release) {
  const extracted = join(workDir, `extracted-${release.version}`);
  mkdirSync(extracted);
  const untar = spawnSync("tar", ["-xzf", archive, "-C", extracted], { encoding: "utf8" });
  if (untar.status !== 0) throw new Error(`tar failed: ${untar.stderr}`);
  const source = join(extracted, "package");
  const manifest = JSON.parse(readFileSync(join(source, "package.json"), "utf8"));
  assert.equal(manifest.version, release.version);
  const libexec = join(kegs, release.version, "libexec");
  mkdirSync(libexec, { recursive: true });
  for (const name of ["package.json", "LICENSE", "README.md"]) copyFileSync(join(source, name), join(libexec, name));
  for (const name of ["dist", "docs"]) cpSync(join(source, name), join(libexec, name), { recursive: true });
  assert.ok(existsSync(join(libexec, "dist/src/cli/gattini.js")));
  assert.ok(existsSync(join(libexec, "dist/src/daemon/gattinid.js")));
}
stage(values["--old-archive"], oldRelease);
stage(values["--new-archive"], newRelease);

const current = join(prefix, "current");
const shellQuote = value => `'${value.replaceAll("'", "'\\''")}'`;
function activate(version) {
  if (existsSync(current)) unlinkSync(current);
  symlinkSync(join(kegs, version), current);
}
activate(oldRelease.version);
for (const name of ["gattini", "gattinid"]) {
  const target = name === "gattini" ? "cli/gattini.js" : "daemon/gattinid.js";
  const path = join(bin, name);
  writeFileSync(path, `#!/bin/sh\nexec ${shellQuote(nodePath)} ${shellQuote(`${current}/libexec/dist/src/${target}`)} "$@"\n`, { mode: 0o755 });
  chmodSync(path, 0o755);
}

const environment = { ...process.env, GATTINI_STATE_DIR: state };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function daemon() {
  const child = spawn(join(bin, "gattinid"), [], { env: environment, stdio: ["ignore", "pipe", "pipe"] });
  let errorText = "";
  child.stderr.on("data", chunk => { errorText += String(chunk); });
  for (let i = 0; i < 100; i += 1) {
    if (existsSync(socket)) return child;
    if (child.exitCode !== null) throw new Error(`Daemon exited early: ${errorText}`);
    await delay(50);
  }
  child.kill("SIGTERM");
  throw new Error(`Daemon did not create socket: ${errorText}`);
}
async function stop(child) {
  if (child.exitCode !== null) return;
  const stopped = new Promise(resolve => child.once("exit", resolve));
  child.kill("SIGINT");
  await stopped;
}
function cli(...argv) {
  const result = spawnSync(join(bin, "gattini"), [...argv, "--json"], { env: environment, encoding: "utf8", timeout: 15_000 });
  if (result.error || result.status !== 0) throw new Error(`CLI ${argv[0]} failed: ${result.error ?? result.stderr}`);
  return JSON.parse(result.stdout);
}
const task = join(workDir, "task with spaces.txt");
writeFileSync(task, "Offline staged release smoke\n");
let child;
try {
  child = await daemon();
  const oldJob = cli("run", "--task-file", task, "--idempotency-key", "old-stage", "--role", "code");
  assert.equal(oldJob.state, "completed");
  const oldId = oldJob.jobId;
  await stop(child);
  child = undefined;

  activate(newRelease.version);
  child = await daemon();
  assert.equal(cli("result", oldId).state, "completed");
  const newJob = cli("run", "--task-file", task, "--idempotency-key", "new-stage", "--role", "code");
  assert.equal(newJob.state, "completed");
  const events = cli("events", newJob.jobId, "--after-sequence", "0", "--limit", "100");
  assert.ok(events.events.length >= 1);
  await stop(child);
  child = undefined;

  const db = join(state, "jobs.sqlite");
  const beforeUninstall = createHash("sha256").update(readFileSync(db)).digest("hex");
  renameSync(prefix, join(workDir, "uninstalled-prefix"));
  assert.equal(createHash("sha256").update(readFileSync(db)).digest("hex"), beforeUninstall);
  process.stdout.write(JSON.stringify({ oldVersion: oldRelease.version, newVersion: newRelease.version,
    oldJobId: oldId, newJobId: newJob.jobId, eventCount: events.events.length,
    statePreservedAfterUninstall: true, workDir }) + "\n");
} finally {
  if (child) await stop(child);
}
