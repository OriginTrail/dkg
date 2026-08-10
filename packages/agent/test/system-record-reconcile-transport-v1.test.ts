import { describe, expect, it, vi } from 'vitest';

import {
  SYSTEM_RECORD_MAX_CLOSURE_BYTES,
  SYSTEM_RECORD_MAX_CLOSURE_OBJECTS,
  SYSTEM_RECORD_MAX_FRAME_BYTES,
  SYSTEM_RECORD_MAX_HEADER_BYTES,
  SYSTEM_RECORD_MAX_SLICE_REQUESTS,
  SYSTEM_RECORD_OBJECT_CAPS_V1,
  type Digest32V1,
} from '@origintrail-official/dkg-core/system-record-v1';

import type { SystemRecordArtifactV1 } from '../src/system-records/artifact-v1.js';
import {
  createAgentProfileReconcileTransportV1,
} from '../src/system-records/reconcile-transport-v1.js';
import type {
  SystemRecordExactArtifactLookupV1,
  SystemRecordExactFetchResultV1,
} from '../src/system-records/requester-v1.js';

const DIGEST_A = `0x${'aa'.repeat(32)}` as Digest32V1;
const DIGEST_B = `0x${'bb'.repeat(32)}` as Digest32V1;
const LOOKUP_A: SystemRecordExactArtifactLookupV1 = Object.freeze({
  type: 'object',
  objectKind: 'agent-profile-head',
  objectDigest: DIGEST_A,
});
const LOOKUP_B: SystemRecordExactArtifactLookupV1 = Object.freeze({
  type: 'object',
  objectKind: 'agent-profile-head',
  objectDigest: DIGEST_B,
});

