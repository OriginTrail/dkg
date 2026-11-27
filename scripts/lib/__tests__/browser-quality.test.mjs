import assert from 'node:assert/strict';
import test from 'node:test';
import { summarizeBrowserQuality } from '../../ci/browser-quality.mjs';

test('a recovered retry remains visible as a first-attempt failure', () => {
  const report = { suites: [{ specs: [{ title: 'journey', file: 'flow.spec.ts', tests: [
    { results: [{ status: 'failed' }, { status: 'passed' }] },
    { results: [{ status: 'passed' }] },
    { results: [{ status: 'skipped' }] },
    { results: [{ status: 'timedOut' }, { status: 'failed' }] },
  ] }] }] };
  assert.deepEqual(summarizeBrowserQuality(report), { cases: 4, firstAttemptFailed: 2, recoveredOnRetry: 1, failed: 1, skipped: 1, retries: 2, firstAttemptFailures: [
    { file: 'flow.spec.ts', title: 'journey', status: 'failed' },
    { file: 'flow.spec.ts', title: 'journey', status: 'timedOut' },
  ] });
  assert.throws(() => summarizeBrowserQuality({ suites: [] }), /no test cases/);
  assert.throws(() => summarizeBrowserQuality({ specs: [{ title: 'missing', tests: [{}] }] }), /no attempt results/);
});

test('expected failures are not flakes, while unexpected passes remain failures', () => {
  const summary = summarizeBrowserQuality({ specs: [{ title: 'known defect', tests: [
    { expectedStatus: 'failed', results: [{ status: 'failed' }] },
    { expectedStatus: 'failed', results: [{ status: 'passed' }] },
    { expectedStatus: 'failed', results: [{ status: 'passed' }, { status: 'failed' }] },
  ] }] });
  assert.equal(summary.firstAttemptFailed, 2);
  assert.equal(summary.recoveredOnRetry, 1);
  assert.equal(summary.failed, 1);
});
