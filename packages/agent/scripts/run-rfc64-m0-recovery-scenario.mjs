import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runProcess } from '../../../scripts/lib/run-process.mjs';
import {
  RFC64_M0_RECOVERY_SCENARIOS,
  getRfc64M0RecoveryScenario,
} from './rfc64-m0-recovery-manifest.mjs';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pnpmCommand = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const recoveryTestFile = 'test/rfc64-dkg-agent-native-wiring.integration.test.ts';

export const RFC64_M0_RECOVERY_SCENARIO_ENV = 'DKG_RFC64_M0_RECOVERY_SCENARIO';
export { RFC64_M0_RECOVERY_SCENARIOS };

function runVitest(args, env) {
  return runProcess({
    args,
    command: pnpmCommand,
    cwd: packageRoot,
    env,
    failureLabel: 'RFC-64 M0 recovery Vitest',
  });
}

export async function runRecoveryScenario(scenarioName, { run = runVitest } = {}) {
  if (getRfc64M0RecoveryScenario(scenarioName) === null) {
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
