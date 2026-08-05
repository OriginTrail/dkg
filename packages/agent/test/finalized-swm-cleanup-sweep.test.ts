// SPDX-License-Identifier: Apache-2.0

/**
 * Control-flow guards of the idle finalized-SWM GC slice.
 *
 * `FinalizedSwmCleanupService.runSweep()` is the only discovery boundary the
 * garbage collector owns, and the reviewer's acceptance criteria are about what
 * it *refuses* to do: under sustained foreground load it must perform no
 * discovery and no payload scan at all, and once its wall-clock budget is spent
 * it must yield the slice rather than keep enumerating.
 *
 * Those are properties of the in-loop `return`s, not of the happy path, so the
 * assertions here are deliberately about work NOT attempted — every test pins a
 * specific gate by observing the next store read or discovery closure that would
 * run if the gate were removed. A test that only asserted the returned
 * `FinalizedSwmCleanupSweepResult` would pass with the gates deleted, because
 * the callee-side guards inside `cleanupMetaGraph`/`inspectBacklog` produce the
 * same result shape one step later.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  GraphManager,
  OxigraphStore,
  StoreSchedulerBusyError,
  type TripleStore,
} from '@origintrail-official/dkg-storage';
import { FinalizedSwmCleanupService } from '../src/finalized-swm-cleanup-service.js';
import { FinalizedSwmCleanupWorker } from '../src/finalized-swm-cleanup-worker.js';

const CG = 'sweep-gate-cg';

/** Toggleable foreground pressure; the service only reads the snapshot. */
function installPressureSwitch(store: TripleStore): { busy: boolean } {
  const state = { busy: false };
  Object.defineProperty(store, 'getPressureSnapshot', {
    configurable: true,
    value: () => ({
      ackInflight: 0,
      healthInflight: 0,
      normalInflight: state.busy ? 1 : 0,
      backgroundInflight: 0,
      ackQueued: 0,
      healthQueued: 0,
      normalQueued: 0,
      backgroundQueued: 0,
      maxConcurrent: 4,
      ackReservedSlots: 1,
    }),
  });
  return state;
}

/**
 * Records every store *method call* (not property read) so a test can assert
 * that a pass touched the store zero times. `asGraphWriteGenSource` only probes
 * `typeof store.getWriteGen === 'function'`, which stays a property read here.
 */
