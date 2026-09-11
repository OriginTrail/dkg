// SPDX-License-Identifier: Apache-2.0

import { failure, opaqueRef } from './common.mjs';
import { mapCanaryPhaseV1, pollUntilV1 } from './phase-helpers.mjs';
import { operationalStatusV1 } from './preflight.mjs';
import { askConfiguredQueryV1 } from './swm.mjs';

export function verifyVmParityV1({ config, nodeById, request, sleep }) {
  return mapCanaryPhaseV1(config.contextGraphs, async (contextGraph) => {
    const source = nodeById.get(contextGraph.sourceNodeId);
    const receiver = nodeById.get(contextGraph.receiverNodeId);
    const parity = await pollUntilV1(
      async () => readVmParityV1(source, receiver, contextGraph, request),
      config.timing.parityTimeoutMs,
      config.timing.pollIntervalMs,
      sleep,
      () => failure('vm-parity-timeout', 'vm-parity'),
    );
    if (contextGraph.vmAskSparql !== undefined) {
      const queryPassed = await Promise.all([source, receiver].map((node) => (
        askConfiguredQueryV1(node, contextGraph, contextGraph.vmAskSparql, 'verifiable-memory', request)
      )));
      if (!queryPassed.every(Boolean)) throw failure('vm-query-parity-failed', 'vm-parity');
    }
    return Object.freeze({
      contextGraphRef: opaqueRef('cg', contextGraph.id),
      status: contextGraph.vmAskSparql === undefined ? 'EVIDENCE_REQUIRED' : 'PASS',
      statusParity: 'PASS',
      cursorPresent: parity.cursorPresent,
      digestParity: parity.digestParity,
      rowCountParity: parity.rowCountParity,
      vmQueryChecked: contextGraph.vmAskSparql !== undefined,
      ...(contextGraph.vmAskSparql === undefined ? { requirement: 'vm-ask-query' } : {}),
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
  const keys = ['appliedCatalogHeadDigest', 'appliedInventoryDigest', 'appliedRowCount', 'catalogVersion'];
  if (!keys.every((key) => sourceOperational[key] === receiverOperational[key])) return false;
  return Object.freeze({ cursorPresent: true, digestParity: true, rowCountParity: true });
}

function completeOperationalParityV1(status, contextGraphId) {
  const operational = operationalStatusV1(status, contextGraphId);
  if (operational === null) return null;
  if (
    operational.effectiveMode !== 'catalog'
    || operational.phase !== 'complete'
    || operational.authorityState !== 'accepted'
    || operational.authorityFreshness !== 'current'
    || operational.missingRowCount !== '0'
    || operational.catalogVersion === null
    || operational.catalogVersion === undefined
    || operational.lastSuccessfulAdvanceAt === null
    || operational.lastSuccessfulAdvanceAt === undefined
    || operational.appliedCatalogHeadDigest === null
    || operational.appliedInventoryDigest === null
    || operational.appliedRowCount === null
    || operational.expectedCatalogHeadDigest !== operational.appliedCatalogHeadDigest
    || operational.expectedInventoryDigest !== operational.appliedInventoryDigest
    || operational.expectedRowCount !== operational.appliedRowCount
  ) return null;
  return operational;
}
