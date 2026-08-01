import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../..');
const pnpmCommand = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const recoveryTestFile = 'test/rfc64-dkg-agent-native-wiring.integration.test.ts';

function commandRow(id, label, args) {
  return Object.freeze({ id, label, kind: 'command', args: Object.freeze(args) });
}

function recoveryRow(id, label, scenarioId) {
  return Object.freeze({ id, label, kind: 'recovery', scenarioId });
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
  recoveryRow(
    'automatic-cold-start-and-restart',
    'Automatic cold start and restart',
    'M0_RECOVERY_COLD_RESTART',
  ),
  recoveryRow(
    'source-recovery',
    'Source recovery',
    'M0_RECOVERY_PROVIDER_FAILOVER',
  ),
  recoveryRow(
    'public-curated-cold-warm-parity',
    'Public-curated cold/warm parity',
    'M0_RECOVERY_CURATED_PARITY',
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

export function validateRecoveryReport(row, report) {
  const expectedTitlePrefix = `[${row.scenarioId}]`;
  const assertionResults = (report.testResults ?? []).flatMap(
    (testResult) => testResult.assertionResults ?? [],
  );
  const matchingAssertions = assertionResults.filter(
    ({ title }) => typeof title === 'string' && title.startsWith(expectedTitlePrefix),
  );
  const passedAssertions = assertionResults.filter(({ status }) => status === 'passed');

  if (
    report.numFailedTests !== 0
    || report.numPassedTests !== 1
    || passedAssertions.length !== 1
    || matchingAssertions.length !== 1
    || matchingAssertions[0].status !== 'passed'
    || passedAssertions[0] !== matchingAssertions[0]
  ) {
    throw new Error(
      `${row.label} did not prove exactly one passing ${expectedTitlePrefix} scenario `
      + `(passed=${String(report.numPassedTests)}, failed=${String(report.numFailedTests)}, `
      + `matching=${matchingAssertions.length})`,
    );
  }
}

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
  if (row.kind === 'command') {
    await runProcess(row.args);
    return;
  }

  const reportDirectory = await mkdtemp(join(tmpdir(), 'dkg-rfc64-m0-'));
  const reportPath = join(reportDirectory, `${row.id}.json`);
  try {
    await runProcess([
      '--filter',
      '@origintrail-official/dkg-agent',
      'exec',
      'vitest',
      'run',
      '--config',
      'vitest.unit.config.ts',
      recoveryTestFile,
      '-t',
      row.scenarioId,
      '--reporter=json',
      `--outputFile=${reportPath}`,
    ]);
    validateRecoveryReport(row, JSON.parse(await readFile(reportPath, 'utf8')));
  } finally {
    await rm(reportDirectory, { recursive: true, force: true });
  }
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
