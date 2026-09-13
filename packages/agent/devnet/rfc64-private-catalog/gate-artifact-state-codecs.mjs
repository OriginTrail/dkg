// SPDX-License-Identifier: Apache-2.0

import {
  ASSET_NUMBERS,
  NETWORK_ID,
  PRIVATE_CATALOG_MEMORY_EXPECTATION,
} from './fixture.mjs';
import {
  assertExactKeysV1,
  boundedArrayV1,
  canonicalIsoInstantV1,
  isDigestV1,
  parseCanonicalDecimalV1,
  plainRecordV1,
  stableJsonV1,
} from './gate-artifact-codec-primitives.mjs';
import { decodePrivateGateRpcEvidenceV1 } from './gate-artifact-rpc-codec.mjs';

/** Source-provider state has no bootstrap and proves workspace ownership. */
export function decodePrivateGateSourceProviderStateV1(value, catalog, topology) {
  return decodeAppliedCatalogStateV1(
    value,
    catalog,
    topology.ownerProvider.agentAddress,
    'RFC-64 private gate source provider',
    Object.freeze({
      catalogKind: 'current',
      hasBootstrap: false,
      memoryKind: 'source',
      proofKind: 'workspace-head',
    }),
  );
}

/** The second provider bootstraps the current catalog directly from the owner. */
export function decodePrivateGateProviderStateV1(value, catalog, topology) {
  return decodeAppliedCatalogStateV1(
    value,
    catalog,
    topology.ownerProvider.agentAddress,
    'RFC-64 private gate provider2',
    Object.freeze({
      catalogKind: 'current',
      expectedProviderPeerId: topology.ownerProvider.peerId,
      hasBootstrap: true,
      memoryKind: 'current',
      proofKind: 'catalog-row',
    }),
  );
}

/** Baseline receiver state is intentionally pinned to the older VM catalog. */
export function decodePrivateGateReceiverBaselineStateV1(value, catalog, topology) {
  return decodeAppliedCatalogStateV1(
    value,
    catalog,
    topology.ownerProvider.agentAddress,
    'RFC-64 private gate receiver baseline',
    Object.freeze({
      catalogKind: 'baseline',
      expectedProviderPeerId: topology.authorizedProviderReceiver.peerId,
      hasBootstrap: true,
      memoryKind: 'baseline',
      proofKind: 'catalog-row',
    }),
  );
}

/** Failover receiver state must bootstrap the current head from provider2. */
export function decodePrivateGateFailoverReceiverStateV1(value, catalog, topology) {
  return decodeAppliedCatalogStateV1(
    value,
    catalog,
    topology.ownerProvider.agentAddress,
    'RFC-64 private gate failover receiver',
    Object.freeze({
      catalogKind: 'current',
      expectedProviderPeerId: topology.authorizedProviderReceiver.peerId,
      hasBootstrap: true,
      memoryKind: 'current',
      proofKind: 'catalog-row',
    }),
  );
}

/** Revoked state retains the current committed memory obtained from provider2. */
export function decodePrivateGateRevokedReceiverStateV1(value, catalog, topology) {
  return decodeAppliedCatalogStateV1(
    value,
    catalog,
    topology.ownerProvider.agentAddress,
    'RFC-64 private gate revoked receiver',
    Object.freeze({
      catalogKind: 'current',
      expectedProviderPeerId: topology.authorizedProviderReceiver.peerId,
      hasBootstrap: true,
      memoryKind: 'current',
      proofKind: 'catalog-row',
    }),
  );
}

/** Restarted state is read from durable memory and therefore has no bootstrap. */
export function decodePrivateGateRestartedReceiverStateV1(value, catalog, topology) {
  return decodeAppliedCatalogStateV1(
    value,
    catalog,
    topology.ownerProvider.agentAddress,
    'RFC-64 private gate restarted receiver',
    Object.freeze({
      catalogKind: 'current',
      hasBootstrap: false,
      memoryKind: 'current',
      proofKind: 'catalog-row',
    }),
  );
}

export function decodePrivateGateFailoverBarrierV1(
  value,
  gateStartedAt,
  gateFinishedAt,
) {
  const barrier = plainRecordV1(value, 'RFC-64 private gate failover barrier');
  assertExactKeysV1(barrier, [
    'ownerExitCode',
    'ownerExitedAt',
    'ownerExitedBeforeReceiverSpawn',
    'ownerListenerClosed',
    'provider2ExactHeadAfterOwnerExit',
    'provider2ListenerDialable',
    'receiverSpawnedAt',
  ], 'RFC-64 private gate failover barrier');
  const ownerExitedAt = canonicalIsoInstantV1(barrier.ownerExitedAt, 'ownerExitedAt');
  const receiverSpawnedAt = canonicalIsoInstantV1(
    barrier.receiverSpawnedAt,
    'receiverSpawnedAt',
  );
  if (
    barrier.ownerExitCode !== 0
    || barrier.ownerExitedBeforeReceiverSpawn !== true
    || barrier.ownerListenerClosed !== true
    || barrier.provider2ExactHeadAfterOwnerExit !== true
    || barrier.provider2ListenerDialable !== true
    || ownerExitedAt > receiverSpawnedAt
    || ownerExitedAt < gateStartedAt
    || receiverSpawnedAt > gateFinishedAt
  ) throw new TypeError('RFC-64 private gate failover barrier is inconsistent');
  return barrier;
}

