import { test } from 'node:test';
import assert from 'node:assert/strict';
import { observeRestartRecoveryPoll } from './restart-observation.mjs';
const ready = { job: { state: 'succeeded' }, descriptor: { status: 200 },
  catalog: { appliedRowCount: '437', legacyReadOnlyCount: 0, phase: 'complete',
    authorityState: 'accepted', authorityFreshness: 'current' } };
test('successful responses delayed beyond the cutoff cannot pass restart recovery', async () => {
  const deadline = 20 * 60_000;
  let clock = deadline - 1_000, deliver;
  const response = new Promise(resolve => { deliver = resolve; });
  const poll = observeRestartRecoveryPoll(() => response, deadline, 437, () => clock);
  clock = deadline + 10_000; deliver(ready);
  const result = await poll;
  assert.equal(result.requestStartedAt, new Date(deadline - 1_000).toISOString());
  assert.equal(result.at, new Date(clock).toISOString());
  assert.equal(result.completedWithinDeadline, false);
  assert.equal(result.succeededBeforeDeadline, false);
});
test('complete evidence within the cutoff passes, incomplete evidence does not', async () => {
  assert.equal((await observeRestartRecoveryPoll(async () => ready, 100, 437, () => 100)).succeededBeforeDeadline, true);
  assert.equal((await observeRestartRecoveryPoll(async () => ({ ...ready, descriptor: { status: 404 } }), 100, 437, () => 99)).succeededBeforeDeadline, false);
});

for (const catalog of [
  { phase: 'unknown-freshness', authorityFreshness: 'unknown' },
  { phase: 'reconciling' }, { authorityState: 'pending' },
  { authorityFreshness: 'stale' }, { phase: undefined },
  { authorityState: undefined }, { authorityFreshness: undefined },
]) test(`matching counts cannot certify incomplete catalog ${JSON.stringify(catalog)}`, async () => {
  const incomplete = { ...ready, catalog: { ...ready.catalog, ...catalog } };
  assert.equal((await observeRestartRecoveryPoll(async () => incomplete, 100, 437, () => 99)).succeededBeforeDeadline, false);
  assert.equal((await observeRestartRecoveryPoll(async () => ready, 100, 437, () => 101)).succeededBeforeDeadline, false);
});
