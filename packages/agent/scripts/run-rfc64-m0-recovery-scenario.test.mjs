import assert from 'node:assert/strict';
import test from 'node:test';

import { RFC64_M0_RECOVERY_SCENARIO_MANIFEST } from './rfc64-m0-recovery-manifest.mjs';
import {
  RFC64_M0_RECOVERY_SCENARIO_ENV,
  RFC64_M0_RECOVERY_SCENARIOS,
  runRecoveryScenario,
} from './run-rfc64-m0-recovery-scenario.mjs';

test('dispatches a stable structural scenario without title filters or reporter parsing', async () => {
  let invocation;
  await runRecoveryScenario('provider-failover', {
    run: async (args, env) => {
      invocation = { args, env };
    },
  });

  assert.deepEqual(invocation.args, [
    'exec',
    'vitest',
    'run',
    '--config',
    'vitest.unit.config.ts',
    'test/rfc64-dkg-agent-native-wiring.integration.test.ts',
  ]);
  assert.equal(invocation.env[RFC64_M0_RECOVERY_SCENARIO_ENV], 'provider-failover');
  assert.equal(invocation.args.includes('-t'), false);
  assert.equal(invocation.args.some((arg) => arg.includes('reporter')), false);
});

test('uses the canonical manifest for scenario ids and package-script routing', () => {
  assert.deepEqual(
    RFC64_M0_RECOVERY_SCENARIOS,
    RFC64_M0_RECOVERY_SCENARIO_MANIFEST.map(({ id }) => id),
  );
  assert.equal(
    new Set(RFC64_M0_RECOVERY_SCENARIO_MANIFEST.map(({ id }) => id)).size,
    RFC64_M0_RECOVERY_SCENARIO_MANIFEST.length,
  );
  assert.deepEqual(
    RFC64_M0_RECOVERY_SCENARIO_MANIFEST.map(({ packageScript }) => packageScript),
    RFC64_M0_RECOVERY_SCENARIO_MANIFEST.map(
      ({ id }) => `test:rfc64-m0-recovery:${id}`,
    ),
  );
});

test('rejects unknown structural scenario targets before invoking Vitest', async () => {
  let invoked = false;
  await assert.rejects(
    runRecoveryScenario('missing-scenario', {
      run: async () => { invoked = true; },
    }),
    /Unknown RFC-64 M0 recovery scenario/,
  );
  assert.equal(invoked, false);
});
