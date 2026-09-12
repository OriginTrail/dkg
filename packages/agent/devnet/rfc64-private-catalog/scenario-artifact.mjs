// SPDX-License-Identifier: Apache-2.0

import {
  PRIVATE_CATALOG_MEMORY_EXPECTATION,
  roleAgentAddress,
} from './fixture.mjs';
import { isExpectedPrivateCatalogDenialResultV1 } from './denial-evidence.mjs';
import {
  hasExactPrivateCatalogMemoryContents,
  hasExactPrivateCatalogSwmContents,
} from './memory-evidence.mjs';
import {
  RFC64_PRIVATE_RUNTIME_RPC_PROCESS_IDS_V1,
  finalizedRuntimeRpcVerdictV1,
  rpcEvidenceV1,
} from './rpc-evidence.mjs';

export const EXPECTED_MEMORY_CONTENTS = PRIVATE_CATALOG_MEMORY_EXPECTATION;

export const hasExactMemoryContents = (state, { swmProofKind = 'catalog-row' } = {}) =>
  hasExactPrivateCatalogMemoryContents(state, {
    ...EXPECTED_MEMORY_CONTENTS,
    swm: {
      ...EXPECTED_MEMORY_CONTENTS.swm,
      proofKind: swmProofKind,
    },
  });

export const hasExactSourceSwmContents = (state) =>
  hasExactPrivateCatalogSwmContents(state, {
    assetNumbers: EXPECTED_MEMORY_CONTENTS.assetNumbers,
    ...EXPECTED_MEMORY_CONTENTS.swm,
    proofKind: 'workspace-head',
  });

/** Project normalized actor evidence into the stable release-gate artifact. */
export function buildRfc64PrivateReleaseArtifactV1(evidence, runtimeManifestDigest) {
  const checks = buildRfc64PrivateReleaseChecksV1(evidence);
  const status = Object.values(checks).every(Boolean) ? 'PASS' : 'FAIL';
  const owner = actor(evidence, 'owner');
  const provider2 = actor(evidence, 'provider2');
  const receiverSeed = actor(evidence, 'receiver-seed');
  const receiver = actor(evidence, 'receiver');
  const ownerRevoker = actor(evidence, 'owner-revoker');
  const outsider = actor(evidence, 'outsider');
  const receiverRestart = actor(evidence, 'receiver-restart');
  const published = observation(owner, 'published');
  const receiverRevocation = observation(provider2, 'revocationObservation');
  const rpcActors = Object.fromEntries(RFC64_PRIVATE_RUNTIME_RPC_PROCESS_IDS_V1.map((id) => [
    id,
    rpcEvidenceV1(actor(evidence, id).shutdown),
  ]));

  return {
    schema: 'dkg-rfc64-private-release-gate-v1',
    status,
    limitation:
      'Uses a deterministic finalized-chain adapter and loopback RPC, not scripts/devnet.sh Hardhat or the CLI daemon.',
    topology: {
      ownerProvider: safeRole(actor(evidence, 'probe-owner').ready),
      authorizedProviderReceiver: safeRole(actor(evidence, 'probe-provider2').ready),
      authorizedReceiver: safeRole(actor(evidence, 'probe-receiver').ready),
      unauthorizedNode: safeRole(actor(evidence, 'probe-outsider').ready),
    },
    runtimeManifestDigest,
    runtimeProvenance: evidence.runtimeProvenance,
    rpcActors,
    checks,
    catalog: {
      headObjectDigest: published.headObjectDigest,
      policyDigest: published.policyDigest,
      catalogVersion: published.catalogVersion,
      inventoryRowCount: published.inventoryRowCount,
      scopeDigest: published.scopeDigest,
    },
    sourceProvider: safeState(
      observation(owner, 'sourceState'),
      null,
      owner.shutdown,
    ),
    provider2: safeState(
      observation(provider2, 'stateAfterRevocation'),
      observation(provider2, 'bootstrap'),
      provider2.shutdown,
    ),
    failoverBarrier: {
      ownerExitCode: owner.shutdown.exit.code,
      ownerExitedAt: owner.shutdown.exit.exitedAt,
      ownerExitedBeforeReceiverSpawn: exitedBeforeSpawnV1(owner, receiver),
      ownerListenerClosed: observation(owner, 'listenerClosed'),
      provider2ExactHeadAfterOwnerExit:
        observation(provider2, 'stateAfterOwnerExit').exactExpectedHead === true,
      provider2ListenerDialable: observation(provider2, 'listenerDialableAfterOwnerExit'),
      receiverSpawnedAt: receiver.spawnedAt,
    },
    failoverReceiver: safeState(
      observation(receiver, 'state'),
      observation(receiver, 'bootstrap'),
      receiver.shutdown,
    ),
    receiverBaseline: safeState(
      observation(receiverSeed, 'state'),
      observation(receiverSeed, 'bootstrap'),
      receiverSeed.shutdown,
    ),
    outsider: {
      denied: observation(outsider, 'denial').denied,
      failureClass: observation(outsider, 'denial').failureClass,
      failureCode: observation(outsider, 'denial').failureCode,
      appliedHeadDigest: observation(outsider, 'state').appliedHeadDigest,
      graphCounts: observation(outsider, 'state').graphCounts,
      rpc: rpcEvidenceV1(outsider.shutdown),
    },
    revokedReceiver: {
      authority: {
        ownerMutation: observation(ownerRevoker, 'revocation'),
        providerObservation: receiverRevocation,
      },
      denial: {
        denied: observation(receiver, 'revokedDenial').denied,
        failureClass: observation(receiver, 'revokedDenial').failureClass,
        failureCode: observation(receiver, 'revokedDenial').failureCode,
      },
      revokedAgentAddress: receiverRevocation.revokedAgentAddress,
      rosterVersion: receiverRevocation.rosterVersion,
      state: safeState(
        observation(receiver, 'stateAfterRevocation'),
        observation(receiver, 'bootstrap'),
        receiver.shutdown,
      ),
    },
    restartedReceiver: safeState(
      observation(receiverRestart, 'state'),
      null,
      receiverRestart.shutdown,
    ),
  };
}

