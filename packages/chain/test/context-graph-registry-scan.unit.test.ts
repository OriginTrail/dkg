import { describe, it, expect, vi } from 'vitest';
import { EVMChainAdapter, type EVMAdapterConfig } from '../src/evm-adapter.js';
import { ContextGraphChainScanPartialError, type ContextGraphChainScanOptions, type ContextGraphOnChain, type ContextGraphRegistryScanOptions } from '../src/chain-adapter.js';
import {
  CG_REGISTRY_MAX_SCAN_PAGES,
  CG_REGISTRY_REORG_BUFFER_BLOCKS,
} from '../src/evm-adapter-base.js';

function recorder<A extends unknown[], R>(impl: (...args: A) => R) {
  const calls: A[] = [];
  const fn = (...args: A): R => {
    calls.push(args);
    return impl(...args);
  };
  return Object.assign(fn, { calls });
}

// A mutable di-seam double: records every call and runs the current `impl`.
// `setImpl` swaps the steady-state behaviour (the no-mock analogue of
// `mockResolvedValue`/`mockReturnValue`); `queueOnce` enqueues one-shot
// outcomes consumed before the steady-state impl (the analogue of
// `mockResolvedValueOnce`/`mockRejectedValueOnce`); `reset` clears both the
// recorded calls and any queued/steady behaviour back to a returns-undefined
// default (the analogue of `mockReset`); `clear` drops only recorded calls
// (the analogue of `mockClear`).
type OnceOutcome<R> = { type: 'return'; value: R } | { type: 'throw'; error: unknown };
function seam<A extends unknown[], R>(initialImpl: (...args: A) => R) {
  const calls: A[] = [];
  const queue: OnceOutcome<R>[] = [];
  let impl = initialImpl;
  const fn = (...args: A): R => {
    calls.push(args);
    if (queue.length > 0) {
      const next = queue.shift() as OnceOutcome<R>;
      if (next.type === 'throw') throw next.error;
      return next.value;
    }
    return impl(...args);
  };
  return Object.assign(fn, {
    calls,
    setImpl(next: (...args: A) => R) {
      impl = next;
    },
    queueOnce(outcome: OnceOutcome<R>) {
      queue.push(outcome);
    },
    reset() {
      calls.length = 0;
      queue.length = 0;
      impl = (() => undefined as unknown as R) as (...args: A) => R;
    },
    clear() {
      calls.length = 0;
    },
  });
}

const DEPLOYER_PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const ADMIN_PK = '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a';
const REGISTRY = '0x3333333333333333333333333333333333333333';

class MemoryRegistryScanCursorStore {
  readonly cursorKeyVersion = 2 as const;
  readonly values = new Map<string, number>();
  readonly loads: string[] = [];
  readonly saves: Array<{ key: string; nextBlock: number }> = [];

  async load(key: { chainId: string; deploymentId: string; registryAddress: string; cursorKind: 'historical' | 'tip' }): Promise<number | undefined> {
    const encoded = this.key(key);
    this.loads.push(encoded);
    return this.values.get(encoded);
  }

  async save(key: { chainId: string; deploymentId: string; registryAddress: string; cursorKind: 'historical' | 'tip' }, nextBlock: number): Promise<void> {
    const encoded = this.key(key);
    this.saves.push({ key: encoded, nextBlock });
    this.values.set(encoded, nextBlock);
  }

  private key(key: { chainId: string; deploymentId: string; registryAddress: string; cursorKind: 'historical' | 'tip' }): string {
    return `${key.chainId}|${key.deploymentId}|${key.cursorKind}|${key.registryAddress.toLowerCase()}`;
  }
}

class LegacyRolelessRegistryScanCursorStore {
  readonly values = new Map<string, number>();
  readonly loads: string[] = [];
  readonly saves: Array<{ key: string; nextBlock: number }> = [];

  async load(key: { chainId: string; deploymentId: string; registryAddress: string }): Promise<number | undefined> {
    const encoded = this.key(key);
    this.loads.push(encoded);
    return this.values.get(encoded);
  }

  async save(
    key: { chainId: string; deploymentId: string; registryAddress: string },
    nextBlock: number,
  ): Promise<void> {
    const encoded = this.key(key);
    this.saves.push({ key: encoded, nextBlock });
    this.values.set(encoded, nextBlock);
  }

  private key(key: { chainId: string; deploymentId: string; registryAddress: string }): string {
    return `${key.chainId}|${key.deploymentId}|${key.registryAddress.toLowerCase()}`;
  }
}

function minimalConfig(overrides: Partial<EVMAdapterConfig> = {}): EVMAdapterConfig {
  return {
    rpcUrl: 'http://127.0.0.1:59998',
    privateKey: DEPLOYER_PK,
    adminPrivateKey: ADMIN_PK,
    hubAddress: '0x0000000000000000000000000000000000000001',
    chainId: 'evm:31337',
    staticNetwork: false,
    ...overrides,
  };
}

