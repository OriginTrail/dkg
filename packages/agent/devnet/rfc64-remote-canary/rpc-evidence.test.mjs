// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  RemoteCanaryError,
  createRemoteCanaryCohortRefV1,
  runBoundedCommandV1,
  validateRemoteCanaryConfigV1,
} from './certify.mjs';
import {
  collectRpcUsageEvidenceV1,
  validateRpcEvidenceV1,
} from './rpc-evidence.mjs';
import { createCertificationPlanV1 } from './certification-plan.mjs';
import { COMMIT, baseConfig, rpcEvidence } from './test-support.mjs';

const OBSERVED_AT = '2026-09-11T00:02:30.000Z';

function evidenceContext(config, overrides = {}) {
  return {
    startedAt: OBSERVED_AT,
    observedAt: OBSERVED_AT,
    expectedCommit: COMMIT,
    cohortRef: createRemoteCanaryCohortRefV1(config),
    ...overrides,
  };
}

function fileConfig(minimumSamples = 1) {
  return validateRemoteCanaryConfigV1(baseConfig({
    rpcUsage: {
      kind: 'evidence-file',
      path: '/tmp/redacted-rpc-evidence.json',
      minimumSamples,
    },
  }));
}

function collect(config, context) {
  return collectRpcUsageEvidenceV1(
    config.rpcUsage,
    context,
    createCertificationPlanV1(config).rpcUsage,
  );
}

test('the shared standards validator enforces RPC evidence date-time formats', async () => {
  const config = fileConfig();
  const evidence = JSON.parse(rpcEvidence(config));
  evidence.samples[0].windowStartedAt = 'not-a-date';
  await assert.rejects(
    collect(config, evidenceContext(config, {
      readFileFn: async () => JSON.stringify(evidence),
    })),
    (error) => error instanceof RemoteCanaryError && error.code === 'rpc-evidence-malformed',
  );
});

test('RPC evidence rejects non-minutely windows', async () => {
  const config = fileConfig();
  const evidence = JSON.parse(rpcEvidence(config));
  evidence.samples = [{
    windowStartedAt: '2026-09-11T00:00:00.000Z',
    windowEndedAt: '2026-09-11T00:00:10.000Z',
    total: 99,
    byMethod: { eth_call: 1 },
  }];
  await assert.rejects(
    collect(config, evidenceContext(config, {
      readFileFn: async () => JSON.stringify(evidence),
    })),
    (error) => error instanceof RemoteCanaryError
      && error.code === 'rpc-evidence-window-not-minutely',
  );
});

test('RPC evidence rejects overlapping and out-of-order windows but accepts adjacency', async () => {
  const config = fileConfig(2);
  const sample = (windowStartedAt, windowEndedAt) => ({
    windowStartedAt,
    windowEndedAt,
    total: 1,
    byMethod: { eth_call: 1 },
  });
  for (const [label, samples] of [
    ['overlapping', [
      sample('2026-09-11T00:00:00.000Z', '2026-09-11T00:01:00.000Z'),
      sample('2026-09-11T00:00:30.000Z', '2026-09-11T00:01:30.000Z'),
    ]],
    ['out-of-order', [
      sample('2026-09-11T00:01:00.000Z', '2026-09-11T00:02:00.000Z'),
      sample('2026-09-11T00:00:00.000Z', '2026-09-11T00:01:00.000Z'),
    ]],
  ]) {
    const evidence = JSON.parse(rpcEvidence(config));
    evidence.samples = samples;
    await assert.rejects(
      collect(config, evidenceContext(config, {
        readFileFn: async () => JSON.stringify(evidence),
      })),
      (error) => error instanceof RemoteCanaryError
        && error.code === 'rpc-evidence-window-not-minutely',
      label,
    );
  }

  const adjacent = JSON.parse(rpcEvidence(config));
  adjacent.samples = [
    sample('2026-09-11T00:00:00.000Z', '2026-09-11T00:01:00.000Z'),
    sample('2026-09-11T00:01:00.000Z', '2026-09-11T00:02:00.000Z'),
  ];
  const result = await collect(config, evidenceContext(config, {
    readFileFn: async () => JSON.stringify(adjacent),
  }));
  assert.equal(result.status, 'PASS');
  assert.equal(result.sampleCount, 2);
});

test('RPC evidence rejects a minutely sample whose method counts do not match total', async () => {
  const config = fileConfig();
  const evidence = JSON.parse(rpcEvidence(config));
  evidence.samples = [{
    windowStartedAt: '2026-09-11T00:01:00.000Z',
    windowEndedAt: '2026-09-11T00:02:00.000Z',
    total: 99,
    byMethod: { eth_call: 1 },
  }];
  await assert.rejects(
    collect(config, evidenceContext(config, {
      readFileFn: async () => JSON.stringify(evidence),
    })),
    (error) => error instanceof RemoteCanaryError
      && error.code === 'rpc-evidence-total-mismatch',
  );
});

