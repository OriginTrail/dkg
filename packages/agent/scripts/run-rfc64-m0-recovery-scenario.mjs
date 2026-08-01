import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pnpmCommand = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const recoveryTestFile = 'test/rfc64-dkg-agent-native-wiring.integration.test.ts';

export const RFC64_M0_RECOVERY_SCENARIO_ENV = 'DKG_RFC64_M0_RECOVERY_SCENARIO';
export const RFC64_M0_RECOVERY_SCENARIOS = Object.freeze([
  'cold-restart',
  'provider-failover',
  'curated-parity',
]);

function runVitest(args, env) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(pnpmCommand, args, {
      cwd: packageRoot,
      env,
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
  if (!RFC64_M0_RECOVERY_SCENARIOS.includes(scenarioName)) {
    throw new Error(`Unknown RFC-64 M0 recovery scenario: ${String(scenarioName)}`);
  }

  await run([
    'exec',
    'vitest',
    'run',
    '--config',
    'vitest.unit.config.ts',
    recoveryTestFile,
  ], {
    ...process.env,
    [RFC64_M0_RECOVERY_SCENARIO_ENV]: scenarioName,
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runRecoveryScenario(process.argv[2]);
}
