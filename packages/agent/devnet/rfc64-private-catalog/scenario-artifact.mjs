// SPDX-License-Identifier: Apache-2.0
// @ts-check

import {
  PRIVATE_CATALOG_MEMORY_EXPECTATION,
  roleAgentAddress,
} from './fixture.mjs';
import { isExpectedPrivateCatalogDenialResultV1 } from './denial-evidence.mjs';
import {
  hasExactPrivateCatalogFinalizedVmBaselineContents,
  hasExactPrivateCatalogMemoryContents,
  hasExactPrivateCatalogSwmContents,
} from './memory-evidence.mjs';
import {
  RFC64_PRIVATE_RELEASE_LIMITATION_V1,
} from './gate-artifact.mjs';
import {
  RFC64_PRIVATE_RUNTIME_RPC_PROCESS_IDS_V1,
  finalizedRuntimeRpcVerdictV1,
  rpcEvidenceV1,
} from './rpc-evidence.mjs';
import {
  RFC64_PRIVATE_RUNTIME_ACTORS_V1,
  RFC64_PRIVATE_RUNTIME_ROLES_V1,
} from './scenario-actors.ts';

export const EXPECTED_MEMORY_CONTENTS = PRIVATE_CATALOG_MEMORY_EXPECTATION;

/** @typedef {import('./scenario-result.ts').Rfc64PrivateScenarioResultV1} Rfc64PrivateScenarioResultV1 */
/** @typedef {import('./scenario-result.ts').Rfc64PrivateCatalogStateV1} Rfc64PrivateCatalogStateV1 */
/** @typedef {import('./scenario-result.ts').Rfc64PrivateBootstrapEvidenceV1} Rfc64PrivateBootstrapEvidenceV1 */
/** @typedef {import('./scenario-result.ts').Rfc64PrivateProcessEvidenceV1} Rfc64PrivateProcessEvidenceV1 */
/** @typedef {import('./scenario-result.ts').Rfc64PrivateReadyEvidenceV1} Rfc64PrivateReadyEvidenceV1 */
/** @typedef {import('./scenario-result.ts').Rfc64PrivateShutdownEvidenceV1} Rfc64PrivateShutdownEvidenceV1 */
/** @typedef {import('./scenario-actors.ts').Rfc64PrivateScenarioProcessIdV1} Rfc64PrivateScenarioProcessIdV1 */

/** @type {(state: Rfc64PrivateCatalogStateV1, options?: { swmProofKind?: 'workspace-head' | 'catalog-row' }) => boolean} */
export const hasExactMemoryContents = (state, { swmProofKind = 'catalog-row' } = {}) =>
  hasExactPrivateCatalogMemoryContents(state, {
    ...EXPECTED_MEMORY_CONTENTS,
    swm: {
      ...EXPECTED_MEMORY_CONTENTS.swm,
      proofKind: swmProofKind,
    },
  });

/** @type {(state: Rfc64PrivateCatalogStateV1) => boolean} */
export const hasExactSourceSwmContents = (state) =>
  hasExactPrivateCatalogSwmContents(state, {
    assetNumbers: EXPECTED_MEMORY_CONTENTS.assetNumbers,
    ...EXPECTED_MEMORY_CONTENTS.swm,
    proofKind: 'workspace-head',
  });

/** Project normalized actor evidence into the stable release-gate artifact. */
/**
 * @param {Readonly<Rfc64PrivateScenarioResultV1>} evidence
 * @param {string} runtimeManifestDigest
 */
