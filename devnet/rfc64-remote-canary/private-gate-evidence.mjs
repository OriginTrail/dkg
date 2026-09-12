// SPDX-License-Identifier: Apache-2.0
// @ts-check

import { stableJsonV1 } from '../rfc64-artifact-v1.mjs';
import { failure } from './errors.mjs';
import { opaqueRef } from './references.mjs';

/** @typedef {import('./domain-contract.js').NormalizedCanaryPrivateGateEvidenceV1} NormalizedCanaryPrivateGateEvidenceV1 */
/** @typedef {import('./domain-contract.js').RemoteCanaryPrivateGateEvidenceResultV1} RemoteCanaryPrivateGateEvidenceResultV1 */
/** @typedef {Readonly<{ readFileFn: (path: string, encoding: BufferEncoding) => Promise<string>, expectedCommit: string, runStartedAt: string }>} PrivateGateEvidenceContextV1 */

const MAX_PRIVATE_GATE_EVIDENCE_BYTES = 4 * 1_048_576;
const PRIVATE_GATE_SCHEMA = 'dkg-rfc64-private-release-gate-v1';
const PRIVATE_GATE_VALIDATOR_URL = new URL(
  '../../packages/agent/devnet/rfc64-private-catalog/gate-artifact.mjs',
  import.meta.url,
);
// This is a deliberately closed compatibility boundary with #2560's
// dkg-rfc64-private-release-gate-v1 PASS artifact. A producer-side check added,
// removed, renamed, or left false must stop release certification until both
// contracts are consciously advanced together.
export const PRIVATE_GATE_PASS_CHECKS_V1 = Object.freeze([
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

/**
 * Consume one already-completed private gate as companion evidence for remote
 * authorization surfaces that are intentionally not exposed over HTTP.
 *
 * @param {NormalizedCanaryPrivateGateEvidenceV1} config
 * @param {PrivateGateEvidenceContextV1} context
 * @returns {Promise<Readonly<RemoteCanaryPrivateGateEvidenceResultV1>>}
 */
export async function collectPrivateGateAuthorizationEvidenceV1(config, context) {
  const text = await context.readFileFn(config.path, 'utf8').catch(() => {
    throw failure('private-gate-evidence-read-failed', 'evidence');
  });
  if (Buffer.byteLength(text) > MAX_PRIVATE_GATE_EVIDENCE_BYTES) {
    throw failure('private-gate-evidence-too-large', 'evidence');
  }

  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(text);
    const validatorModule = await import(PRIVATE_GATE_VALIDATOR_URL.href);
    if (typeof validatorModule.assertRfc64PrivateGatePassProvenanceV1 !== 'function') {
      throw new TypeError('private-gate-pass-validator-unavailable');
    }
    validatorModule.assertRfc64PrivateGatePassProvenanceV1(parsed);
  } catch {
    throw failure('private-gate-evidence-invalid', 'evidence');
  }
  const artifact = /** @type {Record<string, unknown>} */ (parsed);
  if (artifact.sourceRevision !== context.expectedCommit) {
    throw failure('private-gate-evidence-source-mismatch', 'evidence');
  }

  assertAuthorizationChecksV1(artifact.checks);
  const runStartedAt = Date.parse(context.runStartedAt);
  const finishedAt = Date.parse(/** @type {string} */ (artifact.finishedAt));
  if (!Number.isFinite(runStartedAt) || finishedAt > runStartedAt) {
    throw failure('private-gate-evidence-not-bound-to-run', 'evidence');
  }
  if (runStartedAt - finishedAt > config.maxAgeMinutes * 60_000) {
    throw failure('private-gate-evidence-stale', 'evidence');
  }

  let artifactRef;
  let runtimeProvenanceRef;
  try {
    artifactRef = opaqueRef('evidence', stableJsonV1(artifact));
    runtimeProvenanceRef = opaqueRef(
      'provenance',
      stableJsonV1(artifact.runtimeProvenance),
    );
  } catch {
    throw failure('private-gate-evidence-invalid', 'evidence');
  }
  return Object.freeze({
    schema: PRIVATE_GATE_SCHEMA,
    artifactRef,
    sourceRevision: /** @type {string} */ (artifact.sourceRevision),
    runtimeManifestDigest: /** @type {string} */ (artifact.runtimeManifestDigest),
    runtimeProvenanceRef,
    startedAt: /** @type {string} */ (artifact.startedAt),
    finishedAt: /** @type {string} */ (artifact.finishedAt),
  });
}

/** @param {unknown} value */
function assertAuthorizationChecksV1(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw failure('private-gate-evidence-authorization-checks', 'evidence');
  }
  const checks = /** @type {Record<string, unknown>} */ (value);
  const actualKeys = Object.keys(checks).sort();
  const expectedKeys = [...PRIVATE_GATE_PASS_CHECKS_V1].sort();
  if (
    actualKeys.length !== expectedKeys.length
    || actualKeys.some((key, index) => key !== expectedKeys[index])
    || PRIVATE_GATE_PASS_CHECKS_V1.some((check) => checks[check] !== true)
  ) {
    throw failure('private-gate-evidence-authorization-checks', 'evidence');
  }
}
