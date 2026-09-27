import assert from "node:assert/strict";
import { execFileSync, execFile } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { spawnSync } from "node:child_process";

async function runClaudeSignoff(options: object): Promise<any> {
  // A nested `node --test` inherits NODE_TEST_CONTEXT and can silently skip its
  // target. Run the whole scenario in a normal child, as the live entry point does.
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
  const script = `import { runClaudeSignoff } from ${JSON.stringify(new URL("./helpers/claude-signoff.js", import.meta.url).href)}; console.log(JSON.stringify(await runClaudeSignoff(JSON.parse(process.argv[1]))));`;
  const { stdout } = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", script, JSON.stringify(options)], { env, timeout: 150_000 });
  return JSON.parse(stdout);
}

test("live sign-off entry point refuses execution without explicit live opt-in", () => {
  const result = spawnSync(process.execPath, ["scripts/claude-signoff.mjs"], { encoding: "utf8" });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /requires --approved-live/);
});

function fixture(badPatch = false, finishCancel = false, omitRead = false) {
  const root = mkdtempSync(join(tmpdir(), "gattini-signoff-"));
  const source = join(root, "source-code"); mkdirSync(source);
  const git = (...args: string[]) => execFileSync("git", ["-C", source, ...args], { encoding: "utf8" }).trim();
  git("init", "-b", "main"); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.invalid");
  writeFileSync(join(source, "math.mjs"), "export function add(a, b) {\n  return a - b;\n}\n");
  writeFileSync(join(source, "math.test.mjs"), "import { strict as assert } from 'node:assert';\nimport { add } from './math.mjs';\nassert.equal(add(2, 3), 5);\n");
  writeFileSync(join(source, "sentinel.txt"), "base\n"); git("add", "."); git("commit", "-m", "fixture");
  const baseSha = git("rev-parse", "HEAD");
  execFileSync("git", ["clone", "--quiet", source, join(root, "source-cancel")]);
  for (const name of ["source-code", "source-cancel"]) {
    writeFileSync(join(root, name, "sentinel.txt"), "preserve dirty\n");
    writeFileSync(join(root, name, "untracked-sentinel.txt"), "preserve untracked\n");
  }
  writeFileSync(join(root, "code-task.txt"), "Fix add using a single literal proposal.");
  writeFileSync(join(root, "cancel-task.txt"), "Read the math files and analyze candidate inputs.");
  writeFileSync(join(root, "checks.json"), JSON.stringify([{ argv: [process.execPath, "--test", "math.test.mjs"], timeoutMs: 10000 }]));
  // Exact non-secret text from session ac3b42c8-444f-434a-9b2c-0b1c2ae40cfe.
  const observed = '```json\n{\n  "path": "math.mjs",\n  "oldText": "  return a - b;",\n  "newText": "  return a + b;"\n}\n```';
  const executable = join(root, "fake-claude");
  const projectsDirectory = join(root, "transcripts");
  writeFileSync(executable, `#!/usr/bin/env node
const fs = require('node:fs');
if (process.argv.includes('--version')) { console.log('2.1.283 (Claude Code)'); process.exit(0); }
const arg = name => process.argv[process.argv.indexOf(name)+1];
fs.appendFileSync(${JSON.stringify(join(root, "launches"))}, process.cwd()+'\\n');
const session_id = arg('--session-id');
const transcriptDir = require('node:path').join(${JSON.stringify(projectsDirectory)}, process.cwd().replace(/[^a-zA-Z0-9]/g,'-'));
fs.mkdirSync(transcriptDir,{recursive:true});
let task=''; process.stdin.on('data', b=>task+=b);
process.stdin.on('end', ()=>{
 const emit = e=>{fs.appendFileSync(transcriptDir+'/'+session_id+'.jsonl',JSON.stringify({...e,sessionId:session_id,cwd:process.cwd()})+'\\n'); console.log(JSON.stringify(e));};
 emit({type:'system',subtype:'init',session_id,model:arg('--model'),tools:['Read','Glob','Grep']});
 if (!task.includes('Prepare one read-only code proposal')) {
   if (${finishCancel}) { emit({type:'result',subtype:'success',is_error:false,session_id,result:'Already finished.',usage:{input_tokens:1,output_tokens:1},total_cost_usd:0.001}); return; }
   process.on('SIGTERM', ()=>{fs.writeFileSync(${JSON.stringify(join(root, "cancel-signal"))}, JSON.stringify({session_id,pid:process.pid})); setTimeout(()=>process.exit(0),100);});
   setInterval(()=>{},1000); return;
 }
 emit({type:'rate_limit_event',session_id,rate_limit_info:{status:'allowed'}});
 if (!${omitRead}) {
   emit({type:'assistant',session_id,message:{content:[{type:'tool_use',id:'read-1',name:'Read',input:{file_path:process.cwd()+'/math.mjs'}}]}});
   emit({type:'user',session_id,message:{content:[{type:'tool_result',tool_use_id:'read-1',content:fs.readFileSync('math.mjs','utf8'),is_error:false}]}});
 }
 emit({type:'result',subtype:'success',is_error:false,session_id,result:${JSON.stringify(badPatch ? observed.replace('a + b', 'a * b') : observed)},usage:{input_tokens:18,output_tokens:370},total_cost_usd:0.0063698});
});
`, { mode: 0o700 });
  return { root, executable, baseSha, node: process.execPath, projectsDirectory };
}

