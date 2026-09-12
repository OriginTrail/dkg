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

export function verifyVmParityV1({ config, request, sleep }) {
  return verifyVmParityFromSnapshotsV1({ config, request, sleep });
}

async function verifyVmParityFromSnapshotsV1({ config, request, sleep }) {
  const participatingNodes = [...new Set(config.contextGraphs.flatMap(
    ({ source, receiver }) => [source, receiver],
  ))];
  const parity = await pollUntilV1(
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
      return snapshot.every(Boolean) ? snapshot : false;
    },
    config.timing.parityTimeoutMs,
    config.timing.pollIntervalMs,
    sleep,
    () => failure('vm-parity-timeout', 'vm'),
    { retryError: isRetryableNodeRequestErrorV1 },
  );

  return mapCanaryPhaseV1(config.contextGraphs, async (contextGraph, index) => {
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
      cursorPresent: parity[index].cursorPresent,
      digestParity: parity[index].digestParity,
      rowCountParity: parity[index].rowCountParity,
      vmQueryChecked: contextGraph.vmAskSparql !== undefined,
      ...(contextGraph.vmAskSparql === undefined
        ? { requirement: 'vm-ask-query' }
        : {}),
    });
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
