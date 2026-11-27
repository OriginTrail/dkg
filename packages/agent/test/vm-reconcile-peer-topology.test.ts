import { describe, expect, it } from 'vitest';
import {
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

  it('rejects malformed historical topology and clean-miss records', () => {
    const readable = topology([{ peerId: 'a' }]);
    expect(isVmReconcilePeerTopology({ kind: 'readable', peers: [] })).toBe(false);
    expect(parseVmReconcileCleanMissPeerIds(['unknown'], readable)).toBeNull();
    expect(parseVmReconcileCleanMissPeerIds(['a', 'a'], readable)).toBeNull();
    expect(parseVmReconcileCleanMissPeerIds(['a'], readable)).toEqual(['a']);
  });
});
