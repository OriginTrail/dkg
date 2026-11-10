// The large graph catalog fixture: its own CI job, on both engines, required
// by the CI gate and started by every change the Blazegraph lane covers.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import test from 'node:test';
import { parse } from 'yaml';
import { change, pullRequestPlan } from './ci-plan-fixtures.mjs';

const read = (file) => fs.readFileSync(new URL(`../../../${file}`, import.meta.url), 'utf8');
const FIXTURE = 'packages/query/test-live/large-catalog.test.ts';
const CONFIG = '--config vitest.large-catalog.config.ts';
const GATE_STEP = 'Require the large graph catalog fixture where the Blazegraph lane runs';

test('the CI gate fails a selected Blazegraph lane unless the large catalog fixture succeeded', () => {
  const step = parse(read('.github/workflows/ci.yml')).jobs['ci-gate'].steps.find(({ name }) => name === GATE_STEP);
  assert.ok(step, 'the CI gate has its own step for the fixture');
  assert.equal(step.if, 'always()');
  assert.deepEqual(step.env, {
    BLAZEGRAPH_LANE: '${{ needs.changes.outputs.tornado_blazegraph }}',
    LARGE_CATALOG_RESULT: '${{ needs.tornado-large-catalog.result }}',
  });
  const verdict = (lane, result) => spawnSync('bash', ['-e', '-c', step.run], {
    env: { ...process.env, BLAZEGRAPH_LANE: lane, LARGE_CATALOG_RESULT: result },
  }).status;
  assert.equal(verdict('true', 'success'), 0);
  for (const result of ['failure', 'cancelled', 'skipped', '']) assert.notEqual(verdict('true', result), 0, result);
  // A plan without the lane does not run the job.
  assert.equal(verdict('false', 'skipped'), 0);
});

test('the large catalog fixture runs once per engine in its own job, which the CI gate requires', () => {
  const { jobs } = parse(read('.github/workflows/ci.yml'));
  const job = jobs['tornado-large-catalog'];
  assert.equal(job.if, "needs.changes.outputs.tornado_blazegraph == 'true'");
  assert.ok(jobs['ci-gate'].needs.includes('tornado-large-catalog'));
  const steps = job.steps.filter(({ run = '' }) => run.includes(CONFIG));
  const route = JSON.parse(read('test-policy/test-routes.json')).find(({ pattern }) => pattern === FIXTURE);
  assert.equal(route.cadence, 'required');
  assert.deepEqual(steps.map(({ run }) => run), route.command.split(' && '));
  assert.match(steps[0].env.BLAZEGRAPH_TEST_URL, /^http:\/\/127\.0\.0\.1:9999\/bigdata\/namespace\/kb\/sparql$/);
  assert.ok(steps[0].run.startsWith('DKG_REQUIRE_BLAZEGRAPH=1 '), 'the Blazegraph run must not fall back to Oxigraph');
  assert.ok(steps[1].run.startsWith('DKG_LARGE_CATALOG_ENGINE=oxigraph '));
  // The Oxigraph run reports even when the Blazegraph run failed.
  assert.equal(steps[1].if, '${{ !cancelled() }}');
  for (const step of steps) assert.ok(Number.isInteger(step['timeout-minutes']) && step['timeout-minutes'] < job['timeout-minutes']);
  // Not in the Blazegraph job too: that job is close to its time limit.
  assert.ok(jobs['tornado-blazegraph'].steps.every(({ run = '' }) => !run.includes(CONFIG)));
});

test('a change to the fixture, or to the catalog and query code it exercises, starts its job', () => {
  for (const file of [
    FIXTURE,
    'packages/query/test-live/large-catalog-fixture.ts',
    'packages/query/vitest.large-catalog.config.ts',
    'packages/query/src/query-store-read-context.ts',
    'packages/storage/src/graph-set-index-store.ts',
    'packages/storage/src/adapters/blazegraph.ts',
  ]) {
    assert.equal(pullRequestPlan([change(file)]).lanes.tornado_blazegraph, true, file);
  }
});
