import { describe, expect, it, vi } from 'vitest';
import {
  ContextGraphMembershipPersistQueueClosedError,
  ContextGraphMembershipPersistQueueFullError,
  ContextGraphMembershipPersistScheduler,
} from '../src/context-graph-membership-persist-scheduler.js';

describe('ContextGraphMembershipPersistScheduler', () => {
  it('keeps one active and one latest background mutation per busy key', async () => {
    const scheduler = new ContextGraphMembershipPersistScheduler(4, 4);
    let releaseActive!: () => void;
    let markActive!: () => void;
    const activeEntered = new Promise<void>((resolve) => { markActive = resolve; });
    const activeGate = new Promise<void>((resolve) => { releaseActive = resolve; });
    const executed: number[] = [];
    const active = scheduler.enqueue('cg\0node\0peer', async () => {
      executed.push(0);
      markActive();
      await activeGate;
    });
    await activeEntered;

    const pending = Array.from({ length: 1_000 }, (_, index) =>
      scheduler.enqueue('cg\0node\0peer', async () => { executed.push(index + 1); }));
    expect(scheduler.status()).toMatchObject({ lanes: 1, active: 1, pending: 1 });

    releaseActive();
    await Promise.all([active, ...pending]);
    expect(executed).toEqual([0, 1_000]);
    expect(scheduler.status()).toEqual({ closed: false, lanes: 0, active: 0, pending: 0 });
  });

  it('preserves strict FIFO writes and rejects work beyond bounded capacity', async () => {
    const scheduler = new ContextGraphMembershipPersistScheduler(2, 2);
    let releaseA!: () => void;
    let releaseB!: () => void;
    const gateA = new Promise<void>((resolve) => { releaseA = resolve; });
    const gateB = new Promise<void>((resolve) => { releaseB = resolve; });
    const executed: string[] = [];
    const activeA = scheduler.enqueue('a', async () => { executed.push('a0'); await gateA; });
    const activeB = scheduler.enqueue('b', async () => { executed.push('b0'); await gateB; });
    await Promise.resolve();

    const strictA1 = scheduler.enqueue('a', async () => { executed.push('a1'); }, { strict: true });
    const strictA2 = scheduler.enqueue('a', async () => { executed.push('a2'); }, { strict: true });
    await expect(scheduler.enqueue('a', async () => undefined, { strict: true }))
      .rejects.toBeInstanceOf(ContextGraphMembershipPersistQueueFullError);
    await expect(scheduler.enqueue('c', async () => undefined, { strict: true }))
      .rejects.toBeInstanceOf(ContextGraphMembershipPersistQueueFullError);

    releaseA();
    releaseB();
    await Promise.all([activeA, activeB, strictA1, strictA2]);
    expect(executed.filter((item) => item.startsWith('a'))).toEqual(['a0', 'a1', 'a2']);
  });

  it('closes admission and drains physical writes before resolving', async () => {
    const scheduler = new ContextGraphMembershipPersistScheduler();
    let release!: () => void;
    let markEntered!: () => void;
    const entered = new Promise<void>((resolve) => { markEntered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const write = scheduler.enqueue('key', async () => { markEntered(); await gate; });
    await entered;
    const drained = scheduler.closeAndDrain();
    const drainSettled = vi.fn();
    void drained.then(drainSettled);

    await expect(scheduler.enqueue('late', async () => undefined))
      .rejects.toBeInstanceOf(ContextGraphMembershipPersistQueueClosedError);
    await Promise.resolve();
    expect(drainSettled).not.toHaveBeenCalled();

    release();
    await Promise.all([write, drained]);
    expect(drainSettled).toHaveBeenCalledOnce();
    expect(scheduler.status()).toEqual({ closed: true, lanes: 0, active: 0, pending: 0 });
  });
});