export function buildRfc64PrivateReleaseArtifactV2(evidence, runtimeManifestDigest) {
  const checks = buildRfc64PrivateReleaseChecksV1(evidence);
  const status = Object.values(checks).every(Boolean) ? 'PASS' : 'FAIL';
  const owner = actor(evidence, 'owner');
  const provider2 = actor(evidence, 'provider2');
  const receiverSeed = actor(evidence, 'receiver-seed');
  const receiver = actor(evidence, 'receiver');
  const outsider = actor(evidence, 'outsider');
  const receiverRestart = actor(evidence, 'receiver-restart');
  const { baseline, failover, restart, revocation } = evidence.phases;
  const published = baseline.published;
  const receiverRevocation = revocation.receiverRevocation;
  const rpcActors = Object.fromEntries(RFC64_PRIVATE_RUNTIME_RPC_PROCESS_IDS_V1.map((id) => [
    id,
    rpcEvidenceV1(actor(evidence, id).shutdown),
  ]));

  return {
    schema: 'dkg-rfc64-private-release-gate-v2',
    status,
    limitation: RFC64_PRIVATE_RELEASE_LIMITATION_V1,
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
      baseline.ownerSourceState,
      null,
      owner.shutdown,
    ),
    provider2: safeState(
      revocation.provider2StateAfterRevocation,
      baseline.provider2Bootstrap,
      provider2.shutdown,
    ),
    failoverBarrier: {
      ownerExitCode: owner.shutdown.exit.code,
      ownerExitedAt: owner.shutdown.exit.exitedAt,
      ownerExitedBeforeReceiverSpawn: exitedBeforeSpawnV1(owner, receiver),
      ownerListenerClosed: failover.ownerListenerClosed,
      provider2ExactHeadAfterOwnerExit:
        failover.provider2StateAfterOwnerExit.exactExpectedHead === true,
      provider2ListenerDialable: failover.provider2ListenerDialable,
      receiverSpawnedAt: receiver.spawnedAt,
    },
    failoverReceiver: safeState(
      failover.receiverState,
      failover.receiverBootstrap,
      receiver.shutdown,
    ),
    receiverBaseline: safeState(
      baseline.receiverSeedState,
      baseline.receiverSeedBootstrap,
      receiverSeed.shutdown,
    ),
    outsider: {
      agentAddress: roleAgentAddress('outsider'),
      catalogScopeDigest: published.scopeDigest,
      denied: revocation.outsiderDenial.denied,
      failureClass: revocation.outsiderDenial.failureClass,
      failureCode: revocation.outsiderDenial.failureCode,
      appliedHeadDigest: revocation.outsiderState.appliedHeadDigest,
      graphCounts: revocation.outsiderState.graphCounts.map(({ kaNumber, swm, vm }) => ({
        kaNumber,
        swm,
        vm,
      })),
      providerVisibleVmBindings: revocation.providerAccessState.outsiderVisibleVmBindings,
      rpc: rpcEvidenceV1(outsider.shutdown),
    },
    revokedReceiver: {
      authority: {
        schema: 'dkg-rfc64-private-authorization-transition-v1',
        ownerMutation: {
          chainRosterVersion: revocation.ownerRevocation.chainRosterVersion,
          policyDigest: revocation.ownerRevocation.policyDigest,
          previousChainRosterVersion:
            revocation.ownerRevocation.previousChainRosterVersion,
          revokedAgentAddress: revocation.ownerRevocation.revokedAgentAddress,
        },
        providerObservation: {
          chainRosterVersion: receiverRevocation.chainRosterVersion,
          curatorMetadataRefreshed: receiverRevocation.curatorMetadataRefreshed,
          effectiveRosterVersion: receiverRevocation.effectiveRosterVersion,
          localRosterVersion: receiverRevocation.localRosterVersion,
          policyDigest: receiverRevocation.policyDigest,
          previousChainRosterVersion: receiverRevocation.previousChainRosterVersion,
          providerMutationDenied: receiverRevocation.providerMutationDenied,
          revokedAgentAddress: receiverRevocation.revokedAgentAddress,
        },
      },
      denial: {
        denied: revocation.revokedReceiverDenial.denied,
        failureClass: revocation.revokedReceiverDenial.failureClass,
        failureCode: revocation.revokedReceiverDenial.failureCode,
      },
      revokedAgentAddress: receiverRevocation.revokedAgentAddress,
      rosterVersion: receiverRevocation.effectiveRosterVersion,
      state: safeState(
        revocation.receiverStateAfterRevocation,
        failover.receiverBootstrap,
        receiver.shutdown,
      ),
    },
    restartedReceiver: safeState(
      restart.restartState,
      null,
      receiverRestart.shutdown,
    ),
  };
}

