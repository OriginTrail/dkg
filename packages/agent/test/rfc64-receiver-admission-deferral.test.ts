import { describe, expect, it } from 'vitest';

import { Rfc64PublicCatalogReceiverV1 } from '../src/rfc64/public-catalog-receiver-v1.js';
import type { Rfc64PublicCatalogHeadAnnouncementV1 } from '../src/rfc64/public-catalog-transport-v1.js';

/**
 * Regression suite for the contention lifecycle the merge-readiness review
 * flagged (P1-3).
 *
 * Routing RFC64 through the process-wide one-per-chain finalized-read permit is
 * the right strain bound, but the permit is nonqueueing: a legitimate pinned
 * scan for one context graph can hold it for up to the snapshot deadline (60s),
 * while a second CG's receiver burned its three generic provider attempts and
 * exponential backoff in about 1.75 seconds, marked the task FAILED, and deleted
 * its pending key. The head was then only reconsidered if some later
 * announcement or explicit pull happened to arrive — a valid finalized head lost
 * to ordinary contention.
 *
 * Contention is not an error about the head or the provider, so it must not
 * consume an attempt, must not hold the receiver slot or the per-scope semantic
 * lock while waiting, and must leave the task pending.
 */
const CHAIN_SATURATED = 'concurrency-saturated';

function saturationError(): Error {
  // Shaped like the chain layer's typed refusal, including nesting: the
  // classifier must walk `cause`, not match on message text.
  const inner = Object.assign(new Error('Chain 20430 already has 1 finalized snapshot in flight'), {
    code: CHAIN_SATURATED,
  });
  return Object.assign(new Error('RFC-64 finalized VM precommit rejected'), { cause: inner });
}

function announcement(headDigest: string): Rfc64PublicCatalogHeadAnnouncementV1 {
  return {
    networkId: 'test-network',
    contextGraphId: '0x1111111111111111111111111111111111111111/catalog',
    subGraphName: 'catalog',
    authorDid: 'did:dkg:agent:0x2222222222222222222222222222222222222222',
    headDigest,
    headSequence: '1',
  } as unknown as Rfc64PublicCatalogHeadAnnouncementV1;
}

/** A reconciler that reports lane contention `saturateTimes` times, then applies. */
function contendingReconciler(saturateTimes: number) {
  const calls = { reconcile: 0, isHeadApplied: 0 };
  return {
    calls,
    reconciler: {
      isHeadApplied: async () => {
        calls.isHeadApplied += 1;
        return false;
      },
      reconcileHead: async () => {
        calls.reconcile += 1;
        if (calls.reconcile <= saturateTimes) throw saturationError();
        return 'applied' as const;
      },
    },
  };
}

async function settle(receiver: Rfc64PublicCatalogReceiverV1, ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
  await receiver.whenIdle?.();
}

