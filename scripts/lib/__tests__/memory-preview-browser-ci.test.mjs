import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parse } from 'yaml';

const workflow = parse(readFileSync(new URL('../../../.github/workflows/ci.yml', import.meta.url), 'utf8'));
const routes = JSON.parse(readFileSync(new URL('../../../test-policy/test-routes.json', import.meta.url), 'utf8'));
const job = workflow.jobs['kosava-node-ui-e2e'];
const command = 'pnpm --dir packages/node-ui exec playwright test --config playwright.pr3236.config.ts';

test('standalone memory preview regressions run once in a required Chromium shard', () => {
  const entries = job.steps.filter(step => step.run === command);
  assert.equal(entries.length, 1);
  const step = entries[0];
  assert.equal(step.if, 'matrix.shard == 1');
  assert.ok(job.strategy.matrix.shard.includes(1));
  assert.equal(step['continue-on-error'], undefined);
  assert.ok(job.steps.indexOf(step) > job.steps.findIndex(entry => entry.name === 'Restore build outputs'));
  assert.ok(job.steps.indexOf(step) > job.steps.findIndex(entry => entry.name === 'Install Playwright Chromium'));
});

test('test inventory records the same required standalone browser command', () => {
  const route = routes.find(entry => entry.pattern === 'packages/node-ui/browser-regressions/pr3236/*.spec.ts');
  assert.equal(route.command, command);
  assert.equal(route.lane, 'browser');
  assert.equal(route.cadence, 'required');
  assert.ok(route.prerequisites.includes('built workspace dependencies'));
  assert.ok(route.prerequisites.includes('Playwright Chromium'));
});
