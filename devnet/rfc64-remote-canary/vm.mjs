// SPDX-License-Identifier: Apache-2.0

import { RemoteCanaryError, failure } from './errors.mjs';
import {
  isRetryableNodeRequestErrorV1,
  mapCanaryPhaseV1,
  pollUntilV1,
} from './phase-helpers.mjs';
import { askContextGraphPairsV1 } from './query.mjs';
import {
  equalCompleteOperationalParityV1,
} from './status-contract.mjs';

/** @typedef {import('@origintrail-official/dkg-agent').Rfc64DaemonCertificationStatusV1} CertificationStatusV1 */
/** @typedef {import('./domain-contract.js').CanaryNodeClientV1} CanaryNodeClientV1 */
/** @typedef {import('./domain-contract.js').NormalizedCanaryContextGraphV1} NormalizedCanaryContextGraphV1 */
/** @typedef {import('./domain-contract.js').NormalizedRemoteCanaryConfigV1} NormalizedRemoteCanaryConfigV1 */
/** @typedef {Readonly<{ cursorPresent: true, digestParity: true, rowCountParity: true }>} VmParitySnapshotV1 */
/** @typedef {Readonly<{ config: NormalizedRemoteCanaryConfigV1, client: CanaryNodeClientV1, sleep: (milliseconds: number) => Promise<void> }>} VmParityInputV1 */

export { completeOperationalParityV1 } from './status-contract.mjs';

/** @param {VmParityInputV1} input @returns {Promise<import('./domain-contract.js').RemoteCanaryVmParityResultV1>} */
export async function verifyVmParityV1({ config, client, sleep }) {
  return (await verifyVmParityEvidenceV1({ config, client, sleep })).checks;
}

/**
 * Retain the exact daemon snapshots against which the ASK evidence was read.
 * Final preflight uses them to reject even synchronized cursor advancement
 * between application evidence and certificate issuance.
 */
/** @param {VmParityInputV1} input @returns {Promise<Readonly<{ checks: import('./domain-contract.js').RemoteCanaryVmParityResultV1, certificationByNodeId: ReadonlyMap<string, Readonly<CertificationStatusV1>> }>>} */
export async function verifyVmParityEvidenceV1({ config, client, sleep }) {
  const participatingNodes = [...new Set(config.contextGraphs.flatMap(
    ({ source, receiver }) => [source, receiver],
  ))];
  const evidenceSnapshot = await pollUntilV1(
    async () => {
      const statusEntries = await mapCanaryPhaseV1(participatingNodes, async (node) => (
        /** @type {const} */ ([
          node.id,
          await readCertificationStatusOrNullV1(client, node),
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

  const queryResults = await askContextGraphPairsV1(
    config.contextGraphs,
    'vmAskSparql',
    'verifiable-memory',
    client,
  );
  const checks = Object.freeze(config.contextGraphs.map((contextGraph, index) => {
    const vmAskSparql = contextGraph.vmAskSparql;
    if (vmAskSparql === undefined) {
      return Object.freeze({
        contextGraphRef: contextGraph.contextGraphRef,
        status: 'EVIDENCE_REQUIRED',
        statusParity: 'PASS',
        cursorPresent: evidenceSnapshot.parity[index].cursorPresent,
        digestParity: evidenceSnapshot.parity[index].digestParity,
        rowCountParity: evidenceSnapshot.parity[index].rowCountParity,
        vmQueryChecked: false,
        requirement: 'vm-ask-query',
      });
    }
    const pair = queryResults[index];
    if (pair === null) throw new TypeError('vm-query-result-missing');
    if (!pair.source || !pair.receiver) throw failure('vm-query-parity-failed', 'vm');
    return Object.freeze({
      contextGraphRef: contextGraph.contextGraphRef,
      status: 'PASS',
      statusParity: 'PASS',
      cursorPresent: evidenceSnapshot.parity[index].cursorPresent,
      digestParity: evidenceSnapshot.parity[index].digestParity,
      rowCountParity: evidenceSnapshot.parity[index].rowCountParity,
      vmQueryChecked: true,
    });
  }));
  return Object.freeze({
    checks,
    certificationByNodeId: evidenceSnapshot.certificationByNodeId,
  });
}

/**
 * A malformed status is an incomplete polling observation; transport failures
 * retain their retry classification in pollUntilV1.
 * @param {CanaryNodeClientV1} client
 * @param {import('./domain-contract.js').NormalizedCanaryNodeV1} node
 */
async function readCertificationStatusOrNullV1(client, node) {
  try {
    return await client.readCertificationStatus(node);
  } catch (error) {
    if (error instanceof RemoteCanaryError && error.code === 'preflight-status-malformed') {
      return null;
    }
    throw error;
  }
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
