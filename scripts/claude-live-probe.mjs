#!/usr/bin/env node
// Disposable, independent stream-json probe. It never resumes a Claude session.
import { spawn, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, openSync, readFileSync, realpathSync, statSync, writeFileSync, writeSync } from "node:fs";
import { isAbsolute, join } from "node:path";

const VERSION = "2.1.283 (Claude Code)";
const MODEL = "claude-haiku-4-5-20251001";
const TOOLS = ["Read", "Glob", "Grep"];
const MAX_STREAM = 4_000_000;
const MAX_LINE = 1_000_000;
const MAX_STDERR = 65_536;
const MAX_EVENTS = 10_000;
const TIMEOUT_MS = 60_000;
const [executable, directory, taskFile, evidenceDirectory, budgetText] = process.argv.slice(2);

function inputError(message) { throw new Error(`Probe input: ${message}`); }
if (process.argv.length !== 7) inputError("expected EXECUTABLE CWD TASK_FILE EVIDENCE_DIR MAX_BUDGET_USD");
for (const value of [executable, directory, taskFile, evidenceDirectory]) {
  if (!isAbsolute(value) || value.includes("\0")) inputError("all paths must be absolute");
}
const budget = Number(budgetText);
if (!Number.isFinite(budget) || budget <= 0 || budget > 0.05) inputError("budget must be greater than zero and at most USD 0.05");
const cwd = realpathSync(directory);
const evidenceDir = realpathSync(evidenceDirectory);
const evidenceStat = statSync(evidenceDir);
if (!evidenceStat.isDirectory() || (evidenceStat.mode & 0o077) !== 0 || evidenceStat.uid !== process.getuid()) inputError("evidence directory must be owned by this user and mode 0700");
const task = readFileSync(taskFile, "utf8");
if (!task.trim() || Buffer.byteLength(task) > 65_536) inputError("task must contain 1..65536 bytes");
if (execFileSync(executable, ["--version"], { cwd, encoding: "utf8", timeout: 10_000, maxBuffer: 4096 }).trim() !== VERSION) inputError("Claude version mismatch");

const sessionId = randomUUID();
const streamPath = join(evidenceDir, "stream.jsonl");
const reportPath = join(evidenceDir, "report.json");
if (existsSync(streamPath) || existsSync(reportPath)) inputError("evidence files must not already exist");
const streamFd = openSync(streamPath, "wx", 0o600);
const args = ["--print", "--output-format", "stream-json", "--verbose", "--model", MODEL,
  "--session-id", sessionId, "--restricted", "--safe-mode", "--strict-mcp-config",
  "--tools", TOOLS.join(","), "--permission-mode", "dontAsk", "--permission-prompts", "none",
  "--max-budget-usd", String(budget)];
let streamBytes = 0;
let stderrBytes = 0;
let timedOut = false;
let outputExceeded = false;
let captureFailed = false;
let childError = false;
let closed = false;
const child = spawn(executable, args, { cwd, stdio: "pipe", detached: process.platform !== "win32" });
function signal(signalName) {
  if (closed) return;
  try {
    if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signalName);
    else child.kill(signalName);
  } catch { /* Exit must be observed separately. */ }
}
function terminate() {
  signal("SIGTERM");
  const timer = setTimeout(() => signal("SIGKILL"), 2_000);
  timer.unref();
}
const timer = setTimeout(() => { timedOut = true; terminate(); }, TIMEOUT_MS);
child.stdout.on("data", chunk => {
  streamBytes += chunk.length;
  if (streamBytes > MAX_STREAM) { outputExceeded = true; terminate(); return; }
  try {
    let offset = 0;
    while (offset < chunk.length) {
      const written = writeSync(streamFd, chunk, offset, chunk.length - offset);
      if (written < 1) throw new Error("Short Claude evidence write");
      offset += written;
    }
  } catch { captureFailed = true; terminate(); }
});
child.stderr.on("data", chunk => {
  stderrBytes += chunk.length;
  if (stderrBytes > MAX_STDERR) { outputExceeded = true; terminate(); }
});
child.stdin.on("error", () => { /* Close and report process outcome. */ });
const exit = await new Promise(resolve => {
  let settled = false;
  const finish = outcome => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    clearTimeout(hardWatchdog);
    resolve(outcome);
  };
  const hardWatchdog = setTimeout(() => {
    signal("SIGKILL");
    child.stdout.destroy(); child.stderr.destroy(); child.stdin.destroy(); child.unref();
    closed = true;
    finish({ code: null, signal: null, uncertain: true });
  }, TIMEOUT_MS + 5_000);
  child.once("error", () => { childError = true; terminate(); });
  child.once("close", (code, signalName) => { closed = true; finish({ code, signal: signalName, uncertain: false }); });
  child.stdin.end(task, "utf8");
});
closeSync(streamFd);

