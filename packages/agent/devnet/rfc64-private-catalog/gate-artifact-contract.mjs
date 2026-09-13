// SPDX-License-Identifier: Apache-2.0

export const RFC64_PRIVATE_GATE_SCHEMA_V2 = 'dkg-rfc64-private-release-gate-v2';

export const RFC64_PRIVATE_RELEASE_LIMITATION_V1 =
  'Uses a deterministic finalized-chain adapter and loopback RPC, not scripts/devnet.sh Hardhat or the CLI daemon.';

export const RFC64_PRIVATE_RELEASE_CHECK_KEYS_V1 = Object.freeze([
  'fourStableUniqueDaemonIdentities',
  'productionCatalogServiceOnAllRoles',
  'exactTwoAssetPrivateCatalog',
  'provider2ReceivedExactHead',
  'provider2HasSwmV2AndVmV1',
  'receiverBaselineSeededThroughProvider2',
  'receiverUsedProvider2AfterOwnerStopped',
  'ownerExitedBeforeReceiverRuntimeStarted',
  'receiverCaughtUpSwmV2AndVmV1',
  'finalizedChainPathExecuted',
  'finalizedChainRpcWithinBudget',
  'outsiderDeniedBeforeApplication',
  'outsiderReceivedNoPrivateGraphs',
  'nonmemberQueryIsEmpty',
  'revokedReceiverDeniedAfterFinalizedRosterAdvance',
  'revocationDoesNotCorruptPreviouslyCommittedMemory',
  'restartPreservedIdentityAndExactHead',
  'restartPreservedSwmV2AndVmV1',
]);

export const RFC64_PRIVATE_PASS_TOP_LEVEL_KEYS_V1 = Object.freeze([
  'catalog',
  'checks',
  'failoverBarrier',
  'failoverReceiver',
  'finishedAt',
  'limitation',
  'outsider',
  'provider2',
  'receiverBaseline',
  'restartedReceiver',
  'revokedReceiver',
  'rpcActors',
  'runtimeManifestDigest',
  'runtimeProvenance',
  'schema',
  'sourceProvider',
  'sourceRevision',
  'startedAt',
  'status',
  'topology',
]);