/** @param {Readonly<Rfc64PrivateScenarioResultV1>} evidence */
function buildRfc64PrivateReleaseChecksV1(evidence) {
  const owner = actor(evidence, 'owner');
  const receiver = actor(evidence, 'receiver');
  const receiverRestart = actor(evidence, 'receiver-restart');
  const peerIds = evidence.peerIds;
  const { baseline, failover, restart, revocation } = evidence.phases;
  const published = baseline.published;
  const provider2Bootstrap = baseline.provider2Bootstrap;
  const provider2State = baseline.provider2State;
  const receiverSeedBootstrap = baseline.receiverSeedBootstrap;
  const receiverState = failover.receiverState;
  const receiverRevocation = revocation.receiverRevocation;
  const ownerRevocation = revocation.ownerRevocation;
  const rpcReceipts = Object.fromEntries(RFC64_PRIVATE_RUNTIME_RPC_PROCESS_IDS_V1.map((id) => [
    id,
    actor(evidence, id).shutdown,
  ]));
  const rpcVerdict = finalizedRuntimeRpcVerdictV1(rpcReceipts);
  return Object.freeze({
    fourStableUniqueDaemonIdentities:
      new Set(Object.values(peerIds)).size === 4
      && RFC64_PRIVATE_RUNTIME_ROLES_V1.every(
        (role) => actor(evidence, `probe-${role}`).ready.agentClass === 'DKGAgent',
      ),
    productionCatalogServiceOnAllRoles:
      RFC64_PRIVATE_RUNTIME_ACTORS_V1.every(({ processId }) =>
        actor(evidence, processId).ready.catalogServiceStarted === true),
    exactTwoAssetPrivateCatalog:
      published.inventoryRowCount === '2'
      && published.catalogVersion === '4'
      && [
        baseline.ownerSourceState,
        provider2State,
        baseline.receiverSeedState,
        receiverState,
        revocation.receiverStateAfterRevocation,
        restart.restartState,
      ].every(({ catalogScopeDigest }) => catalogScopeDigest === published.scopeDigest),
    provider2ReceivedExactHead:
      hasExactAppliedTransferV1(
        provider2Bootstrap,
        peerIds.owner,
        published.headObjectDigest,
      )
      && provider2State.exactExpectedHead === true
      && provider2State.inventoryRowCount === '2',
    provider2HasSwmV2AndVmV1: hasExactMemoryContents(provider2State),
    receiverBaselineSeededThroughProvider2:
      hasExactAppliedTransferV1(
        receiverSeedBootstrap,
        peerIds.provider2,
        baseline.receiverSeedState.appliedHeadDigest,
      )
      && baseline.receiverSeedState.exactExpectedHead === true
      && hasExactPrivateCatalogFinalizedVmBaselineContents(
        baseline.receiverSeedState,
        EXPECTED_MEMORY_CONTENTS,
      ),
    receiverUsedProvider2AfterOwnerStopped:
      hasExactAppliedTransferV1(
        failover.receiverBootstrap,
        peerIds.provider2,
        published.headObjectDigest,
      ),
    ownerExitedBeforeReceiverRuntimeStarted:
      owner.shutdown.exit.error === null
      && failover.ownerListenerClosed
      && failover.provider2ListenerDialable
      && exitedBeforeSpawnV1(owner, receiver),
    receiverCaughtUpSwmV2AndVmV1: hasExactMemoryContents(receiverState),
    ...rpcVerdict,
    outsiderDeniedBeforeApplication:
      isExpectedPrivateCatalogDenialResultV1(revocation.outsiderDenial)
      && revocation.outsiderState.appliedHeadDigest === null,
    outsiderReceivedNoPrivateGraphs:
      revocation.outsiderState.graphCounts
        .every(({ swm, vm }) => swm === 0 && vm === 0),
    nonmemberQueryIsEmpty:
      revocation.providerAccessState.outsiderVisibleVmBindings === 0,
    revokedReceiverDeniedAfterFinalizedRosterAdvance:
      BigInt(ownerRevocation.chainRosterVersion)
        > BigInt(ownerRevocation.previousChainRosterVersion)
      && receiverRevocation.chainRosterVersion === ownerRevocation.chainRosterVersion
      && receiverRevocation.previousChainRosterVersion
        === ownerRevocation.previousChainRosterVersion
      && BigInt(receiverRevocation.effectiveRosterVersion)
        > BigInt(receiverRevocation.chainRosterVersion)
      && receiverRevocation.curatorMetadataRefreshed === true
      && receiverRevocation.providerMutationDenied === true
      && ownerRevocation.revokedAgentAddress === roleAgentAddress('receiver')
      && receiverRevocation.revokedAgentAddress === roleAgentAddress('receiver')
      && isExpectedPrivateCatalogDenialResultV1(revocation.revokedReceiverDenial),
    revocationDoesNotCorruptPreviouslyCommittedMemory:
      revocation.receiverStateAfterRevocation.exactExpectedHead === true
      && hasExactMemoryContents(revocation.receiverStateAfterRevocation),
    restartPreservedIdentityAndExactHead:
      receiverRestart.ready.peerId === peerIds.receiver
      && restart.restartState.exactExpectedHead === true
      && restart.restartState.inventoryRowCount === '2',
    restartPreservedSwmV2AndVmV1:
      hasExactMemoryContents(restart.restartState),
  });
}

