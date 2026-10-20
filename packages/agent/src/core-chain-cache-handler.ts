// SPDX-License-Identifier: Apache-2.0
import { ethers } from 'ethers';
import { PUBLIC_GRAPH_SNAPSHOT_MAX_BYTES, type ChainAdapter } from '@origintrail-official/dkg-chain';
import { startRequestAbortLifecycle, type ProtocolRouter } from '@origintrail-official/dkg-core';
import type { AgentWorkLifetime } from './agent-work-lifetime.js';
import { PublicSnapshotServingRuntime } from './public-snapshot-serving-runtime.js';
import { PublicSnapshotAdmission } from './public-snapshot-admission.js';
import { encodePublicGraphSnapshotRequest, PUBLIC_GRAPH_SNAPSHOT_REQUEST_MAX_BYTES } from './public-snapshot-wire.js';
import { CACHE_PROOF_MAX_BYTES, decodeCacheChallenge, cacheProofPayload } from './core-chain-cache-proof.js';
import { CORE_CHAIN_CACHE_SOURCE_PROTOCOL, CORE_CHAIN_CACHE_SNAPSHOT_PROTOCOL, type CoreChainCacheNetwork } from './core-chain-cache-config.js';

export function registerCoreChainCacheHandlers(agent: {
  nodeRole: string; chain: ChainAdapter; peerId: string;
  router: Pick<ProtocolRouter, 'register'>; workLifetime: AgentWorkLifetime;
  networks: readonly CoreChainCacheNetwork[];
}): { runtime: PublicSnapshotServingRuntime; sourceAdmission: PublicSnapshotAdmission } | undefined {
  if (agent.nodeRole !== 'core' || !agent.chain.signMessage || !agent.networks.some(n =>
    n.registry.chainId === agent.chain.chainId && n.registry.deploymentId === agent.chain.deploymentId)) return;
  const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
  const unavailable = () => encode({ unavailable: true });
  const admission = new PublicSnapshotAdmission(Date.now, 4);
  let active = 0;
  agent.router.register(CORE_CHAIN_CACHE_SOURCE_PROTOCOL, async (bytes, remote) => {
    let release: (() => void) | undefined;
    const lifetime = startRequestAbortLifecycle(10_000, [agent.workLifetime.signal]);
    try {
      const c = decodeCacheChallenge(bytes);
      if (c.requesterPeerId !== remote.toString() || c.responderPeerId !== agent.peerId || active >= 4
        || !agent.networks.some(n => n.registry.chainId === c.chainId && n.registry.deploymentId === c.deploymentId))
        throw new Error('Unavailable');
      release = admission.acquire(remote.toString()); active++;
      const operation = (async () => {
        const identityId = (await agent.chain.getIdentityId({ signal: lifetime.signal })).toString();
        lifetime.signal.throwIfAborted();
        const p = { chainId: agent.chain.chainId, deploymentId: agent.chain.deploymentId!, identityId };
        const signature = await agent.chain.signMessage!(cacheProofPayload(c, p), { signal: lifetime.signal });
        lifetime.signal.throwIfAborted();
        return encode({ ...p, signature: ethers.Signature.from({
          r: ethers.hexlify(signature.r), yParityAndS: ethers.hexlify(signature.vs),
        }).serialized });
      })();
      agent.workLifetime.track(operation);
      return await operation;
    } catch { return unavailable(); }
    finally { if (release) { active--; release(); } lifetime.release(); }
  }, { maxReadBytes: CACHE_PROOF_MAX_BYTES });

  // One runtime across deployments retains the existing global two-builder/eight-entry bounds.
  const runtime = new PublicSnapshotServingRuntime(async (key, onChainId, signal) => {
    const [deploymentId, graph] = JSON.parse(key) as [string, string];
    const registry = agent.networks.find(n => n.registry.deploymentId === deploymentId)!.registry;
    // The reader checks public access, graph name, finality, all roots and the pinned block.
    return registry.readPublicGraphSnapshot(graph, onChainId, { signal });
  }, agent.workLifetime);
  agent.router.register(CORE_CHAIN_CACHE_SNAPSHOT_PROTOCOL, async (bytes, remote) => {
    try {
      const r = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      if (!r || typeof r !== 'object' || Array.isArray(r)
        || Object.keys(r).sort().join(',') !== 'chainId,contextGraphId,deploymentId,onChainId,refresh,version'
        || !agent.networks.some(n => n.registry.chainId === r.chainId && n.registry.deploymentId === r.deploymentId))
        throw new Error('Unavailable');
      encodePublicGraphSnapshotRequest({ version: r.version, contextGraphId: r.contextGraphId,
        onChainId: r.onChainId, refresh: r.refresh });
      const snapshot = await runtime.get(remote.toString(), JSON.stringify([r.deploymentId, r.contextGraphId]), r.onChainId, r.refresh);
      agent.workLifetime.signal.throwIfAborted();
      const result = encode(snapshot);
      if (result.length > PUBLIC_GRAPH_SNAPSHOT_MAX_BYTES) throw new Error('Unavailable');
      return result;
    } catch { return unavailable(); }
  }, { maxReadBytes: PUBLIC_GRAPH_SNAPSHOT_REQUEST_MAX_BYTES });
  return { runtime, sourceAdmission: admission };
}
