// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PRIVATE_CATALOG_MEMORY_EXPECTATION,
  privateCatalogSwmShareOperationId,
} from './fixture.mjs';
import { buildRfc64PrivateReleaseArtifactV2 } from './scenario-artifact.mjs';
import {
  corruptBaselineProofV1,
  corruptBaselineRowV1,
  passingScenarioEvidenceV1,
} from './scenario-test-fixtures.mjs';

test('artifact fails when receiver startup precedes owner exit', () => {
  const evidence = passingScenarioEvidenceV1();
  const artifact = buildRfc64PrivateReleaseArtifactV2({
    ...evidence,
    processes: {
      ...evidence.processes,
      owner: { ...evidence.processes.owner, exitSequence: 5 },
      receiver: { ...evidence.processes.receiver, spawnSequence: 4 },
    },
  }, 'sha256:fixture');
  assert.equal(artifact.failoverBarrier.ownerExitedBeforeReceiverSpawn, false);
  assert.equal(artifact.checks.ownerExitedBeforeReceiverRuntimeStarted, false);
  assert.deepEqual(
    Object.entries(artifact.checks)
      .filter(([name]) => name !== 'ownerExitedBeforeReceiverRuntimeStarted')
      .filter(([, passed]) => !passed),
    [],
  );
  assert.equal(artifact.status, 'FAIL');
});

test('artifact does not certify already-applied heads as provider transfers', () => {
  for (const [processId, check] of [
    ['provider2', 'provider2ReceivedExactHead'],
    ['receiver-seed', 'receiverBaselineSeededThroughProvider2'],
    ['receiver', 'receiverUsedProvider2AfterOwnerStopped'],
  ]) {
    const evidence = passingScenarioEvidenceV1();
    const phasePath = processId === 'provider2'
      ? evidence.phases.baseline
      : processId === 'receiver-seed'
        ? evidence.phases.baseline
        : evidence.phases.failover;
    const phaseKey = processId === 'provider2'
      ? 'provider2Bootstrap'
      : processId === 'receiver-seed'
        ? 'receiverSeedBootstrap'
        : 'receiverBootstrap';
    const bootstrap = phasePath[phaseKey];
    phasePath[phaseKey] = {
      ...bootstrap,
      outcome: 'already-applied',
      providerPeerId: null,
      appliedTransferProviderPeerId: null,
    };
    const artifact = buildRfc64PrivateReleaseArtifactV2(evidence, 'sha256:fixture');
    assert.equal(artifact.checks[check], false, check);
    assert.equal(artifact.status, 'FAIL', check);
  }
});

test('artifact fails without exact finalized-VM receiver baseline evidence', () => {
  const evidence = passingScenarioEvidenceV1();
  evidence.phases.baseline.receiverSeedState = Object.freeze({
    ...evidence.phases.baseline.receiverSeedState,
    graphCounts: Object.freeze([]),
  });
  const artifact = buildRfc64PrivateReleaseArtifactV2(evidence, 'sha256:fixture');
  assert.equal(artifact.checks.receiverBaselineSeededThroughProvider2, false);
  assert.deepEqual(
    Object.entries(artifact.checks)
      .filter(([name]) => name !== 'receiverBaselineSeededThroughProvider2')
      .filter(([, passed]) => !passed),
    [],
  );
  assert.equal(artifact.status, 'FAIL');
});

test('artifact fails when the finalized-VM receiver baseline retains an SWM head', () => {
  const evidence = passingScenarioEvidenceV1();
  const state = evidence.phases.baseline.receiverSeedState;
  evidence.phases.baseline.receiverSeedState = Object.freeze({
    ...state,
    graphCounts: Object.freeze(state.graphCounts.map((entry, index) => Object.freeze(
      index === 0
        ? {
            ...entry,
            swm: 0,
            swmProof: {
              kind: 'workspace-head',
              assertionVersion: '2',
              assertionGraph: entry.swmGraph,
              shareOperationId: privateCatalogSwmShareOperationId(entry.kaNumber),
            },
          }
        : entry,
    ))),
  });
  const artifact = buildRfc64PrivateReleaseArtifactV2(evidence, 'sha256:fixture');
  assert.equal(artifact.checks.receiverBaselineSeededThroughProvider2, false);
  assert.equal(artifact.status, 'FAIL');
});

test('artifact requires the exact finalized-VM baseline catalog-row closure', () => {
  const corruptions = [
    ['catalog generation', (state) => ({ ...state, catalogVersion: '4' })],
    ['empty SWM digest', (state) => corruptBaselineRowV1(state, {
      swmDigest: PRIVATE_CATALOG_MEMORY_EXPECTATION.swm.projection.digest,
    })],
    ['row assertion version', (state) => corruptBaselineProofV1(state, {
      assertionVersion: '2',
    })],
    ['row catalog head', (state) => corruptBaselineProofV1(state, {
      catalogHeadDigest: `0x${'00'.repeat(32)}`,
    })],
    ['row KA identity', (state) => corruptBaselineProofV1(state, { kaId: '1' })],
    ['row projection digest', (state) => corruptBaselineProofV1(state, {
      projectionDigest: PRIVATE_CATALOG_MEMORY_EXPECTATION.swm.catalogProjectionDigest,
    })],
  ];
  for (const [label, corrupt] of corruptions) {
    const evidence = passingScenarioEvidenceV1();
    const state = evidence.phases.baseline.receiverSeedState;
    evidence.phases.baseline.receiverSeedState = Object.freeze(corrupt(state));
    const artifact = buildRfc64PrivateReleaseArtifactV2(evidence, 'sha256:fixture');
    assert.equal(artifact.checks.receiverBaselineSeededThroughProvider2, false, label);
    assert.equal(artifact.status, 'FAIL', label);
  }
});
