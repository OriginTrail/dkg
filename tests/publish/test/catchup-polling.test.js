import assert from 'node:assert/strict';
import test from 'node:test';

import { subscribeAndWait } from '../src/v10-publish-lib.js';

test('subscribeAndWait enqueues once and polls catch-up through the status endpoint', async () => {
  let subscribeCalls = 0;
  let statusCalls = 0;
  const statuses = ['running', 'done'];
  const client = {
    subscribe: async () => {
      subscribeCalls++;
      return { catchup: { status: 'queued', jobId: 'catchup-1' } };
    },
    catchupStatus: async () => {
      statusCalls++;
      return { status: statuses.shift(), jobId: 'catchup-1' };
    },
  };

  const result = await subscribeAndWait(
    client,
    'jenkins-publish-tests',
    'TestNode1',
    1000,
    0,
  );

  assert.equal(result.status, 'done');
  assert.equal(subscribeCalls, 1);
  assert.equal(statusCalls, 2);
});

test('subscribeAndWait includes the node catch-up error in a terminal failure', async () => {
  const client = {
    subscribe: async () => ({ catchup: { status: 'running', jobId: 'catchup-2' } }),
    catchupStatus: async () => ({
      status: 'failed',
      jobId: 'catchup-2',
      error: 'no sync-capable peers responded',
    }),
  };

  await assert.rejects(
    subscribeAndWait(client, 'jenkins-publish-tests', 'TestNode4', 1000, 0),
    /reported failed: no sync-capable peers responded/,
  );
});
