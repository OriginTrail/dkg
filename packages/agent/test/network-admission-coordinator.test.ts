import { describe, expect, it, vi } from 'vitest';
import { peerIdFromString } from '@libp2p/peer-id';
import { createOperationContext } from '@origintrail-official/dkg-core';
import { NetworkAdmissionCoordinator } from '../src/p2p/network-admission-coordinator.js';
import { NetworkAdmissionService } from '../src/p2p/network-admission.js';

const REMOTE_PEER_ID = '12D3KooWPvHB21rJUKQuPb7sZDCyveJmtsL3PryNN3y99n6hqRNh';
const REMOTE_PEER_ID_CID = peerIdFromString(REMOTE_PEER_ID).toCID().toString();
const SELF_PEER_ID = '12D3KooWDCuLesNUYHGEUY5ksEsfJGbShbZ9ep2Pu7uqCNGvgwnb';
const identity = {
  networkId: 'network-a',
  genesisId: 'base-testnet',
};

function buildCoordinator(input: {
  sendIdentityProbe: (...args: any[]) => Promise<Uint8Array>;
  identity?: typeof identity;
  probeTimeoutMs?: number;
}) {
  const admission = new NetworkAdmissionService({
    networkId: input.identity?.networkId ?? identity.networkId,
    selfPeerId: SELF_PEER_ID,
  });
  const close = vi.fn();
  const abort = vi.fn();
  const deletePeerFromPeerStore = vi.fn();
  const cleanupRejectedPeerState = vi.fn();
  const coordinator = new NetworkAdmissionCoordinator({
    admission,
    identity: input.identity,
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
    ...(input.probeTimeoutMs !== undefined ? { probeTimeoutMs: input.probeTimeoutMs } : {}),
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
  it('accepts every peer synchronously when network identity is disabled', () => {
    const fixture = buildCoordinator({
      identity: undefined,
      sendIdentityProbe: async () => {
        throw new Error('probe should not run');
      },
    });

    expect(fixture.coordinator.enabled).toBe(false);
    expect(fixture.coordinator.isAcceptedPeer(REMOTE_PEER_ID)).toBe(true);
    expect(fixture.coordinator.filterAcceptedPeerIds([REMOTE_PEER_ID])).toEqual([REMOTE_PEER_ID]);
  });

  it('keeps transport probe failures retryable instead of quarantining the peer', async () => {
    const fixture = buildCoordinator({
      identity,
      sendIdentityProbe: async () => {
        throw new Error('stream timeout');
      },
    });

    await expect(
      fixture.coordinator.ensureAdmitted(REMOTE_PEER_ID, createOperationContext('connect')),
    ).rejects.toMatchObject({ code: 'NETWORK_ADMISSION_PROBE_FAILED' });

    expect(fixture.coordinator.isAcceptedPeer(REMOTE_PEER_ID)).toBe(false);
    expect(fixture.coordinator.isRejectedPeer(REMOTE_PEER_ID)).toBe(false);
    expect(fixture.admission.snapshot().quarantinedPeerIds).toEqual([]);
    expect(fixture.admission.snapshot().verifiedPeerIds).toEqual([]);
    expect(fixture.cleanupRejectedPeerState).not.toHaveBeenCalled();
    expect(fixture.close).not.toHaveBeenCalled();
    expect(fixture.abort).not.toHaveBeenCalled();
    expect(fixture.deletePeerFromPeerStore).not.toHaveBeenCalled();
  });

  it('keeps unreadable probe responses retryable instead of quarantining the peer', async () => {
    const fixture = buildCoordinator({
      identity,
      sendIdentityProbe: async () => new TextEncoder().encode('{not json'),
    });

    await expect(
      fixture.coordinator.ensureAdmitted(REMOTE_PEER_ID, createOperationContext('connect')),
    ).rejects.toMatchObject({ code: 'NETWORK_ADMISSION_PROBE_FAILED' });

    expect(fixture.admission.snapshot().quarantinedPeerIds).toEqual([]);
    expect(fixture.cleanupRejectedPeerState).not.toHaveBeenCalled();
    expect(fixture.deletePeerFromPeerStore).not.toHaveBeenCalled();
  });

  it('passes caller cancellation and remaining timeout into identity probes', async () => {
    const callerSignal = AbortSignal.timeout(5_000);
    let seenOptions: { timeoutMs: number; signal?: AbortSignal } | undefined;
    const fixture = buildCoordinator({
      identity,
      probeTimeoutMs: 3_000,
      sendIdentityProbe: async (_peerId, _data, options) => {
        seenOptions = options;
        return new TextEncoder().encode('{not json');
      },
    });

    await expect(
      fixture.coordinator.ensureAdmitted(
        REMOTE_PEER_ID,
        createOperationContext('connect'),
        { signal: callerSignal, timeoutMs: 100 },
      ),
    ).rejects.toMatchObject({ code: 'NETWORK_ADMISSION_PROBE_FAILED' });

    expect(seenOptions).toMatchObject({ timeoutMs: 100 });
    expect(seenOptions?.signal).toBe(callerSignal);
  });

  it('canonicalizes peer ids before probing and sharing in-flight admission attempts', async () => {
    let release!: (value: Uint8Array) => void;
    const sendIdentityProbe = vi.fn(async () => new Promise<Uint8Array>((resolve) => {
      release = resolve;
    }));
    const fixture = buildCoordinator({
      identity,
      sendIdentityProbe,
    });

    const first = fixture.coordinator.ensureAdmitted(REMOTE_PEER_ID_CID, createOperationContext('connect'));
    const second = fixture.coordinator.ensureAdmitted(REMOTE_PEER_ID, createOperationContext('connect'));
    await Promise.resolve();

    expect(sendIdentityProbe).toHaveBeenCalledOnce();
    expect(sendIdentityProbe.mock.calls[0][0]).toBe(REMOTE_PEER_ID);
    release(new TextEncoder().encode('{not json'));
    await expect(first).rejects.toMatchObject({ code: 'NETWORK_ADMISSION_PROBE_FAILED' });
    await expect(second).rejects.toMatchObject({ code: 'NETWORK_ADMISSION_PROBE_FAILED' });
  });

  it('rejects malformed peer ids before probing', async () => {
    const sendIdentityProbe = vi.fn(async () => new TextEncoder().encode('{not json'));
    const fixture = buildCoordinator({
      identity,
      sendIdentityProbe,
    });

    await expect(
      fixture.coordinator.ensureAdmitted('not-a-peer-id', createOperationContext('connect')),
    ).rejects.toMatchObject({ code: 'INVALID_PEER_ID' });
    expect(sendIdentityProbe).not.toHaveBeenCalled();
  });

  it('quarantines peers with a parsed but mismatched network identity proof', async () => {
    const fixture = buildCoordinator({
      identity,
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
    expect(fixture.coordinator.isRejectedPeer(REMOTE_PEER_ID)).toBe(true);
    expect(fixture.cleanupRejectedPeerState).toHaveBeenCalledWith(REMOTE_PEER_ID);
    expect(fixture.close).toHaveBeenCalledTimes(1);
    expect(fixture.deletePeerFromPeerStore).toHaveBeenCalledWith(REMOTE_PEER_ID);
  });
});
