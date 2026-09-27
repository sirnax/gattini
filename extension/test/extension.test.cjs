const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createServer } = require('node:net');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const Module = require('node:module');
const { GattiniClient, ClientError, socketPath } = require('../dist/client.js');
const { JobSession } = require('../dist/session.js');

function state() {
  const values = new Map();
  return { get: (key, fallback) => values.has(key) ? values.get(key) : fallback,
    update: async (key, value) => { values.set(key, structuredClone(value)); } };
}

async function daemon(handler) {
  const directory = mkdtempSync(join(tmpdir(), 'gattini extension space '));
  const path = join(directory, 'gattinid.sock');
  const server = createServer(socket => {
    let line = '';
    socket.on('data', chunk => {
      line += chunk.toString('utf8');
      if (!line.includes('\n')) return;
      const request = JSON.parse(line.slice(0, line.indexOf('\n')));
      const response = handler(request, socket);
      if (response === null) { socket.destroy(); return; }
      socket.end(JSON.stringify({ protocolVersion: 2, requestId: request.requestId, ok: true, result: response }) + '\n');
    });
  });
  await new Promise(resolve => server.listen(path, resolve));
  return { path, close: async () => { await new Promise(resolve => server.close(resolve)); rmSync(directory, { recursive: true, force: true }); } };
}

const hello = { version: '0.2.0', protocolVersion: 2 };
const status = { jobId: 'job-1', state: 'completed', createdAt: 't1', updatedAt: 't2' };
const event = sequence => ({ jobId: 'job-1', sequence, at: 't', type: 'state', detail: {} });

test('v2 handshake, spaced state path, bounded event cursor and replay after restart', async () => {
  const requests = [];
  let server = await daemon(request => {
    requests.push(request);
    if (request.method === 'hello') return hello;
    if (request.method === 'status') return status;
    if (request.method === 'events.list') {
      const n = request.params.afterSequence;
      return { jobId: 'job-1', events: n < 2 ? [event(n + 1)] : [], nextSequence: n < 2 ? n + 1 : n, hasMore: n < 2 };
    }
  });
  assert.equal(socketPath({ GATTINI_STATE_DIR: server.path.slice(0, -'/gattinid.sock'.length) }), server.path);
  const store = state();
  await store.update('gattini.v2.jobs', [{ workspace: 'file:///tmp/project with space', jobId: 'job-1', cursor: 0 }]);
  const first = new JobSession(new GattiniClient(server.path), store);
  const seen = [];
  assert.equal((await first.refresh('job-1', row => seen.push(row.sequence))).pageCount, 3);
  assert.deepEqual(seen, [1, 2]);
  assert.equal(first.jobs()[0].cursor, 2);
  await server.close();
  await assert.rejects(() => first.refresh('job-1', () => {}), error => error.code === 'DAEMON_UNAVAILABLE');
  server = await daemon(request => {
    if (request.method === 'hello') return hello;
    if (request.method === 'status') return status;
    return { jobId: 'job-1', events: [], nextSequence: request.params.afterSequence, hasMore: false };
  });
  const restored = new JobSession(new GattiniClient(server.path), store);
  await restored.refresh('job-1', row => seen.push(row.sequence));
  assert.deepEqual(seen, [1, 2]);
  assert.equal(requests.filter(r => r.method === 'events.list')[0].params.afterSequence, 0);
  await server.close();
});

test('rejects release mismatch, malformed/future cursors, gaps, and disconnected frames', async () => {
  let server = await daemon(request => request.method === 'hello' ? { version: '0.3.0', protocolVersion: 2 } : status);
  await assert.rejects(() => new GattiniClient(server.path).status('job-1'), error => error.code === 'VERSION_MISMATCH');
  await server.close();
  server = await daemon(request => request.method === 'hello' ? hello : request.method === 'status' ? status :
    { jobId: 'job-1', events: [event(2)], nextSequence: 2, hasMore: false });
  const client = new GattiniClient(server.path);
  await assert.rejects(() => client.events('job-1', -1), error => error.code === 'INVALID_CURSOR');
  await assert.rejects(() => client.events('job-1', 0), error => error.code === 'EVENT_GAP');
  await server.close();
  server = await daemon(request => request.method === 'hello' ? hello : null);
  await assert.rejects(() => new GattiniClient(server.path).status('job-1'), error => error.code === 'DAEMON_UNAVAILABLE');
  await server.close();
  server = await daemon(request => request.method === 'hello' ? hello :
    { jobId: 'job-1', events: [], nextSequence: request.params.afterSequence + 1, hasMore: false });
  await assert.rejects(() => new GattiniClient(server.path).events('job-1', 1000), error => error.code === 'PROTOCOL_ERROR');
  await server.close();
});

test('submission reuses idempotency key across disconnect and blocks untrusted workspaces', async () => {
  const store = state();
  const keys = [];
  let attempts = 0;
  const client = { start: async (_task, key) => { keys.push(key); if (++attempts === 1) throw new ClientError('DAEMON_UNAVAILABLE', 'down');
    return { jobId: 'job-1', state: 'queued', deduplicated: true }; } };
  const session = new JobSession(client, store);
  await assert.rejects(() => session.submit('file:///tmp/space root', 'task', () => false), error => error.code === 'WORKSPACE_UNTRUSTED');
  assert.equal(keys.length, 0);
  await assert.rejects(() => session.submit('file:///tmp/space root', 'task', () => true));
  const job = await session.submit('file:///tmp/space root', 'task', () => true);
  assert.equal(job.jobId, 'job-1');
  assert.equal(keys[0], keys[1]);
  assert.equal(session.jobs().length, 1);
});

test('extension host blocks untrusted submit and requires explicit multi-root choice', async () => {
  const callbacks = new Map();
  const messages = [];
  const lines = [];
  let picked = false;
  const mock = {
    workspace: { isTrusted: false, workspaceFolders: [
      { name: 'one', uri: { fsPath: '/tmp/one space', toString: () => 'file:///tmp/one%20space' } },
      { name: 'two', uri: { fsPath: '/tmp/two', toString: () => 'file:///tmp/two' } }],
      onDidGrantWorkspaceTrust: () => ({ dispose() {} }) },
    window: { showErrorMessage: async message => { messages.push(message); }, showInformationMessage: async () => {},
      showInputBox: async () => undefined, showQuickPick: async items => { picked = true; return items[1]; },
      createOutputChannel: () => ({ appendLine: line => lines.push(line), show() {}, dispose() {} }) },
    commands: { registerCommand: (name, callback) => { callbacks.set(name, callback); return { dispose() {} }; } }
  };
  const original = Module._load;
  Module._load = function(request, parent, isMain) { return request === 'vscode' ? mock : original.call(this, request, parent, isMain); };
  try {
    const { activate, deactivate } = require('../dist/extension.js');
    const context = { workspaceState: state(), subscriptions: [] };
    activate(context);
    await callbacks.get('gattini.submitTask')();
    assert.equal(messages.length, 1);
    assert.equal(picked, false);
    mock.workspace.isTrusted = true;
    await callbacks.get('gattini.submitTask')();
    assert.equal(picked, true);
    assert.equal(lines.some(line => line.includes('submitted')), false);
    context.subscriptions.forEach(item => item.dispose());
    deactivate();
  } finally { Module._load = original; }
});