function buildRfc64PrivateReleaseChecksV1(evidence) {
  const owner = actor(evidence, 'owner');
  const provider2 = actor(evidence, 'provider2');
  const receiverSeed = actor(evidence, 'receiver-seed');
  const receiver = actor(evidence, 'receiver');
  const ownerRevoker = actor(evidence, 'owner-revoker');
  const outsider = actor(evidence, 'outsider');
  const receiverRestart = actor(evidence, 'receiver-restart');
  const peerIds = evidence.peerIds;
  const published = observation(owner, 'published');
  const provider2Bootstrap = observation(provider2, 'bootstrap');
  const provider2State = observation(provider2, 'state');
  const receiverSeedBootstrap = observation(receiverSeed, 'bootstrap');
  const receiverState = observation(receiver, 'state');
  const receiverRevocation = observation(provider2, 'revocationObservation');
  const ownerRevocation = observation(ownerRevoker, 'revocation');
  const rpcReceipts = Object.fromEntries(RFC64_PRIVATE_RUNTIME_RPC_PROCESS_IDS_V1.map((id) => [
    id,
    actor(evidence, id).shutdown,
  ]));
  const rpcVerdict = finalizedRuntimeRpcVerdictV1(rpcReceipts);
  return Object.freeze({
    fourStableUniqueDaemonIdentities:
      new Set(Object.values(peerIds)).size === 4
      && ['owner', 'provider2', 'receiver', 'outsider'].every(
        (role) => actor(evidence, `probe-${role}`).ready.agentClass === 'DKGAgent',
      ),
    productionCatalogServiceOnAllRoles:
      [owner, provider2, receiverSeed, receiver, ownerRevoker, outsider, receiverRestart]
        .every(({ ready }) => ready.catalogServiceStarted === true),
    exactTwoAssetPrivateCatalog:
      published.inventoryRowCount === '2'
      && published.catalogVersion === '4'
      && [
        observation(owner, 'sourceState'),
        provider2State,
        observation(receiverSeed, 'state'),
        receiverState,
        observation(receiver, 'stateAfterRevocation'),
        observation(receiverRestart, 'state'),
      ].every(({ catalogScopeDigest }) => catalogScopeDigest === published.scopeDigest),
    provider2ReceivedExactHead:
      provider2Bootstrap.appliedHeadDigest === published.headObjectDigest
      && provider2State.exactExpectedHead === true
      && provider2State.inventoryRowCount === '2',
    provider2HasSwmV2AndVmV1: hasExactMemoryContents(provider2State),
    receiverBaselineSeededThroughProvider2:
      receiverSeedBootstrap.providerPeerId === peerIds.provider2
      && observation(receiverSeed, 'state').exactExpectedHead === true,
    receiverUsedProvider2AfterOwnerStopped:
      observation(receiver, 'bootstrap').appliedHeadDigest === published.headObjectDigest
      && observation(receiver, 'bootstrap').providerPeerId === peerIds.provider2,
    ownerExitedBeforeReceiverRuntimeStarted:
      owner.shutdown.exit.error === null
      && observation(owner, 'listenerClosed')
      && observation(provider2, 'listenerDialableAfterOwnerExit')
      && exitedBeforeSpawnV1(owner, receiver),
    receiverCaughtUpSwmV2AndVmV1: hasExactMemoryContents(receiverState),
    ...rpcVerdict,
    outsiderDeniedBeforeApplication:
      isExpectedPrivateCatalogDenialResultV1(observation(outsider, 'denial'))
      && observation(outsider, 'state').appliedHeadDigest === null,
    outsiderReceivedNoPrivateGraphs:
      observation(outsider, 'state').graphCounts
        .every(({ swm, vm }) => swm === 0 && vm === 0),
    nonmemberQueryIsEmpty:
      observation(provider2, 'accessState').outsiderVisibleVmBindings === 0,
    revokedReceiverDeniedAfterFinalizedRosterAdvance:
      BigInt(receiverRevocation.rosterVersion) > 0n
      && receiverRevocation.curatorMetadataRefreshed === true
      && receiverRevocation.providerMutationDenied === true
      && ownerRevocation.revokedAgentAddress === roleAgentAddress('receiver')
      && receiverRevocation.revokedAgentAddress === roleAgentAddress('receiver')
      && isExpectedPrivateCatalogDenialResultV1(observation(receiver, 'revokedDenial')),
    revocationDoesNotCorruptPreviouslyCommittedMemory:
      observation(receiver, 'stateAfterRevocation').exactExpectedHead === true
      && hasExactMemoryContents(observation(receiver, 'stateAfterRevocation')),
    restartPreservedIdentityAndExactHead:
      receiverRestart.ready.peerId === peerIds.receiver
      && observation(receiverRestart, 'state').exactExpectedHead === true
      && observation(receiverRestart, 'state').inventoryRowCount === '2',
    restartPreservedSwmV2AndVmV1:
      hasExactMemoryContents(observation(receiverRestart, 'state')),
  });
}

