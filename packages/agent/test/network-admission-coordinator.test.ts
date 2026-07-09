import { describe, expect, it, vi } from 'vitest';
import { peerIdFromString } from '@libp2p/peer-id';
import { createOperationContext } from '@origintrail-official/dkg-core';
import {
  NetworkAdmissionCoordinator,
  NetworkAdmissionRejectedError,
} from '../src/p2p/network-admission-coordinator.js';
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
  probeBackoff?: ConstructorParameters<typeof NetworkAdmissionCoordinator>[0]['probeBackoff'];
  now?: () => number;
}) {
  const admission = new NetworkAdmissionService({
    networkId: input.identity?.networkId,
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
    ...(input.probeBackoff !== undefined ? { probeBackoff: input.probeBackoff } : {}),
    ...(input.now !== undefined ? { now: input.now } : {}),
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

  it('keeps active retryable probe backoff on the retryable error path', async () => {
    let now = 1_000;
    const sendIdentityProbe = vi.fn(async () => {
      throw new Error('stream timeout');
    });
    const fixture = buildCoordinator({
      identity,
      sendIdentityProbe,
      now: () => now,
      probeBackoff: {
        transientBaseMs: 100,
        transientMaxMs: 100,
      },
    });

    await expect(
      fixture.coordinator.ensureAdmitted(REMOTE_PEER_ID, createOperationContext('connect')),
    ).rejects.toMatchObject({ code: 'NETWORK_ADMISSION_PROBE_FAILED' });

    await expect(
      fixture.coordinator.ensureAdmitted(REMOTE_PEER_ID, createOperationContext('connect')),
    ).rejects.toMatchObject({ code: 'NETWORK_ADMISSION_PROBE_FAILED' });
    expect(sendIdentityProbe).toHaveBeenCalledTimes(1);
    expect(fixture.coordinator.isRejectedPeer(REMOTE_PEER_ID)).toBe(false);

    now += 101;
    await expect(
      fixture.coordinator.ensureAdmitted(REMOTE_PEER_ID, createOperationContext('connect')),
    ).rejects.toMatchObject({ code: 'NETWORK_ADMISSION_PROBE_FAILED' });
    expect(sendIdentityProbe).toHaveBeenCalledTimes(2);
  });

  it('does not map retryable probe backoff to explicit-connect rejection', async () => {
    let now = 1_000;
    const sendIdentityProbe = vi.fn(async () => {
      throw new Error('stream timeout');
    });
    const fixture = buildCoordinator({
      identity,
      sendIdentityProbe,
      now: () => now,
      probeBackoff: {
        transientBaseMs: 100,
      },
    });
    const assertExplicitConnectAdmitted = async () => {
      if (await fixture.coordinator.ensureAdmitted(REMOTE_PEER_ID, createOperationContext('connect'))) return;
      throw new NetworkAdmissionRejectedError(REMOTE_PEER_ID);
    };

    await expect(assertExplicitConnectAdmitted()).rejects.toMatchObject({
      code: 'NETWORK_ADMISSION_PROBE_FAILED',
    });
    await expect(assertExplicitConnectAdmitted()).rejects.toMatchObject({
      code: 'NETWORK_ADMISSION_PROBE_FAILED',
    });
    expect(sendIdentityProbe).toHaveBeenCalledTimes(1);
    expect(fixture.coordinator.isRejectedPeer(REMOTE_PEER_ID)).toBe(false);
  });

  it('grows transient retryable probe backoff up to the configured cap', async () => {
    let now = 1_000;
    const sendIdentityProbe = vi.fn(async () => {
      throw new Error('stream timeout');
    });
    const fixture = buildCoordinator({
      identity,
      sendIdentityProbe,
      now: () => now,
      probeBackoff: {
        transientBaseMs: 100,
        transientMaxMs: 150,
      },
    });

    await expect(
      fixture.coordinator.ensureAdmitted(REMOTE_PEER_ID, createOperationContext('connect')),
    ).rejects.toMatchObject({ code: 'NETWORK_ADMISSION_PROBE_FAILED' });
    expect(sendIdentityProbe).toHaveBeenCalledTimes(1);

    now += 99;
    await expect(
      fixture.coordinator.ensureAdmitted(REMOTE_PEER_ID, createOperationContext('connect')),
    ).rejects.toMatchObject({
      code: 'NETWORK_ADMISSION_PROBE_FAILED',
      message: expect.stringContaining('retryable probe backed off for 1ms'),
    });
    expect(sendIdentityProbe).toHaveBeenCalledTimes(1);

    now += 1;
    await expect(
      fixture.coordinator.ensureAdmitted(REMOTE_PEER_ID, createOperationContext('connect')),
    ).rejects.toMatchObject({ code: 'NETWORK_ADMISSION_PROBE_FAILED' });
    expect(sendIdentityProbe).toHaveBeenCalledTimes(2);

    now += 149;
    await expect(
      fixture.coordinator.ensureAdmitted(REMOTE_PEER_ID, createOperationContext('connect')),
    ).rejects.toMatchObject({
      code: 'NETWORK_ADMISSION_PROBE_FAILED',
      message: expect.stringContaining('retryable probe backed off for 1ms'),
    });
    expect(sendIdentityProbe).toHaveBeenCalledTimes(2);

    now += 1;
    await expect(
      fixture.coordinator.ensureAdmitted(REMOTE_PEER_ID, createOperationContext('connect')),
    ).rejects.toMatchObject({ code: 'NETWORK_ADMISSION_PROBE_FAILED' });
    expect(sendIdentityProbe).toHaveBeenCalledTimes(3);
  });

  it('uses unreadable-response backoff before retrying malformed probe responses', async () => {
    let now = 1_000;
    const sendIdentityProbe = vi.fn(async () => new TextEncoder().encode('{not json'));
    const fixture = buildCoordinator({
      identity,
      sendIdentityProbe,
      now: () => now,
      probeBackoff: {
        unreadableResponseMs: 250,
      },
    });

    await expect(
      fixture.coordinator.ensureAdmitted(REMOTE_PEER_ID, createOperationContext('connect')),
    ).rejects.toMatchObject({ code: 'NETWORK_ADMISSION_PROBE_FAILED' });
    expect(sendIdentityProbe).toHaveBeenCalledTimes(1);

    now += 249;
    await expect(
      fixture.coordinator.ensureAdmitted(REMOTE_PEER_ID, createOperationContext('connect')),
    ).rejects.toMatchObject({
      code: 'NETWORK_ADMISSION_PROBE_FAILED',
      message: expect.stringContaining('retryable probe backed off for 1ms'),
    });
    expect(sendIdentityProbe).toHaveBeenCalledTimes(1);

    now += 1;
    await expect(
      fixture.coordinator.ensureAdmitted(REMOTE_PEER_ID, createOperationContext('connect')),
    ).rejects.toMatchObject({ code: 'NETWORK_ADMISSION_PROBE_FAILED' });
    expect(sendIdentityProbe).toHaveBeenCalledTimes(2);
  });

  it('uses unsupported-protocol backoff before retrying unsupported identity probes', async () => {
    let now = 1_000;
    const sendIdentityProbe = vi.fn(async () => {
      throw new Error('protocol not supported');
    });
    const fixture = buildCoordinator({
      identity,
      sendIdentityProbe,
      now: () => now,
      probeBackoff: {
        unsupportedProtocolMs: 500,
      },
    });

    await expect(
      fixture.coordinator.ensureAdmitted(REMOTE_PEER_ID, createOperationContext('connect')),
    ).rejects.toMatchObject({ code: 'NETWORK_ADMISSION_PROBE_FAILED' });
    expect(sendIdentityProbe).toHaveBeenCalledTimes(1);

    now += 499;
    await expect(
      fixture.coordinator.ensureAdmitted(REMOTE_PEER_ID, createOperationContext('connect')),
    ).rejects.toMatchObject({
      code: 'NETWORK_ADMISSION_PROBE_FAILED',
      message: expect.stringContaining('retryable probe backed off for 1ms'),
    });
    expect(sendIdentityProbe).toHaveBeenCalledTimes(1);

    now += 1;
    await expect(
      fixture.coordinator.ensureAdmitted(REMOTE_PEER_ID, createOperationContext('connect')),
    ).rejects.toMatchObject({ code: 'NETWORK_ADMISSION_PROBE_FAILED' });
    expect(sendIdentityProbe).toHaveBeenCalledTimes(2);
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

  it('races caller cancellation without passing caller abort into the shared probe', async () => {
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

    expect(seenOptions).toMatchObject({ timeoutMs: 3_000 });
    expect(seenOptions?.signal).toBeInstanceOf(AbortSignal);
    expect(seenOptions?.signal).not.toBe(callerSignal);
  });

  it('does not start a background probe when the first admission wait is already aborted', async () => {
    const sendIdentityProbe = vi.fn(async () => new TextEncoder().encode('{not json'));
    const fixture = buildCoordinator({
      identity,
      sendIdentityProbe,
    });
    const callerAbort = new AbortController();
    callerAbort.abort(new Error('caller already cancelled'));

    await expect(
      fixture.coordinator.ensureAdmitted(
        REMOTE_PEER_ID,
        createOperationContext('connect'),
        { signal: callerAbort.signal },
      ),
    ).rejects.toThrow('caller already cancelled');
    await Promise.resolve();
    expect(sendIdentityProbe).not.toHaveBeenCalled();

    await expect(
      fixture.coordinator.ensureAdmitted(REMOTE_PEER_ID, createOperationContext('connect')),
    ).rejects.toMatchObject({ code: 'NETWORK_ADMISSION_PROBE_FAILED' });
    expect(sendIdentityProbe).toHaveBeenCalledOnce();
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

  it('keeps caller aborts local to that waiter for shared admission attempts', async () => {
    let release!: (value: Uint8Array) => void;
    const sendIdentityProbe = vi.fn(async () => new Promise<Uint8Array>((resolve) => {
      release = resolve;
    }));
    const fixture = buildCoordinator({
      identity,
      sendIdentityProbe,
    });
    const firstAbort = new AbortController();

    const first = fixture.coordinator.ensureAdmitted(
      REMOTE_PEER_ID_CID,
      createOperationContext('connect'),
      { signal: firstAbort.signal },
    );
    const second = fixture.coordinator.ensureAdmitted(REMOTE_PEER_ID, createOperationContext('connect'));
    await Promise.resolve();

    expect(sendIdentityProbe).toHaveBeenCalledOnce();
    expect(sendIdentityProbe.mock.calls[0][2].signal).toBeInstanceOf(AbortSignal);
    expect(sendIdentityProbe.mock.calls[0][2].signal).not.toBe(firstAbort.signal);
    firstAbort.abort(new Error('caller cancelled'));
    await expect(first).rejects.toThrow('caller cancelled');

    release(new TextEncoder().encode('{not json'));
    await expect(second).rejects.toMatchObject({ code: 'NETWORK_ADMISSION_PROBE_FAILED' });
  });

  it('times out a caller wait with the connect timeout code and aborts an unobserved probe', async () => {
    let release!: (value: Uint8Array) => void;
    let probeSignal: AbortSignal | undefined;
    const sendIdentityProbe = vi.fn(async () => new Promise<Uint8Array>((resolve) => {
      release = resolve;
    }));
    const fixture = buildCoordinator({
      identity,
      sendIdentityProbe,
    });

    await expect(
      fixture.coordinator.ensureAdmitted(
        REMOTE_PEER_ID,
        createOperationContext('connect'),
        { timeoutMs: 1 },
      ),
    ).rejects.toMatchObject({ name: 'AbortError', code: 'CONNECT_TIMEOUT' });

    expect(sendIdentityProbe).toHaveBeenCalledOnce();
    probeSignal = sendIdentityProbe.mock.calls[0][2].signal;
    expect(probeSignal).toBeInstanceOf(AbortSignal);
    expect(probeSignal?.aborted).toBe(true);
    release(new TextEncoder().encode('{not json'));
    await Promise.resolve();
    expect(fixture.admission.snapshot().quarantinedPeerIds).toEqual([]);
    expect(fixture.admission.snapshot().verifiedPeerIds).toEqual([]);
  });

  it('keeps a shared probe alive when one of multiple waiters times out', async () => {
    let release!: (value: Uint8Array) => void;
    const sendIdentityProbe = vi.fn(async () => new Promise<Uint8Array>((resolve) => {
      release = resolve;
    }));
    const fixture = buildCoordinator({
      identity,
      sendIdentityProbe,
    });

    const first = fixture.coordinator.ensureAdmitted(
      REMOTE_PEER_ID_CID,
      createOperationContext('connect'),
      { timeoutMs: 1 },
    );
    const second = fixture.coordinator.ensureAdmitted(REMOTE_PEER_ID, createOperationContext('connect'));
    await expect(first).rejects.toMatchObject({ name: 'AbortError', code: 'CONNECT_TIMEOUT' });

    const probeSignal = sendIdentityProbe.mock.calls[0][2].signal;
    expect(probeSignal).toBeInstanceOf(AbortSignal);
    expect(probeSignal?.aborted).toBe(false);
    release(new TextEncoder().encode('{not json'));
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

  it('does not remember retryable backoff for aborted probe attempts', async () => {
    let now = 1_000;
    let attempts = 0;
    const controller = new AbortController();
    const sendIdentityProbe = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) {
        await Promise.resolve();
        controller.abort(new Error('caller cancelled'));
      }
      throw new Error('stream timeout');
    });
    const fixture = buildCoordinator({
      identity,
      sendIdentityProbe,
      now: () => now,
      probeBackoff: {
        transientBaseMs: 1_000,
      },
    });

    await expect(
      fixture.coordinator.ensureAdmitted(
        REMOTE_PEER_ID,
        createOperationContext('connect'),
        { signal: controller.signal },
      ),
    ).rejects.toThrow('caller cancelled');
    await new Promise((resolve) => setTimeout(resolve, 0));

    await expect(
      fixture.coordinator.ensureAdmitted(REMOTE_PEER_ID, createOperationContext('connect')),
    ).rejects.toMatchObject({ code: 'NETWORK_ADMISSION_PROBE_FAILED' });
    expect(sendIdentityProbe).toHaveBeenCalledTimes(2);

    now += 999;
    await expect(
      fixture.coordinator.ensureAdmitted(REMOTE_PEER_ID, createOperationContext('connect')),
    ).rejects.toMatchObject({
      code: 'NETWORK_ADMISSION_PROBE_FAILED',
      message: expect.stringContaining('retryable probe backed off for 1ms'),
    });
    expect(sendIdentityProbe).toHaveBeenCalledTimes(2);
  });

  it('quarantines peers with a parsed but mismatched network identity proof', async () => {
    const sendIdentityProbe = vi.fn(async () => new TextEncoder().encode(JSON.stringify({
      version: 1,
      peerId: REMOTE_PEER_ID,
      networkId: 'network-b',
      genesisId: identity.genesisId,
      proofKind: 'ed25519-peer-id',
      signature: 'invalid-signature',
    })));
    const fixture = buildCoordinator({
      identity,
      sendIdentityProbe,
    });

    await expect(
      fixture.coordinator.ensureAdmitted(REMOTE_PEER_ID, createOperationContext('connect')),
    ).resolves.toBe(false);
    await expect(
      fixture.coordinator.ensureAdmitted(REMOTE_PEER_ID, createOperationContext('connect')),
    ).resolves.toBe(false);

    expect(fixture.admission.snapshot().quarantinedPeerIds).toEqual([REMOTE_PEER_ID]);
    expect(fixture.coordinator.isRejectedPeer(REMOTE_PEER_ID)).toBe(true);
    expect(sendIdentityProbe).toHaveBeenCalledTimes(1);
    expect(fixture.cleanupRejectedPeerState).toHaveBeenCalledWith(REMOTE_PEER_ID);
    expect(fixture.close).toHaveBeenCalledTimes(1);
    expect(fixture.deletePeerFromPeerStore).toHaveBeenCalledWith(REMOTE_PEER_ID);
  });
});
