import assert from 'node:assert/strict';
import test from 'node:test';

import { RFC64_M0_RECOVERY_SCENARIO_MANIFEST } from '../../packages/agent/scripts/rfc64-m0-recovery-manifest.mjs';
import {
  M0_ACCEPTANCE_ROWS,
  runM0Rows,
  runProcess,
} from './runner.mjs';

const expectedRows = Object.freeze([
  {
    id: 'persistence-lifecycle',
    label: 'Persistence lifecycle',
    kind: 'command',
    args: ['test:gate0:rfc64-persistence-lifecycle'],
  },
  {
    id: 'public-swm-policy-parity',
    label: 'Public SWM policy parity',
    kind: 'command',
    args: ['test:m1:rfc64-public-swm-parity'],
  },
  {
    id: 'finalized-public-vm',
    label: 'Finalized public VM',
    kind: 'command',
    args: [
      '--filter',
      '@devnet/rfc64-gate2-multi-asset-completeness',
      'live:public-vm',
    ],
  },
  ...RFC64_M0_RECOVERY_SCENARIO_MANIFEST.map((scenario) => ({
    id: scenario.rowId,
    label: scenario.label,
    kind: 'command',
    args: [
      '--filter',
      '@origintrail-official/dkg-agent',
      scenario.packageScript,
    ],
  })),
  {
    id: 'bounded-work',
    label: 'Bounded work',
    kind: 'command',
    args: [
      '--filter',
      '@origintrail-official/dkg-agent',
      'exec',
      'vitest',
      'run',
      '--config',
      'vitest.unit.config.ts',
      'test/rfc64-public-catalog-receiver-v1.test.ts',
      'test/sync-backpressure.test.ts',
      'test/sync-on-connect-churn.test.ts',
    ],
  },
]);
const expectedRowIds = Object.freeze(expectedRows.map(({ id }) => id));

test('locks every declared M0 acceptance command and invokes each row in order', async () => {
  assert.deepEqual(M0_ACCEPTANCE_ROWS, expectedRows);
  const invoked = [];

  await runM0Rows({
    execute: async (row) => {
      invoked.push(row.id);
    },
  });

  assert.deepEqual(invoked, expectedRowIds);
});

test('delegates recovery rows to stable agent-package proof scripts', () => {
  assert.deepEqual(
    M0_ACCEPTANCE_ROWS.slice(3, 6).map(({ id, args }) => ({ id, args })),
    RFC64_M0_RECOVERY_SCENARIO_MANIFEST.map((scenario) => ({
      id: scenario.rowId,
      args: [
        '--filter',
        '@origintrail-official/dkg-agent',
        scenario.packageScript,
      ],
    })),
  );
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
