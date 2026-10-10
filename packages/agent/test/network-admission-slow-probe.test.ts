import { afterEach, describe, expect, it, vi } from 'vitest';
import { createOperationContext, ed25519Sign, ProtocolRouter, PROTOCOL_NETWORK_IDENTITY, type DKGNode, type PeerResolver } from '@origintrail-official/dkg-core';
import { NetworkAdmissionCoordinator, type NetworkAdmissionCoordinatorOptions } from '../src/p2p/network-admission-coordinator.js';
import { NetworkAdmissionService } from '../src/p2p/network-admission.js';
import { makeNetworkIdentityRequest, signNetworkIdentityResponse } from '../src/p2p/network-identity-proof.js';

const PEER = '12D3KooWPvHB21rJUKQuPb7sZDCyveJmtsL3PryNN3y99n6hqRNh';
const SELF = '12D3KooWDCuLesNUYHGEUY5ksEsfJGbShbZ9ep2Pu7uqCNGvgwnb';
const SEED = Buffer.from('vHxcSg3ecwP9UfJWdmlnWQeJe83jD2yKtOJlWuLpIrTRh3QiB5sL6iRhAidCZ3bHQLaE0RwBfHBNEmV7ylcjqg==', 'base64').slice(0, 32);
const identity = { networkId: 'network-a', genesisId: 'base-testnet' };
const ctx = createOperationContext('connect');

async function signed(data: Uint8Array, networkId = identity.networkId): Promise<Uint8Array> {
  const response = await signNetworkIdentityResponse({
    request: JSON.parse(new TextDecoder().decode(data)), identity: { ...identity, networkId },
    responderPeerId: PEER, sign: (payload) => ed25519Sign(payload, SEED),
  });
  return new TextEncoder().encode(JSON.stringify(response));
}

function fixture(send: NetworkAdmissionCoordinatorOptions['sendIdentityProbe'], connected = true) {
  const admission = new NetworkAdmissionService({ networkId: identity.networkId, selfPeerId: SELF, now: () => Date.now() });
  const close = vi.fn();
  const warn = vi.fn();
  const info = vi.fn();
  const coordinator = new NetworkAdmissionCoordinator({
    admission, identity, selfPeerId: SELF, sign: async () => new Uint8Array(), sendIdentityProbe: send,
    getConnections: () => connected ? [{ remotePeer: { toString: () => PEER }, close, abort: vi.fn() }] : [],
    deletePeerFromPeerStore: vi.fn(), log: { info, warn },
  });
  return { admission, coordinator, close, warn, info };
}

afterEach(() => vi.useRealTimers());