test("sign-off scenario checks observed fenced patch, exact approvals, snapshot, restart and cancellation", async () => {
  const f = fixture();
  try {
    const report = await runClaudeSignoff(f);
    assert.equal(report.outcome, "passed");
    assert.equal(report.code.result.acceptance, "passed");
    assert.equal(report.cancel.status.state, "cancelled");
    const stopped = JSON.parse(readFileSync(join(f.root, "cancel-signal"), "utf8"));
    assert.equal(stopped.session_id, report.cancel.status.runtimeSessionId);
    assert.throws(() => process.kill(stopped.pid, 0), { code: "ESRCH" }, "cancelled is visible only after the actual child exits");
    assert.equal(readFileSync(join(f.root, "launches"), "utf8").trim().split("\n").length, 2);
    await assert.rejects(runClaudeSignoff(f), /already exists/, "a second invocation must not resume or spend again");
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("sign-off rejects a correct patch without a successful read before apply or cancellation", async () => {
  const f = fixture(false, false, true);
  try {
    await assert.rejects(runClaudeSignoff(f), /no successful Read/);
    const report = JSON.parse(readFileSync(join(f.root, "signoff-report.json"), "utf8"));
    assert.equal(report.outcome, "failed");
    assert.equal(readFileSync(join(f.root, "launches"), "utf8").trim().split("\n").length, 1);
    assert.equal(readFileSync(join(report.code.worktreePath, "math.mjs"), "utf8"), "export function add(a, b) {\n  return a - b;\n}\n");
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("sign-off refuses a cancellation row that finishes before interruption", async () => {
  const f = fixture(false, true);
  try {
    await assert.rejects(runClaudeSignoff(f), /cancellation (not exercised|unproven)/);
    const report = JSON.parse(readFileSync(join(f.root, "signoff-report.json"), "utf8"));
    assert.equal(report.outcome, "failed");
    assert.equal(readFileSync(join(f.root, "launches"), "utf8").trim().split("\n").length, 2);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("sign-off rejects a different valid patch before apply and never launches cancellation", async () => {
  const f = fixture(true);
  try {
    await assert.rejects(runClaudeSignoff(f), /replacement/);
    const report = JSON.parse(readFileSync(join(f.root, "signoff-report.json"), "utf8"));
    assert.equal(report.outcome, "failed");
    assert.equal(readFileSync(join(f.root, "launches"), "utf8").trim().split("\n").length, 1);
    assert.equal(readFileSync(join(report.code.worktreePath, "math.mjs"), "utf8"), "export function add(a, b) {\n  return a - b;\n}\n");
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
