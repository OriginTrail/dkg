import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../..');
const pnpmCommand = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';

function commandRow(id, label, args) {
  return Object.freeze({ id, label, kind: 'command', args: Object.freeze(args) });
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
  commandRow(
    'automatic-cold-start-and-restart',
    'Automatic cold start and restart',
    [
      '--filter',
      '@origintrail-official/dkg-agent',
      'test:rfc64-m0-recovery:cold-restart',
    ],
  ),
  commandRow(
    'source-recovery',
    'Source recovery',
    [
      '--filter',
      '@origintrail-official/dkg-agent',
      'test:rfc64-m0-recovery:provider-failover',
    ],
  ),
  commandRow(
    'public-curated-cold-warm-parity',
    'Public-curated cold/warm parity',
    [
      '--filter',
      '@origintrail-official/dkg-agent',
      'test:rfc64-m0-recovery:curated-parity',
    ],
  ),
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
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd: repoRoot,
      env: process.env,
      stdio: 'inherit',
    });
    child.once('error', rejectPromise);
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      rejectPromise(new Error(
        `${command} ${args.join(' ')} failed with ${signal ? `signal ${signal}` : `exit code ${String(code)}`}`,
      ));
    });
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
