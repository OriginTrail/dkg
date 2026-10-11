import { describe, expect, it, vi } from 'vitest';
import { drainsWithin, KeyedPersistScheduler } from '../src/keyed-persist-scheduler.js';
import {
  ContextGraphMembershipPersistQueueClosedError,
  ContextGraphMembershipPersistQueueFullError,
  ContextGraphMembershipPersistScheduler,
} from '../src/context-graph-membership-persist-scheduler.js';

function gate(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => { open = resolve; });
  return { promise, open };
}

/** Resolves 'pending' if `promise` has not settled after a few macrotasks. */
async function settledWithin(promise: Promise<unknown>, ms = 25): Promise<'settled' | 'pending'> {
  return Promise.race([
    promise.then(() => 'settled' as const, () => 'settled' as const),
    new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), ms)),
  ]);
}

describe('KeyedPersistScheduler', () => {
  const build = (maxLanes = 8, maxPendingPerLane = 4) => new KeyedPersistScheduler({
    label: 'test persistence',
    maxLanes,
    maxPendingPerLane,
    queueFullError: (message) => Object.assign(new Error(message), { code: 'TEST_FULL' }),
    queueClosedError: () => Object.assign(new Error('closed'), { code: 'TEST_CLOSED' }),
  });

  it('rejects non-positive bounds with the label in the message', () => {
    const options = {
      label: 'test persistence',
      maxLanes: 1,
      maxPendingPerLane: 1,
      queueFullError: (message: string) => new Error(message),
      queueClosedError: () => new Error('closed'),
    };
    expect(() => new KeyedPersistScheduler({ ...options, maxLanes: 0 }))
      .toThrow('Test persistence maxLanes must be a positive safe integer');
    expect(() => new KeyedPersistScheduler({ ...options, maxPendingPerLane: 1.5 }))
      .toThrow('Test persistence maxPendingPerLane must be a positive safe integer');
  });

  it('serializes a key, overlaps different keys, and lets a task await another key', async () => {
    const scheduler = build();
    const order: string[] = [];
    const firstA = gate();
    const a1 = scheduler.enqueue('a', async () => { order.push('a1:start'); await firstA.promise; order.push('a1:end'); });
    const a2 = scheduler.enqueue('a', async () => { order.push('a2'); }, { strict: true });
    // A different key makes progress while 'a' is held, and a task on one key
    // can enqueue and await a task on another without deadlocking.
    const b = scheduler.enqueue('b', async () => {
      order.push('b:start');
      await scheduler.enqueue('c', async () => { order.push('c'); });
      order.push('b:end');
    });
    await b;
    expect(order).toEqual(['a1:start', 'b:start', 'c', 'b:end']);
    expect(scheduler.hasLane('a')).toBe(true);
    expect(scheduler.hasLane('b')).toBe(false);

    firstA.open();
    await Promise.all([a1, a2]);
    expect(order.slice(4)).toEqual(['a1:end', 'a2']);
  });

  it('cannot finish a task that awaits another task on its own key', async () => {
    // Why the membership and subscription lanes must not share a key space:
    // a join approval awaits a subscription write from inside a membership
    // write, and a shared key would make that nesting wait on itself.
    const scheduler = build();
    const nested = scheduler.enqueue('same', () => scheduler.enqueue('same', async () => undefined));
    expect(await settledWithin(nested)).toBe('pending');
  });

  it('keeps draining after a rejected write and rejects only that caller', async () => {
    const scheduler = build();
    const boom = new Error('store down');
    const failing = scheduler.enqueue('k', async () => { throw boom; }, { strict: true });
    const next = scheduler.enqueue('k', async () => undefined, { strict: true });
    await expect(failing).rejects.toBe(boom);
    await expect(next).resolves.toBeUndefined();
    expect(scheduler.status()).toEqual({ closed: false, lanes: 0, active: 0, pending: 0 });
  });

  it('rejects a synchronous throw from a write without stalling the lane', async () => {
    const scheduler = build();
    const boom = new Error('sync');
    const failing = scheduler.enqueue('k', () => { throw boom; }, { strict: true });
    const next = scheduler.enqueue('k', async () => undefined, { strict: true });
    await expect(failing).rejects.toBe(boom);
    await expect(next).resolves.toBeUndefined();
  });

  it('reports lane, active and pending counts and clears hasLane when idle', async () => {
    const scheduler = build();
    const held = gate();
    expect(scheduler.hasLane('k')).toBe(false);
    const active = scheduler.enqueue('k', () => held.promise, { strict: true });
    const queued = scheduler.enqueue('k', async () => undefined, { strict: true });
    expect(scheduler.hasLane('k')).toBe(true);
    expect(scheduler.status()).toEqual({ closed: false, lanes: 1, active: 1, pending: 1 });
    held.open();
    await Promise.all([active, queued]);
    expect(scheduler.hasLane('k')).toBe(false);
  });

  it('closeAndDrain also runs writes that are admitted but not yet active', async () => {
    const scheduler = build();
    const held = gate();
    const ran: string[] = [];
    const active = scheduler.enqueue('k', async () => { await held.promise; ran.push('active'); }, { strict: true });
    const queued = scheduler.enqueue('k', async () => { ran.push('queued'); }, { strict: true });
    const drained = scheduler.closeAndDrain();
    expect(await settledWithin(drained)).toBe('pending');
    held.open();
    await Promise.all([active, queued, drained]);
    expect(ran).toEqual(['active', 'queued']);
  });

  it('rejects new work with the closed error and reopens only after a drain', async () => {
    const scheduler = build();
    const held = gate();
    const active = scheduler.enqueue('k', () => held.promise);
    void scheduler.closeAndDrain();
    await expect(scheduler.enqueue('late', async () => undefined)).rejects.toMatchObject({ code: 'TEST_CLOSED' });
    expect(() => scheduler.reopen()).toThrow('Cannot reopen test persistence before it drains');
    held.open();
    await active;
    await scheduler.closeAndDrain();
    scheduler.reopen();
    await expect(scheduler.enqueue('again', async () => undefined)).resolves.toBeUndefined();
  });

  it('rejects past the lane and per-key pending bounds with the full error', async () => {
    const scheduler = build(2, 2);
    const heldA = gate();
    const heldB = gate();
    const a0 = scheduler.enqueue('a', () => heldA.promise, { strict: true });
    const b0 = scheduler.enqueue('b', () => heldB.promise, { strict: true });
    const a1 = scheduler.enqueue('a', async () => undefined, { strict: true });
    const a2 = scheduler.enqueue('a', async () => undefined, { strict: true });
    await expect(scheduler.enqueue('a', async () => undefined, { strict: true }))
      .rejects.toMatchObject({ code: 'TEST_FULL', message: expect.stringContaining('key "a" reached its 2-write pending limit') });
    await expect(scheduler.enqueue('c', async () => undefined, { strict: true }))
      .rejects.toMatchObject({ code: 'TEST_FULL', message: 'Test persistence reached its 2-lane limit' });
    heldA.open();
    heldB.open();
    await Promise.all([a0, b0, a1, a2]);
  });
});

