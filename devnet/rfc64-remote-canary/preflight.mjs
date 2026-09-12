// SPDX-License-Identifier: Apache-2.0

import { failure } from './errors.mjs';
import { mapCanaryPhaseV1 } from './phase-helpers.mjs';
import {
  completeOperationalParityV1,
  decodeNodeCertificationStatusV1,
  equalCompleteOperationalParityV1,
  equalExactOperationalSnapshotV1,
  operationalStatusV1,
} from './status-contract.mjs';

/** @typedef {import('@origintrail-official/dkg-agent').Rfc64DaemonCertificationStatusV1} CertificationStatusV1 */
/** @typedef {import('./domain-contract.js').CanaryRequesterV1} CanaryRequesterV1 */
/** @typedef {import('./domain-contract.js').NormalizedCanaryNodeV1} NormalizedCanaryNodeV1 */
/** @typedef {import('./domain-contract.js').NormalizedRemoteCanaryConfigV1} NormalizedRemoteCanaryConfigV1 */

/** @typedef {Readonly<{ config: NormalizedRemoteCanaryConfigV1, request: CanaryRequesterV1 }>} PreflightBaseInputV1 */
/** @typedef {PreflightBaseInputV1 & Readonly<{ mode: 'initial' }>} InitialPreflightInputV1 */
/** @typedef {PreflightBaseInputV1 & Readonly<{
 *   mode: 'final',
 *   baseline: Readonly<{
 *     networkKey: string,
 *     nodeIdentities: ReadonlyMap<string, string>,
 *     operationalCertificationByNodeId: ReadonlyMap<string, Readonly<CertificationStatusV1>>,
 *   }>,
 * }>} FinalPreflightInputV1 */
/** @typedef {InitialPreflightInputV1 | FinalPreflightInputV1} PreflightInputV1 */

/** @param {unknown} value @returns {string} */
function canonicalChainId(value) {
  const canonical = String(value);
  if (!/^(0|[1-9][0-9]*)$/u.test(canonical)) {
    throw failure('node-chain-id-invalid', 'invariant');
  }
  return canonical;
}

/**
 * @param {PreflightInputV1} input
 */
export async function preflightAllNodesV1(input) {
  const { config, request } = input;
  const baseline = input.mode === 'final' ? input.baseline : null;
  const statuses = await mapCanaryPhaseV1(config.nodes, async (node) => {
    const status = await request.json(node, 'GET', '/api/status');
    const certification = validateNodePreflightV1(status, node, config, {
      requireCompleteOperationalStatus: baseline !== null,
    });
    return /** @type {const} */ ([node, certification]);
  });
  const raw = new Map(statuses.map(([node, status]) => [node.id, status]));
  const networkKeys = new Set([...raw.values()].map((status) => (
    `${status.networkId}:${status.chain?.chainId}`
  )));
  if (networkKeys.size !== 1) throw failure('node-network-mismatch', 'invariant');
  const networkKey = [...networkKeys][0];
  if (baseline !== null && networkKey !== baseline.networkKey) {
    throw failure('node-network-changed', 'invariant');
  }
  const participatingNodes = [...new Set(config.contextGraphs.flatMap(
    ({ source, receiver }) => [source, receiver],
  ))];
  const nodeIdentities = new Map(participatingNodes.map((node) => (
    [node.id, requiredCertification(raw, node.id).daemonIdentity]
  )));
  if (new Set(nodeIdentities.values()).size !== nodeIdentities.size) {
    throw failure('duplicate-node-identity', 'invariant');
  }
  if (baseline !== null) {
    for (const [nodeId, daemonIdentity] of nodeIdentities) {
      if (baseline.nodeIdentities.get(nodeId) !== daemonIdentity) {
        throw failure('node-identity-changed', 'invariant');
      }
    }
  }
  if (baseline !== null) {
    for (const contextGraph of config.contextGraphs) {
      if (!equalCompleteOperationalParityV1(
        raw.get(contextGraph.source.id),
        raw.get(contextGraph.receiver.id),
        contextGraph.id,
      )) throw failure('rfc64-operational-parity-changed', 'invariant');
    }
  }
  if (baseline !== null) {
    for (const contextGraph of config.contextGraphs) {
      for (const node of [contextGraph.source, contextGraph.receiver]) {
        if (!equalExactOperationalSnapshotV1(
          baseline.operationalCertificationByNodeId.get(node.id),
          raw.get(node.id),
          contextGraph.id,
        )) throw failure('rfc64-operational-evidence-drift', 'invariant');
      }
    }
  }
  const nodes = Object.freeze(config.nodes.map((node) => {
    const status = requiredCertification(raw, node.id);
    const relevant = config.contextGraphs.filter((entry) => (
      entry.source === node || entry.receiver === node
    ));
    return Object.freeze({
      nodeRef: node.nodeRef,
      role: node.role,
      commit: status.commit,
      chainId: canonicalChainId(status.chain?.chainId),
      syncReconcilerEnabled: true,
      catalogServiceEnabled: status.catalog.enabled,
      contextGraphs: Object.freeze(relevant.map((entry) => Object.freeze({
        contextGraphRef: entry.contextGraphRef,
        mode: 'catalog',
        legacySyncAllowed: false,
      }))),
    });
  }));
  return Object.freeze({ networkKey, nodeIdentities, nodes });
}

