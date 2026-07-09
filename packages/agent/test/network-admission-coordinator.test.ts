import { describe, expect, it, vi } from 'vitest';
import { createOperationContext } from '@origintrail-official/dkg-core';
import { NetworkAdmissionCoordinator } from '../src/p2p/network-admission-coordinator.js';
import { NetworkAdmissionService } from '../src/p2p/network-admission.js';

const REMOTE_PEER_ID = '12D3KooWPvHB21rJUKQuPb7sZDCyveJmtsL3PryNN3y99n6hqRNh';
const SELF_PEER_ID = '12D3KooWDCuLesNUYHGEUY5ksEsfJGbShbZ9ep2Pu7uqCNGvgwnb';
const identity = {
  networkId: 'network-a',
  genesisId: 'base-testnet',
};

function buildCoordinator(input: {
  sendIdentityProbe: () => Promise<Uint8Array>;
}) {
  const admission = new NetworkAdmissionService({
    networkId: identity.networkId,
    selfPeerId: SELF_PEER_ID,
  });
  const close = vi.fn();
  const abort = vi.fn();
  const deletePeerFromPeerStore = vi.fn();
  const cleanupRejectedPeerState = vi.fn();
  const coordinator = new NetworkAdmissionCoordinator({
    admission,
    identity,
    selfPeerId: SELF_PEER_ID,
    sign: async () => new Uint8Array(),
    sendIdentityProbe: input.sendIdentityProbe,
    getConnections: () => [{
      remotePeer: { toString: () => REMOTE_PEER_ID },
      close,
      abort,
    }],
    deletePeerFromPeerStore,
    cleanupRejectedPeerState,
  });

  return {
    admission,
    coordinator,
    close,
    abort,
    deletePeerFromPeerStore,
    cleanupRejectedPeerState,
  };
}

describe('NetworkAdmissionCoordinator', () => {
  it('keeps transport probe failures retryable instead of quarantining the peer', async () => {
    const fixture = buildCoordinator({
      sendIdentityProbe: async () => {
        throw new Error('stream timeout');
      },
    });

    await expect(
      fixture.coordinator.ensureAdmitted(REMOTE_PEER_ID, createOperationContext('connect')),
    ).rejects.toMatchObject({ code: 'NETWORK_ADMISSION_PROBE_FAILED' });

    expect(fixture.admission.snapshot().quarantinedPeerIds).toEqual([]);
    expect(fixture.admission.snapshot().verifiedPeerIds).toEqual([]);
    expect(fixture.cleanupRejectedPeerState).not.toHaveBeenCalled();
    expect(fixture.close).not.toHaveBeenCalled();
    expect(fixture.abort).not.toHaveBeenCalled();
    expect(fixture.deletePeerFromPeerStore).not.toHaveBeenCalled();
  });

  it('keeps unreadable probe responses retryable instead of quarantining the peer', async () => {
    const fixture = buildCoordinator({
      sendIdentityProbe: async () => new TextEncoder().encode('{not json'),
    });

    await expect(
      fixture.coordinator.ensureAdmitted(REMOTE_PEER_ID, createOperationContext('connect')),
    ).rejects.toMatchObject({ code: 'NETWORK_ADMISSION_PROBE_FAILED' });

    expect(fixture.admission.snapshot().quarantinedPeerIds).toEqual([]);
    expect(fixture.cleanupRejectedPeerState).not.toHaveBeenCalled();
    expect(fixture.deletePeerFromPeerStore).not.toHaveBeenCalled();
  });

  it('quarantines peers with a parsed but mismatched network identity proof', async () => {
    const fixture = buildCoordinator({
      sendIdentityProbe: async () => new TextEncoder().encode(JSON.stringify({
        version: 1,
        peerId: REMOTE_PEER_ID,
        networkId: 'network-b',
        genesisId: identity.genesisId,
        proofKind: 'ed25519-peer-id',
        signature: 'invalid-signature',
      })),
    });

    await expect(
      fixture.coordinator.ensureAdmitted(REMOTE_PEER_ID, createOperationContext('connect')),
    ).resolves.toBe(false);

    expect(fixture.admission.snapshot().quarantinedPeerIds).toEqual([REMOTE_PEER_ID]);
    expect(fixture.cleanupRejectedPeerState).toHaveBeenCalledWith(REMOTE_PEER_ID);
    expect(fixture.close).toHaveBeenCalledTimes(1);
    expect(fixture.deletePeerFromPeerStore).toHaveBeenCalledWith(REMOTE_PEER_ID);
  });
});
