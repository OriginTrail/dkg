import { describe, expect, it, vi } from 'vitest';
import { StorePriorityScheduler } from '../src/store-priority-scheduler.js';

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

describe('one ordinary-slot store fairness', () => {
  it.each([
    { maxConcurrent: 1, ackReservedSlots: 0 },
    { maxConcurrent: 2, ackReservedSlots: 1 },
  ])('bounds contended normal dispatches with $maxConcurrent total slots', async (capacity) => {
    const scheduler = new StorePriorityScheduler({
      ...capacity,
      healthReservedSlots: 0,
      backgroundReservedSlots: 1,
    });
    const blocker = gate();
    const ackGate = gate();
    const events: string[] = [];
    let activeOrdinary = 0;
    let peakOrdinary = 0;
    let peakTotal = 0;
    const observeCapacity = () => {
      const s = scheduler.snapshot;
      peakTotal = Math.max(peakTotal, s.ackInflight + s.healthInflight + s.normalInflight + s.backgroundInflight);
    };
    const initial = scheduler.run('normal', 'fairness.blocker', () => blocker.promise);
    const ack = capacity.ackReservedSlots === 1
      ? scheduler.run('ack', 'fairness.ack', async () => { observeCapacity(); await ackGate.promise; })
      : Promise.resolve();
    const work = (name: string) => async () => {
      activeOrdinary += 1;
      peakOrdinary = Math.max(peakOrdinary, activeOrdinary);
      observeCapacity();
      events.push(name);
      await Promise.resolve();
      activeOrdinary -= 1;
      return name;
    };
    const background = [0, 1].map((i) => scheduler.run('background', 'fairness.background', work('B' + i)));
    const normal = Array.from({ length: 17 }, (_, i) => scheduler.run('normal', 'fairness.normal', work('N' + i)));
    blocker.release();
    try {
      await Promise.all([initial, ...normal, ...background]);
      expect(events).toEqual([
        ...Array.from({ length: 8 }, (_, i) => 'N' + i), 'B0',
        ...Array.from({ length: 8 }, (_, i) => 'N' + (i + 8)), 'B1', 'N16',
      ]);
      expect(peakOrdinary).toBe(1);
      expect(peakTotal).toBe(capacity.maxConcurrent);
      expect(scheduler.snapshot).toMatchObject({ normalReservedSlots: 0, backgroundReservedSlots: 0 });
    } finally {
      ackGate.release();
      await ack;
    }
  });

  it('keeps ACK and health ahead of an ordinary contention burst', async () => {
    const scheduler = new StorePriorityScheduler({
      maxConcurrent: 1, ackReservedSlots: 0, healthReservedSlots: 0, backgroundReservedSlots: 1,
    });
    const blocker = gate();
    const initial = scheduler.run('normal', 'fairness.blocker', () => blocker.promise);
    const events: string[] = [];
    const record = (name: string) => async () => { events.push(name); };
    const background = scheduler.run('background', 'fairness.background', record('B'));
    const normal = Array.from({ length: 9 }, (_, i) => scheduler.run('normal', 'fairness.normal', record('N' + i)));
    const health = scheduler.run('health', 'fairness.health', record('H'));
    const ack = scheduler.run('ack', 'fairness.ack', record('A'));
    blocker.release();
    await Promise.all([initial, background, ...normal, health, ack]);
    expect(events).toEqual(['A', 'H', ...Array.from({ length: 8 }, (_, i) => 'N' + i), 'B', 'N8']);
  });

  it('keeps explicit zero background reservation in strict priority order', async () => {
    const scheduler = new StorePriorityScheduler({
      maxConcurrent: 2, ackReservedSlots: 1, healthReservedSlots: 0, backgroundReservedSlots: 0,
    });
    const blocker = gate();
    const initial = scheduler.run('normal', 'fairness.blocker', () => blocker.promise);
    const events: string[] = [];
    const background = scheduler.run('background', 'fairness.background', async () => { events.push('B'); });
    const normal = Array.from({ length: 17 }, (_, i) => scheduler.run('normal', 'fairness.normal', async () => { events.push('N' + i); }));
    blocker.release();
    await Promise.all([initial, background, ...normal]);
    expect(events).toEqual([...Array.from({ length: 17 }, (_, i) => 'N' + i), 'B']);
  });

  it.each(['abort', 'deadline'] as const)('starts a fresh burst after the last background waiter leaves by %s', async (reason) => {
    vi.useFakeTimers();
    const scheduler = new StorePriorityScheduler({
      maxConcurrent: 2, ackReservedSlots: 1, backgroundReservedSlots: 1, queueWaitTimeoutMs: 1_000,
    });
    const blocker = gate();
    const seventh = gate();
    const seventhStarted = gate();
    const controller = new AbortController();
    const events: string[] = [];
    const cancelledWork = vi.fn(async () => undefined);
    const initial = scheduler.run('normal', 'fairness.blocker', () => blocker.promise);
    const cancelled = scheduler.run('background', 'fairness.removed', cancelledWork, controller.signal)
      .catch((error: unknown) => error);
    const firstBurst = Array.from({ length: 7 }, (_, i) => scheduler.run('normal', 'fairness.first', async () => {
      if (i === 6) { seventhStarted.release(); await seventh.promise; }
    }));
    try {
      blocker.release();
      await seventhStarted.promise;
      if (reason === 'abort') controller.abort(new Error('cancel background'));
      else await vi.advanceTimersByTimeAsync(1_000);
      const error = await cancelled;
      expect(error).toBeInstanceOf(Error);
      if (reason === 'deadline') expect(error).toMatchObject({ reason: 'queue_wait_timeout', outcome: 'not_started' });
      expect(cancelledWork).not.toHaveBeenCalled();
      expect(scheduler.snapshot.backgroundQueued).toBe(0);
      const background = scheduler.run('background', 'fairness.fresh', async () => { events.push('B'); });
      const normal = Array.from({ length: 9 }, (_, i) => scheduler.run('normal', 'fairness.next', async () => { events.push('N' + i); }));
      seventh.release();
      await Promise.all([initial, ...firstBurst, background, ...normal]);
      expect(events).toEqual([...Array.from({ length: 8 }, (_, i) => 'N' + i), 'B', 'N8']);
    } finally {
      blocker.release();
      seventh.release();
      vi.useRealTimers();
    }
  });

  it('counts throwing and rejected callbacks only when dispatched, excluding cancelled queued normals', async () => {
    const scheduler = new StorePriorityScheduler({ maxConcurrent: 2, ackReservedSlots: 1, backgroundReservedSlots: 1 });
    const blocker = gate();
    const initial = scheduler.run('normal', 'fairness.blocker', () => blocker.promise);
    const events: string[] = [];
    const background = scheduler.run('background', 'fairness.background', async () => { events.push('B'); });
    const controller = new AbortController();
    const cancelledWork = vi.fn(async () => undefined);
    const cancelled = scheduler.run('normal', 'fairness.cancelled', cancelledWork, controller.signal).catch((error: unknown) => error);
    controller.abort(new Error('cancel normal'));
    const failure = new Error('operation failure');
    const normal = Array.from({ length: 9 }, (_, i) => scheduler.run('normal', 'fairness.normal', () => {
      events.push('N' + i);
      if (i === 0) throw failure;
      return i === 1 ? Promise.reject(failure) : Promise.resolve(i);
    }));
    const settled = Promise.allSettled(normal);
    blocker.release();
    const results = await settled;
    await Promise.all([initial, background, cancelled]);
    expect(results.filter((result) => result.status === 'rejected')).toEqual([
      { status: 'rejected', reason: failure }, { status: 'rejected', reason: failure },
    ]);
    expect(cancelledWork).not.toHaveBeenCalled();
    expect(events).toEqual([...Array.from({ length: 8 }, (_, i) => 'N' + i), 'B', 'N8']);
  });

  it('preserves the background reservation when two ordinary slots are available', async () => {
    const scheduler = new StorePriorityScheduler({
      maxConcurrent: 4, ackReservedSlots: 1, healthReservedSlots: 1, backgroundReservedSlots: 1,
    });
    const first = gate();
    const second = gate();
    const backgroundGate = gate();
    const backgroundStarted = gate();
    const events: string[] = [];
    const blockers = [
      scheduler.run('normal', 'fairness.blocker1', () => first.promise),
      scheduler.run('normal', 'fairness.blocker2', () => second.promise),
    ];
    const background = scheduler.run('background', 'fairness.background', async () => {
      events.push('B'); backgroundStarted.release(); await backgroundGate.promise;
    });
    const normal = scheduler.run('normal', 'fairness.normal', async () => { events.push('N'); });
    first.release();
    try {
      await backgroundStarted.promise;
      expect(events).toEqual(['B']);
      expect(scheduler.snapshot).toMatchObject({ normalInflight: 1, backgroundInflight: 1, normalQueued: 1 });
    } finally {
      second.release();
      backgroundGate.release();
      await Promise.all([...blockers, background, normal]);
    }
    expect(events).toEqual(['B', 'N']);
  });
});
