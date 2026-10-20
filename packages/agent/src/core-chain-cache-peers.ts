// SPDX-License-Identifier: Apache-2.0
import { parseLibp2pConnectCandidate, connectLibp2pCandidate } from '@origintrail-official/dkg-core';
import type { CoreChainCacheNetwork } from './core-chain-cache-config.js';
import { startRequestAbortLifecycle } from '@origintrail-official/dkg-core';
import { mapWithConcurrencyDrained } from './map-with-concurrency.js';

/** Bootstrap addresses are discovery hints only. Every supplier still proves registration. */
export function coreChainCacheSeeds(networks: readonly CoreChainCacheNetwork[]) {
  const seeds = new Map<string, ReturnType<typeof parseLibp2pConnectCandidate>>();
  for (const n of networks) for (const address of n.relays) {
    const candidate = parseLibp2pConnectCandidate(address);
    if (candidate?.targetPeerId) seeds.set(candidate.targetPeerId, candidate);
  }
  return seeds;
}

/** Content peers pass ordinary data-network admission; cache-only admission never qualifies. */
export async function selectCoreChainCacheContentPeers(ports: {
  candidates: readonly string[]; self: string;
  connect(peer: string, signal: AbortSignal): Promise<void>;
  admit(peer: string, signal: AbortSignal): Promise<boolean>;
}, signal: AbortSignal): Promise<readonly string[]> {
  const peers = [...new Set(ports.candidates)].filter(p => p !== ports.self).slice(0, 16);
  const accepted: string[] = [];
  for (let offset = 0; offset < peers.length && accepted.length < 4; offset += 4) {
    signal.throwIfAborted();
    const batch = await mapWithConcurrencyDrained(peers.slice(offset, offset + 4), 4, async peer => {
      const lifetime = startRequestAbortLifecycle(10_000, [signal]);
      try {
        await ports.connect(peer, lifetime.signal);
        lifetime.signal.throwIfAborted();
        const admitted = await ports.admit(peer, lifetime.signal);
        lifetime.signal.throwIfAborted();
        return admitted ? peer : null;
      } catch { signal.throwIfAborted(); return null; }
      finally { lifetime.release(); }
    });
    accepted.push(...batch.filter((p): p is string => p !== null).slice(0, 4 - accepted.length));
  }
  signal.throwIfAborted();
  return Object.freeze(accepted);
}
export async function connectCoreChainCacheSeed(
  libp2p: Parameters<typeof connectLibp2pCandidate>[0],
  candidate: NonNullable<ReturnType<typeof parseLibp2pConnectCandidate>>,
  signal: AbortSignal,
): Promise<void> {
  await connectLibp2pCandidate(libp2p, candidate, { expectedPeerId: candidate.targetPeerId, signal, timeoutMs: 5_000 });
}
