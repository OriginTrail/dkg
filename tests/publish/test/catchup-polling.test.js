import assert from 'node:assert/strict';
import test from 'node:test';

import {
  queryAnyRemoteWithRetry,
  subscribeAndWait,
} from '../src/v10-publish-lib.js';

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

test('subscribeAndWait can preserve a fresh-publish canary after historical catch-up fails', async () => {
  const client = {
    subscribe: async () => ({ subscribed: true, catchup: { status: 'running' } }),
    catchupStatus: async () => ({
      status: 'failed',
      error: 'old staging data is not discoverable',
    }),
  };

  const result = await subscribeAndWait(
    client,
    'jenkins-publish-tests',
    'TestNode4',
    1000,
    0,
    ['failed'],
  );

  assert.equal(result.status, 'failed');
});

test('Query Remote succeeds when any acknowledged storage candidate serves the UAL', async () => {
  const calls = [];
  const client = {
    queryRemote: async (peerId) => {
      calls.push(peerId);
      return peerId === 'ack-peer-2'
        ? { status: 'OK', ntriples: '<urn:s> <urn:p> <urn:o> .' }
        : { status: 'OK', ntriples: '' };
    },
  };

  const readable = await queryAnyRemoteWithRetry(
    client,
    'jenkins-publish-tests',
    'did:dkg:base:84532/0xabc/1',
    [
      { peerId: 'ack-peer-1', name: 'StorageACK core 1' },
      { peerId: 'ack-peer-2', name: 'StorageACK core 2' },
    ],
    0,
    0,
  );

  assert.equal(readable.target.peerId, 'ack-peer-2');
  assert.deepEqual(calls.sort(), ['ack-peer-1', 'ack-peer-2']);
});
