import { describe, expect, it } from 'vitest';

import {
  RFC64_CATALOG_AUTHORITY_REFRESH_INTERVAL_MS_V1,
  Rfc64CatalogAuthorityRefreshLoopV1,
} from '../src/rfc64/catalog-authority-refresh-loop-v1.js';

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
      .toBe(RFC64_CATALOG_AUTHORITY_REFRESH_INTERVAL_MS_V1);

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
    expect(() => loop.start()).toThrow('RFC-64 catalog authority refresh loop is closed');
  });

  it('reports a failed context graph and continues the bounded pass', async () => {
    const failure = new Error('authority unavailable');
    const attempts: string[] = [];
    const reported: Array<Readonly<{ contextGraphId: string; error: unknown }>> = [];
    const loop = new Rfc64CatalogAuthorityRefreshLoopV1({
      readActiveContextGraphIds: () => ['cg-a', 'cg-b'],
      refreshContextGraph: async (contextGraphId) => {
        attempts.push(contextGraphId);
        if (contextGraphId === 'cg-a') throw failure;
      },
      onRefreshFailure: (contextGraphId, error) => {
        reported.push(Object.freeze({ contextGraphId, error }));
      },
    });

    loop.trigger();
    await loop.whenIdle();
    expect(attempts).toEqual(['cg-a', 'cg-b']);
    expect(reported).toEqual([{ contextGraphId: 'cg-a', error: failure }]);
    await loop.close();
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
      refreshContextGraph: async (contextGraphId, signal) => {
        attempts.push(contextGraphId);
        activeSignal = signal;
        signal.addEventListener('abort', markAborted, { once: true });
        markStarted();
        // Deliberately ignore cancellation until the physical operation retires.
        await retirement;
        if (signal.aborted) throw signal.reason;
      },
      onRefreshFailure: (contextGraphId, error) => {
        reported.push(Object.freeze({ contextGraphId, error }));
      },
      scheduler,
    });

    loop.start();
    scheduled[0]!.callback();
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
});