/**
 * @param {unknown} status
 * @param {NormalizedCanaryNodeV1} node
 * @param {NormalizedRemoteCanaryConfigV1} config
 * @param {{ requireCompleteOperationalStatus?: boolean }} [options]
 * @returns {Readonly<CertificationStatusV1>}
 */
export function validateNodePreflightV1(
  status,
  node,
  config,
  { requireCompleteOperationalStatus = false } = {},
) {
  const certification = decodeNodeCertificationStatusV1(status);
  if (certification.commit !== config.expectedCommit) throw failure('node-build-mismatch', 'invariant');
  if (certification.networkId.length < 1) {
    throw failure('node-network-missing', 'invariant');
  }
  if (certification.syncReconcilerEnabled !== true) {
    throw failure('sync-reconciler-disabled', 'invariant');
  }
  if (certification.catalog.enabled !== true) throw failure('rfc64-catalog-disabled', 'invariant');
  if (certification.catalog.killSwitch !== false) {
    throw failure('rfc64-kill-switch-active', 'invariant');
  }
  if (
    certification.chain?.configured !== true
    || !Number.isSafeInteger(certification.chain?.rpcEndpointCount)
    || certification.chain.rpcEndpointCount < 1
  ) throw failure('chain-rpc-not-configured', 'invariant');
  canonicalChainId(certification.chain.chainId);
  for (const entry of config.contextGraphs.filter((candidate) => (
    candidate.source === node || candidate.receiver === node
  ))) {
    if (certification.catalog.contextGraphModes[entry.id] !== entry.expectedMode) {
      throw failure('rfc64-mode-mismatch', 'invariant');
    }
    const operational = operationalStatusV1(certification, entry.id);
    if (operational === null || operational.effectiveMode !== entry.expectedMode) {
      throw failure('rfc64-operational-mode-missing', 'invariant');
    }
    if (operational.catalogServiceStarted !== true) {
      throw failure('rfc64-catalog-service-not-started', 'invariant');
    }
    if (operational.legacySyncAllowed !== false) {
      throw failure('rfc64-legacy-sync-allowed', 'invariant');
    }
    if (
      requireCompleteOperationalStatus
      && completeOperationalParityV1(certification, entry.id) === null
    ) throw failure('rfc64-operational-incomplete', 'invariant');
  }
  return certification;
}

/**
 * @param {ReadonlyMap<string, Readonly<CertificationStatusV1>>} values
 * @param {string} nodeId
 * @returns {Readonly<CertificationStatusV1>}
 */
function requiredCertification(values, nodeId) {
  const value = values.get(nodeId);
  if (value === undefined) throw failure('node-status-missing', 'invariant');
  return value;
}
