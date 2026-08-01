import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pnpmCommand = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const recoveryTestFile = 'test/rfc64-dkg-agent-native-wiring.integration.test.ts';

export const RFC64_M0_RECOVERY_SCENARIOS = Object.freeze({
  'cold-restart': Object.freeze({
    id: 'M0_RECOVERY_COLD_RESTART',
    label: 'Automatic cold start and restart',
  }),
  'provider-failover': Object.freeze({
    id: 'M0_RECOVERY_PROVIDER_FAILOVER',
    label: 'Source recovery',
  }),
  'curated-parity': Object.freeze({
    id: 'M0_RECOVERY_CURATED_PARITY',
    label: 'Public-curated cold/warm parity',
  }),
});

export function validateRecoveryReport(scenario, report) {
  const expectedTitlePrefix = `[${scenario.id}]`;
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
      `${scenario.label} did not prove exactly one passing ${expectedTitlePrefix} scenario `
      + `(passed=${String(report.numPassedTests)}, failed=${String(report.numFailedTests)}, `
      + `matching=${matchingAssertions.length})`,
    );
  }
}

function runVitest(args) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(pnpmCommand, args, {
      cwd: packageRoot,
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
        `RFC-64 M0 recovery Vitest failed with ${signal ? `signal ${signal}` : `exit code ${String(code)}`}`,
      ));
    });
  });
}

export async function runRecoveryScenario(scenarioName, { run = runVitest } = {}) {
  const scenario = RFC64_M0_RECOVERY_SCENARIOS[scenarioName];
  if (!scenario) {
    throw new Error(`Unknown RFC-64 M0 recovery scenario: ${String(scenarioName)}`);
  }

  const reportDirectory = await mkdtemp(join(tmpdir(), 'dkg-rfc64-m0-recovery-'));
  const reportPath = join(reportDirectory, `${scenarioName}.json`);
  try {
    await run([
      'exec',
      'vitest',
      'run',
      '--config',
      'vitest.unit.config.ts',
      recoveryTestFile,
      '-t',
      scenario.id,
      '--reporter=json',
      `--outputFile=${reportPath}`,
    ]);
    validateRecoveryReport(scenario, JSON.parse(await readFile(reportPath, 'utf8')));
  } finally {
    await rm(reportDirectory, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runRecoveryScenario(process.argv[2]);
}
