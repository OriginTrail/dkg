import {
  SYSTEM_RECORD_DIGEST_DOMAINS_V1,
  SYSTEM_RECORD_MAX_FRAME_BYTES,
  SYSTEM_RECORD_MAX_FRAME_PAYLOAD_BYTES,
  SYSTEM_RECORD_WIRE_VERSION_V1,
  canonicalizeSystemRecordInventoryLeafObjectV1,
  computeSystemRecordInventoryLeafDigestV1,
  decodeSystemRecordRequestFrameV1,
  digestSystemRecordBytesV1,
  encodeSystemRecordResponseFrameV1,
  type Digest32V1,
  type SystemRecordRequestHeaderV1,
} from '@origintrail-official/dkg-core/system-record-v1';
import { describe, expect, it, vi } from 'vitest';

import type {
  CreateSystemRecordRequesterOptionsV1,
  SystemRecordRequesterByteAdmissionV1,
  SystemRecordRequesterExchangeV1,
} from '../src/system-records/requester-api-v1.js';
import {
  createSystemRecordRequesterV1,
} from '../src/system-records/requester-v1.js';
import { createSystemRecordPermitGateV1 } from '../src/system-records/resource-admission-v1-internal.js';

const NETWORK = 'base:84532' as const;
const PAYLOAD = Uint8Array.of(1, 2, 3);
const DIGEST = digestSystemRecordBytesV1(
  SYSTEM_RECORD_DIGEST_DOMAINS_V1.profileBundle,
  PAYLOAD,
);
const LOOKUP = Object.freeze({
  type: 'object' as const,
  objectKind: 'profile-bundle' as const,
  objectDigest: DIGEST,
});

