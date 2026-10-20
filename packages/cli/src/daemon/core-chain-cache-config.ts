// SPDX-License-Identifier: Apache-2.0
import { createEvmCoreChainCacheRegistry, type RpcRequestAdmission } from '@origintrail-official/dkg-chain';
import type { DKGAgentConfig } from '@origintrail-official/dkg-agent';
import { loadBundledNetworkRegistry, validateNetworkConfigReadiness, type NetworkConfig } from '../config.js';

/** Mainnet and testnet use identical logic but disjoint, locally installed registries. */
export function coreChainCacheEnvironment(name: string): 'mainnet' | 'testnet' | undefined {
  if (name.startsWith('mainnet-')) return 'mainnet';
  if (name === 'testnet' || name.startsWith('testnet-')) return 'testnet';
  return undefined;
}
export function buildCoreChainCacheConfig(input: {
  enabled?: boolean; role: string; networkName?: string; networkId?: string;
  chain?: { chainId?: string; hubAddress?: string; rpcUrl?: string; rpcUrls?: readonly string[]; finalityConfirmations?: number };
  admission?: RpcRequestAdmission;
}, registry: Readonly<Record<string, NetworkConfig>> = loadBundledNetworkRegistry()): Pick<DKGAgentConfig, 'DKG_Core_chain_cache' | 'coreChainCacheNetworks'> {
  if (input.enabled !== undefined && typeof input.enabled !== 'boolean') throw new Error('DKG_Core_chain_cache must be a boolean');
  if (!(input.enabled ?? input.role === 'core')) return { DKG_Core_chain_cache: false };
  const name = input.networkName ?? '';
  const environment = coreChainCacheEnvironment(name);
  const own = registry[name];
  if (!environment || !own?.chain || !validateNetworkConfigReadiness(own).ok || own.networkId !== input.networkId
    || own.chain.chainId !== input.chain?.chainId
    || own.chain.hubAddress.toLowerCase() !== input.chain?.hubAddress?.toLowerCase()) {
    if (input.enabled) throw new Error('DKG_Core_chain_cache requires an official deployment');
    return { DKG_Core_chain_cache: false };
  }
  const entries = Object.entries(registry).filter(([key, n]) => coreChainCacheEnvironment(key) === environment
    && n.chain && validateNetworkConfigReadiness(n).ok);
  if (entries.length > 16) throw new Error('DKG Core chain cache registry exceeds bound');
  return { DKG_Core_chain_cache: true, coreChainCacheNetworks: Object.freeze(entries.map(([key, network]) => {
    const chain = network.chain!;
    // Respect the operator's endpoints for its own deployment; foreign endpoints are local shipped configuration.
    const connection = key === name ? input.chain! : chain;
    const urls = [...new Set([connection.rpcUrl ?? chain.rpcUrl, ...(connection.rpcUrls ?? [])])];
    return Object.freeze({
      identity: Object.freeze({ networkId: network.networkId, genesisId: network.genesisId,
        chainId: chain.chainId, networkConfigName: key }),
      relays: Object.freeze([...network.relays]),
      registry: createEvmCoreChainCacheRegistry({ chainId: chain.chainId, hubAddress: chain.hubAddress,
        rpcUrls: urls, finalityConfirmations: connection.finalityConfirmations ?? chain.finalityConfirmations ?? 1,
        admission: input.admission }),
    });
  })) };
}
