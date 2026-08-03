import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_LIVE_ADAPTER_TIMEOUT_MS,
  resolveLiveAdapterTimeoutMs,
} from './live-launcher-config.ts';

test('live launcher gives the shipped 20-minute operation a 25-minute boundary', () => {
  assert.equal(resolveLiveAdapterTimeoutMs(undefined), 25 * 60_000);
  assert.equal(resolveLiveAdapterTimeoutMs('  '), DEFAULT_LIVE_ADAPTER_TIMEOUT_MS);
});

test('live launcher honors an explicit bounded runtime override', () => {
  assert.equal(resolveLiveAdapterTimeoutMs('300000'), 300_000);
  assert.throws(
    () => resolveLiveAdapterTimeoutMs('1.5'),
    /DKG_RFC64_M1_ADAPTER_TIMEOUT_MS must be an integer/,
  );
});
