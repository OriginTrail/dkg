import { describe, expect, it, afterEach } from 'vitest';

import { numericChainId, chainIdHex } from '../src/ui/web3/chainId.js';
import { synthesizeChain, publicClientFor, _resetClientCacheForTesting } from '../src/ui/web3/clients.js';

afterEach(() => _resetClientCacheForTesting());

describe('chainId helpers', () => {
  it('extracts the numeric tail from a compound id', () => {
    expect(numericChainId('base:84532')).toBe(84532);
    expect(numericChainId('84532')).toBe(84532);
    expect(numericChainId(100)).toBe(100);
    expect(numericChainId('gnosis:100')).toBe(100);
  });

  it('throws on an unparseable chainId', () => {
    expect(() => numericChainId('base')).toThrow();
  });

  it('chainIdHex is the 0x hex of the numeric id', () => {
    expect(chainIdHex('base:84532')).toBe('0x14a34');
    expect(chainIdHex(100)).toBe('0x64');
  });
});

describe('synthesizeChain', () => {
  it('builds a viem Chain with the numeric id, gas symbol, and rpc urls', () => {
    const chain = synthesizeChain('base:84532', ['https://rpc.example/1', 'https://rpc.example/2']);
    expect(chain.id).toBe(84532); // numeric tail, not the compound string
    expect(chain.nativeCurrency.symbol).toBe('ETH'); // from nativeGasSymbol(84532)
    expect(chain.nativeCurrency.decimals).toBe(18);
    expect(chain.rpcUrls.default.http).toEqual(['https://rpc.example/1', 'https://rpc.example/2']);
  });

  it('maps a Gnosis id to xDAI', () => {
    expect(synthesizeChain('gnosis:100', ['https://rpc']).nativeCurrency.symbol).toBe('xDAI');
  });
});

describe('publicClientFor', () => {
  it('returns a client pinned to the synthesized chain and caches per id + RPC URL set', () => {
    const a = publicClientFor('base:84532', ['https://rpc.example']);
    expect(a.chain?.id).toBe(84532);
    const b = publicClientFor('84532', ['https://rpc.example']); // same numeric id → cache hit
    expect(b).toBe(a);
    const c = publicClientFor('base:84532', ['https://rpc.other']); // same chain, different RPC → new client
    expect(c).not.toBe(a);
    const d = publicClientFor('100', ['https://rpc.gnosis']); // different id → new client
    expect(d).not.toBe(a);
  });
});
