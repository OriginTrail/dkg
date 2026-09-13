// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildExecutedRuntimeManifestV1,
  buildRuntimeManifestFromEntriesV1,
} from '../rfc64-runtime-provenance.mts';
import {
  RFC64_PRIVATE_RUNTIME_PROCESS_IDS_V1,
  buildRfc64PrivateRuntimeProvenanceV1,
} from '../../packages/agent/devnet/rfc64-private-catalog/runtime-provenance.mjs';
import { buildRfc64PrivateReleaseArtifactV1 } from
  '../../packages/agent/devnet/rfc64-private-catalog/scenario-artifact.mjs';
import { passingScenarioEvidenceV1 } from
  '../../packages/agent/devnet/rfc64-private-catalog/scenario-test-fixtures.mjs';
import {
  RemoteCanaryError,
  executeRemoteCanaryCertificationV1,
} from './certify.mjs';
import { createCertificationRuntime } from './orchestration-fixture.mjs';
import {
  PRIVATE_GATE_PASS_CHECKS_V1,
  collectPrivateGateAuthorizationEvidenceV1,
} from './private-gate-evidence.mjs';
import { COMMIT, baseConfig } from './test-support.mjs';

const RUN_STARTED_AT = '2026-09-11T01:00:00.000Z';
const EXPECTED_PRIVATE_GATE_PASS_CHECKS = Object.freeze([
  'exactTwoAssetPrivateCatalog',
  'finalizedChainPathExecuted',
  'finalizedChainRpcWithinBudget',
  'fourStableUniqueDaemonIdentities',
  'nonmemberQueryIsEmpty',
  'outsiderDeniedBeforeApplication',
  'outsiderReceivedNoPrivateGraphs',
  'ownerExitedBeforeReceiverRuntimeStarted',
  'productionCatalogServiceOnAllRoles',
  'provider2HasSwmV2AndVmV1',
  'provider2ReceivedExactHead',
  'receiverBaselineSeededThroughProvider2',
  'receiverCaughtUpSwmV2AndVmV1',
  'receiverUsedProvider2AfterOwnerStopped',
  'restartPreservedIdentityAndExactHead',
  'restartPreservedSwmV2AndVmV1',
  'revocationDoesNotCorruptPreviouslyCommittedMemory',
  'revokedReceiverDeniedAfterFinalizedRosterAdvance',
]);
const RUNTIME_FILES = Object.freeze([
  'packages/agent/dist/index.js',
  'packages/chain/dist/index.js',
  'packages/core/dist/index.js',
  'packages/storage/dist/index.js',
].map((path, index) => Object.freeze({
  byteLength: index + 1,
  path,
  sha256: `0x${String(index + 1).repeat(64)}`,
})));

function privateGateArtifact(overrides = {}) {
  const {
    startedAt = '2026-09-11T00:45:00.000Z',
    finishedAt = '2026-09-11T00:50:00.000Z',
    ...artifactOverrides
  } = overrides;
  const sourceBuild = buildRuntimeManifestFromEntriesV1(COMMIT, RUNTIME_FILES);
  const loaded = buildExecutedRuntimeManifestV1(COMMIT, RUNTIME_FILES);
  const runtimeProvenance = buildRfc64PrivateRuntimeProvenanceV1(
    sourceBuild,
    RFC64_PRIVATE_RUNTIME_PROCESS_IDS_V1.map((id) => ({ id, loaded })),
  );
  const scenarioEvidence = passingScenarioEvidenceV1();
  scenarioEvidence.runtimeProvenance = runtimeProvenance;
  const artifact = buildRfc64PrivateReleaseArtifactV1(
    scenarioEvidence,
    sourceBuild.manifestDigest,
  );
  const gateStart = Date.parse(startedAt);
  return {
    ...artifact,
    failoverBarrier: {
      ...artifact.failoverBarrier,
      ownerExitedAt: new Date(gateStart + 1_000).toISOString(),
      receiverSpawnedAt: new Date(gateStart + 2_000).toISOString(),
    },
    startedAt,
    finishedAt,
    sourceRevision: COMMIT,
    ...artifactOverrides,
  };
}

function collect(artifact, overrides = {}) {
  return collectPrivateGateAuthorizationEvidenceV1(
    {
      kind: 'private-gate-artifact',
      path: '/run/evidence/private-gate.json',
      maxAgeMinutes: 60,
    },
    {
      readFileFn: async () => JSON.stringify(artifact),
      expectedCommit: COMMIT,
      runStartedAt: RUN_STARTED_AT,
      ...overrides,
    },
  );
}

test('private-gate companion reuses the public provenance validator and emits only redacted binding', async () => {
  assert.deepEqual([...PRIVATE_GATE_PASS_CHECKS_V1].sort(), EXPECTED_PRIVATE_GATE_PASS_CHECKS);
  const artifact = privateGateArtifact();
  const privatePeerId = artifact.topology.ownerProvider.peerId;
  const evidence = await collect(artifact);
  assert.deepEqual(evidence, {
    schema: 'dkg-rfc64-private-release-gate-v1',
    artifactRef: evidence.artifactRef,
    sourceRevision: COMMIT,
    runtimeManifestDigest: artifact.runtimeManifestDigest,
    runtimeProvenanceRef: evidence.runtimeProvenanceRef,
    startedAt: artifact.startedAt,
    finishedAt: artifact.finishedAt,
  });
  assert.match(evidence.artifactRef, /^evidence:[0-9a-f]{20}$/u);
  assert.match(evidence.runtimeProvenanceRef, /^provenance:[0-9a-f]{20}$/u);
  assert.equal(JSON.stringify(evidence).includes(privatePeerId), false);
});

