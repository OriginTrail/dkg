// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import { assertRfc64PrivateRuntimeProvenanceV1 } from './runtime-provenance.mjs';
import { isSafeChildDiagnosticPhaseV1 } from './child-protocol.mjs';
import {
  ASSET_NUMBERS,
  NETWORK_ID,
  PRIVATE_CATALOG_MEMORY_EXPECTATION,
  roleAgentAddress,
} from './fixture.mjs';
import { composeRfc64RegisteredRosterVersionV1 } from
  '../../src/rfc64/release-native-catalog-authority-v1.ts';
import {
  RFC64_PRIVATE_FINALIZED_READ_PROCESS_IDS_V1,
  RFC64_PRIVATE_GATE_RPC_BUDGET_V1,
  RFC64_PRIVATE_RUNTIME_RPC_PROCESS_IDS_V1,
} from './rpc-evidence.mjs';

const SCHEMA = 'dkg-rfc64-private-release-gate-v1';
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

const PASS_TOP_LEVEL_KEYS_V1 = Object.freeze([
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

const EXPECTED_PRIVATE_DENIAL_CLASSIFICATIONS_V1 = Object.freeze([
  Object.freeze([
    'Rfc64PublicCatalogCurrentHeadDiscoveryErrorV1',
    'catalog-discovery-policy-denied',
  ]),
  Object.freeze([
    'Rfc64PublicCatalogNativeTransportErrorV1',
    'catalog-native-policy-denied',
  ]),
]);

const MAX_PRIVATE_CATALOG_EVIDENCE_ROWS_V1 = 1_024;

/** Tag a child-command failure with fixed diagnostics safe for gate artifacts. */
export function createGateCommandFailureV1(commandPhase, cause) {
  const error = new Error(`RFC-64 private gate child command failed during ${commandPhase}`, {
    cause,
  });
  error.name = 'Rfc64PrivateGateCommandFailureV1';
  error.commandPhase = commandPhase;
  return error;
}

/**
 * Run one gate invocation with an artifact that can never retain an earlier
 * PASS. The initial INCOMPLETE record is durable before gate work starts, and
 * every caught failure replaces it with a sanitized FAIL record.
 */
export async function runRfc64PrivateGateArtifactLifecycleV1({
  artifactPath,
  execute,
  resolveSourceRevision,
  now = () => new Date(),
}) {
  const startedAt = now().toISOString();
  let canonicalSourceRevision = null;
  await writeGateArtifactAtomicV1(artifactPath, {
    schema: SCHEMA,
    status: 'INCOMPLETE',
    phase: 'starting',
    startedAt,
    sourceRevision: canonicalSourceRevision,
  });

  try {
    if (typeof resolveSourceRevision !== 'function') {
      throw new TypeError('RFC-64 private gate requires one source revision resolver');
    }
    canonicalSourceRevision = canonicalSourceRevisionV1(await resolveSourceRevision());
    if (canonicalSourceRevision === null) {
      throw new TypeError('RFC-64 private gate source revision is malformed');
    }
    const artifact = await execute({ sourceRevision: canonicalSourceRevision });
    const completed = {
      ...artifact,
      startedAt,
      finishedAt: now().toISOString(),
      sourceRevision: canonicalSourceRevision,
    };
    if (completed.status === 'PASS') {
      decodeRfc64PrivateGatePassArtifactV1(completed);
    }
    await writeGateArtifactAtomicV1(artifactPath, completed);
    return completed;
  } catch (error) {
    const failed = {
      schema: SCHEMA,
      status: 'FAIL',
      phase: 'failed',
      startedAt,
      finishedAt: now().toISOString(),
      sourceRevision: canonicalSourceRevision,
      failure: sanitizeGateFailureV1(error),
    };
    try {
      await writeGateArtifactAtomicV1(artifactPath, failed);
    } catch (artifactError) {
      throw new AggregateError(
        [error, artifactError],
        'RFC-64 private gate failed and its sanitized failure artifact could not be written',
      );
    }
    throw error;
  }
}

/** A committed PASS must name one exact source revision, runtime build, and bounded run. */
export function assertRfc64PrivateGatePassProvenanceV1(artifact) {
  if (artifact === null || typeof artifact !== 'object') {
    throw new TypeError('RFC-64 private gate PASS artifact must be an object');
  }
  if (artifact.schema !== SCHEMA || artifact.status !== 'PASS') {
    throw new TypeError('RFC-64 private gate PASS artifact has an invalid schema or status');
  }
  const startedAt = canonicalIsoInstantV1(artifact.startedAt, 'startedAt');
  const finishedAt = canonicalIsoInstantV1(artifact.finishedAt, 'finishedAt');
  if (finishedAt < startedAt) {
    throw new TypeError('RFC-64 private gate PASS finishedAt precedes startedAt');
  }
  if (
    typeof artifact.sourceRevision !== 'string'
    || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(artifact.sourceRevision)
  ) {
    throw new TypeError('RFC-64 private gate PASS requires an exact source revision');
  }
  if (
    typeof artifact.runtimeManifestDigest !== 'string'
    || !/^0x[0-9a-f]{64}$/u.test(artifact.runtimeManifestDigest)
  ) {
    throw new TypeError('RFC-64 private gate PASS requires an exact runtime manifest digest');
  }
  let provenance;
  try {
    provenance = assertRfc64PrivateRuntimeProvenanceV1(artifact.runtimeProvenance);
  } catch {
    throw new TypeError('RFC-64 private gate PASS runtime provenance is incomplete');
  }
  if (
    provenance.sourceBuild.sourceCommit !== artifact.sourceRevision
    || provenance.sourceBuild.manifestDigest !== artifact.runtimeManifestDigest
  ) {
    throw new TypeError('RFC-64 private gate PASS runtime provenance is not source-bound');
  }
  return artifact;
}

/**
 * Decode the complete source-gate PASS contract consumed by companion gates.
 * The exact top-level/check vocabularies are closed, and the two access-control
 * checks are re-established from bounded evidence rather than trusted booleans.
 */
export function decodeRfc64PrivateGatePassArtifactV1(input) {
  const artifact = plainRecordV1(input, 'RFC-64 private gate PASS artifact');
  assertExactKeysV1(artifact, PASS_TOP_LEVEL_KEYS_V1, 'RFC-64 private gate PASS artifact');
  if (
    typeof artifact.sourceRevision !== 'string'
    || !/^[0-9a-f]{40}$/u.test(artifact.sourceRevision)
  ) {
    throw new TypeError('RFC-64 private gate PASS requires one exact Git source revision');
  }
  if (artifact.limitation !== RFC64_PRIVATE_RELEASE_LIMITATION_V1) {
    throw new TypeError('RFC-64 private gate PASS has invalid fixed limitation metadata');
  }
  assertRfc64PrivateGatePassProvenanceV1(artifact);
  const startedAt = canonicalIsoInstantV1(artifact.startedAt, 'startedAt');
  const finishedAt = canonicalIsoInstantV1(artifact.finishedAt, 'finishedAt');
  if (startedAt > Date.now() || finishedAt > Date.now()) {
    throw new TypeError('RFC-64 private gate PASS interval is in the future');
  }

  const checks = plainRecordV1(artifact.checks, 'RFC-64 private gate PASS checks');
  assertExactKeysV1(checks, RFC64_PRIVATE_RELEASE_CHECK_KEYS_V1, 'RFC-64 private gate PASS checks');
  for (const key of RFC64_PRIVATE_RELEASE_CHECK_KEYS_V1) {
    if (checks[key] !== true) {
      throw new TypeError(`RFC-64 private gate PASS check is not true: ${key}`);
    }
  }

  const catalog = assertCatalogEvidenceV1(artifact.catalog);
  const topology = assertTopologyEvidenceV1(artifact.topology);
  const rpcActors = assertRpcActorsEvidenceV1(artifact.rpcActors);
  const sourceState = assertAppliedCatalogStateV1(
    artifact.sourceProvider,
    catalog,
    topology.ownerProvider.agentAddress,
    'RFC-64 private gate source provider',
    {
      hasBootstrap: false,
      memoryKind: 'source',
      proofKind: 'workspace-head',
    },
  );
  assertStateRpcMatchesActorV1(sourceState.rpc, rpcActors.owner, 'source provider');
  const providerState = assertAppliedCatalogStateV1(
    artifact.provider2,
    catalog,
    topology.ownerProvider.agentAddress,
    'RFC-64 private gate provider2',
    {
      expectedProviderPeerId: topology.ownerProvider.peerId,
      memoryKind: 'current',
    },
  );
  assertStateRpcMatchesActorV1(providerState.rpc, rpcActors.provider2, 'provider2');
  const baselineState = assertAppliedCatalogStateV1(
    artifact.receiverBaseline,
    catalog,
    topology.ownerProvider.agentAddress,
    'RFC-64 private gate receiver baseline',
    {
      catalogKind: 'baseline',
      expectedProviderPeerId: topology.authorizedProviderReceiver.peerId,
      memoryKind: 'baseline',
    },
  );
  assertStateRpcMatchesActorV1(
    baselineState.rpc,
    rpcActors['receiver-seed'],
    'receiver baseline',
  );
  assertFailoverBarrierV1(artifact.failoverBarrier, startedAt, finishedAt);
  const failoverState = assertAppliedCatalogStateV1(
    artifact.failoverReceiver,
    catalog,
    topology.ownerProvider.agentAddress,
    'RFC-64 private gate failover receiver',
    {
      expectedProviderPeerId: topology.authorizedProviderReceiver.peerId,
      memoryKind: 'current',
    },
  );
  assertStateRpcMatchesActorV1(failoverState.rpc, rpcActors.receiver, 'failover receiver');
  const outsiderRpc = assertOutsiderDenialEvidenceV1(
    artifact.outsider,
    catalog,
    topology,
    failoverState.kaNumbers,
  );
  assertStateRpcMatchesActorV1(outsiderRpc, rpcActors.outsider, 'outsider');
  const revokedState = assertRevokedReceiverDenialEvidenceV1(
    artifact.revokedReceiver,
    catalog,
    topology,
  );
  assertStateRpcMatchesActorV1(revokedState.rpc, rpcActors.receiver, 'revoked receiver');
  const restartedState = assertAppliedCatalogStateV1(
    artifact.restartedReceiver,
    catalog,
    topology.ownerProvider.agentAddress,
    'RFC-64 private gate restarted receiver',
    { hasBootstrap: false, memoryKind: 'current' },
  );
  assertStateRpcMatchesActorV1(
    restartedState.rpc,
    rpcActors['receiver-restart'],
    'restarted receiver',
  );
  if (stableJsonV1(revokedState.memory) !== stableJsonV1(failoverState.memory)) {
    throw new TypeError('RFC-64 private gate revoked receiver memory changed after denial');
  }
  if (stableJsonV1(restartedState.memory) !== stableJsonV1(failoverState.memory)) {
    throw new TypeError('RFC-64 private gate restarted receiver memory changed after restart');
  }
  return input;
}

/** Replace the artifact with one same-directory atomic rename. */
export async function writeGateArtifactAtomicV1(artifactPath, artifact) {
  const artifactDirectory = dirname(artifactPath);
  await mkdir(artifactDirectory, { recursive: true });
  const temporaryPath = join(
    artifactDirectory,
    `.${basename(artifactPath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    await writeFile(temporaryPath, `${stableJsonV1(artifact)}\n`, {
      encoding: 'utf8',
      mode: 0o644,
      flag: 'wx',
    });
    await rename(temporaryPath, artifactPath);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** Return only fixed classifications. Never retain caller-controlled error data. */
export function sanitizeGateFailureV1(error) {
  if (
    error instanceof Error
    && error.name === 'Rfc64PrivateGateCommandFailureV1'
    && isSafeChildDiagnosticPhaseV1(error.commandPhase)
  ) {
    return Object.freeze({
      failureClass: 'gate-command-failed',
      commandPhase: error.commandPhase,
    });
  }
  const failureClass = error instanceof AggregateError
    ? 'gate-and-artifact-failed'
    : error instanceof Error && error.name === 'AbortError'
      ? 'gate-aborted'
      : 'gate-execution-failed';
  return Object.freeze({ failureClass });
}

function canonicalSourceRevisionV1(value) {
  if (typeof value !== 'string' || !/^[0-9a-f]{7,64}$/iu.test(value)) return null;
  return value.toLowerCase();
}

function canonicalIsoInstantV1(value, field) {
  if (typeof value !== 'string') {
    throw new TypeError(`RFC-64 private gate PASS ${field} must be an ISO instant`);
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) {
    throw new TypeError(`RFC-64 private gate PASS ${field} must be a canonical ISO instant`);
  }
  return timestamp;
}

function assertCatalogEvidenceV1(value) {
  const catalog = plainRecordV1(value, 'RFC-64 private gate catalog evidence');
  assertExactKeysV1(catalog, [
    'catalogVersion',
    'headObjectDigest',
    'inventoryRowCount',
    'policyDigest',
    'scopeDigest',
  ], 'RFC-64 private gate catalog evidence');
  if (
    !isDigestV1(catalog.headObjectDigest)
    || !isDigestV1(catalog.policyDigest)
    || !isDigestV1(catalog.scopeDigest)
    || parseCanonicalDecimalV1(catalog.catalogVersion, false) === null
    || parseCanonicalDecimalV1(catalog.inventoryRowCount, false) === null
    || catalog.catalogVersion !== '4'
    || catalog.inventoryRowCount !== ASSET_NUMBERS.length.toString()
  ) {
    throw new TypeError('RFC-64 private gate catalog evidence is malformed');
  }
  return catalog;
}

function assertTopologyEvidenceV1(value) {
  const topology = plainRecordV1(value, 'RFC-64 private gate topology evidence');
  assertExactKeysV1(topology, [
    'authorizedProviderReceiver',
    'authorizedReceiver',
    'ownerProvider',
    'unauthorizedNode',
  ], 'RFC-64 private gate topology evidence');
  const roles = Object.fromEntries(Object.entries(topology).map(([key, roleValue]) => {
    const role = plainRecordV1(roleValue, `RFC-64 private gate topology ${key}`);
    assertExactKeysV1(
      role,
      ['agentAddress', 'agentClass', 'peerId'],
      `RFC-64 private gate topology ${key}`,
    );
    if (
      !isAddressV1(role.agentAddress)
      || role.agentClass !== 'DKGAgent'
      || typeof role.peerId !== 'string'
      || role.peerId.length < 1
      || role.peerId.length > 256
    ) {
      throw new TypeError(`RFC-64 private gate topology ${key} is malformed`);
    }
    return [key, role];
  }));
  if (
    new Set(Object.values(roles).map(({ agentAddress }) => agentAddress)).size !== 4
    || new Set(Object.values(roles).map(({ peerId }) => peerId)).size !== 4
  ) {
    throw new TypeError('RFC-64 private gate topology identities are not unique');
  }
  const expectedAddresses = {
    authorizedProviderReceiver: roleAgentAddress('provider2'),
    authorizedReceiver: roleAgentAddress('receiver'),
    ownerProvider: roleAgentAddress('owner'),
    unauthorizedNode: roleAgentAddress('outsider'),
  };
  if (Object.entries(expectedAddresses).some(([key, address]) => (
    roles[key].agentAddress !== address
  ))) throw new TypeError('RFC-64 private gate topology is not fixture-bound');
  return roles;
}

function assertOutsiderDenialEvidenceV1(value, catalog, topology, expectedKaNumbers) {
  const outsider = plainRecordV1(value, 'RFC-64 private gate outsider evidence');
  assertExactKeysV1(outsider, [
    'agentAddress',
    'appliedHeadDigest',
    'catalogScopeDigest',
    'denied',
    'failureClass',
    'failureCode',
    'graphCounts',
    'providerVisibleVmBindings',
    'rpc',
  ], 'RFC-64 private gate outsider evidence');
  assertDenialClassificationV1(outsider, 'RFC-64 private gate outsider denial');
  if (
    outsider.agentAddress !== topology.unauthorizedNode.agentAddress
    || outsider.catalogScopeDigest !== catalog.scopeDigest
    || outsider.appliedHeadDigest !== null
    || outsider.providerVisibleVmBindings !== 0
  ) {
    throw new TypeError('RFC-64 private gate outsider denial applied a catalog head');
  }
  const rpc = assertRpcEvidenceV1(outsider.rpc, 'RFC-64 private gate outsider RPC evidence');
  const graphCounts = boundedArrayV1(
    outsider.graphCounts,
    'RFC-64 private gate outsider graph evidence',
  );
  const seen = new Set();
  for (const [index, value] of graphCounts.entries()) {
    const row = plainRecordV1(value, `RFC-64 private gate outsider graph ${index}`);
    assertExactKeysV1(
      row,
      ['kaNumber', 'swm', 'vm'],
      `RFC-64 private gate outsider graph ${index}`,
    );
    if (
      !Number.isSafeInteger(row.kaNumber)
      || row.kaNumber < 0
      || seen.has(row.kaNumber)
      || row.swm !== 0
      || row.vm !== 0
    ) {
      throw new TypeError('RFC-64 private gate outsider graph evidence is not empty and unique');
    }
    seen.add(row.kaNumber);
  }
  if (
    graphCounts.length !== Number(BigInt(catalog.inventoryRowCount))
    || stableJsonV1([...seen].sort((left, right) => left - right))
      !== stableJsonV1(expectedKaNumbers)
    || stableJsonV1(expectedKaNumbers) !== stableJsonV1(ASSET_NUMBERS)
  ) {
    throw new TypeError('RFC-64 private gate outsider graph inventory is not catalog-bound');
  }
  return rpc;
}

function assertRevokedReceiverDenialEvidenceV1(value, catalog, topology) {
  const revoked = plainRecordV1(value, 'RFC-64 private gate revoked-receiver evidence');
  assertExactKeysV1(revoked, [
    'authority',
    'denial',
    'revokedAgentAddress',
    'rosterVersion',
    'state',
  ], 'RFC-64 private gate revoked-receiver evidence');
  const denial = plainRecordV1(revoked.denial, 'RFC-64 private gate revoked-receiver denial');
  assertExactKeysV1(
    denial,
    ['denied', 'failureClass', 'failureCode'],
    'RFC-64 private gate revoked-receiver denial',
  );
  assertDenialClassificationV1(denial, 'RFC-64 private gate revoked-receiver denial');

  const authority = plainRecordV1(
    revoked.authority,
    'RFC-64 private gate revoked-receiver authority',
  );
  assertExactKeysV1(
    authority,
    ['ownerMutation', 'providerObservation', 'schema'],
    'RFC-64 private gate revoked-receiver authority',
  );
  if (authority.schema !== 'dkg-rfc64-private-authorization-transition-v1') {
    throw new TypeError('RFC-64 private gate revoked-receiver authority schema is invalid');
  }
  const owner = plainRecordV1(
    authority.ownerMutation,
    'RFC-64 private gate owner revocation',
  );
  assertExactKeysV1(
    owner,
    ['chainRosterVersion', 'policyDigest', 'previousChainRosterVersion', 'revokedAgentAddress'],
    'RFC-64 private gate owner revocation',
  );
  const provider = plainRecordV1(
    authority.providerObservation,
    'RFC-64 private gate provider revocation',
  );
  assertExactKeysV1(provider, [
    'chainRosterVersion',
    'curatorMetadataRefreshed',
    'effectiveRosterVersion',
    'localRosterVersion',
    'policyDigest',
    'previousChainRosterVersion',
    'providerMutationDenied',
    'revokedAgentAddress',
  ], 'RFC-64 private gate provider revocation');
  const addresses = [
    revoked.revokedAgentAddress,
    owner.revokedAgentAddress,
    provider.revokedAgentAddress,
  ];
  const ownerPrevious = parseCanonicalDecimalV1(owner.previousChainRosterVersion, true);
  const ownerCurrent = parseCanonicalDecimalV1(owner.chainRosterVersion, false);
  const providerPrevious = parseCanonicalDecimalV1(provider.previousChainRosterVersion, true);
  const providerCurrent = parseCanonicalDecimalV1(provider.chainRosterVersion, false);
  const providerLocal = parseCanonicalDecimalV1(provider.localRosterVersion, false);
  const providerEffective = parseCanonicalDecimalV1(provider.effectiveRosterVersion, false);
  const current = parseCanonicalDecimalV1(revoked.rosterVersion, false);
  let composedProviderVersion = null;
  try {
    composedProviderVersion = composeRfc64RegisteredRosterVersionV1(
      provider.chainRosterVersion,
      provider.localRosterVersion,
    );
  } catch {
    // The common inconsistency error below keeps persisted diagnostics bounded.
  }
  if (
    provider.curatorMetadataRefreshed !== true
    || provider.providerMutationDenied !== true
    || !addresses.every((address) => (
      typeof address === 'string'
      && /^0x[0-9a-f]{40}$/u.test(address)
      && address === addresses[0]
    ))
    || addresses[0] !== topology.authorizedReceiver.agentAddress
    || ownerPrevious === null
    || ownerCurrent === null
    || providerPrevious === null
    || providerCurrent === null
    || current === null
    || revoked.rosterVersion !== provider.effectiveRosterVersion
    || ownerPrevious !== providerPrevious
    || ownerCurrent <= ownerPrevious
    || providerCurrent <= providerPrevious
    || providerCurrent !== ownerCurrent
    || providerLocal === null
    || providerEffective === null
    || composedProviderVersion !== provider.effectiveRosterVersion
    || !isDigestV1(owner.policyDigest)
    || owner.policyDigest !== catalog.policyDigest
    || provider.policyDigest !== owner.policyDigest
  ) {
    throw new TypeError('RFC-64 private gate revoked-receiver authority evidence is inconsistent');
  }
  return assertAppliedCatalogStateV1(
    revoked.state,
    catalog,
    topology.ownerProvider.agentAddress,
    'RFC-64 private gate revoked receiver',
    {
      expectedProviderPeerId: topology.authorizedProviderReceiver.peerId,
      memoryKind: 'current',
    },
  );
}

function assertAppliedCatalogStateV1(
  value,
  catalog,
  authorAddress,
  label,
  {
    catalogKind = 'current',
    expectedProviderPeerId,
    hasBootstrap = true,
    memoryKind = 'current',
    proofKind = 'catalog-row',
  } = {},
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
  if (hasBootstrap) stateKeys.push('bootstrap');
  assertExactKeysV1(state, stateKeys, `${label} state`);
  const expectedVersion = catalogKind === 'baseline'
    ? PRIVATE_CATALOG_MEMORY_EXPECTATION.finalizedVmBaseline.catalogVersion
    : catalog.catalogVersion;
  if (
    !isDigestV1(state.appliedHeadDigest)
    || (catalogKind === 'current' && state.appliedHeadDigest !== catalog.headObjectDigest)
    || (catalogKind === 'baseline' && state.appliedHeadDigest === catalog.headObjectDigest)
    || state.catalogScopeDigest !== catalog.scopeDigest
    || state.catalogVersion !== expectedVersion
    || state.inventoryRowCount !== catalog.inventoryRowCount
  ) {
    throw new TypeError(`${label} state is not bound to the catalog`);
  }
  const rpc = assertRpcEvidenceV1(state.rpc, `${label} RPC evidence`);
  if (!Number.isSafeInteger(state.rpcCalls) || state.rpcCalls !== rpc.total) {
    throw new TypeError(`${label} RPC total is inconsistent`);
  }
  if (hasBootstrap) {
    assertBootstrapEvidenceV1(
      state.bootstrap,
      expectedProviderPeerId,
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
  const memory = graphCounts.map((value, index) => {
    const row = plainRecordV1(value, `${label} graph ${index}`);
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
    const swmExpectation = memoryKind === 'baseline'
      ? PRIVATE_CATALOG_MEMORY_EXPECTATION.finalizedVmBaseline
      : PRIVATE_CATALOG_MEMORY_EXPECTATION.swm;
    if (proofKind === 'catalog-row') {
      assertExactKeysV1(proof, [
        'assertionVersion', 'catalogHeadDigest', 'kaId', 'kind', 'projectionDigest',
      ], `${label} graph ${index} SWM proof`);
      const packedKaId = parseCanonicalDecimalV1(proof.kaId, true, 256);
      const expectedAuthor = BigInt(authorAddress);
      if (
        proof.kind !== proofKind
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
        proof.kind !== proofKind
        || proof.assertionGraph !== row.swmGraph
        || proof.assertionVersion !== swmExpectation.assertionVersion
        || proof.shareOperationId
          !== `${PRIVATE_CATALOG_MEMORY_EXPECTATION.swm.shareOperationIdPrefix}${row.kaNumber}`
      ) throw new TypeError(`${label} graph ${index} has a malformed workspace proof`);
    }
    if (row.kaUal !== `did:dkg:${NETWORK_ID}/${authorAddress}/${row.kaNumber}`) {
      throw new TypeError(`${label} graph ${index} has a noncanonical KA UAL`);
    }
    const sourceVmExpectation = PRIVATE_CATALOG_MEMORY_EXPECTATION.finalizedVmBaseline;
    const vmExpectation = memoryKind === 'source'
      ? sourceVmExpectation
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
    if (memoryKind === 'source') {
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

function assertRpcEvidenceV1(value, label) {
  const rpc = plainRecordV1(value, label);
  assertExactKeysV1(rpc, ['byMethod', 'total'], label);
  const byMethod = plainRecordV1(rpc.byMethod, `${label} byMethod`);
  const total = Object.entries(byMethod).reduce((sum, [method, count]) => {
    if (
      method.length < 1
      || method.length > 128
      || !Number.isSafeInteger(count)
      || count < 0
      || !Number.isSafeInteger(sum + count)
    ) throw new TypeError(`${label} has malformed method accounting`);
    return sum + count;
  }, 0);
  if (rpc.total !== total) throw new TypeError(`${label} total is inconsistent`);
  return rpc;
}

function assertBootstrapEvidenceV1(value, expectedProviderPeerId, label) {
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
}

function assertFailoverBarrierV1(value, gateStartedAt, gateFinishedAt) {
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
  const receiverSpawnedAt = canonicalIsoInstantV1(barrier.receiverSpawnedAt, 'receiverSpawnedAt');
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
}

function assertRpcActorsEvidenceV1(value) {
  const actors = plainRecordV1(value, 'RFC-64 private gate RPC actors');
  assertExactKeysV1(
    actors,
    RFC64_PRIVATE_RUNTIME_RPC_PROCESS_IDS_V1,
    'RFC-64 private gate RPC actors',
  );
  const verified = Object.fromEntries(RFC64_PRIVATE_RUNTIME_RPC_PROCESS_IDS_V1.map((id) => {
    const rpc = assertRpcEvidenceV1(actors[id], `RFC-64 private gate RPC actor ${id}`);
    if (
      rpc.total > RFC64_PRIVATE_GATE_RPC_BUDGET_V1.total
      || Object.entries(rpc.byMethod).some(([method, count]) => (
        !Object.hasOwn(RFC64_PRIVATE_GATE_RPC_BUDGET_V1.methods, method)
        || count > RFC64_PRIVATE_GATE_RPC_BUDGET_V1.methods[method]
      ))
      || (RFC64_PRIVATE_FINALIZED_READ_PROCESS_IDS_V1.includes(id)
        && (!(rpc.byMethod.eth_call >= 1) || !(rpc.byMethod.eth_getBlockByNumber >= 1)))
    ) throw new TypeError(`RFC-64 private gate RPC actor ${id} is outside its fixed contract`);
    return [id, rpc];
  }));
  return Object.freeze(verified);
}

function assertStateRpcMatchesActorV1(stateRpc, actorRpc, label) {
  if (stableJsonV1(stateRpc) !== stableJsonV1(actorRpc)) {
    throw new TypeError(`RFC-64 private gate ${label} RPC evidence is not actor-bound`);
  }
}

function isDigestV1(value) {
  return typeof value === 'string' && /^0x[0-9a-f]{64}$/u.test(value);
}

function isAddressV1(value) {
  return typeof value === 'string'
    && /^0x[0-9a-f]{40}$/u.test(value)
    && value !== `0x${'00'.repeat(20)}`;
}

function parseCanonicalDecimalV1(value, allowZero, bits = 64) {
  if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]*)$/u.test(value)) return null;
  const parsed = BigInt(value);
  if ((!allowZero && parsed === 0n) || parsed >= (1n << BigInt(bits))) return null;
  return parsed;
}

function assertDenialClassificationV1(value, label) {
  if (
    value.denied !== true
    || !EXPECTED_PRIVATE_DENIAL_CLASSIFICATIONS_V1.some(
      ([failureClass, failureCode]) => (
        value.failureClass === failureClass && value.failureCode === failureCode
      ),
    )
  ) {
    throw new TypeError(`${label} is not a typed RFC-64 policy denial`);
  }
}

function boundedArrayV1(value, label) {
  if (
    !Array.isArray(value)
    || value.length < 1
    || value.length > MAX_PRIVATE_CATALOG_EVIDENCE_ROWS_V1
  ) {
    throw new TypeError(`${label} is outside the bounded row count`);
  }
  return value;
}

function plainRecordV1(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must be a plain object`);
  }
  if (Reflect.ownKeys(value).some((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return typeof key !== 'string'
      || descriptor === undefined
      || descriptor.enumerable !== true
      || !Object.hasOwn(descriptor, 'value');
  })) throw new TypeError(`${label} must contain only enumerable data fields`);
  return value;
}

function assertExactKeysV1(value, expected, label) {
  const actual = Reflect.ownKeys(value).sort();
  const canonicalExpected = [...expected].sort();
  if (
    actual.length !== canonicalExpected.length
    || actual.some((key, index) => key !== canonicalExpected[index])
  ) {
    throw new TypeError(`${label} has unknown or missing fields`);
  }
}

function stableJsonV1(value) {
  return JSON.stringify(sortKeysV1(value), null, 2);
}

function sortKeysV1(value) {
  if (Array.isArray(value)) return value.map(sortKeysV1);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, sortKeysV1(value[key])]),
    );
  }
  return value;
}