describe('agent-profile reconcile exact transport V1', () => {
  it('fails over immediately and skips one provider only for the memoized digest', async () => {
    let nowMs = 10;
    const control = byteAdmission();
    const releases: ReturnType<typeof vi.fn>[] = [];
    const fetchExact = vi.fn(async (
      providerId: string,
      lookup: SystemRecordExactArtifactLookupV1,
    ): Promise<SystemRecordExactFetchResultV1> => {
      if (providerId === 'provider-a') {
        return Object.freeze({ outcome: 'not-found', wireBytes: 17 });
      }
      const success = successfulFetch(lookup, 101);
      releases.push(success.release);
      return success.result;
    });
    const transport = createAgentProfileReconcileTransportV1({
      listProviderIds: () => ['provider-a', 'provider-b'],
      fetchExact,
      controlAdmission: control,
    });

    const first = openSlice(transport, () => nowMs);
    await expect(first.resolve(LOOKUP_A, new AbortController().signal)).resolves.toMatchObject({
      objectDigest: DIGEST_A,
    });
    first.release();
    expect(fetchExact.mock.calls.map(([providerId]) => providerId))
      .toEqual(['provider-a', 'provider-b']);
    expect(releases[0]).toHaveBeenCalledTimes(1);
    expect(transport.stats()).toMatchObject({
      requests: 2,
      wireBytes: 118,
      negativeMemoEntries: 1,
      negativeMemoWrites: 1,
    });

    const second = openSlice(transport, () => nowMs);
    await expect(second.resolve(LOOKUP_A, new AbortController().signal)).resolves.toMatchObject({
      objectDigest: DIGEST_A,
    });
    second.release();
    expect(fetchExact.mock.calls.map(([providerId]) => providerId))
      .toEqual(['provider-a', 'provider-b', 'provider-b']);

    const unrelated = openSlice(transport, () => nowMs);
    await expect(unrelated.resolve(LOOKUP_B, new AbortController().signal)).resolves.toMatchObject({
      objectDigest: DIGEST_B,
    });
    unrelated.release();
    expect(fetchExact.mock.calls.at(-2)?.[0]).toBe('provider-a');
    expect(fetchExact.mock.calls.at(-1)?.[0]).toBe('provider-b');
    expect(transport.stats().negativeMemoHits).toBe(1);
  });

  it.each([
    ['not-found', 'null'],
    ['invalid-response', 'invalid-response'],
    ['deadline', 'deadline'],
  ] as const)('preserves cached %s semantics without another remote request', async (
    outcome,
    expected,
  ) => {
    const fetchExact = vi.fn(async () => Object.freeze({ outcome, wireBytes: 7 }));
    const transport = createAgentProfileReconcileTransportV1({
      listProviderIds: () => ['provider-a'],
      fetchExact,
      controlAdmission: byteAdmission(),
    });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const slice = openSlice(transport, () => 0);
      const resolving = slice.resolve(LOOKUP_A, new AbortController().signal);
      if (expected === 'null') await expect(resolving).resolves.toBeNull();
      else await expect(resolving).rejects.toMatchObject({ outcome: expected });
      slice.release();
    }

    expect(fetchExact).toHaveBeenCalledTimes(1);
    expect(transport.stats()).toMatchObject({
      requests: 1,
      wireBytes: 7,
      negativeMemoEntries: 1,
      negativeMemoHits: 1,
    });
  });

  it('expires negatives lazily after the fixed monotonic TTL', async () => {
    let nowMs = 1_000;
    let failFirstProvider = true;
    const control = byteAdmission();
    const fetchExact = vi.fn(async (
      providerId: string,
      lookup: SystemRecordExactArtifactLookupV1,
    ): Promise<SystemRecordExactFetchResultV1> => providerId === 'provider-a'
      && failFirstProvider
      ? Object.freeze({ outcome: 'deadline', wireBytes: 7 })
      : successfulFetch(lookup, 11).result);
    const transport = createAgentProfileReconcileTransportV1({
      listProviderIds: () => ['provider-a', 'provider-b'],
      fetchExact,
      controlAdmission: control,
      negativeTtlMs: 30_000,
    });

    const first = openSlice(transport, () => nowMs);
    await first.resolve(LOOKUP_A, new AbortController().signal);
    first.release();
    nowMs += 29_999;
    const beforeExpiry = openSlice(transport, () => nowMs);
    await beforeExpiry.resolve(LOOKUP_A, new AbortController().signal);
    beforeExpiry.release();
    expect(fetchExact.mock.calls.map(([providerId]) => providerId))
      .toEqual(['provider-a', 'provider-b', 'provider-b']);

    nowMs += 1;
    failFirstProvider = false;
    const expired = openSlice(transport, () => nowMs);
    await expired.resolve(LOOKUP_A, new AbortController().signal);
    expired.release();
    expect(fetchExact.mock.calls.at(-1)?.[0]).toBe('provider-a');
    expect(control.activeReservations()).toBe(0);
  });

  it('caps memo entries, evicts oldest ownership, and releases all control bytes on close', async () => {
    let nowMs = 0;
    const control = byteAdmission();
    const transport = createAgentProfileReconcileTransportV1({
      listProviderIds: () => ['provider-a'],
      fetchExact: async () => Object.freeze({ outcome: 'invalid-response', wireBytes: 3 }),
      controlAdmission: control,
      maxNegativeEntries: 1,
    });

    const first = openSlice(transport, () => nowMs);
    await expect(first.resolve(LOOKUP_A, new AbortController().signal))
      .rejects.toThrow('invalid-response');
    first.release();
    expect(transport.stats()).toMatchObject({
      negativeMemoEntries: 1,
      negativeMemoEvictions: 0,
    });
    expect(control.activeBytes()).toBeGreaterThan(0);

    nowMs += 1;
    const second = openSlice(transport, () => nowMs);
    await expect(second.resolve(LOOKUP_B, new AbortController().signal))
      .rejects.toThrow('invalid-response');
    second.release();
    expect(transport.stats()).toMatchObject({
      negativeMemoEntries: 1,
      negativeMemoEvictions: 1,
    });
    expect(control.activeReservations()).toBe(1);
    transport.close();
    expect(control.activeBytes()).toBe(0);
    expect(control.activeReservations()).toBe(0);
    expect(transport.stats()).toMatchObject({ negativeMemoEntries: 0, closed: true });
  });

  it.each([
    'busy',
    'capacity',
    'waiter-limit',
    'transport',
    'remote-busy',
    'remote-error',
    'closed',
  ] as const)('does not poison a provider after %s', async (outcome) => {
    let calls = 0;
    const transport = createAgentProfileReconcileTransportV1({
      listProviderIds: () => ['provider-a'],
      fetchExact: async () => {
        calls += 1;
        return Object.freeze({ outcome, wireBytes: 0 });
      },
      controlAdmission: byteAdmission(),
    });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const slice = openSlice(transport, () => 0);
      await expect(slice.resolve(LOOKUP_A, new AbortController().signal)).rejects.toMatchObject({
        outcome,
        retryable: true,
        wireBytes: 0,
      });
      slice.release();
    }
    expect(calls).toBe(2);
    expect(transport.stats()).toMatchObject({
      negativeMemoEntries: 0,
      negativeMemoWrites: 0,
    });
  });

  it('closes an active slice and releases retained leases immediately', async () => {
    const success = successfulFetch(LOOKUP_A, 41);
    const transport = createAgentProfileReconcileTransportV1({
      listProviderIds: () => ['provider-a'],
      fetchExact: async () => success.result,
      controlAdmission: byteAdmission(),
    });
    const slice = openSlice(transport, () => 0);
    await expect(slice.resolve(LOOKUP_A, new AbortController().signal)).resolves.toMatchObject({
      objectDigest: DIGEST_A,
    });
    expect(slice.stats()).toEqual({ requests: 1, wireBytes: 41 });

    transport.close();

    expect(success.release).toHaveBeenCalledTimes(1);
    expect(transport.stats()).toMatchObject({ activeSlice: 0, closed: true });
    slice.release();
    expect(success.release).toHaveBeenCalledTimes(1);
    expect(transport.openSlice({
      signal: new AbortController().signal,
      deadlineMs: 3_000,
      nowMs: () => 0,
    })).toBeNull();
  });

  it('transfers exact leases across physical slices and serves retained hits without I/O', async () => {
    const control = byteAdmission();
    const success = successfulFetch(LOOKUP_A, 41);
    const fetchExact = vi.fn(async () => success.result);
    const transport = createAgentProfileReconcileTransportV1({
      listProviderIds: () => ['provider-a'],
      fetchExact,
      controlAdmission: control,
    });
    const continuation = transport.openArtifactContinuation();
    if (continuation === null) throw new Error('test continuation was not admitted');

    const first = openSlice(transport, () => 0);
    await expect(continuation.bind(first).resolve(
      LOOKUP_A,
      new AbortController().signal,
    )).resolves.toMatchObject({ objectDigest: DIGEST_A });
    first.release();

    expect(success.release).not.toHaveBeenCalled();
    expect(continuation.stats()).toMatchObject({ artifacts: 1, bytes: 3 });
    expect(transport.stats()).toMatchObject({
      retainedContinuationArtifacts: 1,
      retainedContinuationBytes: 3,
    });
    expect(control.activeReservations()).toBe(2);

    const second = openSlice(transport, () => 0);
    await expect(continuation.bind(second).resolve(
      LOOKUP_A,
      new AbortController().signal,
    )).resolves.toMatchObject({ objectDigest: DIGEST_A });
    expect(second.stats()).toEqual({ requests: 0, wireBytes: 0 });
    second.release();
    expect(fetchExact).toHaveBeenCalledTimes(1);

    continuation.clear();
    expect(success.release).toHaveBeenCalledTimes(1);
    expect(control.activeReservations()).toBe(1);
    expect(continuation.stats()).toMatchObject({ artifacts: 0, bytes: 0 });
    continuation.release();
    expect(success.release).toHaveBeenCalledTimes(1);
    expect(control.activeReservations()).toBe(0);
  });

  it('charges empty continuation handles and refuses them when control admission is full', () => {
    let active = 0;
    const release = vi.fn(() => { active -= 1; });
    const transport = createAgentProfileReconcileTransportV1({
      listProviderIds: () => ['provider-a'],
      fetchExact: vi.fn(),
      controlAdmission: {
        tryReserve: () => {
          if (active > 0) return null;
          active += 1;
          return Object.freeze({ release });
        },
      },
    });

    const first = transport.openArtifactContinuation();
    expect(first).not.toBeNull();
    expect(transport.openArtifactContinuation()).toBeNull();
    expect(transport.stats().retainedContinuationControlBytes).toBeGreaterThan(0);

    first?.release();
    expect(release).toHaveBeenCalledTimes(1);
    expect(active).toBe(0);
    expect(transport.stats().retainedContinuationControlBytes).toBe(0);
  });

  it('releases transferred leases and continuation metadata exactly once on close', async () => {
    const control = byteAdmission();
    const success = successfulFetch(LOOKUP_A, 41);
    const transport = createAgentProfileReconcileTransportV1({
      listProviderIds: () => ['provider-a'],
      fetchExact: async () => success.result,
      controlAdmission: control,
    });
    const continuation = transport.openArtifactContinuation();
    if (continuation === null) throw new Error('test continuation was not admitted');
    const slice = openSlice(transport, () => 0);
    await continuation.bind(slice).resolve(LOOKUP_A, new AbortController().signal);
    slice.release();

    transport.close();

    expect(success.release).toHaveBeenCalledTimes(1);
    expect(control.activeReservations()).toBe(0);
    expect(transport.stats()).toMatchObject({
      retainedContinuationArtifacts: 0,
      retainedContinuationBytes: 0,
      closed: true,
    });
    continuation.release();
    expect(success.release).toHaveBeenCalledTimes(1);
  });

  it('rejects and releases a lease above the retained object-count bound', async () => {
    const control = byteAdmission();
    const releaseByDigest = new Map<string, ReturnType<typeof vi.fn>>();
    const transport = createAgentProfileReconcileTransportV1({
      listProviderIds: () => ['provider-a'],
      fetchExact: async (_providerId, lookup) => {
        const release = vi.fn();
        releaseByDigest.set(lookup.objectDigest, release);
        return Object.freeze({
          outcome: 'ok' as const,
          lease: Object.freeze({
            artifact: Object.freeze({
              objectKind: lookup.objectKind,
              objectDigest: lookup.objectDigest,
              canonicalBytes: Uint8Array.of(1),
            }),
            wireBytes: 1,
            release,
          }),
        });
      },
      controlAdmission: control,
    });
    const continuation = transport.openArtifactContinuation();
    if (continuation === null) throw new Error('test continuation was not admitted');
    let objectIndex = 1;
    while (objectIndex <= SYSTEM_RECORD_MAX_CLOSURE_OBJECTS) {
      const slice = openSlice(transport, () => 0);
      const source = continuation.bind(slice);
      for (let request = 0;
        request < SYSTEM_RECORD_MAX_SLICE_REQUESTS
          && objectIndex <= SYSTEM_RECORD_MAX_CLOSURE_OBJECTS;
        request += 1, objectIndex += 1) {
        await source.resolve(controlLookup(objectIndex), new AbortController().signal);
      }
      slice.release();
    }
    expect(continuation.stats()).toMatchObject({
      artifacts: SYSTEM_RECORD_MAX_CLOSURE_OBJECTS,
      bytes: SYSTEM_RECORD_MAX_CLOSURE_OBJECTS,
    });
    expect(control.activeReservations()).toBe(1 + SYSTEM_RECORD_MAX_CLOSURE_OBJECTS);

    const overflowLookup = controlLookup(SYSTEM_RECORD_MAX_CLOSURE_OBJECTS + 1);
    const overflowSlice = openSlice(transport, () => 0);
    await expect(continuation.bind(overflowSlice).resolve(
      overflowLookup,
      new AbortController().signal,
    )).rejects.toThrow(/retained bound/);
    overflowSlice.release();

    expect(releaseByDigest.get(overflowLookup.objectDigest)).toHaveBeenCalledTimes(1);
    expect(continuation.stats()).toMatchObject({
      artifacts: SYSTEM_RECORD_MAX_CLOSURE_OBJECTS,
      bytes: SYSTEM_RECORD_MAX_CLOSURE_OBJECTS,
    });
    expect(control.activeReservations()).toBe(1 + SYSTEM_RECORD_MAX_CLOSURE_OBJECTS);
    continuation.release();
    expect([...releaseByDigest.values()].every((release) => release.mock.calls.length === 1))
      .toBe(true);
    expect(control.activeReservations()).toBe(0);
  });

  it('rejects and releases a lease above the retained byte bound', async () => {
    const control = byteAdmission();
    const releases: ReturnType<typeof vi.fn>[] = [];
    const payloadBytes = SYSTEM_RECORD_OBJECT_CAPS_V1['profile-bundle'];
    const transport = createAgentProfileReconcileTransportV1({
      listProviderIds: () => ['provider-a'],
      fetchExact: async (_providerId, lookup) => {
        const release = vi.fn();
        releases.push(release);
        return Object.freeze({
          outcome: 'ok' as const,
          lease: Object.freeze({
            artifact: Object.freeze({
              objectKind: lookup.objectKind,
              objectDigest: lookup.objectDigest,
              canonicalBytes: new Uint8Array(payloadBytes),
            }),
            wireBytes: 1,
            release,
          }),
        });
      },
      controlAdmission: control,
    });
    const continuation = transport.openArtifactContinuation();
    if (continuation === null) throw new Error('test continuation was not admitted');
    const slice = openSlice(transport, () => 0);
    const source = continuation.bind(slice);
    for (let index = 1; index <= 3; index += 1) {
      await source.resolve(bundleLookup(index), new AbortController().signal);
    }
    expect(continuation.stats()).toMatchObject({ artifacts: 3, bytes: SYSTEM_RECORD_MAX_CLOSURE_BYTES });

    await expect(source.resolve(bundleLookup(4), new AbortController().signal))
      .rejects.toThrow(/retained bound/);
    expect(releases[3]).toHaveBeenCalledTimes(1);
    expect(continuation.stats()).toMatchObject({ artifacts: 3, bytes: SYSTEM_RECORD_MAX_CLOSURE_BYTES });
    expect(control.activeReservations()).toBe(4);
    slice.release();
    continuation.release();
    expect(releases.every((release) => release.mock.calls.length === 1)).toBe(true);
    expect(control.activeReservations()).toBe(0);
  });

  it('does not retain a transferred lease when continuation metadata admission fails', async () => {
    const success = successfulFetch(LOOKUP_A, 41);
    let reservations = 0;
    const transport = createAgentProfileReconcileTransportV1({
      listProviderIds: () => ['provider-a'],
      fetchExact: async () => success.result,
      controlAdmission: {
        tryReserve: () => {
          reservations += 1;
          return reservations === 1 ? Object.freeze({ release: vi.fn() }) : null;
        },
      },
    });
    const continuation = transport.openArtifactContinuation();
    if (continuation === null) throw new Error('test continuation was not admitted');
    const slice = openSlice(transport, () => 0);

    await expect(continuation.bind(slice).resolve(
      LOOKUP_A,
      new AbortController().signal,
    )).rejects.toMatchObject({ outcome: 'capacity', retryable: true });
    slice.release();

    expect(success.release).toHaveBeenCalledTimes(1);
    expect(continuation.stats()).toMatchObject({ artifacts: 0, bytes: 0 });
  });

  it('rejects and releases a late lease when close races an exact fetch', async () => {
    const control = byteAdmission();
    const pending = Promise.withResolvers<SystemRecordExactFetchResultV1>();
    const transport = createAgentProfileReconcileTransportV1({
      listProviderIds: () => ['provider-a'],
      fetchExact: async () => pending.promise,
      controlAdmission: control,
    });
    const continuation = transport.openArtifactContinuation();
    if (continuation === null) throw new Error('test continuation was not admitted');
    const slice = openSlice(transport, () => 0);
    const resolving = continuation.bind(slice).resolve(
      LOOKUP_A,
      new AbortController().signal,
    );
    await vi.waitFor(() => expect(slice.stats().requests).toBe(1));
    transport.close();
    const success = successfulFetch(LOOKUP_A, 41);
    pending.resolve(success.result);

    await expect(resolving).rejects.toThrow();
    expect(success.release).toHaveBeenCalledTimes(1);
    expect(control.activeReservations()).toBe(0);
    expect(transport.stats()).toMatchObject({
      retainedContinuationArtifacts: 0,
      retainedContinuationBytes: 0,
      retainedContinuationControlBytes: 0,
      closed: true,
    });
  });

  it('does not memoize cancellation and releases a late successful lease after slice abort', async () => {
    let settle!: (result: SystemRecordExactFetchResultV1) => void;
    const pending = new Promise<SystemRecordExactFetchResultV1>((resolve) => { settle = resolve; });
    const fetchExact = vi.fn(async () => pending);
    const transport = createAgentProfileReconcileTransportV1({
      listProviderIds: () => ['provider-a'],
      fetchExact,
      controlAdmission: byteAdmission(),
    });
    const caller = new AbortController();
    const slice = openSlice(transport, () => 0);
    const resolving = slice.resolve(LOOKUP_A, caller.signal);
    await vi.waitFor(() => expect(fetchExact).toHaveBeenCalledTimes(1));
    caller.abort(new Error('caller cancelled'));
    const success = successfulFetch(LOOKUP_A, 5);
    settle(success.result);
    await expect(resolving).rejects.toThrow('caller cancelled');
    slice.release();
    expect(success.release).toHaveBeenCalledTimes(1);
    expect(transport.stats()).toMatchObject({
      activeSlice: 0,
      negativeMemoEntries: 0,
      negativeMemoWrites: 0,
    });
  });

  it('enforces the twelve-attempt physical-slice bound without queueing', async () => {
    const providerIds = Array.from(
      { length: SYSTEM_RECORD_MAX_SLICE_REQUESTS + 3 },
      (_, index) => `provider-${index}`,
    );
    const fetchExact = vi.fn(async () => Object.freeze({
      outcome: 'not-found' as const,
      wireBytes: 1,
    }));
    const transport = createAgentProfileReconcileTransportV1({
      listProviderIds: () => providerIds,
      fetchExact,
      controlAdmission: byteAdmission(),
    });
    const slice = openSlice(transport, () => 0);
    await expect(slice.resolve(LOOKUP_A, new AbortController().signal))
      .rejects.toMatchObject({ outcome: 'capacity', retryable: true });
    expect(fetchExact).toHaveBeenCalledTimes(SYSTEM_RECORD_MAX_SLICE_REQUESTS);
    expect(transport.openSlice({
      signal: new AbortController().signal,
      deadlineMs: 3_000,
      nowMs: () => 0,
    })).toBeNull();
    slice.release();
    expect(transport.stats()).toMatchObject({
      activeSlice: 0,
      requests: SYSTEM_RECORD_MAX_SLICE_REQUESTS,
      wireBytes: SYSTEM_RECORD_MAX_SLICE_REQUESTS,
    });
  });

  it('scans past twelve memo hits to a healthy provider without exceeding attempts', async () => {
    const providerIds = Array.from(
      { length: SYSTEM_RECORD_MAX_SLICE_REQUESTS + 1 },
      (_, index) => `provider-${index}`,
    );
    const fetchExact = vi.fn(async (
      providerId: string,
      lookup: SystemRecordExactArtifactLookupV1,
    ): Promise<SystemRecordExactFetchResultV1> => providerId === 'provider-12'
      ? successfulFetch(lookup, 5).result
      : Object.freeze({ outcome: 'not-found', wireBytes: 1 }));
    const transport = createAgentProfileReconcileTransportV1({
      listProviderIds: () => providerIds,
      fetchExact,
      controlAdmission: byteAdmission(),
    });
    const first = openSlice(transport, () => 0);
    await expect(first.resolve(LOOKUP_A, new AbortController().signal))
      .rejects.toMatchObject({ outcome: 'capacity', retryable: true });
    first.release();
    expect(fetchExact).toHaveBeenCalledTimes(SYSTEM_RECORD_MAX_SLICE_REQUESTS);

    const second = openSlice(transport, () => 0);
    await expect(second.resolve(LOOKUP_A, new AbortController().signal)).resolves.toMatchObject({
      objectDigest: DIGEST_A,
    });
    expect(second.stats()).toEqual({ requests: 1, wireBytes: 5 });
    second.release();

    expect(fetchExact).toHaveBeenCalledTimes(SYSTEM_RECORD_MAX_SLICE_REQUESTS + 1);
    expect(fetchExact.mock.calls.at(-1)?.[0]).toBe('provider-12');
  });

  it('reports capacity when a memo hit precedes an unattempted healthy provider', async () => {
    let consumeBudget = false;
    const successful = successfulFetch(LOOKUP_A, 5);
    const fetchExact = vi.fn(async (
      providerId: string,
      lookup: SystemRecordExactArtifactLookupV1,
    ): Promise<SystemRecordExactFetchResultV1> => {
      if (lookup.objectDigest === DIGEST_B || consumeBudget) {
        return Object.freeze({ outcome: 'remote-error', wireBytes: 1 });
      }
      return providerId === 'provider-a'
        ? Object.freeze({ outcome: 'not-found', wireBytes: 1 })
        : successful.result;
    });
    const transport = createAgentProfileReconcileTransportV1({
      listProviderIds: () => ['provider-a', 'provider-b'],
      fetchExact,
      controlAdmission: byteAdmission(),
    });
    const priming = openSlice(transport, () => 0);
    await expect(priming.resolve(LOOKUP_A, new AbortController().signal)).resolves.toMatchObject({
      objectDigest: DIGEST_A,
    });
    priming.release();
    expect(successful.release).toHaveBeenCalledTimes(1);

    consumeBudget = true;
    const saturated = openSlice(transport, () => 0);
    for (let lookup = 0; lookup < SYSTEM_RECORD_MAX_SLICE_REQUESTS / 2; lookup += 1) {
      await expect(saturated.resolve(LOOKUP_B, new AbortController().signal))
        .rejects.toMatchObject({ outcome: 'remote-error' });
    }
    const callsBeforeMemoizedLookup = fetchExact.mock.calls.length;
    await expect(saturated.resolve(LOOKUP_A, new AbortController().signal))
      .rejects.toMatchObject({ outcome: 'capacity', retryable: true });
    expect(fetchExact).toHaveBeenCalledTimes(callsBeforeMemoizedLookup);
    saturated.release();
  });

  it('rejects and releases a mismatched successful lease before failing over', async () => {
    const badRelease = vi.fn();
    const good = successfulFetch(LOOKUP_A, 9);
    const fetchExact = vi.fn(async (
      providerId: string,
    ): Promise<SystemRecordExactFetchResultV1> => providerId === 'provider-a'
      ? Object.freeze({
          outcome: 'ok',
          lease: Object.freeze({
            artifact: Object.freeze({
              objectKind: LOOKUP_A.objectKind,
              objectDigest: DIGEST_B,
              canonicalBytes: Uint8Array.of(1),
            }),
            wireBytes: 7,
            release: badRelease,
          }),
        })
      : good.result);
    const transport = createAgentProfileReconcileTransportV1({
      listProviderIds: () => ['provider-a', 'provider-b'],
      fetchExact,
      controlAdmission: byteAdmission(),
    });
    const slice = openSlice(transport, () => 0);

    await expect(slice.resolve(LOOKUP_A, new AbortController().signal)).resolves.toMatchObject({
      objectDigest: DIGEST_A,
    });
    expect(badRelease).toHaveBeenCalledTimes(1);
    expect(slice.stats()).toEqual({ requests: 2, wireBytes: 16 });
    expect(transport.stats().negativeMemoEntries).toBe(1);
    slice.release();
    expect(good.release).toHaveBeenCalledTimes(1);
  });

  it('fails closed at the two-MiB slice byte bound and does not poison the unaccepted provider', async () => {
    const release = vi.fn();
    const fetchExact = vi.fn(async (
      providerId: string,
    ): Promise<SystemRecordExactFetchResultV1> => providerId === 'provider-a'
      ? Object.freeze({ outcome: 'not-found', wireBytes: 1_050_000 })
      : Object.freeze({
          outcome: 'ok',
          lease: Object.freeze({
            artifact: Object.freeze({
              objectKind: LOOKUP_A.objectKind,
              objectDigest: LOOKUP_A.objectDigest,
              canonicalBytes: Uint8Array.of(1),
            }),
            wireBytes: 1_050_000,
            release,
          }),
        }));
    const transport = createAgentProfileReconcileTransportV1({
      listProviderIds: () => ['provider-a', 'provider-b'],
      fetchExact,
      controlAdmission: byteAdmission(),
    });
    const slice = openSlice(transport, () => 0);
    await expect(slice.resolve(LOOKUP_A, new AbortController().signal))
      .rejects.toThrow('capacity');
    slice.release();
    expect(release).toHaveBeenCalledTimes(1);
    expect(transport.stats()).toMatchObject({
      requests: 2,
      wireBytes: 2_100_000,
      negativeMemoEntries: 1,
    });

    const retry = openSlice(transport, () => 0);
    await expect(retry.resolve(LOOKUP_A, new AbortController().signal))
      .resolves.toMatchObject({ objectDigest: DIGEST_A });
    retry.release();
    expect(fetchExact.mock.calls.at(-1)?.[0]).toBe('provider-b');
    expect(release).toHaveBeenCalledTimes(2);
  });

  it('creates no timer, queue, or background expiry work', async () => {
    vi.useFakeTimers();
    try {
      const transport = createAgentProfileReconcileTransportV1({
        listProviderIds: () => ['provider-a'],
        fetchExact: async () => Object.freeze({ outcome: 'not-found', wireBytes: 1 }),
        controlAdmission: byteAdmission(),
      });
      const slice = openSlice(transport, () => 0);
      await expect(slice.resolve(LOOKUP_A, new AbortController().signal)).resolves.toBeNull();
      slice.release();
      expect(transport.stats().negativeMemoEntries).toBe(1);
      expect(vi.getTimerCount()).toBe(0);
      transport.close();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('memoizes a provider that consumes the slice deadline before returning', async () => {
    let nowMs = 0;
    const fetchExact = vi.fn(async (
      providerId: string,
      lookup: SystemRecordExactArtifactLookupV1,
    ): Promise<SystemRecordExactFetchResultV1> => {
      if (providerId === 'provider-a') {
        nowMs = 3_000;
        return Object.freeze({ outcome: 'deadline', wireBytes: 1 });
      }
      return successfulFetch(lookup, 1).result;
    });
    const transport = createAgentProfileReconcileTransportV1({
      listProviderIds: () => ['provider-a', 'provider-b'],
      fetchExact,
      controlAdmission: byteAdmission(),
    });
    const first = openSlice(transport, () => nowMs);
    await expect(first.resolve(LOOKUP_A, new AbortController().signal))
      .rejects.toThrow('deadline');
    first.release();
    expect(transport.stats().negativeMemoEntries).toBe(1);

    const second = openSlice(transport, () => nowMs);
    await expect(second.resolve(LOOKUP_A, new AbortController().signal)).resolves.toMatchObject({
      objectDigest: DIGEST_A,
    });
    second.release();
    expect(fetchExact.mock.calls.map(([providerId]) => providerId))
      .toEqual(['provider-a', 'provider-b']);
  });

  it('accepts valid aggregate exchange bytes above the response frame cap', async () => {
    const release = vi.fn();
    const fetchExact = vi.fn(async (
      _providerId: string,
      lookup: SystemRecordExactArtifactLookupV1,
    ): Promise<SystemRecordExactFetchResultV1> => Object.freeze({
      outcome: 'ok',
      lease: Object.freeze({
        artifact: Object.freeze({
          objectKind: lookup.objectKind,
          objectDigest: lookup.objectDigest,
          canonicalBytes: Uint8Array.of(1),
        }),
        wireBytes: SYSTEM_RECORD_MAX_FRAME_BYTES + 1,
        release,
      }),
    }));
    const transport = createAgentProfileReconcileTransportV1({
      listProviderIds: () => ['provider-a'],
      fetchExact,
      controlAdmission: byteAdmission(),
    });
    const slice = openSlice(transport, () => 0);
    await expect(slice.resolve(LOOKUP_A, new AbortController().signal)).resolves.toMatchObject({
      objectDigest: DIGEST_A,
    });
    slice.release();
    expect(fetchExact.mock.calls.map(([providerId]) => providerId))
      .toEqual(['provider-a']);
    expect(release).toHaveBeenCalledTimes(1);
    expect(transport.stats()).toMatchObject({
      negativeMemoEntries: 0,
      requests: 1,
      wireBytes: SYSTEM_RECORD_MAX_FRAME_BYTES + 1,
    });
  });

  it('rejects impossible aggregate exchange accounting and fails over', async () => {
    const invalidRelease = vi.fn();
    const maximumExchangeBytes = 4 + SYSTEM_RECORD_MAX_HEADER_BYTES
      + SYSTEM_RECORD_MAX_FRAME_BYTES;
    const fetchExact = vi.fn(async (
      providerId: string,
      lookup: SystemRecordExactArtifactLookupV1,
    ): Promise<SystemRecordExactFetchResultV1> => providerId === 'provider-a'
      ? Object.freeze({
          outcome: 'ok',
          lease: Object.freeze({
            artifact: Object.freeze({
              objectKind: lookup.objectKind,
              objectDigest: lookup.objectDigest,
              canonicalBytes: Uint8Array.of(1),
            }),
            wireBytes: maximumExchangeBytes + 1,
            release: invalidRelease,
          }),
        })
      : successfulFetch(lookup, 1).result);
    const transport = createAgentProfileReconcileTransportV1({
      listProviderIds: () => ['provider-a', 'provider-b'],
      fetchExact,
      controlAdmission: byteAdmission(),
    });
    const slice = openSlice(transport, () => 0);
    await expect(slice.resolve(LOOKUP_A, new AbortController().signal)).resolves.toMatchObject({
      objectDigest: DIGEST_A,
    });
    slice.release();
    expect(fetchExact.mock.calls.map(([providerId]) => providerId))
      .toEqual(['provider-a', 'provider-b']);
    expect(invalidRelease).toHaveBeenCalledTimes(1);
    expect(transport.stats()).toMatchObject({
      negativeMemoEntries: 1,
      requests: 2,
      wireBytes: maximumExchangeBytes + 2,
    });
  });

  it('rejects artifacts above their kind-specific payload cap', async () => {
    const invalidRelease = vi.fn();
    const fetchExact = vi.fn(async (
      providerId: string,
      lookup: SystemRecordExactArtifactLookupV1,
    ): Promise<SystemRecordExactFetchResultV1> => providerId === 'provider-a'
      ? Object.freeze({
          outcome: 'ok',
          lease: Object.freeze({
            artifact: Object.freeze({
              objectKind: lookup.objectKind,
              objectDigest: lookup.objectDigest,
              canonicalBytes: new Uint8Array(
                SYSTEM_RECORD_OBJECT_CAPS_V1['agent-profile-head'] + 1,
              ),
            }),
            wireBytes: SYSTEM_RECORD_OBJECT_CAPS_V1['agent-profile-head'] + 128,
            release: invalidRelease,
          }),
        })
      : successfulFetch(lookup, 1).result);
    const transport = createAgentProfileReconcileTransportV1({
      listProviderIds: () => ['provider-a', 'provider-b'],
      fetchExact,
      controlAdmission: byteAdmission(),
    });
    const slice = openSlice(transport, () => 0);
    await expect(slice.resolve(LOOKUP_A, new AbortController().signal)).resolves.toMatchObject({
      objectDigest: DIGEST_A,
    });
    slice.release();
    expect(invalidRelease).toHaveBeenCalledTimes(1);
    expect(fetchExact.mock.calls.map(([providerId]) => providerId))
      .toEqual(['provider-a', 'provider-b']);
  });

  it('scopes inventory negatives to the complete root and path coordinates', async () => {
    const fetchExact = vi.fn(async (
      _providerId: string,
      lookup: SystemRecordExactArtifactLookupV1,
    ): Promise<SystemRecordExactFetchResultV1> => lookup.type === 'inventory-object'
      && lookup.rootDescriptorDigest === DIGEST_A
      ? Object.freeze({ outcome: 'not-found', wireBytes: 1 })
      : successfulFetch(lookup, 2).result);
    const transport = createAgentProfileReconcileTransportV1({
      listProviderIds: () => ['provider-a'],
      fetchExact,
      controlAdmission: byteAdmission(),
    });
    const first = openSlice(transport, () => 0);
    await expect(first.loadInventoryObject(Object.freeze({
      rootDescriptorDigest: DIGEST_A,
      objectDigest: DIGEST_B,
      expectedKind: 'inventory-leaf',
      path: Object.freeze([0]),
    }), new AbortController().signal)).resolves.toMatchObject({
      outcome: 'rejected',
      rejection: 'not-found',
    });
    first.release();

    const second = openSlice(transport, () => 0);
    await expect(second.loadInventoryObject(Object.freeze({
      rootDescriptorDigest: DIGEST_B,
      objectDigest: DIGEST_B,
      expectedKind: 'inventory-leaf',
      path: Object.freeze([1]),
    }), new AbortController().signal)).resolves.toMatchObject({ outcome: 'ok' });
    second.release();
    expect(fetchExact).toHaveBeenCalledTimes(2);
    expect(fetchExact.mock.calls[1]?.[1]).toMatchObject({
      rootDescriptorDigest: DIGEST_B,
      path: [1],
    });
  });

  it.each([
    ['not-found', 'not-found'],
    ['unsupported', 'not-found'],
    ['invalid-response', 'invalid-response'],
    ['remote-busy', 'busy'],
    ['busy', 'busy'],
    ['capacity', 'busy'],
    ['waiter-limit', 'busy'],
    ['deadline', 'transport'],
    ['remote-error', 'transport'],
    ['transport', 'transport'],
    ['closed', 'transport'],
  ] as const)('maps exact inventory %s to %s rejection', async (outcome, rejection) => {
    const transport = createAgentProfileReconcileTransportV1({
      listProviderIds: () => ['provider-a'],
      fetchExact: async () => Object.freeze({ outcome, wireBytes: 7 }),
      controlAdmission: byteAdmission(),
    });
    const slice = openSlice(transport, () => 0);
    await expect(slice.loadInventoryObject(Object.freeze({
      rootDescriptorDigest: DIGEST_A,
      objectDigest: DIGEST_B,
      expectedKind: 'inventory-leaf',
      path: Object.freeze([0]),
    }), new AbortController().signal)).resolves.toEqual({
      outcome: 'rejected',
      rejection,
      wireBytes: 7,
    });
    slice.release();
  });

  it('rejects broad root and inventory lookups before opening an exact fetch', async () => {
    const fetchExact = vi.fn();
    const transport = createAgentProfileReconcileTransportV1({
      listProviderIds: () => ['provider-a'],
      fetchExact,
      controlAdmission: byteAdmission(),
    });
    const slice = openSlice(transport, () => 0);
    await expect(slice.resolve(Object.freeze({ type: 'root' }), new AbortController().signal))
      .rejects.toThrow(/requires an exact artifact/);
    await expect(slice.resolve(Object.freeze({
      type: 'object',
      objectKind: 'inventory-leaf',
      objectDigest: DIGEST_A,
    }), new AbortController().signal)).rejects.toThrow(/exact inventory coordinates/);
    slice.release();
    expect(fetchExact).not.toHaveBeenCalled();
  });
});

function openSlice(
  transport: ReturnType<typeof createAgentProfileReconcileTransportV1>,
  nowMs: () => number,
) {
  const opened = transport.openSlice(Object.freeze({
    signal: new AbortController().signal,
    deadlineMs: nowMs() + 3_000,
    nowMs,
  }));
  if (opened === null) throw new Error('test transport slice was not admitted');
  return opened;
}

function successfulFetch(
  lookup: SystemRecordExactArtifactLookupV1,
  wireBytes: number,
): Readonly<{
  result: Extract<SystemRecordExactFetchResultV1, { outcome: 'ok' }>;
  release: ReturnType<typeof vi.fn>;
}> {
  const release = vi.fn();
  const artifact: SystemRecordArtifactV1 = Object.freeze({
    objectKind: lookup.objectKind,
    objectDigest: lookup.objectDigest,
    canonicalBytes: Uint8Array.of(1, 2, 3),
  });
  return Object.freeze({
    release,
    result: Object.freeze({
      outcome: 'ok',
      lease: Object.freeze({ artifact, wireBytes, release }),
    }),
  });
}

function controlLookup(index: number): SystemRecordExactArtifactLookupV1 {
  return Object.freeze({
    type: 'object',
    objectKind: 'agent-profile-head',
    objectDigest: indexedDigest(index),
  });
}

function bundleLookup(index: number): SystemRecordExactArtifactLookupV1 {
  return Object.freeze({
    type: 'object',
    objectKind: 'profile-bundle',
    objectDigest: indexedDigest(index),
  });
}

function indexedDigest(index: number): Digest32V1 {
  return `0x${index.toString(16).padStart(64, '0')}` as Digest32V1;
}

function byteAdmission() {
  let activeBytes = 0;
  let activeReservations = 0;
  return Object.freeze({
    tryReserve(bytes: number) {
      activeBytes += bytes;
      activeReservations += 1;
      let live = true;
      return Object.freeze({
        release() {
          if (!live) return;
          live = false;
          activeBytes -= bytes;
          activeReservations -= 1;
        },
      });
    },
    activeBytes: () => activeBytes,
    activeReservations: () => activeReservations,
  });
}
