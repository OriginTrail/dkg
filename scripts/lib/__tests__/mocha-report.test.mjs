import assert from 'node:assert/strict';
import test from 'node:test';
import { checkMochaReport } from '../../ci/check-mocha-report.mjs';

test('a Mocha report must contain real completed tests and no failures', () => {
  const report = { stats: { tests: 2, passes: 1, pending: 1, failures: 0, duration: 10 }, tests: [{}, {}], passes: [{}], failures: [] };
  assert.equal(checkMochaReport(report).pending, 1);
  assert.throws(() => checkMochaReport({}), /complete test inventory/);
  assert.throws(() => checkMochaReport({ ...report, tests: [] }), /complete test inventory/);
  assert.throws(() => checkMochaReport({ ...report, failures: [{}] }), /failures/);
  assert.throws(() => checkMochaReport({ ...report, stats: { ...report.stats, passes: 0 } }), /passing tests/);
});
