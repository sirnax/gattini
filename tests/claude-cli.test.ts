import assert from "node:assert/strict";
import { mkdtemp, writeFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ClaudeCliError, preflightClaudeTurn, startClaudeTurn, type ClaudeTurnConfig } from "../src/adapters/claude-cli.js";

const fakeSource = `#!/usr/bin/env node
if (process.argv.includes('--version')) { process.stdout.write('2.1.283 (Claude Code)\\n'); process.exit(0); }
const value = (flag) => process.argv[process.argv.indexOf(flag) + 1];
const argv = process.argv.slice(2);
for (const flag of ['--print', '--verbose', '--restricted', '--safe-mode', '--strict-mcp-config']) {
  if (!argv.includes(flag)) process.exit(41);
}
for (const [flag, expected] of [['--output-format', 'stream-json'], ['--tools', 'Read,Glob,Grep'], ['--permission-mode', 'dontAsk'], ['--permission-prompts', 'none'], ['--max-budget-usd', '0.05']]) {
  if (value(flag) !== expected) process.exit(42);
}
if (argv.some(value => ['--resume', '--fallback-model', '--background', '--dangerously-skip-permissions', '--allow-dangerously-skip-permissions', '--worktree'].includes(value))) process.exit(43);
const session_id = value('--session-id');
const model = value('--model');
let task = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => task += chunk);
process.stdin.on('end', () => {
  const event = value => process.stdout.write(JSON.stringify(value) + '\\n');
  const init = { type: 'system', subtype: 'init', session_id, model, tools: ['Read', 'Glob', 'Grep'] };
  const result = { type: 'result', subtype: 'success', is_error: false, session_id, result: 'Reviewed.', usage: { input_tokens: 7, output_tokens: 3 }, total_cost_usd: 0.001 };
  if (task === 'no-init') { setInterval(() => {}, 1000); return; }
  if (task === 'bad-model') init.model = 'claude-other';
  if (task === 'bad-tools') init.tools.push('Bash');
  event(init);
  if (task === 'hang') { setInterval(() => {}, 1000); return; }
  if (task === 'malformed') { process.stdout.write('{broken\\n'); return; }
  if (task === 'oversize') { event({ type: 'assistant', session_id, message: { content: [{ type: 'text', text: 'x'.repeat(1100000) }] } }); return; }
  if (task === 'permission') { result.is_error = true; result.subtype = 'error_during_execution'; }
  if (task === 'changed-session') result.session_id = '00000000-0000-0000-0000-000000000000';
  if (task === 'bad-usage') result.usage.input_tokens = -1;
  if (task === 'large-text') result.result = 'x'.repeat(100);
  if (task === 'unknown-usage') { delete result.usage; delete result.total_cost_usd; }
  event(result);
  if (task === 'nonzero') process.exitCode = 1;
});
`;

async function fixture(fn: (base: ClaudeTurnConfig) => Promise<void>): Promise<void> {
  const cwd = await mkdtemp(join(tmpdir(), "gattini-claude-cli-"));
  const executable = join(cwd, "fake-claude");
  try {
    await writeFile(executable, fakeSource);
    await chmod(executable, 0o755);
    await fn({ model: "claude-sonnet-4-5-20250929", executable, cwd, task: "ok", maxBudgetUsd: 0.05 });
  } finally { await rm(cwd, { recursive: true, force: true }); }
}
const errorCode = (code: string) => (error: unknown): boolean => error instanceof ClaudeCliError && error.code === code;

test("preflight pins local version and rejects ambiguous configuration", async () => fixture(async base => {
  assert.equal(await preflightClaudeTurn(base), "2.1.283 (Claude Code)");
  await assert.rejects(preflightClaudeTurn({ ...base, model: "sonnet" }), errorCode("INVALID_INPUT"));
  await assert.rejects(preflightClaudeTurn({ ...base, maxBudgetUsd: 0 }), errorCode("INVALID_INPUT"));
  await assert.rejects(preflightClaudeTurn({ ...base, executable: "./claude" }), errorCode("INVALID_INPUT"));
}));

test("launch pins argv, exact init identity and terminal usage", async () => fixture(async base => {
  let observed: unknown;
  const turn = startClaudeTurn(base, { onIdentity: identity => { observed = identity; } });
  const result = await turn.result;
  assert.deepEqual(result.identity, observed);
  assert.match(result.identity.sessionId, /^[0-9a-f-]{36}$/);
  assert.equal(result.identity.model, base.model);
  assert.equal(result.identity.cwd, base.cwd);
  assert.equal(result.identity.executable, base.executable);
  assert.equal(result.text, "Reviewed.");
  assert.deepEqual(result.usage, { inputTokens: 7, outputTokens: 3, costUsd: 0.001 });
  const unknown = await startClaudeTurn({ ...base, task: "unknown-usage" }).result;
  assert.deepEqual(unknown.usage, { inputTokens: null, outputTokens: null, costUsd: null });
}));

test("identity, tool, malformed, output, permission and usage failures fail closed", async () => fixture(async base => {
  const cases: Array<[string, string]> = [
    ["bad-model", "PROTOCOL_ERROR"], ["bad-tools", "PROTOCOL_ERROR"],
    ["changed-session", "PROTOCOL_ERROR"], ["malformed", "PROTOCOL_ERROR"],
    ["oversize", "OUTPUT_TOO_LARGE"], ["permission", "PROTOCOL_ERROR"],
    ["bad-usage", "PROTOCOL_ERROR"], ["nonzero", "RUNTIME_FAILED"],
  ];
  for (const [task, code] of cases) {
    await assert.rejects(startClaudeTurn({ ...base, task }).result, errorCode(code), task);
  }
  await assert.rejects(startClaudeTurn({ ...base, task: "large-text" }, { maxTextBytes: 10 }).result, errorCode("PROTOCOL_ERROR"));
}));

test("cancellation confirms only after exit with recorded identity", async () => fixture(async base => {
  let release!: () => void;
  const ready = new Promise<void>(resolve => { release = resolve; });
  const turn = startClaudeTurn({ ...base, task: "hang" }, { onIdentity: () => release(), timeoutMs: 5_000 });
  await ready;
  const cancellation = await turn.interrupt();
  assert.equal(cancellation.confirmed, true);
  assert.match(cancellation.sessionId ?? "", /^[0-9a-f-]{36}$/);
  await assert.rejects(turn.result, errorCode("INTERRUPTED"));
}));

test("cancellation without identity and timeout stay unconfirmed", async () => fixture(async base => {
  const missing = startClaudeTurn({ ...base, task: "no-init" }, { timeoutMs: 100 });
  await assert.rejects(missing.result, errorCode("TIMEOUT"));
  assert.deepEqual(await missing.interrupt(), { confirmed: false, sessionId: null });
  const timed = startClaudeTurn({ ...base, task: "hang" }, { timeoutMs: 100 });
  await assert.rejects(timed.result, errorCode("TIMEOUT"));
}));
