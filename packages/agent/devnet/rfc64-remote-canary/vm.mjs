// SPDX-License-Identifier: Apache-2.0

import {
  assertCanonicalDecimalU64,
  assertCanonicalDigest,
  assertCanonicalTimestampMs,
} from '@origintrail-official/dkg-core';

import { failure } from './errors.mjs';
import {
  isRetryableNodeRequestErrorV1,
  mapCanaryPhaseV1,
  pollUntilV1,
} from './phase-helpers.mjs';
import { operationalStatusV1 } from './preflight.mjs';
import { askConfiguredQueryV1 } from './query.mjs';

export function verifyVmParityV1({ config, request, sleep }) {
  return mapCanaryPhaseV1(config.contextGraphs, async (contextGraph) => {
    const parity = await pollUntilV1(
      async () => readVmParityV1(
        contextGraph.source,
        contextGraph.receiver,
        contextGraph,
        request,
      ),
      config.timing.parityTimeoutMs,
      config.timing.pollIntervalMs,
      sleep,
      () => failure('vm-parity-timeout', 'vm-parity'),
      { retryError: isRetryableNodeRequestErrorV1 },
    );
    if (contextGraph.vmEvidenceState === 'PLANNED') {
      const queryPassed = await Promise.all([
        contextGraph.source,
        contextGraph.receiver,
      ].map((node) => (
        askConfiguredQueryV1(node, contextGraph, contextGraph.vmAskSparql, 'verifiable-memory', request)
      )));
      if (!queryPassed.every(Boolean)) throw failure('vm-query-parity-failed', 'vm-parity');
    }
    return Object.freeze({
      contextGraphRef: contextGraph.contextGraphRef,
      status: contextGraph.vmEvidenceState === 'EVIDENCE_REQUIRED'
        ? 'EVIDENCE_REQUIRED'
        : 'PASS',
      statusParity: 'PASS',
      cursorPresent: parity.cursorPresent,
      digestParity: parity.digestParity,
      rowCountParity: parity.rowCountParity,
      vmQueryChecked: contextGraph.vmEvidenceState === 'PLANNED',
      ...(contextGraph.vmEvidenceState === 'EVIDENCE_REQUIRED'
        ? { requirement: 'vm-ask-query' }
        : {}),
    });
  });
}

async function readVmParityV1(source, receiver, contextGraph, request) {
  const [sourceStatus, receiverStatus] = await Promise.all([
    request.json(source, 'GET', '/api/status'),
    request.json(receiver, 'GET', '/api/status'),
  ]);
  const sourceOperational = completeOperationalParityV1(sourceStatus, contextGraph.id);
  const receiverOperational = completeOperationalParityV1(receiverStatus, contextGraph.id);
  if (sourceOperational === null || receiverOperational === null) return false;
  const keys = [
    'expectedCatalogHeadDigest',
    'appliedCatalogHeadDigest',
    'expectedInventoryDigest',
    'appliedInventoryDigest',
    'expectedRowCount',
    'appliedRowCount',
    'missingRowCount',
    'catalogVersion',
  ];
  if (!keys.every((key) => sourceOperational[key] === receiverOperational[key])) return false;
  return Object.freeze({ cursorPresent: true, digestParity: true, rowCountParity: true });
}

export function completeOperationalParityV1(status, contextGraphId) {
  const operational = operationalStatusV1(status, contextGraphId);
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
