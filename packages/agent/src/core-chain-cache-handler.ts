// SPDX-License-Identifier: Apache-2.0
import { PUBLIC_GRAPH_SNAPSHOT_MAX_BYTES, type ChainAdapter } from '@origintrail-official/dkg-chain';
import type { ProtocolRouter } from '@origintrail-official/dkg-core';
import type { AgentWorkLifetime } from './agent-work-lifetime.js';
import type { PublicSnapshotServingRuntime } from './public-snapshot-serving-runtime.js';
import type { PublicSnapshotProofRuntime } from './public-snapshot-proof-runtime.js';
import { decodeCoreChainCacheSnapshotRequest, PUBLIC_GRAPH_SNAPSHOT_REQUEST_MAX_BYTES } from './public-snapshot-wire.js';
import { CACHE_PROOF_MAX_BYTES, decodeCacheChallenge, cacheProofCodec } from './core-chain-cache-proof.js';
import { CORE_CHAIN_CACHE_SOURCE_PROTOCOL, CORE_CHAIN_CACHE_SNAPSHOT_PROTOCOL, type CoreChainCacheNetwork } from './core-chain-cache-config.js';

export function registerCoreChainCacheHandlers(agent: {
  nodeRole: string; chain: ChainAdapter; peerId: string;
  router: Pick<ProtocolRouter, 'register'>; workLifetime: AgentWorkLifetime;
  networks: readonly CoreChainCacheNetwork[]; proofRuntime: PublicSnapshotProofRuntime;
  runtime: PublicSnapshotServingRuntime;
}): void {
  if (agent.nodeRole !== 'core' || !agent.chain.signMessage || !agent.networks.length) return;
  const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
  const unavailable = () => encode({ unavailable: true });
  agent.router.register(CORE_CHAIN_CACHE_SOURCE_PROTOCOL, (bytes, remote) => agent.proofRuntime.respond(remote.toString(), () => {
    const challenge = decodeCacheChallenge(bytes);
    if (challenge.requesterPeerId !== remote.toString() || challenge.responderPeerId !== agent.peerId
      || !agent.networks.some(n => n.registry.chainId === challenge.chainId && n.registry.deploymentId === challenge.deploymentId))
      throw new Error('Unavailable');
    return {
      assertCurrent: () => {}, validate: async () => {},
      proof: identityId => ({ chainId: agent.chain.chainId, deploymentId: agent.chain.deploymentId!, identityId }),
      codec: cacheProofCodec(challenge),
    };
  }), { maxReadBytes: CACHE_PROOF_MAX_BYTES });

  agent.router.register(CORE_CHAIN_CACHE_SNAPSHOT_PROTOCOL, async (bytes, remote) => {
    try {
      const r = decodeCoreChainCacheSnapshotRequest(bytes);
      if (!agent.networks.some(n => n.registry.chainId === r.chainId && n.registry.deploymentId === r.deploymentId))
        throw new Error('Unavailable');
      const snapshot = await agent.runtime.get(remote.toString(), { deploymentId: r.deploymentId, contextGraphId: r.contextGraphId, onChainId: r.onChainId }, r.refresh);
      agent.workLifetime.signal.throwIfAborted();
      const result = encode(snapshot);
      if (result.length > PUBLIC_GRAPH_SNAPSHOT_MAX_BYTES) throw new Error('Unavailable');
      return result;
    } catch { return unavailable(); }
  }, { maxReadBytes: PUBLIC_GRAPH_SNAPSHOT_REQUEST_MAX_BYTES });
}
