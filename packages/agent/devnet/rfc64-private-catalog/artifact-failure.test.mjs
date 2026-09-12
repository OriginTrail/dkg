// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import test from 'node:test';

import { computeAuthorCatalogScopeDigestV1 } from '@origintrail-official/dkg-core';
import { packKnowledgeAssetIdFromIdentity } from '../../src/ka-identity.ts';

import {
  RFC64_PRIVATE_CHILD_LIFECYCLE_EVENTS_V1,
  RFC64_PRIVATE_CHILD_PROTOCOL_V1,
  childCommandDescriptorV1,
  defineChildCommandHandlersV1,
  dispatchChildCommandV1,
  isSafeChildDiagnosticPhaseV1,
} from './child-protocol.mjs';
import {
  createGateCommandFailureV1,
  sanitizeGateFailureV1,
} from './gate-artifact.mjs';
import {
  assertAuthorityEvidenceParityV1,
  assertInitialFinalizedAuthorityV1,
} from './initial-authority.mjs';
import {
  ASSET_NUMBERS,
  PRIVATE_CATALOG_MEMORY_EXPECTATION,
  createPrivateCatalogScope,
  createPrivateCatalogSyncScope,
  createPrivatePolicyAndRoster,
  roleAgentAddress,
} from './fixture.mjs';
import {
  assertFinalizedRuntimeV1,
  createFinalizedRuntimeV1,
  createOwnerPublicationStateV1,
  createProbeRuntimeV1,
} from './agent-runtime.mjs';
import { buildRfc64PrivateReleaseArtifactV1 } from './scenario-artifact.mjs';

const PROTOCOL_TEST_DIGEST = `0x${'ab'.repeat(32)}`;
const VALID_CHILD_COMMANDS = Object.freeze({
  dial: Object.freeze({
    cmd: 'dial',
    multiaddr: '/ip4/127.0.0.1/tcp/1/p2p/test',
    peerId: 'test-peer',
  }),
  publish: Object.freeze({ cmd: 'publish' }),
  'publish-update': Object.freeze({ cmd: 'publish-update' }),
  'wait-bootstrap': Object.freeze({
    cmd: 'wait-bootstrap',
    expectedHeadDigest: PROTOCOL_TEST_DIGEST,
    timeoutMs: 1_000,
  }),
  inspect: Object.freeze({ cmd: 'inspect', expectedHeadDigest: PROTOCOL_TEST_DIGEST }),
  'inspect-persisted': Object.freeze({ cmd: 'inspect-persisted' }),
  'sync-denied': Object.freeze({ cmd: 'sync-denied', providerPeerIds: ['test-peer'] }),
  'revoke-receiver': Object.freeze({ cmd: 'revoke-receiver' }),
  'observe-receiver-revocation': Object.freeze({ cmd: 'observe-receiver-revocation' }),
  stop: Object.freeze({ cmd: 'stop' }),
});

test('child protocol table classifies every request, response, and safe phase', async () => {
  for (const descriptor of Object.values(RFC64_PRIVATE_CHILD_PROTOCOL_V1)) {
    assert.equal(childCommandDescriptorV1(VALID_CHILD_COMMANDS[descriptor.command]), descriptor);
    assert.equal(isSafeChildDiagnosticPhaseV1(descriptor.responseEvent), true);
    assert.deepEqual(Object.keys(descriptor), ['command', 'responseEvent', 'validate']);
  }
  assert.equal(
    isSafeChildDiagnosticPhaseV1(RFC64_PRIVATE_CHILD_LIFECYCLE_EVENTS_V1.ready),
    true,
  );
  assert.equal(
    isSafeChildDiagnosticPhaseV1(RFC64_PRIVATE_CHILD_LIFECYCLE_EVENTS_V1.commandError),
    false,
  );
  assert.throws(() => childCommandDescriptorV1({ cmd: 'unknown' }), /unknown/u);
  const handlers = defineChildCommandHandlersV1(Object.fromEntries(
    Object.keys(RFC64_PRIVATE_CHILD_PROTOCOL_V1).map((command) => [command, () => ({})]),
  ));
  assert.deepEqual(Object.keys(handlers).sort(), Object.keys(RFC64_PRIVATE_CHILD_PROTOCOL_V1).sort());
  assert.throws(
    () => defineChildCommandHandlersV1({ inspect: () => ({}) }),
    /exactly cover/u,
  );
  for (const [command, descriptor] of Object.entries(RFC64_PRIVATE_CHILD_PROTOCOL_V1)) {
    if (command === 'stop') continue;
    const emitted = [];
    await dispatchChildCommandV1(
      handlers,
      { ...VALID_CHILD_COMMANDS[command], requestId: `parity:${command}` },
      (...args) => emitted.push(args),
    );
    assert.deepEqual(emitted, [[descriptor.responseEvent, `parity:${command}`, {}]]);
  }
  const stopEmitted = [];
  await dispatchChildCommandV1(
    handlers,
    { ...VALID_CHILD_COMMANDS.stop, requestId: 'parity:stop' },
    (...args) => stopEmitted.push(args),
  );
  assert.deepEqual(stopEmitted, []);
  for (const malformed of [
    { cmd: 'dial', multiaddr: '/ip4/127.0.0.1/tcp/1' },
    { cmd: 'publish', unexpected: true },
    { cmd: 'wait-bootstrap', expectedHeadDigest: 'not-a-digest', timeoutMs: 1_000 },
    { cmd: 'wait-bootstrap', expectedHeadDigest: PROTOCOL_TEST_DIGEST, timeoutMs: 999 },
    { cmd: 'inspect', expectedHeadDigest: 'not-a-digest' },
    { cmd: 'sync-denied', providerPeerIds: [] },
  ]) {
    assert.throws(() => childCommandDescriptorV1(malformed), TypeError);
  }
});

