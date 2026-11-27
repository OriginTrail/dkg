import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveCiProfile } from '../../ci/resolve-ci-profile.mjs';
import { planCi } from '../ci-delta.mjs';

test('schedule and explicit dispatch resolve identical execution settings and full plans', () => {
  const scheduled = resolveCiProfile({ eventName: 'schedule', runNumber: '13064' });
  const dispatched = resolveCiProfile({ eventName: 'workflow_dispatch', profile: 'nightly-equivalent', seed: '13064' });
  assert.deepEqual(dispatched, scheduled);
  assert.equal(scheduled.requestedTrials, 1000);
  assert.equal(scheduled.managedLocal, true);
  for (const eventName of ['schedule', 'workflow_dispatch']) assert.equal(planCi({ eventName }).mode, 'full');
});

test('ordinary events retain their seed, budget, local-suite exclusion and planner behavior', () => {
  for (const eventName of ['pull_request', 'merge_group', 'push', 'workflow_dispatch']) {
    assert.deepEqual(resolveCiProfile({ eventName }), {
      schemaVersion: 1, profile: 'standard', seed: 640905, requestedTrials: 100, managedLocal: false,
    });
  }
  assert.equal(planCi({ eventName: 'pull_request', changeEntries: [{ status: 'M', paths: ['README.md'] }] }).mode, 'docs-only');
});

test('signed seeds including zero are reproducible; malformed seeds and profiles fail closed', () => {
  for (const seed of ['0', '-2147483648', '2147483647', '13064']) {
    assert.equal(resolveCiProfile({ eventName: 'workflow_dispatch', seed }).seed, Number(seed));
  }
  for (const seed of [' ', '1.5', '1e3', '+1', '01', '2147483648', '-2147483649', 'NaN', '1\nx=2']) {
    assert.throws(() => resolveCiProfile({ eventName: 'workflow_dispatch', seed }), /seed/);
  }
  assert.throws(() => resolveCiProfile({ eventName: 'workflow_dispatch', profile: 'nightly' }), /Unknown/);
  assert.throws(() => resolveCiProfile({ eventName: 'push', profile: 'nightly-equivalent' }), /require/);
  assert.throws(() => resolveCiProfile({ eventName: 'schedule' }), /seed/);
});
