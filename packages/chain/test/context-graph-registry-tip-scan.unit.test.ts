import { describe, expect, it, vi } from 'vitest';
import {
  ContextGraphChainScanPartialError,
  type ContextGraphRegistryScanCursorKey,
  type ContextGraphRegistryScanCursorStore,
} from '../src/chain-adapter.js';
import {
  MemoryRegistryScanCursorStore,
  REGISTRY,
  collectRegistryScan,
  makeAdapter,
  makeRegistry,
  roleAwareRegistryCursorPersistence,
  seam,
} from './context-graph-registry-scan-test-support.js';

const DEPLOYMENT_ID = 'evm:31337:hub=0x0000000000000000000000000000000000000001';
const LEGACY_KEY: ContextGraphRegistryScanCursorKey = {
  chainId: 'evm:31337',
  deploymentId: DEPLOYMENT_ID,
  registryAddress: REGISTRY,
};

class JsonLegacyRegistryScanCursorStore implements ContextGraphRegistryScanCursorStore {
  readonly values = new Map<string, number>();
  readonly loads: ContextGraphRegistryScanCursorKey[] = [];
  readonly saves: Array<{ key: ContextGraphRegistryScanCursorKey; nextBlock: number }> = [];

  seed(key: ContextGraphRegistryScanCursorKey, nextBlock: number): void {
    this.values.set(JSON.stringify(key), nextBlock);
  }

  async load(key: ContextGraphRegistryScanCursorKey): Promise<number | undefined> {
    this.loads.push({ ...key });
    return this.values.get(JSON.stringify(key));
  }

  async save(key: ContextGraphRegistryScanCursorKey, nextBlock: number): Promise<void> {
    this.saves.push({ key: { ...key }, nextBlock });
    this.values.set(JSON.stringify(key), nextBlock);
  }
}

