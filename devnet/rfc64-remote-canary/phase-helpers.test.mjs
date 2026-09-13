// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import test from 'node:test';

import { RemoteCanaryError } from './errors.mjs';
import {
  PHASE_CONCURRENCY,
  isRetryableNodeRequestErrorV1,
  mapCanaryPhaseDrainedV1,
  mapCanaryPhaseV1,
  pollUntilV1,
} from './phase-helpers.mjs';

test('normal and drained phase mapping enforce the four-operation cap', async () => {
  let active = 0;
  let peak = 0;
  let completed = 0;
  const items = Array.from({ length: PHASE_CONCURRENCY + 5 }, (_, index) => index);
  const result = await mapCanaryPhaseV1(items, async (index) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setImmediate(resolve));
    active -= 1;
    completed += 1;
    return index;
  });
  assert.deepEqual(result, items);
  assert.equal(peak, PHASE_CONCURRENCY);
  assert.equal(completed, items.length);

  let releaseStarted;
  const startedMaySettle = new Promise((resolve) => { releaseStarted = resolve; });
  active = 0;
  peak = 0;
  const started = [];
  const drained = mapCanaryPhaseDrainedV1(items, async (index) => {
    started.push(index);
    active += 1;
    peak = Math.max(peak, active);
    if (index === 1) {
      active -= 1;
      throw new Error('expected-drained-failure');
    }
    await startedMaySettle;
    active -= 1;
    return index;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(active, PHASE_CONCURRENCY - 1);
  releaseStarted();
  await assert.rejects(drained, /expected-drained-failure/u);
  assert.ok(peak <= PHASE_CONCURRENCY);
  assert.equal(active, 0);
  assert.deepEqual(started, items.slice(0, PHASE_CONCURRENCY));
});

test('polling retries only explicitly classified failures', async () => {
  const transient = new RemoteCanaryError('node-request-failed', 'http');
  let attempts = 0;
  const result = await pollUntilV1(
    async () => {
      attempts += 1;
      if (attempts === 1) return false;
      if (attempts === 2) throw transient;
      return 'ready';
    },
    1_000,
    1,
    async () => undefined,
    () => new Error('timeout'),
    { retryError: isRetryableNodeRequestErrorV1 },
  );
  assert.equal(result, 'ready');
  assert.equal(attempts, 3);

  const invariant = new RemoteCanaryError('node-build-mismatch', 'preflight');
  await assert.rejects(
    pollUntilV1(
      async () => { throw invariant; },
      1_000,
      1,
      async () => undefined,
      () => new Error('timeout'),
    ),
    (error) => error === invariant,
  );
});