describe('system-record requester V1', () => {
  it('coalesces one exact transfer and accounts isolated caller leases', async () => {
    const bytes = byteAdmission();
    const stream = permitAdmission();
    const decode = permitAdmission();
    const response = Promise.withResolvers<Uint8Array>();
    const exchange = fixtureExchange(async (request) => {
      await response.promise;
      return successResponse(request, PAYLOAD, DIGEST);
    });
    const openExchange = vi.fn(async () => exchange.value);
    const requester = createRequester({ bytes, stream, decode, openExchange });
    const signal = new AbortController().signal;

    const first = requester.fetch(LOOKUP, signal);
    await exchange.requestWritten.promise;
    const second = requester.fetch(LOOKUP, signal);
    expect(requester.stats()).toMatchObject({
      started: 1,
      joined: 1,
      pendingDigests: 1,
      waitingCallers: 2,
      activeStream: 1,
      queuedStreams: 0,
    });
    response.resolve(Uint8Array.of());
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(firstResult.outcome).toBe('ok');
    expect(secondResult.outcome).toBe('ok');
    if (firstResult.outcome !== 'ok' || secondResult.outcome !== 'ok') return;
    expect(firstResult.lease.artifact).not.toBe(secondResult.lease.artifact);
    expect(firstResult.lease.artifact.canonicalBytes).not.toBe(
      secondResult.lease.artifact.canonicalBytes,
    );
    expect(firstResult.lease.artifact).toMatchObject({
      objectKind: 'profile-bundle',
      objectDigest: DIGEST,
    });
    expect(firstResult.lease.artifact.canonicalBytes).toEqual(PAYLOAD);
    expect(openExchange).toHaveBeenCalledTimes(1);
    expect(exchange.writeRequestFrame).toHaveBeenCalledTimes(1);
    expect(exchange.readResponseFrame).toHaveBeenCalledWith(
      SYSTEM_RECORD_MAX_FRAME_BYTES,
      expect.any(AbortSignal),
    );
    expect(bytes.reservations.map(({ requested }) => requested)).toEqual([
      SYSTEM_RECORD_MAX_FRAME_BYTES,
      PAYLOAD.byteLength,
      PAYLOAD.byteLength,
      PAYLOAD.byteLength,
    ]);
    expect(bytes.reservations[0]?.released).toBe(true);
    expect(bytes.reservations[1]?.released).toBe(false);
    expect(bytes.reservations[2]?.released).toBe(false);
    expect(bytes.reservations[3]?.released).toBe(false);
    expect(requester.stats()).toMatchObject({
      completed: 1,
      pendingDigests: 1,
      activeLeases: 2,
      retainedPayloadBytes: PAYLOAD.byteLength * 3,
      activeStream: 0,
    });
    expect(decode.active()).toBe(true);
    firstResult.lease.release();
    expect(bytes.reservations[1]?.released).toBe(false);
    expect(bytes.reservations[2]?.released).toBe(true);
    expect(bytes.reservations[3]?.released).toBe(false);
    expect(decode.active()).toBe(true);
    secondResult.lease.release();
    expect(bytes.reservations[1]?.released).toBe(true);
    expect(bytes.reservations[3]?.released).toBe(true);
    expect(decode.active()).toBe(false);
    expect(requester.stats()).toMatchObject({
      pendingDigests: 0,
      activeLeases: 0,
      retainedPayloadBytes: 0,
    });
  });

  it('serves a late subscriber from retained bytes without sharing mutable storage', async () => {
    const bytes = byteAdmission();
    const exchange = fixtureExchange();
    const openExchange = vi.fn(async () => exchange.value);
    const requester = createRequester({ bytes, openExchange });
    const first = await requester.fetch(
      LOOKUP,
      new AbortController().signal,
    );
    expect(first.outcome).toBe('ok');
    if (first.outcome !== 'ok') return;

    const second = await requester.fetch(LOOKUP, new AbortController().signal);
    expect(second.outcome).toBe('ok');
    if (second.outcome !== 'ok') return;
    expect(openExchange).toHaveBeenCalledTimes(1);
    expect(second.lease.artifact.canonicalBytes).toEqual(PAYLOAD);

    first.lease.artifact.canonicalBytes[0] = 99;
    expect(second.lease.artifact.canonicalBytes).toEqual(PAYLOAD);
    expect(requester.stats()).toMatchObject({
      started: 1,
      joined: 1,
      pendingDigests: 1,
      activeLeases: 2,
      retainedPayloadBytes: PAYLOAD.byteLength * 3,
    });

    second.lease.release();
    first.lease.release();
    expect(bytes.reservations.every(({ released }) => released)).toBe(true);
    expect(requester.stats()).toMatchObject({
      pendingDigests: 0,
      activeLeases: 0,
      retainedPayloadBytes: 0,
    });
  });

  it('fetches and verifies an exact inventory object through the public requester', async () => {
    const leaf = { objectType: 'inventory-leaf', rows: [] } as const;
    const payload = canonicalizeSystemRecordInventoryLeafObjectV1(leaf, NETWORK, true);
    const digest = computeSystemRecordInventoryLeafDigestV1(leaf, NETWORK, true);
    const bytes = byteAdmission();
    let active = fixtureExchange(async (request) => (
      successResponse(request, payload, digest, 'inventory-leaf')
    ));
    const requester = createRequester({
      bytes,
      openExchange: async () => active.value,
    });
    const lookup = Object.freeze({
      type: 'inventory-object' as const,
      rootDescriptorDigest: DIGEST,
      path: Object.freeze([]),
      objectKind: 'inventory-leaf' as const,
      objectDigest: digest,
    });

    const result = await requester.fetch(lookup, new AbortController().signal);
    expect(result.outcome).toBe('ok');
    if (result.outcome !== 'ok') return;
    expect(result.lease.artifact).toMatchObject({
      objectKind: 'inventory-leaf',
      objectDigest: digest,
      canonicalBytes: payload,
    });
    result.lease.release();

    active = fixtureExchange(async (request) => (
      successResponse(request, payload, digest, 'inventory-internal')
    ));
    await expect(requester.fetch(
      lookup,
      new AbortController().signal,
    )).resolves.toMatchObject({ outcome: 'invalid-response' });
    expect(active.reset).toHaveBeenCalledWith('invalid-response');
    expect(bytes.reservations.every(({ released }) => released)).toBe(true);
  });

  it('never queues an unrelated digest behind the one requester stream', async () => {
    const gate = Promise.withResolvers<void>();
    const firstExchange = fixtureExchange(async (request) => {
      await gate.promise;
      return successResponse(request, PAYLOAD, DIGEST);
    });
    const openExchange = vi.fn(async () => firstExchange.value);
    const requester = createRequester({ openExchange });
    const first = requester.fetch(
      LOOKUP,
      new AbortController().signal,
    );
    await firstExchange.requestWritten.promise;
    const otherPayload = Uint8Array.of(4, 5, 6);
    const otherDigest = digestSystemRecordBytesV1(
      SYSTEM_RECORD_DIGEST_DOMAINS_V1.profileBundle,
      otherPayload,
    );
    await expect(requester.fetch({
      ...LOOKUP,
      objectDigest: otherDigest,
    }, new AbortController().signal)).resolves.toEqual({
      outcome: 'busy',
      wireBytes: 0,
    });
    expect(openExchange).toHaveBeenCalledTimes(1);
    expect(requester.stats().queuedStreams).toBe(0);
    gate.resolve();
    const result = await first;
    expect(result.outcome).toBe('ok');
    if (result.outcome === 'ok') result.lease.release();
  });

  it('caps followers per digest without opening another stream', async () => {
    const gate = Promise.withResolvers<void>();
    const exchange = fixtureExchange(async (request) => {
      await gate.promise;
      return successResponse(request, PAYLOAD, DIGEST);
    });
    const openExchange = vi.fn(async () => exchange.value);
    const requester = createRequester({ maxWaitersPerDigest: 1, openExchange });
    const signal = new AbortController().signal;
    const leader = requester.fetch(LOOKUP, signal);
    await exchange.requestWritten.promise;
    const follower = requester.fetch(LOOKUP, signal);
    await expect(requester.fetch(LOOKUP, signal)).resolves.toEqual({
      outcome: 'waiter-limit',
      wireBytes: 0,
    });
    gate.resolve();
    const results = await Promise.all([leader, follower]);
    for (const result of results) {
      if (result.outcome === 'ok') result.lease.release();
    }
    expect(openExchange).toHaveBeenCalledTimes(1);
  });

  it('counts retained successful entries against the global digest cap', async () => {
    const firstExchange = fixtureExchange();
    const openExchange = vi.fn(async () => firstExchange.value);
    const requester = createRequester({ maxPendingDigests: 1, openExchange });
    const first = await requester.fetch(
      LOOKUP,
      new AbortController().signal,
    );
    expect(first.outcome).toBe('ok');
    const otherPayload = Uint8Array.of(7, 8, 9);
    const otherDigest = digestSystemRecordBytesV1(
      SYSTEM_RECORD_DIGEST_DOMAINS_V1.profileBundle,
      otherPayload,
    );
    await expect(requester.fetch({
      ...LOOKUP,
      objectDigest: otherDigest,
    }, new AbortController().signal)).resolves.toEqual({
      outcome: 'capacity',
      wireBytes: 0,
    });
    expect(openExchange).toHaveBeenCalledTimes(1);
    if (first.outcome === 'ok') first.lease.release();
    expect(requester.stats().pendingDigests).toBe(0);
  });

  it('keeps a coalesced transfer alive when only one caller aborts', async () => {
    const gate = Promise.withResolvers<void>();
    const exchange = fixtureExchange(async (request) => {
      await gate.promise;
      return successResponse(request, PAYLOAD, DIGEST);
    });
    const requester = createRequester({ openExchange: async () => exchange.value });
    const leaderController = new AbortController();
    const followerController = new AbortController();
    const leader = requester.fetch(LOOKUP, leaderController.signal);
    await exchange.requestWritten.promise;
    const follower = requester.fetch(LOOKUP, followerController.signal);
    leaderController.abort(new Error('leader cancelled'));
    await expect(leader).rejects.toThrow('leader cancelled');
    gate.resolve();
    const result = await follower;
    expect(result.outcome).toBe('ok');
    if (result.outcome === 'ok') result.lease.release();
    expect(exchange.reset).not.toHaveBeenCalled();
  });

  it('aborts and releases the shared transfer after its final caller leaves', async () => {
    const bytes = byteAdmission();
    const exchange = fixtureExchange(async () => new Promise<Uint8Array>(() => {}));
    const requester = createRequester({ bytes, openExchange: async () => exchange.value });
    const controller = new AbortController();
    const result = requester.fetch(LOOKUP, controller.signal);
    await exchange.requestWritten.promise;
    controller.abort(new Error('caller left'));
    await expect(result).rejects.toThrow('caller left');
    await vi.waitFor(() => {
      expect(requester.stats()).toMatchObject({
        completed: 1,
        pendingDigests: 0,
        waitingCallers: 0,
        activeStream: 0,
      });
    });
    expect(bytes.reservations).toHaveLength(1);
    expect(bytes.reservations[0]?.released).toBe(true);
    expect(exchange.reset).toHaveBeenCalledWith('cancelled');
  });

  it('releases stream and frame ownership when the only caller leaves during open', async () => {
    const bytes = byteAdmission();
    const stream = permitAdmission();
    const opening = Promise.withResolvers<void>();
    const openExchange = vi.fn(async () => {
      opening.resolve();
      return new Promise<SystemRecordRequesterExchangeV1>(() => {});
    });
    const requester = createRequester({ bytes, stream, openExchange });
    const controller = new AbortController();
    const result = requester.fetch(LOOKUP, controller.signal);
    await opening.promise;
    controller.abort(new Error('caller left during open'));

    await expect(result).rejects.toThrow('caller left during open');
    await vi.waitFor(() => expect(requester.stats()).toMatchObject({
      completed: 1,
      pendingDigests: 0,
      waitingCallers: 0,
      activeStream: 0,
    }));
    expect(stream.active()).toBe(false);
    expect(bytes.reservations).toHaveLength(1);
    expect(bytes.reservations[0]?.released).toBe(true);
  });

  it('cleans up when the opener synchronously cancels the initiating caller', async () => {
    const bytes = byteAdmission();
    const stream = permitAdmission();
    const controller = new AbortController();
    const openExchange = vi.fn(async () => {
      controller.abort(new Error('cancelled during open'));
      return new Promise<SystemRecordRequesterExchangeV1>(() => {});
    });
    const requester = createRequester({ bytes, stream, openExchange });
    const result = requester.fetch(LOOKUP, controller.signal);

    await expect(result).rejects.toThrow('cancelled during open');
    await vi.waitFor(() => expect(requester.stats()).toMatchObject({
      completed: 1,
      pendingDigests: 0,
      waitingCallers: 0,
      activeStream: 0,
    }));
    expect(stream.active()).toBe(false);
    expect(bytes.reservations).toHaveLength(1);
    expect(bytes.reservations[0]?.released).toBe(true);
  });

  it('does not attach an immediate retry to a cancelled single-flight', async () => {
    const exchange = fixtureExchange(async () => new Promise<Uint8Array>(() => {}));
    const openExchange = vi.fn(async () => exchange.value);
    const requester = createRequester({ openExchange });
    const controller = new AbortController();
    const first = requester.fetch(LOOKUP, controller.signal);
    await exchange.requestWritten.promise;
    const firstRejection = expect(first).rejects.toThrow('caller left');
    controller.abort(new Error('caller left'));

    const retry = requester.fetch(LOOKUP, new AbortController().signal);
    await expect(retry).resolves.toEqual({ outcome: 'busy', wireBytes: 0 });
    expect(openExchange).toHaveBeenCalledTimes(1);
    await firstRejection;
    await vi.waitFor(() => expect(requester.stats().pendingDigests).toBe(0));
  });

  it('maps every remote status and rejects invalid payload identity fail closed', async () => {
    let active = fixtureExchange();
    const requester = createRequester({ openExchange: async () => active.value });
    const statuses = [
      ['not-found', 'not-found'],
      ['unsupported', 'unsupported'],
      ['busy', 'remote-busy'],
      ['invalid-request', 'remote-error'],
      ['internal', 'remote-error'],
    ] as const;
    for (const [remote, local] of statuses) {
      const response = fixtureExchange(async (request) => errorResponse(request, remote));
      active = response;
      await expect(requester.fetch(
        LOOKUP,
        new AbortController().signal,
      )).resolves.toMatchObject({ outcome: local, wireBytes: expect.any(Number) });
      expect(response.reset).not.toHaveBeenCalled();
    }

    const wrongPayload = Uint8Array.of(9, 9, 9);
    const invalid = fixtureExchange(async (request) => successResponse(request, wrongPayload, DIGEST));
    active = invalid;
    const invalidResult = await requester.fetch(
      LOOKUP,
      new AbortController().signal,
    );
    expect(invalidResult).toEqual(expect.objectContaining({
      outcome: 'invalid-response',
      wireBytes: expect.any(Number),
    }));
    expect(invalidResult.wireBytes).toBeGreaterThan(0);
    expect(invalid.reset).toHaveBeenCalledWith('invalid-response');
    expect(requester.stats()).toMatchObject({ pendingDigests: 0, activeStream: 0 });

    const malformed = fixtureExchange(async () => Uint8Array.of(1));
    active = malformed;
    await expect(requester.fetch(
      LOOKUP,
      new AbortController().signal,
    )).resolves.toMatchObject({ outcome: 'invalid-response', wireBytes: expect.any(Number) });
    expect(malformed.reset).toHaveBeenCalledWith('invalid-response');
  });

  it('reserves before network work and releases permits on capacity, deadline, and close', async () => {
    const stream = permitAdmission();
    const unopened = vi.fn(async () => fixtureExchange().value);
    const exhausted = createRequester({
      bytes: { tryReserve: vi.fn(() => null) },
      stream,
      openExchange: unopened,
    });
    await expect(exhausted.fetch(
      LOOKUP,
      new AbortController().signal,
    )).resolves.toEqual({ outcome: 'capacity', wireBytes: 0 });
    expect(unopened).not.toHaveBeenCalled();
    expect(stream.active()).toBe(false);

    const slow = fixtureExchange(async () => new Promise<Uint8Array>(() => {}));
    const timed = createRequester({ timeoutMs: 5, openExchange: async () => slow.value });
    await expect(timed.fetch(
      LOOKUP,
      new AbortController().signal,
    )).resolves.toMatchObject({ outcome: 'deadline', wireBytes: expect.any(Number) });
    expect(slow.reset).toHaveBeenCalledWith('deadline');
    expect(timed.stats()).toMatchObject({ pendingDigests: 0, activeStream: 0 });

    const blocked = fixtureExchange(async () => new Promise<Uint8Array>(() => {}));
    const closing = createRequester({ openExchange: async () => blocked.value });
    const result = closing.fetch(
      LOOKUP,
      new AbortController().signal,
    );
    await blocked.requestWritten.promise;
    closing.close();
    await expect(result).resolves.toMatchObject({ outcome: 'closed', wireBytes: expect.any(Number) });
    expect(blocked.reset).toHaveBeenCalledWith('closed');
    expect(closing.stats()).toMatchObject({ closed: true, pendingDigests: 0, activeStream: 0 });
    await expect(closing.fetch(
      LOOKUP,
      new AbortController().signal,
    )).resolves.toEqual({ outcome: 'closed', wireBytes: 0 });
  });

  it('maps ordinary open and read failures to transport with complete cleanup', async () => {
    const openBytes = byteAdmission();
    const openStream = permitAdmission();
    const openFailure = createRequester({
      bytes: openBytes,
      stream: openStream,
      openExchange: async () => { throw new Error('dial failed'); },
    });
    await expect(openFailure.fetch(
      LOOKUP,
      new AbortController().signal,
    )).resolves.toEqual({ outcome: 'transport', wireBytes: 0 });
    expect(openStream.active()).toBe(false);
    expect(openBytes.reservations).toHaveLength(1);
    expect(openBytes.reservations[0]?.released).toBe(true);

    const readBytes = byteAdmission();
    const readStream = permitAdmission();
    const readFailure = fixtureExchange(async () => { throw new Error('read failed'); });
    const readRequester = createRequester({
      bytes: readBytes,
      stream: readStream,
      openExchange: async () => readFailure.value,
    });
    const result = await readRequester.fetch(LOOKUP, new AbortController().signal);
    expect(result).toMatchObject({ outcome: 'transport', wireBytes: expect.any(Number) });
    expect(result.wireBytes).toBeGreaterThan(0);
    expect(readFailure.reset).toHaveBeenCalledWith('transport');
    expect(readStream.active()).toBe(false);
    expect(readBytes.reservations).toHaveLength(1);
    expect(readBytes.reservations[0]?.released).toBe(true);
  });

  it('resets an exchange that opens after the requester deadline', async () => {
    const opening = Promise.withResolvers<SystemRecordRequesterExchangeV1>();
    const requester = createRequester({
      timeoutMs: 5,
      openExchange: async () => opening.promise,
    });
    await expect(requester.fetch(
      LOOKUP,
      new AbortController().signal,
    )).resolves.toEqual({ outcome: 'deadline', wireBytes: 0 });

    const late = fixtureExchange();
    opening.resolve(late.value);
    await vi.waitFor(() => expect(late.reset).toHaveBeenCalledWith('deadline'));
    expect(late.writeRequestFrame).not.toHaveBeenCalled();
  });

  it('returns busy when the shared decoder is occupied and retains no payload', async () => {
    const decode = permitAdmission();
    const held = decode.value.tryAcquire();
    expect(held).not.toBeNull();
    const bytes = byteAdmission();
    const exchange = fixtureExchange(async (request) => successResponse(request, PAYLOAD, DIGEST));
    const requester = createRequester({
      bytes,
      decode,
      openExchange: async () => exchange.value,
    });
    await expect(requester.fetch(
      LOOKUP,
      new AbortController().signal,
    )).resolves.toMatchObject({ outcome: 'busy', wireBytes: expect.any(Number) });
    expect(bytes.reservations).toHaveLength(1);
    expect(bytes.reservations[0]?.released).toBe(true);
    expect(requester.stats().retainedPayloadBytes).toBe(0);
    held?.release();
  });

  it('acquires decoder admission before verifying a successful payload', async () => {
    const decode = permitAdmission();
    const held = decode.value.tryAcquire();
    expect(held).not.toBeNull();
    const invalid = fixtureExchange(async (request) => (
      successResponse(request, Uint8Array.of(9, 9, 9), DIGEST)
    ));
    const requester = createRequester({ decode, openExchange: async () => invalid.value });

    await expect(requester.fetch(
      LOOKUP,
      new AbortController().signal,
    )).resolves.toMatchObject({ outcome: 'busy', wireBytes: expect.any(Number) });
    expect(invalid.reset).not.toHaveBeenCalled();
    held?.release();
  });

  it('fails closed when an isolated lease copy cannot be reserved', async () => {
    const base = byteAdmission();
    let reservationAttempt = 0;
    const bytes: SystemRecordRequesterByteAdmissionV1 = {
      tryReserve(requested) {
        reservationAttempt += 1;
        if (reservationAttempt === 3) return null;
        return base.tryReserve(requested);
      },
    };
    const decode = permitAdmission();
    const capacityExchange = fixtureExchange();
    const requester = createRequester({
      bytes,
      decode,
      openExchange: async () => capacityExchange.value,
    });

    await expect(requester.fetch(
      LOOKUP,
      new AbortController().signal,
    )).resolves.toMatchObject({ outcome: 'capacity', wireBytes: expect.any(Number) });
    expect(base.reservations).toHaveLength(2);
    expect(base.reservations.every(({ released }) => released)).toBe(true);
    expect(decode.active()).toBe(false);
    expect(requester.stats()).toMatchObject({
      pendingDigests: 0,
      activeLeases: 0,
      retainedPayloadBytes: 0,
    });
  });

  it('releases decoder and frame ownership when verified payload retention is full', async () => {
    const base = byteAdmission();
    let reservationAttempt = 0;
    const bytes: SystemRecordRequesterByteAdmissionV1 = {
      tryReserve(requested) {
        reservationAttempt += 1;
        if (reservationAttempt === 2) return null;
        return base.tryReserve(requested);
      },
    };
    const decode = permitAdmission();
    const exchange = fixtureExchange();
    const requester = createRequester({
      bytes,
      decode,
      openExchange: async () => exchange.value,
    });

    const result = await requester.fetch(LOOKUP, new AbortController().signal);
    expect(result).toMatchObject({ outcome: 'capacity', wireBytes: expect.any(Number) });
    expect(result.wireBytes).toBeGreaterThan(0);
    expect(base.reservations).toHaveLength(1);
    expect(base.reservations[0]?.released).toBe(true);
    expect(decode.active()).toBe(false);
    expect(requester.stats()).toMatchObject({
      pendingDigests: 0,
      activeLeases: 0,
      retainedPayloadBytes: 0,
    });
  });

  it('accepts the maximum legal bundle under encoded and decoded reservations', async () => {
    const payload = new Uint8Array(SYSTEM_RECORD_MAX_FRAME_PAYLOAD_BYTES);
    const digest = digestSystemRecordBytesV1(
      SYSTEM_RECORD_DIGEST_DOMAINS_V1.profileBundle,
      payload,
    );
    const bytes = byteAdmission();
    const exchange = fixtureExchange(async (request) => successResponse(request, payload, digest));
    const requester = createRequester({ bytes, openExchange: async () => exchange.value });
    const result = await requester.fetch({
      ...LOOKUP,
      objectDigest: digest,
    }, new AbortController().signal);

    expect(result.outcome).toBe('ok');
    expect(bytes.reservations.map(({ requested }) => requested)).toEqual([
      SYSTEM_RECORD_MAX_FRAME_BYTES,
      SYSTEM_RECORD_MAX_FRAME_PAYLOAD_BYTES,
      SYSTEM_RECORD_MAX_FRAME_PAYLOAD_BYTES,
    ]);
    expect(bytes.reservations[0]?.shrunk).toBeLessThanOrEqual(SYSTEM_RECORD_MAX_FRAME_BYTES);
    if (result.outcome === 'ok') {
      expect(result.lease.artifact.canonicalBytes.byteLength).toBe(
        SYSTEM_RECORD_MAX_FRAME_PAYLOAD_BYTES,
      );
      result.lease.release();
    }
    expect(bytes.reservations.every(({ released }) => released)).toBe(true);
  });

  it('closes new work without under-accounting an already delivered lease', async () => {
    const bytes = byteAdmission();
    const decode = permitAdmission();
    const exchange = fixtureExchange();
    const requester = createRequester({
      bytes,
      decode,
      openExchange: async () => exchange.value,
    });
    const result = await requester.fetch(
      LOOKUP,
      new AbortController().signal,
    );
    expect(result.outcome).toBe('ok');
    requester.close();
    expect(requester.stats()).toMatchObject({
      closed: true,
      activeLeases: 1,
      retainedPayloadBytes: PAYLOAD.byteLength * 2,
    });
    expect(bytes.reservations[1]?.released).toBe(false);
    expect(bytes.reservations[2]?.released).toBe(false);
    expect(decode.active()).toBe(true);
    if (result.outcome === 'ok') result.lease.release();
    expect(requester.stats()).toMatchObject({ activeLeases: 0, retainedPayloadBytes: 0 });
    expect(bytes.reservations[1]?.released).toBe(true);
    expect(bytes.reservations[2]?.released).toBe(true);
    expect(decode.active()).toBe(false);
  });
});