function decodeAppliedCatalogStateV1(
  value,
  catalog,
  authorAddress,
  label,
  contract,
) {
  const state = plainRecordV1(value, `${label} state`);
  const stateKeys = [
    'appliedHeadDigest',
    'catalogScopeDigest',
    'catalogVersion',
    'graphCounts',
    'inventoryRowCount',
    'receiver',
    'rpc',
    'rpcCalls',
  ];
  if (contract.hasBootstrap) stateKeys.push('bootstrap');
  assertExactKeysV1(state, stateKeys, `${label} state`);
  const expectedVersion = contract.catalogKind === 'baseline'
    ? PRIVATE_CATALOG_MEMORY_EXPECTATION.finalizedVmBaseline.catalogVersion
    : catalog.catalogVersion;
  if (
    !isDigestV1(state.appliedHeadDigest)
    || (contract.catalogKind === 'current'
      && state.appliedHeadDigest !== catalog.headObjectDigest)
    || (contract.catalogKind === 'baseline'
      && state.appliedHeadDigest === catalog.headObjectDigest)
    || state.catalogScopeDigest !== catalog.scopeDigest
    || state.catalogVersion !== expectedVersion
    || state.inventoryRowCount !== catalog.inventoryRowCount
  ) {
    throw new TypeError(`${label} state is not bound to the catalog`);
  }
  const rpc = decodePrivateGateRpcEvidenceV1(state.rpc, `${label} RPC evidence`);
  if (!Number.isSafeInteger(state.rpcCalls) || state.rpcCalls !== rpc.total) {
    throw new TypeError(`${label} RPC total is inconsistent`);
  }
  if (contract.hasBootstrap) {
    decodeBootstrapEvidenceV1(
      state.bootstrap,
      contract.expectedProviderPeerId,
      `${label} bootstrap evidence`,
    );
  }
  const receiver = plainRecordV1(state.receiver, `${label} receiver counters`);
  assertExactKeysV1(receiver, ['applied', 'failed'], `${label} receiver counters`);
  if (![receiver.applied, receiver.failed].every((count) => (
    Number.isSafeInteger(count) && count >= 0
  ))) throw new TypeError(`${label} receiver counters are malformed`);
  const graphCounts = boundedArrayV1(state.graphCounts, `${label} graph evidence`);
  const kaNumbers = [];
  const memory = graphCounts.map((entry, index) => {
    const row = plainRecordV1(entry, `${label} graph ${index}`);
    assertExactKeysV1(row, [
      'kaNumber', 'kaUal', 'swm', 'swmDigest', 'swmGraph', 'swmProof',
      'vm', 'vmDigest', 'vmGraph', 'vmHead',
    ], `${label} graph ${index}`);
    if (
      !Number.isSafeInteger(row.kaNumber)
      || row.kaNumber < 0
      || (index > 0 && row.kaNumber <= kaNumbers[index - 1])
      || typeof row.kaUal !== 'string'
      || !Number.isSafeInteger(row.swm)
      || row.swm < 0
      || !Number.isSafeInteger(row.vm)
      || row.vm < 0
      || typeof row.swmDigest !== 'string'
      || !/^[0-9a-f]{64}$/u.test(row.swmDigest)
      || typeof row.vmDigest !== 'string'
      || !/^[0-9a-f]{64}$/u.test(row.vmDigest)
    ) throw new TypeError(`${label} graph ${index} is malformed`);
    const proof = plainRecordV1(row.swmProof, `${label} graph ${index} SWM proof`);
    const swmExpectation = contract.memoryKind === 'baseline'
      ? PRIVATE_CATALOG_MEMORY_EXPECTATION.finalizedVmBaseline
      : PRIVATE_CATALOG_MEMORY_EXPECTATION.swm;
    if (contract.proofKind === 'catalog-row') {
      assertExactKeysV1(proof, [
        'assertionVersion', 'catalogHeadDigest', 'kaId', 'kind', 'projectionDigest',
      ], `${label} graph ${index} SWM proof`);
      const packedKaId = parseCanonicalDecimalV1(proof.kaId, true, 256);
      const expectedAuthor = BigInt(authorAddress);
      if (
        proof.kind !== contract.proofKind
        || proof.catalogHeadDigest !== state.appliedHeadDigest
        || proof.projectionDigest !== swmExpectation.catalogProjectionDigest
        || proof.assertionVersion !== swmExpectation.assertionVersion
        || packedKaId === null
        || (packedKaId >> 96n) !== expectedAuthor
        || (packedKaId & ((1n << 96n) - 1n)) !== BigInt(row.kaNumber)
      ) throw new TypeError(`${label} graph ${index} has a noncanonical KA identity proof`);
    } else {
      assertExactKeysV1(proof, [
        'assertionGraph', 'assertionVersion', 'kind', 'shareOperationId',
      ], `${label} graph ${index} SWM proof`);
      if (
        proof.kind !== contract.proofKind
        || proof.assertionGraph !== row.swmGraph
        || proof.assertionVersion !== swmExpectation.assertionVersion
        || proof.shareOperationId
          !== `${PRIVATE_CATALOG_MEMORY_EXPECTATION.swm.shareOperationIdPrefix}${row.kaNumber}`
      ) throw new TypeError(`${label} graph ${index} has a malformed workspace proof`);
    }
    if (row.kaUal !== `did:dkg:${NETWORK_ID}/${authorAddress}/${row.kaNumber}`) {
      throw new TypeError(`${label} graph ${index} has a noncanonical KA UAL`);
    }
    const vmExpectation = contract.memoryKind === 'source'
      ? PRIVATE_CATALOG_MEMORY_EXPECTATION.finalizedVmBaseline
      : PRIVATE_CATALOG_MEMORY_EXPECTATION.vm;
    if (
      row.swm !== swmExpectation.projection.count
      || row.swmDigest !== swmExpectation.projection.digest
      || row.vm !== vmExpectation.projection.count
      || row.vmDigest !== vmExpectation.projection.digest
      || typeof row.swmGraph !== 'string'
      || row.swmGraph.length < 1
      || row.swmGraph.length > 1_024
      || typeof row.vmGraph !== 'string'
      || row.vmGraph.length < 1
      || row.vmGraph.length > 1_024
      || row.vmGraph === row.swmGraph
    ) throw new TypeError(`${label} graph ${index} differs from the fixed memory fixture`);
    if (contract.memoryKind === 'source') {
      if (row.vmHead !== null) {
        throw new TypeError(`${label} graph ${index} has unexpected finalized VM evidence`);
      }
      kaNumbers.push(row.kaNumber);
      return Object.freeze({
        kaNumber: row.kaNumber,
        kaUal: row.kaUal,
        swm: row.swm,
        swmDigest: row.swmDigest,
        swmGraph: row.swmGraph,
        swmProof: proof,
        vm: row.vm,
        vmDigest: row.vmDigest,
        vmGraph: row.vmGraph,
        vmHead: null,
      });
    }
    const vmHead = plainRecordV1(row.vmHead, `${label} graph ${index} VM head`);
    assertExactKeysV1(
      vmHead,
      ['assertionGraph', 'assertionVersion'],
      `${label} graph ${index} VM head`,
    );
    if (
      vmHead.assertionGraph !== row.vmGraph
      || vmHead.assertionVersion !== vmExpectation.assertionVersion
    ) throw new TypeError(`${label} graph ${index} VM head is malformed`);
    kaNumbers.push(row.kaNumber);
    return Object.freeze({
      kaNumber: row.kaNumber,
      kaUal: row.kaUal,
      swm: row.swm,
      swmDigest: row.swmDigest,
      swmGraph: row.swmGraph,
      swmProof: proof,
      vm: row.vm,
      vmDigest: row.vmDigest,
      vmGraph: row.vmGraph,
      vmHead,
    });
  });
  if (
    graphCounts.length !== Number(BigInt(catalog.inventoryRowCount))
    || stableJsonV1(kaNumbers) !== stableJsonV1(ASSET_NUMBERS)
  ) {
    throw new TypeError(`${label} graph inventory is not catalog-bound`);
  }
  return Object.freeze({
    kaNumbers: Object.freeze(kaNumbers),
    memory: Object.freeze(memory),
    rpc,
  });
}

function decodeBootstrapEvidenceV1(value, expectedProviderPeerId, label) {
  const bootstrap = plainRecordV1(value, label);
  assertExactKeysV1(bootstrap, [
    'appliedTransferProviderPeerId',
    'attempts',
    'outcome',
    'providerPeerId',
  ], label);
  if (
    typeof expectedProviderPeerId !== 'string'
    || !Number.isSafeInteger(bootstrap.attempts)
    || bootstrap.attempts < 1
    || bootstrap.attempts > 1_024
    || !['applied', 'already-applied'].includes(bootstrap.outcome)
    || bootstrap.appliedTransferProviderPeerId !== expectedProviderPeerId
    || (bootstrap.outcome === 'applied'
      ? bootstrap.providerPeerId !== expectedProviderPeerId
      : bootstrap.providerPeerId !== null)
  ) throw new TypeError(`${label} is not bound to the expected provider`);
  return bootstrap;
}
