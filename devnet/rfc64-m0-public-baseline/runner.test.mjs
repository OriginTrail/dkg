import assert from 'node:assert/strict';
import test from 'node:test';

import {
  M0_ACCEPTANCE_ROWS,
  runM0Rows,
  runProcess,
  validateRecoveryReport,
} from './runner.mjs';

const expectedRowIds = Object.freeze([
  'persistence-lifecycle',
  'public-swm-policy-parity',
  'finalized-public-vm',
  'automatic-cold-start-and-restart',
  'source-recovery',
  'public-curated-cold-warm-parity',
  'bounded-work',
]);

test('invokes every declared M0 acceptance row exactly once and in order', async () => {
  assert.deepEqual(M0_ACCEPTANCE_ROWS.map(({ id }) => id), expectedRowIds);
  const invoked = [];

  await runM0Rows({
    execute: async (row) => {
      invoked.push(row.id);
    },
  });

  assert.deepEqual(invoked, expectedRowIds);
});

test('fails the composed gate immediately when a child row fails', async () => {
  const invoked = [];
  const failure = new Error('synthetic child failure');

  await assert.rejects(
    runM0Rows({
      execute: async (row) => {
        invoked.push(row.id);
        if (row.id === 'finalized-public-vm') {
          throw failure;
        }
      },
    }),
    failure,
  );

  assert.deepEqual(invoked, expectedRowIds.slice(0, 3));
});

test('rejects a child process that exits unsuccessfully', async () => {
  await assert.rejects(
    runProcess(['-e', 'process.exit(17)'], { command: process.execPath }),
    /exit code 17/,
  );
});

test('requires exactly one passing recovery assertion with the stable scenario ID', () => {
  const row = M0_ACCEPTANCE_ROWS.find(({ id }) => id === 'source-recovery');
  const matchingAssertion = {
    status: 'passed',
    title: `[${row.scenarioId}] provider failover description may change`,
  };

  assert.doesNotThrow(() => validateRecoveryReport(row, {
    numFailedTests: 0,
    numPassedTests: 1,
    testResults: [{ assertionResults: [matchingAssertion] }],
  }));

  assert.throws(() => validateRecoveryReport(row, {
    numFailedTests: 0,
    numPassedTests: 0,
    testResults: [{ assertionResults: [{ ...matchingAssertion, status: 'skipped' }] }],
  }), /did not prove exactly one passing/);

  assert.throws(() => validateRecoveryReport(row, {
    numFailedTests: 0,
    numPassedTests: 2,
    testResults: [{ assertionResults: [matchingAssertion, { ...matchingAssertion }] }],
  }), /did not prove exactly one passing/);
});
