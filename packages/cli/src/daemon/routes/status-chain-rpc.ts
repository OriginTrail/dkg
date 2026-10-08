// SPDX-License-Identifier: Apache-2.0

import {
  getKnowledgeAssetVersionSnapshotHealth,
  getRpcFailoverStats,
} from '@origintrail-official/dkg-chain';

/**
 * Chain endpoint observability for `/api/status.chain`: process-wide, across
 * every chain adapter in this daemon. Counts, hosts and closed classes only,
 * never an RPC URL.
 */
export function chainRpcStatusFields() {
  const rpcFailoverStats = getRpcFailoverStats();
  return {
    // Multi-RPC failover observability (counts only — no RPC URLs).
    rpcFailovers: rpcFailoverStats.failovers,
    rpcExhaustions: rpcFailoverStats.exhaustions,
    rpcFailoversByClass: rpcFailoverStats.byErrorClass,
    // Per-provider distribution (host-only). `served` is the success side
    // — which endpoint is actually carrying the traffic — and `failed` is
    // the failover side. Together they show provider health at a glance.
    rpcServedByEndpointHost: rpcFailoverStats.servedByEndpointHost,
    rpcFailoversByEndpointHost: rpcFailoverStats.byEndpointHost,
    // Endpoint-stickiness: times the client stuck to a backup after a
    // failover (a rising count = a configured primary is degraded).
    rpcPreferredEstablishments: rpcFailoverStats.preferredEstablishments,
    // The read that decides whether a confirmed publish is still the current
    // version needs a complete answer from every endpoint at one pinned block.
    // `failingEndpoints` names each endpoint whose latest such read gave none
    // (position, host, step, closed class): while it is not empty, confirmed
    // publishes on this node wait.
    versionSnapshot: getKnowledgeAssetVersionSnapshotHealth(),
  };
}
