import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { parse } from 'yaml';
import { CI_MATRICES } from '../ci-lanes.mjs';
import { pullRequestPlan, change } from './ci-plan-fixtures.mjs';

const command = 'node --experimental-sqlite --import tsx scripts/repro/rfc64-catalog-durable-head.mts';
const read = (file) => fs.readFileSync(new URL(`../../../${file}`, import.meta.url), 'utf8');

test('catalog process-death campaign is required once in the reserved agent sidecar', () => {
  const job = parse(read('.github/workflows/ci.yml')).jobs['tornado-agent'];
  const steps = job.steps.filter(({ run }) => run === command);
  assert.equal(steps.length, 1, 'the parent campaign must run, not the disposable worker directly');
  assert.equal(steps[0].if, 'matrix.sidecars');
  assert.notEqual(steps[0]['continue-on-error'], true);
  assert.equal(job['timeout-minutes'], '${{ matrix.timeoutMinutes }}');
  const selected = CI_MATRICES['tornado-agent'].include.filter(({ sidecars }) => sidecars);
  assert.equal(selected.length, 1);
  assert.ok(Number.isInteger(steps[0]['timeout-minutes']) && steps[0]['timeout-minutes'] > 0);
  assert.ok(selected.every(({ timeoutMinutes }) => Number.isInteger(timeoutMinutes)
    && steps[0]['timeout-minutes'] <= timeoutMinutes));
  const route = JSON.parse(read('test-policy/test-routes.json'))
    .find(({ pattern }) => pattern === 'packages/agent/campaigns/catalog-durable-head.test.ts');
  assert.equal(route.cadence, 'required');
  assert.equal(route.command, command);
});

test('campaign parent, isolated worker and fixture edits select their required agent lane', () => {
  for (const file of [
    'scripts/repro/rfc64-catalog-durable-head.mts',
    'packages/agent/campaigns/catalog-durable-head.test.ts',
    'packages/agent/vitest.catalog-durability.config.ts',
    'packages/agent/test/helpers/catalog-durability-scenario.ts',
    'packages/agent/test/helpers/native-gate1-fixture.ts',
  ]) assert.equal(pullRequestPlan([change(file)]).lanes.tornado_agent, true, file);
});
