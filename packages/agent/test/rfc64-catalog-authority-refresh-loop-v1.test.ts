import { describe, expect, it } from 'vitest';

import { Rfc64CatalogAuthorityRefreshLoopV1 } from
  '../src/rfc64/catalog-authority-refresh-loop-v1.js';
import { RFC64_CATALOG_AUTHORITY_REFRESH_POLICY_V1 } from
  '../src/rfc64/catalog-authority-config-v1.js';

function createSchedulerHarness() {
  const scheduled: Array<Readonly<{
    callback: () => void;
    intervalMs: number;
    handle: ReturnType<typeof setInterval>;
  }>> = [];
  const cleared: Array<ReturnType<typeof setInterval>> = [];
  return {
    scheduled,
    cleared,
    scheduler: {
      setInterval(callback: () => void, intervalMs: number) {
        const handle = Object.freeze({ ordinal: scheduled.length + 1 }) as unknown as
          ReturnType<typeof setInterval>;
        scheduled.push(Object.freeze({ callback, intervalMs, handle }));
        return handle;
      },
      clearInterval(handle: ReturnType<typeof setInterval>) {
        cleared.push(handle);
      },
    },
  };
}

describe('RFC-64 catalog authority refresh loop', () => {
  it('reports an active-set read failure and retries on the next tick', async () => {
    const { scheduled, scheduler } = createSchedulerHarness();
    const failure = new Error('catalog responsibility read failed');
    const readFailures: unknown[] = [];
    const attempts: string[] = [];
    let failRead = true;
    const loop = new Rfc64CatalogAuthorityRefreshLoopV1({
      readActiveContextGraphIds: () => {
        if (failRead) {
          failRead = false;
          throw failure;
        }
        return ['cg-a'];
      },
      onActiveContextGraphIdsReadFailure: (error) => { readFailures.push(error); },
      refreshContextGraph: async (contextGraphId) => { attempts.push(contextGraphId); },
      onRefreshFailure: () => undefined,
      scheduler,
    });

    loop.start();
    await loop.whenIdle();
    expect(readFailures).toEqual([failure]);
    expect(attempts).toEqual([]);

    scheduled[0]!.callback();
    await loop.whenIdle();
    expect(readFailures).toEqual([failure]);
    expect(attempts).toEqual(['cg-a']);
    await loop.close();
  });

  it('keeps fixed cadence, drops overlapping ticks, and clears its exact handle', async () => {
    const { scheduled, cleared, scheduler } = createSchedulerHarness();
    let releaseFirst!: () => void;
    let markFirstStarted!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve; });
    let calls = 0;
    let active = 0;
    let peak = 0;
    const loop = new Rfc64CatalogAuthorityRefreshLoopV1({
      readActiveContextGraphIds: () => ['cg-a'],
      onActiveContextGraphIdsReadFailure: () => undefined,
      refreshContextGraph: async () => {
        calls += 1;
        active += 1;
        peak = Math.max(peak, active);
        markFirstStarted();
        await firstGate;
        active -= 1;
      },
      onRefreshFailure: () => undefined,
      scheduler,
    });

    loop.start();
    loop.start();
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]?.intervalMs)
      .toBe(RFC64_CATALOG_AUTHORITY_REFRESH_POLICY_V1.intervalMs);

    scheduled[0]!.callback();
    await firstStarted;
    scheduled[0]!.callback();
    expect(calls).toBe(1);

    releaseFirst();
    await loop.whenIdle();
    expect(calls).toBe(1);
    scheduled[0]!.callback();
    await loop.whenIdle();
    expect(calls).toBe(2);
    expect(peak).toBe(1);

    await loop.close();
    await loop.close();
    expect(cleared).toEqual([scheduled[0]!.handle]);
    scheduled[0]!.callback();
    await loop.whenIdle();
    expect(calls).toBe(2);

    loop.start();
    await loop.whenIdle();
    expect(scheduled).toHaveLength(2);
    expect(scheduled[1]!.handle).not.toBe(scheduled[0]!.handle);
    expect(calls).toBe(3);
    await loop.close();
    expect(cleared).toEqual([scheduled[0]!.handle, scheduled[1]!.handle]);
  });

  it('reports a failed context graph and continues the bounded pass', async () => {
    const failure = new Error('authority unavailable');
    const attempts: string[] = [];
    const reported: Array<Readonly<{ contextGraphId: string; error: unknown }>> = [];
    const loop = new Rfc64CatalogAuthorityRefreshLoopV1({
      readActiveContextGraphIds: () => ['cg-a', 'cg-b'],
      onActiveContextGraphIdsReadFailure: () => undefined,
      refreshContextGraph: async (contextGraphId) => {
        attempts.push(contextGraphId);
        if (contextGraphId === 'cg-a') throw failure;
      },
      onRefreshFailure: (contextGraphId, error) => {
        reported.push(Object.freeze({ contextGraphId, error }));
      },
    });

    loop.start();
    await loop.whenIdle();
    expect(attempts).toEqual(['cg-a', 'cg-b']);
    expect(reported).toEqual([{ contextGraphId: 'cg-a', error: failure }]);
    await loop.close();
  });

  it('keeps healthy lanes refreshing while another graph remains stalled', async () => {
    const { scheduled, scheduler } = createSchedulerHarness();
    let releaseStalled!: () => void;
    let markStalledStarted!: () => void;
    const stalledGate = new Promise<void>((resolve) => { releaseStalled = resolve; });
    const stalledStarted = new Promise<void>((resolve) => { markStalledStarted = resolve; });
    let healthyCalls = 0;
    let markHealthyRefreshed!: () => void;
    let healthyRefreshed = new Promise<void>((resolve) => { markHealthyRefreshed = resolve; });
    const loop = new Rfc64CatalogAuthorityRefreshLoopV1({
      readActiveContextGraphIds: () => ['cg-a', 'cg-b'],
      onActiveContextGraphIdsReadFailure: () => undefined,
      refreshContextGraph: async (contextGraphId) => {
        if (contextGraphId === 'cg-a') {
          markStalledStarted();
          await stalledGate;
          return;
        }
        healthyCalls += 1;
        markHealthyRefreshed();
      },
      onRefreshFailure: () => undefined,
      scheduler,
      maxConcurrentReads: 2,
    });

    loop.start();
    await Promise.all([stalledStarted, healthyRefreshed]);
    expect(healthyCalls).toBe(1);
    // Let the healthy lane publish its physical-idle transition before the
    // next cadence callback requests another pass.
    await new Promise<void>((resolve) => { setTimeout(resolve, 0); });

    healthyRefreshed = new Promise<void>((resolve) => { markHealthyRefreshed = resolve; });
    scheduled[0]!.callback();
    await healthyRefreshed;
    expect(healthyCalls).toBe(2);

    let closeSettled = false;
    const closing = loop.close().then(() => { closeSettled = true; });
    await Promise.resolve();
    expect(closeSettled).toBe(false);
    releaseStalled();
    await closing;
  });

  it('bounds independent lanes without letting one stalled graph own the queue', async () => {
    let releaseA!: () => void;
    let releaseB!: () => void;
    let markAStarted!: () => void;
    let markBStarted!: () => void;
    let markCStarted!: () => void;
    const gateA = new Promise<void>((resolve) => { releaseA = resolve; });
    const gateB = new Promise<void>((resolve) => { releaseB = resolve; });
    const startedA = new Promise<void>((resolve) => { markAStarted = resolve; });
    const startedB = new Promise<void>((resolve) => { markBStarted = resolve; });
    const startedC = new Promise<void>((resolve) => { markCStarted = resolve; });
    const attempts: string[] = [];
    const loop = new Rfc64CatalogAuthorityRefreshLoopV1({
      readActiveContextGraphIds: () => ['cg-a', 'cg-b', 'cg-c'],
      onActiveContextGraphIdsReadFailure: () => undefined,
      refreshContextGraph: async (contextGraphId) => {
        attempts.push(contextGraphId);
        if (contextGraphId === 'cg-a') {
          markAStarted();
          await gateA;
        } else if (contextGraphId === 'cg-b') {
          markBStarted();
          await gateB;
        } else {
          markCStarted();
        }
      },
      onRefreshFailure: () => undefined,
      maxConcurrentReads: 2,
    });

    loop.start();
    await Promise.all([startedA, startedB]);
    expect(attempts).toEqual(['cg-a', 'cg-b']);
    releaseB();
    await startedC;
    expect(attempts).toEqual(['cg-a', 'cg-b', 'cg-c']);

    const closing = loop.close();
    releaseA();
    await closing;
  });

  it('aborts and physically drains an in-flight pass before close settles', async () => {
    const { scheduled, cleared, scheduler } = createSchedulerHarness();
    let markStarted!: () => void;
    let markAborted!: () => void;
    let releaseRetirement!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const aborted = new Promise<void>((resolve) => { markAborted = resolve; });
    const retirement = new Promise<void>((resolve) => { releaseRetirement = resolve; });
    const attempts: string[] = [];
    const reported: Array<Readonly<{ contextGraphId: string; error: unknown }>> = [];
    let activeSignal: AbortSignal | undefined;
    const loop = new Rfc64CatalogAuthorityRefreshLoopV1({
      readActiveContextGraphIds: () => ['cg-a', 'cg-b'],
      onActiveContextGraphIdsReadFailure: () => undefined,
      refreshContextGraph: async (contextGraphId, signal) => {
        attempts.push(contextGraphId);
        activeSignal = signal;
        signal.addEventListener('abort', markAborted, { once: true });
        markStarted();
        // Deliberately ignore cancellation and resolve successfully only when
        // the physical operation retires. The loop, not this stub, must fence
        // the next context graph after shutdown begins.
        await retirement;
      },
      onRefreshFailure: (contextGraphId, error) => {
        reported.push(Object.freeze({ contextGraphId, error }));
      },
      scheduler,
      maxConcurrentReads: 1,
    });

    loop.start();
    await started;
    let closeSettled = false;
    const close = loop.close().then(() => { closeSettled = true; });
    await aborted;

    expect(activeSignal?.aborted).toBe(true);
    expect(activeSignal?.reason).toMatchObject({
      message: 'RFC-64 authority refresh stopped during agent shutdown',
    });
    await Promise.resolve();
    expect(closeSettled).toBe(false);
    releaseRetirement();
    await close;

    expect(attempts).toEqual(['cg-a']);
    expect(reported).toEqual([]);
    expect(cleared).toEqual([scheduled[0]!.handle]);
  });

  it('retires lanes that leave the active responsibility set and recreates them on return', async () => {
    const { scheduled, scheduler } = createSchedulerHarness();
    let activeContextGraphIds = ['cg-a'];
    let releaseFirst!: () => void;
    let markFirstStarted!: () => void;
    let markFirstAborted!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve; });
    const firstAborted = new Promise<void>((resolve) => { markFirstAborted = resolve; });
    const attempts: string[] = [];
    const loop = new Rfc64CatalogAuthorityRefreshLoopV1({
      readActiveContextGraphIds: () => activeContextGraphIds,
      onActiveContextGraphIdsReadFailure: () => undefined,
      refreshContextGraph: async (contextGraphId, signal) => {
        attempts.push(contextGraphId);
        if (attempts.length !== 1) return;
        signal.addEventListener('abort', markFirstAborted, { once: true });
        markFirstStarted();
        // A non-cooperative physical read must still be drained after its lane
        // is no longer part of the desired responsibility set.
        await firstGate;
      },
      onRefreshFailure: () => undefined,
      scheduler,
      maxConcurrentReads: 1,
    });

    loop.start();
    await firstStarted;
    activeContextGraphIds = [];
    scheduled[0]!.callback();
    await firstAborted;
    let idleSettled = false;
    const idle = loop.whenIdle().then(() => { idleSettled = true; });
    await Promise.resolve();
    expect(idleSettled).toBe(false);
    releaseFirst();
    await idle;

    activeContextGraphIds = ['cg-a'];
    scheduled[0]!.callback();
    await loop.whenIdle();
    expect(attempts).toEqual(['cg-a', 'cg-a']);
    await loop.close();
  });
});
