import { describe, expect, it, vi } from 'vitest';

import {
  Rfc64PublicCatalogReceiverV1,
  type Rfc64PublicCatalogReceiverStagerV1,
} from '../src/rfc64/public-catalog-receiver-v1.js';
import type {
  FetchedRfc64PublicCatalogHeadV1,
  Rfc64PublicCatalogHeadAnnouncementV1,
} from '../src/rfc64/public-catalog-transport-v1.js';

function announcement(
  overrides: Partial<Rfc64PublicCatalogHeadAnnouncementV1> = {},
): Rfc64PublicCatalogHeadAnnouncementV1 {
  return {
    kind: 'rfc64-author-catalog-head-availability-v1',
    networkId: 'otp:20430',
    contextGraphId: '0x1111111111111111111111111111111111111111/lane',
    subGraphName: null,
    authorAddress: '0x2222222222222222222222222222222222222222',
    catalogEra: '0',
    catalogVersion: '0',
    policyDigest: `0x${'71'.repeat(32)}`,
    catalogHeadObjectDigest: `0x${'aa'.repeat(32)}`,
    signatureVariantDigest: `0x${'bb'.repeat(32)}`,
    ...overrides,
  } as Rfc64PublicCatalogHeadAnnouncementV1;
}

function headWith(objectDigest: string): Rfc64PublicCatalogHeadAnnouncementV1 {
  return announcement({ catalogHeadObjectDigest: objectDigest as `0x${string}` & string });
}

