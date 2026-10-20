// SPDX-License-Identifier: Apache-2.0
import type { ChainAdapter } from '@origintrail-official/dkg-chain';
import { PUBLIC_GRAPH_SNAPSHOT_MAX_BYTES } from '@origintrail-official/dkg-chain';
import type { ProtocolRouter } from '@origintrail-official/dkg-core';
import { DKG_CORE_CHAIN_CACHE, CORE_CHAIN_CACHE_SOURCE_PROTOCOL, CORE_CHAIN_CACHE_SNAPSHOT_PROTOCOL,
  type CoreChainCacheNetwork } from './core-chain-cache-config.js';
import { verifyCacheProof } from './core-chain-cache-proof.js';
import { PUBLIC_SNAPSHOT_SOURCE_PROTOCOL, PUBLIC_SNAPSHOT_SOURCE_MAX_BYTES,
  verifySourceProof, type SnapshotSourceChallenge } from './public-snapshot-source-proof.js';
import { encodeCoreChainCacheSnapshotRequest, encodePublicGraphSnapshotRequest } from './public-snapshot-wire.js';
import { PUBLIC_GRAPH_SNAPSHOT_PROTOCOL } from './public-snapshot-reader.js';

export interface SnapshotSourcePolicy {
  probe(peer: string, nonce: string, signal: AbortSignal): Promise<boolean>;
  request(peer: string, refresh: boolean, signal: AbortSignal): Promise<Uint8Array>;
  readonly unavailableMessage: string;
}

/** Bind authentication and transport together before entering the bounded common algorithms. */
export function bindSnapshotSourcePolicy(options: {
  sourcePolicy?: string;
  chain: Pick<ChainAdapter, 'chainId' | 'deploymentId' | 'verifyACKIdentity'>;
  selfPeerId: string; networks: readonly CoreChainCacheNetwork[];
  send: ProtocolRouter['send'];
  scope: { contextGraphId: string; onChainId: string };
}): SnapshotSourcePolicy {
  const { chain, scope, send } = options;
  const expected = { chainId: chain.chainId, deploymentId: chain.deploymentId!, ...scope };
  const cache = options.sourcePolicy === DKG_CORE_CHAIN_CACHE;
  if (options.sourcePolicy && !cache && (!chain.deploymentId || chain.chainId !== 'base:8453' || !chain.verifyACKIdentity))
    throw new Error('Registered Base mainnet source verification unavailable');
  const protocol = cache ? CORE_CHAIN_CACHE_SOURCE_PROTOCOL : PUBLIC_SNAPSHOT_SOURCE_PROTOCOL;
  const verify = cache
    ? (bytes: Uint8Array, challenge: SnapshotSourceChallenge, signal: AbortSignal) => verifyCacheProof(bytes, challenge, options.networks, signal)
    : (bytes: Uint8Array, challenge: SnapshotSourceChallenge, signal: AbortSignal) => verifySourceProof(bytes, challenge, chain.verifyACKIdentity!.bind(chain), signal);
  const encodeRequest = cache
    ? (refresh: boolean) => encodeCoreChainCacheSnapshotRequest({ version: 1, ...expected, refresh })
    : (refresh: boolean) => encodePublicGraphSnapshotRequest({ version: 1, ...scope, refresh });
  const snapshotProtocol = cache ? CORE_CHAIN_CACHE_SNAPSHOT_PROTOCOL : PUBLIC_GRAPH_SNAPSHOT_PROTOCOL;
  return {
    unavailableMessage: cache ? 'No registered DKG core proved chain-cache identity' : 'No registered Base mainnet core proved snapshot availability',
    probe: async (peer, nonce, signal) => {
      const challenge: SnapshotSourceChallenge = { version: 1, nonce, requesterPeerId: options.selfPeerId,
        responderPeerId: peer, ...expected };
      const bytes = await send(peer, protocol, new TextEncoder().encode(JSON.stringify(challenge)),
        { signal, timeoutMs: 5_000, maxReadBytes: PUBLIC_SNAPSHOT_SOURCE_MAX_BYTES });
      return verify(bytes, challenge, signal);
    },
    request: (peer, refresh, signal) => send(peer, snapshotProtocol, encodeRequest(refresh),
      { timeoutMs: 115_000, signal, maxReadBytes: PUBLIC_GRAPH_SNAPSHOT_MAX_BYTES }),
  };
}
