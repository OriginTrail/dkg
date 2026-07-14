import { describe, it, expect } from 'vitest';
import {
  reconcileContextGraph,
  VmReconcileQueueClosedError,
  VmReconcileQueueFullError,
  VmReconcileDispatcher,
  RecentUalSet,
  type ChainReconcilerDeps,
  type OrdinalOutcome,
} from '../src/chain-reconciler.js';
import { createCursorState } from '../src/reconcile-cursor.js';

/**
 * Phase B — sweep + cursor orchestration (B.2/B.4). The cursor math itself is
 * covered by reconcile-cursor.test.ts; here we pin the sweep driver:
 * gap-fill, watermark-persist-only-on-move, reorg depth, pending-retry, plus
 * the VM scheduler and UAL dedupe.
 */

function makeDeps(overrides: Partial<ChainReconcilerDeps> = {}): {
  deps: ChainReconcilerDeps;
  persisted: Array<{ cg: string; watermark: number }>;
  attempted: number[];
} {
  const persisted: Array<{ cg: string; watermark: number }> = [];
  const attempted: number[] = [];
  const deps: ChainReconcilerDeps = {
    getKCCount: async () => 0,
    getHeadBlock: async () => undefined,
    reconcileOrdinal: async (_cg, _onchain, ordinal) => {
      attempted.push(ordinal);
      return { status: 'reconciled', blockNumber: 0 };
    },
    persistWatermark: (cg, watermark) => persisted.push({ cg, watermark }),
    confirmationDepth: 0,
    log: () => undefined,
    ...overrides,
  };
  return { deps, persisted, attempted };
}

describe('reconcileContextGraph — sweep', () => {
  it('reconciles [watermark, head) and advances + persists the watermark', async () => {
    const { deps, persisted, attempted } = makeDeps({ getKCCount: async () => 3 });
    const state = createCursorState(0);
    const res = await reconcileContextGraph(deps, state, 'cg', 1n);
    expect(attempted).toEqual([0, 1, 2]);
    expect(res.watermark).toBe(3);
    expect(persisted).toEqual([{ cg: 'cg', watermark: 3 }]);
  });

  it('skips head-block and ordinal work when the durable watermark covers the chain head', async () => {
    let headBlockReads = 0;
    const { deps, persisted, attempted } = makeDeps({
      getKCCount: async () => 3,
      getHeadBlock: async () => {
        headBlockReads += 1;
        return 100;
      },
    });
    const state = createCursorState(3); // already at head
    const result = await reconcileContextGraph(deps, state, 'cg', 1n);

    expect(result).toEqual({ head: 3, watermark: 3, reconciled: 0, pending: 0 });
    expect(headBlockReads).toBe(0);
    expect(attempted).toEqual([]);
    expect(persisted).toEqual([]);
  });

  it('a pending ordinal holds the watermark; a later sweep fills the gap', async () => {
    let firstPass = true;
    const { deps, persisted } = makeDeps({
      getKCCount: async () => 3,
      reconcileOrdinal: async (_cg, _onchain, ordinal) => {
        // ordinal 1 is missing SWM on the first pass only.
        if (ordinal === 1 && firstPass) return { status: 'pending' } as OrdinalOutcome;
        return { status: 'reconciled', blockNumber: 0 };
      },
    });
    const state = createCursorState(0);

    const r1 = await reconcileContextGraph(deps, state, 'cg', 1n);
    // 0 reconciled -> watermark 1; 1 pending -> hold; 2 reconciled but held above gap.
    expect(r1.watermark).toBe(1);
    expect(persisted).toEqual([{ cg: 'cg', watermark: 1 }]);

    firstPass = false;
    const r2 = await reconcileContextGraph(deps, state, 'cg', 1n);
    // 1 now reconciled -> absorbs 1 and the held 2 -> watermark 3.
    expect(r2.watermark).toBe(3);
    expect(persisted).toEqual([
      { cg: 'cg', watermark: 1 },
      { cg: 'cg', watermark: 3 },
    ]);
  });

  it('does not re-attempt an ordinal already held in the cursor', async () => {
    // ordinal 2 completes out of order on pass 1 (held because 1 is pending),
    // then must NOT be re-attempted on pass 2.
    let pass = 0;
    const attempts: number[][] = [[], []];
    const { deps } = makeDeps({
      getKCCount: async () => 3,
      reconcileOrdinal: async (_cg, _onchain, ordinal) => {
        attempts[pass].push(ordinal);
        if (ordinal === 1 && pass === 0) return { status: 'pending' };
        return { status: 'reconciled', blockNumber: 0 };
      },
    });
    const state = createCursorState(0);
    await reconcileContextGraph(deps, state, 'cg', 1n);
    pass = 1;
    await reconcileContextGraph(deps, state, 'cg', 1n);
    expect(attempts[0]).toEqual([0, 1, 2]);
    expect(attempts[1]).toEqual([1]); // only the gap, not the held 2
  });

  it('respects the reorg confirmation depth: a shallow ordinal holds, a buried one advances', async () => {
    let head = 100;
    const { deps } = makeDeps({
      getKCCount: async () => 1,
      getHeadBlock: async () => head,
      confirmationDepth: 5,
      reconcileOrdinal: async () => ({ status: 'reconciled', blockNumber: 100 }),
    });
    const state = createCursorState(0);

    const r1 = await reconcileContextGraph(deps, state, 'cg', 1n);
    expect(r1.watermark).toBe(0); // depth 2 < 5: held

    head = 106; // now buried by 6 >= 5
    const r2 = await reconcileContextGraph(deps, state, 'cg', 1n);
    expect(r2.watermark).toBe(1);
  });

  it('skips promotion during transient head fetch failure and retries when the head recovers', async () => {
    let headThrows = true;
    const attempted: number[] = [];
    const { deps, persisted } = makeDeps({
      getKCCount: async () => 2,
      confirmationDepth: 5,
      getHeadBlock: async () => {
        if (headThrows) throw new Error('RPC down');
        return 100;
      },
      reconcileOrdinal: async (_cg, _onchain, ordinal) => {
        attempted.push(ordinal);
        return { status: 'reconciled', blockNumber: 90 };
      },
    });
    const state = createCursorState(0);

    const r1 = await reconcileContextGraph(deps, state, 'cg', 1n);
    expect(r1.reconciled).toBe(0);
    expect(r1.pending).toBe(2);
    expect(r1.watermark).toBe(0);
    expect(attempted).toEqual([]);
    expect(persisted).toEqual([]);

    headThrows = false;
    const r2 = await reconcileContextGraph(deps, state, 'cg', 1n);
    expect(r2.watermark).toBe(2);
    expect(attempted).toEqual([0, 1]);
    expect(persisted).toEqual([{ cg: 'cg', watermark: 2 }]);
  });
});

