import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parse } from 'yaml';

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

test('Windows builds once without EVM and still generates and verifies Gate 0', () => {
  const builds = job.steps.filter((step) => /run build\b/.test(step.run ?? ''));
  assert.equal(builds.length, 1);
  assert.match(builds[0].run, /--filter @origintrail-official\/dkg-agent\.\.\./);
  assert.match(builds[0].run, /--filter '!@origintrail-official\/dkg-evm-module'/);
  const generate = job.steps.find((step) => step.name === 'Run Gate 0 production persistence lifecycle');
  const verify = job.steps.find((step) => step.name === 'Verify Gate 0 persistence evidence');
  assert.equal(generate.if, "matrix.group == 'inventory'");
  assert.equal(verify.if, generate.if);
  assert.equal(generate.run, 'node --experimental-sqlite --import tsx devnet/rfc64-persistence-lifecycle/run.ts');
  assert.equal(verify.run, 'pnpm test:gate0:rfc64-persistence-lifecycle:verify');
  assert.ok(job.steps.indexOf(builds[0]) < job.steps.indexOf(generate));
  assert.ok(job.steps.indexOf(generate) < job.steps.indexOf(verify));
});
