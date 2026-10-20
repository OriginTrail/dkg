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
type PolicyChain = Pick<ChainAdapter, 'chainId' | 'deploymentId' | 'verifyACKIdentity'>;
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

type ResolvedSnapshotPolicy = { chainId: string; deploymentId: string } & (
  | { name: typeof BASE_MAINNET_SOURCE_POLICY; verifyIdentity: NonNullable<ChainAdapter['verifyACKIdentity']> }
  | { name: typeof DKG_CORE_CHAIN_CACHE; networks: readonly CoreChainCacheNetwork[] }
);

/** The same capability resolution drives both advertisement and binding. */
export function resolveSnapshotSourcePolicies(chain: PolicyChain,
  networks: readonly CoreChainCacheNetwork[]): ResolvedSnapshotPolicy[] {
  if (!chain.deploymentId) return [];
  const deployment = { chainId: chain.chainId, deploymentId: chain.deploymentId };
  const policies: ResolvedSnapshotPolicy[] = [];
  if (chain.chainId === 'base:8453' && chain.verifyACKIdentity)
    policies.push({ ...deployment, name: BASE_MAINNET_SOURCE_POLICY, verifyIdentity: chain.verifyACKIdentity.bind(chain) });
  if (networks.length) policies.push({ ...deployment, name: DKG_CORE_CHAIN_CACHE, networks });
  return policies;
}

/** Only supported, capability-checked policies enter authenticated discovery. */
export function bindSnapshotSourcePolicy(options: {
  sourcePolicy: SnapshotSourcePolicyName; chain: PolicyChain;
  selfPeerId: string; networks: readonly CoreChainCacheNetwork[];
  send: ProtocolRouter['send']; scope: SnapshotScope;
}): SnapshotSourcePolicy {
  const { chain, scope, send, selfPeerId } = options;
  const policy = resolveSnapshotSourcePolicies(chain, options.networks).find(p => p.name === options.sourcePolicy);
  if (!policy) {
    if (options.sourcePolicy === DKG_CORE_CHAIN_CACHE)
      throw new Error('DKG_Core_chain_cache is unavailable for this deployment');
    if (options.sourcePolicy === BASE_MAINNET_SOURCE_POLICY)
      throw new Error('Registered Base mainnet source verification unavailable');
    throw new Error('Unsupported authenticated snapshot source policy');
  }
  const expected = { chainId: policy.chainId, deploymentId: policy.deploymentId, ...scope };
  if (policy.name === DKG_CORE_CHAIN_CACHE) {
    return bindAuthenticatedPolicy({ selfPeerId, send, expected,
      protocol: CORE_CHAIN_CACHE_SOURCE_PROTOCOL,
      request: bindRequest(send, CORE_CHAIN_CACHE_SNAPSHOT_PROTOCOL,
        refresh => encodeCoreChainCacheSnapshotRequest({ version: 1, ...expected, refresh })),
      unavailableMessage: 'No registered DKG core proved chain-cache identity',
      verify: (bytes, challenge, signal) => verifyCacheProof(bytes, challenge, policy.networks, signal),
    });
  }
  return bindAuthenticatedPolicy({ selfPeerId, send, expected,
    protocol: PUBLIC_SNAPSHOT_SOURCE_PROTOCOL, request: bindSnapshotRequest(send, scope),
    unavailableMessage: 'No registered Base mainnet core proved snapshot availability',
    verify: (bytes, challenge, signal) => verifySourceProof(bytes, challenge, policy.verifyIdentity, signal),
  });
}
