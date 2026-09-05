import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { parse } from 'yaml';

const workflow = parse(fs.readFileSync(new URL('../../../.github/workflows/ci.yml', import.meta.url), 'utf8'));

test('tracked-text validation is unconditional in the required planning job and uses immutable scanner code', () => {
  const steps = workflow.jobs.changes.steps;
  const checkout = steps.find((step) => step.with?.path === 'trusted-text');
  assert.equal(checkout.with.repository, 'OriginTrail/dkg');
  assert.equal(checkout.with.ref, '6f6f6f4e73e965679bc534240d23a6947734d201');
  assert.match(checkout.uses, /^actions\/checkout@[a-f0-9]{40}$/);
  assert.equal(checkout.with['persist-credentials'], false);
  assert.equal(checkout.with['sparse-checkout'].trim(), 'scripts/ci/check-tracked-text-nul.mjs');
  const scan = steps.find((step) => step.name === 'Reject NUL bytes in tracked candidate text');
  assert.equal(scan.run, 'node trusted-text/scripts/ci/check-tracked-text-nul.mjs --repo candidate');
  assert.ok(steps.indexOf(checkout) < steps.indexOf(scan));
  for (const node of [workflow.jobs.changes, checkout, scan]) {
    assert.equal(node.if, undefined);
    assert.equal(node['continue-on-error'], undefined);
  }
  const gate = Object.values(workflow.jobs).find((job) => job.name === 'CI gate');
  assert.ok(gate.needs.includes('changes'));
  assert.ok(workflow.on.pull_request.branches.includes('testnet-canary'));
  assert.ok(Object.hasOwn(workflow.on, 'merge_group'));
});
