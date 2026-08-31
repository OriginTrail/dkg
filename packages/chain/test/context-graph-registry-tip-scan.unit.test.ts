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
  registryCursorStores,
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

class KindedJsonLegacyRegistryScanCursorStore extends JsonLegacyRegistryScanCursorStore {
  readonly kind = 'sqlite';
}

describe('EVMChainAdapter ContextGraphNameRegistry tip recovery', () => {
  it('exposes only the load policy owned by each cursor role', () => {
    const { adapter } = makeAdapter(makeRegistry(), 10_000);
    const historical = (adapter as any).contextGraphRegistryScanCursor;
    const tip = (adapter as any).contextGraphRegistryTipScanCursor;

    expect(historical.loadBestEffortWatermark).toEqual(expect.any(Function));
    expect(historical.loadStrictWatermark).toBeUndefined();
    expect(tip.loadStrictWatermark).toEqual(expect.any(Function));
    expect(tip.loadBestEffortWatermark).toBeUndefined();
    expect(historical.loadWatermark).toBeUndefined();
    expect(tip.loadWatermarkResult).toBeUndefined();
  });

  it('probes the current tip independently while a middle historical page remains unavailable', async () => {
    let head = 4_999;
    const store = new MemoryRegistryScanCursorStore();
    const cursorStores = registryCursorStores(store);
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
      ...cursorStores,
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
      ...cursorStores,
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
    const cursorStores = registryCursorStores(store);
    const registry = makeRegistry({
      queryFilter: seam(async () => {
        throw new Error('first tip page unavailable');
      }),
    });
    const { adapter } = makeAdapter(registry, 10_000, {
      ...cursorStores,
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
      ...cursorStores,
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

  it('retains exact v1 read/write keys for a legacy store with unrelated kind metadata', async () => {
    const historical = new KindedJsonLegacyRegistryScanCursorStore();
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
    expect(historical.saves).toEqual([{ key: LEGACY_KEY, nextBlock: 2_950 }]);
    expect(Object.keys(historical.saves[0]?.key ?? {}).sort()).toEqual([
      'chainId',
      'deploymentId',
      'registryAddress',
    ]);

    registry.queryFilter.clear();
    const { adapter: restarted } = makeAdapter(registry, 5_000, {
      cgRegistryScanPageSize: 1_000,
      contextGraphRegistryScanCursorStore: historical,
    });
    await collectRegistryScan(restarted, { mode: 'seedFromCursor', pageBudget: 1 });

    expect(registry.queryFilter.calls[0]?.slice(1)).toEqual([2_900, 3_899]);
  });

  it('keeps tip progress in memory when only the original legacy store is configured', async () => {
    const historical = new JsonLegacyRegistryScanCursorStore();
    historical.seed(LEGACY_KEY, 2_000);
    const registry = makeRegistry();
    const { adapter } = makeAdapter(registry, 10_000, {
      contextGraphRegistryScanCursorStore: historical,
    });
    registry.queryFilter.setImpl(async () => []);

    await collectRegistryScan(adapter, { mode: 'tip' });

    expect(registry.queryFilter.calls.map(([, lo, hi]: [unknown, number, number]) => [lo, hi])).toEqual([
      [8_001, 10_000],
    ]);
    expect(historical.loads).toEqual([]);
    expect(historical.saves).toEqual([]);
    expect(historical.values.get(JSON.stringify(LEGACY_KEY))).toBe(2_000);
    expect((adapter as any).contextGraphRegistryTipScanCursor.getCachedWatermark(REGISTRY))
      .toBe(10_001);
  });

  it('retains process-local tip progress across unrelated preflight invalidation', async () => {
    let head = 10_000;
    const eventBlock = 10_001;
    const registry = makeRegistry();
    const { adapter, provider } = makeAdapter(registry, head);
    provider.getBlockNumber.setImpl(async () => head);
    registry.queryFilter.setImpl(async () => []);

    await collectRegistryScan(adapter, { mode: 'tip' });
    expect((adapter as any).contextGraphRegistryTipScanCursor.getCachedWatermark(REGISTRY))
      .toBe(10_001);

    adapter.invalidatePublishPreflightCache();
    head = 13_200;
    registry.queryFilter.clear();
    registry.queryFilter.setImpl(async (_filter: unknown, lo: number, hi: number) =>
      lo <= eventBlock && eventBlock <= hi
        ? [{ topics: [], data: '0x01', blockNumber: eventBlock }]
        : [],
    );

    const recovered = await collectRegistryScan(adapter, { mode: 'tip' });

    expect(recovered.map((cg) => cg.blockNumber)).toEqual([eventBlock]);
    expect(registry.queryFilter.calls.map(([, lo, hi]: [unknown, number, number]) => [lo, hi]))
      .toEqual([
        [9_951, 11_950],
        [11_951, 13_200],
      ]);
  });

  it('persists independent historical and tip progress through one role-aware store', async () => {
    const store = new MemoryRegistryScanCursorStore();
    await store.save({ ...LEGACY_KEY, cursorKind: 'historical' }, 2_000);
    const cursorStores = registryCursorStores(store);
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
      ...cursorStores,
    });

    await collectRegistryScan(adapter, { mode: 'tip' });

    expect(store.values.get(`${LEGACY_KEY.chainId}|${LEGACY_KEY.deploymentId}|historical|${REGISTRY}`))
      .toBe(2_000);
    expect(store.values.get(`${LEGACY_KEY.chainId}|${LEGACY_KEY.deploymentId}|tip|${REGISTRY}`))
      .toBe(10_001);

    head = 13_200;
    registry.queryFilter.clear();
    const { adapter: restarted, provider } = makeAdapter(registry, head, {
      ...cursorStores,
    });
    provider.getBlockNumber.setImpl(async () => head);
    const recovered = await collectRegistryScan(restarted, { mode: 'tip' });

    expect(recovered.map((cg) => cg.blockNumber)).toEqual([eventBlock]);
    expect(registry.queryFilter.calls.map(([, lo, hi]: [unknown, number, number]) => [lo, hi])).toEqual([
      [9_951, 11_950],
      [11_951, 13_200],
    ]);
    expect(store.values.get(`${LEGACY_KEY.chainId}|${LEGACY_KEY.deploymentId}|historical|${REGISTRY}`))
      .toBe(2_000);
    expect(store.values.get(`${LEGACY_KEY.chainId}|${LEGACY_KEY.deploymentId}|tip|${REGISTRY}`))
      .toBe(13_201);
    expect(store.loads.filter((key) => key.includes('|tip|'))).toHaveLength(2);
  });

  it('fails closed on marker and acknowledgement saves without skipping the attempted tip range', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let persisted: number | undefined;
    let saveAttempt = 0;
    const store = {
      load: vi.fn(async () => persisted),
      save: vi.fn(async (_key: unknown, nextBlock: number) => {
        saveAttempt += 1;
        if (saveAttempt === 1) throw new Error('tip marker save failed');
        if (saveAttempt === 3) throw new Error('tip acknowledgement save failed');
        persisted = nextBlock;
      }),
    };
    let head = 10_000;
    const eventBlock = 10_001;
    const registry = makeRegistry({
      queryFilter: seam(async (_filter: unknown, lo: number, hi: number) =>
        lo <= eventBlock && eventBlock <= hi
          ? [{ topics: [], data: '0x01', blockNumber: eventBlock }]
          : [],
      ),
    });
    const { adapter, provider } = makeAdapter(registry, head, {
      ...registryCursorStores(store),
    });
    provider.getBlockNumber.setImpl(async () => head);

    try {
      await expect(collectRegistryScan(adapter, { mode: 'tip' }))
        .rejects.toThrow('tip marker save failed');
      expect(registry.queryFilter.calls).toEqual([]);
      expect((adapter as any).contextGraphRegistryTipScanCursor.getCachedWatermark(REGISTRY))
        .toBe(8_001);

      adapter.invalidatePublishPreflightCache();
      head = 13_000;
      registry.queryFilter.clear();
      expect((adapter as any).contextGraphRegistryTipScanCursor.getCachedWatermark(REGISTRY))
        .toBe(8_001);
      await expect(collectRegistryScan(adapter, { mode: 'tip' }))
        .rejects.toThrow('tip acknowledgement save failed');
      expect(persisted).toBe(8_001);
      expect(registry.queryFilter.calls[0]?.slice(1)).toEqual([7_951, 9_950]);

      head = 13_200;
      registry.queryFilter.clear();
      const { adapter: restarted, provider: restartedProvider } = makeAdapter(registry, head, {
        ...registryCursorStores(store),
      });
      restartedProvider.getBlockNumber.setImpl(async () => head);
      const recovered = await collectRegistryScan(restarted, { mode: 'tip' });

      expect(recovered.map((cg) => cg.blockNumber)).toEqual([eventBlock]);
      expect(registry.queryFilter.calls[0]?.slice(1)).toEqual([7_951, 9_950]);
      expect((restarted as any).contextGraphRegistryScanCursor.getCachedWatermark(REGISTRY))
        .toBeUndefined();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('fails closed when the first tip cursor read fails instead of overwriting older progress', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let persisted = 8_001;
    let loadAttempts = 0;
    const store = {
      load: vi.fn(async () => {
        loadAttempts += 1;
        if (loadAttempts === 1) throw new Error('temporary cursor read failure');
        return persisted;
      }),
      save: vi.fn(async (_key: unknown, nextBlock: number) => {
        persisted = nextBlock;
      }),
    };
    const eventBlock = 10_000;
    const registry = makeRegistry({
      queryFilter: seam(async (_filter: unknown, lo: number, hi: number) =>
        lo <= eventBlock && eventBlock <= hi
          ? [{ topics: [], data: '0x01', blockNumber: eventBlock }]
          : [],
      ),
    });
    const cursorStores = registryCursorStores(store);
    const { adapter } = makeAdapter(registry, 20_000, {
      ...cursorStores,
    });

    try {
      await expect(collectRegistryScan(adapter, { mode: 'tip' }))
        .rejects.toThrow('tip cursor load failed');
      expect(registry.queryFilter.calls).toEqual([]);
      expect(store.save).not.toHaveBeenCalled();
      expect(persisted).toBe(8_001);

      const recovered = await collectRegistryScan(adapter, { mode: 'tip' });

      expect(recovered.map((cg) => cg.blockNumber)).toEqual([eventBlock]);
      expect(registry.queryFilter.calls[0]?.slice(1)).toEqual([7_951, 9_950]);
      expect(persisted).toBe(20_001);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('fails closed when a store returns a present invalid tip cursor', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = {
      load: vi.fn(async () => 0),
      save: vi.fn(async () => undefined),
    };
    const registry = makeRegistry();
    const { adapter } = makeAdapter(registry, 20_000, {
      ...registryCursorStores(store),
    });

    try {
      await expect(collectRegistryScan(adapter, { mode: 'tip' }))
        .rejects.toThrow('tip cursor load failed');
      expect(registry.queryFilter.calls).toEqual([]);
      expect(store.save).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('revisits a fetched tip page when local application never acknowledges it', async () => {
    const store = new MemoryRegistryScanCursorStore();
    const cursorStores = registryCursorStores(store);
    const eventBlock = 9_999;
    const registry = makeRegistry({
      queryFilter: seam(async (_filter: unknown, lo: number, hi: number) =>
        lo <= eventBlock && eventBlock <= hi
          ? [{ topics: [], data: '0x01', blockNumber: eventBlock }]
          : [],
      ),
    });
    const { adapter } = makeAdapter(registry, 10_000, {
      ...cursorStores,
    });
    const iterator = adapter.scanContextGraphRegistryPages({ mode: 'tip' })[Symbol.asyncIterator]();

    const fetched = await iterator.next();
    expect(fetched.done).toBe(false);
    expect(fetched.value?.contextGraphs.map((cg) => cg.blockNumber)).toEqual([eventBlock]);
    await iterator.return?.();
    expect(store.saves.map((save) => save.nextBlock)).toEqual([8_001]);

    registry.queryFilter.clear();
    const { adapter: restarted } = makeAdapter(registry, 10_000, {
      ...cursorStores,
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
