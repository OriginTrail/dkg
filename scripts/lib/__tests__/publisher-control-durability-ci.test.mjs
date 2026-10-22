import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import test from 'node:test';
import { parse } from 'yaml';
import { CI_MATRICES } from '../ci-lanes.mjs';
import { discoverTestSurface, isTestSurface, secondaryRoutes } from '../test-inventory-surface.mjs';
import { REPO_ROOT, TRUSTED_CI_CONTROLLER_SHA, gateNeeds, succeeded, pullRequestPlan, change } from './ci-plan-fixtures.mjs';
import { CONTROLLER_POLICY_FILES } from '../../ci/trusted-controller-pins.mjs';

const parent = 'scripts/repro/publisher-live-control-restart.test.mts';
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
    .flatMap(({ run = '' }) => run.split('\n'))
    .filter(line => /^\s*node\s/.test(line) && line.includes(parent)).length, 1);
});

test('publisher campaign inputs and its runtime select the required CLI lane', () => {
  for (const file of [parent, worker, 'scripts/testing/owned-process.mjs', 'scripts/testing/ka-vm-publish.ts',
    'packages/cli/src/publisher-runner.ts', 'packages/cli/src/publisher-live-control.ts',
    'packages/cli/src/daemon/routes/publisher-live-control.ts', 'packages/cli/src/daemon/teardown.ts',
    'packages/publisher/src/index.ts', 'packages/storage/src/index.ts']) {
    assert.equal(pullRequestPlan([change(file)]).lanes.bura_cli, true, file);
  }
});

test('actual workflow routes campaign-only diffs through the active trusted controller and gate', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'publisher-controller-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const candidate = path.join(root, 'candidate');
  const controller = path.join(root, 'trusted-ci');
  const workflow = parse(read('.github/workflows/ci.yml'));
  const steps = workflow.jobs.changes.steps;
  const pin = steps.find(step => step.with?.path === 'trusted-ci').with.ref;
  assert.equal(pin, TRUSTED_CI_CONTROLLER_SHA);
  for (const file of CONTROLLER_POLICY_FILES) {
    fs.mkdirSync(path.dirname(path.join(controller, file)), { recursive: true });
    fs.writeFileSync(path.join(controller, file), execFileSync('git', ['-C', REPO_ROOT, 'show', `${pin}:${file}`]));
  }
  fs.mkdirSync(candidate);
  const git = (...args) => execFileSync('git', ['-C', candidate, '-c', 'user.name=ci', '-c', 'user.email=ci@example.invalid', ...args], { encoding: 'utf8' }).trim();
  git('init', '-q');
  const other = 'scripts/repro/publisher-live-control-worker.mts.backup';
  for (const file of [parent, worker, other, 'CHANGELOG.md', 'scripts/ci/plan-ci.mjs']) {
    fs.mkdirSync(path.dirname(path.join(candidate, file)), { recursive: true });
    fs.writeFileSync(path.join(candidate, file), 'throw new Error("candidate code must not execute");\n');
  }
  git('add', '.'); git('commit', '-qm', 'fixture base');
  const base = git('rev-parse', 'HEAD');
  const planScript = steps.find(step => step.id === 'plan').run;
  for (const scenario of [
    { file: parent, selected: true },
    { file: worker, selected: true },
    { from: worker, file: 'scripts/repro/renamed-worker.mts', selected: true },
    { from: other, file: parent, selected: true },
    { file: other, selected: false },
    { file: 'CHANGELOG.md', selected: false },
  ]) {
    git('reset', '--hard', base);
    if (scenario.from) {
      if (fs.existsSync(path.join(candidate, scenario.file))) {
        fs.rmSync(path.join(candidate, scenario.file));
        git('add', '-A'); git('commit', '-qm', 'fixture rename destination absent');
      }
      fs.renameSync(path.join(candidate, scenario.from), path.join(candidate, scenario.file));
    } else fs.appendFileSync(path.join(candidate, scenario.file), '// edit\n');
    git('add', '-A'); git('commit', '-qm', 'fixture change');
    const output = path.join(root, 'github-output');
    fs.writeFileSync(output, '');
    const result = spawnSync('bash', ['-c', planScript], { cwd: root, encoding: 'utf8', env: {
      ...process.env, EVENT_NAME: 'pull_request', DELTA_ENABLED: 'true', PR_LABELS: '[]',
      MERGE_SHA: git('rev-parse', 'HEAD'), RUNNER_TEMP: root, GITHUB_OUTPUT: output,
      GITHUB_STEP_SUMMARY: path.join(root, 'summary'),
    } });
    assert.equal(result.status, 0, result.stderr);
    const plan = JSON.parse(result.stdout);
    assert.equal(plan.lanes.bura_cli, scenario.selected, scenario.file);
    assert.match(fs.readFileSync(output, 'utf8'), new RegExp(`^bura_cli=${scenario.selected}$`, 'm'));
    if (!scenario.selected) continue;
    assert.equal(plan.mode, 'full', 'temporary fallback asks the trusted controller to widen the plan');
    const needs = gateNeeds(succeeded(Object.keys(gateNeeds())));
    const gate = () => spawnSync(process.execPath, [path.join(controller, 'scripts/ci/assert-ci-results.mjs'), '--workflow', 'primary'], {
      encoding: 'utf8', env: { ...process.env, EVENT_NAME: 'pull_request', PLAN_JSON: JSON.stringify(plan), NEEDS_JSON: JSON.stringify(needs) },
    });
    assert.equal(gate().status, 0);
    for (const status of ['skipped', 'failure', 'cancelled']) {
      needs['bura-cli'].result = status;
      const rejected = gate();
      assert.equal(rejected.status, 1, status);
      assert.match(rejected.stderr, /bura-cli/);
    }
    delete needs['bura-cli'];
    assert.equal(gate().status, 1, 'missing required CLI is rejected');
  }
});

test('publisher campaign is discoverable with an explicit required native execution route', () => {
  assert.equal(isTestSurface(parent), true, 'the parent uses the existing test suffix convention');
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
