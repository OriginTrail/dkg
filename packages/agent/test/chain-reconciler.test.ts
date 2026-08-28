import { describe, it, expect } from 'vitest';
import {
  reconcileContextGraph,
  VmReconcileDispatcher,
  RecentUalSet,
  type ChainReconcilerDeps,
  type OrdinalRecoveryTarget,
  type OrdinalOutcome,
} from '../src/chain-reconciler.js';
import {
  VmReconcileQueueClosedError,
  VmReconcileQueueFullError,
} from '../src/vm-reconcile-service.js';
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

function recoveryTarget(
  ordinal: number,
  overrides: Partial<OrdinalRecoveryTarget> = {},
): OrdinalRecoveryTarget {
  return {
    localCgId: 'cg',
    onChainCgId: '1',
    ordinal,
    ual: `did:dkg:base:84532/0x0000000000000000000000000000000000000001/${ordinal}`,
    merkleRoot: `0x${ordinal.toString(16).padStart(64, '0')}`,
    kaId: String(ordinal),
    reason: 'no-swm',
    ...overrides,
  };
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

    expect(result).toEqual({
      head: 3,
      watermark: 3,
      reconciled: 0,
      pending: 0,
      processed: 0,
      hasMore: false,
      shouldContinueImmediately: false,
      staleTarget: false,
    });
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

  it('processes a large head in bounded slices and yields between them', async () => {
    const attempts: number[][] = [[], [], []];
    let pass = 0;
    const { deps } = makeDeps({
      getKCCount: async () => 25,
      maxOrdinalsPerPass: 10,
      reconcileOrdinal: async (_cg, _onchain, ordinal) => {
        attempts[pass]!.push(ordinal);
        return { status: 'pending' };
      },
    });
    const state = createCursorState(0);

    const r1 = await reconcileContextGraph(deps, state, 'cg', 1n);
    pass += 1;
    const r2 = await reconcileContextGraph(deps, state, 'cg', 1n);
    pass += 1;
    const r3 = await reconcileContextGraph(deps, state, 'cg', 1n);

    expect(attempts).toEqual([
      [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
      [10, 11, 12, 13, 14, 15, 16, 17, 18, 19],
      [20, 21, 22, 23, 24],
    ]);
    expect([r1.processed, r2.processed, r3.processed]).toEqual([10, 10, 5]);
    expect([r1.hasMore, r2.hasMore, r3.hasMore]).toEqual([true, true, false]);
    expect(state.scanOrdinal).toBe(0);
  });

  it('makes the recent head useful while preserving bounded historical progress', async () => {
    const attempts: number[][] = [[], [], []];
    let pass = 0;
    const { deps } = makeDeps({
      getKCCount: async () => 30,
      maxOrdinalsPerPass: 10,
      recentOrdinalsPerPass: 7,
      reconcileOrdinal: async (_cg, _onchain, ordinal) => {
        attempts[pass]!.push(ordinal);
        return { status: 'reconciled', blockNumber: 0 };
      },
    });
    const state = createCursorState(0);

    const first = await reconcileContextGraph(deps, state, 'cg', 1n);
    pass += 1;
    const second = await reconcileContextGraph(deps, state, 'cg', 1n);
    pass += 1;
    const third = await reconcileContextGraph(deps, state, 'cg', 1n);

    expect(attempts).toEqual([
      [0, 1, 2, 23, 24, 25, 26, 27, 28, 29],
      [3, 4, 5, 16, 17, 18, 19, 20, 21, 22],
      [6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    ]);
    expect([first.hasMore, second.hasMore, third.hasMore]).toEqual([true, true, false]);
    expect([first.watermark, second.watermark, third.watermark]).toEqual([3, 6, 30]);
    expect(state.scanOrdinal).toBe(30);
  });

  it('spends selected exact-recovery budget on recent ordinals before history', async () => {
    const recoveryCalls: number[][] = [];
    const { deps } = makeDeps({
      getKCCount: async () => 30,
      maxOrdinalsPerPass: 10,
      recentOrdinalsPerPass: 7,
      reconcileOrdinal: async (_cg, _onchain, ordinal) => ({
        status: 'pending',
        recovery: recoveryTarget(ordinal),
      }),
      recoverPendingOrdinals: async (_cg, _onchain, targets) => {
        recoveryCalls.push(targets.map(({ ordinal }) => ordinal));
        return {
          outcomes: new Map(),
          attemptedOrdinals: [targets[0]!.ordinal],
          continuationOrdinal: targets[1]!.ordinal,
          hasImmediateRecoveryWork: false,
        };
      },
    });

    await reconcileContextGraph(deps, createCursorState(0), 'cg', 1n);

    expect(recoveryCalls).toEqual([[
      29, 28, 27, 26, 25, 24, 23,
      0, 1, 2,
    ]]);
  });

  it('never lets recent recovery continuation starve history while the head grows', async () => {
    let head = 30;
    let pass = 0;
    const attempts: number[][] = [[], [], []];
    const recoveryCalls: number[][] = [];
    const { deps } = makeDeps({
      getKCCount: async () => head,
      maxOrdinalsPerPass: 10,
      recentOrdinalsPerPass: 7,
      reconcileOrdinal: async (_cg, _onchain, ordinal) => {
        attempts[pass]!.push(ordinal);
        if (ordinal < head - 7) {
          return { status: 'reconciled', blockNumber: 0 };
        }
        return {
          status: 'pending',
          recovery: recoveryTarget(ordinal),
        };
      },
      recoverPendingOrdinals: async (_cg, _onchain, targets) => {
        const ordinals = targets.map(({ ordinal }) => ordinal);
        recoveryCalls.push(ordinals);
        const attempted = targets[0]!;
        return {
          outcomes: new Map([[
            attempted.ordinal,
            { status: 'pending', recovery: attempted } as OrdinalOutcome,
          ]]),
          attemptedOrdinals: [attempted.ordinal],
          continuationOrdinal: targets[1]?.ordinal,
          hasImmediateRecoveryWork: false,
        };
      },
    });
    const state = createCursorState(0);

    const first = await reconcileContextGraph(deps, state, 'cg', 1n);
    expect(first.watermark).toBe(3);
    expect(state.scanOrdinal).toBe(3);

    head = 35;
    pass += 1;
    const second = await reconcileContextGraph(deps, state, 'cg', 1n);
    expect(second.watermark).toBe(6);
    expect(state.scanOrdinal).toBe(6);

    head = 40;
    pass += 1;
    const third = await reconcileContextGraph(deps, state, 'cg', 1n);
    expect(third.watermark).toBe(9);
    expect(state.scanOrdinal).toBe(9);

    expect(attempts).toEqual([
      [0, 1, 2, 23, 24, 25, 26, 27, 28, 29],
      [3, 4, 5, 28, 29, 30, 31, 32, 33, 34],
      [6, 7, 8, 33, 34, 35, 36, 37, 38, 39],
    ]);
    expect(recoveryCalls.map((ordinals) => ordinals[0])).toEqual([29, 34, 39]);
  });

  it('runs each bounded slice with capped ordinal concurrency', async () => {
    let active = 0;
    let maxActive = 0;
    const { deps } = makeDeps({
      getKCCount: async () => 10,
      maxOrdinalsPerPass: 10,
      maxOrdinalConcurrency: 3,
      reconcileOrdinal: async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 1));
        active -= 1;
        return { status: 'reconciled', blockNumber: 0 };
      },
    });
    const state = createCursorState(0);

    const result = await reconcileContextGraph(deps, state, 'cg', 1n);

    expect(maxActive).toBe(3);
    expect(result).toMatchObject({ processed: 10, reconciled: 10, watermark: 10 });
  });

  it('batch-recovers only locally-missing ordinals and reuses their outcomes', async () => {
    const recoveryCalls: number[][] = [];
    const { deps } = makeDeps({
      getKCCount: async () => 3,
      maxOrdinalsPerPass: 10,
      reconcileOrdinal: async (_cg, _onchain, ordinal) => {
        if (ordinal === 0) return { status: 'already', blockNumber: 100 };
        return {
          status: 'pending',
          recovery: recoveryTarget(ordinal),
        };
      },
      recoverPendingOrdinals: async (_cg, _onchain, targets) => {
        recoveryCalls.push(targets.map((target) => target.ordinal));
        return {
          outcomes: new Map(targets.map((target) => [
            target.ordinal,
            { status: 'reconciled', blockNumber: 100 } as OrdinalOutcome,
          ])),
          attemptedOrdinals: targets.map((target) => target.ordinal),
          continuationOrdinal: undefined,
          hasImmediateRecoveryWork: false,
        };
      },
    });
    const state = createCursorState(0);

    const result = await reconcileContextGraph(deps, state, 'cg', 1n);

    expect(recoveryCalls).toEqual([[1, 2]]);
    expect(result).toMatchObject({ processed: 3, reconciled: 3, watermark: 3 });
  });

  it('resumes at the first untouched recovery ordinal instead of skipping to the next slice', async () => {
    const recoveryCalls: number[][] = [];
    const { deps } = makeDeps({
      getKCCount: async () => 25,
      maxOrdinalsPerPass: 10,
      reconcileOrdinal: async (_cg, _onchain, ordinal) => ({
        status: 'pending',
        recovery: recoveryTarget(ordinal),
      }),
      recoverPendingOrdinals: async (_cg, _onchain, targets) => {
        const ordinals = targets.map((target) => target.ordinal);
        recoveryCalls.push(ordinals);
        const attempted = ordinals.slice(0, 3);
        return {
          outcomes: new Map(attempted.map((ordinal) => [
            ordinal,
            { status: 'reconciled', blockNumber: 100 } as OrdinalOutcome,
          ])),
          attemptedOrdinals: attempted,
          continuationOrdinal: ordinals[attempted.length],
          hasImmediateRecoveryWork: false,
        };
      },
    });
    const state = createCursorState(0);

    const first = await reconcileContextGraph(deps, state, 'cg', 1n);
    expect(first.hasMore).toBe(true);
    expect(state.watermark).toBe(3);
    expect(state.scanOrdinal).toBe(3);

    await reconcileContextGraph(deps, state, 'cg', 1n);

    expect(recoveryCalls).toEqual([
      [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
      [3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
    ]);
  });

  it('visits an untouched ordinal before reprobing an earlier provider rotation', async () => {
    const recoveryCalls: number[][] = [];
    const { deps } = makeDeps({
      getKCCount: async () => 2,
      maxOrdinalsPerPass: 1,
      reconcileOrdinal: async (_cg, _onchain, ordinal) => ({
        status: 'pending',
        recovery: recoveryTarget(ordinal),
      }),
      recoverPendingOrdinals: async (_cg, _onchain, targets) => {
        recoveryCalls.push(targets.map((target) => target.ordinal));
        const target = targets[0]!;
        return {
          outcomes: new Map([[
            target.ordinal,
            { status: 'pending', recovery: target } as OrdinalOutcome,
          ]]),
          attemptedOrdinals: [target.ordinal],
          continuationOrdinal: undefined,
          hasImmediateRecoveryWork: true,
        };
      },
    });
    const state = createCursorState(0);

    const first = await reconcileContextGraph(deps, state, 'cg', 1n);
    expect(first.hasMore).toBe(true);
    expect(state.scanOrdinal).toBe(1);

    await reconcileContextGraph(deps, state, 'cg', 1n);

    expect(recoveryCalls).toEqual([[0], [1]]);
  });

  it('schedules another pass when recovery alone reports immediate work', async () => {
    const target = recoveryTarget(0);
    const { deps } = makeDeps({
      getKCCount: async () => 1,
      maxOrdinalsPerPass: 1,
      reconcileOrdinal: async () => ({ status: 'pending', recovery: target }),
      recoverPendingOrdinals: async () => ({
        outcomes: new Map([[0, { status: 'pending', recovery: target }]]),
        attemptedOrdinals: [0],
        continuationOrdinal: undefined,
        hasImmediateRecoveryWork: true,
      }),
    });
    const state = createCursorState(0);

    const result = await reconcileContextGraph(deps, state, 'cg', 1n);

    expect(result.hasMore).toBe(true);
    expect(result.shouldContinueImmediately).toBe(true);
    expect(state.scanOrdinal).toBe(0);
  });

  it('preserves the next recovery target across a cooldown-only pass', async () => {
    const recoveryCalls: number[][] = [];
    const networkAttempts: number[] = [];
    const { deps } = makeDeps({
      getKCCount: async () => 2,
      maxOrdinalsPerPass: 2,
      reconcileOrdinal: async (_cg, _onchain, ordinal) => ({
        status: 'pending',
        recovery: recoveryTarget(ordinal),
      }),
      recoverPendingOrdinals: async (_cg, _onchain, targets) => {
        const ordinals = targets.map((target) => target.ordinal);
        recoveryCalls.push(ordinals);
        if (recoveryCalls.length === 2) {
          return {
            outcomes: new Map(),
            attemptedOrdinals: [],
            continuationOrdinal: targets[0]?.ordinal,
            hasImmediateRecoveryWork: false,
            cooldownOnly: true,
          };
        }
        const attempted = targets[0]!;
        networkAttempts.push(attempted.ordinal);
        const outcome: OrdinalOutcome = attempted.ordinal === 1
          ? { status: 'reconciled', blockNumber: 100 }
          : { status: 'pending', recovery: attempted };
        return {
          outcomes: new Map([[attempted.ordinal, outcome]]),
          attemptedOrdinals: [attempted.ordinal],
          continuationOrdinal: targets[1]?.ordinal
            ?? (outcome.status === 'pending' ? attempted.ordinal : undefined),
          hasImmediateRecoveryWork: false,
        };
      },
    });
    const state = createCursorState(0);

    const first = await reconcileContextGraph(deps, state, 'cg', 1n);
    expect(first.hasMore).toBe(true);
    expect(state.watermark).toBe(0);
    expect(state.scanOrdinal).toBe(1);

    const cooldown = await reconcileContextGraph(deps, state, 'cg', 1n);
    expect(cooldown.hasMore).toBe(false);
    expect(state.scanOrdinal).toBe(1);

    await reconcileContextGraph(deps, state, 'cg', 1n);
    await reconcileContextGraph(deps, state, 'cg', 1n);

    expect(networkAttempts).toEqual([0, 1, 0]);
    expect(recoveryCalls).toEqual([
      [0, 1],
      [1],
      [1],
      [0],
    ]);
  });

  it('keeps the fair scan moving when recovery finds no eligible peer', async () => {
    const attempts: number[][] = [[], []];
    let pass = 0;
    const { deps } = makeDeps({
      getKCCount: async () => 25,
      maxOrdinalsPerPass: 10,
      reconcileOrdinal: async (_cg, _onchain, ordinal) => {
        attempts[pass]!.push(ordinal);
        if (ordinal !== 0) return { status: 'reconciled', blockNumber: 100 };
        return {
          status: 'pending',
          recovery: recoveryTarget(ordinal),
        };
      },
      recoverPendingOrdinals: async (_cg, _onchain, targets) => ({
        outcomes: new Map(),
        attemptedOrdinals: [],
        continuationOrdinal: targets[0]?.ordinal,
        hasImmediateRecoveryWork: false,
        cooldownOnly: false,
      }),
    });
    const state = createCursorState(0);

    const first = await reconcileContextGraph(deps, state, 'cg', 1n);
    expect(first.hasMore).toBe(true);
    expect(state.scanOrdinal).toBe(10);

    pass += 1;
    await reconcileContextGraph(deps, state, 'cg', 1n);

    expect(attempts).toEqual([
      [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
      [10, 11, 12, 13, 14, 15, 16, 17, 18, 19],
    ]);
  });

  it('advances the fair scan past a damped recovery gap without hot-looping', async () => {
    const attempts: number[][] = [[], [], []];
    let pass = 0;
    const { deps } = makeDeps({
      getKCCount: async () => 25,
      maxOrdinalsPerPass: 10,
      reconcileOrdinal: async (_cg, _onchain, ordinal) => {
        attempts[pass]!.push(ordinal);
        if (ordinal !== 0) return { status: 'reconciled', blockNumber: 100 };
        return {
          status: 'pending',
          recovery: recoveryTarget(ordinal),
        };
      },
      recoverPendingOrdinals: async () => ({
        outcomes: new Map(),
        attemptedOrdinals: [],
        continuationOrdinal: undefined,
        hasImmediateRecoveryWork: false,
      }),
    });
    const state = createCursorState(0);

    const first = await reconcileContextGraph(deps, state, 'cg', 1n);
    expect(first.hasMore).toBe(true);
    expect(state.scanOrdinal).toBe(10);

    pass += 1;
    const second = await reconcileContextGraph(deps, state, 'cg', 1n);
    expect(second.hasMore).toBe(true);
    expect(state.scanOrdinal).toBe(20);

    pass += 1;
    const third = await reconcileContextGraph(deps, state, 'cg', 1n);

    expect(attempts).toEqual([
      [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
      [10, 11, 12, 13, 14, 15, 16, 17, 18, 19],
      [20, 21, 22, 23, 24],
    ]);
    expect(third.watermark).toBe(0);
    expect(third.pending).toBe(1);
    expect(third.hasMore).toBe(false);
    expect(state.ahead.size).toBe(24);
    expect(state.scanOrdinal).toBe(0);
  });

  it('keeps scanning later slices when an early ordinal remains pending', async () => {
    const attempts: number[][] = [[], [], []];
    let pass = 0;
    const { deps } = makeDeps({
      getKCCount: async () => 6,
      maxOrdinalsPerPass: 2,
      reconcileOrdinal: async (_cg, _onchain, ordinal) => {
        attempts[pass]!.push(ordinal);
        if (ordinal === 0) return { status: 'pending' };
        return { status: 'reconciled', blockNumber: 0 };
      },
    });
    const state = createCursorState(0);

    await reconcileContextGraph(deps, state, 'cg', 1n);
    pass += 1;
    await reconcileContextGraph(deps, state, 'cg', 1n);
    pass += 1;
    const result = await reconcileContextGraph(deps, state, 'cg', 1n);

    expect(attempts).toEqual([[0, 1], [2, 3], [4, 5]]);
    expect(result.watermark).toBe(0);
    expect(result.pending).toBe(1);
    expect(result.hasMore).toBe(false);
    expect(state.ahead.size).toBe(5);
  });

  it('stops a slice when its captured context-graph binding becomes stale', async () => {
    let current = true;
    const { deps, attempted } = makeDeps({
      getKCCount: async () => 5,
      maxOrdinalsPerPass: 5,
      isTargetCurrent: async () => current,
      reconcileOrdinal: async (_cg, _onchain, ordinal) => {
        attempted.push(ordinal);
        current = false;
        return { status: 'reconciled', blockNumber: 0 };
      },
    });
    const state = createCursorState(0);

    const result = await reconcileContextGraph(deps, state, 'cg', 66n);

    expect(attempted).toEqual([0]);
    expect(result).toMatchObject({
      processed: 1,
      reconciled: 0,
      staleTarget: true,
      hasMore: false,
      shouldContinueImmediately: true,
    });
    expect(state.watermark).toBe(0);
    expect(state.scanOrdinal).toBe(0);
  });

  it('discards recovered outcomes when the binding flips during batch recovery', async () => {
    let current = true;
    const { deps, persisted } = makeDeps({
      getKCCount: async () => 2,
      maxOrdinalsPerPass: 10,
      isTargetCurrent: async () => current,
      reconcileOrdinal: async (_cg, _onchain, ordinal) => ({
        status: 'pending',
        recovery: recoveryTarget(ordinal),
      }),
      recoverPendingOrdinals: async (_cg, _onchain, targets) => {
        // The rebind lands while the long recovery await is in flight. The
        // recovered outcomes belong to the OLD binding and must be discarded.
        current = false;
        return {
          outcomes: new Map(targets.map((target) => [
            target.ordinal,
            { status: 'reconciled', blockNumber: 100 } as OrdinalOutcome,
          ])),
          attemptedOrdinals: targets.map((target) => target.ordinal),
          continuationOrdinal: undefined,
          hasImmediateRecoveryWork: false,
        };
      },
    });
    const state = createCursorState(0);

    const result = await reconcileContextGraph(deps, state, 'cg', 5n);

    expect(result.staleTarget).toBe(true);
    expect(result.reconciled).toBe(0);
    expect(result.hasMore).toBe(false);
    expect(state.watermark).toBe(0);
    expect(state.scanOrdinal).toBe(0);
    expect(persisted).toEqual([]);
  });

  it('contains a worker failure: siblings drain, no new ordinals start, then the pass rejects', async () => {
    const attempted: number[] = [];
    const completed: number[] = [];
    let releaseSlow!: () => void;
    const slowGate = new Promise<void>((resolve) => { releaseSlow = resolve; });
    const { deps } = makeDeps({
      getKCCount: async () => 6,
      maxOrdinalsPerPass: 6,
      maxOrdinalConcurrency: 2,
      reconcileOrdinal: async (_cg, _onchain, ordinal) => {
        attempted.push(ordinal);
        if (ordinal === 0) {
          throw new Error('ordinal 0 exploded');
        }
        if (ordinal === 1) {
          await slowGate;
        }
        completed.push(ordinal);
        return { status: 'reconciled', blockNumber: 0 };
      },
    });
    const state = createCursorState(0);

    const pass = reconcileContextGraph(deps, state, 'cg', 1n);
    let settled = false;
    void pass.catch(() => undefined).then(() => { settled = true; });

    // Let the failing worker reject and the dispatch loops observe it.
    await new Promise((resolve) => setTimeout(resolve, 10));
    // The pass must still be waiting on the in-flight sibling ordinal…
    expect(settled).toBe(false);
    releaseSlow();
    await expect(pass).rejects.toThrow('ordinal 0 exploded');

    // …and after the failure no NEW ordinal may have been dispatched.
    expect(attempted).toEqual([0, 1]);
    expect(completed).toEqual([1]);
    expect(state.watermark).toBe(0);
  });
});

describe('VmReconcileDispatcher scheduling', () => {
  it('places a self-scheduled next slice behind context graphs already waiting', async () => {
    const observed: string[] = [];
    let scheduler!: VmReconcileDispatcher<void>;
    scheduler = new VmReconcileDispatcher(
      async (key) => {
        observed.push(key);
        if (key === 'large-cg' && observed.filter((seen) => seen === key).length === 1) {
          scheduler.triggerLive(key);
        }
      },
      () => undefined,
    );

    scheduler.triggerLive('large-cg');
    scheduler.triggerLive('waiting-cg');
    await scheduler.waitForIdle();

    expect(observed).toEqual(['large-cg', 'waiting-cg', 'large-cg']);
  });

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

  it('makes manual admission wait for one fresh pass behind active automatic work', async () => {
    let observedHead = 5;
    let releaseAutomatic!: () => void;
    const runs: Array<{ source: string; head: number }> = [];
    const dispatcher = new VmReconcileDispatcher(async (_key, source) => {
      const result = { source, head: observedHead };
      runs.push(result);
      if (runs.length === 1) {
        await new Promise<void>((resolve) => { releaseAutomatic = resolve; });
      }
      return result;
    }, () => undefined, { concurrency: 1 });

    const automatic = dispatcher.dispatch('cg', 'periodic');
    await new Promise((resolve) => setTimeout(resolve, 0));
    dispatcher.triggerLive('cg');
    const manual = dispatcher.triggerManual('cg');
    const duplicateManual = dispatcher.triggerManual('cg');
    observedHead = 6;

    let manualSettled = false;
    void manual.then(() => { manualSettled = true; });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(manualSettled).toBe(false);
    expect(manual).toBe(duplicateManual);
    expect(manual).not.toBe(automatic);

    releaseAutomatic();
    await expect(automatic).resolves.toEqual({ source: 'periodic', head: 5 });
    await expect(manual).resolves.toEqual({ source: 'manual', head: 6 });
    expect(runs).toEqual([
      { source: 'periodic', head: 5 },
      { source: 'manual', head: 6 },
    ]);
  });

  it('still runs a fresh manual boundary when the older automatic pass fails', async () => {
    let rejectAutomatic!: (error: Error) => void;
    const sources: string[] = [];
    const dispatcher = new VmReconcileDispatcher(async (_key, source) => {
      sources.push(source);
      if (sources.length === 1) {
        await new Promise<void>((_resolve, reject) => { rejectAutomatic = reject; });
      }
      return source;
    }, () => undefined, { concurrency: 1 });

    const automaticFailure = dispatcher.dispatch('cg', 'periodic').catch((error) => error);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const manual = dispatcher.triggerManual('cg');
    const failure = new Error('automatic pass failed');
    rejectAutomatic(failure);

    await expect(automaticFailure).resolves.toBe(failure);
    await expect(manual).resolves.toBe('manual');
    expect(sources).toEqual(['periodic', 'manual']);
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
