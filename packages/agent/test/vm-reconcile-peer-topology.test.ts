import { describe, expect, it } from 'vitest';
import {
  canReuseVmReconcilePeerTopology,
  createVmReconcilePeerTopology,
  isVmReconcilePeerTopology,
  UNREADABLE_VM_RECONCILE_PEER_TOPOLOGY,
} from '../src/vm-reconcile-peer-topology.js';
import type { VmReconcilePeerTopology } from '../src/dkg-agent-types.js';

function topology(
  peers: Array<{ peerId: string; core?: boolean }>,
  preferredPeerId: string | null = null,
  cleanMissPeerIds: string[] = [],
): VmReconcilePeerTopology {
  return createVmReconcilePeerTopology({
    preferredPeerId,
    privateOnly: false,
    peers: peers.map((peer) => ({
      peerId: peer.peerId,
      core: peer.core ?? false,
    })),
    cleanMissPeerIds,
  });
}

describe('VM reconcile peer-topology compatibility', () => {
  it('constructs a canonical topology without redundant rank or preferred fields', () => {
    const value = createVmReconcilePeerTopology({
      preferredPeerId: 'preferred',
      privateOnly: false,
      peers: [
        { peerId: 'preferred', core: false },
        { peerId: 'preferred', core: true },
        { peerId: 'core', core: true },
      ],
      cleanMissPeerIds: ['core', 'missing', 'core'],
    });
    expect(value).toEqual({
      kind: 'readable',
      preferredPeerId: 'preferred',
      privateOnly: false,
      peers: [
        { peerId: 'preferred', core: false },
        { peerId: 'core', core: true },
      ],
      cleanMissPeerIds: ['core'],
    });
    expect(isVmReconcilePeerTopology(value)).toBe(true);
  });

  it('reuses exact topology and removal of peers with clean-miss evidence', () => {
    const cached = topology(
      [{ peerId: 'a' }, { peerId: 'b', core: true }, { peerId: 'c' }],
      null,
      ['a', 'b', 'c'],
    );
    expect(canReuseVmReconcilePeerTopology(cached, cached)).toBe(true);
    expect(canReuseVmReconcilePeerTopology(
      cached,
      topology([{ peerId: 'a' }, { peerId: 'c' }]),
    )).toBe(true);
  });

  it('rejects removal that exposes a previously unproven peer', () => {
    const cached = topology(
      [{ peerId: 'skipped' }, { peerId: 'clean' }],
      null,
      ['clean'],
    );
    expect(canReuseVmReconcilePeerTopology(
      cached,
      topology([{ peerId: 'skipped' }]),
    )).toBe(false);
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

  it('preserves explicit unreadable equality and rejects malformed domain records', () => {
    const readable = topology([{ peerId: 'a' }]);
    expect(canReuseVmReconcilePeerTopology(
      UNREADABLE_VM_RECONCILE_PEER_TOPOLOGY,
      UNREADABLE_VM_RECONCILE_PEER_TOPOLOGY,
    )).toBe(true);
    expect(canReuseVmReconcilePeerTopology(
      UNREADABLE_VM_RECONCILE_PEER_TOPOLOGY,
      readable,
    )).toBe(false);
    expect(isVmReconcilePeerTopology({
      ...readable,
      cleanMissPeerIds: ['unknown'],
    })).toBe(false);
  });
});