/**
 * @param {Readonly<Rfc64PrivateScenarioResultV1>} evidence
 * @param {Rfc64PrivateScenarioProcessIdV1} processId
 * @returns {Readonly<Rfc64PrivateProcessEvidenceV1>}
 */
function actor(evidence, processId) {
  const process = evidence?.processes?.[processId];
  if (process === null || typeof process !== 'object' || Array.isArray(process)) {
    throw new Error(`RFC-64 private scenario is missing process evidence: ${processId}`);
  }
  return process;
}

/**
 * @param {Readonly<Rfc64PrivateProcessEvidenceV1>} exitedProcess
 * @param {Readonly<Rfc64PrivateProcessEvidenceV1>} spawnedProcess
 */
function exitedBeforeSpawnV1(exitedProcess, spawnedProcess) {
  return Number.isSafeInteger(exitedProcess.exitSequence)
    && Number.isSafeInteger(spawnedProcess.spawnSequence)
    && exitedProcess.exitSequence < spawnedProcess.spawnSequence;
}

/** @param {Readonly<Rfc64PrivateReadyEvidenceV1>} ready */
function safeRole(ready) {
  return {
    agentClass: ready.agentClass,
    peerId: ready.peerId,
    agentAddress: roleAgentAddress(ready.role),
  };
}

/**
 * @param {Readonly<Rfc64PrivateCatalogStateV1>} state
 * @param {Readonly<Rfc64PrivateBootstrapEvidenceV1> | null} bootstrap
 * @param {Readonly<Rfc64PrivateShutdownEvidenceV1>} shutdownReceipt
 */
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
        appliedTransferProviderPeerId: bootstrap.appliedTransferProviderPeerId,
        attempts: bootstrap.attempts,
      },
    }),
  };
}

/**
 * @param {Readonly<Rfc64PrivateBootstrapEvidenceV1>} bootstrap
 * @param {string} providerPeerId
 * @param {string | null} headObjectDigest
 */
function hasExactAppliedTransferV1(bootstrap, providerPeerId, headObjectDigest) {
  return bootstrap.appliedHeadDigest === headObjectDigest
    && bootstrap.appliedTransferProviderPeerId === providerPeerId
    && (
      bootstrap.outcome === 'applied'
        ? bootstrap.providerPeerId === providerPeerId
        : bootstrap.outcome === 'already-applied'
          && bootstrap.providerPeerId === null
    );
}
