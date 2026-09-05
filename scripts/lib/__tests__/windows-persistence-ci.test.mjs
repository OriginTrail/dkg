import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parse } from 'yaml';
import { runPersistenceEvidence } from '../../ci/run-windows-persistence-evidence.mjs';

const workflow = parse(readFileSync(new URL('../../../.github/workflows/rfc64-inventory-windows.yml', import.meta.url), 'utf8'));
const job = workflow.jobs['inventory-lifecycle'];

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

test('Windows builds once and dispatches one inventory evidence phase', () => {
  const build = job.steps.find((step) => step.run === `pnpm ${prefix}:build`);
  const phase = job.steps.find((step) => step.run === 'pnpm ci:rfc64-persistence-evidence');
  assert.ok(build);
  assert.equal(job.steps.filter((step) => step.run === build.run).length, 1);
  assert.equal(phase.if, "matrix.group == 'inventory'");
  assert.equal(job.steps.filter((step) => step.if).length, 1);
  assert.ok(job.steps.indexOf(build) < job.steps.indexOf(phase));
  assert.equal(job['timeout-minutes'], 40);
  assert.equal(scripts['ci:rfc64-persistence-evidence'], 'node scripts/ci/run-windows-persistence-evidence.mjs');
  for (const event of ['push', 'pull_request']) {
    assert.ok(workflow.on[event].paths.includes('scripts/ci/run-windows-persistence-evidence.mjs'));
  }
});

test('canonical scripts retain developer build/generate/verify composition', () => {
  assert.equal(scripts[prefix], `pnpm run ${prefix}:generate && pnpm run ${prefix}:verify`);
  assert.equal(scripts[`${prefix}:generate`], `pnpm run ${prefix}:build && pnpm run ${prefix}:generate:only`);
  assert.match(scripts[`${prefix}:build`], /--filter @origintrail-official\/dkg-agent\.\.\./);
  assert.match(scripts[`${prefix}:build`], /--filter '!@origintrail-official\/dkg-evm-module'/);
  assert.equal(scripts[`${prefix}:generate:only`], 'node --experimental-sqlite --import tsx devnet/rfc64-persistence-lifecycle/run.ts');
});

test('evidence phase preserves ordering and generator timeout without a rebuild', async () => {
  const calls = [];
  await runPersistenceEvidence({ pnpm: '/tools/pnpm.cjs', run: (...args) => { calls.push(args); return { status: 0 }; } });
  assert.deepEqual(calls.map(([, args]) => args.slice(1, 3)), [
    ['exec', 'node'],
    ['run', 'typecheck:devnet:rfc64-evidence'],
    ['run', 'test:devnet:rfc64-evidence'],
    ['run', `typecheck:gate0:rfc64-persistence-lifecycle`],
    ['run', `${prefix}:generate:only`],
    ['run', `${prefix}:verify`],
    ['exec', 'tsc'],
  ]);
  assert.ok(calls.every(([command, args]) => command === process.execPath && args[0] === '/tools/pnpm.cjs'));
  assert.equal(calls[4][2].timeout, 20 * 60_000);
  assert.deepEqual(calls[0][1], ['/tools/pnpm.cjs', 'exec', 'node', '--test', 'scripts/lib/__tests__/process-tree-timeout.test.mjs']);
  assert.deepEqual(calls.at(-1)[1], ['/tools/pnpm.cjs', 'exec', 'tsc',
    '--noEmit', '--target', 'ES2022', '--module', 'NodeNext',
    '--moduleResolution', 'NodeNext', '--types', 'node,vitest/globals', '--skipLibCheck',
    'packages/agent/test/rfc64-inventory-v1-lifecycle.test.ts',
    'packages/agent/test/fixtures/rfc64-inventory-v1-child.ts',
  ]);
  for (const failure of [{ status: 1 }, { status: null, error: new Error('timeout') }]) {
    let count = 0;
    await assert.rejects(() => runPersistenceEvidence({ pnpm: '/tools/pnpm.cjs', run: () => {
      count += 1;
      return count === 5 ? failure : { status: 0 };
    } }), /Persistence evidence phase failed/);
    assert.equal(count, 5, 'verification never runs after unsuccessful generation');
  }
});
