// SPDX-License-Identifier: Apache-2.0

import {
  assertCanonicalDecimalU64,
  assertCanonicalDigest,
  assertCanonicalTimestampMs,
} from '@origintrail-official/dkg-core';
import {
  decodeRfc64DaemonCertificationStatusV1,
  RFC64_DAEMON_CERTIFICATION_COMPLETE_PARITY_KEYS_V1,
} from '@origintrail-official/dkg-agent';

import { failure } from './errors.mjs';

export function decodeNodeCertificationStatusV1(status) {
  if (status === null || typeof status !== 'object' || Array.isArray(status)) {
    throw failure('preflight-status-malformed', 'invariant');
  }
  try {
    return decodeRfc64DaemonCertificationStatusV1(status.rfc64Certification);
  } catch {
    throw failure('preflight-status-malformed', 'invariant');
  }
}

export function tryDecodeNodeCertificationStatusV1(status) {
  try {
    return decodeNodeCertificationStatusV1(status);
  } catch {
    return null;
  }
}

export function operationalStatusV1(certification, contextGraphId) {
  return certification?.catalog.contextGraphs.find(
    (entry) => entry.contextGraphId === contextGraphId,
  ) ?? null;
}

export function completeOperationalParityV1(certification, contextGraphId) {
  const operational = operationalStatusV1(certification, contextGraphId);
  if (operational === null) return null;
  try {
    for (const key of [
      'expectedCatalogHeadDigest',
      'appliedCatalogHeadDigest',
      'expectedInventoryDigest',
      'appliedInventoryDigest',
    ]) assertCanonicalDigest(operational[key], key);
    for (const key of [
      'expectedRowCount',
      'appliedRowCount',
      'missingRowCount',
      'catalogVersion',
    ]) assertCanonicalDecimalU64(operational[key], key);
    assertCanonicalTimestampMs(
      operational.lastSuccessfulAdvanceAt,
      'lastSuccessfulAdvanceAt',
    );
  } catch {
    return null;
  }
  if (
    operational.effectiveMode !== 'catalog'
    || operational.phase !== 'complete'
    || operational.authorityState !== 'accepted'
    || operational.authorityFreshness !== 'current'
    || operational.missingRowCount !== '0'
    || operational.expectedCatalogHeadDigest !== operational.appliedCatalogHeadDigest
    || operational.expectedInventoryDigest !== operational.appliedInventoryDigest
    || operational.expectedRowCount !== operational.appliedRowCount
  ) return null;
  return operational;
}

export function equalCompleteOperationalParityV1(
  sourceCertification,
  receiverCertification,
  contextGraphId,
) {
  const source = completeOperationalParityV1(sourceCertification, contextGraphId);
  const receiver = completeOperationalParityV1(receiverCertification, contextGraphId);
  return source !== null
    && receiver !== null
    && RFC64_DAEMON_CERTIFICATION_COMPLETE_PARITY_KEYS_V1.every(
      (key) => source[key] === receiver[key],
    );
}

/**
 * Compare one node's exact complete snapshot across time. The successful
 * application timestamp is node-local, so it belongs here rather than in the
 * cross-node parity predicate above.
 */
export function equalExactOperationalSnapshotV1(
  expectedCertification,
  currentCertification,
  contextGraphId,
) {
  const expected = completeOperationalParityV1(expectedCertification, contextGraphId);
  const current = completeOperationalParityV1(currentCertification, contextGraphId);
  return expected !== null
    && current !== null
    && [
      ...RFC64_DAEMON_CERTIFICATION_COMPLETE_PARITY_KEYS_V1,
      'lastSuccessfulAdvanceAt',
    ].every((key) => expected[key] === current[key]);
}
