import { describe, expect, it } from 'vitest';
import {
  canReuseVmReconcilePeerTopology,
  decodeVmReconcilePeerTopology,
  encodeVmReconcilePeerTopology,
  type VmReconcilePeerTopology,
} from '../src/vm-reconcile-peer-topology.js';

function topology(
  peers: Array<{ peerId: string; preferred?: boolean; core?: boolean }>,
  preferredPeerId: string | null = null,
): VmReconcilePeerTopology {
  return {
    kind: 'readable',
    preferredPeerId,
    privateOnly: false,
    peers: peers.map((peer) => ({
      peerId: peer.peerId,
      preferred: peer.preferred ?? false,
      core: peer.core ?? false,
    })),
  };
}

describe('VM reconcile peer-topology compatibility', () => {
  it('round-trips a validated readable topology at the durable boundary', () => {
    const value = topology([
      { peerId: 'preferred', preferred: true },
      { peerId: 'core', core: true },
    ], 'preferred');
    expect(decodeVmReconcilePeerTopology(encodeVmReconcilePeerTopology(value))).toEqual(value);
  });

  it('reuses exact topology and capability-preserving peer removal', () => {
    const cached = topology([
      { peerId: 'a' },
      { peerId: 'b', core: true },
      { peerId: 'c' },
    ]);
    expect(canReuseVmReconcilePeerTopology(cached, cached)).toBe(true);
    expect(canReuseVmReconcilePeerTopology(cached, topology([
      { peerId: 'a' },
      { peerId: 'c' },
    ]))).toBe(true);
  });

  it('rejects peer additions, capability reclassification, and ordering changes', () => {
    const cached = topology([{ peerId: 'a' }, { peerId: 'b' }]);
    expect(canReuseVmReconcilePeerTopology(
      cached,
      topology([{ peerId: 'a' }, { peerId: 'b' }, { peerId: 'c' }]),
    )).toBe(false);
    expect(canReuseVmReconcilePeerTopology(
      cached,
      topology([{ peerId: 'a', core: true }, { peerId: 'b' }]),
    )).toBe(false);
    expect(canReuseVmReconcilePeerTopology(
      cached,
      topology([{ peerId: 'b' }, { peerId: 'a' }]),
    )).toBe(false);
  });

  it('preserves explicit unreadable equality but rejects malformed durable state', () => {
    const readable = topology([{ peerId: 'a' }]);
    const unreadable = decodeVmReconcilePeerTopology('unreadable');
    expect(unreadable).toEqual({ kind: 'unreadable' });
    expect(canReuseVmReconcilePeerTopology(unreadable!, unreadable!)).toBe(true);
    expect(canReuseVmReconcilePeerTopology(unreadable!, readable)).toBe(false);
    expect(canReuseVmReconcilePeerTopology(readable, unreadable!)).toBe(false);

    const invalidPayloads = [
      '{',
      JSON.stringify({ version: 2, preferredPeerId: null, privateOnly: false, peers: [] }),
      JSON.stringify({ version: 1, preferredPeerId: null, privateOnly: false, peers: [{
        rank: 1,
        peerId: 'a',
        preferred: false,
        core: false,
      }] }),
      JSON.stringify({ version: 1, preferredPeerId: null, privateOnly: false, peers: [{
        rank: 0,
        peerId: 'a',
        preferred: true,
        core: false,
      }] }),
    ];
    for (const payload of invalidPayloads) {
      const decoded = decodeVmReconcilePeerTopology(payload);
      expect(decoded).toBeNull();
    }
  });
});
