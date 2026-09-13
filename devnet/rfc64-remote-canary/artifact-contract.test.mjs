// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ARTIFACT_SCHEMA,
  validateRemoteCanaryCertificateV1,
} from './artifact-contract.mjs';
import {
  createRemoteCanaryDryRunArtifactV1,
  executeRemoteCanaryCertificationV1,
} from './certify.mjs';
import { createCertificationRuntime } from './orchestration-fixture.mjs';
import { baseConfig } from './test-support.mjs';

const AT = '2026-09-11T01:00:00.000Z';

test('certificate v1 validates every authoritative status variant', async () => {
  const starting = {
    schema: ARTIFACT_SCHEMA,
    status: 'INCOMPLETE',
    phase: 'starting',
    startedAt: AT,
  };
  const dryRun = createRemoteCanaryDryRunArtifactV1(baseConfig(), () => new Date(AT));
  const pass = await executeRemoteCanaryCertificationV1(
    baseConfig(),
    createCertificationRuntime(),
  );
  const incompleteConfig = baseConfig({
    lifecycle: null,
    authorizationChecks: {
      unauthorized: {
        kind: 'not-exposed',
        reasonCode: 'catalog-protocol-api-not-exposed',
      },
      revoked: {
        kind: 'not-exposed',
        reasonCode: 'revocation-api-not-exposed',
      },
    },
    rpcUsage: { kind: 'required' },
  });
  delete incompleteConfig.contextGraphs[0].vmAskSparql;
  delete incompleteConfig.contextGraphs[0].catalogSwmAskSparql;
  const incomplete = await executeRemoteCanaryCertificationV1(
    incompleteConfig,
    createCertificationRuntime(),
  );
  const fail = {
    schema: ARTIFACT_SCHEMA,
    status: 'FAIL',
    phase: 'preflight',
    startedAt: AT,
    finishedAt: AT,
    failure: { code: 'node-build-mismatch' },
  };

  for (const artifact of [starting, dryRun, pass, incomplete, fail]) {
    assert.equal(validateRemoteCanaryCertificateV1(artifact), artifact);
  }
  assert.deepEqual(
    [starting.status, dryRun.status, pass.status, incomplete.status, fail.status],
    ['INCOMPLETE', 'DRY_RUN', 'PASS', 'INCOMPLETE', 'FAIL'],
  );
});

test('certificate v1 rejects omitted fields, renamed checks, and open failure codes', async () => {
  const pass = await executeRemoteCanaryCertificationV1(
    baseConfig(),
    createCertificationRuntime(),
  );
  const missingFinishedAt = structuredClone(pass);
  delete missingFinishedAt.finishedAt;
  const renamedVmCheck = structuredClone(pass);
  renamedVmCheck.checks.vmParityEvidence = renamedVmCheck.checks.vmParity;
  delete renamedVmCheck.checks.vmParity;
  const passWithMissingEvidence = structuredClone(pass);
  passWithMissingEvidence.checks.rpcUsage = {
    status: 'EVIDENCE_REQUIRED',
    requirement: 'dkg-rpc-usage-minutes-v1',
    acceptedSources: ['evidence-file', 'command'],
  };
  const incompleteWithAllEvidence = structuredClone(pass);
  incompleteWithAllEvidence.status = 'INCOMPLETE';
  incompleteWithAllEvidence.phase = 'evidence-required';
  const misspelledFailure = {
    schema: ARTIFACT_SCHEMA,
    status: 'FAIL',
    phase: 'vm-parity',
    startedAt: AT,
    finishedAt: AT,
    failure: { code: 'vm-parity-timeot' },
  };

  for (const malformed of [
    missingFinishedAt,
    renamedVmCheck,
    passWithMissingEvidence,
    incompleteWithAllEvidence,
    misspelledFailure,
  ]) {
    assert.throws(
      () => validateRemoteCanaryCertificateV1(malformed),
      /remote-canary-certificate-contract/u,
    );
  }
});
