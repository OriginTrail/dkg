import assert from 'node:assert/strict';
import test from 'node:test';
import { isTestSurface, secondaryRoutes } from '../test-inventory-surface.mjs';

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