describe('slow identity admission', () => {
  it('logs the responder receiving and completing the signed response without letting logging fail the probe', async () => {
    const h = fixture(vi.fn());
    let handler!: (data: Uint8Array) => Promise<Uint8Array>;
    h.coordinator.registerIdentityProtocol({ register: (_protocol, callback) => { handler = callback; } });
    const request = makeNetworkIdentityRequest({ nonce: 'responder-observation', requesterPeerId: PEER, identity });
    const response = await handler(new TextEncoder().encode(JSON.stringify(request)));
    expect(JSON.parse(new TextDecoder().decode(response))).toMatchObject({ version: 1, networkId: identity.networkId });
    expect(h.info.mock.calls.map((call) => call[1])).toEqual([
      expect.stringContaining('Network identity request received'),
      expect.stringMatching(/Network identity response signed in \d+ms/),
    ]);
    h.info.mockImplementation(() => { throw new Error('sink failed'); });
    await expect(handler(new TextEncoder().encode(JSON.stringify(request)))).resolves.toBeInstanceOf(Uint8Array);
  });
  it('retries a 3.5-second responder once without treating its timeout as identity proof', async () => {
    vi.useFakeTimers();
    let first = true;
    const send = vi.fn<NetworkAdmissionCoordinatorOptions['sendIdentityProbe']>(async (_peer, data, options) => {
      if (!first) return signed(data);
      first = false;
      return new Promise<Uint8Array>((resolve, reject) => {
        const late = setTimeout(() => { void signed(data).then(resolve, reject); }, 3_500);
        const timeout = setTimeout(() => { clearTimeout(late); reject(new DOMException('probe deadline', 'TimeoutError')); }, options.timeoutMs);
        options.signal?.addEventListener('abort', () => { clearTimeout(late); clearTimeout(timeout); reject(options.signal!.reason); }, { once: true });
      });
    });
    const h = fixture(send);
    const attempt = h.coordinator.ensureAdmitted(PEER, ctx);
    const outcome = expect(attempt).resolves.toBe(true);
    await vi.advanceTimersByTimeAsync(2_999);
    expect(h.coordinator.isAcceptedPeer(PEER)).toBe(false);
    await vi.advanceTimersByTimeAsync(501);
    await outcome;
    expect(send).toHaveBeenCalledTimes(2);
    expect(h.admission.getRetryableProbeBackoff(PEER)).toBeUndefined();
    expect(h.close).not.toHaveBeenCalled();
  });

  it.each([true, false])('bounds two timeouts and caps suppression only for an open connection (connected=%s)', async (connected) => {
    vi.useFakeTimers();
    let attempts = 0;
    const send = vi.fn<NetworkAdmissionCoordinatorOptions['sendIdentityProbe']>(async (_peer, data) => {
      if (++attempts <= 2) throw new DOMException('probe deadline', 'TimeoutError');
      return signed(data);
    });
    const h = fixture(send, connected);
    await expect(h.coordinator.ensureAdmitted(PEER, ctx)).rejects.toMatchObject({ code: 'NETWORK_ADMISSION_PROBE_FAILED' });
    expect(send).toHaveBeenCalledTimes(2);
    expect(h.coordinator.isAcceptedPeer(PEER)).toBe(false);
    expect(h.admission.getRetryableProbeBackoff(PEER)?.retryAfterMs).toBeLessThanOrEqual(connected ? 3_000 : 15_000);
    expect(h.warn).toHaveBeenCalledTimes(1);
    await expect(h.coordinator.ensureAdmitted(PEER, ctx)).rejects.toMatchObject({ code: 'NETWORK_ADMISSION_PROBE_FAILED' });
    expect(send).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(3_000);
    if (connected) {
      await expect(h.coordinator.ensureAdmitted(PEER, ctx)).resolves.toBe(true);
      expect(send).toHaveBeenCalledTimes(3);
    } else {
      await expect(h.coordinator.ensureAdmitted(PEER, ctx)).rejects.toMatchObject({ code: 'NETWORK_ADMISSION_PROBE_FAILED' });
      expect(send).toHaveBeenCalledTimes(2);
    }
  });

  it('cancels a held retry without recording failure or accepting a delivered late proof', async () => {
    let entered!: () => void;
    let deliver!: (response: Uint8Array) => void;
    let request!: Uint8Array;
    const retryEntered = new Promise<void>((resolve) => { entered = resolve; });
    let attempts = 0;
    const send = vi.fn<NetworkAdmissionCoordinatorOptions['sendIdentityProbe']>(async (_peer, data) => {
      if (++attempts === 1) throw new DOMException('probe deadline', 'TimeoutError');
      request = data;
      entered();
      // A transport may finish after its caller aborts; exercise the late response guard.
      return new Promise<Uint8Array>((resolve) => { deliver = resolve; });
    });
    const h = fixture(send);
    const verified = vi.spyOn(h.admission, 'markVerifiedSameNetwork');
    const caller = new AbortController();
    const attempt = h.coordinator.ensureAdmitted(PEER, ctx, { signal: caller.signal });
    const cancelled = expect(attempt).rejects.toThrow('caller stopped');
    await retryEntered;
    expect(send.mock.calls[1]![2].timeoutMs).toBe(15_000);
    caller.abort(new Error('caller stopped'));
    await cancelled;
    // Observe the same shared attempt through its public boundary until it retires.
    // A new observer cannot revive the controller the sole caller already aborted.
    const retired = h.coordinator.ensureAdmitted(PEER, ctx).then(
      (value) => ({ value }), (error: unknown) => ({ error }),
    );
    deliver(await signed(request));
    expect(await retired).toMatchObject({ error: { name: 'AbortError', code: 'CONNECT_TIMEOUT' } });
    expect(send).toHaveBeenCalledTimes(2);
    expect(verified).not.toHaveBeenCalled();
    expect(h.admission.getRetryableProbeBackoff(PEER)).toBeUndefined();
    expect(h.coordinator.isAcceptedPeer(PEER)).toBe(false);
    expect(h.coordinator.isRejectedPeer(PEER)).toBe(false);
  });

  it.each(['backoff', 'read'] as const)('retries the real router %s deadline once with a signed response', async (phase) => {
    vi.useFakeTimers();
    const routed = routerProbe(phase);
    const h = fixture(routed.send);
    const attempt = h.coordinator.ensureAdmitted(PEER, ctx);
    const admitted = attempt.then((value) => ({ value }), (error: unknown) => ({ error }));
    await vi.advanceTimersByTimeAsync(3_000);
    expect(await admitted).toEqual({ value: true });
    expect(routed.send.mock.calls.map((call) => call[2].timeoutMs)).toEqual([3_000, 15_000]);
    expect(routed.dials()).toBe(2);
    expect(routed.errors).toHaveLength(1);
    expect(routed.errors[0]).toMatchObject(phase === 'backoff'
      ? { name: 'TimeoutError' }
      : { name: 'AbortError', cause: { name: 'TimeoutError' } });
    expect(h.coordinator.isAcceptedPeer(PEER)).toBe(true);
    expect(h.admission.getRetryableProbeBackoff(PEER)).toBeUndefined();
  });

  it.each(['backoff', 'read'] as const)('caller cancellation during real router %s prevents retry and peer blame', async (phase) => {
    vi.useFakeTimers();
    const routed = routerProbe(phase);
    const h = fixture(routed.send);
    const caller = new AbortController();
    const cancelled = expect(h.coordinator.ensureAdmitted(PEER, ctx, { signal: caller.signal })).rejects.toThrow('caller stopped');
    await vi.advanceTimersByTimeAsync(2_900);
    caller.abort(new Error('caller stopped'));
    await cancelled;
    await vi.advanceTimersByTimeAsync(500);
    expect(routed.send).toHaveBeenCalledTimes(1);
    expect(routed.dials()).toBe(1);
    expect(h.coordinator.isAcceptedPeer(PEER)).toBe(false);
    expect(h.coordinator.isRejectedPeer(PEER)).toBe(false);
    expect(h.admission.getRetryableProbeBackoff(PEER)).toBeUndefined();
  });

  it('rejects a foreign-network signed proof after the retry instead of accepting connection liveness', async () => {
    let attempts = 0;
    const send = vi.fn<NetworkAdmissionCoordinatorOptions['sendIdentityProbe']>(async (_peer, data) => {
      if (++attempts === 1) throw new DOMException('probe deadline', 'TimeoutError');
      return signed(data, 'foreign-network');
    });
    const h = fixture(send);
    await expect(h.coordinator.ensureAdmitted(PEER, ctx)).resolves.toBe(false);
    expect(send).toHaveBeenCalledTimes(2);
    expect(h.coordinator.isRejectedPeer(PEER)).toBe(true);
    expect(h.coordinator.isAcceptedPeer(PEER)).toBe(false);
    expect(h.close).toHaveBeenCalledTimes(1);
  });
});

