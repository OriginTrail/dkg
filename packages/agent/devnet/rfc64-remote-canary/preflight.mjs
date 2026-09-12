// SPDX-License-Identifier: Apache-2.0

import { failure } from './errors.mjs';
import { mapCanaryPhaseV1 } from './phase-helpers.mjs';
import {
  completeOperationalParityV1,
  decodeNodeCertificationStatusV1,
  operationalStatusV1,
} from './status-contract.mjs';

function canonicalChainId(value) {
  const canonical = String(value);
  if (!/^(0|[1-9][0-9]*)$/u.test(canonical)) {
    throw failure('node-chain-id-invalid', 'invariant');
  }
  return canonical;
}

export async function preflightAllNodesV1({ config, request, expectedNetworkKey }) {
  const statuses = await mapCanaryPhaseV1(config.nodes, async (node) => {
    const status = await request.json(node, 'GET', '/api/status');
    const certification = validateNodePreflightV1(status, node, config, {
      requireCompleteOperationalStatus: expectedNetworkKey !== undefined,
    });
    return [node, certification];
  });
  const raw = new Map(statuses.map(([node, status]) => [node.id, status]));
  const networkKeys = new Set([...raw.values()].map((status) => (
    `${status.networkId}:${status.chain?.chainId}`
  )));
  if (networkKeys.size !== 1) throw failure('node-network-mismatch', 'invariant');
  const networkKey = [...networkKeys][0];
  if (expectedNetworkKey !== undefined && networkKey !== expectedNetworkKey) {
    throw failure('node-network-changed', 'invariant');
  }
  const nodes = Object.freeze(config.nodes.map((node) => {
    const status = raw.get(node.id);
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
  return Object.freeze({ networkKey, nodes });
}

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
