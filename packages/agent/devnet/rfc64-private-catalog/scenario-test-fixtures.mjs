// SPDX-License-Identifier: Apache-2.0
// @ts-check

import { computeAuthorCatalogScopeDigestV1 } from '@origintrail-official/dkg-core';
import {
  buildExecutedRuntimeManifestV1,
  buildRuntimeManifestFromEntriesV1,
} from '../../../../devnet/rfc64-runtime-provenance.mts';

import { packKnowledgeAssetIdFromIdentity } from '../../src/ka-identity.ts';
import {
  ASSET_NUMBERS,
  PRIVATE_CATALOG_MEMORY_EXPECTATION,
  createPrivateCatalogScope,
  createPrivatePolicyAndRoster,
  roleAgentAddress,
} from './fixture.mjs';
import {
  RFC64_PRIVATE_RUNTIME_PROCESS_IDS_V1,
  buildRfc64PrivateRuntimeProvenanceV2,
} from './runtime-provenance.mjs';

/** @typedef {import('./scenario-result.ts').Rfc64PrivateScenarioPhasesV1} Rfc64PrivateScenarioPhasesV1 */
/** @typedef {import('./scenario-result.ts').Rfc64PrivateScenarioResultV1} Rfc64PrivateScenarioResultV1 */
/** @typedef {import('./scenario-actors.ts').Rfc64PrivateRuntimeRoleV1} Rfc64PrivateRuntimeRoleV1 */
/** @typedef {import('./scenario-actors.ts').Rfc64PrivateScenarioProcessIdV1} Rfc64PrivateScenarioProcessIdV1 */
/** @typedef {import('./scenario-result.ts').Rfc64PrivateProcessEvidenceV1} Rfc64PrivateProcessEvidenceV1 */
/** @typedef {import('./scenario-result.ts').Rfc64PrivateReadyEvidenceV1} Rfc64PrivateReadyEvidenceV1 */
/** @typedef {import('./scenario-result.ts').Rfc64PrivateShutdownEvidenceV1} Rfc64PrivateShutdownEvidenceV1 */
/** @typedef {import('./scenario-result.ts').Rfc64PrivateCatalogStateV1} Rfc64PrivateCatalogStateV1 */
/** @typedef {import('./scenario-result.ts').Rfc64PrivateRpcCallCountsV1} Rfc64PrivateRpcCallCountsV1 */
/** @typedef {import('@origintrail-official/dkg-core').Digest32V1} Digest32V1 */

const FIXTURE_SOURCE_REVISION = 'b'.repeat(40);
const FIXTURE_RUNTIME_FILES = Object.freeze([
  'packages/agent/dist/index.js',
  'packages/chain/dist/index.js',
  'packages/core/dist/index.js',
  'packages/storage/dist/index.js',
].map((path, index) => Object.freeze({
  byteLength: index + 1,
  path,
  sha256: `0x${String(index + 1).repeat(64)}`,
})));

const FIXTURE_SOURCE_BUILD = buildRuntimeManifestFromEntriesV1(
  FIXTURE_SOURCE_REVISION,
  FIXTURE_RUNTIME_FILES,
);
const FIXTURE_EXECUTED_RUNTIME = buildExecutedRuntimeManifestV1(
  FIXTURE_SOURCE_REVISION,
  FIXTURE_RUNTIME_FILES,
);
const FIXTURE_RUNTIME_PROVENANCE = buildRfc64PrivateRuntimeProvenanceV2(
  FIXTURE_SOURCE_BUILD,
  RFC64_PRIVATE_RUNTIME_PROCESS_IDS_V1.map((id) => ({
    id,
    loaded: FIXTURE_EXECUTED_RUNTIME,
  })),
);