describe('VmReconcileDispatcher scheduling', () => {
  it('passes the trigger source to the scheduled run', async () => {
    const observed: string[] = [];
    const scheduler = new VmReconcileDispatcher(
      async (_key, source) => { observed.push(source); },
      () => undefined,
    );

    scheduler.triggerLive('cg');
    await scheduler.waitForIdle('cg');
    scheduler.triggerPeriodic('cg');
    await scheduler.waitForIdle('cg');

    expect(observed).toEqual(['live', 'periodic']);
  });

  it('collapses a successful live burst into one run plus one trailing run', async () => {
    let runs = 0;
    let resolveCurrent!: () => void;
    const scheduler = new VmReconcileDispatcher(
      async () => {
        runs += 1;
        await new Promise<void>((resolve) => {
          resolveCurrent = resolve;
        });
      },
      () => undefined,
    );

    expect(scheduler.triggerLive('cg')).toBeUndefined();
    scheduler.triggerLive('cg');
    scheduler.triggerLive('cg');
    scheduler.triggerLive('cg');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(runs).toBe(1);

    resolveCurrent();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(runs).toBe(2);

    resolveCurrent();
    await scheduler.waitForIdle('cg');
    expect(runs).toBe(2);
    expect(scheduler.isInFlight('cg')).toBe(false);
  });

  it('suppresses queued/live retries after failure but retries on the periodic path', async () => {
    let runs = 0;
    const failures: Array<{ key: string; error: unknown }> = [];
    let resolveCurrent!: () => void;
    let rejectCurrent!: (error: Error) => void;
    const scheduler = new VmReconcileDispatcher(
      async () => {
        runs += 1;
        await new Promise<void>((resolve, reject) => {
          resolveCurrent = resolve;
          rejectCurrent = reject;
        });
      },
      (key, error) => failures.push({ key, error }),
    );

    const failure = new Error('store deadline exceeded');
    scheduler.triggerLive('cg');
    await new Promise((resolve) => setTimeout(resolve, 0));
    scheduler.triggerLive('cg'); // queues one trailing pass while active
    rejectCurrent(failure);
    await scheduler.waitForIdle('cg');
    expect(runs).toBe(1); // failed pass does not immediately run the queued pass
    expect(failures).toEqual([{ key: 'cg', error: failure }]);

    scheduler.triggerLive('cg');
    await scheduler.waitForIdle('cg');
    expect(runs).toBe(1); // live nudge during the failure hold is ignored

    scheduler.triggerPeriodic('cg');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(runs).toBe(2); // the periodic reliability path retries normally
    resolveCurrent();
    await scheduler.waitForIdle('cg');

    scheduler.triggerLive('cg');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(runs).toBe(3); // successful periodic recovery releases the live hold
    resolveCurrent();
    await scheduler.waitForIdle('cg');
  });

  it('preserves a periodic retry queued behind a failing live pass', async () => {
    let runs = 0;
    let resolveCurrent!: () => void;
    let rejectCurrent!: (error: Error) => void;
    const scheduler = new VmReconcileDispatcher(
      async () => {
        runs += 1;
        await new Promise<void>((resolve, reject) => {
          resolveCurrent = resolve;
          rejectCurrent = reject;
        });
      },
      () => undefined,
    );

    scheduler.triggerLive('cg');
    await new Promise((resolve) => setTimeout(resolve, 0));
    scheduler.triggerPeriodic('cg');
    rejectCurrent(new Error('store deadline exceeded'));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(runs).toBe(2); // queued periodic pass starts despite the live failure hold
    resolveCurrent();
    await scheduler.waitForIdle('cg');
    expect(scheduler.isInFlight('cg')).toBe(false);
  });

  it('isolates the live failure hold per context graph', async () => {
    const ran: string[] = [];
    const failures: string[] = [];
    const scheduler = new VmReconcileDispatcher(
      async (key) => {
        ran.push(key);
        if (key === 'cg-a') throw new Error('cg-a unavailable');
      },
      (key) => failures.push(key),
    );

    scheduler.triggerLive('cg-a');
    await scheduler.waitForIdle('cg-a');
    scheduler.triggerLive('cg-a'); // held after failure
    await scheduler.waitForIdle('cg-a');
    scheduler.triggerLive('cg-b'); // unrelated CG still runs immediately
    await scheduler.waitForIdle('cg-b');

    expect(ran).toEqual(['cg-a', 'cg-b']);
    expect(failures).toEqual(['cg-a']);
  });
});

