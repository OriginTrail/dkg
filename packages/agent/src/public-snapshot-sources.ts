import { verifyCacheProof } from './core-chain-cache-proof.js';
import { CORE_CHAIN_CACHE_SOURCE_PROTOCOL, type CoreChainCacheNetwork } from './core-chain-cache-config.js';
// SPDX-License-Identifier: Apache-2.0
import { createHash, randomBytes } from 'node:crypto';
import { startRequestAbortLifecycle, type ProtocolRouter } from '@origintrail-official/dkg-core';
import type { ChainAdapter } from '@origintrail-official/dkg-chain';
import { mapWithConcurrencyDrained } from './map-with-concurrency.js';
import {
  PUBLIC_SNAPSHOT_SOURCE_PROTOCOL, PUBLIC_SNAPSHOT_SOURCE_MAX_BYTES,
  verifySourceProof, type SnapshotSourceChallenge,
} from './public-snapshot-source-proof.js';

export interface SnapshotSourcePorts {
  chain: Pick<ChainAdapter, 'chainId' | 'deploymentId' | 'verifyACKIdentity'>;
  selfPeerId: string;
  cacheNetworks?: readonly CoreChainCacheNetwork[];
  /** Bounded phonebook/connected candidates are hints, never trust evidence. */
  candidates(signal: AbortSignal): Promise<readonly string[]>;
  connect(peer: string, signal: AbortSignal): Promise<void>;
  send: ProtocolRouter['send'];
}

/** Every registered Base core may qualify; one job probes at most 16 hints,
 * four at a time, and pins at most four proven sources. Random order avoids a
 * fixed preferred core. Nothing changes the caller's one-hour job lifetime. */
export async function selectSnapshotSources(
  ports: SnapshotSourcePorts,
  scope: { contextGraphId: string; onChainId: string },
  signal: AbortSignal,
): Promise<readonly string[]> {
  if (!ports.chain.deploymentId || (!ports.cacheNetworks && (ports.chain.chainId !== 'base:8453' || !ports.chain.verifyACKIdentity))) throw new Error('Registered Base mainnet source verification unavailable');
  signal.throwIfAborted();
  const nonce = randomBytes(32).toString('hex');
  const rank = (peer: string) => createHash('sha256').update(nonce).update(peer).digest('hex');
  const candidates = [...new Set(await ports.candidates(signal))]
    .filter(peer => typeof peer === 'string' && peer.length > 0 && peer.length <= 256 && peer !== ports.selfPeerId)
    .map(peer => ({ peer, rank: rank(peer) })).sort((a, b) => a.rank.localeCompare(b.rank))
    .slice(0, 16);
  const selected: string[] = [];
  for (let offset = 0; offset < candidates.length && selected.length < 4; offset += 4) {
    signal.throwIfAborted();
    // Keep every admitted probe in the job's physical lifetime, including a
    // dependency still retiring after a sibling observes cancellation.
    const proven = await mapWithConcurrencyDrained(candidates.slice(offset, offset + 4), 4, async ({ peer }) => {
      const lifetime = startRequestAbortLifecycle(10_000, [signal]);
      try {
        await ports.connect(peer, lifetime.signal);
        lifetime.signal.throwIfAborted();
        const challenge: SnapshotSourceChallenge = {
          version: 1, nonce, requesterPeerId: ports.selfPeerId, responderPeerId: peer,
          chainId: ports.chain.chainId, deploymentId: ports.chain.deploymentId!, ...scope,
        };
        const bytes = await ports.send(peer, ports.cacheNetworks ? CORE_CHAIN_CACHE_SOURCE_PROTOCOL : PUBLIC_SNAPSHOT_SOURCE_PROTOCOL,
          new TextEncoder().encode(JSON.stringify(challenge)),
          { signal: lifetime.signal, timeoutMs: 5_000, maxReadBytes: PUBLIC_SNAPSHOT_SOURCE_MAX_BYTES });
        const valid = ports.cacheNetworks
          ? await verifyCacheProof(bytes, challenge, ports.cacheNetworks, lifetime.signal)
          : await verifySourceProof(bytes, challenge, ports.chain.verifyACKIdentity!.bind(ports.chain), lifetime.signal);
        return valid ? peer : null;
      } catch {
        signal.throwIfAborted();
        return null;
      } finally { lifetime.release(); }
    });
    selected.push(...proven.filter((p): p is string => p !== null).slice(0, 4 - selected.length));
  }
  signal.throwIfAborted();
  if (!selected.length) throw new Error(ports.cacheNetworks ? 'No registered DKG core proved chain-cache identity' : 'No registered Base mainnet core proved snapshot availability');
  return Object.freeze(selected);
}