describe('drainsWithin', () => {
  it('resolves true when the drain settles first and false when the timer wins', async () => {
    await expect(drainsWithin(Promise.resolve(), 1_000)).resolves.toBe(true);
    await expect(drainsWithin(new Promise(() => undefined), 5)).resolves.toBe(false);
  });

  it('never leaves its timer armed after the drain settles', async () => {
    vi.useFakeTimers();
    try {
      const outcome = drainsWithin(Promise.resolve(), 60_000);
      await vi.advanceTimersByTimeAsync(0);
      await expect(outcome).resolves.toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('ContextGraphMembershipPersistScheduler (refactor invariants)', () => {
  it('keeps its typed errors, codes and messages on the shared scheduler', async () => {
    const scheduler = new ContextGraphMembershipPersistScheduler(1, 1);
    const held = gate();
    const active = scheduler.enqueue('a', () => held.promise, { strict: true });
    const pending = scheduler.enqueue('a', async () => undefined, { strict: true });
    const full = await scheduler.enqueue('a', async () => undefined, { strict: true }).catch((e: unknown) => e);
    expect(full).toBeInstanceOf(ContextGraphMembershipPersistQueueFullError);
    expect(full).toMatchObject({
      code: 'CG_MEMBERSHIP_PERSIST_QUEUE_FULL',
      message: 'Context-graph membership persistence key "a" reached its 1-write pending limit',
    });
    const laneFull = await scheduler.enqueue('b', async () => undefined).catch((e: unknown) => e);
    expect(laneFull).toMatchObject({
      code: 'CG_MEMBERSHIP_PERSIST_QUEUE_FULL',
      message: 'Context-graph membership persistence reached its 1-lane limit',
    });
    void scheduler.closeAndDrain();
    const closed = await scheduler.enqueue('c', async () => undefined).catch((e: unknown) => e);
    expect(closed).toBeInstanceOf(ContextGraphMembershipPersistQueueClosedError);
    expect(closed).toMatchObject({ code: 'CG_MEMBERSHIP_PERSIST_QUEUE_CLOSED' });
    expect(() => scheduler.reopen()).toThrow('Cannot reopen context-graph membership persistence before it drains');
    held.open();
    await Promise.all([active, pending]);
  });
});
