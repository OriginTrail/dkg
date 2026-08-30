import { describe, expect, it } from 'vitest';
import {
  canReuseVmReconcilePeerTopology,
  createVmReconcileCleanMissPeerIds,
  createVmReconcilePeerTopology,
  encodeLegacyVmReconcilePeerTopologyKey,
  isVmReconcilePeerTopology,
  parseLegacyVmReconcilePeerTopologyKey,
  parseVmReconcileCleanMissPeerIds,
  UNREADABLE_VM_RECONCILE_PEER_TOPOLOGY,
} from '../src/vm-reconcile-peer-topology.js';
import type { VmReconcilePeerTopology } from '../src/dkg-agent-types.js';

function topology(
  peers: Array<{ peerId: string; core?: boolean }>,
  preferredPeerId: string | null = null,
): VmReconcilePeerTopology {
  return createVmReconcilePeerTopology({
    preferredPeerId,
    privateOnly: false,
    peers: peers.map((peer) => ({
      peerId: peer.peerId,
      core: peer.core ?? false,
    })),
  });
}

function evidence(
  value: VmReconcilePeerTopology,
  cleanMissPeerIds: string[],
) {
  return {
    topology: value,
    cleanMissPeerIds: createVmReconcileCleanMissPeerIds(value, cleanMissPeerIds),
  };
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
    });
    expect(value).toEqual({
      kind: 'readable',
      preferredPeerId: 'preferred',
      privateOnly: false,
      peers: [
        { peerId: 'preferred', core: false },
        { peerId: 'core', core: true },
      ],
    });
    expect(isVmReconcilePeerTopology(value)).toBe(true);
    expect(createVmReconcileCleanMissPeerIds(value, ['core', 'missing', 'core']))
      .toEqual(['core']);
  });

  it('round-trips the exact legacy topology-key representation', () => {
    const value = topology(
      [{ peerId: 'preferred', core: true }, { peerId: 'other' }],
      'preferred',
    );
    const encoded = encodeLegacyVmReconcilePeerTopologyKey(value);

    expect(JSON.parse(encoded)).toEqual({
      preferredPeerId: 'preferred',
      privateOnly: false,
      peers: [
        { rank: 0, peerId: 'preferred', preferred: true, core: true },
        { rank: 1, peerId: 'other', preferred: false, core: false },
      ],
    });
    expect(parseLegacyVmReconcilePeerTopologyKey(encoded)).toEqual(value);
    expect(parseLegacyVmReconcilePeerTopologyKey('unreadable'))
      .toEqual(UNREADABLE_VM_RECONCILE_PEER_TOPOLOGY);
  });

  it('reuses exact topology and removal of peers with clean-miss evidence', () => {
    const cachedTopology = topology(
      [{ peerId: 'a' }, { peerId: 'b', core: true }, { peerId: 'c' }],
    );
    const cached = evidence(cachedTopology, ['a', 'b', 'c']);
    expect(canReuseVmReconcilePeerTopology(cached, cachedTopology)).toBe(true);
    expect(canReuseVmReconcilePeerTopology(
      cached,
      topology([{ peerId: 'a' }, { peerId: 'c' }]),
    )).toBe(true);
  });

  it('rejects removal that exposes a previously unproven peer', () => {
    const cached = evidence(topology(
      [{ peerId: 'skipped' }, { peerId: 'clean' }],
    ), ['clean']);
    expect(canReuseVmReconcilePeerTopology(
      cached,
      topology([{ peerId: 'skipped' }]),
    )).toBe(false);
  });

  it('rejects peer additions, capability reclassification, and ordering changes', () => {
    const cached = evidence(topology([{ peerId: 'a' }, { peerId: 'b' }]), []);
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

  it.each([
    ['preferred peer', 'b', false],
    ['privacy mode', 'a', true],
  ] as const)('rejects reuse when the %s changes', (_field, preferredPeerId, privateOnly) => {
    const cachedTopology = createVmReconcilePeerTopology({
      preferredPeerId: 'a',
      privateOnly: false,
      peers: [{ peerId: 'a', core: false }],
    });
    const currentTopology = createVmReconcilePeerTopology({
      preferredPeerId,
      privateOnly,
      peers: [{ peerId: 'a', core: false }],
    });

    expect(canReuseVmReconcilePeerTopology(
      evidence(cachedTopology, ['a']),
      currentTopology,
    )).toBe(false);
  });

  it('preserves explicit unreadable equality and rejects malformed domain records', () => {
    const readable = topology([{ peerId: 'a' }]);
    expect(canReuseVmReconcilePeerTopology(
      evidence(UNREADABLE_VM_RECONCILE_PEER_TOPOLOGY, []),
      UNREADABLE_VM_RECONCILE_PEER_TOPOLOGY,
    )).toBe(true);
    expect(canReuseVmReconcilePeerTopology(
      evidence(UNREADABLE_VM_RECONCILE_PEER_TOPOLOGY, []),
      readable,
    )).toBe(false);
    expect(parseVmReconcileCleanMissPeerIds(['unknown'], readable)).toBeNull();
  });
});
