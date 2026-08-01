import assert from 'node:assert/strict';
import test from 'node:test';

import {
  M0_ACCEPTANCE_ROWS,
  runM0Rows,
  runProcess,
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

test('delegates recovery rows to stable agent-package proof scripts', () => {
  const recoveryScripts = M0_ACCEPTANCE_ROWS.slice(3, 6).map(
    ({ args }) => args.at(-1),
  );

  assert.deepEqual(recoveryScripts, [
    'test:rfc64-m0-recovery:cold-restart',
    'test:rfc64-m0-recovery:provider-failover',
    'test:rfc64-m0-recovery:curated-parity',
  ]);
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
