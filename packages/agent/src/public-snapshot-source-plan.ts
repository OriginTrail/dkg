// SPDX-License-Identifier: Apache-2.0
import { createOperationContext } from '@origintrail-official/dkg-core';
import type { RpcUsageScope } from '@origintrail-official/dkg-chain';
import type { DKGAgent } from './dkg-agent.js';
import type { ResolvedDKGAgentConfig } from './dkg-agent-types.js';
import type { PublicSnapshotSyncOptions } from './public-snapshot-options.js';
import { DKG_CORE_CHAIN_CACHE } from './core-chain-cache-config.js';
import { coreChainCacheSeeds, connectCoreChainCacheSeed, createCoreChainCacheContentPeers } from './core-chain-cache-peers.js';
import { bindSnapshotRequest, bindSnapshotSourcePolicy, type SnapshotRequest, type SnapshotSourcePolicyName } from './public-snapshot-policy.js';
import { ensurePeerConnected } from './p2p/peer-connect.js';
import { selectSnapshotSources } from './public-snapshot-sources.js';

interface SnapshotSourceReport {
  sourcePolicy?: SnapshotSourcePolicyName;
  selectedCorePeerIds?: readonly string[];
  contentPeerIds?: readonly string[];
  chainCacheRpcUsage?: { chainId: string; methods: Readonly<Record<string, number>> }[];
}
interface SnapshotSourcePlan {
  inventoryPeers: readonly string[];
  request: SnapshotRequest;
  contentPeerBatches(): AsyncIterable<readonly string[]>;
  report(): SnapshotSourceReport;
}
interface SourceHost extends Pick<DKGAgent, 'peerId' | 'router' | 'node' | 'discovery'
  | 'peerResolver' | 'networkAdmissionCoordinator'> {
  config: Pick<ResolvedDKGAgentConfig, 'coreChainCacheNetworks'>;
  chain: Parameters<typeof bindSnapshotSourcePolicy>[0]['chain'];
  ensurePeerConnected: OmitThisParameter<DKGAgent['ensurePeerConnected']>;
}

/** Resolve all policy differences once. Discovery hints are explicit inputs to
 * inventory authentication and lazy, separately admitted content recovery. */
export async function createPublicSnapshotSourcePlan(agent: SourceHost, options: PublicSnapshotSyncOptions,
  signal: AbortSignal, rpcScope: RpcUsageScope): Promise<SnapshotSourcePlan> {
  const send = agent.router.send.bind(agent.router);
  const scope = { contextGraphId: options.contextGraphId, onChainId: options.onChainId };
  if (!options.sourcePolicy) {
    const peers = Object.freeze([...options.trustedCorePeerIds]);
    return { inventoryPeers: peers, request: bindSnapshotRequest(send, scope),
      contentPeerBatches: async function* () { yield peers; }, report: () => ({}) };
  }
  const cache = options.sourcePolicy === DKG_CORE_CHAIN_CACHE;
  const networks = cache ? agent.config.coreChainCacheNetworks : [];
  const policy = bindSnapshotSourcePolicy({ sourcePolicy: options.sourcePolicy, chain: agent.chain,
    selfPeerId: agent.peerId, networks, send, scope });
  signal.throwIfAborted();
  const seeds = coreChainCacheSeeds(networks);
  const dataSeeds = coreChainCacheSeeds(networks.filter(n => n.registry.deploymentId === agent.chain.deploymentId));
  const connected = agent.node.libp2p.getConnections().map(c => c.remotePeer.toString());
  const hints = await agent.discovery.findSnapshotCorePeerIds(signal).catch(error => {
    signal.throwIfAborted();
    if (!connected.length && !seeds.size) throw error;
    return [];
  });
  signal.throwIfAborted();
  const inventoryCandidates = [...connected, ...hints, ...seeds.keys()];
  const contentCandidates = [...dataSeeds.keys(), ...connected, ...hints];
  const peers = await selectSnapshotSources({ ...policy, selfPeerId: agent.peerId,
    candidates: async () => inventoryCandidates,
    connect: async (peer, requestSignal) => {
      if (!cache) return agent.ensurePeerConnected(peer, { signal: requestSignal });
      if (seeds.has(peer)) await connectCoreChainCacheSeed(agent.node.libp2p, seeds.get(peer)!, requestSignal);
      else await ensurePeerConnected(agent.peerResolver, peer, { signal: requestSignal });
      if (!await agent.networkAdmissionCoordinator.ensureCacheAdmitted(peer, createOperationContext('connect'), { signal: requestSignal }))
        throw new Error('Peer is not admitted for chain-cache authentication');
    },
  }, signal);
  const content = cache ? createCoreChainCacheContentPeers({ candidates: contentCandidates, self: agent.peerId,
    connect: (peer, requestSignal) => dataSeeds.has(peer)
      ? connectCoreChainCacheSeed(agent.node.libp2p, dataSeeds.get(peer)!, requestSignal)
      : agent.ensurePeerConnected(peer, { signal: requestSignal }),
    admit: (peer, requestSignal) => agent.networkAdmissionCoordinator.ensureAdmitted(peer, createOperationContext('sync'), { signal: requestSignal }),
  }, signal) : undefined;
  return { inventoryPeers: peers, request: policy.request,
    contentPeerBatches: content?.batches ?? (async function* () { yield peers; }),
    report: () => ({ sourcePolicy: options.sourcePolicy, selectedCorePeerIds: peers,
      ...(content ? { contentPeerIds: [...content.selected], chainCacheRpcUsage: networks.map(n => ({
        chainId: n.registry.chainId, methods: n.registry.rpcUsage(rpcScope),
      })) } : {}),
    }),
  };
}