test('child command failures retain only a bounded command phase', () => {
  const sensitiveCause = new Error('provider endpoint and wallet material');
  const classified = sanitizeGateFailureV1(
    createGateCommandFailureV1('persisted-inspection', sensitiveCause),
  );
  assert.deepEqual(classified, {
    failureClass: 'gate-command-failed',
    commandPhase: 'persisted-inspection',
  });
  assert.equal(JSON.stringify(classified).includes(sensitiveCause.message), false);
  assert.deepEqual(sanitizeGateFailureV1(
    createGateCommandFailureV1('caller-controlled-phase', sensitiveCause),
  ), { failureClass: 'gate-execution-failed' });
});

test('runtime variants make owner publication ordering explicit', () => {
  const created = { agent: {}, chainAdapter: undefined, rpc: undefined };
  const probe = createProbeRuntimeV1(created);
  assert.equal(probe.kind, 'probe');
  assert.throws(() => assertFinalizedRuntimeV1(probe), /requires a finalized runtime/u);

  const publication = createOwnerPublicationStateV1();
  assert.throws(() => publication.requireBaseline(), /requires a published/u);
  publication.beginBaseline();
  assert.throws(() => publication.beginBaseline(), /already published/u);
  const scope = Object.freeze({ scope: 'test' });
  publication.commitBaseline(scope, [Object.freeze({ asset: 1 })]);
  assert.deepEqual(publication.requireBaseline(), {
    kind: 'baseline',
    scope,
    assets: [{ asset: 1 }],
  });

  const finalized = createFinalizedRuntimeV1(created, {
    initialFinalizedAuthority: {},
    peerIds: { owner: 'owner-peer' },
    role: 'provider2',
  });
  assert.equal(finalized.kind, 'run');
  assert.equal(finalized.publication, null);
  assert.doesNotThrow(() => assertFinalizedRuntimeV1(finalized));
});

test('publication and synchronization derive the exact canonical catalog scope', () => {
  const scope = createPrivateCatalogScope();
  const syncScope = createPrivateCatalogSyncScope();
  assert.equal(
    computeAuthorCatalogScopeDigestV1(scope),
    '0x7dbdfe9c09c959661b0d26d5353d14e55336429a26d75da593f9ca680d127f52',
  );
  assert.deepEqual(syncScope, {
    networkId: scope.networkId,
    contextGraphId: scope.contextGraphId,
    subGraphName: scope.subGraphName,
    authorAddress: scope.authorAddress,
    catalogEra: scope.era,
  });
});

