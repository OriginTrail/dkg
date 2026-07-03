// @vitest-environment happy-dom

import { describe, expect, it, afterEach, vi } from 'vitest';

import { numericChainId, chainIdHex } from '../src/ui/web3/chainId.js';
import { synthesizeChain, publicClientFor, _resetClientCacheForTesting } from '../src/ui/web3/clients.js';

afterEach(() => {
  vi.unstubAllGlobals();
  _resetClientCacheForTesting();
});

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
  function headerValue(headers: HeadersInit | undefined, name: string): string | undefined {
    if (!headers) return undefined;
    if (headers instanceof Headers) return headers.get(name) ?? undefined;
    if (Array.isArray(headers)) {
      const found = headers.find(([key]) => key.toLowerCase() === name.toLowerCase());
      return found?.[1];
    }
    return (headers as Record<string, string>)[name];
  }

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

  it('can read through a same-origin relative PCA RPC URL in the browser', async () => {
    const seenUrls: string[] = [];
    const seenInits: Array<RequestInit | undefined> = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      seenUrls.push(typeof input === 'string' ? input : input.toString());
      seenInits.push(init);
      const body = JSON.parse(String(init?.body ?? '{}')) as { id?: unknown } | Array<{ id?: unknown }>;
      const responseBody = Array.isArray(body)
        ? body.map((call) => ({ jsonrpc: '2.0', id: call.id, result: '0x14a34' }))
        : { jsonrpc: '2.0', id: body.id, result: '0x14a34' };
      return new Response(JSON.stringify(responseBody), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    const client = publicClientFor('base:84532', ['/api/pca/rpc']);
    await expect(client.request({ method: 'eth_chainId' })).resolves.toBe('0x14a34');
    expect(seenUrls).toEqual(['/api/pca/rpc']);
    expect(seenInits[0]?.credentials).toBe('same-origin');
    expect(headerValue(seenInits[0]?.headers, 'Authorization')).toBeUndefined();
  });

  it('does not send dashboard credentials to external RPC URLs', async () => {
    const seenHeaders: Array<HeadersInit | undefined> = [];
    vi.stubGlobal('fetch', async (_input: RequestInfo | URL, init?: RequestInit) => {
      seenHeaders.push(init?.headers);
      const body = JSON.parse(String(init?.body ?? '{}')) as { id?: unknown } | Array<{ id?: unknown }>;
      const responseBody = Array.isArray(body)
        ? body.map((call) => ({ jsonrpc: '2.0', id: call.id, result: '0x14a34' }))
        : { jsonrpc: '2.0', id: body.id, result: '0x14a34' };
      return new Response(JSON.stringify(responseBody), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    const client = publicClientFor('base:84532', ['https://rpc.example']);
    await expect(client.request({ method: 'eth_chainId' })).resolves.toBe('0x14a34');
    expect(headerValue(seenHeaders[0], 'Authorization')).toBeUndefined();
  });
});
