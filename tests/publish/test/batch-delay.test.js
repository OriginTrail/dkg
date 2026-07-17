import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isStoreSchedulerBusy,
  waitBetweenPublishBatches,
} from '../src/v10-publish-lib.js';

test('isStoreSchedulerBusy recognizes only the retry-safe scheduler rejection', () => {
  assert.equal(isStoreSchedulerBusy(new Error('Store scheduler queue wait timeout (normal: blazegraph.query)')), true);
  assert.equal(isStoreSchedulerBusy({ body: { code: 'STORE_SCHEDULER_BUSY' } }), true);
  assert.equal(isStoreSchedulerBusy(new Error('storage_ack_timeout: only 1/3 ACKs received')), false);
});

test('waitBetweenPublishBatches applies the configured delay before another KA', async () => {
  const waits = [];

  const waited = await waitBetweenPublishBatches(0, 2, 10_000, async (delayMs) => {
    waits.push(delayMs);
  });

  assert.equal(waited, true);
  assert.deepEqual(waits, [10_000]);
});

test('waitBetweenPublishBatches does not delay after the final KA or when disabled', async () => {
  let sleepCalls = 0;
  const sleepFn = async () => { sleepCalls++; };

  assert.equal(await waitBetweenPublishBatches(1, 2, 10_000, sleepFn), false);
  assert.equal(await waitBetweenPublishBatches(0, 2, 0, sleepFn), false);
  assert.equal(sleepCalls, 0);
});
