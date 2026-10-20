// SPDX-License-Identifier: Apache-2.0
import type { ChainAdapter } from '@origintrail-official/dkg-chain';
import { PUBLIC_GRAPH_SNAPSHOT_MAX_BYTES } from '@origintrail-official/dkg-chain';
import type { ProtocolRouter } from '@origintrail-official/dkg-core';
import { DKG_CORE_CHAIN_CACHE, CORE_CHAIN_CACHE_SOURCE_PROTOCOL, CORE_CHAIN_CACHE_SNAPSHOT_PROTOCOL,
  type CoreChainCacheNetwork } from './core-chain-cache-config.js';
import { verifyCacheProof } from './core-chain-cache-proof.js';
import { BASE_MAINNET_SOURCE_POLICY, PUBLIC_SNAPSHOT_SOURCE_PROTOCOL, PUBLIC_SNAPSHOT_SOURCE_MAX_BYTES,
  verifySourceProof, type SnapshotSourceChallenge } from './public-snapshot-source-proof.js';
import { encodeCoreChainCacheSnapshotRequest, encodePublicGraphSnapshotRequest } from './public-snapshot-wire.js';
import { PUBLIC_GRAPH_SNAPSHOT_PROTOCOL } from './public-snapshot-reader.js';

type SnapshotScope = { contextGraphId: string; onChainId: string };
type SnapshotDeploymentScope = SnapshotScope & { chainId: string; deploymentId: string };
export type SnapshotSourcePolicyName = typeof BASE_MAINNET_SOURCE_POLICY | typeof DKG_CORE_CHAIN_CACHE;
export type SnapshotRequest = (peer: string, refresh: boolean, signal: AbortSignal) => Promise<Uint8Array>;
export interface SnapshotSourcePolicy {
  probe(peer: string, nonce: string, signal: AbortSignal): Promise<boolean>;
  request: SnapshotRequest;
  readonly unavailableMessage: string;
}

function bindRequest(send: ProtocolRouter['send'], protocol: string,
  encode: (refresh: boolean) => Uint8Array): SnapshotRequest {
  return (peer, refresh, signal) => send(peer, protocol, encode(refresh),
    { timeoutMs: 115_000, signal, maxReadBytes: PUBLIC_GRAPH_SNAPSHOT_MAX_BYTES });
}

/** Explicit peers need only snapshot transport, with no identity/discovery capability. */
export function bindSnapshotRequest(send: ProtocolRouter['send'], scope: SnapshotScope): SnapshotRequest {
  return bindRequest(send, PUBLIC_GRAPH_SNAPSHOT_PROTOCOL,
    refresh => encodePublicGraphSnapshotRequest({ version: 1, ...scope, refresh }));
}

function bindAuthenticatedPolicy(options: {
  selfPeerId: string; expected: SnapshotDeploymentScope; send: ProtocolRouter['send'];
  protocol: string; request: SnapshotRequest; unavailableMessage: string;
  verify(bytes: Uint8Array, challenge: SnapshotSourceChallenge, signal: AbortSignal): Promise<boolean>;
}): SnapshotSourcePolicy {
  return {
    unavailableMessage: options.unavailableMessage,
    request: options.request,
    probe: async (peer, nonce, signal) => {
      const challenge: SnapshotSourceChallenge = { version: 1, nonce, requesterPeerId: options.selfPeerId,
        responderPeerId: peer, ...options.expected };
      const bytes = await options.send(peer, options.protocol, new TextEncoder().encode(JSON.stringify(challenge)),
        { signal, timeoutMs: 5_000, maxReadBytes: PUBLIC_SNAPSHOT_SOURCE_MAX_BYTES });
      return options.verify(bytes, challenge, signal);
    },
  };
}

/** Only supported, capability-checked policies enter authenticated discovery. */
export function bindSnapshotSourcePolicy(options: {
  sourcePolicy: SnapshotSourcePolicyName;
  chain: Pick<ChainAdapter, 'chainId' | 'deploymentId' | 'verifyACKIdentity'>;
  selfPeerId: string; networks: readonly CoreChainCacheNetwork[];
  send: ProtocolRouter['send']; scope: SnapshotScope;
}): SnapshotSourcePolicy {
  const { chain, scope, send, selfPeerId } = options;
  if (options.sourcePolicy === DKG_CORE_CHAIN_CACHE) {
    if (!chain.deploymentId || !options.networks.length)
      throw new Error('DKG_Core_chain_cache is unavailable for this deployment');
    const expected = { chainId: chain.chainId, deploymentId: chain.deploymentId, ...scope };
    return bindAuthenticatedPolicy({ selfPeerId, send, expected,
      protocol: CORE_CHAIN_CACHE_SOURCE_PROTOCOL,
      request: bindRequest(send, CORE_CHAIN_CACHE_SNAPSHOT_PROTOCOL,
        refresh => encodeCoreChainCacheSnapshotRequest({ version: 1, ...expected, refresh })),
      unavailableMessage: 'No registered DKG core proved chain-cache identity',
      verify: (bytes, challenge, signal) => verifyCacheProof(bytes, challenge, options.networks, signal),
    });
  }
  if (options.sourcePolicy === BASE_MAINNET_SOURCE_POLICY) {
    const verifyIdentity = chain.verifyACKIdentity;
    if (!chain.deploymentId || chain.chainId !== 'base:8453' || !verifyIdentity)
      throw new Error('Registered Base mainnet source verification unavailable');
    return bindAuthenticatedPolicy({ selfPeerId, send,
      expected: { chainId: chain.chainId, deploymentId: chain.deploymentId, ...scope },
      protocol: PUBLIC_SNAPSHOT_SOURCE_PROTOCOL, request: bindSnapshotRequest(send, scope),
      unavailableMessage: 'No registered Base mainnet core proved snapshot availability',
      verify: (bytes, challenge, signal) => verifySourceProof(bytes, challenge, verifyIdentity.bind(chain), signal),
    });
  }
  throw new Error('Unsupported authenticated snapshot source policy');
}
