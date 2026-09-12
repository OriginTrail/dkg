// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import { assertRfc64PrivateRuntimeProvenanceV1 } from './runtime-provenance.mjs';
import { isSafeChildDiagnosticPhaseV1 } from './child-protocol.mjs';

const SCHEMA = 'dkg-rfc64-private-release-gate-v1';
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

  assertOutsiderDenialEvidenceV1(artifact.outsider);
  assertRevokedReceiverDenialEvidenceV1(artifact.revokedReceiver);
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

function assertOutsiderDenialEvidenceV1(value) {
  const outsider = plainRecordV1(value, 'RFC-64 private gate outsider evidence');
  assertExactKeysV1(outsider, [
    'appliedHeadDigest',
    'denied',
    'failureClass',
    'failureCode',
    'graphCounts',
    'rpc',
  ], 'RFC-64 private gate outsider evidence');
  assertDenialClassificationV1(outsider, 'RFC-64 private gate outsider denial');
  if (outsider.appliedHeadDigest !== null) {
    throw new TypeError('RFC-64 private gate outsider denial applied a catalog head');
  }
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
}

function assertRevokedReceiverDenialEvidenceV1(value) {
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
    ['ownerMutation', 'providerObservation'],
    'RFC-64 private gate revoked-receiver authority',
  );
  const owner = plainRecordV1(
    authority.ownerMutation,
    'RFC-64 private gate owner revocation',
  );
  assertExactKeysV1(
    owner,
    ['policyDigest', 'revokedAgentAddress', 'rosterVersion'],
    'RFC-64 private gate owner revocation',
  );
  const provider = plainRecordV1(
    authority.providerObservation,
    'RFC-64 private gate provider revocation',
  );
  assertExactKeysV1(provider, [
    'curatorMetadataRefreshed',
    'policyDigest',
    'providerMutationDenied',
    'revokedAgentAddress',
    'rosterVersion',
  ], 'RFC-64 private gate provider revocation');
  const addresses = [
    revoked.revokedAgentAddress,
    owner.revokedAgentAddress,
    provider.revokedAgentAddress,
  ];
  const canonicalVersion = (version) => (
    typeof version === 'string' && /^[1-9][0-9]*$/u.test(version)
  );
  if (
    provider.curatorMetadataRefreshed !== true
    || provider.providerMutationDenied !== true
    || !addresses.every((address) => (
      typeof address === 'string'
      && /^0x[0-9a-f]{40}$/u.test(address)
      && address === addresses[0]
    ))
    || !canonicalVersion(revoked.rosterVersion)
    || !canonicalVersion(owner.rosterVersion)
    || !canonicalVersion(provider.rosterVersion)
    || revoked.rosterVersion !== provider.rosterVersion
    || BigInt(provider.rosterVersion) < BigInt(owner.rosterVersion)
    || typeof owner.policyDigest !== 'string'
    || !/^0x[0-9a-f]{64}$/u.test(owner.policyDigest)
    || provider.policyDigest !== owner.policyDigest
  ) {
    throw new TypeError('RFC-64 private gate revoked-receiver authority evidence is inconsistent');
  }
  const state = plainRecordV1(revoked.state, 'RFC-64 private gate revoked-receiver state');
  if (
    typeof state.appliedHeadDigest !== 'string'
    || !/^0x[0-9a-f]{64}$/u.test(state.appliedHeadDigest)
  ) {
    throw new TypeError('RFC-64 private gate revoked receiver lost its applied catalog head');
  }
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
  return value;
}

function assertExactKeysV1(value, expected, label) {
  const actual = Object.keys(value).sort();
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
