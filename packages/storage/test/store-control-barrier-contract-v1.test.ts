import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  StorePriorityScheduler,
  type StoreQueuedAdmissionV1,
} from '../src/store-priority-scheduler.js';
import { createStoreControlBarrierKeyV1 } from '../src/store-control-barrier-key-v1.js';

/**
 * The scheduler/coordinator boundary, asserted through the PUBLIC scheduler.
 *
 * The control-barrier lifecycle moved out of `StorePriorityScheduler` into a
 * coordinator wired back through callbacks. That is a concurrency path where a
 * wiring mistake is invisible to reading the new class alone: it would change
 * WHEN a barrier starts, WHETHER the seal is released, or what the metrics say,
 * and every existing test would still pass because they exercise the scheduler
 * from further away.
 *
 * So these drive the scheduler exactly as production does — `run()` for
 * ordinary work and the public barrier APIs for transitions — and assert the
 * properties the extraction could have broken. Nothing here reaches into the
 * coordinator: if the callback wiring is wrong, the observable behaviour is
 * wrong, which is the only thing worth pinning.
 */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** A promise plus the handle to settle it, so a test can hold work in flight. */
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
};

const queuedAdmission = (storeId: object): StoreQueuedAdmissionV1 => ({
  mode: 'shared',
  storeId,
  generation: 'gen-1',
});

describe('control barrier contract survives the coordinator extraction', () => {
  it('clears cached tagged inflight before a later untagged-only barrier', async () => {
    const scheduler = new StorePriorityScheduler({ maxConcurrent: 8 });
    const storeId = {};

    await scheduler.run('normal', 'tagged.complete', async () => undefined, undefined, {
      mode: 'shared',
      storeId,
      generation: 'gen-1',
    });
    expect(scheduler.snapshot.admissionTaggedInflight).toBe(0);

    const untagged = deferred<void>();
    const untaggedRun = scheduler.run('normal', 'untagged.blocker', () => untagged.promise);
    await settle();

    let started = false;
    const barrier = scheduler.runControlBarrier<void>(
      storeId,
      'probe.effect',
      async () => {
        started = true;
      },
    );
    expectTypeOf(barrier).toEqualTypeOf<Promise<void>>();
    await settle();
    expect(started).toBe(false);

    untagged.resolve();
    await untaggedRun;
    await barrier;
    expect(started).toBe(true);
  });

  it('waits for BOTH untagged and same-store tagged work before starting', async () => {
    // The reviewer's scenario: one untagged run and one tagged run for the same
    // store, both in flight when the barrier is enqueued. The transition must
    // not start until both drain — the quiescence gate reads two different
    // counters, and a wiring mistake could easily consult one.
    const scheduler = new StorePriorityScheduler({ maxConcurrent: 8 });
    const storeId = {};

    const untagged = deferred<void>();
    const tagged = deferred<void>();
    const untaggedRun = scheduler.run('normal', 'untagged', () => untagged.promise);
    const taggedRun = scheduler.run(
      'normal',
      'tagged',
      () => tagged.promise,
      undefined,
      queuedAdmission(storeId),
    );
    await settle();

    let started = false;
    const barrier = scheduler.runControlBarrier(storeId, 'probe.transition', async () => {
      started = true;
    });
    await settle();
    expect(started).toBe(false);

    untagged.resolve();
    await untaggedRun;
    await settle();
    expect(started).toBe(false); // tagged work for this store is still in flight

    tagged.resolve();
    await taggedRun;
    await settle();

    await barrier;
    expect(started).toBe(true);
  });

  it('releases the seal so ordinary work resumes after the transition', async () => {
    // If the seal were not committed on the coordinator's completion path, the
    // store would be sealed forever and this held run would never execute.
    const scheduler = new StorePriorityScheduler({ maxConcurrent: 8 });
    const storeId = {};

    const transitionGate = deferred<void>();
    const barrier = scheduler.runControlBarrier(
      storeId,
      'probe.transition',
      () => transitionGate.promise,
    );
    await settle();

    let ran = false;
    const held = scheduler.run('normal', 'after', async () => {
      ran = true;
    }, undefined, queuedAdmission(storeId));
    await settle();
    expect(ran).toBe(false); // sealed while the transition owns the store

    transitionGate.resolve();
    await barrier;
    await held;

    expect(ran).toBe(true);
  });

  it('coalesces by (storeId, purpose) and reports it in the snapshot', async () => {
    // Coalescing is the coordinator's own invariant, and the metric proving it
    // now crosses the extraction boundary.
    const scheduler = new StorePriorityScheduler({ maxConcurrent: 8 });
    const storeId = {};
    const gate = deferred<string>();

    let invocations = 0;
    const first = scheduler.runControlBarrier(storeId, 'same.purpose', () => {
      invocations += 1;
      return gate.promise;
    });
    const second = scheduler.runControlBarrier(storeId, 'same.purpose', () => {
      invocations += 1;
      return Promise.resolve('never');
    });

    gate.resolve('once');
    expect(await first).toBe('once');
    expect(await second).toBe('once');
    expect(invocations).toBe(1);
    expect(scheduler.snapshot.barrierCoalesced).toBe(1);
  });

  it('keeps an empty legacy purpose source-compatible', async () => {
    const scheduler = new StorePriorityScheduler({ maxConcurrent: 8 });
    await expect(
      scheduler.runControlBarrier({}, '', async () => 'unnamed'),
    ).resolves.toBe('unnamed');
  });

  it('keeps legacy coalescing through a transition-phase timeout', async () => {
    const scheduler = new StorePriorityScheduler({ maxConcurrent: 8 });
    const storeId = {};
    const physical = deferred<void>();
    let duplicateStarted = false;

    const first = scheduler.runControlBarrier(
      storeId,
      'restart',
      () => physical.promise,
      undefined,
      10,
    );
    await expect(first).rejects.toMatchObject({ phase: 'transition' });

    const duplicate = scheduler.runControlBarrier(storeId, 'restart', async () => {
      duplicateStarted = true;
    });
    await expect(duplicate).rejects.toMatchObject({ phase: 'transition' });
    expect(duplicateStarted).toBe(false);
    expect(scheduler.snapshot.barrierCoalesced).toBe(1);

    physical.resolve();
    await settle();
  });

  it('coalesces typed barriers only by key identity and preserves each result type', async () => {
    const scheduler = new StorePriorityScheduler({ maxConcurrent: 8 });
    const storeId = {};
    const resultKey = createStoreControlBarrierKeyV1<{ epoch: string }>('same.purpose');
    const effectKey = createStoreControlBarrierKeyV1<void>('same.purpose');
    const gate = deferred<{ epoch: string }>();
    let effectStarted = false;

    const first = scheduler.runTypedControlBarrier(storeId, resultKey, () => gate.promise);
    const coalesced = scheduler.runTypedControlBarrier(storeId, resultKey, async () => ({
      epoch: 'never',
    }));
    const distinct = scheduler.runTypedControlBarrier(storeId, effectKey, async () => {
      effectStarted = true;
    });

    await settle();
    expect(effectStarted).toBe(false);
    gate.resolve({ epoch: '7' });
    expect(await first).toEqual({ epoch: '7' });
    expect(await coalesced).toEqual({ epoch: '7' });
    await distinct;
    expect(effectStarted).toBe(true);
    expect(scheduler.snapshot.barrierCoalesced).toBe(1);
  });

  it('does not coalesce one typed key across different stores', async () => {
    const scheduler = new StorePriorityScheduler({ maxConcurrent: 8 });
    const key = createStoreControlBarrierKeyV1<string>('shared.typed.key');
    const firstGate = deferred<string>();
    let secondStarted = false;

    const first = scheduler.runTypedControlBarrier({}, key, () => firstGate.promise);
    const second = scheduler.runTypedControlBarrier({}, key, async () => {
      secondStarted = true;
      return 'store-b';
    });

    await settle();
    expect(secondStarted).toBe(false); // one global controller slot, not coalescing
    expect(scheduler.snapshot.barrierCoalesced).toBe(0);

    firstGate.resolve('store-a');
    await expect(first).resolves.toBe('store-a');
    await expect(second).resolves.toBe('store-b');
    expect(secondStarted).toBe(true);
  });

  it('a transition rejection propagates and still unseals the store', async () => {
    // The cleanup path runs in a `finally`, so a failed transition must not
    // leave the store sealed — the failure mode that would freeze a lane.
    const scheduler = new StorePriorityScheduler({ maxConcurrent: 8 });
    const storeId = {};

    await expect(
      scheduler.runControlBarrier(storeId, 'failing.transition', async () => {
        throw new Error('transition failed');
      }),
    ).rejects.toThrow('transition failed');

    let ran = false;
    await scheduler.run('normal', 'after', async () => {
      ran = true;
    }, undefined, queuedAdmission(storeId));

    expect(ran).toBe(true);
  });
});

