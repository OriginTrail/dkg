import { describe, expect, it, vi } from 'vitest';
import { combineConnectionGaters } from '../src/connection-gater-combiner.js';

const peer = { toString: () => 'peer' } as any;
const addr = { toString: () => '/ip4/1.2.3.4/tcp/9090' } as any;

describe('combineConnectionGaters', () => {
  it('denies when any fragment denies, consulting them in order until the first denial', () => {
    const first = vi.fn(() => false);
    const second = vi.fn(() => true);
    const third = vi.fn(() => true);
    const gater = combineConnectionGaters([
      { denyDialMultiaddr: first },
      { denyDialMultiaddr: second },
      { denyDialMultiaddr: third },
    ]);

    expect(gater.denyDialMultiaddr!(addr)).toBe(true);
    expect(first).toHaveBeenCalledWith(addr);
    expect(second).toHaveBeenCalledWith(addr);
    // A later policy neither runs nor logs for an already-refused connection.
    expect(third).not.toHaveBeenCalled();

    second.mockReturnValue(false);
    third.mockReturnValue(false);
    expect(gater.denyDialMultiaddr!(addr)).toBe(false);
  });

  it('keeps an address only when every fragment keeps it', () => {
    const gater = combineConnectionGaters([
      { filterMultiaddrForPeer: () => true },
      { filterMultiaddrForPeer: (_peer, multiaddr) => !multiaddr.toString().includes('p2p-circuit') },
    ]);

    // libp2p hands this hook to the peer store as a bare function.
    const { filterMultiaddrForPeer } = gater;
    expect(filterMultiaddrForPeer!(peer, addr)).toBe(true);
    expect(filterMultiaddrForPeer!(peer, { toString: () => '/ip4/1.2.3.4/tcp/9090/p2p-circuit' } as any)).toBe(false);
  });

  it('leaves hooks no fragment provides undefined, skipping absent fragments', () => {
    const gater = combineConnectionGaters([
      undefined,
      { denyInboundRelayedConnection: () => false, denyDialPeer: undefined },
      undefined,
    ]);

    expect(Object.keys(gater)).toEqual(['denyInboundRelayedConnection']);
    expect(gater.denyDialPeer).toBeUndefined();
    expect(gater.filterMultiaddrForPeer).toBeUndefined();
    expect(combineConnectionGaters([])).toEqual({});
  });

  it('calls method-style hooks with their own fragment as `this`', () => {
    const fragment = {
      denied: new Set(['peer']),
      denyDialPeer(this: { denied: Set<string> }, peerId: { toString(): string }) {
        return this.denied.has(peerId.toString());
      },
    };
    const { denyDialPeer } = combineConnectionGaters([fragment]);

    expect(denyDialPeer!(peer)).toBe(true);
  });
});