function makeRegistry(overrides: Record<string, unknown> = {}) {
  return {
    getAddress: recorder(async () => REGISTRY),
    filters: { NameClaimed: recorder(() => 'NameClaimedFilter') },
    interface: {
      parseLog: recorder(({ data }: { data: string }) => {
        if (data === '0x01') {
          return {
            name: 'NameClaimed',
            args: {
              nameHash: '0xaaa0000000000000000000000000000000000000000000000000000000000001',
              creator: '0x1111111111111111111111111111111111111111',
              accessPolicy: 0,
            },
          };
        }
        return null;
      }),
    },
    queryFilter: seam(async (_filter: unknown, _lo: number, _hi: number) => [] as unknown[]),
    connect: recorder(() => undefined),
    ...overrides,
  } as any;
}

function makeAdapter(registry: any, head = 0, config: Partial<EVMAdapterConfig> = {}) {
  const adapter = new EVMChainAdapter(minimalConfig(config));
  registry.connect = recorder(() => registry);
  const provider = {
    getBlockNumber: seam(async () => head),
    getCode: seam(async (_address: string, block?: number) =>
      block === undefined || block >= 0 ? '0x6000' : '0x',
    ),
  };
  (adapter as any).contracts = { contextGraphNameRegistry: registry };
  (adapter as any).initialized = true;
  (adapter as any).provider = provider;
  (adapter as any).providers = [provider];
  return { adapter, provider };
}

async function collectRegistryScan(
  adapter: EVMChainAdapter,
  options: ContextGraphRegistryScanOptions,
): Promise<ContextGraphOnChain[]> {
  const results: ContextGraphOnChain[] = [];
  for await (const page of adapter.scanContextGraphRegistryPages(options)) {
    results.push(...page.contextGraphs);
    await page.ack();
  }
  return results;
}