function createRequester(overrides: {
  bytes?: SystemRecordRequesterByteAdmissionV1;
  stream?: ReturnType<typeof permitAdmission>;
  decode?: ReturnType<typeof permitAdmission>;
  openExchange?: CreateSystemRecordRequesterOptionsV1['openExchange'];
  timeoutMs?: number;
  maxWaitersPerDigest?: number;
  maxPendingDigests?: number;
} = {}) {
  const stream = overrides.stream ?? permitAdmission();
  const decode = overrides.decode ?? permitAdmission();
  return createSystemRecordRequesterV1({
    networkId: NETWORK,
    openExchange: overrides.openExchange ?? (async () => fixtureExchange().value),
    byteAdmission: overrides.bytes ?? byteAdmission(),
    streamAdmission: stream.value,
    decodeAdmission: decode.value,
    requestId: () => '1'.repeat(32),
    ...(overrides.timeoutMs === undefined ? {} : { timeoutMs: overrides.timeoutMs }),
    ...(overrides.maxWaitersPerDigest === undefined
      ? {}
      : { maxWaitersPerDigest: overrides.maxWaitersPerDigest }),
    ...(overrides.maxPendingDigests === undefined
      ? {}
      : { maxPendingDigests: overrides.maxPendingDigests }),
  });
}

