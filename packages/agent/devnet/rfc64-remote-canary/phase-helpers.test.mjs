// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import test from 'node:test';

import { RemoteCanaryError } from './errors.mjs';
import { isRetryableNodeRequestErrorV1, pollUntilV1 } from './phase-helpers.mjs';

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
