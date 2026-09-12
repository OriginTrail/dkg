// SPDX-License-Identifier: Apache-2.0

import { computeAuthorCatalogScopeDigestV1 } from '@origintrail-official/dkg-core';

import { packKnowledgeAssetIdFromIdentity } from '../../src/ka-identity.ts';
import {
  ASSET_NUMBERS,
  PRIVATE_CATALOG_MEMORY_EXPECTATION,
  createPrivateCatalogScope,
  roleAgentAddress,
} from './fixture.mjs';

/** Build the canonical passing evidence shared by scenario-artifact tests. */
export function passingScenarioEvidenceV1() {
  const peerIds = Object.freeze({
    owner: 'owner-peer',
    provider2: 'provider2-peer',
    receiver: 'receiver-peer',
    outsider: 'outsider-peer',
  });
  const headObjectDigest = `0x${'cd'.repeat(32)}`;
  const scopeDigest = computeAuthorCatalogScopeDigestV1(createPrivateCatalogScope());
  const catalogState = scenarioMemoryStateV1(headObjectDigest, scopeDigest, 'catalog-row');
  const baselineState = scenarioFinalizedVmBaselineStateV1(headObjectDigest, scopeDigest);
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
        bootstrap: {
          appliedHeadDigest: headObjectDigest,
          outcome: 'applied',
          providerPeerId: peerIds.owner,
          appliedTransferProviderPeerId: peerIds.owner,
        },
        listenerDialableAfterOwnerExit: true,
        revocationObservation: {
          policyDigest: `0x${'ef'.repeat(32)}`,
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
        bootstrap: {
          appliedHeadDigest: headObjectDigest,
          outcome: 'applied',
          providerPeerId: peerIds.provider2,
          appliedTransferProviderPeerId: peerIds.provider2,
        },
        state: baselineState,
      },
      shutdown: finalizedShutdown,
    }),
    receiver: process('receiver', 'receiver', {
      spawnSequence: 3,
      observations: {
        bootstrap: {
          appliedHeadDigest: headObjectDigest,
          outcome: 'applied',
          providerPeerId: peerIds.provider2,
          appliedTransferProviderPeerId: peerIds.provider2,
        },
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

export function corruptBaselineRowV1(state, fields) {
  return {
    ...state,
    graphCounts: Object.freeze(state.graphCounts.map((entry, index) => Object.freeze(
      index === 0 ? { ...entry, ...fields } : entry,
    ))),
  };
}

export function corruptBaselineProofV1(state, fields) {
  return corruptBaselineRowV1(state, {
    swmProof: {
      ...state.graphCounts[0].swmProof,
      ...fields,
    },
  });
}

function scenarioFinalizedVmBaselineStateV1(headObjectDigest, catalogScopeDigest) {
  const state = scenarioMemoryStateV1(headObjectDigest, catalogScopeDigest, 'catalog-row');
  const baseline = PRIVATE_CATALOG_MEMORY_EXPECTATION.finalizedVmBaseline;
  return Object.freeze({
    ...state,
    catalogVersion: baseline.catalogVersion,
    graphCounts: Object.freeze(state.graphCounts.map((evidence) => Object.freeze({
      ...evidence,
      swm: baseline.projection.count,
      swmDigest: baseline.projection.digest,
      swmProof: Object.freeze({
        assertionVersion: baseline.assertionVersion,
        catalogHeadDigest: headObjectDigest,
        kaId: packKnowledgeAssetIdFromIdentity({
          agentAddress: baseline.authorAddress,
          kaNumber: evidence.kaNumber,
        }).toString(),
        kind: 'catalog-row',
        projectionDigest: baseline.catalogProjectionDigest,
      }),
    }))),
  });
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
