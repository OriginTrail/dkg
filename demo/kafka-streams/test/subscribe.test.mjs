import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ensureSubscribed } from '../lib/subscribe.mjs';
test('ensureSubscribed posts subscribe body, auth headers, and returns parsed success', async () => {
  const calls = [];
  const res = await ensureSubscribed(
    async (url, init) => {
      calls.push({ url, init });
      return { status: 200, parsed: { subscribed: 'cg-x', catchup: { status: 'queued' } } };
    },
    'http://node2',
    'cg-x',
    { Authorization: 'Bearer t' },
  );
  assert.equal(calls[0].url, 'http://node2/api/context-graph/subscribe');
  assert.deepEqual(JSON.parse(calls[0].init.body), { contextGraphId: 'cg-x', includeSharedMemory: true });
  assert.equal(calls[0].init.headers.Authorization, 'Bearer t');
  assert.equal(calls[0].init.headers['Content-Type'], 'application/json');
  assert.equal(res.catchup.status, 'queued');
});
test('ensureSubscribed throws descriptively on non-2xx', async () => {
  await assert.rejects(
    ensureSubscribed(async () => ({ status: 403, parsed: { error: 'not allowed' } }), 'http://node2', 'cg-z'),
    /403.*not allowed/,
  );
});