describe('EVMChainAdapter ContextGraphNameRegistry tip recovery', () => {
  it('probes the current tip independently while a middle historical page remains unavailable', async () => {
    let head = 4_999;
    const store = new MemoryRegistryScanCursorStore();
    const persistence = roleAwareRegistryCursorPersistence(store);
    const tipGraphBlock = 9_999;
    const betweenTipProbesGraphBlock = 10_001;
    const registry = makeRegistry({
      queryFilter: seam(async (_filter: unknown, lo: number, hi: number) => {
        if (lo >= 2_000 && lo < 4_000) throw new Error('archive range unavailable');
        return [tipGraphBlock, betweenTipProbesGraphBlock]
          .filter((blockNumber) => lo <= blockNumber && blockNumber <= hi)
          .map((blockNumber) => ({ topics: [], data: '0x01', blockNumber }));
      }),
    });
    const { adapter, provider } = makeAdapter(registry, head, {
      contextGraphRegistryScanCursorPersistence: persistence,
    });
    provider.getBlockNumber.setImpl(async () => head);

    const firstRecovery = await collectRegistryScan(adapter, { mode: 'seedFull' }).catch((err) => err);

    expect(firstRecovery).toBeInstanceOf(ContextGraphChainScanPartialError);
    expect((adapter as any).contextGraphRegistryScanCursor.getCachedWatermark(REGISTRY)).toBe(2_000);

    head = 10_000;
    registry.queryFilter.clear();
    const tipResults = await collectRegistryScan(adapter, { mode: 'tip' });

    expect(tipResults.map((cg) => cg.blockNumber)).toEqual([tipGraphBlock]);
    expect(registry.queryFilter.calls.map(([, lo, hi]: [unknown, number, number]) => [lo, hi])).toEqual([
      [8_001, 10_000],
    ]);
    expect((adapter as any).contextGraphRegistryScanCursor.getCachedWatermark(REGISTRY)).toBe(2_000);

    head = 13_200;
    const { adapter: restartedAdapter, provider: restartedProvider } = makeAdapter(registry, head, {
      contextGraphRegistryScanCursorPersistence: persistence,
    });
    restartedProvider.getBlockNumber.setImpl(async () => head);
    registry.queryFilter.clear();
    const nextTipResults = await collectRegistryScan(restartedAdapter, { mode: 'tip' });

    expect(nextTipResults.map((cg) => cg.blockNumber)).toEqual([
      tipGraphBlock,
      betweenTipProbesGraphBlock,
    ]);
    expect(registry.queryFilter.calls.map(([, lo, hi]: [unknown, number, number]) => [lo, hi])).toEqual([
      [9_951, 11_950],
      [11_951, 13_200],
    ]);
    expect((restartedAdapter as any).contextGraphRegistryTipScanCursor.getCachedWatermark(REGISTRY)).toBe(13_201);
    expect(await restartedAdapter.hasContextGraphRegistryScanWatermark()).toBe(true);
    expect((restartedAdapter as any).contextGraphRegistryScanCursor.getCachedWatermark(REGISTRY)).toBe(2_000);

    registry.queryFilter.clear();
    const secondRecovery = await collectRegistryScan(restartedAdapter, { mode: 'seedFull' })
      .catch((err) => err);

    expect(secondRecovery).toBeInstanceOf(ContextGraphChainScanPartialError);
    expect(registry.queryFilter.calls.map(([, lo, hi]: [unknown, number, number]) => [lo, hi])).toEqual([
      [0, 1_999],
      [2_000, 3_999],
    ]);
    expect((restartedAdapter as any).contextGraphRegistryScanCursor.getCachedWatermark(REGISTRY)).toBe(2_000);
  });

  it('retains the first attempted tip range when its query fails before any acknowledgement', async () => {
    const store = new MemoryRegistryScanCursorStore();
    const persistence = roleAwareRegistryCursorPersistence(store);
    const registry = makeRegistry({
      queryFilter: seam(async () => {
        throw new Error('first tip page unavailable');
      }),
    });
    const { adapter } = makeAdapter(registry, 10_000, {
      contextGraphRegistryScanCursorPersistence: persistence,
    });

    await expect(collectRegistryScan(adapter, { mode: 'tip' }))
      .rejects.toThrow('first tip page unavailable');
    expect(store.saves.map((save) => save.nextBlock)).toEqual([8_001]);

    const eventBlock = 10_001;
    const head = 13_200;
    registry.queryFilter.reset();
    registry.queryFilter.setImpl(async (_filter: unknown, lo: number, hi: number) =>
      lo <= eventBlock && eventBlock <= hi
        ? [{ topics: [], data: '0x01', blockNumber: eventBlock }]
        : [],
    );
    const { adapter: restarted } = makeAdapter(registry, head, {
      contextGraphRegistryScanCursorPersistence: persistence,
    });

    const recovered = await collectRegistryScan(restarted, { mode: 'tip' });

    expect(recovered.map((cg) => cg.blockNumber)).toEqual([eventBlock]);
    expect(registry.queryFilter.calls.map(([, lo, hi]: [unknown, number, number]) => [lo, hi])).toEqual([
      [7_951, 9_950],
      [9_951, 11_950],
      [11_951, 13_200],
    ]);
    expect(await restarted.hasContextGraphRegistryScanWatermark()).toBe(false);
  });

  it('retains the exact v1 key shape when loading a legacy historical cursor', async () => {
    const historical = new JsonLegacyRegistryScanCursorStore();
    historical.seed(LEGACY_KEY, 2_000);
    const registry = makeRegistry();
    const { adapter, provider } = makeAdapter(registry, 5_000, {
      cgRegistryScanPageSize: 1_000,
      contextGraphRegistryScanCursorStore: historical,
    });
    provider.getCode = seam(async () => {
      throw new Error('deploy probing must not run after loading the legacy cursor');
    });
    registry.queryFilter.setImpl(async () => []);

    await collectRegistryScan(adapter, { mode: 'seedFromCursor', pageBudget: 1 });

    expect(provider.getCode.calls).toEqual([]);
    expect(historical.loads).toEqual([LEGACY_KEY]);
    expect(Object.keys(historical.loads[0] ?? {}).sort()).toEqual([
      'chainId',
      'deploymentId',
      'registryAddress',
    ]);
    expect(registry.queryFilter.calls[0]?.slice(1)).toEqual([1_950, 2_949]);
  });

  it('persists independent tip progress across restart with split legacy stores', async () => {
    const historical = new JsonLegacyRegistryScanCursorStore();
    const tip = new JsonLegacyRegistryScanCursorStore();
    historical.seed(LEGACY_KEY, 2_000);
    const persistence = { kind: 'legacy' as const, historical, tip };
    const eventBlock = 10_001;
    let head = 10_000;
    const registry = makeRegistry({
      queryFilter: seam(async (_filter: unknown, lo: number, hi: number) =>
        lo <= eventBlock && eventBlock <= hi
          ? [{ topics: [], data: '0x01', blockNumber: eventBlock }]
          : [],
      ),
    });
    const { adapter } = makeAdapter(registry, head, {
      contextGraphRegistryScanCursorPersistence: persistence,
    });

    await collectRegistryScan(adapter, { mode: 'tip' });

    expect(historical.values.get(JSON.stringify(LEGACY_KEY))).toBe(2_000);
    expect(tip.values.get(JSON.stringify(LEGACY_KEY))).toBe(10_001);
    expect(historical.loads).toEqual([]);

    head = 13_200;
    registry.queryFilter.clear();
    const { adapter: restarted, provider } = makeAdapter(registry, head, {
      contextGraphRegistryScanCursorPersistence: persistence,
    });
    provider.getBlockNumber.setImpl(async () => head);
    const recovered = await collectRegistryScan(restarted, { mode: 'tip' });

    expect(recovered.map((cg) => cg.blockNumber)).toEqual([eventBlock]);
    expect(registry.queryFilter.calls.map(([, lo, hi]: [unknown, number, number]) => [lo, hi])).toEqual([
      [9_951, 11_950],
      [11_951, 13_200],
    ]);
    expect(historical.values.get(JSON.stringify(LEGACY_KEY))).toBe(2_000);
    expect(tip.values.get(JSON.stringify(LEGACY_KEY))).toBe(13_201);
    expect(tip.loads).toHaveLength(2);
    expect(tip.loads.every((key) => !('cursorKind' in key))).toBe(true);
  });

  it('retains the first tip lower bound in process when durable cursor persistence fails', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = {
      load: vi.fn(async () => undefined),
      save: vi.fn(async () => {
        throw new Error('tip cursor save failed');
      }),
    };
    let head = 10_000;
    let firstQuery = true;
    const eventBlock = 10_001;
    const registry = makeRegistry({
      queryFilter: seam(async (_filter: unknown, lo: number, hi: number) => {
        if (firstQuery) {
          firstQuery = false;
          throw new Error('first tip page unavailable');
        }
        return lo <= eventBlock && eventBlock <= hi
          ? [{ topics: [], data: '0x01', blockNumber: eventBlock }]
          : [];
      }),
    });
    const { adapter, provider } = makeAdapter(registry, head, {
      contextGraphRegistryScanCursorPersistence: roleAwareRegistryCursorPersistence(store),
    });
    provider.getBlockNumber.setImpl(async () => head);

    try {
      await expect(collectRegistryScan(adapter, { mode: 'tip' }))
        .rejects.toThrow('first tip page unavailable');
      expect((adapter as any).contextGraphRegistryTipScanCursor.getCachedWatermark(REGISTRY))
        .toBe(8_001);

      head = 13_200;
      registry.queryFilter.clear();
      const recovered = await collectRegistryScan(adapter, { mode: 'tip' });

      expect(recovered.map((cg) => cg.blockNumber)).toEqual([eventBlock]);
      expect(registry.queryFilter.calls[0]?.slice(1)).toEqual([7_951, 9_950]);
      expect((adapter as any).contextGraphRegistryScanCursor.getCachedWatermark(REGISTRY))
        .toBeUndefined();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('revisits a fetched tip page when local application never acknowledges it', async () => {
    const store = new MemoryRegistryScanCursorStore();
    const persistence = roleAwareRegistryCursorPersistence(store);
    const eventBlock = 9_999;
    const registry = makeRegistry({
      queryFilter: seam(async (_filter: unknown, lo: number, hi: number) =>
        lo <= eventBlock && eventBlock <= hi
          ? [{ topics: [], data: '0x01', blockNumber: eventBlock }]
          : [],
      ),
    });
    const { adapter } = makeAdapter(registry, 10_000, {
      contextGraphRegistryScanCursorPersistence: persistence,
    });
    const iterator = adapter.scanContextGraphRegistryPages({ mode: 'tip' })[Symbol.asyncIterator]();

    const fetched = await iterator.next();
    expect(fetched.done).toBe(false);
    expect(fetched.value?.contextGraphs.map((cg) => cg.blockNumber)).toEqual([eventBlock]);
    await iterator.return?.();
    expect(store.saves.map((save) => save.nextBlock)).toEqual([8_001]);

    registry.queryFilter.clear();
    const { adapter: restarted } = makeAdapter(registry, 10_000, {
      contextGraphRegistryScanCursorPersistence: persistence,
    });
    const retried = await collectRegistryScan(restarted, { mode: 'tip' });

    expect(retried.map((cg) => cg.blockNumber)).toEqual([eventBlock]);
    expect(registry.queryFilter.calls.map(([, lo, hi]: [unknown, number, number]) => [lo, hi])).toEqual([
      [7_951, 9_950],
      [9_951, 10_000],
    ]);
    expect(await restarted.hasContextGraphRegistryScanWatermark()).toBe(false);
  });
});
