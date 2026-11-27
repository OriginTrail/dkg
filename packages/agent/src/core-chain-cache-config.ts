// SPDX-License-Identifier: Apache-2.0
import type { CoreChainCacheRegistry } from '@origintrail-official/dkg-chain';
import type { DkgNetworkIdentity } from '@origintrail-official/dkg-core';

/** Local deployment configuration, never accepted from a remote proof or phonebook. */
export interface CoreChainCacheNetwork {
  readonly identity: DkgNetworkIdentity;
  readonly registry: CoreChainCacheRegistry;
  readonly relays: readonly string[];
}

export const DKG_CORE_CHAIN_CACHE = 'DKG_Core_chain_cache' as const;
export const CORE_CHAIN_CACHE_SOURCE_PROTOCOL = '/dkg/10.0.0/core-chain-cache-source/1';
export const CORE_CHAIN_CACHE_SNAPSHOT_PROTOCOL = '/dkg/10.0.0/core-chain-cache-snapshot/1';
export const isCoreChainCacheProtocol = (protocol: string): boolean =>
  protocol === CORE_CHAIN_CACHE_SOURCE_PROTOCOL || protocol === CORE_CHAIN_CACHE_SNAPSHOT_PROTOCOL;

/** Capture configuration once. A caller mutating its input cannot widen a running node's trust. */
export function snapshotCoreChainCacheNetworks(enabled: boolean | undefined,
  networks: readonly CoreChainCacheNetwork[] | undefined, own: DkgNetworkIdentity,
  deploymentId: string | undefined): readonly CoreChainCacheNetwork[] {
  if (enabled !== undefined && typeof enabled !== 'boolean') throw new Error('DKG_Core_chain_cache must be a boolean');
  if (!enabled) return Object.freeze([]);
  if (!networks?.length || networks.length > 16 || !networks.some(n => n.registry.deploymentId === deploymentId
    && n.identity.networkId === own.networkId && n.registry.chainId === own.chainId)
    || new Set(networks.map(n => n.registry.deploymentId)).size !== networks.length)
    throw new Error('Invalid DKG Core chain cache deployments');
  return Object.freeze(networks.map(n => {
    if (!n.identity.networkId || n.identity.chainId !== n.registry.chainId || !n.registry.deploymentId)
      throw new Error('Invalid DKG Core chain cache deployment identity');
    return Object.freeze({ identity: Object.freeze({ ...n.identity }), relays: Object.freeze([...n.relays]),
      registry: Object.freeze({ chainId: n.registry.chainId, deploymentId: n.registry.deploymentId,
        verifyACKIdentity: n.registry.verifyACKIdentity.bind(n.registry),
        readPublicGraphSnapshot: n.registry.readPublicGraphSnapshot.bind(n.registry),
        rpcUsage: n.registry.rpcUsage.bind(n.registry), drainRpcUsage: n.registry.drainRpcUsage?.bind(n.registry), destroy: n.registry.destroy.bind(n.registry) }) });
  }));
}