/** Actual send/read/backoff scopes, with only the libp2p stream endpoint simulated. */
function routerProbe(phase: 'backoff' | 'read') {
  let dials = 0;
  const errors: unknown[] = [];
  const stop = new AbortController();
  const node = {
    stopSignal: stop.signal,
    libp2p: {
      getConnections: () => [],
      peerStore: { get: async () => { throw new Error('NotFound'); } },
      dialProtocol: async () => {
        const first = ++dials === 1;
        if (first && phase === 'backoff') {
          await new Promise((resolve) => setTimeout(resolve, 2_700));
          throw new Error('stream reset');
        }
        let data!: Uint8Array;
        let finish!: () => void;
        const waiting = new Promise<void>((resolve) => { finish = resolve; });
        return {
          writeStatus: 'open', send: (request: Uint8Array) => { data = request; },
          close: async () => {}, abort: () => finish(),
          async *[Symbol.asyncIterator]() {
            if (first) { await waiting; return; }
            yield await signed(data);
          },
        };
      },
    },
  } as unknown as DKGNode;
  const router = new ProtocolRouter(node, { peerResolver: { resolve: async () => [] } as unknown as PeerResolver });
  const send = vi.fn<NetworkAdmissionCoordinatorOptions['sendIdentityProbe']>(async (peer, data, options) => {
    try { return await router.send(peer, PROTOCOL_NETWORK_IDENTITY, data, options); }
    catch (error) { errors.push(error); throw error; }
  });
  return { send, errors, dials: () => dials };
}
