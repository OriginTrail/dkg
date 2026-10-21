import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { parse } from 'yaml';
import { CI_MATRICES } from '../ci-lanes.mjs';
import { discoverTestSurface, isTestSurface, secondaryRoutes } from '../test-inventory-surface.mjs';
import { REPO_ROOT, pullRequestPlan, change } from './ci-plan-fixtures.mjs';

const parent = 'scripts/repro/publisher-live-control-restart.mts';
const worker = 'scripts/repro/publisher-live-control-worker.mts';
const command = `node --experimental-sqlite --import tsx ${parent}`;
const read = (file) => fs.readFileSync(new URL(`../../../${file}`, import.meta.url), 'utf8');

test('publisher control process-death campaign runs once in required CLI CI with a deadline', () => {
  const workflow = parse(read('.github/workflows/ci.yml'));
  const job = workflow.jobs['bura-cli'];
  const steps = job.steps.filter(({ run }) => run === command);
  assert.equal(steps.length, 1, 'run the parent that owns all five workers, not a worker directly');
  assert.equal(steps[0].if, 'matrix.shard == 1');
  assert.equal(steps[0]['continue-on-error'] ?? false, false);
  assert.equal(job['continue-on-error'] ?? false, false);
  assert.ok(Number.isInteger(steps[0]['timeout-minutes'])
    && steps[0]['timeout-minutes'] > 0 && steps[0]['timeout-minutes'] <= 3);
  assert.equal(CI_MATRICES['bura-cli'].include.filter(({ shard }) => shard === 1).length, 1);
  assert.equal(Object.values(workflow.jobs).flatMap(({ steps = [] }) => steps)
    .filter(({ run = '' }) => run.includes(parent)).length, 1);
});

test('publisher campaign inputs and its runtime select the required CLI lane', () => {
  for (const file of [parent, worker, 'scripts/testing/owned-process.mjs', 'scripts/testing/ka-vm-publish.ts',
    'packages/cli/src/publisher-runner.ts', 'packages/cli/src/publisher-live-control.ts',
    'packages/cli/src/daemon/routes/publisher-live-control.ts', 'packages/cli/src/daemon/teardown.ts',
    'packages/publisher/src/index.ts', 'packages/storage/src/index.ts']) {
    assert.equal(pullRequestPlan([change(file)]).lanes.bura_cli, true, file);
  }
});

test('publisher campaign is discoverable with an explicit required native execution route', () => {
  assert.equal(isTestSurface(parent), false, 'campaign knowledge belongs to standalone inventory policy');
  assert.equal(isTestSurface(worker), false, 'a disposable worker is not a second campaign');
  const discovered = discoverTestSurface(REPO_ROOT, ['scripts/repro']);
  assert.deepEqual(discovered, [parent]);
  const registrations = JSON.parse(read('test-policy/test-routes.json'));
  const route = registrations.find(({ pattern }) => pattern === parent);
  assert.ok(route);
  assert.equal(route.cadence, 'required');
  assert.equal(route.command, command);
  assert.match(route.layer, /process/);
  assert.ok(route.prerequisites.length > 0);
  assert.equal(secondaryRoutes([parent], [route]).get(parent).command, command);
  const withoutRoute = secondaryRoutes(discovered, []);
  assert.deepEqual(discovered.filter(file => !withoutRoute.has(file)), [parent],
    'removing the route must leave an unowned discovered campaign');
});
