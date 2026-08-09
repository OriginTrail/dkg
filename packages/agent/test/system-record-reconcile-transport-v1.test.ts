import { describe, expect, it, vi } from 'vitest';

import {
  SYSTEM_RECORD_MAX_FRAME_BYTES,
  SYSTEM_RECORD_MAX_SLICE_REQUESTS,
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
      await expect(slice.resolve(LOOKUP_A, new AbortController().signal)).rejects.toThrow(outcome);
      slice.release();
    }
    expect(calls).toBe(2);
    expect(transport.stats()).toMatchObject({
      negativeMemoEntries: 0,
      negativeMemoWrites: 0,
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
    await expect(slice.resolve(LOOKUP_A, new AbortController().signal)).resolves.toBeNull();
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

  it('rejects an oversized physical frame and fails over within the slice budget', async () => {
    const oversizedRelease = vi.fn();
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
            wireBytes: SYSTEM_RECORD_MAX_FRAME_BYTES + 1,
            release: oversizedRelease,
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
    expect(oversizedRelease).toHaveBeenCalledTimes(1);
    expect(transport.stats()).toMatchObject({
      negativeMemoEntries: 1,
      requests: 2,
      wireBytes: SYSTEM_RECORD_MAX_FRAME_BYTES + 2,
    });
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