test('RPC evidence rejects unsafe counts and checked aggregate overflow', async () => {
  const config = fileConfig(2);
  const cohortRef = createRemoteCanaryCohortRefV1(config);
  const evidence = {
    schema: 'dkg-rpc-usage-minutes-v1',
    scope: 'certified-cohort',
    expectedCommit: COMMIT,
    cohortRef,
    samples: [
      {
        windowStartedAt: '2026-09-11T00:00:00.000Z',
        windowEndedAt: '2026-09-11T00:01:00.000Z',
        total: Number.MAX_SAFE_INTEGER,
        byMethod: { eth_call: Number.MAX_SAFE_INTEGER },
      },
      {
        windowStartedAt: '2026-09-11T00:01:00.000Z',
        windowEndedAt: '2026-09-11T00:02:00.000Z',
        total: 1,
        byMethod: { eth_call: 1 },
      },
    ],
  };
  const validationContext = evidenceContext(config);
  await assert.rejects(
    collect(config, {
      readFileFn: async () => JSON.stringify(evidence),
      ...validationContext,
    }),
    (error) => error instanceof RemoteCanaryError
      && error.code === 'rpc-evidence-count-overflow',
  );

  const unsafeEvidence = structuredClone(evidence);
  unsafeEvidence.samples = [{
    windowStartedAt: '2026-09-11T00:01:00.000Z',
    windowEndedAt: '2026-09-11T00:02:00.000Z',
    total: Number.MAX_SAFE_INTEGER + 1,
    byMethod: { eth_call: Number.MAX_SAFE_INTEGER + 1 },
  }];
  assert.throws(
    () => validateRpcEvidenceV1(unsafeEvidence, 1, validationContext),
    (error) => error instanceof RemoteCanaryError
      && error.code === 'rpc-evidence-count-out-of-range',
  );
  await assert.rejects(
    collect(config, {
      readFileFn: async () => JSON.stringify(unsafeEvidence),
      ...validationContext,
    }),
    (error) => error instanceof RemoteCanaryError
      && error.code === 'rpc-evidence-malformed',
  );

  const sampleOverflow = structuredClone(evidence);
  sampleOverflow.samples = [{
    windowStartedAt: '2026-09-11T00:01:00.000Z',
    windowEndedAt: '2026-09-11T00:02:00.000Z',
    total: Number.MAX_SAFE_INTEGER,
    byMethod: { eth_call: Number.MAX_SAFE_INTEGER, eth_blockNumber: 1 },
  }];
  assert.throws(
    () => validateRpcEvidenceV1(sampleOverflow, 1, validationContext),
    (error) => error instanceof RemoteCanaryError
      && error.code === 'rpc-evidence-count-overflow',
  );
});

test('RPC evidence rejects stale and future windows bound to the right release cohort', async () => {
  const config = fileConfig();
  for (const [windowStartedAt, windowEndedAt, expectedCode] of [
    ['2026-09-10T23:00:00.000Z', '2026-09-10T23:01:00.000Z', 'rpc-evidence-stale'],
    ['2026-09-11T00:10:00.000Z', '2026-09-11T00:11:00.000Z', 'rpc-evidence-future'],
  ]) {
    const evidence = JSON.parse(rpcEvidence(config));
    evidence.samples = [{
      windowStartedAt,
      windowEndedAt,
      total: 1,
      byMethod: { eth_call: 1 },
    }];
    await assert.rejects(
      collect(config, evidenceContext(config, {
        readFileFn: async () => JSON.stringify(evidence),
      })),
      (error) => error instanceof RemoteCanaryError && error.code === expectedCode,
    );
  }
});

test('RPC evidence accepts old history when its final sample is fresh for this run', async () => {
  const config = fileConfig(2);
  const evidence = JSON.parse(rpcEvidence(config));
  evidence.samples.unshift({
    windowStartedAt: '2026-09-10T23:00:00.000Z',
    windowEndedAt: '2026-09-10T23:01:00.000Z',
    total: 3,
    byMethod: { eth_call: 3 },
  });
  const result = await collect(config, evidenceContext(config, {
    readFileFn: async () => JSON.stringify(evidence),
  }));
  assert.equal(result.status, 'PASS');
  assert.equal(result.sampleCount, 3);
});

test('command-backed RPC evidence crosses the real subprocess boundary', async () => {
  const rawConfig = baseConfig({
    rpcUsage: {
      kind: 'command',
      command: { argv: [process.execPath, '-e', 'process.stdout.write(process.argv[1])', '{}'] },
      minimumSamples: 2,
      commandTimeoutMs: 5_000,
    },
  });
  rawConfig.rpcUsage.command.argv[3] = rpcEvidence(rawConfig);
  const config = validateRemoteCanaryConfigV1(rawConfig);
  const result = await collect(config, evidenceContext(config, {
    runCommand: runBoundedCommandV1,
  }));
  assert.equal(result.status, 'PASS');
  assert.equal(result.source, 'command');
});

test('RPC evidence must identify the certified commit and cohort', async () => {
  const config = fileConfig(2);
  for (const [mutate, expectedCode] of [
    [(evidence) => { evidence.expectedCommit = 'f'.repeat(40); }, 'rpc-evidence-commit-mismatch'],
    [(evidence) => { evidence.cohortRef = `cohort:${'f'.repeat(20)}`; }, 'rpc-evidence-cohort-mismatch'],
  ]) {
    const evidence = JSON.parse(rpcEvidence(config));
    mutate(evidence);
    await assert.rejects(
      collect(config, evidenceContext(config, {
        readFileFn: async () => JSON.stringify(evidence),
      })),
      (error) => error instanceof RemoteCanaryError && error.code === expectedCode,
    );
  }
});
