import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { discoverTestSurface, isTestSurface, secondaryRoutes } from '../test-inventory-surface.mjs';

// Route ownership for a specific CI obligation is pinned beside its workflow wiring,
// e.g. the Gate 0 unit route in windows-persistence-ci.test.mjs.

test('shell drivers and Python/YAML suites cannot disappear when their execution route is removed', () => {
  const files = ['scripts/devnet-test-publish.sh', 'ccl_v0_1/tests/run_all_tests.py', 'ccl_v0_1/tests/cases/owner.yaml', 'packages/adapter-hermes/pytests/test_cli.py', 'README.md'];
  const surface = files.filter(isTestSurface);
  assert.deepEqual(surface, files.slice(0, 4));
  const registrations = surface.map((file) => ({ pattern: file, reason: 'fixture', command: `run ${file}`, cadence: 'manual' }));
  assert.deepEqual(surface.filter((file) => !secondaryRoutes(surface, registrations).has(file)), []);
  registrations.shift();
  assert.deepEqual(surface.filter((file) => !secondaryRoutes(surface, registrations).has(file)), ['scripts/devnet-test-publish.sh']);
  assert.throws(() => secondaryRoutes(surface, [{ pattern: 'missing.test.ts', reason: 'fixture', command: 'run', cadence: 'manual' }]), /stale test route/);
});

function fixture(t, entrypoints = ['campaigns/restart.mts']) {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'test-entrypoints-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q'], { cwd: root });
  for (const directory of ['test-policy', 'campaigns', 'test']) fs.mkdirSync(path.join(root, directory));
  fs.writeFileSync(path.join(root, 'test-policy/standalone-test-entrypoints.json'), JSON.stringify(entrypoints));
  for (const file of ['campaigns/restart.mts', 'campaigns/worker.mts', 'test/ordinary.test.ts']) {
    fs.writeFileSync(path.join(root, file), '// fixture\n');
  }
  return root;
}

test('standalone policy adds entrypoints independently of conventions, routes and scoped discovery', t => {
  const root = fixture(t);
  assert.deepEqual(discoverTestSurface(root).sort(), ['campaigns/restart.mts', 'test/ordinary.test.ts']);
  assert.deepEqual(discoverTestSurface(root, ['test']), ['test/ordinary.test.ts']);
  const campaign = discoverTestSurface(root, ['campaigns']);
  assert.deepEqual(campaign, ['campaigns/restart.mts']);
  const owned = secondaryRoutes(campaign, []);
  assert.deepEqual(campaign.filter(file => !owned.has(file)), campaign);
});

test('stale, ignored, duplicate and malformed standalone declarations fail discovery', t => {
  for (const entrypoints of [null, ['missing.mts'], ['campaigns/restart.mts', 'campaigns/restart.mts'],
    [7], ['../outside.mts'], ['/absolute.mts']]) {
    const root = fixture(t, entrypoints);
    assert.throws(() => discoverTestSurface(root), /standalone test entrypoint/);
  }
  const ignored = fixture(t);
  fs.writeFileSync(path.join(ignored, '.gitignore'), 'campaigns/restart.mts\n');
  assert.throws(() => discoverTestSurface(ignored), /standalone test entrypoint/);
  const deleted = fixture(t);
  fs.unlinkSync(path.join(deleted, 'campaigns/restart.mts'));
  assert.throws(() => discoverTestSurface(deleted, ['test']), /standalone test entrypoint/);
});
