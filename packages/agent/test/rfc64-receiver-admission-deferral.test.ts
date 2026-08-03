import { describe, expect, it } from 'vitest';

import { acquireFinalizedChainRead } from '@origintrail-official/dkg-chain';

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
/**
 * A stand-in refusal for the receiver's own unit tests.
 *
 * Deliberately NOT a hand-forged `concurrency-saturated` object: the chain
 * layer classifies contention by IDENTITY (a `WeakSet` of refusals it actually
 * threw), precisely so a look-alike error cannot be mistaken for lane
 * contention. These tests therefore inject the deferral policy — which is the
 * receiver's real contract, "defer when the policy says so" — and one test
 * below exercises the DEFAULT chain classifier end to end so the default wiring
 * is not left unproven.
 */
const FAKE_CONTENTION = Symbol('fake-contention');

function saturationError(): Error {
  const inner = Object.assign(new Error('Chain 20430 already has 1 finalized snapshot in flight'), {
    [FAKE_CONTENTION]: true,
  });
  // Nested: the receiver's policy must be asked about the whole chain, since a
  // real refusal reaches it wrapped by the precommit.
  return Object.assign(new Error('RFC-64 finalized VM precommit rejected'), { cause: inner });
}

/** Mirrors how the default policy walks `cause`, over the test's own marker. */
function isFakeContention(error: unknown): boolean {
  for (let cause: unknown = error, depth = 0;
    cause !== undefined && cause !== null && depth < 8;
    depth += 1) {
    if (typeof cause === 'object' && (cause as Record<symbol, unknown>)[FAKE_CONTENTION] === true) {
      return true;
    }
    cause = (cause as { cause?: unknown }).cause;
  }
  return false;
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

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((fulfill) => {
    resolve = fulfill;
  });
  return { promise, resolve };
}

async function settle(receiver: Rfc64PublicCatalogReceiverV1, ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
  await receiver.whenIdle?.();
}

describe('RFC-64 receiver defers on finalized chain-lane contention', () => {
  it('does not fail the head, and applies it after the lane frees', async () => {
    const { reconciler, calls } = contendingReconciler(2);
    const receiver = new Rfc64PublicCatalogReceiverV1(reconciler as never, {
      isDeferrableError: isFakeContention,
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
      isDeferrableError: isFakeContention,
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
      isDeferrableError: isFakeContention,
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
      { isDeferrableError: isFakeContention, admissionDeferralMs: 5, retryBackoffMs: 1 },
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
      isDeferrableError: isFakeContention,
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
      isDeferrableError: isFakeContention,
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
      isDeferrableError: isFakeContention,
      admissionDeferralMs: 10_000,
    });
    receiver.schedule(announcement('0xee'), 'peer-a');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(receiver.stats().admissionDeferred).toBeGreaterThanOrEqual(1);
    // Must resolve promptly; a retained 10s timer would hang this.
    await receiver.close();
    expect(receiver.stats().queued).toBe(0);
  });
  it('DEFAULT policy defers a REAL chain refusal, and only a real one', async () => {
    // Proves the default wiring, which the injected-policy tests above cannot:
    // the receiver with no `isDeferrableError` must defer on a refusal that
    // genuinely came out of `acquireFinalizedChainRead`, and must NOT defer on
    // a look-alike carrying the same `concurrency-saturated` code.
    // No registry reset needed: this test acquires and releases the lane within
    // itself, and `…ForTests` is deliberately not part of the package's public
    // surface.
    const gate = deferred<void>();
    const held = acquireFinalizedChainRead(
      { chainId: '20430', owner: 'rfc64' },
      () => gate.promise,
      (active, holder) => Object.assign(
        new Error(`Chain 20430 already has ${active} in flight (held by ${holder})`),
        { code: 'concurrency-saturated' },
      ),
    );
    await Promise.resolve();

    // Capture a genuine refusal, wrapped the way the precommit wraps it.
    let realRefusal: unknown;
    try {
      await acquireFinalizedChainRead(
        { chainId: '20430', owner: 'w2-page' },
        async () => 'x',
        (active) => Object.assign(new Error(`busy:${active}`), { code: 'concurrency-saturated' }),
      );
    } catch (error) {
      realRefusal = Object.assign(new Error('precommit rejected'), { cause: error });
    }
    gate.resolve();
    await held;

    let thrown = 0;
    const receiver = new Rfc64PublicCatalogReceiverV1(
      {
        isHeadApplied: async () => false,
        reconcileHead: async () => {
          thrown += 1;
          if (thrown === 1) throw realRefusal;
          return 'applied' as const;
        },
      } as never,
      { admissionDeferralMs: 10 }, // no injected policy — the default is under test
    );
    receiver.schedule(announcement('0xf9'), 'peer-a');
    await settle(receiver, 400);
    expect(receiver.stats().applied).toBe(1);
    expect(receiver.stats().admissionDeferred).toBe(1);
    expect(receiver.stats().failed).toBe(0);
    await receiver.close();

    // The look-alike must fail fast under the same default policy.
    const lookAlike = new Rfc64PublicCatalogReceiverV1(
      {
        isHeadApplied: async () => false,
        reconcileHead: async () => {
          throw Object.assign(new Error('nice try'), { code: 'concurrency-saturated' });
        },
      } as never,
      { admissionDeferralMs: 10, retryBackoffMs: 1 },
    );
    lookAlike.schedule(announcement('0xfa'), 'peer-a');
    await settle(lookAlike, 300);
    expect(lookAlike.stats().failed).toBe(1);
    expect(lookAlike.stats().admissionDeferred).toBe(0);
    await lookAlike.close();
  });
});
