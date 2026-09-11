// SPDX-License-Identifier: Apache-2.0

import { canonicalChainId, failure, opaqueRef } from './common.mjs';
import { mapCanaryPhaseV1 } from './phase-helpers.mjs';

export async function preflightAllNodesV1({ config, request, nodeRefs }) {
  const statuses = await mapCanaryPhaseV1(config.nodes, async (node) => {
    const status = await request.json(node, 'GET', '/api/status');
    validateNodePreflightV1(status, node, config);
    return [node, status];
  });
  const raw = new Map(statuses.map(([node, status]) => [node.id, status]));
  const networkKeys = new Set([...raw.values()].map((status) => (
    `${String(status.networkId)}:${String(status.chain?.chainId)}`
  )));
  if (networkKeys.size !== 1) throw failure('node-network-mismatch', 'preflight');
  return Object.freeze(config.nodes.map((node) => {
    const status = raw.get(node.id);
    const relevant = config.contextGraphs.filter((entry) => (
      entry.sourceNodeId === node.id || entry.receiverNodeId === node.id
    ));
    return Object.freeze({
      nodeRef: nodeRefs.get(node.id),
      role: node.role,
      commit: status.commit,
      chainId: canonicalChainId(status.chain?.chainId),
      syncReconcilerEnabled: true,
      catalogServiceEnabled: status.rfc64Catalog.enabled === true,
      contextGraphs: Object.freeze(relevant.map((entry) => Object.freeze({
        contextGraphRef: opaqueRef('cg', entry.id),
        mode: 'catalog',
        legacySyncAllowed: false,
      }))),
    });
  }));
}

export function validateNodePreflightV1(status, node, config) {
  if (status === null || typeof status !== 'object' || Array.isArray(status)) {
    throw failure('preflight-status-malformed', 'preflight');
  }
  if (status.commit !== config.expectedCommit) throw failure('node-build-mismatch', 'preflight');
  if (typeof status.networkId !== 'string' || status.networkId.length < 1) {
    throw failure('node-network-missing', 'preflight');
  }
  if (status.syncLifecycle?.syncReconcilerEnabled !== true) {
    throw failure('sync-reconciler-disabled', 'preflight');
  }
  if (status.rfc64Catalog?.enabled !== true) throw failure('rfc64-catalog-disabled', 'preflight');
  if (status.rfc64Catalog?.rollout?.killSwitch !== false) {
    throw failure('rfc64-kill-switch-active', 'preflight');
  }
  if (
    status.chain?.configured !== true
    || !Number.isSafeInteger(status.chain?.rpcEndpointCount)
    || status.chain.rpcEndpointCount < 1
  ) throw failure('chain-rpc-not-configured', 'preflight');
  canonicalChainId(status.chain.chainId);
  for (const entry of config.contextGraphs.filter((candidate) => (
    candidate.sourceNodeId === node.id || candidate.receiverNodeId === node.id
  ))) {
    if (status.rfc64Catalog?.rollout?.contextGraphModes?.[entry.id] !== entry.expectedMode) {
      throw failure('rfc64-mode-mismatch', 'preflight');
    }
    const operational = operationalStatusV1(status, entry.id);
    if (operational === null || operational.effectiveMode !== entry.expectedMode) {
      throw failure('rfc64-operational-mode-missing', 'preflight');
    }
    if (operational.catalogServiceStarted !== true) {
      throw failure('rfc64-catalog-service-not-started', 'preflight');
    }
    if (operational.legacySyncAllowed !== false) {
      throw failure('rfc64-legacy-sync-allowed', 'preflight');
    }
  }
}

export function operationalStatusV1(status, contextGraphId) {
  const entries = status.rfc64Catalog?.contextGraphs;
  if (!Array.isArray(entries)) return null;
  return entries.find((entry) => entry?.contextGraphId === contextGraphId) ?? null;
}
