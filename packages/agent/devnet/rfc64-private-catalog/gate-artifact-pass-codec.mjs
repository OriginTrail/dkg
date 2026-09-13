// SPDX-License-Identifier: Apache-2.0

import { assertRfc64PrivateRuntimeProvenanceV2 } from './runtime-provenance.mjs';
import {
  RFC64_PRIVATE_GATE_SCHEMA_V2,
  RFC64_PRIVATE_PASS_TOP_LEVEL_KEYS_V1,
  RFC64_PRIVATE_RELEASE_CHECK_KEYS_V1,
  RFC64_PRIVATE_RELEASE_LIMITATION_V1,
} from './gate-artifact-contract.mjs';
import {
  assertExactKeysV1,
  canonicalIsoInstantV1,
  plainRecordV1,
  stableJsonV1,
} from './gate-artifact-codec-primitives.mjs';
import {
  assertPrivateGateStateRpcMatchesActorV1,
  decodePrivateGateRpcActorsEvidenceV1,
} from './gate-artifact-rpc-codec.mjs';
import {
  decodePrivateGateCatalogEvidenceV1,
  decodePrivateGateTopologyEvidenceV1,
} from './gate-artifact-scope-codecs.mjs';
import {
  decodePrivateGateFailoverBarrierV1,
  decodePrivateGateFailoverReceiverStateV1,
  decodePrivateGateProviderStateV1,
  decodePrivateGateReceiverBaselineStateV1,
  decodePrivateGateRestartedReceiverStateV1,
  decodePrivateGateSourceProviderStateV1,
} from './gate-artifact-state-codecs.mjs';
import {
  decodePrivateGateOutsiderDenialEvidenceV1,
  decodePrivateGateRevokedReceiverDenialEvidenceV1,
} from './gate-artifact-access-codecs.mjs';

/** A committed PASS must name one exact source revision, runtime build, and bounded run. */
export function assertRfc64PrivateGatePassProvenanceV2(artifact) {
  if (artifact === null || typeof artifact !== 'object') {
    throw new TypeError('RFC-64 private gate PASS artifact must be an object');
  }
  if (artifact.schema !== RFC64_PRIVATE_GATE_SCHEMA_V2 || artifact.status !== 'PASS') {
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
    provenance = assertRfc64PrivateRuntimeProvenanceV2(artifact.runtimeProvenance);
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
 * Each state variant uses a fixed codec so callers cannot weaken bootstrap,
 * memory, or proof requirements with option flags.
 */
export function decodeRfc64PrivateGatePassArtifactV2(input) {
  const artifact = plainRecordV1(input, 'RFC-64 private gate PASS artifact');
  assertExactKeysV1(
    artifact,
    RFC64_PRIVATE_PASS_TOP_LEVEL_KEYS_V1,
    'RFC-64 private gate PASS artifact',
  );
  if (
    typeof artifact.sourceRevision !== 'string'
    || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(artifact.sourceRevision)
  ) {
    throw new TypeError('RFC-64 private gate PASS requires one exact Git source revision');
  }
  if (artifact.limitation !== RFC64_PRIVATE_RELEASE_LIMITATION_V1) {
    throw new TypeError('RFC-64 private gate PASS has invalid fixed limitation metadata');
  }
  assertRfc64PrivateGatePassProvenanceV2(artifact);
  const startedAt = canonicalIsoInstantV1(artifact.startedAt, 'startedAt');
  const finishedAt = canonicalIsoInstantV1(artifact.finishedAt, 'finishedAt');
  if (startedAt > Date.now() || finishedAt > Date.now()) {
    throw new TypeError('RFC-64 private gate PASS interval is in the future');
  }

  const checks = plainRecordV1(artifact.checks, 'RFC-64 private gate PASS checks');
  assertExactKeysV1(
    checks,
    RFC64_PRIVATE_RELEASE_CHECK_KEYS_V1,
    'RFC-64 private gate PASS checks',
  );
  for (const key of RFC64_PRIVATE_RELEASE_CHECK_KEYS_V1) {
    if (checks[key] !== true) {
      throw new TypeError(`RFC-64 private gate PASS check is not true: ${key}`);
    }
  }

  const catalog = decodePrivateGateCatalogEvidenceV1(artifact.catalog);
  const topology = decodePrivateGateTopologyEvidenceV1(artifact.topology);
  const rpcActors = decodePrivateGateRpcActorsEvidenceV1(artifact.rpcActors);

  const sourceState = decodePrivateGateSourceProviderStateV1(
    artifact.sourceProvider,
    catalog,
    topology,
  );
  assertPrivateGateStateRpcMatchesActorV1(
    sourceState.rpc,
    rpcActors.owner,
    'source provider',
  );

  const providerState = decodePrivateGateProviderStateV1(
    artifact.provider2,
    catalog,
    topology,
  );
  assertPrivateGateStateRpcMatchesActorV1(
    providerState.rpc,
    rpcActors.provider2,
    'provider2',
  );

  const baselineState = decodePrivateGateReceiverBaselineStateV1(
    artifact.receiverBaseline,
    catalog,
    topology,
  );
  assertPrivateGateStateRpcMatchesActorV1(
    baselineState.rpc,
    rpcActors['receiver-seed'],
    'receiver baseline',
  );

  decodePrivateGateFailoverBarrierV1(artifact.failoverBarrier, startedAt, finishedAt);
  const failoverState = decodePrivateGateFailoverReceiverStateV1(
    artifact.failoverReceiver,
    catalog,
    topology,
  );
  assertPrivateGateStateRpcMatchesActorV1(
    failoverState.rpc,
    rpcActors.receiver,
    'failover receiver',
  );

  const outsiderRpc = decodePrivateGateOutsiderDenialEvidenceV1(
    artifact.outsider,
    catalog,
    topology,
    failoverState.kaNumbers,
  );
  assertPrivateGateStateRpcMatchesActorV1(outsiderRpc, rpcActors.outsider, 'outsider');

  const revokedState = decodePrivateGateRevokedReceiverDenialEvidenceV1(
    artifact.revokedReceiver,
    catalog,
    topology,
  );
  assertPrivateGateStateRpcMatchesActorV1(
    revokedState.rpc,
    rpcActors.receiver,
    'revoked receiver',
  );

  const restartedState = decodePrivateGateRestartedReceiverStateV1(
    artifact.restartedReceiver,
    catalog,
    topology,
  );
  assertPrivateGateStateRpcMatchesActorV1(
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
