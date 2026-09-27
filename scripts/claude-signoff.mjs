#!/usr/bin/env node
// This flag is an accidental-launch guard, not permission to bypass owner or tool approval.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

if (process.argv.length !== 3 || process.argv[2] !== '--approved-live') {
  console.error('Live Claude sign-off requires --approved-live after specific owner approval.');
  process.exit(2);
}
const root = '/private/tmp/gattini-claude-live.BxPN3R';
const executable = '/opt/homebrew/bin/claude';
const node = '/opt/homebrew/opt/node@24/bin/node';
const baseSha = '40fd52db93226e7f2798419e6b435e74adfe918d';
try {
  assert.equal(process.version, 'v24.21.0');
  assert.equal(process.env.NODE_TEST_CONTEXT, undefined, 'Run outside the Node test runner');
  for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY']) {
    assert.ok(!process.env[key], `Unexpected credential/routing override: ${key}`);
  }
  assert.equal(execFileSync(executable, ['--version'], { encoding: 'utf8', timeout: 10000 }).trim(), '2.1.283 (Claude Code)');
  const auth = JSON.parse(execFileSync(executable, ['auth', 'status', '--json'], { encoding: 'utf8', timeout: 10000, maxBuffer: 65536 }));
  assert.equal(auth.loggedIn, true); assert.equal(auth.authMethod, 'claude.ai');
  assert.equal(auth.apiProvider, 'firstParty'); assert.equal(auth.subscriptionType, 'max');
  assert.equal(auth.projectsDirectory, '/Users/nathanlord/.claude/projects');
  const hashes = {
    'code-task.txt': '037b7e6c919ff2801fd7e4108f6aad55e8588fd0fd236656e666b55a8c3d0212',
    'cancel-task.txt': 'ca0c4ea5c31466f29a4a4d6822abb27085eb8038dd525449def60ee33d3563a7',
    'checks.json': '353a69d21e192299abd1dcbcd4cccc66d7645943d6376ce669bff2617c3d30d1',
  };
  for (const source of ['source-code', 'source-cancel']) for (const [file, digest] of Object.entries({
    'math.mjs': '75cfacb7faac086c50b23ac4b29a709eb8680999e6756f620ca76d42aba07cab',
    'math.test.mjs': 'dbe93a2cdd56593eb8ab22c7df0594f12ce9fd87b2fe10eceac860a6b65d9cf4',
    'sentinel.txt': 'ac178812a29ab17fe90e73af33e6e310d7ce77cba50b2ffdf8ce8cced61fce54',
    'untracked-sentinel.txt': '0f523221ba9ef0c24d916cfaac43d86d50bc6245d4659d6461a459c05af832c1',
  })) hashes[`${source}/${file}`] = digest;
  for (const [file, digest] of Object.entries(hashes)) assert.equal(createHash('sha256').update(readFileSync(join(root, file))).digest('hex'), digest, `Fixture changed: ${file}`);
  console.log('Preflight passed: installed Claude 2.1.283, Max authentication, exact disposable fixture. Starting at most one code and one cancel turn.');
  const { runClaudeSignoff } = await import('../dist/tests/helpers/claude-signoff.js');
  const report = await runClaudeSignoff({ root, executable, node, baseSha, projectsDirectory: auth.projectsDirectory });
  console.log(JSON.stringify({ outcome: report.outcome, codeJob: report.code.jobId, cancelJob: report.cancel.jobId,
    report: join(root, 'signoff-report.json'), scope: 'code and cancellation; combine with retained live review evidence and offline suite' }));
} catch {
  // Keep provider text, account details and assertion payloads out of terminal output.
  console.error('Sign-off stopped. Inspect the private signoff-report.json if created; preflight failures create no provider turn. No retry is authorized.');
  process.exitCode = 1;
}
