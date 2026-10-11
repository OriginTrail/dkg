import { describe, expect, it } from 'vitest';
import {
  CONTEXT_GRAPH_SUBSCRIPTION_PERSIST_SHUTDOWN_TIMEOUT_ERROR_CODE,
  ContextGraphSubscriptionPersistQueueClosedError,
  ContextGraphSubscriptionPersistQueueFullError,
  ContextGraphSubscriptionPersistScheduler,
  ContextGraphSubscriptionPersistShutdownTimeoutError,
} from '../src/context-graph-subscription-persist-scheduler.js';

function gate(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => { open = resolve; });
  return { promise, open };
}

describe('ContextGraphSubscriptionPersistScheduler', () => {
  it('runs every write for one key in order and never coalesces displaced writes', async () => {
    const scheduler = new ContextGraphSubscriptionPersistScheduler();
    const held = gate();
    const executed: number[] = [];
    const first = scheduler.enqueue('cg', async () => { executed.push(0); await held.promise; });
    const rest = Array.from({ length: 50 }, (_, index) =>
      scheduler.enqueue('cg', async () => { executed.push(index + 1); }));
    held.open();
    await Promise.all([first, ...rest]);
    expect(executed).toEqual(Array.from({ length: 51 }, (_, index) => index));
  });

  it('starts a write a microtask after admission, so the caller finishes its synchronous section first', async () => {
    const scheduler = new ContextGraphSubscriptionPersistScheduler();
    const events: string[] = [];
    const write = scheduler.enqueue('cg', async () => { events.push('write:start'); });
    events.push('caller-sync-done');
    expect(events).toEqual(['caller-sync-done']);
    // One microtask is enough: the write is deferred, not delayed to a macrotask.
    await Promise.resolve();
    expect(events).toEqual(['caller-sync-done', 'write:start']);
    await write;
  });

  it('starts the first write after the caller and a queued write only once the write ahead of it has ended', async () => {
    const scheduler = new ContextGraphSubscriptionPersistScheduler();
    const held = gate();
    const events: string[] = [];
    const first = scheduler.enqueue('cg', async () => {
      events.push('first:start');
      await held.promise;
      events.push('first:end');
    });
    const second = scheduler.enqueue('cg', async () => { events.push('second:start'); });
    events.push('caller-sync-done');
    held.open();
    await Promise.all([first, second]);
    expect(events).toEqual(['caller-sync-done', 'first:start', 'first:end', 'second:start']);
  });

  it('rejects only the caller of a write that throws before returning a promise, and keeps draining', async () => {
    const scheduler = new ContextGraphSubscriptionPersistScheduler();
    const boom = new Error('store threw synchronously');
    const failed = scheduler.enqueue('cg', (() => { throw boom; }) as () => Promise<void>);
    const ran: string[] = [];
    const next = scheduler.enqueue('cg', async () => { ran.push('next'); });
    const other = scheduler.enqueue('other', async () => { ran.push('other'); });
    await expect(failed).rejects.toBe(boom);
    await expect(next).resolves.toBeUndefined();
    await expect(other).resolves.toBeUndefined();
    expect(ran).toEqual(expect.arrayContaining(['next', 'other']));
    expect(scheduler.status()).toMatchObject({ lanes: 0, active: 0, pending: 0 });
  });

  it('overlaps different context graphs', async () => {
    const scheduler = new ContextGraphSubscriptionPersistScheduler();
    const held = gate();
    const slow = scheduler.enqueue('cg-a', () => held.promise);
    await expect(scheduler.enqueue('cg-b', async () => undefined)).resolves.toBeUndefined();
    expect(scheduler.hasLane('cg-a')).toBe(true);
    held.open();
    await slow;
  });

  it('has bounds far above membership backpressure so no healthy write is rejected', async () => {
    const scheduler = new ContextGraphSubscriptionPersistScheduler();
    const held = gate();
    const writes = Array.from({ length: 2_000 }, (_, index) =>
      scheduler.enqueue(`cg-${index}`, () => held.promise));
    // Membership's 1 000-lane bound would have rejected the second half.
    expect(scheduler.status().lanes).toBe(2_000);
    const deep = Array.from({ length: 200 }, () => scheduler.enqueue('cg-0', async () => undefined));
    held.open();
    await Promise.all([...writes, ...deep]);
  });

  it('rejects with typed subscription errors past its bounds and once closed', async () => {
    const scheduler = new ContextGraphSubscriptionPersistScheduler(1, 1);
    const held = gate();
    const active = scheduler.enqueue('a', () => held.promise);
    const pending = scheduler.enqueue('a', async () => undefined);
    const full = await scheduler.enqueue('a', async () => undefined).catch((e: unknown) => e);
    expect(full).toBeInstanceOf(ContextGraphSubscriptionPersistQueueFullError);
    expect(full).toMatchObject({
      code: 'CG_SUBSCRIPTION_PERSIST_QUEUE_FULL',
      message: 'Context-graph subscription persistence key "a" reached its 1-write pending limit',
    });
    void scheduler.closeAndDrain();
    const closed = await scheduler.enqueue('b', async () => undefined).catch((e: unknown) => e);
    expect(closed).toBeInstanceOf(ContextGraphSubscriptionPersistQueueClosedError);
    expect(closed).toMatchObject({
      code: 'CG_SUBSCRIPTION_PERSIST_QUEUE_CLOSED',
      message: 'Context-graph subscription persistence is closed',
    });
    held.open();
    await Promise.all([active, pending]);
  });

  it('exposes a stable shutdown timeout error code', () => {
    const error = new ContextGraphSubscriptionPersistShutdownTimeoutError(5_000);
    expect(error.code).toBe(CONTEXT_GRAPH_SUBSCRIPTION_PERSIST_SHUTDOWN_TIMEOUT_ERROR_CODE);
    expect(error.code).toBe('CG_SUBSCRIPTION_PERSIST_SHUTDOWN_TIMEOUT');
    expect(error.message).toBe('Context-graph subscription persistence did not drain within 5000ms');
  });

  it('reopenIfClosed leaves a never-closed scheduler with writes in flight alone', async () => {
    const scheduler = new ContextGraphSubscriptionPersistScheduler();
    const held = gate();
    const write = scheduler.enqueue('cg', () => held.promise);
    expect(() => scheduler.reopenIfClosed()).not.toThrow();
    expect(scheduler.status().closed).toBe(false);
    held.open();
    await write;
  });

  it('reopenIfClosed reopens a drained scheduler and refuses while lanes remain', async () => {
    const scheduler = new ContextGraphSubscriptionPersistScheduler();
    const held = gate();
    const write = scheduler.enqueue('cg', () => held.promise);
    const drained = scheduler.closeAndDrain();
    expect(() => scheduler.reopenIfClosed()).toThrow('before it drains');
    held.open();
    await Promise.all([write, drained]);
    scheduler.reopenIfClosed();
    expect(scheduler.status().closed).toBe(false);
    await expect(scheduler.enqueue('cg', async () => undefined)).resolves.toBeUndefined();
  });
});
