import { describe, expect, it } from 'vitest';
import { buildCoreChainCacheConfig } from '../src/daemon/core-chain-cache-config.js';
import { loadBundledNetworkRegistry, type NetworkConfig } from '../src/config.js';

const network = (name: string, chainId: string): NetworkConfig => ({ networkName: name,
  genesisId: name, networkId: name, genesisVersion: 1, relays: [], defaultNodeRole: 'core',
  chain: { type: 'evm', chainId, hubAddress: '0x0000000000000000000000000000000000000001', rpcUrl: 'http://127.0.0.1:1' } });
const registry = { 'mainnet-a': network('mainnet-a', 'base:1'), 'mainnet-b': network('mainnet-b', 'gnosis:2'),
  testnet: network('testnet', 'base:3'), 'testnet-b': network('testnet-b', 'gnosis:4'), private: network('private', 'evm:5') };

describe('official chain-cache deployment configuration', () => {
  it('boots against the actual shipped registries without activating pre-deployment networks', () => {
    const bundled = loadBundledNetworkRegistry();
    for (const name of ['mainnet-base', 'mainnet-gnosis', 'testnet']) {
      const own = bundled[name];
      const result = buildCoreChainCacheConfig({ enabled: true, role: 'edge', networkName: name,
        networkId: own.networkId, chain: own.chain });
      expect(result.coreChainCacheNetworks?.map(n => n.registry.chainId).sort()).toEqual(
        name === 'testnet' ? ['base:84532'] : ['base:8453', 'gnosis:100']);
      for (const n of result.coreChainCacheNetworks!) { expect(n.registry.rpcUsage()).toEqual({}); n.registry.destroy(); }
    }
  });
  it.each(['mainnet-a', 'testnet'] as const)('uses identical logic within %s and no other environment', name => {
    const own = registry[name];
    const result = buildCoreChainCacheConfig({ enabled: true, role: 'edge', networkName: name,
      networkId: own.networkId, chain: own.chain }, registry);
    const expected = name.startsWith('mainnet') ? ['base:1', 'gnosis:2'] : ['base:3', 'gnosis:4'];
    expect(result.coreChainCacheNetworks?.map(n => n.registry.chainId)).toEqual(expected);
    for (const n of result.coreChainCacheNetworks!) { expect(n.registry.rpcUsage()).toEqual({}); n.registry.destroy(); }
  });
  it('refuses custom hubs and private environments and leaves an unconfigured Edge opted out', () => {
    const own = registry['mainnet-a'];
    expect(() => buildCoreChainCacheConfig({ enabled: true, role: 'edge', networkName: 'mainnet-a',
      networkId: own.networkId, chain: { ...own.chain, hubAddress: 'different' } }, registry)).toThrow('official deployment');
    expect(() => buildCoreChainCacheConfig({ enabled: true, role: 'edge', networkName: 'private',
      networkId: 'private', chain: registry.private.chain }, registry)).toThrow('official deployment');
    expect(buildCoreChainCacheConfig({ role: 'edge' }, registry)).toEqual({ DKG_Core_chain_cache: false });
    expect(buildCoreChainCacheConfig({ enabled: false, role: 'core' }, registry)).toEqual({ DKG_Core_chain_cache: false });
  });
});