describe('typed barrier keys close the generic result channel (#2179)', () => {
  // The retired contract's defect was that `T` was chosen per CALL while
  // coalescing was keyed per runtime STRING, so the type system had no say in
  // which caller's `T` a coalesced promise satisfied. These are type-level
  // pins that the replacement actually closes that channel: `T` is chosen per
  // KEY, once, and no call site can renegotiate it.
  it('binds the result type to the key, not the call site', async () => {
    const scheduler = new StorePriorityScheduler({ maxConcurrent: 1 });
    const epochKey = createStoreControlBarrierKeyV1<{ epoch: string }>('typed.epoch');
    const effectKey = createStoreControlBarrierKeyV1<void>('typed.effect');

    const typed = scheduler.runTypedControlBarrier({}, epochKey, async () => ({ epoch: '1' }));
    expectTypeOf(typed).toEqualTypeOf<Promise<{ epoch: string }>>();
    expect(await typed).toEqual({ epoch: '1' });

    // A void key is an effect barrier BY TYPE: its promise carries no data, so
    // it cannot be used as a typed side channel between coalescing callers.
    const effect = scheduler.runTypedControlBarrier({}, effectKey, async () => {});
    expectTypeOf(effect).toEqualTypeOf<Promise<void>>();
    await effect;

  });

  // The compile-only NEGATIVE contracts (smuggled result types, forged keys,
  // the coordinator's structural no-string-member pin) live in
  // store-control-barrier-contract-v1.typetest.ts, compiled by the
  // typecheck:type-contracts lane and never executed — this file stays
  // runtime-only.

  it('rejects an empty purpose at key creation', () => {
    expect(() => createStoreControlBarrierKeyV1('')).toThrow(/must not be empty/);
  });
});
