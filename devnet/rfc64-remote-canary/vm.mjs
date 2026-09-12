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

/** @typedef {import('@origintrail-official/dkg-agent').Rfc64DaemonCertificationStatusV1} CertificationStatusV1 */
/** @typedef {import('./domain-contract.js').CanaryRequesterV1} CanaryRequesterV1 */
/** @typedef {import('./domain-contract.js').NormalizedCanaryContextGraphV1} NormalizedCanaryContextGraphV1 */
/** @typedef {import('./domain-contract.js').NormalizedRemoteCanaryConfigV1} NormalizedRemoteCanaryConfigV1 */
/** @typedef {Readonly<{ cursorPresent: true, digestParity: true, rowCountParity: true }>} VmParitySnapshotV1 */
/** @typedef {Readonly<{ config: NormalizedRemoteCanaryConfigV1, request: CanaryRequesterV1, sleep: (milliseconds: number) => Promise<void> }>} VmParityInputV1 */

export { completeOperationalParityV1 } from './status-contract.mjs';

/** @param {VmParityInputV1} input */
export async function verifyVmParityV1({ config, request, sleep }) {
  return (await verifyVmParityEvidenceV1({ config, request, sleep })).checks;
}

/**
 * Retain the exact daemon snapshots against which the ASK evidence was read.
 * Final preflight uses them to reject even synchronized cursor advancement
 * between application evidence and certificate issuance.
 */
/** @param {VmParityInputV1} input */
export async function verifyVmParityEvidenceV1({ config, request, sleep }) {
  const participatingNodes = [...new Set(config.contextGraphs.flatMap(
    ({ source, receiver }) => [source, receiver],
  ))];
  const evidenceSnapshot = await pollUntilV1(
    async () => {
      const statusEntries = await mapCanaryPhaseV1(participatingNodes, async (node) => (
        /** @type {const} */ ([
          node.id,
          tryDecodeNodeCertificationStatusV1(
            await request.json(node, 'GET', '/api/status'),
          ),
        ])
      ));
      const statusByNodeId = new Map(statusEntries);
      const snapshot = config.contextGraphs.map((contextGraph) => readVmParityV1(
        statusByNodeId.get(contextGraph.source.id),
        statusByNodeId.get(contextGraph.receiver.id),
        contextGraph,
      ));
      if (snapshot.some((entry) => entry === false)) return false;
      const parity = /** @type {readonly VmParitySnapshotV1[]} */ (snapshot);
      const certificationByNodeId = /** @type {ReadonlyMap<string, Readonly<CertificationStatusV1>>} */ (
        statusByNodeId
      );
      return Object.freeze({ parity, certificationByNodeId });
    },
    config.timing.parityTimeoutMs,
    config.timing.pollIntervalMs,
    sleep,
    () => failure('vm-parity-timeout', 'vm'),
    { retryError: isRetryableNodeRequestErrorV1 },
  );

  const checks = await mapCanaryPhaseV1(config.contextGraphs, async (contextGraph, index) => {
    const vmAskSparql = contextGraph.vmAskSparql;
    if (vmAskSparql !== undefined) {
      const queryPassed = await Promise.all([
        contextGraph.source,
        contextGraph.receiver,
      ].map((node) => (
        askConfiguredQueryV1(node, contextGraph, vmAskSparql, 'verifiable-memory', request)
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

/**
 * @param {Readonly<CertificationStatusV1> | null | undefined} sourceStatus
 * @param {Readonly<CertificationStatusV1> | null | undefined} receiverStatus
 * @param {NormalizedCanaryContextGraphV1} contextGraph
 * @returns {VmParitySnapshotV1 | false}
 */
function readVmParityV1(sourceStatus, receiverStatus, contextGraph) {
  if (!equalCompleteOperationalParityV1(
    sourceStatus,
    receiverStatus,
    contextGraph.id,
  )) return false;
  return Object.freeze({ cursorPresent: true, digestParity: true, rowCountParity: true });
}