function countingStore(inner: TripleStore, calls: string[]): TripleStore {
  return new Proxy(inner as unknown as object, {
    get(target, prop) {
      const value = Reflect.get(target, prop);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        calls.push(String(prop));
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  }) as unknown as TripleStore;
}

/** Collects the `source` label of every query the sweep issues. */
function recordQuerySources(store: OxigraphStore): {
  sources: string[];
  restore: () => void;
} {
  const sources: string[] = [];
  const originalQuery = store.query.bind(store);
  const spy = vi.spyOn(store, 'query').mockImplementation(async (query, options) => {
    if (options?.source?.startsWith('agent.finalizedSwmCleanup')) {
      sources.push(options.source);
    }
    return originalQuery(query, options);
  });
  return { sources, restore: () => spy.mockRestore() };
}

describe('finalized SWM cleanup sweep gates', () => {
  /**
   * Reviewer acceptance bullet (a): under sustained load the GC performs no
   * discovery and no payload scan. Asserting only that the discovery closure
   * was skipped is weaker than the bullet — it leaves room for a refactor to
   * hoist a store read (a backlog probe, a resumption-cursor read) above the
   * pressure gate. This pins the store itself: the only call permitted while
   * pressure is active is reading the pressure snapshot.
   */
  it('performs zero store operations and no discovery while the store is under pressure', async () => {
    const inner = new OxigraphStore();
    const pressure = installPressureSwitch(inner);
    pressure.busy = true;
    const calls: string[] = [];
    const listContextGraphIds = vi.fn(async () => [CG]);
    const listSharedMemoryMetaGraphs = vi.fn(async () => [
      new GraphManager(inner).sharedMemoryMetaUri(CG),
    ]);
    const service = new FinalizedSwmCleanupService({
      store: countingStore(inner, calls),
      writeLocks: new Map<string, Promise<void>>(),
      listContextGraphIds,
      listSharedMemoryMetaGraphs,
    });

    await expect(service.runSweep()).resolves.toMatchObject({
      pressureSkipped: true,
      deletedItems: 0,
      backlogDepth: 0,
    });

    expect(listContextGraphIds).not.toHaveBeenCalled();
    expect(listSharedMemoryMetaGraphs).not.toHaveBeenCalled();
    expect(calls.filter((name) => name !== 'getPressureSnapshot')).toEqual([]);
    expect(calls.length).toBeGreaterThan(0);
  });

  /**
   * Pressure that appears *after* the context-graph enumeration resolves — the
   * realistic case, since enumeration is the expensive call that tends to run
   * just as foreground work arrives. The gate at the top of the context-graph
   * loop must abandon the slice before the per-graph meta enumeration.
   */
  it('abandons the slice when pressure appears after context-graph enumeration', async () => {
    const store = new OxigraphStore();
    const pressure = installPressureSwitch(store);
    const listSharedMemoryMetaGraphs = vi.fn(async () => [
      new GraphManager(store).sharedMemoryMetaUri(CG),
    ]);
    const { sources, restore } = recordQuerySources(store);
    const service = new FinalizedSwmCleanupService({
      store,
      writeLocks: new Map<string, Promise<void>>(),
      listContextGraphIds: async () => {
        pressure.busy = true;
        return [CG, 'second-cg'];
      },
      listSharedMemoryMetaGraphs,
    });

    await expect(service.runSweep()).resolves.toMatchObject({
      pressureSkipped: true,
      deletedItems: 0,
    });

    expect(listSharedMemoryMetaGraphs).not.toHaveBeenCalled();
    expect(sources).toEqual([]);
    restore();
  });

  /**
   * Pressure that appears while a meta graph is being cleaned. The gate after
   * `cleanupMetaGraph` must abandon the slice: without it the backlog probe
   * runs and throws `StoreSchedulerBusyError` into the worker, converting an
   * expected, retryable idle-yield into a recorded sweep failure.
   */
  it('abandons the slice when pressure appears during meta-graph cleanup', async () => {
    const store = new OxigraphStore();
    const pressure = installPressureSwitch(store);
    const sources: string[] = [];
    const originalQuery = store.query.bind(store);
    const querySpy = vi.spyOn(store, 'query').mockImplementation(async (query, options) => {
      const result = await originalQuery(query, options);
      if (options?.source?.startsWith('agent.finalizedSwmCleanup')) {
        sources.push(options.source);
        if (options.source === 'agent.finalizedSwmCleanup.discover') pressure.busy = true;
      }
      return result;
    });
    const service = new FinalizedSwmCleanupService({
      store,
      writeLocks: new Map<string, Promise<void>>(),
      listContextGraphIds: async () => [CG],
      listSharedMemoryMetaGraphs: async () => [
        new GraphManager(store).sharedMemoryMetaUri(CG),
      ],
    });

    await expect(service.runSweep()).resolves.toMatchObject({
      pressureSkipped: true,
      deletedItems: 0,
    });

    expect(sources).toEqual(['agent.finalizedSwmCleanup.discover']);
    expect(sources).not.toContain('agent.finalizedSwmCleanup.backlog');
    querySpy.mockRestore();
  });

  /**
   * A pressure snapshot is a point-in-time sample: a foreground burst can be
   * over by the time a callee re-samples it. The gate at the top of the
   * meta-graph loop is therefore not redundant with the guard inside
   * `cleanupMetaGraph` — it is the only observer of a spike seen at that
   * instant, and dropping it lets a slice that already saw pressure go on to
   * open a discovery scan.
   *
   * The spike is one-shot on purpose. Adding a further gate before this one
   * keeps the test green (the slice is still abandoned, still with no scan);
   * only removing the gate turns it red.
   */
  it('abandons the slice on a transient pressure spike seen after meta-graph enumeration', async () => {
    const store = new OxigraphStore();
    let spikePending = false;
    Object.defineProperty(store, 'getPressureSnapshot', {
      configurable: true,
      value: () => {
        const busy = spikePending;
        spikePending = false;
        return {
          ackInflight: 0,
          healthInflight: 0,
          normalInflight: busy ? 1 : 0,
          backgroundInflight: 0,
          ackQueued: 0,
          healthQueued: 0,
          normalQueued: 0,
          backgroundQueued: 0,
          maxConcurrent: 4,
          ackReservedSlots: 1,
        };
      },
    });
    const { sources, restore } = recordQuerySources(store);
    const service = new FinalizedSwmCleanupService({
      store,
      writeLocks: new Map<string, Promise<void>>(),
      listContextGraphIds: async () => [CG],
      listSharedMemoryMetaGraphs: async () => {
        spikePending = true;
        return [new GraphManager(store).sharedMemoryMetaUri(CG)];
      },
    });

    await expect(service.runSweep()).resolves.toMatchObject({
      pressureSkipped: true,
      deletedItems: 0,
    });

    expect(sources).toEqual([]);
    restore();
  });

  /**
   * The wall-clock budget is enforced on a caller-supplied clock, so these
   * three tests move the clock at each in-loop boundary. `budgetExhausted` is
   * what makes the worker reschedule promptly instead of waiting for the
   * periodic backstop, so both the flag and the abandoned work are asserted.
   */
  it('yields the slice when the budget expires during context-graph enumeration', async () => {
    const store = new OxigraphStore();
    installPressureSwitch(store);
    const clock = { now: 1_000_000 };
    const listSharedMemoryMetaGraphs = vi.fn(async () => [
      new GraphManager(store).sharedMemoryMetaUri(CG),
    ]);
    const { sources, restore } = recordQuerySources(store);
    const service = new FinalizedSwmCleanupService({
      store,
      writeLocks: new Map<string, Promise<void>>(),
      now: () => clock.now,
      wallClockBudgetMs: 60_000,
      listContextGraphIds: async () => {
        clock.now += 60_001;
        return [CG, 'second-cg'];
      },
      listSharedMemoryMetaGraphs,
    });

    await expect(service.runSweep()).resolves.toMatchObject({
      pressureSkipped: false,
      budgetExhausted: true,
      deletedItems: 0,
    });

    expect(listSharedMemoryMetaGraphs).not.toHaveBeenCalled();
    expect(sources).toEqual([]);
    restore();
  });

  it('yields the slice when the budget expires during meta-graph enumeration', async () => {
    const store = new OxigraphStore();
    installPressureSwitch(store);
    const clock = { now: 1_000_000 };
    const { sources, restore } = recordQuerySources(store);
    const service = new FinalizedSwmCleanupService({
      store,
      writeLocks: new Map<string, Promise<void>>(),
      now: () => clock.now,
      wallClockBudgetMs: 60_000,
      listContextGraphIds: async () => [CG],
      listSharedMemoryMetaGraphs: async () => {
        clock.now += 60_001;
        return [new GraphManager(store).sharedMemoryMetaUri(CG)];
      },
    });

    await expect(service.runSweep()).resolves.toMatchObject({
      pressureSkipped: false,
      budgetExhausted: true,
      deletedItems: 0,
    });

    // Neither the candidate discovery nor the backlog probe may run once the
    // slice is over budget.
    expect(sources).toEqual([]);
    restore();
  });

  it('yields the slice when the budget expires inside meta-graph cleanup', async () => {
    const store = new OxigraphStore();
    installPressureSwitch(store);
    const clock = { now: 1_000_000 };
    const sources: string[] = [];
    const originalQuery = store.query.bind(store);
    const querySpy = vi.spyOn(store, 'query').mockImplementation(async (query, options) => {
      const result = await originalQuery(query, options);
      if (options?.source?.startsWith('agent.finalizedSwmCleanup')) {
        sources.push(options.source);
        if (options.source === 'agent.finalizedSwmCleanup.discover') clock.now += 60_001;
      }
      return result;
    });
    const service = new FinalizedSwmCleanupService({
      store,
      writeLocks: new Map<string, Promise<void>>(),
      now: () => clock.now,
      wallClockBudgetMs: 60_000,
      listContextGraphIds: async () => [CG],
      listSharedMemoryMetaGraphs: async () => [
        new GraphManager(store).sharedMemoryMetaUri(CG),
      ],
    });

    await expect(service.runSweep()).resolves.toMatchObject({
      pressureSkipped: false,
      budgetExhausted: true,
      deletedItems: 0,
    });

    expect(sources).toEqual(['agent.finalizedSwmCleanup.discover']);
    expect(sources).not.toContain('agent.finalizedSwmCleanup.backlog');
    querySpy.mockRestore();
  });

  /**
   * End-to-end budget wiring: the worker's prompt-retry decision is driven by a
   * `budgetExhausted` produced by the real service, not by a stubbed sweep, and
   * a yielded slice must not be miscounted as store pressure.
   */
  it('reschedules promptly on a budget-exhausted slice produced by the real service', async () => {
    const store = new OxigraphStore();
    installPressureSwitch(store);
    const clock = { now: 1_000_000 };
    const service = new FinalizedSwmCleanupService({
      store,
      writeLocks: new Map<string, Promise<void>>(),
      now: () => clock.now,
      wallClockBudgetMs: 60_000,
      listContextGraphIds: async () => {
        clock.now += 60_001;
        return [CG];
      },
      listSharedMemoryMetaGraphs: async () => [
        new GraphManager(store).sharedMemoryMetaUri(CG),
      ],
    });
    const timers: Array<{ fn: () => void; delayMs: number }> = [];
    const onError = vi.fn();
    const worker = new FinalizedSwmCleanupWorker({
      sweep: () => service.runSweep(),
      retryDelayMs: 321,
      onError,
      setTimer: ((fn: () => void, delayMs: number) => {
        timers.push({ fn, delayMs });
        return { unref() {} };
      }) as never,
      clearTimer: () => {},
    });

    await worker.runNow();

    expect(onError).not.toHaveBeenCalled();
    expect(worker.snapshot()).toMatchObject({ runs: 1, pressureSkips: 0, lastError: null });
    expect(timers).toHaveLength(1);
    expect(timers[0]!.delayMs).toBe(321);
    await worker.close();
  });

  /**
   * Wires the real service into the real worker so a store rejection travels
   * the whole path it travels in production.
   *
   * The snapshot gate is a point-in-time sample and cannot see load that lands
   * between the gate and the query, so the background lane reports saturation
   * by THROWING instead. `inspectBacklog` even raises that class itself as a
   * defensive check straight after the gate, so the service can manufacture the
   * error without any scheduler load at all — just the race between the two.
   *
   * Before this was classified, such a throw skipped the worker's retry
   * scheduling entirely (which exists only on the success path) and stranded
   * the backlog until the 15-minute backstop.
   */
  function schedulerThrowFixture(error: unknown) {
    const store = new OxigraphStore();
    installPressureSwitch(store);
    const originalQuery = store.query.bind(store);
    vi.spyOn(store, 'query').mockImplementation(async (query, options) => {
      if (options?.source === 'agent.finalizedSwmCleanup.backlog') throw error;
      return originalQuery(query, options);
    });
    const service = new FinalizedSwmCleanupService({
      store,
      writeLocks: new Map<string, Promise<void>>(),
      listContextGraphIds: async () => [CG],
      listSharedMemoryMetaGraphs: async () => [
        new GraphManager(store).sharedMemoryMetaUri(CG),
      ],
    });
    const timers: Array<{ fn: () => void; delayMs: number }> = [];
    const onError = vi.fn();
    const worker = new FinalizedSwmCleanupWorker({
      sweep: () => service.runSweep(),
      retryDelayMs: 5_000,
      onError,
      setTimer: ((fn: () => void, delayMs: number) => {
        timers.push({ fn, delayMs });
        return { unref() {} };
      }) as never,
      clearTimer: () => {},
    });
    return { worker, timers, onError };
  }

  it('retries and counts a scheduler rejection thrown out of the sweep as pressure', async () => {
    const { worker, timers, onError } = schedulerThrowFixture(
      new StoreSchedulerBusyError('queue_full', 'background', 'agent.finalizedSwmCleanup.backlog'),
    );

    await worker.runNow();

    // Retried on the prompt cadence rather than left to the periodic backstop.
    expect(timers).toHaveLength(1);
    expect(timers[0]!.delayMs).toBe(5_000);
    // Counted as a deferral, not swallowed as a fault: the counters must stay
    // meaningful exactly when deferral is happening.
    expect(worker.snapshot()).toMatchObject({
      runs: 1,
      pressureSkips: 1,
      lastError: null,
      backlogStale: true,
    });
    expect(onError).not.toHaveBeenCalled();
    await worker.close();
  });

  /**
   * The negative that makes the classification mean something. Broadening it to
   * catch every throw would make an unknown fault hot-retry every few seconds
   * forever, and the positive test above would still pass — so the boundary
   * needs its own assertion.
   */
  it('does not retry an unknown sweep failure', async () => {
    const { worker, timers, onError } = schedulerThrowFixture(new Error('store exploded'));

    await worker.runNow();

    expect(timers).toHaveLength(0);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(worker.snapshot()).toMatchObject({
      runs: 1,
      pressureSkips: 0,
      lastError: 'store exploded',
    });
    await worker.close();
  });

  /**
   * The classification exists at FOUR independent `await` boundaries inside a
   * sweep, and a single end-to-end test covers only whichever one it happens to
   * trigger — the other three can be deleted with the suite green. Each is
   * therefore driven separately here.
   *
   * The two enumeration boundaries and the two query boundaries also differ in
   * what they must preserve: the context-graph enumeration fails before a
   * rotation exists, so it defers outright, while the later three must yield
   * the rotation and keep the cursor.
   */
  type PressureSite = 'context-graph enumeration' | 'meta-graph enumeration'
    | 'candidate discovery' | 'the backlog probe';

  function serviceThrowingAt(site: PressureSite, error: unknown) {
    const store = new OxigraphStore();
    installPressureSwitch(store);
    const metaGraph = new GraphManager(store).sharedMemoryMetaUri(CG);
    const originalQuery = store.query.bind(store);
    vi.spyOn(store, 'query').mockImplementation(async (query, options) => {
      if (site === 'candidate discovery' && options?.source === 'agent.finalizedSwmCleanup.discover') {
        throw error;
      }
      if (site === 'the backlog probe' && options?.source === 'agent.finalizedSwmCleanup.backlog') {
        throw error;
      }
      return originalQuery(query, options);
    });
    return new FinalizedSwmCleanupService({
      store,
      writeLocks: new Map<string, Promise<void>>(),
      listContextGraphIds: async () => {
        if (site === 'context-graph enumeration') throw error;
        return [CG];
      },
      listSharedMemoryMetaGraphs: async () => {
        if (site === 'meta-graph enumeration') throw error;
        return [metaGraph];
      },
    });
  }

  const PRESSURE_SITES: PressureSite[] = [
    'context-graph enumeration',
    'meta-graph enumeration',
    'candidate discovery',
    'the backlog probe',
  ];

  it.each(PRESSURE_SITES)(
    'classifies a scheduler rejection raised at %s as a retryable deferral',
    async (site) => {
      const service = serviceThrowingAt(
        site,
        new StoreSchedulerBusyError('queue_full', 'background', 'agent.finalizedSwmCleanup'),
      );

      await expect(service.runSweep()).resolves.toMatchObject({
        pressureSkipped: true,
        stale: true,
        deletedItems: 0,
      });
    },
  );

  it.each(PRESSURE_SITES)(
    'lets an unknown failure at %s stay terminal',
    async (site) => {
      const service = serviceThrowingAt(site, new Error(`unknown failure at ${site}`));

      await expect(service.runSweep()).rejects.toThrow(`unknown failure at ${site}`);
    },
  );

  /**
   * A converted throw must behave like a pressure yield, not merely return the
   * right shape: the context graph it interrupted has to be re-measured whole
   * on the next slice. Committing its partial contribution would double-count
   * it on resume — the same defect the rotation accumulator exists to prevent,
   * arriving through the error path instead of the gate.
   */
  it('re-measures an interrupted context graph whole after a converted rejection', async () => {
    const store = new OxigraphStore();
    installPressureSwitch(store);
    const graphManager = new GraphManager(store);
    const rootMeta = graphManager.sharedMemoryMetaUri(CG);
    const subMeta = graphManager.sharedMemoryMetaUri(CG, 'named');
    const marker = (label: string, graph: string) => ([
      { subject: `urn:dkg:finalized-swm-cleanup:${label}`, predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: 'http://dkg.io/ontology/FinalizedSwmCleanupTask', graph },
      { subject: `urn:dkg:finalized-swm-cleanup:${label}`, predicate: 'http://dkg.io/ontology/finalizedSwmCleanupRoot', object: JSON.stringify(`0x${'11'.repeat(32)}`), graph },
    ]);
    await store.insert([...marker('a', rootMeta), ...marker('b', subMeta)]);

    let backlogReads = 0;
    const originalQuery = store.query.bind(store);
    vi.spyOn(store, 'query').mockImplementation(async (query, options) => {
      if (options?.source === 'agent.finalizedSwmCleanup.backlog') {
        backlogReads += 1;
        // Interrupt AFTER the first meta graph has been measured, so a
        // partial contribution exists to be wrongly committed.
        if (backlogReads === 2) {
          throw new StoreSchedulerBusyError('queue_full', 'background', 'agent.finalizedSwmCleanup.backlog');
        }
      }
      return originalQuery(query, options);
    });

    const service = new FinalizedSwmCleanupService({
      store,
      writeLocks: new Map<string, Promise<void>>(),
      listContextGraphIds: async () => [CG],
      listSharedMemoryMetaGraphs: async () => [rootMeta, subMeta],
    });

    await expect(service.runSweep()).resolves.toMatchObject({
      pressureSkipped: true,
      stale: true,
      // The one marker measured before the throw is NOT published.
      backlogDepth: 0,
    });

    await expect(service.runSweep()).resolves.toMatchObject({
      pressureSkipped: false,
      stale: false,
      // Two markers total — the interrupted graph re-measured whole, not three.
      backlogDepth: 2,
    });
  });
});
