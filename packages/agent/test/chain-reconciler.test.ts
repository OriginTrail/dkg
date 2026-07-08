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

const ASSET_UAL = 'did:dkg:hardhat:31337/0x00000000000000000000000000000000000000aa/7';

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

  it('emits assetUal lifecycle decisions for a reconciled published KA ordinal', async () => {
    const lifecycleEvents: Array<{
      assetUal: string;
      action: string;
      result: string;
      localCgId: string;
      onChainCgId: string;
      ordinal: number;
      kaId?: string;
    }> = [];
    const { deps } = makeDeps({
      getKCCount: async () => 1,
      reconcileOrdinal: async () => ({
        status: 'reconciled',
        blockNumber: 12,
        assetUal: ASSET_UAL,
        kaId: '7',
      } as never),
      logLifecycle: (event) => lifecycleEvents.push(event),
    } as Partial<ChainReconcilerDeps>);
    const state = createCursorState(0);

    await reconcileContextGraph(deps, state, 'published-cg', 77n);

    expect(lifecycleEvents).toContainEqual(expect.objectContaining({
      assetUal: ASSET_UAL,
      action: 'promote',
      result: 'reconciled',
      localCgId: 'published-cg',
      onChainCgId: '77',
      ordinal: 0,
      kaId: '7',
    }));
    expect(lifecycleEvents).toContainEqual(expect.objectContaining({
      assetUal: ASSET_UAL,
      action: 'cursor-advance',
      result: 'advanced',
      localCgId: 'published-cg',
      onChainCgId: '77',
      ordinal: 0,
      kaId: '7',
    }));
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
