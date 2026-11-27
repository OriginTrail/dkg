import type {
  ContextGraphAuthorityIndexId,
  ContextGraphAuthoritySnapshot,
} from '@origintrail-official/dkg-chain';
import { describe, expect, it, vi } from 'vitest';

import {
  Rfc64CatalogAuthorityRefreshLoopV1,
  Rfc64CatalogAuthorityRevisionReadFailureV1,
  type Rfc64CatalogAuthorityRevisionReadV1,
  type Rfc64CatalogAuthorityRevisionSourceV1,
} from
  '../src/rfc64/catalog-authority-refresh-loop-v1.js';
import { RFC64_CATALOG_AUTHORITY_REFRESH_POLICY_V1 } from
  '../src/rfc64/catalog-authority-config-v1.js';
import { Rfc64FinalizedAuthoritySnapshotBatchRuntimeV1 } from
  '../src/rfc64/finalized-authority-snapshot-batch-runtime-v1.js';

const COMMITTED = 'committed' as const;
const SUPERSEDED = 'superseded' as const;

function createSchedulerHarness() {
  const scheduled: Array<Readonly<{
    callback: () => void;
    intervalMs: number;
    handle: ReturnType<typeof setInterval>;
  }>> = [];
  const cleared: Array<ReturnType<typeof setInterval>> = [];
  const timeouts: Array<Readonly<{
    callback: () => void;
    delayMs: number;
    handle: ReturnType<typeof setTimeout>;
  }>> = [];
  const clearedTimeouts: Array<ReturnType<typeof setTimeout>> = [];
  return {
    scheduled,
    cleared,
    timeouts,
    clearedTimeouts,
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
      setTimeout(callback: () => void, delayMs: number) {
        const handle = Object.freeze({ timeout: timeouts.length + 1 }) as unknown as
          ReturnType<typeof setTimeout>;
        timeouts.push(Object.freeze({ callback, delayMs, handle }));
        return handle;
      },
      clearTimeout(handle: ReturnType<typeof setTimeout>) {
        clearedTimeouts.push(handle);
      },
    },
  };
}

const FINALIZED_ABSENCE = Object.freeze({ kind: 'finalized-absence' as const });

function finalizedAbsenceFor(
  contextGraphIds: readonly string[],
): ReadonlyMap<string, typeof FINALIZED_ABSENCE> {
  return new Map(contextGraphIds.map((contextGraphId) => [
    contextGraphId,
    FINALIZED_ABSENCE,
  ]));
}

/** Let promise chains that settled outside the loop's own awaits run out. */
async function settleEventLoopTurns(): Promise<void> {
  await new Promise<void>((resolve) => { setImmediate(resolve); });
  await new Promise<void>((resolve) => { setImmediate(resolve); });
}

function completeRevisionRead(
  revisions: ReadonlyMap<string, string>,
): Rfc64CatalogAuthorityRevisionReadV1 {
  return revisions;
}

function revisionSource(
  read: Rfc64CatalogAuthorityRevisionSourceV1['read'],
  whenIdle: Rfc64CatalogAuthorityRevisionSourceV1['whenIdle'] = async () => undefined,
): Rfc64CatalogAuthorityRevisionSourceV1 {
  return Object.freeze({ read, whenIdle });
}