function actor(evidence, processId) {
  const process = evidence?.processes?.[processId];
  if (process === null || typeof process !== 'object' || Array.isArray(process)) {
    throw new Error(`RFC-64 private scenario is missing process evidence: ${processId}`);
  }
  return process;
}

function exitedBeforeSpawnV1(exitedProcess, spawnedProcess) {
  return Number.isSafeInteger(exitedProcess.exitSequence)
    && Number.isSafeInteger(spawnedProcess.spawnSequence)
    && exitedProcess.exitSequence < spawnedProcess.spawnSequence;
}

function observation(process, key) {
  if (!Object.hasOwn(process.observations, key)) {
    throw new Error(`RFC-64 private scenario is missing observation: ${process.processId}.${key}`);
  }
  return process.observations[key];
}

function safeRole(ready) {
  return {
    agentClass: ready.agentClass,
    peerId: ready.peerId,
    agentAddress: roleAgentAddress(ready.role),
  };
}

function safeState(state, bootstrap, shutdownReceipt) {
  const rpc = rpcEvidenceV1(shutdownReceipt);
  return {
    appliedHeadDigest: state.appliedHeadDigest,
    catalogScopeDigest: state.catalogScopeDigest,
    catalogVersion: state.catalogVersion,
    inventoryRowCount: state.inventoryRowCount,
    graphCounts: state.graphCounts,
    rpcCalls: rpc.total,
    rpc,
    receiver: {
      applied: state.receiverStats?.applied ?? 0,
      failed: state.receiverStats?.failed ?? 0,
    },
    ...(bootstrap === null ? {} : {
      bootstrap: {
        outcome: bootstrap.outcome,
        providerPeerId: bootstrap.providerPeerId,
        attempts: bootstrap.attempts,
      },
    }),
  };
}
