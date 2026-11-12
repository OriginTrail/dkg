import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parse } from 'yaml';

const workflow = parse(readFileSync(new URL('../../../.github/workflows/ci.yml', import.meta.url), 'utf8'));
const routes = JSON.parse(readFileSync(new URL('../../../test-policy/test-routes.json', import.meta.url), 'utf8'));
const job = workflow.jobs['kosava-node-ui-e2e'];
const command = 'pnpm --dir packages/node-ui exec playwright test --config playwright.marketplace.config.ts';

test('the NeuroSymbolic Marketplace lane runs once, as its own entry of the required browser job', () => {
  assert.deepEqual(job.strategy.matrix.include, [{ shard: 'marketplace' }]);
  const entries = job.steps.filter(step => step.run === command);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].if, "matrix.shard == 'marketplace'");
  assert.equal(entries[0]['continue-on-error'], undefined);
  assert.ok(job.steps.indexOf(entries[0]) > job.steps.findIndex(step => step.name === 'Restore devnet EVM artifacts'));
  assert.ok(job.steps.indexOf(entries[0]) > job.steps.findIndex(step => step.name === 'Install Playwright Chromium'));
  // The seven shards of the default suite skip the marketplace entry, and it skips them.
  const shards = job.steps.filter(step => (step.run ?? '').includes('playwright test --shard='));
  assert.equal(shards.length, 1);
  assert.equal(shards[0].if, "matrix.shard != 'marketplace'");
  assert.match(job.name, /matrix\.shard == 'marketplace' && 'marketplace' \|\| format\('\{0\}\/7', matrix\.shard\)/);
});

test('test inventory records the same required marketplace command', () => {
  const route = routes.find(entry => entry.pattern === 'packages/node-ui/e2e/marketplace/specs/*.spec.ts');
  assert.equal(route.command, command);
  assert.equal(route.lane, 'browser');
  assert.equal(route.cadence, 'required');
  assert.ok(route.prerequisites.includes('isolated local devnet'));
  assert.ok(route.prerequisites.includes('Playwright Chromium'));
});
