import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { parse } from 'yaml';

const workflow = parse(fs.readFileSync(new URL('../../../.github/workflows/package-certification.yml', import.meta.url), 'utf8'));
const job = workflow.jobs.certify;
const PUSH_SHA = 'a'.repeat(40);
const MANUAL_SHA = 'b'.repeat(40);

// These workflow expressions use string context lookups and &&, ||, == only,
// whose behavior for the string/boolean fixtures here matches Actions. Evaluate
// the expression read from YAML, rather than duplicating the selection policy.
function expand(template, context) {
  return template.replace(/\$\{\{([\s\S]*?)\}\}/g, (_match, expression) => {
    assert.match(expression, /^[\w\s.'=&|]+$/);
    return vm.runInNewContext(expression.trim(), context, { timeout: 100 });
  });
}

function candidate(eventName, input = '') {
  return expand(job.env.CANDIDATE, {
    github: { event_name: eventName, sha: PUSH_SHA },
    inputs: { candidate: input },
  });
}

function validateCandidate(value) {
  const validation = job.steps.find((step) => step.name === 'Validate certification source identity');
  assert.ok(validation, 'validate the selected identity before checkout');
  return spawnSync('bash', ['-c', validation.run], { env: { ...process.env, CANDIDATE: value } }).status;
}

test('package certification automatically runs on every main push, with manual rehearsal retained', () => {
  assert.deepEqual(workflow.on.push, { branches: ['main'] });
  assert.deepEqual(workflow.on.workflow_dispatch.inputs.candidate, {
    description: 'Full candidate commit SHA containing the certification tooling', required: true, type: 'string',
  });
  assert.equal(job.if, undefined, 'automatic activation must not be disabled by a job condition');
});

test('push certification selects the pushed SHA even when a different candidate is supplied', () => {
  assert.equal(candidate('push'), PUSH_SHA);
  assert.equal(candidate('push', MANUAL_SHA), PUSH_SHA);
  assert.equal(validateCandidate(candidate('push')), 0);
});

test('manual certification selects its candidate, not the workflow commit, and rejects invalid identities', () => {
  assert.equal(candidate('workflow_dispatch', MANUAL_SHA), MANUAL_SHA);
  assert.equal(validateCandidate(candidate('workflow_dispatch', MANUAL_SHA)), 0);
  for (const input of ['', 'main', '1234567', `${MANUAL_SHA}; echo ignored`]) {
    assert.notEqual(validateCandidate(candidate('workflow_dispatch', input)), 0);
  }
});

test('both event paths use the selected identity for checkout, certification, negative control and evidence', () => {
  const checkout = job.steps.find((step) => step.uses?.startsWith('actions/checkout@'));
  const artifact = job.steps.find((step) => step.uses?.startsWith('actions/upload-artifact@'));
  assert.ok(checkout);
  assert.ok(artifact);
  assert.ok(job.steps.indexOf(checkout) > 0, 'identity validation precedes checkout');
  const certify = job.steps.find((step) => step.name === 'Certify both actual npm layouts').run;
  const negative = job.steps.find((step) => step.name === 'Prove missing installed asset fails').run;
  const commands = `${certify}\n${negative}`.replace(/\\\n\s*/g, ' ')
    .split('\n').filter((line) => /pnpm release:(certify-install|verify-package-certificate)/.test(line));
  assert.equal(commands.length, 3);
  for (const command of commands) assert.match(command, /--commit "\$CANDIDATE"(?:\s|;)/);
  assert.match(commands[2], /--negative-control missing-ui/);
  for (const [eventName, input, expected] of [['push', '', PUSH_SHA], ['workflow_dispatch', MANUAL_SHA, MANUAL_SHA]]) {
    const context = { env: { CANDIDATE: candidate(eventName, input) }, github: { run_id: '42', run_attempt: '2' } };
    assert.equal(expand(checkout.with.ref, context), expected);
    assert.equal(expand(artifact.with.name, context), `installed-packages-${expected}-42-2`);
  }
  for (const step of job.steps) assert.equal(step.env?.CANDIDATE, undefined, 'steps must not override the shared candidate');
});
