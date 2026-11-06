import assert from 'node:assert/strict';
import test from 'node:test';
import { createStressApiClient } from '../../testnet-publish-stress/api-client.mjs';
import { createPartitionPublisher } from '../../testnet-publish-stress/publish-partition.mjs';
import { AUTHORITY_CODE, READ_AUTHORITY_CODE } from '../qa/authority-retry.mjs';

const unavailable = (code = AUTHORITY_CODE) => ({ status: 503, body: { code, retryable: true, error: 'authority busy' } });
const success = { status: 200, body: { kaId: '42', txHash: '0xreceipt', status: 'confirmed' } };
function fixture(answers, createAnswer = { status: 200, body: { seal: { merkleRoot: 'root' } } }) {
  const calls = [], waits = [], logs = [];
  let publishes = 0;
  const wait = async ms => { waits.push(ms); };
  const apiCall = createStressApiClient({ host: 'http://fixture', token: 'fixture-token', wait,
    fetch: async (url, init) => {
      calls.push({ path: new URL(url).pathname, ...init });
      const answer = url.endsWith('/vm/publish') ? answers[Math.min(publishes++, answers.length - 1)] : createAnswer;
      return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { 'Retry-After': '1' } });
    },
  });
  const publish = createPartitionPublisher({ cgId: 'graph', stressRunId: 'run', apiCall, sleep: wait, log: text => logs.push(text) });
  return { calls, waits, logs, run: () => publish({ triples: [] }, 7, 2) };
}

test('the actual partition publisher retries only publish, preserving the created name and body', async () => {
  const f = fixture([unavailable(), success]);
  const result = await f.run();
  assert.equal(result.kaId, '42');
  assert.equal(result.name, 'stress-run-000007-r2');
  assert.equal(f.calls.filter(c => c.path === '/api/knowledge-assets').length, 1);
  const publishes = f.calls.filter(c => c.path.endsWith('/vm/publish'));
  assert.equal(publishes.length, 2);
  assert.equal(publishes[0].path, '/api/knowledge-assets/stress-run-000007-r2/vm/publish');
  assert.equal(publishes[0].path, publishes[1].path);
  assert.equal(publishes[0].body, publishes[1].body);
  assert.deepEqual(JSON.parse(publishes[0].body), { contextGraphId: 'graph' });
  assert.deepEqual(f.waits, [3000, 1000]);
  assert.equal(f.logs.length, 1);
});

for (const answer of [unavailable(READ_AUTHORITY_CODE), { ...unavailable(), status: 500 }, { status: 503, body: { code: AUTHORITY_CODE } }]) {
  test(`does not repeat an unsafe publish answer: ${answer.status} ${JSON.stringify(answer.body)}`, async () => {
    const f = fixture([answer, success]);
    await assert.rejects(f.run(), error => {
      assert.equal(error.status, answer.status);
      assert.deepEqual(error.body, answer.body);
      assert.equal(error.retryAfter, '1');
      return true;
    });
    assert.equal(f.calls.length, 2);
    assert.deepEqual(f.waits, [3000]);
  });
}

test('exhaustion reports the last real answer after four retries without creating another asset', async () => {
  const f = fixture([unavailable()]);
  await assert.rejects(f.run(), { status: 503, body: unavailable().body });
  assert.equal(f.calls.filter(c => c.path === '/api/knowledge-assets').length, 1);
  assert.equal(f.calls.filter(c => c.path.endsWith('/vm/publish')).length, 5);
  assert.deepEqual(f.waits, [3000, 1000, 2000, 4000, 8000]);
});

test('asset creation never opts into the publish retry policy', async () => {
  const f = fixture([success], unavailable());
  await assert.rejects(f.run(), { status: 503 });
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.waits, []);
});

test('a timed-out publish preserves the per-attempt deadline and is not repeated', async () => {
  let calls = 0;
  const apiCall = createStressApiClient({ host: 'http://fixture', token: 'fixture-token', fetch: async (_url, init) => {
    calls++;
    return new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }));
  } });
  await assert.rejects(apiCall('POST', '/api/knowledge-assets/asset/vm/publish', {}, { timeoutMs: 5, retryPublishAuthority: true }), { name: 'AbortError' });
  assert.equal(calls, 1);
});
