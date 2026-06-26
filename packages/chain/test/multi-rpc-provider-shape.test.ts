// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest';
import { FallbackProvider, JsonRpcProvider } from 'ethers';
import { EVMChainAdapter } from '../src/evm-adapter.js';

const PK = '0x' + '1'.repeat(64);
const HUB = '0x0000000000000000000000000000000000000001';

// Constructing the adapter is offline (providers are lazy / never dialled), so
// these assertions need no live RPC — they exercise the constructor's provider
// topology: 1 endpoint => bare JsonRpcProvider (identical to the pre-multi-RPC
// path); >1 endpoint => N bare JsonRpcProviders in `this.providers[]` with the
// bare PRIMARY exposed as the read provider. R1 removed the ethers
// FallbackProvider — reads fail over EXPLICITLY via `readWithFailover` over
// `this.providers[]` (the immediate-failover behaviour itself is covered by
// multi-rpc-read-failover.test.ts, so that coverage is NOT dropped here, only
// the now-removed FallbackProvider topology assertion is updated).
describe('multi-RPC provider shape (backwards compatibility)', () => {
  it('a single rpcUrl yields a bare JsonRpcProvider (no FallbackProvider)', () => {
    const a = new EVMChainAdapter({
      rpcUrl: 'http://127.0.0.1:1',
      hubAddress: HUB,
      privateKey: PK,
      allowNoAdminSigner: true,
    });
    const read = a.getProvider();
    expect(read).toBeInstanceOf(JsonRpcProvider);
    expect(read).not.toBeInstanceOf(FallbackProvider);
    expect(a.getRpcUrls()).toEqual(['http://127.0.0.1:1']);
  });

  it('multiple rpcUrls build a bare-primary read provider + N providers for readWithFailover (no FallbackProvider)', () => {
    const a = new EVMChainAdapter({
      rpcUrl: 'http://127.0.0.1:1',
      rpcUrls: ['http://127.0.0.1:2', 'http://127.0.0.1:3'],
      hubAddress: HUB,
      privateKey: PK,
      allowNoAdminSigner: true,
    });
    // R1: getProvider() is the bare PRIMARY JsonRpcProvider — the
    // FallbackProvider is gone; reads fail over explicitly via readWithFailover
    // over this.providers[] (getReadProvider() was removed as obsolete: there is
    // no single read provider anymore).
    const read = a.getProvider();
    expect(read).toBeInstanceOf(JsonRpcProvider);
    expect(read).not.toBeInstanceOf(FallbackProvider);
    // All endpoints stay configured, primary first — the failover topology now
    // lives in this.providers[] (one bare JsonRpcProvider per endpoint), which
    // readWithFailover iterates.
    expect(a.getRpcUrls()).toEqual(['http://127.0.0.1:1', 'http://127.0.0.1:2', 'http://127.0.0.1:3']);
    const providers = (a as unknown as { providers: unknown[] }).providers;
    expect(providers).toHaveLength(3);
    expect(providers.every((p) => p instanceof JsonRpcProvider)).toBe(true);
    expect(providers.some((p) => p instanceof FallbackProvider)).toBe(false);
  });

  it('dedupes a backup that repeats the primary (no redundant provider)', () => {
    const a = new EVMChainAdapter({
      rpcUrl: 'http://127.0.0.1:1',
      rpcUrls: ['http://127.0.0.1:1'],
      hubAddress: HUB,
      privateKey: PK,
      allowNoAdminSigner: true,
    });
    // Collapses to a single unique endpoint -> no FallbackProvider.
    expect(a.getProvider()).not.toBeInstanceOf(FallbackProvider);
    expect(a.getRpcUrls()).toEqual(['http://127.0.0.1:1']);
  });
});
