// SPDX-License-Identifier: Apache-2.0
import { parseLibp2pConnectCandidate } from '@origintrail-official/dkg-core';
import type { CoreChainCacheNetwork } from './core-chain-cache-config.js';
import { probeSnapshotPeerBatches } from './public-snapshot-peer-probes.js';

/** Bootstrap addresses are discovery hints only. Every supplier still proves registration. */
export function coreChainCacheSeeds(networks: readonly CoreChainCacheNetwork[]) {
  const seeds = new Map<string, ReturnType<typeof parseLibp2pConnectCandidate>>();
  for (const n of networks) for (const address of n.relays) {
    const candidate = parseLibp2pConnectCandidate(address);
    if (candidate?.targetPeerId) seeds.set(candidate.targetPeerId, candidate);
  }
  return seeds;
}

/** At most sixteen hints, admitted four at a time. Recovery advances only when a
 * batch cannot supply the requested content; empty relays cannot consume all slots. */
export function createCoreChainCacheContentPeers(ports: {
  candidates: readonly string[]; self: string;
  connect(peer: string, signal: AbortSignal): Promise<void>;
  admit(peer: string, signal: AbortSignal): Promise<boolean>;
}, signal: AbortSignal): { batches(): AsyncIterable<readonly string[]>; selected: readonly string[] } {
  const peers = [...new Set(ports.candidates)].filter(p => p !== ports.self).slice(0, 16);
  const selected: string[] = [], batches: Array<readonly string[]> = [];
  const probes = probeSnapshotPeerBatches({ candidates: peers,
    connect: (peer, probeSignal) => ports.connect(peer, probeSignal),
    authenticate: (peer, probeSignal) => ports.admit(peer, probeSignal),
  }, signal);
  return {
    selected,
    async *batches() {
      let index = 0;
      for (;;) {
        signal.throwIfAborted();
        if (index < batches.length) { yield batches[index++]; continue; }
        const batch = await probes.next();
        signal.throwIfAborted();
        if (batch.done) return;
        batches.push(batch.value); selected.push(...batch.value);
      }
    },
  };
}
