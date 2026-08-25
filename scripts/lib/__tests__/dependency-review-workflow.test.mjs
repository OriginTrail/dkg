import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const WORKFLOW_PATH = path.join(REPO_ROOT, '.github/workflows/dependency-review.yml');
const DEPENDENCY_REVIEW_ACTION = 'actions/dependency-review-action@a1d282b36b6f3519aa1f3fc636f609c47dddb294';

function assertDependencyReviewContract(workflow) {
  assert.deepEqual(workflow.on?.pull_request?.branches, ['main', 'testnet-canary']);
  assert.deepEqual(workflow.on?.merge_group?.types, ['checks_requested']);

  const job = workflow.jobs?.['dependency-review'];
  assert.ok(job, 'dependency-review job must exist');
  assert.equal(job.if, undefined, 'dependency-review job must not be disabled or event-gated');
  assert.ok(Array.isArray(job.steps), 'dependency-review job must contain steps');

  const actionSteps = job.steps.filter((step) => step?.uses === DEPENDENCY_REVIEW_ACTION);
  assert.equal(actionSteps.length, 1, 'job must invoke the expected SHA-pinned dependency-review action once');
  const [actionStep] = actionSteps;
  assert.equal(actionStep.if, undefined, 'dependency-review action must not be conditionally disabled');
  assert.deepEqual(actionStep.with, {
    'base-ref': '${{ github.event.pull_request.base.sha || github.event.merge_group.base_sha }}',
    'head-ref': '${{ github.event.pull_request.head.sha || github.event.merge_group.head_sha }}',
    'fail-on-severity': 'high',
    'fail-on-scopes': 'runtime, development, unknown',
    'retry-on-snapshot-warnings': true,
    'show-patched-versions': true,
  });
}

test('dependency review structurally gates PR and merge-queue candidates', () => {
  const workflow = parseYaml(fs.readFileSync(WORKFLOW_PATH, 'utf8'));
  assertDependencyReviewContract(workflow);

  // Re-serializing changes indentation and flow lists to block lists. The
  // semantic contract remains valid because it is independent of YAML style.
  assertDependencyReviewContract(parseYaml(stringifyYaml(workflow)));
});

test('dependency review contract rejects a replaced or disabled action', () => {
  const workflow = parseYaml(fs.readFileSync(WORKFLOW_PATH, 'utf8'));
  const actionStep = workflow.jobs['dependency-review'].steps[0];

  const replaced = structuredClone(workflow);
  replaced.jobs['dependency-review'].steps[0].uses = `attacker/action@${'1'.repeat(40)}`;
  assert.throws(() => assertDependencyReviewContract(replaced), /expected SHA-pinned/);

  const disabled = structuredClone(workflow);
  disabled.jobs['dependency-review'].steps[0].if = false;
  assert.throws(() => assertDependencyReviewContract(disabled), /must not be conditionally disabled/);
  assert.equal(actionStep.uses, DEPENDENCY_REVIEW_ACTION);
});
