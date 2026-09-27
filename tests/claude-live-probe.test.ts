import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const probe = fileURLToPath(new URL("../../scripts/claude-live-probe.mjs", import.meta.url));
const fake = `#!/usr/bin/env node
const path = require('node:path');
if (process.argv.includes('--version')) { console.log('2.1.283 (Claude Code)'); process.exit(0); }
const arg = flag => process.argv[process.argv.indexOf(flag) + 1];
if (arg('--model') !== 'claude-haiku-4-5-20251001' || arg('--tools') !== 'Read,Glob,Grep' ||
    arg('--max-budget-usd') !== '0.02' || arg('--permission-mode') !== 'dontAsk' ||
    arg('--permission-prompts') !== 'none' || !process.argv.includes('--restricted') || !process.argv.includes('--safe-mode')) process.exit(50);
const session_id = arg('--session-id');
let task = '';
process.stdin.on('data', chunk => task += chunk);
process.stdin.on('end', () => {
  const emit = event => process.stdout.write(JSON.stringify(event) + '\\n');
  emit({ type: 'system', subtype: 'init', session_id, model: arg('--model'), tools: ['Read', 'Glob', 'Grep'] });
  emit({ type: 'rate_limit_event', session_id, rate_limit_info: { status: task === 'rejected' ? 'rejected' : 'allowed', rateLimitType: 'five_hour' } });
  for (const [index, name] of ['math.mjs', 'math.test.mjs'].entries()) {
    const id = 'read-' + index;
    emit({ type: 'assistant', session_id, message: { content: [{ type: 'tool_use', id, name: task === 'bad-tool' ? 'Bash' : 'Read', input: { file_path: path.join(process.cwd(), name) } }] } });
    if (task !== 'missing-result') emit({ type: 'user', session_id, message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'file contents', is_error: false }] } });
  }
  emit({ type: 'result', subtype: 'success', is_error: false, session_id, result: 'math.mjs: add(2, 3) returns -1; math.test.mjs expects 5.',
    usage: { input_tokens: 9, output_tokens: 20 }, total_cost_usd: task === 'over-budget' ? 0.03 : 0.005 });
});
`;

function fixture(task: string) {
  const root = mkdtempSync(join(tmpdir(), "gattini-claude-probe-"));
  const cwd = join(root, "source"), evidence = join(root, "evidence"), executable = join(root, "fake-claude"), taskFile = join(root, "task.txt");
  mkdirSync(cwd); mkdirSync(evidence, { mode: 0o700 });
  writeFileSync(executable, fake, { mode: 0o700 });
  writeFileSync(taskFile, task);
  return { root, cwd, evidence, executable, taskFile };
}

test("independent Claude CLI probe retains exact successful stream evidence", () => {
  const f = fixture("review");
  try {
    const output = execFileSync(process.execPath, [probe, f.executable, f.cwd, f.taskFile, f.evidence, "0.02"], { encoding: "utf8" });
    const summary = JSON.parse(output);
    const report = JSON.parse(readFileSync(join(f.evidence, "report.json"), "utf8"));
    assert.equal(summary.ok, true);
    assert.equal(report.ok, true);
    assert.equal(report.model, "claude-haiku-4-5-20251001");
    assert.equal(report.sessionId, summary.sessionId);
    assert.deepEqual(report.rateStatuses, ["allowed"]);
    assert.deepEqual(report.toolNames, ["Read", "Read"]);
    assert.equal(report.resultText, "math.mjs: add(2, 3) returns -1; math.test.mjs expects 5.");
    assert.deepEqual(report.usage, { inputTokens: 9, outputTokens: 20, costUsd: 0.005 });
    assert.match(readFileSync(join(f.evidence, "stream.jsonl"), "utf8"), /rate_limit_event/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("independent Claude CLI probe refuses rejected limits, write tools, unfinished reads and excess cost", () => {
  for (const task of ["rejected", "bad-tool", "missing-result", "over-budget"]) {
    const f = fixture(task);
    try {
      const result = spawnSync(process.execPath, [probe, f.executable, f.cwd, f.taskFile, f.evidence, "0.02"], { encoding: "utf8" });
      assert.equal(result.status, 1);
      const report = JSON.parse(readFileSync(join(f.evidence, "report.json"), "utf8"));
      assert.equal(report.ok, false);
      assert.ok(report.errors.includes(task === "rejected" ? "rate-limit-status" : task === "bad-tool" ? "unexpected-tool" : task === "missing-result" ? "unfinished-tool" : "cost-over-budget"));
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  }
});
