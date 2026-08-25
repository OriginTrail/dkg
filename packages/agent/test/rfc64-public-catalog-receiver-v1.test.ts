import { describe, expect, it, vi } from 'vitest';

import {
  Rfc64PublicCatalogReceiverV1,
  type Rfc64PublicCatalogReceiverReconcilerV1,
  type Rfc64PublicCatalogReconcileResultV1,
} from '../src/rfc64/public-catalog-receiver-v1.js';
import type { Rfc64PublicCatalogHeadAnnouncementV1 } from '../src/rfc64/public-catalog-transport-v1.js';

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
    catalogVersion: '1',
    policyDigest: `0x${'71'.repeat(32)}`,
    catalogHeadObjectDigest: `0x${'aa'.repeat(32)}`,
    signatureVariantDigest: `0x${'bb'.repeat(32)}`,
    ...overrides,
  } as Rfc64PublicCatalogHeadAnnouncementV1;
}

function headWith(objectDigest: string): Rfc64PublicCatalogHeadAnnouncementV1 {
  return announcement({ catalogHeadObjectDigest: objectDigest as `0x${string}` & string });
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (v: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function reconciler(
  reconcileHead: Rfc64PublicCatalogReceiverReconcilerV1['reconcileHead'],
  isHeadApplied: Rfc64PublicCatalogReceiverReconcilerV1['isHeadApplied'] = async () => false,
): Rfc64PublicCatalogReceiverReconcilerV1 {
  return { isHeadApplied, reconcileHead };
}

/** Small deterministic script for multi-provider scheduler scenarios. */
function scriptedReconciler(peerIds: readonly string[]) {
  const steps: Array<{
    readonly peerId: string;
    readonly started: ReturnType<typeof deferred<void>>;
    readonly result: ReturnType<typeof deferred<Rfc64PublicCatalogReconcileResultV1>>;
    signal?: AbortSignal;
  }> = peerIds.map((peerId) => ({
    peerId,
    started: deferred<void>(),
    result: deferred<Rfc64PublicCatalogReconcileResultV1>(),
  }));
  const peers: string[] = [];
  let cursor = 0;
  return {
    peers,
    steps,
    reconciler: reconciler(async (peerId, _head, signal) => {
      const step = steps[cursor];
      cursor += 1;
      if (step === undefined) throw new Error(`Unexpected reconcile call for ${peerId}`);
      expect(peerId).toBe(step.peerId);
      step.signal = signal;
      peers.push(peerId);
      step.started.resolve();
      return step.result.promise;
    }),
  };
}

describe('RFC-64 public catalog receiver scheduler v1', () => {
  it('reconciles and reports one durably applied inventory head', async () => {
    const appliedPeers: string[] = [];
    const onHeadApplied = vi.fn();
    const receiver = new Rfc64PublicCatalogReceiverV1(
      reconciler(async (peerId) => { appliedPeers.push(peerId); return 'applied'; }),
      { onHeadApplied },
    );
    receiver.schedule(announcement(), 'peerA');
    await receiver.whenIdle();

    expect(appliedPeers).toEqual(['peerA']);
    expect(onHeadApplied).toHaveBeenCalledTimes(1);
    expect(receiver.stats()).toMatchObject({ scheduled: 1, applied: 1, notFound: 0, failed: 0 });
  });

  it('schedule returns synchronously without awaiting reconciliation', () => {
    const started = deferred<void>();
    const receiver = new Rfc64PublicCatalogReceiverV1(reconciler(async () => {
      started.resolve();
      return new Promise<Rfc64PublicCatalogReconcileResultV1>(() => {});
    }));
    expect(receiver.schedule(announcement(), 'peerA')).toBeUndefined();
    expect(receiver.stats().scheduled).toBe(1);
  });

  it('deduplicates one head while retaining an alternate provider', async () => {
    const gate = deferred<Rfc64PublicCatalogReconcileResultV1>();
    const peers: string[] = [];
    let calls = 0;
    const receiver = new Rfc64PublicCatalogReceiverV1(reconciler(async (peerId) => {
      peers.push(peerId);
      calls += 1;
      if (calls === 1) return gate.promise;
      return 'applied';
    }), { maxAttempts: 2, retryBackoffMs: 0 });

    receiver.schedule(announcement(), 'peerA');
    receiver.schedule(announcement(), 'peerB');
    expect(receiver.stats().dedupedInFlight).toBe(1);
    gate.resolve('not-found');
    await receiver.whenIdle();

    expect(peers).toEqual(['peerA', 'peerB']);
    expect(receiver.stats()).toMatchObject({ scheduled: 2, applied: 1, notFound: 0 });
  });

  it('never retries an authoritative not-found peer while a viable peer can retry', async () => {
    const peers: string[] = [];
    let peerBAttempts = 0;
    const firstAttempt = deferred<void>();
    const receiver = new Rfc64PublicCatalogReceiverV1(reconciler(async (peerId) => {
      peers.push(peerId);
      if (peerId === 'peerA') {
        firstAttempt.resolve();
        return 'not-found';
      }
      peerBAttempts += 1;
      if (peerBAttempts === 1) throw new Error('peerB transient');
      return 'applied';
    }), { maxAttempts: 3, retryBackoffMs: 0 });

    receiver.schedule(announcement(), 'peerA');
    await firstAttempt.promise;
    receiver.schedule(announcement(), 'peerB');
    await receiver.whenIdle();

    expect(peers).toEqual(['peerA', 'peerB', 'peerB']);
    expect(receiver.stats()).toMatchObject({ applied: 1, notFound: 0, failed: 0 });
  });

  it('tries a newly retained provider even when the first provider used its only attempt', async () => {
    const peers: string[] = [];
    const firstAttempt = deferred<void>();
    const receiver = new Rfc64PublicCatalogReceiverV1(reconciler(async (peerId) => {
      peers.push(peerId);
      if (peerId === 'peerA') {
        firstAttempt.resolve();
        return 'not-found';
      }
      return 'applied';
    }), { maxAttempts: 1, retryBackoffMs: 0 });
    receiver.schedule(announcement(), 'peerA');
    await firstAttempt.promise;
    receiver.schedule(announcement(), 'peerB');
    await receiver.whenIdle();
    expect(peers).toEqual(['peerA', 'peerB']);
    expect(receiver.stats()).toMatchObject({ applied: 1, notFound: 0, failed: 0 });
  });

  it('retries a provider when a new hint supersedes its in-flight not-found observation', async () => {
    const script = scriptedReconciler(['peerA', 'peerB', 'peerA']);
    const receiver = new Rfc64PublicCatalogReceiverV1(
      script.reconciler,
      { maxAttempts: 3, retryBackoffMs: 0 },
    );

    receiver.schedule(announcement(), 'peerA');
    receiver.schedule(announcement(), 'peerB');
    await script.steps[0]!.started.promise;
    script.steps[0]!.result.resolve('not-found');
    await script.steps[1]!.started.promise;

    // peerA has made the content available since its first fetch. The exact
    // repeated hint must revive it without creating duplicate semantic work.
    receiver.schedule(announcement(), 'peerA');
    script.steps[1]!.result.resolve('not-found');
    await script.steps[2]!.started.promise;
    script.steps[2]!.result.resolve('applied');
    await receiver.whenIdle();

    expect(script.peers).toEqual(['peerA', 'peerB', 'peerA']);
    expect(receiver.stats()).toMatchObject({
      scheduled: 3,
      dedupedInFlight: 2,
      applied: 1,
      notFound: 0,
      failed: 0,
    });
  });

  it('does not lose a refreshed hint accepted during terminal promise settlement', async () => {
    const script = scriptedReconciler(['peerA', 'peerB', 'peerA']);
    const receiver = new Rfc64PublicCatalogReceiverV1(
      script.reconciler,
      { maxAttempts: 2, retryBackoffMs: 0 },
    );

    receiver.schedule(announcement(), 'peerA');
    receiver.schedule(announcement(), 'peerB');
    await script.steps[0]!.started.promise;
    script.steps[0]!.result.resolve('not-found');
    await script.steps[1]!.started.promise;

    // Resolving B queues #runTask's terminal continuation first. This queued
    // refresh runs after that decision but before the completion handler that
    // used to delete the pending task.
    script.steps[1]!.result.resolve('not-found');
    queueMicrotask(() => receiver.schedule(announcement(), 'peerA'));

    await script.steps[2]!.started.promise;
    script.steps[2]!.result.resolve('applied');
    await receiver.whenIdle();

    expect(script.peers).toEqual(['peerA', 'peerB', 'peerA']);
    expect(receiver.stats()).toMatchObject({
      scheduled: 3,
      dedupedInFlight: 2,
      applied: 1,
      notFound: 0,
      failed: 0,
    });
  });

  it('reports an explicit error when a fresh hint arrives after the last attempt starts', async () => {
    const script = scriptedReconciler(['peerA']);
    const onError = vi.fn();
    const receiver = new Rfc64PublicCatalogReceiverV1(
      script.reconciler,
      { maxAttempts: 1, retryBackoffMs: 0, onError },
    );

    receiver.schedule(announcement(), 'peerA');
    await script.steps[0]!.started.promise;
    receiver.schedule(announcement(), 'peerA');
    script.steps[0]!.result.resolve('not-found');
    await receiver.whenIdle();

    expect(script.peers).toEqual(['peerA']);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[1]).toBeInstanceOf(Error);
    expect((onError.mock.calls[0]?.[1] as Error).message)
      .toMatch(/attempt budget.*latest accepted provider hint/);
    expect(receiver.stats()).toMatchObject({ notFound: 0, failed: 1 });
  });

  it('coalesces repeated refreshed hints into one bounded retry per provider observation', async () => {
    const script = scriptedReconciler(['peerA', 'peerB', 'peerA', 'peerB']);
    const receiver = new Rfc64PublicCatalogReceiverV1(
      script.reconciler,
      { maxAttempts: 32, retryBackoffMs: 0 },
    );

    receiver.schedule(announcement(), 'peerA');
    await script.steps[0]!.started.promise;
    for (let index = 0; index < 50; index += 1) {
      receiver.schedule(announcement(), 'peerA');
    }
    receiver.schedule(announcement(), 'peerB');
    script.steps[0]!.result.resolve('not-found');

    await script.steps[1]!.started.promise;
    for (let index = 0; index < 50; index += 1) {
      receiver.schedule(announcement(), 'peerB');
    }
    script.steps[1]!.result.resolve('not-found');
    await script.steps[2]!.started.promise;
    script.steps[2]!.result.resolve('not-found');
    await script.steps[3]!.started.promise;
    script.steps[3]!.result.resolve('not-found');
    await receiver.whenIdle();

    // Fifty duplicates for each peer collapse to the newest observation. With
    // no later observation, both providers settle after exactly one refresh.
    expect(script.peers).toEqual(['peerA', 'peerB', 'peerA', 'peerB']);
    expect(receiver.stats()).toMatchObject({
      scheduled: 102,
      dedupedInFlight: 101,
      applied: 0,
      notFound: 1,
      failed: 0,
      inFlight: 0,
      queued: 0,
    });
  });

  it('fairly alternates two providers when each advertises a fresher in-flight observation', async () => {
    const script = scriptedReconciler(['peerA', 'peerB', 'peerA', 'peerB']);
    const receiver = new Rfc64PublicCatalogReceiverV1(
      script.reconciler,
      { maxAttempts: 2, retryBackoffMs: 0 },
    );

    receiver.schedule(announcement(), 'peerA');
    await script.steps[0]!.started.promise;
    receiver.schedule(announcement(), 'peerB');
    script.steps[0]!.result.resolve('not-found');

    await script.steps[1]!.started.promise;
    receiver.schedule(announcement(), 'peerA');
    script.steps[1]!.result.resolve('not-found');

    await script.steps[2]!.started.promise;
    receiver.schedule(announcement(), 'peerB');
    script.steps[2]!.result.resolve('not-found');

    await script.steps[3]!.started.promise;
    script.steps[3]!.result.resolve('applied');
    await receiver.whenIdle();

    expect(script.peers).toEqual(['peerA', 'peerB', 'peerA', 'peerB']);
    expect(receiver.stats()).toMatchObject({
      scheduled: 4,
      dedupedInFlight: 3,
      applied: 1,
      notFound: 0,
      failed: 0,
    });
  });

  it('does not reset an exhausted provider budget when refreshed during an alternate fetch', async () => {
    const script = scriptedReconciler(['peerA', 'peerB']);
    const onError = vi.fn();
    const receiver = new Rfc64PublicCatalogReceiverV1(
      script.reconciler,
      { maxAttempts: 1, retryBackoffMs: 0, onError },
    );

    receiver.schedule(announcement(), 'peerA');
    await script.steps[0]!.started.promise;
    receiver.schedule(announcement(), 'peerB');
    script.steps[0]!.result.reject(new Error('peerA exhausted'));

    await script.steps[1]!.started.promise;
    for (let index = 0; index < 50; index += 1) {
      receiver.schedule(announcement(), 'peerA');
    }
    script.steps[1]!.result.resolve('not-found');
    await receiver.whenIdle();

    expect(script.peers).toEqual(['peerA', 'peerB']);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(receiver.stats()).toMatchObject({
      scheduled: 52,
      dedupedInFlight: 51,
      applied: 0,
      notFound: 0,
      failed: 1,
      inFlight: 0,
      queued: 0,
    });
  });

  it('close aborts an alternate fetch without starting a freshly revived provider', async () => {
    const script = scriptedReconciler(['peerA', 'peerB']);
    const receiver = new Rfc64PublicCatalogReceiverV1(
      script.reconciler,
      { maxAttempts: 3, retryBackoffMs: 0 },
    );

    receiver.schedule(announcement(), 'peerA');
    await script.steps[0]!.started.promise;
    receiver.schedule(announcement(), 'peerB');
    script.steps[0]!.result.resolve('not-found');

    await script.steps[1]!.started.promise;
    receiver.schedule(announcement(), 'peerA');
    const closing = receiver.close();
    expect(script.steps[1]!.signal?.aborted).toBe(true);
    script.steps[1]!.result.resolve('not-found');
    await closing;

    expect(script.peers).toEqual(['peerA', 'peerB']);
    expect(receiver.stats()).toMatchObject({ scheduled: 3, applied: 0, inFlight: 0, queued: 0 });
  });

  it('round-robins transient failures with a bounded per-provider budget', async () => {
    const peers: string[] = [];
    const firstAttempt = deferred<void>();
    const onError = vi.fn();
    const receiver = new Rfc64PublicCatalogReceiverV1(reconciler(async (peerId) => {
      peers.push(peerId);
      firstAttempt.resolve();
      throw new Error(`${peerId} transient`);
    }), { maxAttempts: 2, retryBackoffMs: 0, onError });
    receiver.schedule(announcement(), 'peerA');
    await firstAttempt.promise;
    receiver.schedule(announcement(), 'peerB');
    await receiver.whenIdle();
    expect(peers).toEqual(['peerA', 'peerB', 'peerA', 'peerB']);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(receiver.stats()).toMatchObject({ applied: 0, failed: 1 });
  });

  it('retains a same-peer announcement under a rotated accepted policy', async () => {
    const oldPolicy = `0x${'71'.repeat(32)}`;
    const newPolicy = `0x${'72'.repeat(32)}`;
    const firstResult = deferred<Rfc64PublicCatalogReconcileResultV1>();
    const seenPolicies: string[] = [];
    let calls = 0;
    const receiver = new Rfc64PublicCatalogReceiverV1(reconciler(async (_peerId, head) => {
      seenPolicies.push(head.policyDigest);
      calls += 1;
      if (calls === 1) return firstResult.promise;
      return 'applied';
    }), { maxAttempts: 1, retryBackoffMs: 0 });

    receiver.schedule(announcement({ policyDigest: oldPolicy as never }), 'peerA');
    receiver.schedule(announcement({ policyDigest: newPolicy as never }), 'peerA');
    firstResult.resolve('not-found');
    await receiver.whenIdle();

    expect(seenPolicies).toEqual([oldPolicy, newPolicy]);
    expect(receiver.stats()).toMatchObject({ applied: 1, notFound: 0, failed: 0 });
  });

  it('caps retained providers for one exact head', async () => {
    const gate = deferred<Rfc64PublicCatalogReconcileResultV1>();
    const receiver = new Rfc64PublicCatalogReceiverV1(
      reconciler(async () => gate.promise),
      { maxProvidersPerHead: 2 },
    );
    receiver.schedule(announcement(), 'peerA');
    receiver.schedule(announcement(), 'peerB');
    receiver.schedule(announcement(), 'peerC');
    expect(receiver.stats()).toMatchObject({ dedupedInFlight: 2, droppedProviders: 1 });
    gate.resolve('applied');
    await receiver.whenIdle();
  });

  it('skips an exact head only when durable applied state says complete', async () => {
    const reconcileHead = vi.fn(async () => 'applied' as const);
    const receiver = new Rfc64PublicCatalogReceiverV1(
      reconciler(reconcileHead, async () => true),
    );
    receiver.schedule(announcement(), 'peerA');
    await receiver.whenIdle();
    expect(reconcileHead).not.toHaveBeenCalled();
    expect(receiver.stats()).toMatchObject({ dedupedAlreadyApplied: 1, applied: 0 });
  });

  it('does not treat a not-found response as applied', async () => {
    const receiver = new Rfc64PublicCatalogReceiverV1(
      reconciler(async () => 'not-found'),
    );
    receiver.schedule(announcement(), 'peerA');
    await receiver.whenIdle();
    expect(receiver.stats()).toMatchObject({ notFound: 1, applied: 0 });
  });

  it('drops distinct heads when the bounded queue is full', async () => {
    const gate = deferred<Rfc64PublicCatalogReconcileResultV1>();
    const receiver = new Rfc64PublicCatalogReceiverV1(
      reconciler(async () => gate.promise),
      { maxConcurrent: 1, maxQueue: 1 },
    );
    receiver.schedule(headWith(`0x${'a1'.repeat(32)}`), 'peer');
    receiver.schedule(headWith(`0x${'a2'.repeat(32)}`), 'peer');
    receiver.schedule(headWith(`0x${'a3'.repeat(32)}`), 'peer');
    expect(receiver.stats().droppedQueueFull).toBe(1);
    gate.resolve('not-found');
    await receiver.whenIdle();
  });

  it('retries transient failures with bounded backoff', async () => {
    let attempts = 0;
    const receiver = new Rfc64PublicCatalogReceiverV1(reconciler(async () => {
      attempts += 1;
      if (attempts < 3) throw new Error('transient network failure');
      return 'applied';
    }), { maxAttempts: 3, retryBackoffMs: 1 });
    receiver.schedule(announcement(), 'peerA');
    await receiver.whenIdle();
    expect(attempts).toBe(3);
    expect(receiver.stats()).toMatchObject({ applied: 1, failed: 0 });
  });

  it('reports failure after maxAttempts', async () => {
    const onError = vi.fn();
    const receiver = new Rfc64PublicCatalogReceiverV1(
      reconciler(async () => { throw new Error('down'); }),
      { maxAttempts: 2, retryBackoffMs: 1, onError },
    );
    receiver.schedule(announcement(), 'peerA');
    await receiver.whenIdle();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(receiver.stats()).toMatchObject({ failed: 1, applied: 0 });
  });

  it('serializes different heads in one catalog scope', async () => {
    const firstGate = deferred<Rfc64PublicCatalogReconcileResultV1>();
    let active = 0;
    let maxActive = 0;
    let calls = 0;
    const receiver = new Rfc64PublicCatalogReceiverV1(reconciler(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      calls += 1;
      if (calls === 1) await firstGate.promise;
      active -= 1;
      return 'applied';
    }), { maxConcurrent: 4 });
    receiver.schedule(headWith(`0x${'a1'.repeat(32)}`), 'peerA');
    receiver.schedule(headWith(`0x${'a2'.repeat(32)}`), 'peerB');
    await Promise.resolve();
    expect(calls).toBe(1);
    firstGate.resolve('applied');
    await receiver.whenIdle();
    expect(calls).toBe(2);
    expect(maxActive).toBe(1);
  });

  it('allows independent catalog scopes to use the bounded pool concurrently', async () => {
    const gate = deferred<Rfc64PublicCatalogReconcileResultV1>();
    let active = 0;
    let maxActive = 0;
    const receiver = new Rfc64PublicCatalogReceiverV1(reconciler(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await gate.promise;
      active -= 1;
      return 'applied';
    }), { maxConcurrent: 2 });
    receiver.schedule(announcement(), 'peerA');
    receiver.schedule(announcement({ authorAddress: '0x3333333333333333333333333333333333333333' as never }), 'peerB');
    await Promise.resolve();
    await Promise.resolve();
    expect(maxActive).toBe(2);
    gate.resolve('applied');
    await receiver.whenIdle();
  });

  it('close awaits in-flight reconciliation, passes an abort signal, and rejects new work', async () => {
    const reconcileGate = deferred<Rfc64PublicCatalogReconcileResultV1>();
    let observedSignal: AbortSignal | undefined;
    const receiver = new Rfc64PublicCatalogReceiverV1(reconciler(async (_peer, _head, signal) => {
      observedSignal = signal;
      return reconcileGate.promise;
    }));
    receiver.schedule(announcement(), 'peerA');
    await Promise.resolve();
    const closing = receiver.close();
    expect(observedSignal?.aborted).toBe(true);
    reconcileGate.resolve('applied');
    await closing;
    receiver.schedule(headWith(`0x${'cc'.repeat(32)}`), 'peerA');
    expect(receiver.stats().scheduled).toBe(1);
  });
});
