import { describe, expect, it } from 'vitest';
import {
  createVmReconcilePeerTopology,
  type VmReconcileNegativeRecord,
} from '@origintrail-official/dkg-agent';
import {
  decodeVmReconcileNegativeRow,
  encodeVmReconcileNegativeRow,
} from '../src/daemon/vm-reconcile-negative-store-adapter.js';

function record(): VmReconcileNegativeRecord {
  return {
    cacheKey: 'cg\0ual#root',
    localCgId: 'cg',
    failures: 2,
    nextRetryAt: 1234,
    swmGen: 'changelog:1:2',
    candidateNamespaces: [{ metaGraph: 'urn:meta', dataGraph: 'urn:data' }],
    peerTopology: createVmReconcilePeerTopology({
      preferredPeerId: 'peer-a',
      privateOnly: false,
      peers: [
        { peerId: 'peer-a', core: true },
        { peerId: 'peer-b', core: false },
      ],
    }),
    cleanMissPeerIds: ['peer-b'],
  };
}

describe('VM reconcile negative SQLite adapter', () => {
  it('round-trips the typed domain record through the existing text columns', () => {
    const value = record();
    const row = encodeVmReconcileNegativeRow(value, 999);

    expect(row.updated_at).toBe(999);
    expect(JSON.parse(row.peer_topology_key)).toEqual({
      version: 2,
      preferredPeerId: 'peer-a',
      privateOnly: false,
      peers: [
        { peerId: 'peer-a', core: true },
        { peerId: 'peer-b', core: false },
      ],
      cleanMissPeerIds: ['peer-b'],
    });
    expect(decodeVmReconcileNegativeRow(row)).toEqual(value);
  });

  it('round-trips the unreadable topology sentinel without JSON encoding', () => {
    const value = record();
    value.peerTopology = { kind: 'unreadable' };
    value.cleanMissPeerIds = [];
    const row = encodeVmReconcileNegativeRow(value, 999);

    expect(row.peer_topology_key).toBe('unreadable');
    expect(decodeVmReconcileNegativeRow(row)).toEqual(value);
  });

  it('migrates the exact unversioned legacy encoding without granting miss evidence', () => {
    const row = encodeVmReconcileNegativeRow(record(), 999);
    row.peer_topology_key = JSON.stringify({
      preferredPeerId: 'peer-a',
      privateOnly: false,
      peers: [
        { rank: 0, peerId: 'peer-a', preferred: true, core: true },
        { rank: 1, peerId: 'peer-b', preferred: false, core: false },
      ],
    });

    expect(decodeVmReconcileNegativeRow(row)).toMatchObject({
      peerTopology: {
        kind: 'readable',
        preferredPeerId: 'peer-a',
        privateOnly: false,
        peers: [
          { peerId: 'peer-a', core: true },
          { peerId: 'peer-b', core: false },
        ],
      },
      cleanMissPeerIds: [],
    });
  });

  it('rejects the unshipped intermediate version-1 topology encoding', () => {
    const row = encodeVmReconcileNegativeRow(record(), 999);
    row.peer_topology_key = JSON.stringify({
      version: 1,
      preferredPeerId: 'peer-a',
      privateOnly: false,
      peers: [
        { rank: 0, peerId: 'peer-a', preferred: true, core: true },
        { rank: 1, peerId: 'peer-b', preferred: false, core: false },
      ],
    });

    expect(decodeVmReconcileNegativeRow(row)).toBeNull();
  });

  it('fails open on malformed topology state', () => {
    const row = encodeVmReconcileNegativeRow(record(), 999);
    row.peer_topology_key = JSON.stringify({
      version: 2,
      preferredPeerId: null,
      privateOnly: false,
      peers: [{ peerId: 'peer-a', core: false }],
      cleanMissPeerIds: ['unknown-peer'],
    });

    expect(decodeVmReconcileNegativeRow(row)).toBeNull();
  });
});
