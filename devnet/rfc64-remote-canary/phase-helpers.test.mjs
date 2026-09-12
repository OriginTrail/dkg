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
  for (const [label, map, rejects] of [
    ['normal', mapCanaryPhaseV1, false],
    ['drained', mapCanaryPhaseDrainedV1, true],
  ]) {
    let active = 0;
    let peak = 0;
    let completed = 0;
    const operation = map(
      Array.from({ length: PHASE_CONCURRENCY + 5 }, (_, index) => index),
      async (index) => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setImmediate(resolve));
        active -= 1;
        completed += 1;
        if (rejects && index === 1) throw new Error('expected-drained-failure');
        return index;
      },
    );
    if (rejects) await assert.rejects(operation, /expected-drained-failure/u, label);
    else assert.deepEqual(await operation, Array.from({ length: 9 }, (_, index) => index), label);
    assert.equal(peak, PHASE_CONCURRENCY, label);
    assert.equal(completed, PHASE_CONCURRENCY + 5, label);
  }
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
