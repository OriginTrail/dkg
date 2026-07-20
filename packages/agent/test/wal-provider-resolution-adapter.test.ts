import { peerIdFromString } from '@libp2p/peer-id';
import { describe, expect, it, vi } from 'vitest';
import { createDkgWalProviderResolutionAdapter } from '../src/wal/provider-resolution-adapter.js';

const TARGET = '12D3KooWQz2bQbQueABKRSjV9koF8VYsXk5TdCsUmPf5zAEZg3q6';
const OTHER = '12D3KooWSmU3owJvB9sFw8uApDgKrv2VBMecsGGvgAc4Gq6hB57M';
const TARGET_BYTES = peerIdFromString(TARGET).toMultihash().bytes;

function connection(address: string) {
  return { remoteAddr: { toString: () => address } } as never;
}

describe('DKG WAL provider resolution adapter', () => {
  it('validates signed and persisted hints, primes them independently, and adds normal resolver paths', async () => {
    const signed = `/ip4/127.0.0.1/tcp/4001/p2p/${TARGET}`;
    const persisted = '/ip4/127.0.0.1/tcp/4002';
    const live = '/ip4/127.0.0.1/tcp/4003';
    const direct = '/ip4/127.0.0.1/tcp/4004';
    const relay = `/ip4/127.0.0.1/tcp/4005/p2p/${OTHER}/p2p-circuit/p2p/${TARGET}`;
    const wrongTarget = `/ip4/127.0.0.1/tcp/4006/p2p/${OTHER}`;
    const merged: string[] = [];
    const signal = new AbortController().signal;
    const resolve = vi.fn(async () => [live, direct, relay]);
    const adapter = createDkgWalProviderResolutionAdapter({
      network: {
        getConnections: () => [connection(live)],
        addKnownAddresses: async (peerId, addresses) => {
          expect(peerId).toBe(TARGET);
          if (addresses[0].includes('4007')) throw new Error('peer store rejected address');
          merged.push(...addresses);
        },
      },
      peerResolver: { resolve },
      perStepTimeoutMs: 321,
    });

    const paths = await adapter.resolve(
      TARGET_BYTES,
      [signed, 'not-a-multiaddr', wrongTarget, '/ip4/127.0.0.1/tcp/4007'],
      [persisted, signed],
      { signal },
    );
    expect(merged).toEqual([signed, persisted, signed]);
    expect(paths).toEqual([
      { address: signed, kind: 'signed' },
      { address: persisted, kind: 'persisted' },
      { address: live, kind: 'live' },
      { address: direct, kind: 'direct' },
      { address: relay, kind: 'relay' },
    ]);
    expect(resolve).toHaveBeenCalledWith(TARGET, { signal, perStepTimeoutMs: 321 });
  });

  it('fails malformed peer identities before touching the network', async () => {
    const addKnownAddresses = vi.fn();
    const resolve = vi.fn();
    const adapter = createDkgWalProviderResolutionAdapter({
      network: { getConnections: () => [], addKnownAddresses },
      peerResolver: { resolve },
    });
    await expect(adapter.resolve(new Uint8Array(), [], [])).rejects.toThrow('canonical multihash bytes');
    await expect(adapter.resolve(Uint8Array.of(1, 2, 3), [], [])).rejects.toThrow();
    expect(addKnownAddresses).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
  });

  it('honors cancellation and falls through a broken live-connection cache', async () => {
    const resolve = vi.fn(async () => ['/ip4/127.0.0.1/tcp/4010']);
    const adapter = createDkgWalProviderResolutionAdapter({
      network: {
        getConnections: () => { throw new Error('cache'); },
        addKnownAddresses: async () => undefined,
      },
      peerResolver: { resolve },
    });
    const aborted = new AbortController();
    aborted.abort();
    await expect(adapter.resolve(TARGET_BYTES, [], [], { signal: aborted.signal })).resolves.toEqual([]);
    await expect(adapter.resolve(TARGET_BYTES, [], [])).resolves.toEqual([
      { address: '/ip4/127.0.0.1/tcp/4010', kind: 'direct' },
    ]);
  });

  it('rejects missing dependencies and invalid timeout configuration', () => {
    expect(() => createDkgWalProviderResolutionAdapter(null as never)).toThrow('existing DKG network');
    expect(() => createDkgWalProviderResolutionAdapter({ network: {} as never, peerResolver: null as never })).toThrow('existing DKG network');
    expect(() => createDkgWalProviderResolutionAdapter({
      network: {} as never, peerResolver: {} as never, perStepTimeoutMs: 0,
    })).toThrow('positive safe integer');
  });
});
