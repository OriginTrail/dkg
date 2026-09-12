// SPDX-License-Identifier: Apache-2.0

import { failure } from './errors.mjs';
import {
  isRetryableNodeRequestErrorV1,
  mapCanaryPhaseV1,
  pollUntilV1,
} from './phase-helpers.mjs';
import { askConfiguredQueryV1 } from './query.mjs';
import {
  equalCompleteOperationalParityV1,
  tryDecodeNodeCertificationStatusV1,
} from './status-contract.mjs';

export { completeOperationalParityV1 } from './status-contract.mjs';

export async function verifyVmParityV1({ config, request, sleep }) {
  return (await verifyVmParityEvidenceV1({ config, request, sleep })).checks;
}

/**
 * Retain the exact daemon snapshots against which the ASK evidence was read.
 * Final preflight uses them to reject even synchronized cursor advancement
 * between application evidence and certificate issuance.
 */
export async function verifyVmParityEvidenceV1({ config, request, sleep }) {
  const participatingNodes = [...new Set(config.contextGraphs.flatMap(
    ({ source, receiver }) => [source, receiver],
  ))];
  const evidenceSnapshot = await pollUntilV1(
    async () => {
      const statusEntries = await mapCanaryPhaseV1(participatingNodes, async (node) => (
        [
          node.id,
          tryDecodeNodeCertificationStatusV1(
            await request.json(node, 'GET', '/api/status'),
          ),
        ]
      ));
      const statusByNodeId = new Map(statusEntries);
      const snapshot = config.contextGraphs.map((contextGraph) => readVmParityV1(
        statusByNodeId.get(contextGraph.source.id),
        statusByNodeId.get(contextGraph.receiver.id),
        contextGraph,
      ));
      return snapshot.every(Boolean)
        ? Object.freeze({ parity: snapshot, certificationByNodeId: statusByNodeId })
        : false;
    },
    config.timing.parityTimeoutMs,
    config.timing.pollIntervalMs,
    sleep,
    () => failure('vm-parity-timeout', 'vm'),
    { retryError: isRetryableNodeRequestErrorV1 },
  );

  const checks = await mapCanaryPhaseV1(config.contextGraphs, async (contextGraph, index) => {
    if (contextGraph.vmAskSparql !== undefined) {
      const queryPassed = await Promise.all([
        contextGraph.source,
        contextGraph.receiver,
      ].map((node) => (
        askConfiguredQueryV1(node, contextGraph, contextGraph.vmAskSparql, 'verifiable-memory', request)
      )));
      if (!queryPassed.every(Boolean)) throw failure('vm-query-parity-failed', 'vm');
    }
    return Object.freeze({
      contextGraphRef: contextGraph.contextGraphRef,
      status: contextGraph.vmAskSparql === undefined
        ? 'EVIDENCE_REQUIRED'
        : 'PASS',
      statusParity: 'PASS',
      cursorPresent: evidenceSnapshot.parity[index].cursorPresent,
      digestParity: evidenceSnapshot.parity[index].digestParity,
      rowCountParity: evidenceSnapshot.parity[index].rowCountParity,
      vmQueryChecked: contextGraph.vmAskSparql !== undefined,
      ...(contextGraph.vmAskSparql === undefined
        ? { requirement: 'vm-ask-query' }
        : {}),
    });
  });
  return Object.freeze({
    checks,
    certificationByNodeId: evidenceSnapshot.certificationByNodeId,
  });
}

function readVmParityV1(sourceStatus, receiverStatus, contextGraph) {
  if (!equalCompleteOperationalParityV1(
    sourceStatus,
    receiverStatus,
    contextGraph.id,
  )) return false;
  return Object.freeze({ cursorPresent: true, digestParity: true, rowCountParity: true });
}
