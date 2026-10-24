import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { parse } from 'yaml';
import { LIFECYCLE_FILE, LIFECYCLE_TESTS, LIFT_TEST, browserExecutions, summarizeNightlyProfile } from '../../ci/nightly-profile-results.mjs';
import { resolveCiProfile } from '../../ci/resolve-ci-profile.mjs';

const subject = 'a'.repeat(40);
const workflow = parse(fs.readFileSync(new URL('../../../.github/workflows/ci.yml', import.meta.url), 'utf8'));
function packet() {
  return {
    profile: { ...resolveCiProfile({ eventName: 'schedule', runNumber: '13064' }), subject },
    needs: Object.fromEntries(['changes', 'tornado-publisher', 'kosava-node-ui-e2e'].map(job => [job, { result: 'success' }])),
    browsers: Array.from({ length: 7 }, (_, index) => ({ shard: index + 1,
      runtime: { subject, profile: 'nightly-equivalent', managedLocal: true, seed: '13064', requestedTrials: '1000' },
      tests: (index === 2 ? LIFECYCLE_TESTS : ['another test']).map(title => ({
      title, identity: title, file: index === 2 ? LIFECYCLE_FILE : 'other.spec.ts', project: 'real-node', expectedStatus: 'passed',
      attempts: [{ status: 'passed', durationMs: 10 }],
    })) })),
    campaigns: [{ schemaVersion: 1, identity: LIFT_TEST, subject, profile: 'nightly-equivalent', status: 'passed',
      seed: 13064, requestedTrials: 1000, completedTrials: 1000, interrupted: false, numSkips: 0, durationMs: 42000 }],
  };
}

test('complete actual executions certify; missing/skipped/cancelled/zero discovery never do', () => {
  assert.equal(summarizeNightlyProfile(packet()).status, 'passed');
  const mutations = [
    p => { p.browsers = []; },
    p => { p.browsers[0].tests = []; },
    p => { p.browsers[2].tests.pop(); },
    p => { p.browsers[2].tests[0].attempts = []; },
    p => { p.browsers[2].tests[0].attempts[0].status = 'skipped'; },
    p => { p.browsers[2].tests[0].expectedStatus = 'failed'; },
    p => { p.browsers[2].tests[0].attempts[0].status = 'timedOut'; },
    p => { p.browsers[2].tests[0].attempts[0].status = 'interrupted'; },
    p => { p.campaigns = []; },
    p => { p.campaigns[0].status = 'running'; },
    p => { p.campaigns[0].status = 'failed'; },
    p => { p.campaigns[0].completedTrials = 999; },
    p => { p.campaigns[0].seed = 1; },
    p => { p.campaigns[0].subject = 'b'.repeat(40); },
    p => { p.campaigns[0].interrupted = true; },
    p => { p.campaigns[0].numSkips = 1; },
    p => { delete p.needs['tornado-publisher']; },
    p => { p.needs['kosava-node-ui-e2e'].result = 'cancelled'; },
  ];
  for (const mutate of mutations) {
    const input = packet(); mutate(input);
    assert.equal(summarizeNightlyProfile(input).status, 'failed', String(mutate));
  }
});

test('a failed property remains visible alongside missing browser evidence', () => {
  const input = packet(); input.browsers = []; input.campaigns[0].status = 'failed';
  input.needs['tornado-publisher'].result = 'failure';
  const result = summarizeNightlyProfile(input);
  assert.match(result.errors.join('\n'), /browser shard/);
  assert.match(result.errors.join('\n'), /campaign failed/);
  assert.match(result.errors.join('\n'), /tornado-publisher: failure/);
});

test('browser records retain timed-out and skipped attempts in the denominator', () => {
  const tests = browserExecutions({ suites: [{ title: 'lifecycle', specs: ['passed', 'timedOut', 'skipped'].map(status => ({
    title: status, file: LIFECYCLE_FILE, tests: [{ projectName: 'real-node', expectedStatus: 'passed', results: [{ status, duration: 12, retry: 0 }] }],
  })) }] });
  assert.equal(tests.length, 3);
  assert.deepEqual(tests.map(t => t.attempts[0].status), ['passed', 'timedOut', 'skipped']);
});

test('the existing aggregate gate requires the profile verdict even if coverage also fails', () => {
  const gate = workflow.jobs['ci-gate'];
  assert.ok(gate.needs.includes('profile-results'));
  const step = gate.steps.find(s => s.name === 'Require the execution profile verdict');
  assert.equal(step.if, 'always()');
  assert.equal(step.env.PROFILE_RESULT, '${{ needs.profile-results.result }}');
  for (const result of ['success', 'failure', 'cancelled', 'skipped', '']) {
    const executed = spawnSync('bash', ['-e', '-c', step.run], { env: { ...process.env, PROFILE_RESULT: result } });
    assert.equal(executed.status === 0, result === 'success');
  }
  assert.equal(gate.steps.find(s => s.name === 'Verify selected lanes completed').if, 'always()');
});

test('profile settings drive all package jobs; candidate refs and controller pins cannot diverge', () => {
  for (const [name, job] of Object.entries(workflow.jobs)) {
    if (job.needs && job.steps && !['profile-results'].includes(name)) {
      assert.equal(job.env.DKG_PROPERTY_RUNS, '${{ needs.changes.outputs.property_runs }}', name);
      assert.equal(job.env.DKG_PROPERTY_SEED, '${{ needs.changes.outputs.property_seed }}', name);
    }
    for (const step of job.steps ?? []) if (step.uses?.startsWith('actions/checkout@')) {
      assert.equal(step.with.ref, step.with.path === 'trusted-ci' ? '8af04a376332c17527ce0f7dffaac8432ba1a9b3' : '${{ github.sha }}', name);
    }
  }
  assert.equal(workflow.jobs['kosava-node-ui-e2e'].env.PW_DEVNET_LOCAL, '${{ needs.changes.outputs.managed_local }}');
  const steps = workflow.jobs.changes.steps;
  assert.ok(steps.findIndex(s => s.id === 'profile') > steps.findIndex(s => s.id === 'plan'));
  assert.equal(workflow.concurrency['cancel-in-progress'], true);
  // Evaluate the actual workflow's group expression over representative events.
  function group(event, profile = '') {
    const github = { workflow: 'CI', ref: 'refs/heads/candidate', event_name: event, event: { pull_request: {} } };
    const inputs = { profile };
    return workflow.concurrency.group.replace(/\$\{\{(.*?)\}\}/g, (_, expression) => Function('github', 'inputs', `return (${expression})`)(github, inputs));
  }
  assert.equal(group('schedule'), group('workflow_dispatch', 'nightly-equivalent'));
  assert.notEqual(group('push'), group('schedule'));
  assert.equal(group('push'), group('workflow_dispatch', 'standard'));
});
