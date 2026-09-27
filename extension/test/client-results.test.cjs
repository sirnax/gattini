const assert = require('node:assert/strict');
const { test } = require('node:test');
const { GattiniClient } = require('../dist/client.js');
const { evidenceLines } = require('../dist/views.js');

const hello = { version: '0.2.0', protocolVersion: 2 };

test('result projection drops artifact paths and evidence never accepts a client path', async () => {
  const requests = [];
  const client = new GattiniClient('/unused', async (_path, method, params) => {
    requests.push({ method, params });
    if (method === 'hello') return hello;
    if (method === 'result') return { jobId: 'job-1', state: 'completed', result: {
      jobId: 'job-1', execution: 'completed', acceptance: 'passed', summary: 'done', changedFiles: [], verification: [], limitations: [],
      snapshot: { artifact: { path: '/private/secrets/key.pem', diffPath: '../../escape' } }
    } };
    return { jobId: 'job-1', kind: 'diff', sha256: 'a'.repeat(64), text: '../../escape\n<script>x</script>', truncated: false };
  });
  const result = await client.result('job-1');
  assert.equal(JSON.stringify(result).includes('/private/secrets'), false);
  const evidence = await client.evidence('job-1', undefined, 'diff');
  assert.equal(requests.at(-1).method, 'evidence.read');
  assert.deepEqual(Object.keys(requests.at(-1).params).sort(), ['jobId', 'kind']);
  assert(evidenceLines(evidence).some(line => line.includes('../../escape')));
});

test('oversized or wrong-attempt evidence is rejected before display', async () => {
  let response = { jobId: 'job-1', attemptId: 'attempt-1', kind: 'diff', sha256: 'a'.repeat(64), text: 'x'.repeat(65537), truncated: false };
  const client = new GattiniClient('/unused', async (_path, method) => method === 'hello' ? hello : response);
  await assert.rejects(() => client.evidence('job-1', 'attempt-1', 'diff'), error => error.code === 'PROTOCOL_ERROR');
  response = { ...response, text: 'safe', attemptId: 'attempt-other' };
  await assert.rejects(() => client.evidence('job-1', 'attempt-1', 'diff'), error => error.code === 'PROTOCOL_ERROR');
});