test('private-gate companion closes only not-exposed authorization gaps in a full remote certificate', async () => {
  const companionPath = '/run/evidence/private-gate.json';
  const companionArtifact = privateGateArtifact({
    startedAt: '2026-09-11T00:00:00.000Z',
    finishedAt: '2026-09-11T00:02:00.000Z',
  });
  const config = baseConfig({
    authorizationChecks: {
      unauthorized: {
        kind: 'not-exposed',
        reasonCode: 'catalog-protocol-api-not-exposed',
      },
      revoked: {
        kind: 'not-exposed',
        reasonCode: 'revocation-api-not-exposed',
      },
      companionEvidence: {
        kind: 'private-gate-artifact',
        path: companionPath,
        maxAgeMinutes: 60,
      },
    },
  });
  const runtime = createCertificationRuntime({ rpcEvidenceConfig: config });
  const delegateReadFile = runtime.readFileFn;
  runtime.readFileFn = async (path, encoding) => (
    path === companionPath
      ? JSON.stringify(companionArtifact)
      : delegateReadFile(path, encoding)
  );

  const certificate = await executeRemoteCanaryCertificationV1(config, runtime);
  assert.equal(certificate.status, 'PASS');
  assert.deepEqual(certificate.checks.authorization.unauthorized, {
    status: 'PASS',
    denialObserved: true,
  });
  assert.deepEqual(certificate.checks.authorization.revoked, {
    status: 'PASS',
    denialObserved: true,
  });
  assert.equal(
    certificate.checks.authorization.companionEvidence.sourceRevision,
    COMMIT,
  );
  assert.equal(
    JSON.stringify(certificate).includes('/run/evidence/private-gate.json'),
    false,
  );
  assert.equal(
    runtime.state.requests.some(({ path }) => path.includes('unauthorized-probe')),
    false,
  );
  assert.equal(
    runtime.state.requests.some(({ path }) => path.includes('revoked-probe')),
    false,
  );
});

test('private-gate companion rejects every non-PASS status and invalid source provenance', async () => {
  for (const mutate of [
    (artifact) => { artifact.status = 'INCOMPLETE'; },
    (artifact) => { artifact.status = 'FAIL'; },
    (artifact) => { artifact.schema = 'dkg-rfc64-private-release-gate-v2'; },
    (artifact) => { artifact.runtimeManifestDigest = `0x${'f'.repeat(64)}`; },
    (artifact) => { artifact.runtimeProvenance = null; },
  ]) {
    const artifact = privateGateArtifact();
    mutate(artifact);
    await assert.rejects(
      collect(artifact),
      (error) => error instanceof RemoteCanaryError
        && error.code === 'private-gate-evidence-invalid',
    );
  }
});

test('private-gate companion fails closed when its bounded artifact cannot be read', async () => {
  await assert.rejects(
    collect(privateGateArtifact(), {
      readFileFn: async () => {
        throw new Error('fixture intentionally unavailable');
      },
    }),
    (error) => error instanceof RemoteCanaryError
      && error.code === 'private-gate-evidence-read-failed',
  );

  await assert.rejects(
    collect(privateGateArtifact(), {
      readFileFn: async () => ' '.repeat((4 * 1_048_576) + 1),
    }),
    (error) => error instanceof RemoteCanaryError
      && error.code === 'private-gate-evidence-too-large',
  );
});

test('private-gate companion requires the exact release commit and closed PASS check set', async () => {
  await assert.rejects(
    collect(privateGateArtifact(), { expectedCommit: 'f'.repeat(40) }),
    (error) => error instanceof RemoteCanaryError
      && error.code === 'private-gate-evidence-source-mismatch',
  );

  for (const check of PRIVATE_GATE_PASS_CHECKS_V1) {
    const artifact = privateGateArtifact();
    artifact.checks = { ...artifact.checks, [check]: false };
    await assert.rejects(
      collect(artifact),
      (error) => error instanceof RemoteCanaryError
        && error.code === 'private-gate-evidence-authorization-checks',
      check,
    );
  }

  for (const mutate of [
    (checks) => { delete checks.outsiderDeniedBeforeApplication; },
    (checks) => { checks.futureUnreviewedCheck = true; },
  ]) {
    const artifact = privateGateArtifact();
    artifact.checks = { ...artifact.checks };
    mutate(artifact.checks);
    await assert.rejects(
      collect(artifact),
      (error) => error instanceof RemoteCanaryError
        && error.code === 'private-gate-evidence-authorization-checks',
    );
  }
});

test('private-gate companion is complete before and recent for this remote run', async () => {
  await assert.rejects(
    collect(privateGateArtifact({ finishedAt: '2026-09-11T01:00:01.000Z' })),
    (error) => error instanceof RemoteCanaryError
      && error.code === 'private-gate-evidence-not-bound-to-run',
  );
  await assert.rejects(
    collect(privateGateArtifact({
      startedAt: '2026-09-10T23:00:00.000Z',
      finishedAt: '2026-09-10T23:01:00.000Z',
    })),
    (error) => error instanceof RemoteCanaryError
      && error.code === 'private-gate-evidence-stale',
  );
});
