import assert from 'node:assert/strict';
import test from 'node:test';
import { playwrightExecutions } from '../playwright-executions.mjs';
import { summarizeBrowserQuality } from '../../ci/browser-quality.mjs';
import { browserExecutions } from '../../ci/nightly-profile-results.mjs';

test('nested identities, projects, expected status and every attempt survive both consumers', () => {
  const report = { suites: [{ title: 'flow.spec.ts', suites: [{ title: 'outer', suites: [{ title: 'inner', specs: [{
    id: 'stable-id', file: 'flow.spec.ts', title: 'journey', tests: [
      { projectName: 'real-node', expectedStatus: 'passed', results: [
        { status: 'timedOut', duration: 100, startTime: '2026-10-24T00:00:00Z', retry: 0 },
        { status: 'passed', duration: 20, startTime: '2026-10-24T00:00:01Z', retry: 1 },
      ] },
      { projectName: 'another-project', expectedStatus: 'failed', results: [{ status: 'failed', retry: 0 }] },
    ],
  }] }] }] }] };
  const executions = [...playwrightExecutions(report)];
  assert.deepEqual(executions[0], { id: 'stable-id', file: 'flow.spec.ts', title: 'journey',
    identity: 'flow.spec.ts > outer > inner > journey', project: 'real-node', expectedStatus: 'passed', attempts: [
      { status: 'timedOut', durationMs: 100, startTime: '2026-10-24T00:00:00Z', retry: 0 },
      { status: 'passed', durationMs: 20, startTime: '2026-10-24T00:00:01Z', retry: 1 },
    ] });
  assert.equal(executions[1].project, 'another-project');
  assert.equal(executions[1].expectedStatus, 'failed');
  assert.deepEqual(browserExecutions(report), executions);
  assert.deepEqual(summarizeBrowserQuality(report), { cases: 2, firstAttemptFailed: 1, recoveredOnRetry: 1,
    failed: 0, skipped: 0, retries: 1, firstAttemptFailures: [
      { file: 'flow.spec.ts', title: 'journey', id: 'stable-id', project: 'real-node', status: 'timedOut' },
    ] });
});