describe('RFC-64 receiver defers on finalized chain-lane contention', () => {
  it('does not fail the head, and applies it after the lane frees', async () => {
    const { reconciler, calls } = contendingReconciler(2);
    const receiver = new Rfc64PublicCatalogReceiverV1(reconciler as never, {
      admissionDeferralMs: 10,
      retryBackoffMs: 1,
    });

    receiver.schedule(announcement('0xaa'), 'peer-a');
    await settle(receiver, 300);

    const stats = receiver.stats();
    // The head is APPLIED, not failed — the whole point.
    expect(stats.applied).toBe(1);
    expect(stats.failed).toBe(0);
    // …and it took real deferrals to get there, so the assertion is not vacuous.
    expect(stats.admissionDeferred).toBeGreaterThanOrEqual(2);
    // It was retried WITHOUT a second `schedule()` call.
    expect(stats.scheduled).toBe(1);
    expect(calls.reconcile).toBe(3);
    await receiver.close();
  });

  it('releases the concurrency slot and scope lock while waiting', async () => {
    // A deferral that kept the slot would block every other head on the node,
    // converting one busy chain lane into a stalled receiver.
    const { reconciler } = contendingReconciler(3);
    const receiver = new Rfc64PublicCatalogReceiverV1(reconciler as never, {
      admissionDeferralMs: 40,
      maxConcurrent: 1,
    });
    receiver.schedule(announcement('0xbb'), 'peer-a');

    await new Promise((resolve) => setTimeout(resolve, 20));
    const midFlight = receiver.stats();
    expect(midFlight.inFlight).toBe(0);
    expect(midFlight.admissionDeferred).toBeGreaterThanOrEqual(1);

    await settle(receiver, 400);
    expect(receiver.stats().applied).toBe(1);
    await receiver.close();
  });

  it('gives up in bounded time rather than looping on a wedged lane', async () => {
    // A permanently busy lane must degrade into an ordinary failure, not spin.
    const { reconciler } = contendingReconciler(Number.MAX_SAFE_INTEGER);
    const receiver = new Rfc64PublicCatalogReceiverV1(reconciler as never, {
      admissionDeferralMs: 1,
      maxAdmissionDeferrals: 3,
    });
    receiver.schedule(announcement('0xcc'), 'peer-a');
    await settle(receiver, 400);

    const stats = receiver.stats();
    expect(stats.failed).toBe(1);
    expect(stats.applied).toBe(0);
    expect(stats.admissionDeferred).toBe(4); // 3 allowed + the one that gave up
    await receiver.close();
  });

  it('still fails fast on an ordinary error, which must NOT be deferred', async () => {
    // The classifier must be narrow. A generic failure keeps the pre-existing
    // three-attempt behaviour; widening it would hide real breakage as patience.
    const receiver = new Rfc64PublicCatalogReceiverV1(
      {
        isHeadApplied: async () => false,
        reconcileHead: async () => {
          throw new Error('provider exploded');
        },
      } as never,
      { admissionDeferralMs: 5, retryBackoffMs: 1 },
    );
    receiver.schedule(announcement('0xdd'), 'peer-a');
    await settle(receiver, 300);

    const stats = receiver.stats();
    expect(stats.failed).toBe(1);
    expect(stats.admissionDeferred).toBe(0);
    await receiver.close();
  });

  it('does NOT report idle while a head is waiting on the chain lane', async () => {
    // The deferral releases the slot and the queue entry by design, so without
    // an explicit deferred state `#isIdle()` saw `active=0, queue=0` and
    // `whenIdle()` resolved during the retry window. A caller draining the
    // receiver (`synchronizeCurrentCatalogHead`) would then conclude scheduling
    // had settled before the head was applied, staged, not-found or failed.
    const { reconciler } = contendingReconciler(1);
    const receiver = new Rfc64PublicCatalogReceiverV1(reconciler as never, {
      admissionDeferralMs: 300,
    });
    receiver.schedule(announcement('0xf1'), 'peer-a');

    // Wait until the task is genuinely in the deferred state.
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && receiver.stats().deferred === 0) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const waiting = receiver.stats();
    expect(waiting.deferred).toBe(1);
    expect(waiting.inFlight).toBe(0);
    expect(waiting.queued).toBe(0);

    let idleResolved = false;
    const idle = receiver.whenIdle().then(() => {
      idleResolved = true;
    });
    // Long enough to catch an immediate resolve, short of the 300ms retry.
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(idleResolved).toBe(false);

    await idle;
    // Idle only after the deferred work reached a terminal outcome.
    expect(receiver.stats().applied).toBe(1);
    expect(receiver.stats().deferred).toBe(0);
    await receiver.close();
  });

  it('keeps the pending key while deferred, so a duplicate does not fork a second writer', async () => {
    // The deferral moved `pendingByKey.delete` out of the `finally` path. If a
    // regression moved it back, the single-announcement tests above would still
    // pass — but a re-announcement during the detached retry window would miss
    // the existing task and create a second semantic writer for one head.
    const { reconciler, calls } = contendingReconciler(1);
    const receiver = new Rfc64PublicCatalogReceiverV1(reconciler as never, {
      admissionDeferralMs: 250,
    });
    receiver.schedule(announcement('0xf2'), 'peer-a');

    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && receiver.stats().deferred === 0) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(receiver.stats().inFlight).toBe(0);

    // Same head, different peer, while the retry timer is pending.
    receiver.schedule(announcement('0xf2'), 'peer-b');
    expect(receiver.stats().dedupedInFlight).toBe(1);

    await settle(receiver, 600);
    const stats = receiver.stats();
    expect(stats.applied).toBe(1);
    expect(stats.failed).toBe(0);
    // One writer, not two: the second announcement contributed a provider.
    expect(calls.reconcile).toBe(2);
    await receiver.close();
  });

  it('drops pending deferrals on close without leaking a timer', async () => {
    const { reconciler } = contendingReconciler(Number.MAX_SAFE_INTEGER);
    const receiver = new Rfc64PublicCatalogReceiverV1(reconciler as never, {
      admissionDeferralMs: 10_000,
    });
    receiver.schedule(announcement('0xee'), 'peer-a');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(receiver.stats().admissionDeferred).toBeGreaterThanOrEqual(1);
    // Must resolve promptly; a retained 10s timer would hang this.
    await receiver.close();
    expect(receiver.stats().queued).toBe(0);
  });
});