const FAKE_FETCHED = { envelope: {}, issuerSignature: {} } as unknown as FetchedRfc64PublicCatalogHeadV1;

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('RFC-64 public catalog receiver scheduler v1', () => {
  it('fetches, durably stages, and reports the staged head', async () => {
    const staged: FetchedRfc64PublicCatalogHeadV1[] = [];
    const onHeadStaged = vi.fn();
    const stager: Rfc64PublicCatalogReceiverStagerV1 = {
      isHeadStaged: async () => false,
      fetchHead: async () => FAKE_FETCHED,
      stageHead: async (f) => { staged.push(f); },
    };
    const receiver = new Rfc64PublicCatalogReceiverV1(stager, { onHeadStaged });
    receiver.schedule(announcement(), 'peerA');
    await receiver.whenIdle();

    expect(staged).toEqual([FAKE_FETCHED]);
    expect(onHeadStaged).toHaveBeenCalledTimes(1);
    expect(receiver.stats()).toMatchObject({ scheduled: 1, staged: 1, notFound: 0, failed: 0 });
  });

  it('schedule() returns synchronously without awaiting the fetch (ACK path is not stalled)', () => {
    const fetchStarted = deferred<void>();
    const stager: Rfc64PublicCatalogReceiverStagerV1 = {
      isHeadStaged: async () => { fetchStarted.resolve(); return false; },
      fetchHead: () => new Promise(() => {}), // never resolves
      stageHead: async () => {},
    };
    const receiver = new Rfc64PublicCatalogReceiverV1(stager);
    const returned = receiver.schedule(announcement(), 'peerA');
    // schedule returns void synchronously even though fetch never completes.
    expect(returned).toBeUndefined();
    expect(receiver.stats().scheduled).toBe(1);
  });

  it('deduplicates a head already in flight', async () => {
    const gate = deferred<FetchedRfc64PublicCatalogHeadV1 | null>();
    let fetchCalls = 0;
    const stager: Rfc64PublicCatalogReceiverStagerV1 = {
      isHeadStaged: async () => false,
      fetchHead: async () => { fetchCalls += 1; return gate.promise; },
      stageHead: async () => {},
    };
    const receiver = new Rfc64PublicCatalogReceiverV1(stager);
    receiver.schedule(announcement(), 'peerA');
    receiver.schedule(announcement(), 'peerB'); // same head identity → in-flight dedup
    expect(receiver.stats().dedupedInFlight).toBe(1);
    gate.resolve(FAKE_FETCHED);
    await receiver.whenIdle();
    expect(fetchCalls).toBe(1);
    expect(receiver.stats()).toMatchObject({ scheduled: 2, dedupedInFlight: 1, staged: 1 });
  });

  it('skips a head that is already durably staged (no fetch)', async () => {
    const fetchHead = vi.fn(async () => FAKE_FETCHED);
    const stager: Rfc64PublicCatalogReceiverStagerV1 = {
      isHeadStaged: async () => true,
      fetchHead,
      stageHead: async () => {},
    };
    const receiver = new Rfc64PublicCatalogReceiverV1(stager);
    receiver.schedule(announcement(), 'peerA');
    await receiver.whenIdle();
    expect(fetchHead).not.toHaveBeenCalled();
    expect(receiver.stats()).toMatchObject({ dedupedAlreadyStaged: 1, staged: 0 });
  });

  it('records not-found without staging', async () => {
    const stageHead = vi.fn(async () => {});
    const stager: Rfc64PublicCatalogReceiverStagerV1 = {
      isHeadStaged: async () => false,
      fetchHead: async () => null,
      stageHead,
    };
    const receiver = new Rfc64PublicCatalogReceiverV1(stager);
    receiver.schedule(announcement(), 'peerA');
    await receiver.whenIdle();
    expect(stageHead).not.toHaveBeenCalled();
    expect(receiver.stats()).toMatchObject({ notFound: 1, staged: 0 });
  });

  it('drops distinct heads when the queue is full', async () => {
    const gate = deferred<FetchedRfc64PublicCatalogHeadV1 | null>();
    const stager: Rfc64PublicCatalogReceiverStagerV1 = {
      isHeadStaged: async () => false,
      fetchHead: async () => gate.promise,
      stageHead: async () => {},
    };
    const receiver = new Rfc64PublicCatalogReceiverV1(stager, { maxConcurrent: 1, maxQueue: 1 });
    receiver.schedule(headWith(`0x${'a1'.repeat(32)}`), 'peer'); // active
    receiver.schedule(headWith(`0x${'a2'.repeat(32)}`), 'peer'); // queued
    receiver.schedule(headWith(`0x${'a3'.repeat(32)}`), 'peer'); // dropped (queue full)
    expect(receiver.stats().droppedQueueFull).toBe(1);
    gate.resolve(null);
    await receiver.whenIdle();
  });

  it('retries transient fetch failures with bounded backoff then succeeds', async () => {
    let attempts = 0;
    const stager: Rfc64PublicCatalogReceiverStagerV1 = {
      isHeadStaged: async () => false,
      fetchHead: async () => {
        attempts += 1;
        if (attempts < 3) throw new Error('transient network failure');
        return FAKE_FETCHED;
      },
      stageHead: async () => {},
    };
    const receiver = new Rfc64PublicCatalogReceiverV1(stager, { maxAttempts: 3, retryBackoffMs: 1 });
    receiver.schedule(announcement(), 'peerA');
    await receiver.whenIdle();
    expect(attempts).toBe(3);
    expect(receiver.stats()).toMatchObject({ staged: 1, failed: 0 });
  });

  it('gives up after maxAttempts and reports failure', async () => {
    const onError = vi.fn();
    const stager: Rfc64PublicCatalogReceiverStagerV1 = {
      isHeadStaged: async () => false,
      fetchHead: async () => { throw new Error('down'); },
      stageHead: async () => {},
    };
    const receiver = new Rfc64PublicCatalogReceiverV1(stager, { maxAttempts: 2, retryBackoffMs: 1, onError });
    receiver.schedule(announcement(), 'peerA');
    await receiver.whenIdle();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(receiver.stats()).toMatchObject({ failed: 1, staged: 0 });
  });

  it('close() awaits in-flight stage writes and rejects new work', async () => {
    const stageGate = deferred<void>();
    let stageDone = false;
    const stager: Rfc64PublicCatalogReceiverStagerV1 = {
      isHeadStaged: async () => false,
      fetchHead: async () => FAKE_FETCHED,
      stageHead: async () => { await stageGate.promise; stageDone = true; },
    };
    const receiver = new Rfc64PublicCatalogReceiverV1(stager);
    receiver.schedule(announcement(), 'peerA');
    // Let the task reach the stage await.
    await Promise.resolve();
    await Promise.resolve();
    const closing = receiver.close();
    let closed = false;
    void closing.then(() => { closed = true; });
    await Promise.resolve();
    expect(closed).toBe(false); // close is blocked on the in-flight stage write
    stageGate.resolve();
    await closing;
    expect(stageDone).toBe(true);
    // Post-close schedules are dropped.
    receiver.schedule(announcement({ catalogHeadObjectDigest: `0x${'cc'.repeat(32)}` as never }), 'peerA');
    expect(receiver.stats().scheduled).toBe(1);
  });
});
