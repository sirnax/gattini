const assert = require('node:assert/strict');
const { test } = require('node:test');
const { mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawn } = require('node:child_process');
const { GattiniClient } = require('../dist/client.js');
const { JobSession } = require('../dist/session.js');

function cli(directory, ...args) {
  const entry = join(__dirname, '..', '..', 'dist', 'src', 'cli', 'gattini.js');
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry, ...args, '--json'], {
      env: { ...process.env, GATTINI_STATE_DIR: directory }, stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', code => resolve({ code, stdout, stderr }));
  });
}

test('real daemon and CLI share a durable job and event cursor after restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'gattini extension real space '));
  const serverModule = join(__dirname, '..', '..', 'dist', 'src', 'daemon', 'server.js');
  const { startDaemon } = await import(pathToFileURL(serverModule).href);
  let daemon;
  try {
    daemon = await startDaemon(directory);
    const client = new GattiniClient(daemon.socketPath);
    const started = await client.start('Inspect an offline fake task.', 'extension-real-once');
    assert.equal(started.state, 'completed');
    const values = new Map([['gattini.v2.jobs', [{ workspace: 'file:///tmp/project%20with%20space', jobId: started.jobId, cursor: 0 }]]]);
    const storage = { get: (key, fallback) => values.has(key) ? values.get(key) : fallback,
      update: async (key, value) => { values.set(key, structuredClone(value)); } };
    const session = new JobSession(client, storage);
    const seen = [];
    const first = await session.refresh(started.jobId, event => seen.push(event.sequence));
    assert.equal(first.status.jobId, started.jobId);
    assert(seen.length > 0);
    assert.deepEqual(seen, seen.map((_, i) => i + 1));
    const fromCli = await cli(directory, 'events', started.jobId, '--after-sequence', '0', '--limit', '100');
    assert.equal(fromCli.code, 0, fromCli.stderr);
    const page = JSON.parse(fromCli.stdout);
    assert.equal(page.jobId, started.jobId);
    assert.deepEqual(page.events.map(event => event.sequence), seen);
    const taskFile = join(directory, 'CLI task with spaces.txt');
    writeFileSync(taskFile, 'Another offline fake job.');
    const cliStart = await cli(directory, 'start', '--task-file', taskFile, '--idempotency-key', 'cli-created-for-attach');
    assert.equal(cliStart.code, 0, cliStart.stderr);
    const cliJob = JSON.parse(cliStart.stdout);
    const attached = await session.attach('file:///tmp/second%20folder', cliJob.jobId, () => true);
    assert.equal(attached.jobId, cliJob.jobId);
    assert.equal(attached.workspace, 'file:///tmp/second%20folder');
    assert.equal(session.jobs().length, 2);
    const attachedAgain = await session.attach('file:///tmp/second%20folder', cliJob.jobId, () => true);
    assert.equal(attachedAgain.jobId, cliJob.jobId);
    assert.equal(session.jobs().length, 2);
    await daemon.close();
    daemon = await startDaemon(directory);
    const restored = new JobSession(new GattiniClient(daemon.socketPath), storage);
    const replay = [];
    const second = await restored.refresh(started.jobId, event => replay.push(event.sequence));
    assert.equal(second.status.jobId, started.jobId);
    assert.equal(second.status.state, 'completed');
    assert.deepEqual(replay, []);
    assert.equal(restored.jobs()[0].cursor, seen.at(-1));
    const attachedStatus = await restored.refresh(cliJob.jobId, () => {});
    assert.equal(attachedStatus.status.jobId, cliJob.jobId);
    const status = await cli(directory, 'status', started.jobId);
    assert.equal(status.code, 0, status.stderr);
    assert.equal(JSON.parse(status.stdout).jobId, started.jobId);
  } finally {
    if (daemon) await daemon.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
