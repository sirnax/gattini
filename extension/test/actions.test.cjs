const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createServer } = require('node:net');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const Module = require('node:module');

test('plain-text hostile result/evidence and refreshed exact-ID actions', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'gattini action space '));
  const path = join(directory, 'gattinid.sock');
  const requests = [];
  let jobState = 'awaiting-approval';
  let approval = 'ap-1';
  let stale = false;
  let disconnectOnDecision = false;
  const server = createServer(socket => {
    let input = '';
    socket.on('data', chunk => {
      input += chunk.toString('utf8');
      if (!input.includes('\n')) return;
      const request = JSON.parse(input.slice(0, input.indexOf('\n')));
      requests.push(request);
      if (disconnectOnDecision && request.method === 'approve') { socket.destroy(); return; }
      let result;
      if (request.method === 'hello') result = { version: '0.2.0', protocolVersion: 2 };
      else if (request.method === 'status') result = { jobId: 'job-1', state: jobState, createdAt: 't1', updatedAt: 't2' };
      else if (request.method === 'events.list') result = { jobId: 'job-1', events: [], nextSequence: request.params.afterSequence, hasMore: false };
      else if (request.method === 'result') result = { jobId: 'job-1', state: jobState, attemptId: 'attempt-1', result: {
        jobId: 'job-1', execution: 'completed', acceptance: 'passed', summary: '<script>alert(1)</script>',
        changedFiles: ['../../<img onerror=alert(1)>'], verification: [], limitations: ['<svg onload=alert(1)>'] } };
      else if (request.method === 'evidence.read') result = { jobId: 'job-1', attemptId: 'attempt-1', kind: request.params.kind,
        sha256: 'a'.repeat(64), text: '<img src=x onerror=alert(1)>', truncated: false };
      else if (request.method === 'approvals.list') result = stale && requests.filter(row => row.method === 'approvals.list').length % 2 === 0 ? [] :
        [{ id: approval, jobId: 'job-1', action: { kind: 'code-apply', task: 'private text' }, state: 'pending',
          createdAt: '2026-09-27T00:00:00.000Z', expiresAt: '2099-09-27T00:00:00.000Z' }];
      else if (request.method === 'approve' || request.method === 'deny') { result = { approvalId: request.params.approvalId, jobId: 'job-1', state: request.method === 'approve' ? 'approved' : 'denied' }; jobState = 'queued'; }
      else if (request.method === 'cancel') { result = { jobId: 'job-1', state: 'cancelling' }; jobState = 'cancelling'; }
      socket.end(JSON.stringify({ protocolVersion: 2, requestId: request.requestId, ok: true, result }) + '\n');
    });
  });
  await new Promise(resolve => server.listen(path, resolve));
  const previousDir = process.env.GATTINI_STATE_DIR;
  process.env.GATTINI_STATE_DIR = directory;
  const original = Module._load;
  const callbacks = new Map();
  const lines = [];
  const errors = [];
  let inputJobId = 'job-1';
  let folderSelections = 0;
  const values = new Map([['gattini.v2.jobs', [{ workspace: 'file:///tmp/root', jobId: 'job-1', cursor: 0 }]]]);
  const mock = {
    workspace: { isTrusted: true, workspaceFolders: [
      { name: 'spaced', uri: { fsPath: '/tmp/root with space', toString: () => 'file:///tmp/root%20with%20space' } },
      { name: 'other', uri: { fsPath: '/tmp/other', toString: () => 'file:///tmp/other' } }
    ], onDidGrantWorkspaceTrust: () => ({ dispose() {} }) },
    window: { showErrorMessage: async value => { errors.push(value); }, showInformationMessage: async () => {},
      showWarningMessage: async (_message, _options, choice) => choice,
      showQuickPick: async (items, options) => { if (options?.placeHolder?.includes('workspace folder')) folderSelections += 1; return items[0]; },
      showInputBox: async () => inputJobId,
      createOutputChannel: () => ({ appendLine: line => lines.push(line), show() {}, dispose() {} }) },
    commands: { registerCommand: (name, callback) => { callbacks.set(name, callback); return { dispose() {} }; } }
  };
  Module._load = function(request, parent, isMain) { return request === 'vscode' ? mock : original.call(this, request, parent, isMain); };
  try {
    const { activate, deactivate } = require('../dist/extension.js');
    const context = { workspaceState: { get: (key, fallback) => values.has(key) ? values.get(key) : fallback,
      update: async (key, value) => { values.set(key, structuredClone(value)); } }, subscriptions: [] };
    activate(context);
    await callbacks.get('gattini.showResult')();
    await callbacks.get('gattini.showEvidence')();
    assert(lines.some(line => line.includes('<script>alert(1)</script>')));
    assert(lines.some(line => line.includes('<img src=x onerror=alert(1)>')));
    assert.equal(lines.some(line => line.includes('private text')), false);
    await callbacks.get('gattini.approve')();
    assert(requests.some(row => row.method === 'approve' && row.params.approvalId === 'ap-1'));
    approval = 'ap-2'; jobState = 'awaiting-approval';
    await callbacks.get('gattini.deny')();
    assert(requests.some(row => row.method === 'deny' && row.params.approvalId === 'ap-2'));
    approval = 'ap-3'; jobState = 'awaiting-approval'; stale = true;
    const decisions = requests.filter(row => row.method === 'approve' || row.method === 'deny').length;
    await callbacks.get('gattini.approve')();
    assert.equal(requests.filter(row => row.method === 'approve' || row.method === 'deny').length, decisions);
    assert(errors.some(value => value.includes('APPROVAL_STALE')));
    stale = false; approval = 'ap-4'; disconnectOnDecision = true;
    await callbacks.get('gattini.approve')();
    assert(errors.some(value => value.includes('DAEMON_UNAVAILABLE')));
    assert.equal(lines.some(line => line.includes('Approval ap-4')), false);
    disconnectOnDecision = false; jobState = 'queued';
    await callbacks.get('gattini.cancel')();
    assert(requests.some(row => row.method === 'cancel' && row.params.jobId === 'job-1'));
    assert(lines.some(line => line.includes('durable state: cancelling')));
    values.set('gattini.v2.jobs', [{ workspace: 'file:///tmp/root', jobId: 'job-1', cursor: 5 }]);
    const starts = requests.filter(row => row.method === 'start').length;
    await callbacks.get('gattini.attachJob')();
    await callbacks.get('gattini.attachJob')();
    assert.equal(folderSelections, 2);
    assert.equal(values.get('gattini.v2.jobs').length, 1);
    assert.equal(values.get('gattini.v2.jobs')[0].workspace, 'file:///tmp/root%20with%20space');
    assert.equal(values.get('gattini.v2.jobs')[0].cursor, 5);
    assert.equal(requests.filter(row => row.method === 'start').length, starts);
    inputJobId = 'wrong-job';
    await callbacks.get('gattini.attachJob')();
    assert(errors.some(value => value.includes('PROTOCOL_ERROR')));
    assert.equal(values.get('gattini.v2.jobs').length, 1);
    mock.workspace.isTrusted = false;
    const before = requests.length;
    await callbacks.get('gattini.cancel')();
    await callbacks.get('gattini.attachJob')();
    assert.equal(requests.length, before);
    context.subscriptions.forEach(item => item.dispose());
    deactivate();
  } finally {
    Module._load = original;
    if (previousDir === undefined) delete process.env.GATTINI_STATE_DIR; else process.env.GATTINI_STATE_DIR = previousDir;
    await new Promise(resolve => server.close(resolve));
    rmSync(directory, { recursive: true, force: true });
  }
});