const errors = [];
const eventCounts = {};
const toolNames = [];
const rateStatuses = [];
const pendingTools = new Map();
const completedReads = new Set();
let initSeen = false;
let resultSeen = false;
let resultText = null;
let usage = { inputTokens: null, outputTokens: null, costUsd: null };
const raw = readFileSync(streamPath, "utf8");
if (raw && !raw.endsWith("\n")) errors.push("incomplete-line");
const lines = raw.split("\n").filter(Boolean);
if (lines.length > MAX_EVENTS) errors.push("event-limit");
for (const line of lines.slice(0, MAX_EVENTS)) {
  if (Buffer.byteLength(line) > MAX_LINE) { errors.push("line-limit"); continue; }
  let event;
  try { event = JSON.parse(line); } catch { errors.push("malformed-json"); continue; }
  if (!event || typeof event !== "object" || Array.isArray(event) || typeof event.type !== "string") { errors.push("malformed-event"); continue; }
  const type = /^[a-z_]{1,48}$/.test(event.type) ? event.type : "other";
  eventCounts[type] = (eventCounts[type] ?? 0) + 1;
  if (type === "system" && event.subtype === "init") {
    if (initSeen || resultSeen || event.session_id !== sessionId || event.model !== MODEL ||
      !Array.isArray(event.tools) || event.tools.length !== TOOLS.length || !TOOLS.every(name => event.tools.includes(name))) errors.push("init-identity-or-tools");
    else initSeen = true;
    continue;
  }
  if (!initSeen || resultSeen || (event.session_id !== undefined && event.session_id !== sessionId) ||
      (event.model !== undefined && event.model !== MODEL)) { errors.push("event-order-or-identity"); continue; }
  if (type === "rate_limit_event") {
    if (event.session_id !== sessionId || !event.rate_limit_info || typeof event.rate_limit_info !== "object") { errors.push("rate-limit-shape"); continue; }
    const status = event.rate_limit_info.status;
    rateStatuses.push(typeof status === "string" ? status : "unknown");
    if (status !== "allowed" && status !== "allowed_warning") errors.push("rate-limit-status");
  } else if (type === "assistant") {
    if (!Array.isArray(event.message?.content)) { errors.push("assistant-shape"); continue; }
    for (const block of event.message.content) {
      if (block?.type === "tool_use") {
        toolNames.push(block.name);
        if (!TOOLS.includes(block.name)) errors.push("unexpected-tool");
        if (typeof block.id !== "string" || !block.id || pendingTools.has(block.id)) errors.push("tool-id");
        else {
          const path = block.name === "Read" ? block.input?.file_path : null;
          pendingTools.set(block.id, { name: block.name, path });
        }
      } else if (!block || !["text", "thinking"].includes(block.type)) errors.push("assistant-content");
    }
  } else if (type === "user") {
    if (Array.isArray(event.message?.content)) for (const block of event.message.content) {
      if (block?.type !== "tool_result") continue;
      const tool = pendingTools.get(block.tool_use_id);
      if (!tool) { errors.push("unmatched-tool-result"); continue; }
      pendingTools.delete(block.tool_use_id);
      if ((block.is_error !== undefined && block.is_error !== false) || typeof block.content !== "string" || !block.content.trim()) errors.push("tool-error");
      else if (tool.name === "Read" && ["math.mjs", "math.test.mjs"].some(name => tool.path === join(cwd, name))) completedReads.add(tool.path);
    }
  } else if (type === "system") {
    if (typeof event.subtype === "string" && /permission|error|fail|denied/i.test(event.subtype)) errors.push("system-failure");
  } else if (type === "result") {
    resultSeen = true;
    if (event.session_id !== sessionId || event.subtype !== "success" || event.is_error !== false ||
      typeof event.result !== "string" || Buffer.byteLength(event.result) > 262_144 ||
      (event.permission_denials !== undefined && (!Array.isArray(event.permission_denials) || event.permission_denials.length > 0))) errors.push("result-failure");
    else resultText = event.result;
    if (event.usage !== undefined && (typeof event.usage !== "object" || event.usage === null || Array.isArray(event.usage))) errors.push("usage-shape");
    for (const [source, target] of [["input_tokens", "inputTokens"], ["output_tokens", "outputTokens"]]) {
      const value = event.usage?.[source];
      if (value !== undefined && value !== null) {
        if (!Number.isSafeInteger(value) || value < 0) errors.push("usage-invalid");
        else usage[target] = value;
      }
    }
    if (event.total_cost_usd !== undefined && event.total_cost_usd !== null) {
      if (typeof event.total_cost_usd !== "number" || !Number.isFinite(event.total_cost_usd) || event.total_cost_usd < 0) errors.push("cost-invalid");
      else usage.costUsd = event.total_cost_usd;
    }
  } else errors.push("unknown-event");
}
if (!initSeen) errors.push("init-missing");
if (!resultSeen) errors.push("result-missing");
if (pendingTools.size) errors.push("unfinished-tool");
if (!["math.mjs", "math.test.mjs"].every(name => completedReads.has(join(cwd, name)))) errors.push("fixture-reads-missing");
if (typeof resultText !== "string" || !["math.mjs", "math.test.mjs", "-1", "5"].every(value => resultText.includes(value))) errors.push("finding-missing");
if (usage.inputTokens === null || usage.outputTokens === null || usage.costUsd === null) errors.push("usage-missing");
if (usage.costUsd !== null && usage.costUsd > budget) errors.push("cost-over-budget");
if (exit.code !== 0 || exit.signal || childError) errors.push("process-failure");
if (exit.uncertain) errors.push("process-exit-unconfirmed");
if (timedOut) errors.push("timeout");
if (outputExceeded) errors.push("output-limit");
if (captureFailed) errors.push("capture-failed");
const report = { ok: errors.length === 0, executable, runtimeVersion: VERSION, model: MODEL, sessionId, cwd,
  exit, streamBytes, stderrBytes, timedOut, eventCounts, toolNames, rateStatuses, usage, resultText, errors };
writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n", { flag: "wx", mode: 0o600 });
console.log(JSON.stringify({ ok: report.ok, sessionId, reportPath, streamPath, errors, usage }));
if (!report.ok) process.exitCode = 1;
if (exit.uncertain) process.exit(1);