/** Build the canonical passing evidence shared by scenario-artifact tests. */
/** @returns {Readonly<Rfc64PrivateScenarioResultV1>} */
export function passingScenarioEvidenceV1() {
  /** @type {Readonly<Record<Rfc64PrivateRuntimeRoleV1, string>>} */
  const peerIds = Object.freeze({
    owner: 'owner-peer',
    provider2: 'provider2-peer',
    receiver: 'receiver-peer',
    outsider: 'outsider-peer',
  });
  const headObjectDigest = /** @type {Digest32V1} */ (`0x${'cd'.repeat(32)}`);
  const baselineHeadObjectDigest = /** @type {Digest32V1} */ (`0x${'bc'.repeat(32)}`);
  const scopeDigest = computeAuthorCatalogScopeDigestV1(createPrivateCatalogScope());
  const catalogState = scenarioMemoryStateV1(headObjectDigest, scopeDigest, 'catalog-row');
  const baselineState = scenarioFinalizedVmBaselineStateV1(
    baselineHeadObjectDigest,
    scopeDigest,
  );
  const sourceState = scenarioSourceStateV1(headObjectDigest, scopeDigest);
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
    rpcCallCounts: Object.freeze({}),
    rpcCalls: 0,
  });
  const denial = Object.freeze({
    applied: false,
    denied: true,
    failureClass: 'Rfc64PublicCatalogCurrentHeadDiscoveryErrorV1',
    failureCode: 'catalog-discovery-policy-denied',
  });
  /**
   * @param {Rfc64PrivateRuntimeRoleV1} role
   * @returns {Readonly<Rfc64PrivateReadyEvidenceV1>}
   */
  const ready = (role) => Object.freeze({
    agentClass: 'DKGAgent',
    catalogServiceStarted: true,
    event: 'ready',
    peerId: peerIds[role],
    role,
  });
  const quietShutdown = scenarioShutdownV1({});
  const finalizedShutdown = scenarioShutdownV1({
    eth_call: 1,
    eth_getBlockByNumber: 1,
  });
  /**
   * @param {Rfc64PrivateScenarioProcessIdV1} processId
   * @param {Rfc64PrivateRuntimeRoleV1} role
   * @param {{ shutdown: Readonly<Rfc64PrivateShutdownEvidenceV1> } & Partial<Pick<Rfc64PrivateProcessEvidenceV1, 'exitSequence' | 'spawnSequence' | 'spawnedAt'>>} fields
   * @returns {Readonly<Rfc64PrivateProcessEvidenceV1>}
   */
  const process = (processId, role, fields) => Object.freeze({
    exitSequence: 2,
    processId,
    ready: ready(role),
    role,
    spawnSequence: 1,
    spawnedAt: '2026-08-26T00:00:00.100Z',
    ...fields,
  });
  const processes = {
    'probe-owner': process('probe-owner', 'owner', { shutdown: quietShutdown }),
    'probe-provider2': process('probe-provider2', 'provider2', { shutdown: quietShutdown }),
    'probe-receiver': process('probe-receiver', 'receiver', { shutdown: quietShutdown }),
    'probe-outsider': process('probe-outsider', 'outsider', { shutdown: quietShutdown }),
    owner: process('owner', 'owner', {
      exitSequence: 2,
      shutdown: quietShutdown,
    }),
    provider2: process('provider2', 'provider2', {
      shutdown: finalizedShutdown,
    }),
    'receiver-seed': process('receiver-seed', 'receiver', {
      shutdown: finalizedShutdown,
    }),
    receiver: process('receiver', 'receiver', {
      spawnSequence: 3,
      spawnedAt: '2026-08-26T00:00:00.500Z',
      shutdown: finalizedShutdown,
    }),
    'owner-revoker': process('owner-revoker', 'owner', { shutdown: quietShutdown }),
    outsider: process('outsider', 'outsider', { shutdown: quietShutdown }),
    'receiver-restart': process('receiver-restart', 'receiver', { shutdown: quietShutdown }),
  };
  const provider2Bootstrap = Object.freeze({
    appliedHeadDigest: headObjectDigest,
    attempts: 1,
    catalogVersion: '4',
    inventoryRowCount: '2',
    outcome: 'applied',
    providerPeerId: peerIds.owner,
    appliedTransferProviderPeerId: peerIds.owner,
  });
  const receiverSeedBootstrap = Object.freeze({
    appliedHeadDigest: baselineHeadObjectDigest,
    attempts: 1,
    catalogVersion: '4',
    inventoryRowCount: '2',
    outcome: 'applied',
    providerPeerId: peerIds.provider2,
    appliedTransferProviderPeerId: peerIds.provider2,
  });
  const receiverBootstrap = Object.freeze({
    ...receiverSeedBootstrap,
    appliedHeadDigest: headObjectDigest,
  });
  const published = Object.freeze({
    catalogVersion: '4',
    headObjectDigest,
    inventoryRowCount: '2',
    policyDigest: createPrivatePolicyAndRoster().policyDigest,
    scopeDigest,
  });
  const ownerRevocation = Object.freeze({
    chainRosterVersion: '1',
    policyDigest: published.policyDigest,
    previousChainRosterVersion: '0',
    revokedAgentAddress: roleAgentAddress('receiver'),
  });
  const receiverRevocation = Object.freeze({
    ...ownerRevocation,
    curatorMetadataRefreshed: true,
    effectiveRosterVersion: '10000000000007',
    localRosterVersion: '7',
    providerMutationDenied: true,
  });
  const phases = {
    baseline: {
      baseline: published,
      ownerSourceState: sourceState,
      provider2Bootstrap,
      provider2State: catalogState,
      published,
      receiverSeedBootstrap,
      receiverSeedState: baselineState,
    },
    failover: {
      ownerListenerClosed: true,
      provider2ListenerDialable: true,
      provider2StateAfterOwnerExit: catalogState,
      receiverBootstrap,
      receiverState: catalogState,
    },
    restart: { restartState: catalogState },
    revocation: {
      outsiderDenial: denial,
      outsiderState: emptyState,
      ownerRevocation,
      provider2StateAfterRevocation: catalogState,
      providerAccessState: { ...catalogState, outsiderVisibleVmBindings: 0 },
      receiverRevocation,
      receiverStateAfterRevocation: catalogState,
      revokedReceiverDenial: denial,
    },
  };
  return Object.freeze({
    peerIds,
    phases,
    processes: Object.freeze(processes),
    runtimeProvenance: FIXTURE_RUNTIME_PROVENANCE,
  });
}