describe('RFC-64 catalog authority refresh loop', () => {
  it.each([
    ['STORE_OPERATION_TIMEOUT', 'Managed Oxigraph is recovering; query was not started'],
    ['STORE_SCHEDULER_BUSY', 'Store scheduler queue full (normal: sparql-http.query)'],
  ])('single-flights 128 lanes and trips one selector generation on %s', async (
    code,
    message,
  ) => {
    const { scheduled, scheduler } = createSchedulerHarness();
    const contextGraphIds = Array.from({ length: 128 }, (_, index) => `cg-${index}`);
    const failures: Array<readonly [string, unknown]> = [];
    const attempts: string[] = [];
    let firstGeneration = true;
    let active = 0;
    let peak = 0;
    const loop = new Rfc64CatalogAuthorityRefreshLoopV1({
      readActiveContextGraphIds: () => contextGraphIds,
      onActiveContextGraphIdsReadFailure: () => undefined,
      refreshContextGraph: async (contextGraphId) => {
        attempts.push(contextGraphId);
        active += 1;
        peak = Math.max(peak, active);
        await Promise.resolve();
        active -= 1;
        if (firstGeneration) {
          throw Object.assign(new Error(message), {
            code,
            retryable: true,
            outcome: 'not_started',
          });
        }
        return COMMITTED;
      },
      onRefreshFailure: (contextGraphId, error) => {
        failures.push([contextGraphId, error]);
      },
      scheduler,
    });

    loop.start();
    await loop.whenIdle();

    expect(attempts).toEqual(['cg-0']);
    expect(failures).toHaveLength(1);
    expect(peak).toBe(1);

    firstGeneration = false;
    scheduled[0]!.callback();
    await loop.whenIdle();

    expect(attempts.slice(1)).toEqual(contextGraphIds);
    expect(failures).toHaveLength(1);
    expect(peak).toBe(1);
    await loop.close();
  });

  it('does not trip peer lanes for a graph-specific authority failure', async () => {
    const { scheduler } = createSchedulerHarness();
    const attempts: string[] = [];
    const failures: string[] = [];
    let active = 0;
    let peak = 0;
    const loop = new Rfc64CatalogAuthorityRefreshLoopV1({
      readActiveContextGraphIds: () => ['cg-a', 'cg-b', 'cg-c'],
      onActiveContextGraphIdsReadFailure: () => undefined,
      refreshContextGraph: async (contextGraphId) => {
        attempts.push(contextGraphId);
        active += 1;
        peak = Math.max(peak, active);
        await Promise.resolve();
        active -= 1;
        if (contextGraphId === 'cg-a') throw new Error('invalid authority for cg-a');
        return COMMITTED;
      },
      onRefreshFailure: (contextGraphId) => { failures.push(contextGraphId); },
      scheduler,
    });

    loop.start();
    await loop.whenIdle();

    expect(attempts).toEqual(['cg-a', 'cg-b', 'cg-c']);
    expect(failures).toEqual(['cg-a']);
    expect(peak).toBe(1);
    await loop.close();
  });

  it('aborts one active refresh and drains queued lanes without starting them', async () => {
    const { scheduler } = createSchedulerHarness();
    const contextGraphIds = Array.from({ length: 128 }, (_, index) => `cg-${index}`);
    const attempts: string[] = [];
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const loop = new Rfc64CatalogAuthorityRefreshLoopV1({
      readActiveContextGraphIds: () => contextGraphIds,
      onActiveContextGraphIdsReadFailure: () => undefined,
      refreshContextGraph: async (contextGraphId, signal) => {
        attempts.push(contextGraphId);
        markStarted();
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
        return COMMITTED;
      },
      onRefreshFailure: () => undefined,
      scheduler,
    });

    loop.start();
    await started;
    await expect(loop.close()).resolves.toBeUndefined();

    expect(attempts).toEqual(['cg-0']);
  });

  it('rejects a request factory that omits a selected graph', async () => {
    const { scheduler } = createSchedulerHarness();
    const failures: unknown[] = [];
    const refreshContextGraph = vi.fn(async () => COMMITTED);
    const loop = new Rfc64CatalogAuthorityRefreshLoopV1({
      readActiveContextGraphIds: () => ['cg-a', 'cg-b'],
      authorityRevisionSource: revisionSource(async () => completeRevisionRead(new Map([
        ['cg-a', 'revision-1'],
        ['cg-b', 'revision-1'],
      ]))),
      onActiveContextGraphIdsReadFailure: () => undefined,
      onAuthorityRevisionsReadFailure: (error) => { failures.push(error); },
      createRefreshRequests: async () => new Map([
        ['cg-a', Object.freeze({ kind: 'auto' as const })],
      ]),
      refreshContextGraph,
      onRefreshFailure: () => undefined,
      scheduler,
    });

    loop.start();
    await loop.whenIdle();

    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      message: expect.stringContaining('omitted selected Context Graph "cg-b"'),
    });
    expect(refreshContextGraph).not.toHaveBeenCalled();
    await loop.close();
  });

  it('performs one logical authority read per multi-graph pass and fences the next revision', async () => {
    const { scheduled, scheduler } = createSchedulerHarness();
    let revision = 'revision-1';
    const indexIds = new Map<string, ContextGraphAuthorityIndexId>([
      ['cg-a', '9' as ContextGraphAuthorityIndexId],
      ['cg-b', '10' as ContextGraphAuthorityIndexId],
    ]);
    const readSnapshots = vi.fn(async (
      targetIds: readonly ContextGraphAuthorityIndexId[],
    ) => new Map(targetIds.map((contextGraphId) => [contextGraphId, {
      chainId: '20430',
      governanceContract: '0x3333333333333333333333333333333333333333',
      contextGraphId,
      owner: '0x1111111111111111111111111111111111111111',
      active: true,
      accessPolicy: 0,
      publishPolicy: 1,
      publishAuthority: null,
      publishAuthorityAccountId: '0',
      participantAgents: [],
      nameHash: `0x${contextGraphId.padStart(64, '0')}`,
      ownershipEra: '0',
      policyVersion: '0',
      rosterVersion: '0',
      sourceBlockNumber: '42',
      sourceBlockHash: `0x${'44'.repeat(32)}`,
    } satisfies ContextGraphAuthoritySnapshot])));
    const authorityRuntime = new Rfc64FinalizedAuthoritySnapshotBatchRuntimeV1({
      readSnapshots,
    });
    const loop = new Rfc64CatalogAuthorityRefreshLoopV1({
      readActiveContextGraphIds: () => ['cg-a', 'cg-b'],
      authorityRevisionSource: revisionSource(async () => completeRevisionRead(new Map([
        ['cg-a', revision],
        ['cg-b', revision],
      ]))),
      onActiveContextGraphIdsReadFailure: () => undefined,
      createRefreshRequests: async (contextGraphIds, signal) => {
        const batch = authorityRuntime.createBatch(
          contextGraphIds.map((contextGraphId) => indexIds.get(contextGraphId)!),
        );
        return new Map(await Promise.all(contextGraphIds.map(async (contextGraphId) => [
          contextGraphId,
          {
            kind: 'finalized-evidence' as const,
            evidence: await batch.read(
              indexIds.get(contextGraphId)!,
              signal,
            ),
          },
        ] as const)));
      },
      refreshContextGraph: async (contextGraphId, _signal, request) => {
        expect(request.kind).toBe('finalized-evidence');
        if (request.kind !== 'finalized-evidence') throw new Error('expected evidence');
        expect(request.evidence).toMatchObject({
          contextGraphAuthorityIndexId: indexIds.get(contextGraphId),
        });
        return COMMITTED;
      },
      onRefreshFailure: () => undefined,
      scheduler,
    });

    loop.start();
    await loop.whenIdle();
    expect(readSnapshots).toHaveBeenCalledOnce();
    expect(readSnapshots).toHaveBeenLastCalledWith([
      '9' as ContextGraphAuthorityIndexId,
      '10' as ContextGraphAuthorityIndexId,
    ]);

    revision = 'revision-2';
    scheduled[0]!.callback();
    await loop.whenIdle();
    expect(readSnapshots).toHaveBeenCalledTimes(2);
    await loop.close();
  });

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

  it('single-flights healthy lanes behind a stalled store refresh', async () => {
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
    await stalledStarted;
    expect(healthyCalls).toBe(0);
    releaseStalled();
    await healthyRefreshed;
    expect(healthyCalls).toBe(1);
    await loop.whenIdle();

    healthyRefreshed = new Promise<void>((resolve) => { markHealthyRefreshed = resolve; });
    scheduled[0]!.callback();
    await healthyRefreshed;
    expect(healthyCalls).toBe(2);

    await loop.close();
  });

  it('serializes per-graph lanes through global store admission', async () => {
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
    await startedA;
    expect(attempts).toEqual(['cg-a']);
    releaseA();
    await startedB;
    expect(attempts).toEqual(['cg-a', 'cg-b']);
    releaseB();
    await startedC;
    expect(attempts).toEqual(['cg-a', 'cg-b', 'cg-c']);

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
      onActiveContextGraphIdsReadFailure: () => undefined,
      refreshContextGraph: async (contextGraphId, signal) => {
        attempts.push(contextGraphId);
        activeSignal = signal;
        signal.addEventListener('abort', markAborted, { once: true });
        markStarted();
        // Deliberately ignore cancellation and resolve successfully only when
        // the one admitted physical operation retires. Queued graph lanes
        // must be cancelled without starting store work.
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

    expect(attempts).toEqual(['cg-a']);
    expect(reported).toEqual([]);
    expect(cleared).toEqual([scheduled[0]!.handle]);
  });

  it('drains detached physical revision work before close settles', async () => {
    let markReadStarted!: () => void;
    let releasePhysicalRead!: () => void;
    const readStarted = new Promise<void>((resolve) => { markReadStarted = resolve; });
    const physicalRead = new Promise<void>((resolve) => { releasePhysicalRead = resolve; });
    const loop = new Rfc64CatalogAuthorityRefreshLoopV1({
      readActiveContextGraphIds: () => ['cg-a'],
      onActiveContextGraphIdsReadFailure: () => undefined,
      authorityRevisionSource: revisionSource(async (_contextGraphIds, signal) => {
        markReadStarted();
        return new Promise<Rfc64CatalogAuthorityRevisionReadV1>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      }, () => physicalRead),
      refreshContextGraph: async () => COMMITTED,
      onRefreshFailure: () => undefined,
    });

    loop.start();
    await readStarted;
    let closeSettled = false;
    const closing = loop.close().then(() => { closeSettled = true; });
    await Promise.resolve();
    expect(closeSettled).toBe(false);
    releasePhysicalRead();
    await closing;
    expect(closeSettled).toBe(true);
  });

  it('drains detached physical revision work before reporting idle', async () => {
    let markReadStarted!: () => void;
    let releasePhysicalRead!: () => void;
    const readStarted = new Promise<void>((resolve) => { markReadStarted = resolve; });
    const physicalRead = new Promise<void>((resolve) => { releasePhysicalRead = resolve; });
    const loop = new Rfc64CatalogAuthorityRefreshLoopV1({
      readActiveContextGraphIds: () => ['cg-a'],
      onActiveContextGraphIdsReadFailure: () => undefined,
      authorityRevisionSource: revisionSource(async () => {
        markReadStarted();
        throw new Error('revision selector timed out');
      }, () => physicalRead),
      refreshContextGraph: async () => COMMITTED,
      onRefreshFailure: () => undefined,
    });

    loop.start();
    await readStarted;
    let idleSettled = false;
    const idle = loop.whenIdle().then(() => { idleSettled = true; });
    await Promise.resolve();
    expect(idleSettled).toBe(false);
    releasePhysicalRead();
    await idle;
    expect(idleSettled).toBe(true);
    await loop.close();
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
      authorityRevisionSource: revisionSource(
        async () => completeRevisionRead(revisions),
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
      authorityRevisionSource: revisionSource(async () => completeRevisionRead(
        new Map([['registered', 'revision-1']]),
      )),
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
      authorityRevisionSource: revisionSource(async () => {
        reads += 1;
        if (reads === 1) {
          return completeRevisionRead(new Map([['cg-a', 'a-1'], ['cg-b', 'b-1']]));
        }
        throw failure;
      }),
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
      authorityRevisionSource: revisionSource(async () => {
        reads += 1;
        if (reads === 1) throw failure;
        return completeRevisionRead(new Map([
          ['cg-a', 'revision-a-1'],
          ['cg-b', 'revision-b-1'],
        ]));
      }),
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
      authorityRevisionSource: revisionSource(async () => completeRevisionRead(
        new Map([['cg-a', 'revision-1']]),
      )),
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
      authorityRevisionSource: revisionSource(async () => completeRevisionRead(
        new Map([['cg-a', 'revision-1']]),
      )),
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
      authorityRevisionSource: revisionSource(async () => completeRevisionRead(
        new Map([['cg-a', 'revision-1']]),
      )),
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
      authorityRevisionSource: revisionSource(async () => completeRevisionRead(
        new Map([['cg-a', revision]]),
      )),
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
      authorityRevisionSource: revisionSource(async () => {
        reads += 1;
        if (reads === 2) {
          markSecondReadStarted();
          await secondReadGate;
        }
        return completeRevisionRead(new Map([['cg-a', revision]]));
      }),
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

  it('contains mapped work after rejection but preserves known legacy refreshes', async () => {
    const { scheduled, scheduler } = createSchedulerHarness();
    const failure = new Error('shared index unavailable');
    const readFailures: unknown[] = [];
    const attempts: string[] = [];
    let reads = 0;
    const loop = new Rfc64CatalogAuthorityRefreshLoopV1({
      readActiveContextGraphIds: () => ['registered', 'unregistered'],
      onActiveContextGraphIdsReadFailure: () => undefined,
      authorityRevisionSource: revisionSource(async () => {
        reads += 1;
        if (reads > 1) {
          throw new Rfc64CatalogAuthorityRevisionReadFailureV1(
            failure,
            ['unregistered'],
          );
        }
        return completeRevisionRead(
          new Map([['registered', 'revision-1']]),
        );
      }),
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

    expect(attempts).toEqual(['registered', 'unregistered', 'unregistered']);
    expect(readFailures).toEqual([failure]);
    await loop.close();
  });

  it('gives a lane that was still refreshing at selection no request the pass did not create', async () => {
    // An unregistered public graph has no revision, so every pass selects it
    // unless its lane is busy. A pass that left it out, and whose finalized
    // read took longer than the lane's refresh, used to hand the idle lane an
    // `auto` request, and `auto` cannot consume an owner-signed replica seed.
    const { scheduler } = createSchedulerHarness();
    const refreshes: Array<readonly [string, string]> = [];
    let requestBatches = 0;
    let markFirstRefreshStarted!: () => void;
    let releaseFirstRefresh!: () => void;
    let markSecondBatchStarted!: () => void;
    let releaseSecondBatch!: () => void;
    const firstRefreshStarted = new Promise<void>((resolve) => {
      markFirstRefreshStarted = resolve;
    });
    const firstRefreshGate = new Promise<void>((resolve) => { releaseFirstRefresh = resolve; });
    const secondBatchStarted = new Promise<void>((resolve) => {
      markSecondBatchStarted = resolve;
    });
    const secondBatchGate = new Promise<void>((resolve) => { releaseSecondBatch = resolve; });
    const loop = new Rfc64CatalogAuthorityRefreshLoopV1({
      readActiveContextGraphIds: () => ['public-replica'],
      onActiveContextGraphIdsReadFailure: () => undefined,
      createRefreshRequests: async (contextGraphIds) => {
        requestBatches += 1;
        if (requestBatches === 2) {
          markSecondBatchStarted();
          await secondBatchGate;
        }
        return finalizedAbsenceFor(contextGraphIds);
      },
      refreshContextGraph: async (contextGraphId, _signal, request) => {
        refreshes.push([contextGraphId, request.kind]);
        if (refreshes.length === 1) {
          markFirstRefreshStarted();
          await firstRefreshGate;
        }
        return COMMITTED;
      },
      onRefreshFailure: () => undefined,
      scheduler,
    });

    loop.start();
    await firstRefreshStarted;
    // A lifecycle nudge while the lane is busy: the pass leaves the lane out
    // and waits for its finalized read, during which the lane goes idle.
    loop.trigger();
    await secondBatchStarted;
    releaseFirstRefresh();
    await settleEventLoopTurns();
    releaseSecondBatch();
    await loop.whenIdle();

    expect(requestBatches).toBe(2);
    expect(refreshes).toEqual([['public-replica', 'finalized-absence']]);
    await loop.close();
  });

  it('retries a failed graph from its own timer and asks for that graph only', async () => {
    const { timeouts, scheduler } = createSchedulerHarness();
    const requestBatches: string[][] = [];
    const attempts: string[] = [];
    const failures: string[] = [];
    let failReplica = true;
    const loop = new Rfc64CatalogAuthorityRefreshLoopV1({
      readActiveContextGraphIds: () => ['public-replica', 'healthy'],
      onActiveContextGraphIdsReadFailure: () => undefined,
      createRefreshRequests: async (contextGraphIds) => {
        requestBatches.push([...contextGraphIds]);
        return finalizedAbsenceFor(contextGraphIds);
      },
      refreshContextGraph: async (contextGraphId) => {
        attempts.push(contextGraphId);
        if (contextGraphId === 'public-replica' && failReplica) {
          throw new Error('authority composition failed');
        }
        return COMMITTED;
      },
      onRefreshFailure: (contextGraphId) => { failures.push(contextGraphId); },
      scheduler,
    });

    loop.start();
    await loop.whenIdle();
    expect(failures).toEqual(['public-replica']);
    expect(timeouts.map(({ delayMs }) => delayMs)).toEqual([1_000]);

    // No lifecycle nudge and no interval tick: the retry alone brings it back.
    failReplica = false;
    timeouts[0]!.callback();
    await loop.whenIdle();

    expect(requestBatches).toEqual([['public-replica', 'healthy'], ['public-replica']]);
    expect(attempts).toEqual(['public-replica', 'healthy', 'public-replica']);
    expect(failures).toEqual(['public-replica']);
    expect(timeouts).toHaveLength(1);
    await loop.close();
  });

  it('bounds the retries of a graph that keeps failing and starts over after a commit', async () => {
    const { scheduled, timeouts, clearedTimeouts, scheduler } = createSchedulerHarness();
    const attempts: string[] = [];
    let fail = true;
    const loop = new Rfc64CatalogAuthorityRefreshLoopV1({
      readActiveContextGraphIds: () => ['public-replica'],
      onActiveContextGraphIdsReadFailure: () => undefined,
      createRefreshRequests: async (contextGraphIds) => finalizedAbsenceFor(contextGraphIds),
      refreshContextGraph: async (contextGraphId) => {
        attempts.push(contextGraphId);
        if (fail) throw new Error('no authenticated owner authority');
        return COMMITTED;
      },
      onRefreshFailure: () => undefined,
      scheduler,
    });

    loop.start();
    await loop.whenIdle();
    for (let retry = 0; retry < RFC64_CATALOG_AUTHORITY_REFRESH_POLICY_V1.failureRetryDelaysMs.length; retry += 1) {
      timeouts[retry]!.callback();
      await loop.whenIdle();
    }
    expect(timeouts.map(({ delayMs }) => delayMs))
      .toEqual([...RFC64_CATALOG_AUTHORITY_REFRESH_POLICY_V1.failureRetryDelaysMs]);
    expect(attempts).toHaveLength(4);

    // Once the retries are spent, a failure waits for an ordinary pass.
    scheduled[0]!.callback();
    await loop.whenIdle();
    expect(attempts).toHaveLength(5);
    expect(timeouts).toHaveLength(3);

    fail = false;
    scheduled[0]!.callback();
    await loop.whenIdle();
    expect(attempts).toHaveLength(6);

    fail = true;
    scheduled[0]!.callback();
    await loop.whenIdle();
    expect(timeouts).toHaveLength(4);
    expect(timeouts[3]!.delayMs).toBe(RFC64_CATALOG_AUTHORITY_REFRESH_POLICY_V1.failureRetryDelaysMs[0]);

    await loop.close();
    expect(clearedTimeouts).toEqual([timeouts[3]!.handle]);
    timeouts[3]!.callback();
    expect(attempts).toHaveLength(7);
  });

  it('keeps retrying when a superseded refresh or a failed request batch leaves the graph unresolved', async () => {
    const { timeouts, scheduler } = createSchedulerHarness();
    const readFailures: unknown[] = [];
    let refreshResult: 'fail' | typeof SUPERSEDED | typeof COMMITTED = 'fail';
    let failBatch = false;
    const loop = new Rfc64CatalogAuthorityRefreshLoopV1({
      readActiveContextGraphIds: () => ['public-replica'],
      onActiveContextGraphIdsReadFailure: () => undefined,
      onAuthorityRevisionsReadFailure: (error) => { readFailures.push(error); },
      createRefreshRequests: async (contextGraphIds) => {
        if (failBatch) throw new Error('finalized index unavailable');
        return finalizedAbsenceFor(contextGraphIds);
      },
      refreshContextGraph: async () => {
        if (refreshResult === 'fail') throw new Error('authority composition failed');
        return refreshResult;
      },
      onRefreshFailure: () => undefined,
      scheduler,
    });

    loop.start();
    await loop.whenIdle();
    refreshResult = SUPERSEDED;
    timeouts[0]!.callback();
    await loop.whenIdle();
    expect(timeouts.map(({ delayMs }) => delayMs)).toEqual([1_000, 5_000]);

    failBatch = true;
    timeouts[1]!.callback();
    await loop.whenIdle();
    expect(readFailures).toHaveLength(1);
    expect(timeouts.map(({ delayMs }) => delayMs)).toEqual([1_000, 5_000, 30_000]);

    failBatch = false;
    refreshResult = COMMITTED;
    timeouts[2]!.callback();
    await loop.whenIdle();
    expect(timeouts).toHaveLength(3);
    await loop.close();
  });

  it('drops the pending retry of a graph that leaves the active set', async () => {
    const { timeouts, clearedTimeouts, scheduler } = createSchedulerHarness();
    let active = ['public-replica'];
    const attempts: string[] = [];
    const loop = new Rfc64CatalogAuthorityRefreshLoopV1({
      readActiveContextGraphIds: () => active,
      onActiveContextGraphIdsReadFailure: () => undefined,
      refreshContextGraph: async (contextGraphId) => {
        attempts.push(contextGraphId);
        throw new Error('no authenticated owner authority');
      },
      onRefreshFailure: () => undefined,
      scheduler,
    });

    loop.start();
    await loop.whenIdle();
    expect(timeouts).toHaveLength(1);

    active = [];
    loop.trigger();
    await loop.whenIdle();
    expect(clearedTimeouts).toEqual([timeouts[0]!.handle]);

    // A timer that fires anyway after its graph left asks for nothing.
    timeouts[0]!.callback();
    await loop.whenIdle();
    expect(attempts).toEqual(['public-replica']);
    await loop.close();
  });
});
