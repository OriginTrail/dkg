import { describe, expect, it, vi } from 'vitest';
import * as chain from '@origintrail-official/dkg-chain';
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
  it('normalizes ordered own and foreign endpoints before applying the eight-endpoint bound', () => {
    const create = vi.spyOn(chain, 'createEvmCoreChainCacheRegistry');
    const own = registry['mainnet-a'];
    const foreign = registry['mainnet-b'];
    const configured = { ...registry, 'mainnet-b': { ...foreign, chain: { ...foreign.chain!,
      rpcUrl: ' http://127.0.0.1:4 ', rpcUrls: ['http://127.0.0.1:4', ' http://127.0.0.1:5 '] } } };
    const result = buildCoreChainCacheConfig({ enabled: true, role: 'edge', networkName: 'mainnet-a',
      networkId: own.networkId, chain: { ...own.chain!, rpcUrl: ' http://127.0.0.1:2 ',
        rpcUrls: [...Array(9).fill('http://127.0.0.1:2'), ' http://127.0.0.1:3 ', ''] } }, configured);
    try {
      expect(create.mock.calls.map(([options]) => options.rpcUrls)).toEqual([
        ['http://127.0.0.1:2', 'http://127.0.0.1:3'], ['http://127.0.0.1:4', 'http://127.0.0.1:5'],
      ]);
    } finally { result.coreChainCacheNetworks!.forEach(n => n.registry.destroy()); create.mockRestore(); }
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
  it.each(['mainnet-base', 'testnet'])('keeps a default %s core with nine endpoints valid', name => {
    const create = vi.spyOn(chain, 'createEvmCoreChainCacheRegistry');
    const own = loadBundledNetworkRegistry()[name];
    const urls = Array.from({ length: 9 }, (_, i) => `http://127.0.0.1:${10 + i}`);
    const configuredChain = { ...own.chain!, rpcUrl: urls[0]!, rpcUrls: urls.slice(1) };
    const original = structuredClone(configuredChain);
    let result: ReturnType<typeof buildCoreChainCacheConfig> | undefined;
    try {
      result = buildCoreChainCacheConfig({ role: 'core', networkName: name,
        networkId: own.networkId, chain: configuredChain });
      expect(result.DKG_Core_chain_cache).toBe(true);
      expect(create.mock.calls.find(([c]) => c.chainId === own.chain!.chainId)![0].rpcUrls).toEqual(urls.slice(0, 8));
      expect(configuredChain).toEqual(original);
      expect(chain.resolveRpcUrls(configuredChain.rpcUrl, configuredChain.rpcUrls)).toEqual(urls);
    } finally { result?.coreChainCacheNetworks?.forEach(n => n.registry.destroy()); create.mockRestore(); }
  });
});