/**
 * @param {Readonly<Rfc64PrivateCatalogStateV1>} state
 * @param {Readonly<Record<string, unknown>>} fields
 */
export function corruptBaselineRowV1(state, fields) {
  return {
    ...state,
    graphCounts: Object.freeze(state.graphCounts.map((entry, index) => Object.freeze(
      index === 0 ? { ...entry, ...fields } : entry,
    ))),
  };
}

/**
 * @param {Readonly<Rfc64PrivateCatalogStateV1>} state
 * @param {Readonly<Record<string, unknown>>} fields
 */
export function corruptBaselineProofV1(state, fields) {
  return corruptBaselineRowV1(state, {
    swmProof: {
      ...state.graphCounts[0].swmProof,
      ...fields,
    },
  });
}

/** @param {Digest32V1} headObjectDigest @param {Digest32V1} catalogScopeDigest */
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

/**
 * @param {Digest32V1} headObjectDigest
 * @param {Digest32V1} catalogScopeDigest
 * @param {'workspace-head' | 'catalog-row'} proofKind
 * @returns {Readonly<Rfc64PrivateCatalogStateV1>}
 */
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
        kaUal: `did:dkg:otp:20430/${authorAddress}/${kaNumber}`,
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
    rpcCallCounts: Object.freeze({}),
    rpcCalls: 0,
  });
}

/** @param {Digest32V1} headObjectDigest @param {Digest32V1} catalogScopeDigest */
function scenarioSourceStateV1(headObjectDigest, catalogScopeDigest) {
  const state = scenarioMemoryStateV1(headObjectDigest, catalogScopeDigest, 'workspace-head');
  const emptyVm = PRIVATE_CATALOG_MEMORY_EXPECTATION.finalizedVmBaseline.projection;
  return Object.freeze({
    ...state,
    graphCounts: Object.freeze(state.graphCounts.map((evidence) => Object.freeze({
      ...evidence,
      vm: emptyVm.count,
      vmDigest: emptyVm.digest,
      vmHead: null,
    }))),
  });
}

/** @param {Rfc64PrivateRpcCallCountsV1} rpcCallCounts */
function scenarioShutdownV1(rpcCallCounts) {
  return Object.freeze({
    executedRuntimeManifest: FIXTURE_EXECUTED_RUNTIME,
    exit: Object.freeze({
      code: 0,
      error: null,
      exitedAt: '2026-08-26T00:00:00.250Z',
      signal: null,
    }),
    rpcCallCounts: Object.freeze(rpcCallCounts),
  });
}