test('artifact fails when receiver startup precedes owner exit', () => {
  const evidence = passingScenarioEvidenceV1();
  evidence.processes.owner.exitSequence = 5;
  evidence.processes.receiver.spawnSequence = 4;
  const artifact = buildRfc64PrivateReleaseArtifactV1(evidence, 'sha256:fixture');
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

test('initial authority rejects a finalized-chain roster fault before readiness', () => {
  const expected = createPrivatePolicyAndRoster();
  const expectedAuthority = {
    policy: expected.policy,
    policyDigest: expected.policyDigest,
    roster: expected.roster,
    source: 'finalized-chain',
  };
  assert.doesNotThrow(() => assertInitialFinalizedAuthorityV1({
    acceptedAuthority: expectedAuthority,
    finalizedAuthority: expectedAuthority,
    expectedAuthority,
  }));
  const sourceMismatch = {
    ...expectedAuthority,
    policy: {
      ...expectedAuthority.policy,
      source: {
        ...expectedAuthority.policy.source,
        blockHash: `0x${'00'.repeat(32)}`,
      },
    },
  };
  assert.throws(
    () => assertInitialFinalizedAuthorityV1({
      acceptedAuthority: expectedAuthority,
      finalizedAuthority: sourceMismatch,
      expectedAuthority,
    }),
    /differs from the finalized chain snapshot/u,
  );
  const finalizedAuthority = {
    ...expectedAuthority,
    roster: {
      ...expected.roster,
      members: expected.roster.members.filter(
        ({ agentAddress }) => agentAddress !== roleAgentAddress('receiver'),
      ),
    },
  };
  assert.throws(
    () => assertInitialFinalizedAuthorityV1({
      acceptedAuthority: expectedAuthority,
      finalizedAuthority,
      expectedAuthority,
    }),
    /differs from the finalized chain snapshot/u,
  );
  const laterGeneration = {
    ...expectedAuthority,
    roster: { ...expectedAuthority.roster, version: '10000000000000' },
  };
  assert.throws(
    () => assertAuthorityEvidenceParityV1({
      actual: laterGeneration,
      expected: expectedAuthority,
      message: 'test authority mismatch',
    }),
    /test authority mismatch/u,
  );
  assert.doesNotThrow(() => assertAuthorityEvidenceParityV1({
    actual: laterGeneration,
    expected: expectedAuthority,
    expectedRosterVersion: laterGeneration.roster.version,
    message: 'test authority mismatch',
  }));
});

function passingScenarioEvidenceV1() {
  const peerIds = Object.freeze({
    owner: 'owner-peer',
    provider2: 'provider2-peer',
    receiver: 'receiver-peer',
    outsider: 'outsider-peer',
  });
  const headObjectDigest = `0x${'cd'.repeat(32)}`;
  const scopeDigest = computeAuthorCatalogScopeDigestV1(createPrivateCatalogScope());
  const catalogState = scenarioMemoryStateV1(headObjectDigest, scopeDigest, 'catalog-row');
  const sourceState = scenarioMemoryStateV1(headObjectDigest, scopeDigest, 'workspace-head');
  const emptyState = Object.freeze({
    appliedHeadDigest: null,
    catalogScopeDigest: scopeDigest,
    catalogVersion: null,
    exactExpectedHead: false,
    graphCounts: Object.freeze(ASSET_NUMBERS.map((kaNumber) => Object.freeze({
      kaNumber,
      swm: 0,
      vm: 0,
    }))),
    inventoryRowCount: null,
    outsiderVisibleVmBindings: null,
    receiverStats: null,
  });
  const denial = Object.freeze({
    applied: false,
    denied: true,
    failureClass: 'Rfc64PublicCatalogCurrentHeadDiscoveryErrorV1',
    failureCode: 'catalog-discovery-policy-denied',
  });
  const ready = (role) => Object.freeze({
    agentClass: 'DKGAgent',
    catalogServiceStarted: true,
    peerId: peerIds[role],
    role,
  });
  const quietShutdown = scenarioShutdownV1({});
  const finalizedShutdown = scenarioShutdownV1({
    eth_call: 1,
    eth_getBlockByNumber: 1,
  });
  const process = (processId, role, fields = {}) => ({
    processId,
    ready: ready(role),
    role,
    spawnSequence: 1,
    spawnedAt: '2026-09-11T00:00:00.000Z',
    observations: {},
    ...fields,
  });
  const processes = {
    'probe-owner': process('probe-owner', 'owner', { shutdown: quietShutdown }),
    'probe-provider2': process('probe-provider2', 'provider2', { shutdown: quietShutdown }),
    'probe-receiver': process('probe-receiver', 'receiver', { shutdown: quietShutdown }),
    'probe-outsider': process('probe-outsider', 'outsider', { shutdown: quietShutdown }),
    owner: process('owner', 'owner', {
      exitSequence: 2,
      observations: {
        listenerClosed: true,
        published: {
          catalogVersion: '4',
          headObjectDigest,
          inventoryRowCount: '2',
          policyDigest: `0x${'ef'.repeat(32)}`,
          scopeDigest,
        },
        sourceState,
      },
      shutdown: quietShutdown,
    }),
    provider2: process('provider2', 'provider2', {
      observations: {
        accessState: { ...catalogState, outsiderVisibleVmBindings: 0 },
        bootstrap: { appliedHeadDigest: headObjectDigest, providerPeerId: peerIds.owner },
        listenerDialableAfterOwnerExit: true,
        revocationObservation: {
          curatorMetadataRefreshed: true,
          providerMutationDenied: true,
          revokedAgentAddress: roleAgentAddress('receiver'),
          rosterVersion: '1',
        },
        state: catalogState,
        stateAfterOwnerExit: catalogState,
        stateAfterRevocation: catalogState,
      },
      shutdown: finalizedShutdown,
    }),
    'receiver-seed': process('receiver-seed', 'receiver', {
      observations: {
        bootstrap: { appliedHeadDigest: headObjectDigest, providerPeerId: peerIds.provider2 },
        state: catalogState,
      },
      shutdown: finalizedShutdown,
    }),
    receiver: process('receiver', 'receiver', {
      observations: {
        bootstrap: { appliedHeadDigest: headObjectDigest, providerPeerId: peerIds.provider2 },
        revokedDenial: denial,
        state: catalogState,
        stateAfterRevocation: catalogState,
      },
      shutdown: finalizedShutdown,
    }),
    'owner-revoker': process('owner-revoker', 'owner', {
      observations: {
        revocation: {
          policyDigest: `0x${'ef'.repeat(32)}`,
          revokedAgentAddress: roleAgentAddress('receiver'),
          rosterVersion: '1',
        },
      },
      shutdown: quietShutdown,
    }),
    outsider: process('outsider', 'outsider', {
      observations: { denial, state: emptyState },
      shutdown: quietShutdown,
    }),
    'receiver-restart': process('receiver-restart', 'receiver', {
      observations: { state: catalogState },
      shutdown: quietShutdown,
    }),
  };
  return { peerIds, processes, runtimeProvenance: {} };
}

function scenarioMemoryStateV1(headObjectDigest, catalogScopeDigest, proofKind) {
  const expectation = PRIVATE_CATALOG_MEMORY_EXPECTATION;
  const authorAddress = expectation.swm.authorAddress;
  return Object.freeze({
    appliedHeadDigest: headObjectDigest,
    catalogScopeDigest,
    catalogVersion: expectation.swm.catalogVersion,
    exactExpectedHead: true,
    graphCounts: Object.freeze(ASSET_NUMBERS.map((kaNumber) => {
      const swmGraph = `urn:swm:${kaNumber}`;
      const vmGraph = `urn:vm:${kaNumber}`;
      const swmProof = proofKind === 'workspace-head'
        ? {
            assertionGraph: swmGraph,
            assertionVersion: expectation.swm.assertionVersion,
            kind: proofKind,
            shareOperationId: `${expectation.swm.shareOperationIdPrefix}${kaNumber}`,
          }
        : {
            assertionVersion: expectation.swm.assertionVersion,
            catalogHeadDigest: headObjectDigest,
            kaId: packKnowledgeAssetIdFromIdentity({ agentAddress: authorAddress, kaNumber })
              .toString(),
            kind: proofKind,
            projectionDigest: expectation.swm.catalogProjectionDigest,
          };
      return Object.freeze({
        kaNumber,
        swm: expectation.swm.projection.count,
        swmDigest: expectation.swm.projection.digest,
        swmGraph,
        swmProof: Object.freeze(swmProof),
        vm: expectation.vm.projection.count,
        vmDigest: expectation.vm.projection.digest,
        vmGraph,
        vmHead: Object.freeze({
          assertionGraph: vmGraph,
          assertionVersion: expectation.vm.assertionVersion,
        }),
      });
    })),
    inventoryRowCount: ASSET_NUMBERS.length.toString(),
    outsiderVisibleVmBindings: 0,
    receiverStats: Object.freeze({ applied: 1, failed: 0 }),
  });
}

function scenarioShutdownV1(rpcCallCounts) {
  return Object.freeze({
    exit: Object.freeze({
      code: 0,
      error: null,
      exitedAt: '2026-09-11T00:00:01.000Z',
      signal: null,
    }),
    rpcCallCounts: Object.freeze(rpcCallCounts),
  });
}
