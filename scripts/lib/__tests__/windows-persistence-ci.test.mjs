import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { discoverTestSurface, secondaryRoutes } from '../test-inventory-surface.mjs';

const workflow = parse(readFileSync(new URL('../../../.github/workflows/rfc64-inventory-windows.yml', import.meta.url), 'utf8'));
const ciWorkflow = parse(readFileSync(new URL('../../../.github/workflows/ci.yml', import.meta.url), 'utf8'));
const job = workflow.jobs['inventory-lifecycle'];

test('the Windows gate runs directly for integration pushes and through CI for pull requests', () => {
  assert.ok(Object.hasOwn(workflow.on, 'workflow_call'));
  assert.deepEqual(workflow.on.push.branches, ['integration/rfc64-devnet']);
  assert.ok(workflow.on.push.paths.includes('packages/agent/**'));
  assert.equal(workflow.on.pull_request, undefined);
  assert.deepEqual(ciWorkflow.on.pull_request.branches, ['main', 'testnet-canary']);
  assert.equal(ciWorkflow.jobs['inventory-windows'].uses, './.github/workflows/rfc64-inventory-windows.yml');
  assert.equal(ciWorkflow.jobs['inventory-windows'].if, "needs.changes.outputs.tornado_agent == 'true'");
});

test('Windows groups retain every original test selector exactly once', () => {
  const originalSelectors = [
    'test/finalization-recovery-sqlite-deferred.test.ts',
    'test/finalization-recovery-sqlite-migration.test.ts',
    'test/finalization-recovery-sqlite-store.test.ts',
    'test/rfc64-inventory-v1',
    'test/rfc64-agent-inventory-lifecycle.test.ts',
    'test/rfc64-author-catalog-producer.test.ts',
    'test/rfc64-control-object-store-v1.test.ts',
    'test/rfc64-control-object-store-lifecycle-v1.test.ts',
    'test/rfc64-durable-file-store-v1.test.ts',
    'test/rfc64-secure-filesystem-policy-v1.test.ts',
  ];
  assert.equal(job['runs-on'], 'windows-latest');
  assert.equal(job.strategy['fail-fast'], false);
  const selectors = job.strategy.matrix.include.flatMap((group) => group.tests.trim().split(/\s+/));
  assert.deepEqual(selectors.sort(), originalSelectors.sort());
  assert.equal(new Set(selectors).size, selectors.length);
  assert.match(job.steps.find((step) => step.name === 'Run SQLite persistence tests').run,
    /--config vitest\.unit\.config\.ts\s+\$\{\{ matrix.tests \}\}/);
});

const scripts = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')).scripts;
const prefix = 'test:gate0:rfc64-persistence-lifecycle';
const harnessDir = 'devnet/rfc64-persistence-lifecycle';
const unitNames = ['evidence', 'process-lifecycle', 'verifier'];
const unitFiles = unitNames.map((name) => `${harnessDir}/${name}.test.ts`);
const routes = JSON.parse(readFileSync(new URL('../../../test-policy/test-routes.json', import.meta.url), 'utf8'));
const unitRoute = routes.find((entry) => entry.command === `pnpm ${prefix}:unit`);

test('canonical scripts retain developer build/generate/verify composition', () => {
  assert.equal(scripts[prefix], `pnpm run ${prefix}:generate && pnpm run ${prefix}:verify`);
  assert.equal(scripts[`${prefix}:generate`], `pnpm run ${prefix}:build && pnpm run ${prefix}:generate:only`);
  assert.match(scripts[`${prefix}:build`], /--filter @origintrail-official\/dkg-agent\.\.\./);
  assert.match(scripts[`${prefix}:build`], /--filter '!@origintrail-official\/dkg-evm-module'/);
  assert.equal(scripts[`${prefix}:generate:only`], 'node --experimental-sqlite --import tsx devnet/rfc64-persistence-lifecycle/run.ts');
  assert.equal(scripts[`${prefix}:unit`], `node --import tsx --test ${unitFiles.join(' ')}`);
});

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

test('the required unit route owns exactly the unit files across the repository', () => {
  assert.ok(unitRoute, `expected a test route for pnpm ${prefix}:unit`);
  assert.equal(unitRoute.lane, 'inventory-windows');
  assert.equal(unitRoute.cadence, 'required');
  // Resolve exactly as `pnpm test:inventory` does: no earlier route (such as
  // devnet/**) may shadow a unit file, and a widened pattern may not claim any other test.
  const resolved = secondaryRoutes(discoverTestSurface(repoRoot), routes);
  const owned = [...resolved].filter(([, route]) => route.pattern === unitRoute.pattern).map(([file]) => file);
  assert.deepEqual(owned.sort(), [...unitFiles].sort());
});

test('every Gate 0 harness test, including subdirectories, is a unit file', () => {
  // This also catches a missing unit file, which `node --test` silently skips
  // while any other listed path exists.
  assert.deepEqual(discoverTestSurface(repoRoot, [harnessDir]).sort(), [...unitFiles].sort());
});

test('the Gate 0 unit tests also run on the Linux agent sidecar shard', () => {
  // Windows skips the POSIX-only cases; the sidecar shard runs every case.
  const posix = ciWorkflow.jobs['tornado-agent'].steps.find((step) => step.run === `pnpm ${prefix}:unit`);
  assert.equal(posix?.if, 'matrix.sidecars');
});

test('each matrix leg builds once and only inventory runs named evidence steps', () => {
  const build = job.steps.find((step) => step.run === `pnpm ${prefix}:build`);
  assert.ok(build);
  assert.equal(build.if, undefined);
  assert.equal(job.steps.filter((step) => step.run === build.run).length, 1);
  assert.equal(job['timeout-minutes'], 40);
  const expectedCommands = [
    'pnpm typecheck:devnet:rfc64-evidence',
    'pnpm test:devnet:rfc64-evidence',
    'pnpm typecheck:gate0:rfc64-persistence-lifecycle',
    `pnpm ${prefix}:unit`,
    `pnpm ${prefix}:generate:only`,
    `pnpm ${prefix}:verify`,
    'pnpm exec tsc --noEmit --target ES2022 --module NodeNext --moduleResolution NodeNext --types node,vitest/globals --skipLibCheck packages/agent/test/rfc64-inventory-v1-lifecycle.test.ts packages/agent/test/fixtures/rfc64-inventory-v1-child.ts',
  ];
  const evidence = job.steps.filter((step) => step.if === 'matrix.evidence');
  assert.deepEqual(evidence.map((step) => step.run), expectedCommands);
  assert.equal(job.steps.filter((step) => step.if).length, evidence.length);
  assert.ok(evidence.every((step) => step.name && !step['continue-on-error']));
  assert.ok(job.steps.indexOf(build) < job.steps.indexOf(evidence[0]));
  assert.equal(evidence.find((step) => step.run === `pnpm ${prefix}:generate:only`)['timeout-minutes'], 20);
  for (const group of job.strategy.matrix.include) {
    assert.equal(Boolean(group.evidence), group.group === 'inventory');
  }
});