function fixtureExchange(
  respond: (request: SystemRecordRequestHeaderV1) => Promise<Uint8Array> = async (request) => (
    successResponse(request, PAYLOAD, DIGEST)
  ),
) {
  let written: Uint8Array | undefined;
  const requestWritten = Promise.withResolvers<void>();
  const writeRequestFrame = vi.fn(async (frame: Uint8Array) => {
    written = Uint8Array.from(frame);
    requestWritten.resolve();
  });
  const readResponseFrame = vi.fn(async () => {
    if (written === undefined) throw new Error('request was not written');
    return respond(decodeSystemRecordRequestFrameV1(written));
  });
  const reset = vi.fn();
  const value: SystemRecordRequesterExchangeV1 = {
    writeRequestFrame,
    readResponseFrame,
    reset,
  };
  return { value, writeRequestFrame, readResponseFrame, reset, requestWritten };
}

function successResponse(
  request: SystemRecordRequestHeaderV1,
  payload: Uint8Array,
  digest: Digest32V1,
  objectKind: 'profile-bundle' | 'inventory-internal' | 'inventory-leaf' = 'profile-bundle',
): Uint8Array {
  return encodeSystemRecordResponseFrameV1({
    wireVersion: SYSTEM_RECORD_WIRE_VERSION_V1,
    requestId: request.requestId,
    status: 'ok',
    objectKind,
    objectDigest: digest,
    payloadBytes: payload.byteLength.toString(),
  }, payload);
}