describe('VmReconcileDispatcher admission', () => {
  it('serializes cross-CG work and lets foreground work pass periodic backlog', async () => {
    const order: string[] = [];
    let releaseFirst!: () => void;
    const dispatcher = new VmReconcileDispatcher(async (key) => {
      if (key === 'first') {
        order.push('first:start');
        await new Promise<void>((resolve) => { releaseFirst = resolve; });
        order.push('first:end');
      } else {
        order.push(key);
      }
    }, () => undefined, { concurrency: 1 });

    const first = dispatcher.dispatch('first', 'periodic');
    const second = dispatcher.dispatch('second', 'periodic');
    const foreground = dispatcher.dispatch('foreground', 'live');

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(dispatcher.snapshot()).toEqual({ active: 1, queued: 2, closed: false });
    releaseFirst();
    await Promise.all([first, second, foreground]);

    expect(order).toEqual(['first:start', 'first:end', 'foreground', 'second']);
    expect(dispatcher.snapshot()).toEqual({ active: 0, queued: 0, closed: false });
  });

  it('keeps draining after a failed reconciliation job', async () => {
    const failure = new Error('store unavailable');
    const dispatcher = new VmReconcileDispatcher(async (key) => {
      if (key === 'first') throw failure;
      return 'recovered';
    }, () => undefined, { concurrency: 1 });
    const first = dispatcher.dispatch('first', 'periodic');
    const second = dispatcher.dispatch('second', 'periodic');

    await expect(first).rejects.toBe(failure);
    await expect(second).resolves.toBe('recovered');
    expect(dispatcher.snapshot()).toEqual({ active: 0, queued: 0, closed: false });
  });

  it('upgrades a queued periodic CG to live priority in place', async () => {
    const order: string[] = [];
    let releaseBlocker!: () => void;
    const dispatcher = new VmReconcileDispatcher(
      async (key, source) => {
        if (key === 'blocker') {
          await new Promise<void>((resolve) => { releaseBlocker = resolve; });
          return;
        }
        order.push(`${key}:${source}`);
      },
      () => undefined,
      { concurrency: 1 },
    );
    const blocker = dispatcher.dispatch('blocker', 'periodic');

    dispatcher.triggerPeriodic('a');
    dispatcher.triggerPeriodic('b');
    dispatcher.triggerLive('b');

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(dispatcher.pendingSource('b')).toBe('live');
    expect(dispatcher.snapshot()).toEqual({ active: 1, queued: 2, closed: false });
    releaseBlocker();
    await blocker;
    await dispatcher.waitForIdle();

    expect(order).toEqual(['b:live', 'a:periodic']);
  });

  it('coalesces repeated manual requests for one queued context graph', async () => {
    let releaseBlocker!: () => void;
    let manualRuns = 0;
    const dispatcher = new VmReconcileDispatcher(async (key) => {
      if (key === 'blocker') {
        await new Promise<void>((resolve) => { releaseBlocker = resolve; });
        return 'blocker';
      }
      if (key === 'manual-cg') {
        manualRuns += 1;
        return 'done';
      }
      return key;
    }, () => undefined, { concurrency: 1, maxPending: 2 });
    const blocker = dispatcher.dispatch('blocker', 'periodic');
    const requests = Array.from({ length: 20 }, () => dispatcher.triggerManual('manual-cg'));

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(new Set(requests).size).toBe(1);
    expect(dispatcher.snapshot()).toEqual({ active: 1, queued: 1, closed: false });
    releaseBlocker();
    await blocker;
    await expect(Promise.all(requests)).resolves.toEqual(Array(20).fill('done'));
    expect(manualRuns).toBe(1);
  });

  it('rejects excess distinct work with a typed overload error', async () => {
    let releaseBlocker!: () => void;
    const dispatcher = new VmReconcileDispatcher(async (key) => {
      if (key === 'blocker') await new Promise<void>((resolve) => { releaseBlocker = resolve; });
    }, () => undefined, { concurrency: 1, maxPending: 1 });
    const blocker = dispatcher.dispatch('blocker', 'periodic');
    const admitted = dispatcher.triggerManual('admitted');

    await expect(dispatcher.triggerManual('over-limit'))
      .rejects.toBeInstanceOf(VmReconcileQueueFullError);
    await new Promise((resolve) => setTimeout(resolve, 0));
    releaseBlocker();
    await Promise.all([blocker, admitted]);
  });

  it('admits periodic work within a bounded foreground burst', async () => {
    const order: string[] = [];
    let releaseBlocker!: () => void;
    const dispatcher = new VmReconcileDispatcher(async (key) => {
      if (key === 'blocker') {
        await new Promise<void>((resolve) => { releaseBlocker = resolve; });
        return;
      }
      order.push(key);
    }, () => undefined, { concurrency: 1, maxForegroundBurst: 2 });
    const blocker = dispatcher.dispatch('blocker', 'periodic');
    const periodic = dispatcher.dispatch('periodic', 'periodic');
    const foreground = Array.from({ length: 5 }, (_, index) =>
      dispatcher.triggerManual(`manual-${index}`));

    await new Promise((resolve) => setTimeout(resolve, 0));
    releaseBlocker();
    await Promise.all([blocker, periodic, ...foreground]);

    expect(order.slice(0, 3)).toEqual(['manual-0', 'manual-1', 'periodic']);
  });

  it('cancels pending work and never starts it after the dispatcher closes', async () => {
    let releaseActive!: () => void;
    let queuedStarted = false;
    const dispatcher = new VmReconcileDispatcher(async (key) => {
      if (key === 'active') {
        await new Promise<void>((resolve) => { releaseActive = resolve; });
      } else if (key === 'queued') {
        queuedStarted = true;
      }
    }, () => undefined, { concurrency: 1 });
    const active = dispatcher.triggerManual('active');
    const queued = dispatcher.triggerManual('queued');
    const queuedOutcome = queued.catch((error) => error);

    const closing = dispatcher.close();
    let closed = false;
    void closing.then(() => { closed = true; });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(await queuedOutcome).toBeInstanceOf(VmReconcileQueueClosedError);
    await expect(dispatcher.triggerManual('late'))
      .rejects.toBeInstanceOf(VmReconcileQueueClosedError);
    expect(queuedStarted).toBe(false);
    expect(closed).toBe(false);

    releaseActive();
    await Promise.all([active, closing]);
    expect(queuedStarted).toBe(false);
    expect(dispatcher.snapshot()).toEqual({ active: 0, queued: 0, closed: true });
  });
});

describe('RecentUalSet', () => {
  it('dedupes and evicts oldest past the cap', () => {
    const set = new RecentUalSet(2);
    set.add('a');
    set.add('b');
    expect(set.has('a')).toBe(true);
    set.add('c'); // evicts 'a'
    expect(set.has('a')).toBe(false);
    expect(set.has('b')).toBe(true);
    expect(set.has('c')).toBe(true);
  });

  it('deletes all entries for one local CG prefix without touching others', () => {
    const set = new RecentUalSet(10);
    set.add('cg-a\0ual#01');
    set.add('cg-a\0ual#02');
    set.add('cg-b\0ual#01');

    set.deleteByPrefix('cg-a\0');

    expect(set.has('cg-a\0ual#01')).toBe(false);
    expect(set.has('cg-a\0ual#02')).toBe(false);
    expect(set.has('cg-b\0ual#01')).toBe(true);
  });
});
