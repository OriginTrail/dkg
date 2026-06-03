import { describe, it, expect } from 'vitest';
import {
  reconcileContextGraph,
  ReconcileCoalescer,
  RecentUalSet,
  type ChainReconcilerDeps,
  type OrdinalOutcome,
} from '../src/chain-reconciler.js';
import { createCursorState } from '../src/reconcile-cursor.js';

/**
 * Phase B — sweep + cursor orchestration (B.2/B.4). The cursor math itself is
 * covered by reconcile-cursor.test.ts; here we pin the sweep driver:
 * gap-fill, watermark-persist-only-on-move, reorg depth, pending-retry, plus
 * the coalescer and UAL dedupe.
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

  it('does not persist when the watermark does not move (nothing new)', async () => {
    const { deps, persisted } = makeDeps({ getKCCount: async () => 3 });
    const state = createCursorState(3); // already at head
    await reconcileContextGraph(deps, state, 'cg', 1n);
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

  it('#13 — a transient getHeadBlock failure promotes but does NOT advance/persist the watermark', async () => {
    // A throwing getHeadBlock means we can't observe the head; advancing the
    // watermark at depth 0 here (the old `undefined`-conflation bug) would
    // strand the ordinal if a shallow reorg then drops it. The ordinal IS
    // reconciled (counted), but the watermark must hold until a real head is
    // seen — at which point the cheap recentReconciledUals/`already` re-check
    // folds it in under the proper depth gate.
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
    expect(r1.reconciled).toBe(2);   // both ordinals promoted
    expect(r1.watermark).toBe(0);    // but watermark held — no confirmed head
    expect(persisted).toEqual([]);   // nothing persisted on unconfirmed data

    // Head observable again (block 100, regs at 90 → buried by 10 >= 5).
    headThrows = false;
    const r2 = await reconcileContextGraph(deps, state, 'cg', 1n);
    expect(r2.watermark).toBe(2);
    expect(persisted).toEqual([{ cg: 'cg', watermark: 2 }]);
  });
});

describe('ReconcileCoalescer', () => {
  it('collapses a burst into one run plus a single trailing run', async () => {
    let runs = 0;
    let resolveCurrent!: () => void;
    const coalescer = new ReconcileCoalescer(async () => {
      runs += 1;
      await new Promise<void>((r) => { resolveCurrent = r; });
    });

    // First trigger starts a run (now in flight, awaiting resolveCurrent).
    void coalescer.trigger('cg');
    // 4 more triggers while in flight → mark "again", do NOT start new runs.
    void coalescer.trigger('cg');
    void coalescer.trigger('cg');
    void coalescer.trigger('cg');
    void coalescer.trigger('cg');
    expect(runs).toBe(1);

    // Finish the first run → exactly one trailing run starts.
    const r1 = resolveCurrent;
    r1();
    await new Promise((r) => setTimeout(r, 0));
    expect(runs).toBe(2);

    // Finish the trailing run → no further runs (no triggers landed during it).
    resolveCurrent();
    await new Promise((r) => setTimeout(r, 0));
    expect(runs).toBe(2);
  });

  it('runs independently per key', async () => {
    const ran: string[] = [];
    const coalescer = new ReconcileCoalescer(async (key) => { ran.push(key); });
    await Promise.all([coalescer.trigger('a'), coalescer.trigger('b')]);
    expect(ran.sort()).toEqual(['a', 'b']);
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
});