function errorResponse(
  request: SystemRecordRequestHeaderV1,
  status: 'not-found' | 'unsupported' | 'busy' | 'internal' | 'invalid-request',
): Uint8Array {
  const errorCode = status === 'not-found'
    ? 'not_found'
    : status === 'invalid-request'
      ? 'invalid_request'
      : status;
  return encodeSystemRecordResponseFrameV1({
    wireVersion: SYSTEM_RECORD_WIRE_VERSION_V1,
    requestId: request.requestId,
    status,
    payloadBytes: '0',
    errorCode,
  }, new Uint8Array());
}

function permitAdmission() {
  const value = createSystemRecordPermitGateV1();
  return { value, active: () => value.active === 1 };
}

function byteAdmission() {
  const reservations: Array<{
    requested: number;
    shrunk?: number;
    released: boolean;
  }> = [];
  const value: SystemRecordRequesterByteAdmissionV1 = {
    tryReserve(requested) {
      const record: {
        requested: number;
        shrunk?: number;
        released: boolean;
      } = { requested, released: false };
      reservations.push(record);
      return {
        shrinkTo(bytes) {
          if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > requested) {
            throw new Error('invalid reservation shrink');
          }
          record.shrunk = bytes;
        },
        release() {
          record.released = true;
        },
      };
    },
  };
  return { ...value, reservations };
}
