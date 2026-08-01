import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { RFC64_M0_RECOVERY_SCENARIO_MANIFEST } from '../../packages/agent/scripts/rfc64-m0-recovery-manifest.mjs';
import { runProcess as runChildProcess } from '../../scripts/lib/run-process.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../..');
const pnpmCommand = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';

function commandRow(id, label, args) {
  return Object.freeze({ id, label, args: Object.freeze(args) });
}

export const M0_ACCEPTANCE_ROWS = Object.freeze([
  commandRow('persistence-lifecycle', 'Persistence lifecycle', [
    'test:gate0:rfc64-persistence-lifecycle',
  ]),
  commandRow('public-swm-policy-parity', 'Public SWM policy parity', [
    'test:m1:rfc64-public-swm-parity',
  ]),
  commandRow('finalized-public-vm', 'Finalized public VM', [
    '--filter',
    '@devnet/rfc64-gate2-multi-asset-completeness',
    'live:public-vm',
  ]),
  ...RFC64_M0_RECOVERY_SCENARIO_MANIFEST.map((scenario) => commandRow(
    scenario.rowId,
    scenario.label,
    [
      '--filter',
      '@origintrail-official/dkg-agent',
      'exec',
      'node',
      'scripts/run-rfc64-m0-recovery-scenario.mjs',
      scenario.id,
    ],
  )),
  commandRow('bounded-work', 'Bounded work', [
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
  ]),
]);

export function runProcess(args, { command = pnpmCommand } = {}) {
  return runChildProcess({
    args,
    command,
    cwd: repoRoot,
  });
}

export async function executeRow(row) {
  await runProcess(row.args);
}

export async function runM0Rows({ execute = executeRow } = {}) {
  for (const [index, row] of M0_ACCEPTANCE_ROWS.entries()) {
    process.stdout.write(`\n[M0 ${index + 1}/${M0_ACCEPTANCE_ROWS.length}] ${row.label}\n`);
    await execute(row);
  }
  process.stdout.write(`\nM0 PASS: ${M0_ACCEPTANCE_ROWS.length}/${M0_ACCEPTANCE_ROWS.length} acceptance rows passed.\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runM0Rows();
}