describe('EVMChainAdapter.listContextGraphsFromChain registry scan', () => {
  it('anchors at the registry deploy block and paginates with the 2,000-block default', async () => {
    const deployBlock = 1_500;
    const head = 5_500;
    const registry = makeRegistry({
      queryFilter: seam(async (_filter: unknown, lo: number, hi: number) =>
        lo <= 3_500 && 3_500 <= hi
          ? [{ topics: [], data: '0x01', blockNumber: 3_500 }]
          : [],
      ),
    });
    const { adapter, provider } = makeAdapter(registry, head);
    provider.getCode = seam(async (_address: string, block?: number) =>
      block === undefined || block >= deployBlock ? '0x6000' : '0x',
    );

    const results = await adapter.listContextGraphsFromChain();

    expect(results).toEqual([
      {
        contextGraphId: '0xaaa0000000000000000000000000000000000000000000000000000000000001',
        creator: '0x1111111111111111111111111111111111111111',
        accessPolicy: 0,
        blockNumber: 3_500,
        metadataRevealed: false,
      },
    ]);
    expect(registry.queryFilter.calls.map(([, lo, hi]: [unknown, number, number]) => [lo, hi])).toEqual([
      [1_500, 3_499],
      [3_500, 5_499],
      [5_500, 5_500],
    ]);
  });

  it('throws explicit partial scan failures with scanned-prefix results and resumes with a reorg buffer', async () => {
    const registry = makeRegistry();
    const { adapter, provider } = makeAdapter(registry, 4_999);
    provider.getBlockNumber.queueOnce({ type: 'return', value: Promise.resolve(4_999) });
    provider.getBlockNumber.queueOnce({ type: 'return', value: Promise.resolve(2_100) });
    registry.queryFilter.queueOnce({
      type: 'return',
      value: Promise.resolve([{ topics: [], data: '0x01', blockNumber: 10 }]),
    });
    registry.queryFilter.queueOnce({ type: 'throw', error: new Error('range too wide') });

    const partial = await collectRegistryScan(adapter, {
      mode: 'incremental',
    }).catch((err) => err);

    expect(partial).toBeInstanceOf(ContextGraphChainScanPartialError);
    expect(partial.partialResults).toHaveLength(1);
    expect(partial.scannedToBlock).toBe(1_999);
    expect(partial.failedFromBlock).toBe(2_000);
    expect(partial.failedToBlock).toBe(3_999);
    expect((adapter as any).contextGraphRegistryScanCursor.getCachedWatermark(REGISTRY)).toBe(2_000);

    registry.queryFilter.reset();
    registry.queryFilter.setImpl(async () => []);
    await collectRegistryScan(adapter, {
      mode: 'incremental',
    });

    expect(registry.queryFilter.calls[0][1]).toBe(1_950);
    expect(registry.queryFilter.calls[0][2]).toBe(2_100);
  });

  it('surfaces partial-prefix results for failing seeded daemon scans', async () => {
    const store = new MemoryRegistryScanCursorStore();
    const registry = makeRegistry();
    const { adapter } = makeAdapter(registry, 4_999, {
      contextGraphRegistryScanCursorStore: store,
    });
    registry.queryFilter.queueOnce({
      type: 'return',
      value: Promise.resolve([{ topics: [], data: '0x01', blockNumber: 10 }]),
    });
    registry.queryFilter.queueOnce({ type: 'throw', error: new Error('range too wide') });

    const partial = await collectRegistryScan(adapter, {
      mode: 'seedFull',
    }).catch((err) => err);

    expect(partial).toBeInstanceOf(ContextGraphChainScanPartialError);
    expect(partial.partialResults.map((cg: { blockNumber: number }) => cg.blockNumber)).toEqual([10]);
    expect(partial.scannedToBlock).toBe(1_999);
    expect(partial.failedFromBlock).toBe(2_000);
    expect(partial.failedToBlock).toBe(3_999);
    expect(store.saves.map((s) => s.nextBlock)).toEqual([2_000]);
  });

  it('probes the current tip independently while a middle historical page remains unavailable', async () => {
    let head = 4_999;
    const store = new MemoryRegistryScanCursorStore();
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
      contextGraphRegistryScanCursorStore: store,
    });
    provider.getBlockNumber.setImpl(async () => head);

    const firstRecovery = await collectRegistryScan(adapter, {
      mode: 'seedFull',
    }).catch((err) => err);

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

    // More than one configured page elapses before the next tip probe. Its independent cursor,
    // with reorg overlap, closes the interval instead of jumping to only the newest page and
    // permanently skipping the event immediately after the prior head.
    head = 13_200;
    const { adapter: restartedAdapter, provider: restartedProvider } = makeAdapter(registry, head, {
      contextGraphRegistryScanCursorStore: store,
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
    const secondRecovery = await collectRegistryScan(restartedAdapter, {
      mode: 'seedFull',
    }).catch((err) => err);

    expect(secondRecovery).toBeInstanceOf(ContextGraphChainScanPartialError);
    expect(registry.queryFilter.calls.map(([, lo, hi]: [unknown, number, number]) => [lo, hi])).toEqual([
      [0, 1_999],
      [2_000, 3_999],
    ]);
    expect((restartedAdapter as any).contextGraphRegistryScanCursor.getCachedWatermark(REGISTRY)).toBe(2_000);
  });

  it('retains the first attempted tip range when its query fails before any acknowledgement', async () => {
    const store = new MemoryRegistryScanCursorStore();
    const registry = makeRegistry({
      queryFilter: seam(async () => {
        throw new Error('first tip page unavailable');
      }),
    });
    const { adapter } = makeAdapter(registry, 10_000, {
      contextGraphRegistryScanCursorStore: store,
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
      contextGraphRegistryScanCursorStore: store,
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

  it('never aliases tip progress through a legacy role-less historical cursor store', async () => {
    const store = new LegacyRolelessRegistryScanCursorStore();
    await store.save({
      chainId: 'evm:31337',
      deploymentId: 'evm:31337:hub=0x0000000000000000000000000000000000000001',
      registryAddress: REGISTRY,
    }, 2_000);
    store.loads.length = 0;
    store.saves.length = 0;
    const registry = makeRegistry();
    const { adapter } = makeAdapter(registry, 10_000, {
      contextGraphRegistryScanCursorStore: store,
    });
    registry.queryFilter.setImpl(async () => []);

    await collectRegistryScan(adapter, { mode: 'tip' });

    expect(registry.queryFilter.calls.map(([, lo, hi]: [unknown, number, number]) => [lo, hi])).toEqual([
      [8_001, 10_000],
    ]);
    expect(store.loads).toEqual([]);
    expect(store.saves).toEqual([]);
    expect((adapter as any).contextGraphRegistryTipScanCursor.getCachedWatermark(REGISTRY)).toBe(10_001);

    await expect(adapter.hasContextGraphRegistryScanWatermark()).resolves.toBe(true);
    expect((adapter as any).contextGraphRegistryScanCursor.getCachedWatermark(REGISTRY)).toBe(2_000);
    expect([...store.values.values()]).toEqual([2_000]);
  });

  it('retains the first tip lower bound in process when durable cursor persistence fails', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = {
      cursorKeyVersion: 2 as const,
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
      contextGraphRegistryScanCursorStore: store,
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
    const eventBlock = 9_999;
    const registry = makeRegistry({
      queryFilter: seam(async (_filter: unknown, lo: number, hi: number) =>
        lo <= eventBlock && eventBlock <= hi
          ? [{ topics: [], data: '0x01', blockNumber: eventBlock }]
          : [],
      ),
    });
    const { adapter } = makeAdapter(registry, 10_000, {
      contextGraphRegistryScanCursorStore: store,
    });
    const iterator = adapter.scanContextGraphRegistryPages({ mode: 'tip' })[Symbol.asyncIterator]();

    const fetched = await iterator.next();
    expect(fetched.done).toBe(false);
    expect(fetched.value?.contextGraphs.map((cg) => cg.blockNumber)).toEqual([eventBlock]);
    await iterator.return?.();
    expect(store.saves.map((save) => save.nextBlock)).toEqual([8_001]);

    registry.queryFilter.clear();
    const { adapter: restarted } = makeAdapter(registry, 10_000, {
      contextGraphRegistryScanCursorStore: store,
    });
    const retried = await collectRegistryScan(restarted, { mode: 'tip' });

    expect(retried.map((cg) => cg.blockNumber)).toEqual([eventBlock]);
    expect(registry.queryFilter.calls.map(([, lo, hi]: [unknown, number, number]) => [lo, hi])).toEqual([
      [7_951, 9_950],
      [9_951, 10_000],
    ]);
    expect(await restarted.hasContextGraphRegistryScanWatermark()).toBe(false);
  });

  it('does not advance the incremental watermark when parsing a later page fails', async () => {
    const registry = makeRegistry({
      interface: {
        parseLog: recorder(({ data }: { data: string }) => {
          if (data === '0xbad') throw new Error('bad registry log');
          return {
            name: 'NameClaimed',
            args: {
              nameHash: '0xaaa0000000000000000000000000000000000000000000000000000000000001',
              creator: '0x1111111111111111111111111111111111111111',
              accessPolicy: 0,
            },
          };
        }),
      },
    });
    const { adapter, provider } = makeAdapter(registry, 2_100);
    provider.getBlockNumber.queueOnce({ type: 'return', value: Promise.resolve(2_100) });
    registry.queryFilter.queueOnce({
      type: 'return',
      value: Promise.resolve([{ topics: [], data: '0x01', blockNumber: 10 }]),
    });
    registry.queryFilter.queueOnce({
      type: 'return',
      value: Promise.resolve([{ topics: [], data: '0xbad', blockNumber: 2_000 }]),
    });

    const partial = await collectRegistryScan(adapter, {
      mode: 'incremental',
    }).catch((err) => err);

    expect(partial).toBeInstanceOf(ContextGraphChainScanPartialError);
    expect(partial.partialResults).toHaveLength(1);
    expect(partial.failedFromBlock).toBe(2_000);
    expect(partial.failedToBlock).toBe(2_100);
    expect((adapter as any).contextGraphRegistryScanCursor.getCachedWatermark(REGISTRY)).toBe(2_000);
  });

  it('preserves public list-all semantics unless the caller opts into incremental scans', async () => {
    const registry = makeRegistry();
    const { adapter, provider } = makeAdapter(registry, 2_100);
    provider.getBlockNumber.queueOnce({ type: 'return', value: Promise.resolve(2_100) });
    provider.getBlockNumber.queueOnce({ type: 'return', value: Promise.resolve(2_100) });
    registry.queryFilter.setImpl(async () => []);

    await adapter.listContextGraphsFromChain();
    await adapter.listContextGraphsFromChain();

    expect(registry.queryFilter.calls.map(([, lo, hi]: [unknown, number, number]) => [lo, hi])).toEqual([
      [0, 1_999],
      [2_000, 2_100],
      [0, 1_999],
      [2_000, 2_100],
    ]);
    expect((adapter as any).contextGraphRegistryScanCursor.getCachedWatermark(REGISTRY)).toBeUndefined();
  });

  it('keeps legacy public incremental option as a cursor-backed compatibility wrapper', async () => {
    const store = new MemoryRegistryScanCursorStore();
    const registry = makeRegistry();
    const { adapter, provider } = makeAdapter(registry, 2_100, {
      cgRegistryScanPageSize: 1_000,
      contextGraphRegistryScanCursorStore: store,
    });
    registry.queryFilter.setImpl(async () => []);

    await adapter.listContextGraphsFromChain(undefined, {
      incremental: true,
      pageBudget: 1,
    });

    expect(registry.queryFilter.calls.map(([, lo, hi]: [unknown, number, number]) => [lo, hi])).toEqual([
      [0, 999],
    ]);
    expect(store.saves.map((s) => s.nextBlock)).toEqual([1_000]);

    provider.getCode = seam(async () => {
      throw new Error('deploy block probing should not run with the legacy incremental cursor');
    });
    registry.queryFilter.clear();

    await adapter.listContextGraphsFromChain(undefined, {
      incremental: true,
      pageBudget: 1,
    });

    expect(provider.getCode.calls).toEqual([]);
    expect(registry.queryFilter.calls.map(([, lo, hi]: [unknown, number, number]) => [lo, hi])).toEqual([
      [1_000 - CG_REGISTRY_REORG_BUFFER_BLOCKS, 1_949],
    ]);
    expect(store.saves.map((s) => s.nextBlock)).toEqual([1_000, 1_950]);
  });

  it('keeps false and computed legacy public options source-compatible as list-all scans', async () => {
    const registry = makeRegistry();
    const { adapter } = makeAdapter(registry, 2_100, {
      cgRegistryScanPageSize: 1_000,
    });
    registry.queryFilter.setImpl(async () => []);
    const incrementalOptions = (incremental: boolean): ContextGraphChainScanOptions => ({
      incremental,
      pageBudget: 1,
    });
    const seedOptions = (seedIncrementalWatermark: boolean): ContextGraphChainScanOptions => ({
      seedIncrementalWatermark,
      resumeFromCursor: true,
      pageBudget: 1,
    });

    await adapter.listContextGraphsFromChain(undefined, incrementalOptions(false));
    await adapter.listContextGraphsFromChain(undefined, seedOptions(false));

    expect(registry.queryFilter.calls.map(([, lo, hi]: [unknown, number, number]) => [lo, hi])).toEqual([
      [0, 999],
      [1_000, 1_999],
      [2_000, 2_100],
      [0, 999],
      [1_000, 1_999],
      [2_000, 2_100],
    ]);
    expect((adapter as any).contextGraphRegistryScanCursor.getCachedWatermark(REGISTRY)).toBeUndefined();
  });

  it('keeps legacy public seed option as a full-scan watermark compatibility wrapper', async () => {
    const store = new MemoryRegistryScanCursorStore();
    const historicalGraphBlock = 10;
    const registry = makeRegistry({
      queryFilter: seam(async (_filter: unknown, lo: number, hi: number) =>
        lo <= historicalGraphBlock && historicalGraphBlock <= hi
          ? [{ topics: [], data: '0x01', blockNumber: historicalGraphBlock }]
          : [],
      ),
    });
    const { adapter } = makeAdapter(registry, 2_100, {
      cgRegistryScanPageSize: 1_000,
      contextGraphRegistryScanCursorStore: store,
    });

    const seeded = await adapter.listContextGraphsFromChain(undefined, {
      seedIncrementalWatermark: true,
    });

    expect(seeded.map((cg) => cg.blockNumber)).toEqual([historicalGraphBlock]);
    expect(registry.queryFilter.calls.map(([, lo, hi]: [unknown, number, number]) => [lo, hi])).toEqual([
      [0, 999],
      [1_000, 1_999],
      [2_000, 2_100],
    ]);
    expect(store.saves.map((s) => s.nextBlock)).toEqual([1_000, 2_000, 2_101]);
    expect((adapter as any).contextGraphRegistryScanCursor.getCachedWatermark(REGISTRY)).toBe(2_101);
  });

  it('rejects explicit daemon scan modes on the public list method', async () => {
    const registry = makeRegistry();
    const { adapter } = makeAdapter(registry, 2_100);

    await expect(adapter.listContextGraphsFromChain(undefined, {
      mode: 'incremental',
    } as any)).rejects.toThrow('scanContextGraphRegistryPages');
    expect(registry.queryFilter.calls).toEqual([]);
  });

  it('does not emit a synthetic empty terminal page for seed scans', async () => {
    const registry = makeRegistry();
    const { adapter } = makeAdapter(registry, 2_100, {
      cgRegistryScanPageSize: 1_000,
    });
    registry.queryFilter.setImpl(async () => []);

    const pageSizes: number[] = [];
    for await (const page of adapter.scanContextGraphRegistryPages({
      mode: 'seedFull',
    })) {
      pageSizes.push(page.contextGraphs.length);
      await page.ack();
    }

    expect(pageSizes).toEqual([0, 0, 0]);
    expect(registry.queryFilter.calls.map(([, lo, hi]: [unknown, number, number]) => [lo, hi])).toEqual([
      [0, 999],
      [1_000, 1_999],
      [2_000, 2_100],
    ]);
    expect((adapter as any).contextGraphRegistryScanCursor.getCachedWatermark(REGISTRY)).toBe(2_101);
  });

  it('can seed the incremental watermark from an explicit successful full scan', async () => {
    const historicalGraphBlock = 10_000;
    const head = 20_000;
    const registry = makeRegistry({
      queryFilter: seam(async (_filter: unknown, lo: number, hi: number) =>
        lo <= historicalGraphBlock && historicalGraphBlock <= hi
          ? [{ topics: [], data: '0x01', blockNumber: historicalGraphBlock }]
          : [],
      ),
    });
    const { adapter, provider } = makeAdapter(registry, head);

    await expect(adapter.hasContextGraphRegistryScanWatermark()).resolves.toBe(false);

    const seeded = await collectRegistryScan(adapter, {
      mode: 'seedFull',
    });

    expect(seeded.map((cg) => cg.blockNumber)).toEqual([historicalGraphBlock]);
    expect((adapter as any).contextGraphRegistryScanCursor.getCachedWatermark(REGISTRY)).toBe(head + 1);
    await expect(adapter.hasContextGraphRegistryScanWatermark()).resolves.toBe(true);

    provider.getCode = seam(async () => {
      throw new Error('eth_getCode should not be called after watermark seeding');
    });
    registry.queryFilter.clear();

    await collectRegistryScan(adapter, {
      mode: 'incremental',
    });

    expect(provider.getCode.calls).toEqual([]);
    expect(registry.queryFilter.calls.map(([, lo, hi]: [unknown, number, number]) => [lo, hi])).toEqual([
      [head + 1 - CG_REGISTRY_REORG_BUFFER_BLOCKS, head],
    ]);
  });

  it('persists daemon scan progress and resumes after restart with the reorg buffer', async () => {
    const store = new MemoryRegistryScanCursorStore();
    const registry = makeRegistry();
    const { adapter } = makeAdapter(registry, 5_000, {
      cgRegistryScanPageSize: 1_000,
      contextGraphRegistryScanCursorStore: store,
    });
    registry.queryFilter.setImpl(async () => []);

    await collectRegistryScan(adapter, {
      mode: 'seedFromCursor',
      pageBudget: 2,
    });

    expect(registry.queryFilter.calls.map(([, lo, hi]: [unknown, number, number]) => [lo, hi])).toEqual([
      [0, 999],
      [1_000, 1_999],
    ]);
    expect(store.saves.map((s) => s.nextBlock)).toEqual([1_000, 2_000]);

    const restartedRegistry = makeRegistry();
    const { adapter: restarted, provider } = makeAdapter(restartedRegistry, 5_000, {
      cgRegistryScanPageSize: 1_000,
      contextGraphRegistryScanCursorStore: store,
    });
    provider.getCode = seam(async () => {
      throw new Error('deploy block probing should not run with persisted cursor');
    });
    restartedRegistry.queryFilter.setImpl(async () => []);

    await expect(restarted.hasContextGraphRegistryScanWatermark()).resolves.toBe(true);
    await collectRegistryScan(restarted, {
      mode: 'incremental',
      pageBudget: 1,
    });

    expect(provider.getCode.calls).toEqual([]);
    expect(restartedRegistry.queryFilter.calls.map(([, lo, hi]: [unknown, number, number]) => [lo, hi])).toEqual([
      [2_000 - CG_REGISTRY_REORG_BUFFER_BLOCKS, 2_949],
    ]);
    expect(store.saves.map((s) => s.nextBlock)).toEqual([1_000, 2_000, 2_950]);
  });

  it('does not advance durable registry cursor until page discoveries are committed', async () => {
    const store = new MemoryRegistryScanCursorStore();
    const registry = makeRegistry({
      queryFilter: seam(async () => [{ topics: [], data: '0x01', blockNumber: 10 }]),
    });
    const { adapter } = makeAdapter(registry, 2_100, {
      cgRegistryScanPageSize: 1_000,
      contextGraphRegistryScanCursorStore: store,
    });

    const iterator = adapter.scanContextGraphRegistryPages({
      mode: 'seedFromCursor',
      pageBudget: 1,
    })[Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(first.done).toBe(false);
    expect(first.value.contextGraphs).toHaveLength(1);
    expect(store.saves).toEqual([]);
    expect((adapter as any).contextGraphRegistryScanCursor.getCachedWatermark(REGISTRY)).toBeUndefined();
    await iterator.return?.();

    const restartedRegistry = makeRegistry();
    const { adapter: restarted } = makeAdapter(restartedRegistry, 2_100, {
      cgRegistryScanPageSize: 1_000,
      contextGraphRegistryScanCursorStore: store,
    });
    restartedRegistry.queryFilter.setImpl(async () => []);

    await collectRegistryScan(restarted, {
      mode: 'seedFromCursor',
      pageBudget: 1,
    });

    expect(restartedRegistry.queryFilter.calls.map(([, lo, hi]: [unknown, number, number]) => [lo, hi])).toEqual([
      [0, 999],
    ]);
    expect(store.saves.map((s) => s.nextBlock)).toEqual([1_000]);
  });

  it('falls back to deploy-block scanning when durable cursor load fails', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = {
      load: vi.fn(async () => {
        throw new Error('cursor load failed');
      }),
      save: vi.fn(async () => {}),
    };
    try {
      const registry = makeRegistry();
      const { adapter } = makeAdapter(registry, 2_100, {
        contextGraphRegistryScanCursorStore: store,
      });
      registry.queryFilter.setImpl(async () => []);

      await collectRegistryScan(adapter, {
        mode: 'seedFromCursor',
        pageBudget: 1,
      });

      expect(store.load).toHaveBeenCalledTimes(1);
      expect(registry.queryFilter.calls.map(([, lo, hi]: [unknown, number, number]) => [lo, hi])).toEqual([
        [0, 1_999],
      ]);
      expect(store.save).toHaveBeenCalledWith(expect.any(Object), 2_000);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('keeps save failures non-fatal and advances the process-local registry cursor', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = {
      load: vi.fn(async () => undefined),
      save: vi.fn(async () => {
        throw new Error('cursor save failed');
      }),
    };
    try {
      const registry = makeRegistry();
      const { adapter, provider } = makeAdapter(registry, 2_100, {
        contextGraphRegistryScanCursorStore: store,
      });
      registry.queryFilter.setImpl(async () => []);

      await collectRegistryScan(adapter, {
        mode: 'seedFull',
      });

      expect((adapter as any).contextGraphRegistryScanCursor.getCachedWatermark(REGISTRY)).toBe(2_101);
      provider.getCode = seam(async () => {
        throw new Error('deploy block probing should not run with process-local cursor');
      });
      registry.queryFilter.clear();

      await collectRegistryScan(adapter, {
        mode: 'incremental',
      });

      expect(provider.getCode.calls).toEqual([]);
      expect(registry.queryFilter.calls.map(([, lo, hi]: [unknown, number, number]) => [lo, hi])).toEqual([
        [2_101 - CG_REGISTRY_REORG_BUFFER_BLOCKS, 2_100],
      ]);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('continues cursor-resumed daemon catch-up scans from the persisted cursor', async () => {
    const store = new MemoryRegistryScanCursorStore();
    await store.save({
      chainId: 'evm:31337',
      deploymentId: 'evm:31337:hub=0x0000000000000000000000000000000000000001',
      registryAddress: REGISTRY,
      cursorKind: 'historical',
    }, 3_000);

    const registry = makeRegistry();
    const { adapter, provider } = makeAdapter(registry, 5_000, {
      cgRegistryScanPageSize: 1_000,
      contextGraphRegistryScanCursorStore: store,
    });
    provider.getCode = seam(async () => {
      throw new Error('deploy block probing should not run with persisted cursor');
    });
    registry.queryFilter.setImpl(async () => []);

    await collectRegistryScan(adapter, {
      mode: 'seedFromCursor',
      pageBudget: 1,
    });

    expect(provider.getCode.calls).toEqual([]);
    expect(registry.queryFilter.calls.map(([, lo, hi]: [unknown, number, number]) => [lo, hi])).toEqual([
      [3_000 - CG_REGISTRY_REORG_BUFFER_BLOCKS, 3_949],
    ]);
    expect(store.saves.map((s) => s.nextBlock)).toEqual([3_000, 3_950]);
  });

  it('keeps periodic full-recovery seeded scans full even when a daemon cursor is persisted', async () => {
    const store = new MemoryRegistryScanCursorStore();
    await store.save({
      chainId: 'evm:31337',
      deploymentId: 'evm:31337:hub=0x0000000000000000000000000000000000000001',
      registryAddress: REGISTRY,
      cursorKind: 'historical',
    }, 3_000);
    const registry = makeRegistry({
      queryFilter: seam(async (_filter: unknown, lo: number, hi: number) =>
        lo <= 10 && 10 <= hi
          ? [{ topics: [], data: '0x01', blockNumber: 10 }]
          : [],
      ),
    });
    const { adapter } = makeAdapter(registry, 3_500, {
      cgRegistryScanPageSize: 1_000,
      contextGraphRegistryScanCursorStore: store,
    });

    const results = await collectRegistryScan(adapter, {
      mode: 'seedFull',
    });

    expect(results.map((cg) => cg.blockNumber)).toEqual([10]);
    expect(registry.queryFilter.calls.map(([, lo, hi]: [unknown, number, number]) => [lo, hi])).toEqual([
      [0, 999],
      [1_000, 1_999],
      [2_000, 2_999],
      [3_000, 3_500],
    ]);
    expect(store.saves.map((s) => s.nextBlock)).toEqual([3_000, 3_501]);
  });

  it('keeps public list-all scans complete even when a daemon cursor is persisted', async () => {
    const store = new MemoryRegistryScanCursorStore();
    const seedRegistry = makeRegistry();
    const { adapter: seedAdapter } = makeAdapter(seedRegistry, 2_100, {
      contextGraphRegistryScanCursorStore: store,
    });
    seedRegistry.queryFilter.setImpl(async () => []);

    await collectRegistryScan(seedAdapter, {
      mode: 'seedFromCursor',
      pageBudget: 1,
    });

    const publicRegistry = makeRegistry();
    const { adapter: publicAdapter } = makeAdapter(publicRegistry, 2_100, {
      contextGraphRegistryScanCursorStore: store,
    });
    publicRegistry.queryFilter.setImpl(async () => []);

    await publicAdapter.listContextGraphsFromChain();

    expect(publicRegistry.queryFilter.calls.map(([, lo, hi]: [unknown, number, number]) => [lo, hi])).toEqual([
      [0, 1_999],
      [2_000, 2_100],
    ]);
  });

  it('reports no registry scan watermark after preflight cache invalidation without a durable store', async () => {
    const registry = makeRegistry();
    const { adapter } = makeAdapter(registry, 4_000);
    registry.queryFilter.setImpl(async () => []);

    await collectRegistryScan(adapter, {
      mode: 'seedFull',
    });
    await expect(adapter.hasContextGraphRegistryScanWatermark()).resolves.toBe(true);

    adapter.invalidatePublishPreflightCache();

    await expect(adapter.hasContextGraphRegistryScanWatermark()).resolves.toBe(false);
  });

  it('preflight cache invalidation clears only the in-memory registry cursor cache', async () => {
    const store = new MemoryRegistryScanCursorStore();
    const registry = makeRegistry();
    const { adapter } = makeAdapter(registry, 4_000, {
      contextGraphRegistryScanCursorStore: store,
    });
    registry.queryFilter.setImpl(async () => []);

    await collectRegistryScan(adapter, {
      mode: 'seedFull',
    });
    await expect(adapter.hasContextGraphRegistryScanWatermark()).resolves.toBe(true);

    adapter.invalidatePublishPreflightCache();

    expect((adapter as any).contextGraphRegistryScanCursor.getCachedWatermark(REGISTRY)).toBeUndefined();
    await expect(adapter.hasContextGraphRegistryScanWatermark()).resolves.toBe(true);
  });

  it('rethrows later page failures for public list-all scans', async () => {
    const registry = makeRegistry();
    const { adapter, provider } = makeAdapter(registry, 2_100);
    provider.getBlockNumber.queueOnce({ type: 'return', value: Promise.resolve(2_100) });
    registry.queryFilter.queueOnce({ type: 'return', value: Promise.resolve([]) });
    registry.queryFilter.queueOnce({ type: 'throw', error: new Error('range too wide') });

    await expect(adapter.listContextGraphsFromChain()).rejects.toThrow('range too wide');
    expect((adapter as any).contextGraphRegistryScanCursor.getCachedWatermark(REGISTRY)).toBeUndefined();
  });

  it('does not require deploy-block probing when fromBlock is explicit', async () => {
    const registry = makeRegistry();
    const { adapter, provider } = makeAdapter(registry, 2_100);
    provider.getCode = seam(async () => {
      throw new Error('eth_getCode should not be called');
    });
    registry.queryFilter.setImpl(async () => []);

    await adapter.listContextGraphsFromChain(1_234);

    expect(provider.getCode.calls).toEqual([]);
    expect(registry.queryFilter.calls.map(([, lo, hi]: [unknown, number, number]) => [lo, hi])).toEqual([
      [1_234, 2_100],
    ]);
  });

  it('resumes incremental scans from the watermark without deploy-block probing', async () => {
    const registry = makeRegistry();
    const { adapter, provider } = makeAdapter(registry, 2_100);
    provider.getCode = seam(async () => {
      throw new Error('eth_getCode should not be called');
    });
    registry.queryFilter.setImpl(async () => []);
    await (adapter as any).contextGraphRegistryScanCursor.saveWatermark(REGISTRY, 2_050);

    await collectRegistryScan(adapter, {
      mode: 'incremental',
    });

    expect(provider.getCode.calls).toEqual([]);
    expect(registry.queryFilter.calls.map(([, lo, hi]: [unknown, number, number]) => [lo, hi])).toEqual([
      [2_050 - CG_REGISTRY_REORG_BUFFER_BLOCKS, 2_100],
    ]);
  });

  it('allows default registry scans beyond the old 3M page-count cap', async () => {
    const registry = makeRegistry();
    const { adapter } = makeAdapter(registry, 4_000_000);
    registry.queryFilter.setImpl(async () => []);

    await expect(adapter.listContextGraphsFromChain()).resolves.toEqual([]);

    expect(registry.queryFilter.calls).toHaveLength(Math.ceil((4_000_000 + 1) / 2_000));
  });

  it('lets larger cgRegistryScanPageSize extend the block span at the same page budget', async () => {
    const registry = makeRegistry();
    const head = 20_000_000;
    const pageSize = 10_000;
    const { adapter } = makeAdapter(registry, head, { cgRegistryScanPageSize: pageSize });
    registry.queryFilter.setImpl(async () => []);

    await expect(adapter.listContextGraphsFromChain()).resolves.toEqual([]);

    expect(registry.queryFilter.calls).toHaveLength(Math.ceil((head + 1) / pageSize));
  });

  it('keeps public list-all scans complete beyond the incremental page budget', async () => {
    const registry = makeRegistry();
    const defaultPageSize = 2_000;
    const defaultBlockBudget = CG_REGISTRY_MAX_SCAN_PAGES * defaultPageSize;
    const { adapter } = makeAdapter(registry, defaultBlockBudget);
    registry.queryFilter.setImpl(async () => []);

    await expect(adapter.listContextGraphsFromChain()).resolves.toEqual([]);

    expect(registry.queryFilter.calls).toHaveLength(CG_REGISTRY_MAX_SCAN_PAGES + 1);
  });

  it('throws before queryFilter when an incremental registry scan would exceed the page budget', async () => {
    const registry = makeRegistry();
    const defaultPageSize = 2_000;
    const defaultBlockBudget = CG_REGISTRY_MAX_SCAN_PAGES * defaultPageSize;
    const { adapter } = makeAdapter(registry, defaultBlockBudget);

    await expect(collectRegistryScan(adapter, {
      mode: 'incremental',
    })).rejects.toThrow(
      new RegExp(`incremental ContextGraphNameRegistry scan would need.*budget ${CG_REGISTRY_MAX_SCAN_PAGES} pages`),
    );
    expect(registry.queryFilter.calls).toEqual([]);
  });

  it('keeps degraded non-archive genesis fallback complete beyond the page budget', async () => {
    const registry = makeRegistry();
    const defaultPageSize = 2_000;
    const defaultBlockBudget = CG_REGISTRY_MAX_SCAN_PAGES * defaultPageSize;
    const { adapter, provider } = makeAdapter(registry, defaultBlockBudget);
    provider.getCode = seam(async () => {
      throw new Error('missing trie node (pruned node)');
    });
    registry.queryFilter.setImpl(async () => []);

    await expect(adapter.listContextGraphsFromChain()).resolves.toEqual([]);

    expect(registry.queryFilter.calls).toHaveLength(CG_REGISTRY_MAX_SCAN_PAGES + 1);
  });

  it('honors cgRegistryScanPageSize and defaults invalid values', () => {
    const tuned = new EVMChainAdapter(minimalConfig({ cgRegistryScanPageSize: 10_000.5 }));
    expect((tuned as any).cgRegistryScanPageSize).toBe(10_000);

    const defaulted = new EVMChainAdapter(minimalConfig({ cgRegistryScanPageSize: 0.5 }));
    expect((defaulted as any).cgRegistryScanPageSize).toBe(2_000);
  });
});
