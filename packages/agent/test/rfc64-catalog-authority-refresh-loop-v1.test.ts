import { describe, expect, it } from 'vitest';

import { Rfc64CatalogAuthorityRefreshLoopV1 } from
  '../src/rfc64/catalog-authority-refresh-loop-v1.js';
import type { Rfc64CatalogAuthorityRevisionReadV1 } from
  '../src/rfc64/catalog-authority-refresh-loop-v1.js';
import { RFC64_CATALOG_AUTHORITY_REFRESH_POLICY_V1 } from
  '../src/rfc64/catalog-authority-config-v1.js';

const COMMITTED = Object.freeze({ kind: 'committed' as const });
const SUPERSEDED = Object.freeze({ kind: 'superseded' as const });

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

function completeRevisionRead(
  revisions: ReadonlyMap<string, string>,
): Rfc64CatalogAuthorityRevisionReadV1 {
  return revisions;
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
      refreshContextGraph: async (contextGraphId) => {
        attempts.push(contextGraphId);
        return COMMITTED;
      },
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
        return COMMITTED;
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
        return COMMITTED;
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
          return COMMITTED;
        }
        healthyCalls += 1;
        markHealthyRefreshed();
        return COMMITTED;
      },
      onRefreshFailure: () => undefined,
      scheduler,
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

  it('delegates global admission while keeping per-graph lanes independent', async () => {
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
        return COMMITTED;
      },
      onRefreshFailure: () => undefined,
    });

    loop.start();
    await Promise.all([startedA, startedB, startedC]);
    expect(attempts).toEqual(['cg-a', 'cg-b', 'cg-c']);

    const closing = loop.close();
    releaseB();
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
        // the physical operation retires. Each per-graph lane must still be
        // physically drained before loop shutdown settles.
        await retirement;
        return COMMITTED;
      },
      onRefreshFailure: (contextGraphId, error) => {
        reported.push(Object.freeze({ contextGraphId, error }));
      },
      scheduler,
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

    expect(attempts).toEqual(['cg-a', 'cg-b']);
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
        if (attempts.length !== 1) return COMMITTED;
        signal.addEventListener('abort', markFirstAborted, { once: true });
        markFirstStarted();
        // A non-cooperative physical read must still be drained after its lane
        // is no longer part of the desired responsibility set.
        await firstGate;
        return COMMITTED;
      },
      onRefreshFailure: () => undefined,
      scheduler,
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

  it('refreshes only changed revisions between periodic safety passes', async () => {
    const { scheduled, scheduler } = createSchedulerHarness();
    let revisions = new Map([
      ['cg-a', 'revision-a-1'],
      ['cg-b', 'revision-b-1'],
    ]);
    const attempts: string[] = [];
    const loop = new Rfc64CatalogAuthorityRefreshLoopV1({
      readActiveContextGraphIds: () => ['cg-a', 'cg-b'],
      onActiveContextGraphIdsReadFailure: () => undefined,
      readAuthorityRevisions: async () => completeRevisionRead(revisions),
      refreshContextGraph: async (contextGraphId) => {
        attempts.push(contextGraphId);
        return COMMITTED;
      },
      onRefreshFailure: () => undefined,
      scheduler,
    });

    loop.start();
    await loop.whenIdle();
    expect(attempts).toEqual(['cg-a', 'cg-b']);

    scheduled[0]!.callback();
    await loop.whenIdle();
    expect(attempts).toEqual(['cg-a', 'cg-b']);

    revisions = new Map([
      ['cg-a', 'revision-a-2'],
      ['cg-b', 'revision-b-1'],
    ]);
    scheduled[0]!.callback();
    await loop.whenIdle();
    expect(attempts).toEqual(['cg-a', 'cg-b', 'cg-a']);

    // Three ordinary intervals after startup retain a full revalidation
    // before the four-interval freshness deadline.
    scheduled[0]!.callback();
    await loop.whenIdle();
    expect(attempts).toEqual(['cg-a', 'cg-b', 'cg-a', 'cg-a', 'cg-b']);
    await loop.close();
  });

  it('keeps unindexed responsibilities on the legacy every-pass path', async () => {
    const { scheduled, scheduler } = createSchedulerHarness();
    const attempts: string[] = [];
    const loop = new Rfc64CatalogAuthorityRefreshLoopV1({
      readActiveContextGraphIds: () => ['registered', 'unregistered'],
      onActiveContextGraphIdsReadFailure: () => undefined,
      readAuthorityRevisions: async () => completeRevisionRead(
        new Map([['registered', 'revision-1']]),
      ),
      refreshContextGraph: async (contextGraphId) => {
        attempts.push(contextGraphId);
        return COMMITTED;
      },
      onRefreshFailure: () => undefined,
      scheduler,
    });

    loop.start();
    await loop.whenIdle();
    scheduled[0]!.callback();
    await loop.whenIdle();
    expect(attempts).toEqual(['registered', 'unregistered', 'unregistered']);
    await loop.close();
  });

  it('contains a failed ordinary delta scan but preserves full safety revalidation', async () => {
    const { scheduled, scheduler } = createSchedulerHarness();
    const failure = new Error('shared index unavailable');
    const readFailures: unknown[] = [];
    const attempts: string[] = [];
    let reads = 0;
    const loop = new Rfc64CatalogAuthorityRefreshLoopV1({
      readActiveContextGraphIds: () => ['cg-a', 'cg-b'],
      onActiveContextGraphIdsReadFailure: () => undefined,
      readAuthorityRevisions: async () => {
        reads += 1;
        if (reads === 1) {
          return completeRevisionRead(new Map([['cg-a', 'a-1'], ['cg-b', 'b-1']]));
        }
        throw failure;
      },
      onAuthorityRevisionsReadFailure: (error) => { readFailures.push(error); },
      refreshContextGraph: async (contextGraphId) => {
        attempts.push(contextGraphId);
        return COMMITTED;
      },
      onRefreshFailure: () => undefined,
      scheduler,
    });

    loop.start();
    await loop.whenIdle();
    scheduled[0]!.callback();
    await loop.whenIdle();
    scheduled[0]!.callback();
    await loop.whenIdle();
    expect(attempts).toEqual(['cg-a', 'cg-b']);
    expect(readFailures).toEqual([failure, failure]);

    scheduled[0]!.callback();
    await loop.whenIdle();
    expect(attempts).toEqual(['cg-a', 'cg-b', 'cg-a', 'cg-b']);
    expect(readFailures).toEqual([failure, failure, failure]);
    await loop.close();
  });

  it('falls back to a full first pass after revision rejection, then suppresses unchanged work', async () => {
    const { scheduled, scheduler } = createSchedulerHarness();
    const failure = new Error('first authority index scan failed');
    const readFailures: unknown[] = [];
    const attempts: string[] = [];
    let reads = 0;
    const loop = new Rfc64CatalogAuthorityRefreshLoopV1({
      readActiveContextGraphIds: () => ['cg-a', 'cg-b'],
      onActiveContextGraphIdsReadFailure: () => undefined,
      readAuthorityRevisions: async () => {
        reads += 1;
        if (reads === 1) throw failure;
        return completeRevisionRead(new Map([
          ['cg-a', 'revision-a-1'],
          ['cg-b', 'revision-b-1'],
        ]));
      },
      onAuthorityRevisionsReadFailure: (error) => { readFailures.push(error); },
      refreshContextGraph: async (contextGraphId) => {
        attempts.push(contextGraphId);
        return COMMITTED;
      },
      onRefreshFailure: () => undefined,
      scheduler,
    });

    loop.start();
    await loop.whenIdle();
    expect(attempts).toEqual(['cg-a', 'cg-b']);
    expect(readFailures).toEqual([failure]);

    scheduled[0]!.callback();
    await loop.whenIdle();
    expect(attempts).toEqual(['cg-a', 'cg-b', 'cg-a', 'cg-b']);

    scheduled[0]!.callback();
    await loop.whenIdle();
    expect(attempts).toEqual(['cg-a', 'cg-b', 'cg-a', 'cg-b']);
    await loop.close();
  });

  it('retries an unchanged revision until the selected refresh commits', async () => {
    const { scheduled, scheduler } = createSchedulerHarness();
    const failure = new Error('authority refresh failed');
    const reported: unknown[] = [];
    let calls = 0;
    const loop = new Rfc64CatalogAuthorityRefreshLoopV1({
      readActiveContextGraphIds: () => ['cg-a'],
      onActiveContextGraphIdsReadFailure: () => undefined,
      readAuthorityRevisions: async () => completeRevisionRead(
        new Map([['cg-a', 'revision-1']]),
      ),
      refreshContextGraph: async () => {
        calls += 1;
        if (calls === 1) throw failure;
        return COMMITTED;
      },
      onRefreshFailure: (_contextGraphId, error) => { reported.push(error); },
      scheduler,
    });

    loop.start();
    await loop.whenIdle();
    expect(calls).toBe(1);
    expect(reported).toEqual([failure]);

    scheduled[0]!.callback();
    await loop.whenIdle();
    expect(calls).toBe(2);

    scheduled[0]!.callback();
    await loop.whenIdle();
    expect(calls).toBe(2);
    await loop.close();
  });

  it('does not accept a fulfilled refresh that reports no authority commit', async () => {
    const { scheduled, scheduler } = createSchedulerHarness();
    const outcomes = [SUPERSEDED, COMMITTED];
    let calls = 0;
    const loop = new Rfc64CatalogAuthorityRefreshLoopV1({
      readActiveContextGraphIds: () => ['cg-a'],
      onActiveContextGraphIdsReadFailure: () => undefined,
      readAuthorityRevisions: async () => completeRevisionRead(
        new Map([['cg-a', 'revision-1']]),
      ),
      refreshContextGraph: async () => outcomes[calls++]!,
      onRefreshFailure: () => undefined,
      scheduler,
    });

    loop.start();
    await loop.whenIdle();
    scheduled[0]!.callback();
    await loop.whenIdle();
    expect(calls).toBe(2);

    scheduled[0]!.callback();
    await loop.whenIdle();
    expect(calls).toBe(2);
    await loop.close();
  });

  it('retries an unchanged revision after a forced safety refresh is superseded', async () => {
    const { scheduled, scheduler } = createSchedulerHarness();
    const outcomes = [COMMITTED, SUPERSEDED, COMMITTED];
    let calls = 0;
    const loop = new Rfc64CatalogAuthorityRefreshLoopV1({
      readActiveContextGraphIds: () => ['cg-a'],
      onActiveContextGraphIdsReadFailure: () => undefined,
      readAuthorityRevisions: async () => completeRevisionRead(
        new Map([['cg-a', 'revision-1']]),
      ),
      refreshContextGraph: async () => outcomes[calls++]!,
      onRefreshFailure: () => undefined,
      scheduler,
    });

    loop.start();
    await loop.whenIdle();
    scheduled[0]!.callback();
    await loop.whenIdle();
    scheduled[0]!.callback();
    await loop.whenIdle();
    expect(calls).toBe(1);

    // The fourth pass is the forced safety revalidation. Its superseded
    // result clears suppression, so the next ordinary pass retries at once.
    scheduled[0]!.callback();
    await loop.whenIdle();
    expect(calls).toBe(2);
    scheduled[0]!.callback();
    await loop.whenIdle();
    expect(calls).toBe(3);
    await loop.close();
  });

  it('coalesces a newer revision observed during an in-flight refresh', async () => {
    const { scheduled, scheduler } = createSchedulerHarness();
    let revision = 'revision-1';
    let markFirstStarted!: () => void;
    let releaseFirst!: () => void;
    const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve; });
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let calls = 0;
    const loop = new Rfc64CatalogAuthorityRefreshLoopV1({
      readActiveContextGraphIds: () => ['cg-a'],
      onActiveContextGraphIdsReadFailure: () => undefined,
      readAuthorityRevisions: async () => completeRevisionRead(
        new Map([['cg-a', revision]]),
      ),
      refreshContextGraph: async () => {
        calls += 1;
        if (calls === 1) {
          markFirstStarted();
          await firstGate;
        }
        return COMMITTED;
      },
      onRefreshFailure: () => undefined,
      scheduler,
    });

    loop.start();
    await firstStarted;
    revision = 'revision-2';
    scheduled[0]!.callback();
    await Promise.resolve();
    expect(calls).toBe(1);
    releaseFirst();
    await loop.whenIdle();
    expect(calls).toBe(2);

    scheduled[0]!.callback();
    await loop.whenIdle();
    expect(calls).toBe(2);
    await loop.close();
  });

  it('fences pass activity that starts while existing lanes drain', async () => {
    const { scheduled, scheduler } = createSchedulerHarness();
    let revision = 'revision-1';
    let reads = 0;
    let markSecondReadStarted!: () => void;
    let releaseSecondRead!: () => void;
    const secondReadStarted = new Promise<void>((resolve) => {
      markSecondReadStarted = resolve;
    });
    const secondReadGate = new Promise<void>((resolve) => { releaseSecondRead = resolve; });
    let refreshes = 0;
    let markFirstRefreshStarted!: () => void;
    let releaseFirstRefresh!: () => void;
    let markSecondRefreshStarted!: () => void;
    let releaseSecondRefresh!: () => void;
    const firstRefreshStarted = new Promise<void>((resolve) => {
      markFirstRefreshStarted = resolve;
    });
    const firstRefreshGate = new Promise<void>((resolve) => { releaseFirstRefresh = resolve; });
    const secondRefreshStarted = new Promise<void>((resolve) => {
      markSecondRefreshStarted = resolve;
    });
    const secondRefreshGate = new Promise<void>((resolve) => { releaseSecondRefresh = resolve; });
    const loop = new Rfc64CatalogAuthorityRefreshLoopV1({
      readActiveContextGraphIds: () => ['cg-a'],
      onActiveContextGraphIdsReadFailure: () => undefined,
      readAuthorityRevisions: async () => {
        reads += 1;
        if (reads === 2) {
          markSecondReadStarted();
          await secondReadGate;
        }
        return completeRevisionRead(new Map([['cg-a', revision]]));
      },
      refreshContextGraph: async () => {
        refreshes += 1;
        if (refreshes === 1) {
          markFirstRefreshStarted();
          await firstRefreshGate;
        } else {
          markSecondRefreshStarted();
          await secondRefreshGate;
        }
        return COMMITTED;
      },
      onRefreshFailure: () => undefined,
      scheduler,
    });

    loop.start();
    await firstRefreshStarted;
    let idleSettled = false;
    const idle = loop.whenIdle().then(() => { idleSettled = true; });
    await Promise.resolve();

    revision = 'revision-2';
    scheduled[0]!.callback();
    await secondReadStarted;
    releaseFirstRefresh();
    await Promise.resolve();
    expect(idleSettled).toBe(false);

    releaseSecondRead();
    await secondRefreshStarted;
    expect(idleSettled).toBe(false);
    releaseSecondRefresh();
    await idle;
    expect(refreshes).toBe(2);
    await loop.close();
  });

  it('uses rejection as the sole shared-index read failure channel', async () => {
    const { scheduled, scheduler } = createSchedulerHarness();
    const failure = new Error('shared index unavailable');
    const readFailures: unknown[] = [];
    const attempts: string[] = [];
    let reads = 0;
    const loop = new Rfc64CatalogAuthorityRefreshLoopV1({
      readActiveContextGraphIds: () => ['registered', 'unregistered'],
      onActiveContextGraphIdsReadFailure: () => undefined,
      readAuthorityRevisions: async () => {
        reads += 1;
        if (reads > 1) throw failure;
        return completeRevisionRead(
          new Map([['registered', 'revision-1']]),
        );
      },
      onAuthorityRevisionsReadFailure: (error) => { readFailures.push(error); },
      refreshContextGraph: async (contextGraphId) => {
        attempts.push(contextGraphId);
        return COMMITTED;
      },
      onRefreshFailure: () => undefined,
      scheduler,
    });

    loop.start();
    await loop.whenIdle();
    scheduled[0]!.callback();
    await loop.whenIdle();

    expect(attempts).toEqual(['registered', 'unregistered']);
    expect(readFailures).toEqual([failure]);
    await loop.close();
  });
});
