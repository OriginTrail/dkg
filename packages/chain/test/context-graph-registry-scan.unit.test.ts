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
  readonly values = new Map<string, number>();
  readonly repairAudits = new Map<string, unknown>();
  readonly loads: string[] = [];
  readonly saves: Array<{ key: string; nextBlock: number }> = [];
  readonly repairAudit = {
    load: async (
      key: { chainId: string; deploymentId: string; registryAddress: string },
    ): Promise<unknown> => this.repairAudits.get(this.key(key)),
    save: async (
      key: { chainId: string; deploymentId: string; registryAddress: string },
      checkpoint: unknown,
    ): Promise<void> => {
      this.repairAudits.set(this.key(key), checkpoint);
    },
  };

  async load(key: { chainId: string; deploymentId: string; registryAddress: string }): Promise<number | undefined> {
    const encoded = this.key(key);
    this.loads.push(encoded);
    return this.values.get(encoded);
  }

  async save(key: { chainId: string; deploymentId: string; registryAddress: string }, nextBlock: number): Promise<void> {
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

  it('fails page acknowledgement without advancing process-local state when durable cursor save fails', async () => {
    const store = {
      load: vi.fn(async () => undefined),
      save: vi.fn(async () => {
        throw new Error('cursor save failed');
      }),
    };
    const registry = makeRegistry();
    const { adapter } = makeAdapter(registry, 2_100, {
      contextGraphRegistryScanCursorStore: store,
    });
    registry.queryFilter.setImpl(async () => []);

    await expect(collectRegistryScan(adapter, {
      mode: 'seedFromCursor',
      pageBudget: 1,
    })).rejects.toThrow('cursor save failed');

    expect((adapter as any).contextGraphRegistryScanCursor.getCachedWatermark(REGISTRY)).toBeUndefined();
  });

  it('seeds a missing live watermark at the current tail while repair owns historical backfill', async () => {
    const store = new MemoryRegistryScanCursorStore();
    const registry = makeRegistry();
    const { adapter, provider } = makeAdapter(registry, 2_100, {
      cgRegistryScanPageSize: 1_000,
      contextGraphRegistryScanCursorStore: store,
    });
    provider.getCode = seam(async () => {
      throw new Error('live-tail bootstrap must not probe the deploy block');
    });
    registry.queryFilter.setImpl(async () => []);

    await collectRegistryScan(adapter, { mode: 'seedLiveTail', pageBudget: 30 });

    expect(provider.getCode.calls).toEqual([]);
    expect(registry.queryFilter.calls.map(([, lo, hi]: [unknown, number, number]) => [lo, hi])).toEqual([
      [2_100 + 1 - CG_REGISTRY_REORG_BUFFER_BLOCKS, 2_100],
    ]);
    expect(store.saves.map((save) => save.nextBlock)).toEqual([2_101]);

    const restartedRegistry = makeRegistry();
    const { adapter: restarted, provider: restartedProvider } = makeAdapter(restartedRegistry, 2_200, {
      cgRegistryScanPageSize: 1_000,
      contextGraphRegistryScanCursorStore: store,
    });
    restartedProvider.getCode = seam(async () => {
      throw new Error('incremental restart must not probe the deploy block');
    });
    restartedRegistry.queryFilter.setImpl(async () => []);
    await collectRegistryScan(restarted, { mode: 'incremental', pageBudget: 30 });

    expect(restartedProvider.getCode.calls).toEqual([]);
    expect(restartedRegistry.queryFilter.calls.map(([, lo, hi]: [unknown, number, number]) => [lo, hi])).toEqual([
      [2_101 - CG_REGISTRY_REORG_BUFFER_BLOCKS, 2_200],
    ]);
  });

  it('replaces a corrupt live watermark with a bounded current-tail seed', async () => {
    const store = new MemoryRegistryScanCursorStore();
    const key = {
      chainId: 'evm:31337',
      deploymentId: 'evm:31337:hub=0x0000000000000000000000000000000000000001',
      registryAddress: REGISTRY,
    };
    store.values.set((store as any).key(key), 0);
    const registry = makeRegistry();
    const { adapter, provider } = makeAdapter(registry, 2_100, {
      contextGraphRegistryScanCursorStore: store,
    });
    provider.getCode = seam(async () => {
      throw new Error('corrupt-watermark recovery must not probe deploy history');
    });
    registry.queryFilter.setImpl(async () => []);

    await expect(adapter.hasContextGraphRegistryScanWatermark()).resolves.toBe(false);
    await collectRegistryScan(adapter, { mode: 'seedLiveTail', pageBudget: 30 });

    expect(provider.getCode.calls).toEqual([]);
    expect(registry.queryFilter.calls.map(([, lo, hi]: [unknown, number, number]) => [lo, hi])).toEqual([
      [2_100 + 1 - CG_REGISTRY_REORG_BUFFER_BLOCKS, 2_100],
    ]);
    expect(store.values.get((store as any).key(key))).toBe(2_101);
  });

  it('replaces a live watermark beyond the bounded rollback window and resumes after restart', async () => {
    const store = new MemoryRegistryScanCursorStore();
    const key = {
      chainId: 'evm:31337',
      deploymentId: 'evm:31337:hub=0x0000000000000000000000000000000000000001',
      registryAddress: REGISTRY,
    };
    await store.save(key, 9_000);
    const registry = makeRegistry();
    const { adapter, provider } = makeAdapter(registry, 2_100, {
      cgRegistryScanPageSize: 1_000,
      contextGraphRegistryScanCursorStore: store,
    });
    provider.getCode = seam(async () => {
      throw new Error('rollback recovery must not probe deployment history');
    });
    registry.queryFilter.setImpl(async () => []);

    await collectRegistryScan(adapter, { mode: 'incremental', pageBudget: 1 });

    expect(provider.getCode.calls).toEqual([]);
    expect(registry.queryFilter.calls.map(
      ([, lo, hi]: [unknown, number, number]) => [lo, hi],
    )).toEqual([[2_051, 2_100]]);
    expect(store.values.get((store as any).key(key))).toBe(2_101);

    const restartedRegistry = makeRegistry();
    const { adapter: restarted } = makeAdapter(restartedRegistry, 2_200, {
      cgRegistryScanPageSize: 1_000,
      contextGraphRegistryScanCursorStore: store,
    });
    restartedRegistry.queryFilter.setImpl(async () => []);
    await collectRegistryScan(restarted, { mode: 'incremental', pageBudget: 1 });
    expect(restartedRegistry.queryFilter.calls.map(
      ([, lo, hi]: [unknown, number, number]) => [lo, hi],
    )).toEqual([[2_051, 2_200]]);
    expect(store.values.get((store as any).key(key))).toBe(2_201);
  });

  it('owns live scans exclusively and rejects skipped, duplicate, concurrent, and late acknowledgements', async () => {
    const store = new MemoryRegistryScanCursorStore();
    let releaseSave: (() => void) | undefined;
    const saveGate = new Promise<void>((resolve) => { releaseSave = resolve; });
    const durableSave = store.save.bind(store);
    let blockSave = true;
    store.save = async (key, nextBlock) => {
      if (blockSave) await saveGate;
      await durableSave(key, nextBlock);
    };
    const registry = makeRegistry();
    const { adapter } = makeAdapter(registry, 2_100, {
      cgRegistryScanPageSize: 1_000,
      contextGraphRegistryScanCursorStore: store,
    });
    registry.queryFilter.setImpl(async () => []);

    const owner = adapter.scanContextGraphRegistryPages({
      mode: 'seedFromCursor',
      pageBudget: 2,
    })[Symbol.asyncIterator]();
    const first = await owner.next();
    expect(first.done).toBe(false);
    const overlap = adapter.scanContextGraphRegistryPages({
      mode: 'incremental',
      pageBudget: 1,
    })[Symbol.asyncIterator]();
    await expect(overlap.next()).rejects.toThrow('already has an active cursor owner');

    const saving = first.value.ack();
    await Promise.resolve();
    await expect(first.value.ack()).rejects.toThrow('exactly once');
    releaseSave?.();
    await saving;
    await expect(first.value.ack()).rejects.toThrow('exactly once');
    const second = await owner.next();
    expect(second.done).toBe(false);
    await owner.return?.();
    await expect(second.value.ack()).rejects.toThrow('stale or no longer owned');

    blockSave = false;
    const skipped = adapter.scanContextGraphRegistryPages({
      mode: 'incremental',
      pageBudget: 2,
    })[Symbol.asyncIterator]();
    const skippedPage = await skipped.next();
    expect(skippedPage.done).toBe(false);
    await expect(skipped.next()).rejects.toThrow('must be acknowledged before scanning continues');
  });

  it('leaves an aborted live page unacknowledged for restart replay', async () => {
    const store = new MemoryRegistryScanCursorStore();
    const registry = makeRegistry();
    const { adapter } = makeAdapter(registry, 2_100, {
      cgRegistryScanPageSize: 1_000,
      contextGraphRegistryScanCursorStore: store,
    });
    registry.queryFilter.setImpl(async () => []);
    const controller = new AbortController();
    const iterator = adapter.scanContextGraphRegistryPages({
      mode: 'seedFromCursor',
      pageBudget: 1,
      signal: controller.signal,
    })[Symbol.asyncIterator]();
    const page = await iterator.next();
    expect(page.done).toBe(false);

    controller.abort(new Error('daemon closing'));
    await expect(page.value.ack()).rejects.toThrow('daemon closing');
    await iterator.return?.();
    expect(store.saves).toEqual([]);

    const replayRegistry = makeRegistry();
    const { adapter: replay } = makeAdapter(replayRegistry, 2_100, {
      cgRegistryScanPageSize: 1_000,
      contextGraphRegistryScanCursorStore: store,
    });
    replayRegistry.queryFilter.setImpl(async () => []);
    await collectRegistryScan(replay, { mode: 'seedFromCursor', pageBudget: 1 });
    expect(replayRegistry.queryFilter.calls.map(
      ([, lo, hi]: [unknown, number, number]) => [lo, hi],
    )).toEqual([[0, 999]]);
  });

  it('fails repair closed before chain RPC when the durable repair capability is absent', async () => {
    const store = {
      load: vi.fn(async () => undefined),
      save: vi.fn(async () => {}),
    };
    const registry = makeRegistry();
    const { adapter, provider } = makeAdapter(registry, 2_100, {
      contextGraphRegistryScanCursorStore: store,
    });
    const iterator = adapter.scanContextGraphRegistryPages({
      mode: 'repair',
      pageBudget: 1,
    })[Symbol.asyncIterator]();

    await expect(iterator.next()).rejects.toThrow('durable repairAudit load/save capability');
    expect(provider.getBlockNumber.calls).toEqual([]);
    expect(provider.getCode.calls).toEqual([]);
    expect(registry.queryFilter.calls).toEqual([]);
  });

  it('bounds and resumes repair audit from an atomic cursor/target without touching the live cursor', async () => {
    const store = new MemoryRegistryScanCursorStore();
    const key = {
      chainId: 'evm:31337',
      deploymentId: 'evm:31337:hub=0x0000000000000000000000000000000000000001',
      registryAddress: REGISTRY,
    };
    await store.save(key, 3_400);
    const registry = makeRegistry();
    const { adapter } = makeAdapter(registry, 3_500, {
      cgRegistryScanPageSize: 1_000,
      contextGraphRegistryScanCursorStore: store,
    });
    registry.queryFilter.setImpl(async () => []);

    await collectRegistryScan(adapter, {
      mode: 'repair',
      pageBudget: 2,
      minimumIntervalMs: 86_400_000,
    });

    expect(registry.queryFilter.calls.map(([, lo, hi]: [unknown, number, number]) => [lo, hi])).toEqual([
      [0, 999],
      [1_000, 1_999],
    ]);
    expect(store.values.get((store as any).key(key))).toBe(3_400);
    expect(store.repairAudits.get((store as any).key(key))).toMatchObject({
      version: 1,
      nextBlock: 2_000,
      targetBlock: 3_500 - CG_REGISTRY_REORG_BUFFER_BLOCKS,
    });

    const restartedRegistry = makeRegistry();
    const { adapter: restarted, provider: restartedProvider } = makeAdapter(restartedRegistry, 3_500, {
      cgRegistryScanPageSize: 1_000,
      contextGraphRegistryScanCursorStore: store,
    });
    restartedRegistry.queryFilter.setImpl(async () => []);
    await collectRegistryScan(restarted, {
      mode: 'repair',
      pageBudget: 2,
      minimumIntervalMs: 86_400_000,
    });

    expect(restartedRegistry.queryFilter.calls.map(([, lo, hi]: [unknown, number, number]) => [lo, hi])).toEqual([
      [2_000, 2_999],
      [3_000, 3_450],
    ]);
    expect(store.values.get((store as any).key(key))).toBe(3_400);
    expect(store.repairAudits.get((store as any).key(key))).toMatchObject({
      nextBlock: 3_451,
      targetBlock: 3_450,
      completedAt: expect.any(Number),
    });

    restartedRegistry.queryFilter.clear();
    restartedProvider.getBlockNumber.clear();
    restartedProvider.getCode.clear();
    await collectRegistryScan(restarted, {
      mode: 'repair',
      pageBudget: 2,
      minimumIntervalMs: 86_400_000,
    });
    expect(restartedRegistry.queryFilter.calls).toEqual([]);
    expect(restartedProvider.getBlockNumber.calls).toEqual([]);
    expect(restartedProvider.getCode.calls).toEqual([]);

    const completed = store.repairAudits.get((store as any).key(key)) as Record<string, unknown>;
    store.repairAudits.set((store as any).key(key), {
      ...completed,
      completedAt: Date.now() - 86_400_001,
    });
    const renewedRegistry = makeRegistry();
    const { adapter: renewed } = makeAdapter(renewedRegistry, 4_000, {
      cgRegistryScanPageSize: 1_000,
      contextGraphRegistryScanCursorStore: store,
    });
    renewedRegistry.queryFilter.setImpl(async () => []);
    await collectRegistryScan(renewed, {
      mode: 'repair',
      pageBudget: 1,
      minimumIntervalMs: 86_400_000,
    });
    expect(renewedRegistry.queryFilter.calls.map(
      ([, lo, hi]: [unknown, number, number]) => [lo, hi],
    )).toEqual([[0, 999]]);
    expect(store.repairAudits.get((store as any).key(key))).toMatchObject({
      nextBlock: 1_000,
      targetBlock: 3_950,
    });
    expect(store.repairAudits.get((store as any).key(key))).not.toHaveProperty('completedAt');
  });

  it('replaces an incomplete repair generation anchored beyond the current stable head', async () => {
    const store = new MemoryRegistryScanCursorStore();
    const key = {
      chainId: 'evm:31337',
      deploymentId: 'evm:31337:hub=0x0000000000000000000000000000000000000001',
      registryAddress: REGISTRY,
    };
    const oldStartedAt = Date.now() - 10_000;
    store.repairAudits.set((store as any).key(key), {
      version: 1,
      nextBlock: 2_000,
      targetBlock: 9_000,
      startedAt: oldStartedAt,
    });
    const registry = makeRegistry();
    const { adapter } = makeAdapter(registry, 2_100, {
      cgRegistryScanPageSize: 1_000,
      contextGraphRegistryScanCursorStore: store,
    });
    registry.queryFilter.setImpl(async () => []);

    await collectRegistryScan(adapter, {
      mode: 'repair',
      pageBudget: 1,
      minimumIntervalMs: 86_400_000,
    });

    expect(registry.queryFilter.calls.map(
      ([, lo, hi]: [unknown, number, number]) => [lo, hi],
    )).toEqual([[0, 999]]);
    expect(store.repairAudits.get((store as any).key(key))).toMatchObject({
      version: 1,
      nextBlock: 1_000,
      targetBlock: 2_050,
    });
    expect((store.repairAudits.get((store as any).key(key)) as any).startedAt)
      .toBeGreaterThan(oldStartedAt);
  });

  it('does not advance repair progress when atomic checkpoint persistence rejects', async () => {
    const store = new MemoryRegistryScanCursorStore();
    const key = {
      chainId: 'evm:31337',
      deploymentId: 'evm:31337:hub=0x0000000000000000000000000000000000000001',
      registryAddress: REGISTRY,
    };
    const durableSave = store.repairAudit.save;
    let saveCalls = 0;
    store.repairAudit.save = async (cursorKey, checkpoint) => {
      saveCalls += 1;
      if (saveCalls === 2) throw new Error('repair checkpoint unavailable');
      await durableSave(cursorKey, checkpoint);
    };
    const registry = makeRegistry();
    const { adapter } = makeAdapter(registry, 2_100, {
      cgRegistryScanPageSize: 1_000,
      contextGraphRegistryScanCursorStore: store,
    });
    registry.queryFilter.setImpl(async () => []);
    const iterator = adapter.scanContextGraphRegistryPages({
      mode: 'repair',
      pageBudget: 1,
      minimumIntervalMs: 86_400_000,
    })[Symbol.asyncIterator]();
    const page = await iterator.next();
    expect(page.done).toBe(false);
    await expect(page.value.ack()).rejects.toThrow('repair checkpoint unavailable');
    await iterator.return?.();
    expect(store.repairAudits.get((store as any).key(key))).toMatchObject({
      nextBlock: 0,
      targetBlock: 2_050,
    });
    expect(store.repairAudits.get((store as any).key(key))).not.toHaveProperty('completedAt');

    store.repairAudit.save = durableSave;
    registry.queryFilter.clear();
    await collectRegistryScan(adapter, {
      mode: 'repair',
      pageBudget: 1,
      minimumIntervalMs: 86_400_000,
    });
    expect(registry.queryFilter.calls.map(
      ([, lo, hi]: [unknown, number, number]) => [lo, hi],
    )).toEqual([[0, 999]]);
    expect(store.repairAudits.get((store as any).key(key))).toMatchObject({
      nextBlock: 1_000,
      targetBlock: 2_050,
    });

    const restartedRegistry = makeRegistry();
    const { adapter: restarted } = makeAdapter(restartedRegistry, 2_100, {
      cgRegistryScanPageSize: 1_000,
      contextGraphRegistryScanCursorStore: store,
    });
    restartedRegistry.queryFilter.setImpl(async () => []);
    await collectRegistryScan(restarted, {
      mode: 'repair',
      pageBudget: 1,
      minimumIntervalMs: 86_400_000,
    });
    expect(restartedRegistry.queryFilter.calls.map(
      ([, lo, hi]: [unknown, number, number]) => [lo, hi],
    )).toEqual([[1_000, 1_999]]);
  });

  it('rejects inconsistent persisted repair checkpoints and cannot be suppressed by future time', async () => {
    const now = Date.now();
    const invalidCheckpoints = [
      { version: 1, nextBlock: 101, targetBlock: 100, startedAt: now },
      { version: 1, nextBlock: 100, targetBlock: 100, startedAt: now - 2, completedAt: now - 1 },
      { version: 1, nextBlock: 101, targetBlock: 100, startedAt: now, completedAt: now - 1 },
      {
        version: 1,
        nextBlock: 101,
        targetBlock: 100,
        startedAt: now,
        completedAt: now + 24 * 60 * 60 * 1_000,
      },
      {
        version: 1,
        nextBlock: 100,
        targetBlock: 100,
        startedAt: now + 24 * 60 * 60 * 1_000,
      },
    ];

    for (const invalid of invalidCheckpoints) {
      const store = new MemoryRegistryScanCursorStore();
      const key = {
        chainId: 'evm:31337',
        deploymentId: 'evm:31337:hub=0x0000000000000000000000000000000000000001',
        registryAddress: REGISTRY,
      };
      store.repairAudits.set((store as any).key(key), invalid);
      const registry = makeRegistry();
      const { adapter } = makeAdapter(registry, 2_100, {
        contextGraphRegistryScanCursorStore: store,
      });
      registry.queryFilter.setImpl(async () => []);

      await collectRegistryScan(adapter, {
        mode: 'repair',
        pageBudget: 1,
        minimumIntervalMs: 86_400_000,
      });

      expect(registry.queryFilter.calls).toHaveLength(1);
      expect(store.repairAudits.get((store as any).key(key))).toMatchObject({
        version: 1,
        nextBlock: 2_000,
        targetBlock: 2_100 - CG_REGISTRY_REORG_BUFFER_BLOCKS,
        startedAt: expect.any(Number),
      });
    }
  });

  it('keeps repair pages below the protected live reorg window and rejects overlap', async () => {
    const store = new MemoryRegistryScanCursorStore();
    const registry = makeRegistry();
    const { adapter } = makeAdapter(registry, 2_100, {
      cgRegistryScanPageSize: 2_000,
      contextGraphRegistryScanCursorStore: store,
    });
    registry.queryFilter.setImpl(async () => []);

    const first = adapter.scanContextGraphRegistryPages({
      mode: 'repair',
      pageBudget: 1,
      minimumIntervalMs: 86_400_000,
    })[Symbol.asyncIterator]();
    const page = await first.next();
    expect(page.done).toBe(false);
    expect(registry.queryFilter.calls.map(([, lo, hi]: [unknown, number, number]) => [lo, hi])).toEqual([
      [0, 1_999],
    ]);
    const overlap = adapter.scanContextGraphRegistryPages({
      mode: 'repair',
      pageBudget: 1,
    })[Symbol.asyncIterator]();
    await expect(overlap.next()).resolves.toMatchObject({ done: true });
    await page.value.ack();
    await first.next();
    expect(store.repairAudits.values().next().value).toMatchObject({ targetBlock: 2_050 });
  });

  it('makes the 30-logical-page repair ceiling observable independently from provider retries', async () => {
    const store = new MemoryRegistryScanCursorStore();
    const registry = makeRegistry();
    const { adapter } = makeAdapter(registry, 100_000, {
      cgRegistryScanPageSize: 100,
      contextGraphRegistryScanCursorStore: store,
    });
    registry.queryFilter.setImpl(async () => []);

    const iterator = adapter.scanContextGraphRegistryPages({
      mode: 'repair',
      pageBudget: 30,
      minimumIntervalMs: 86_400_000,
    })[Symbol.asyncIterator]();
    const progress: NonNullable<Awaited<ReturnType<typeof iterator.next>>['value']['scanProgress']>[] = [];
    while (true) {
      const next = await iterator.next();
      if (next.done) break;
      if (next.value.scanProgress) progress.push(next.value.scanProgress);
      await next.value.ack();
    }

    expect(registry.queryFilter.calls).toHaveLength(30);
    expect(registry.queryFilter.calls.at(0)?.slice(1)).toEqual([0, 99]);
    expect(registry.queryFilter.calls.at(-1)?.slice(1)).toEqual([2_900, 2_999]);
    expect(store.repairAudits.values().next().value).toMatchObject({
      nextBlock: 3_000,
      targetBlock: 100_000 - CG_REGISTRY_REORG_BUFFER_BLOCKS,
    });
    expect(progress).toHaveLength(30);
    expect(progress.at(-1)).toMatchObject({
      mode: 'repair',
      page: 30,
      pageBudget: 30,
      fromBlock: 2_900,
      toBlock: 2_999,
      targetBlock: 99_950,
      completesGeneration: false,
    });
  });

  it('attributes live and repair eth_getLogs pages to distinct bounded consumers', async () => {
    const store = new MemoryRegistryScanCursorStore();
    const registry = makeRegistry();
    const { adapter } = makeAdapter(registry, 2_100, {
      cgRegistryScanPageSize: 2_000,
      contextGraphRegistryScanCursorStore: store,
    });
    registry.queryFilter.setImpl(async () => []);
    const queryPage = vi.spyOn(adapter as any, 'queryEventLogsPage');

    await collectRegistryScan(adapter, { mode: 'seedFromCursor', pageBudget: 1 });
    await collectRegistryScan(adapter, {
      mode: 'repair',
      pageBudget: 1,
      minimumIntervalMs: 86_400_000,
    });

    expect(queryPage.mock.calls.map((call) => call.at(-1))).toEqual([
      'listContextGraphsFromChain',
      'repairContextGraphRegistry',
    ]);
  });

  it('continues cursor-resumed daemon catch-up scans from the persisted cursor', async () => {
    const store = new MemoryRegistryScanCursorStore();
    await store.save({
      chainId: 'evm:31337',
      deploymentId: 'evm:31337:hub=0x0000000000000000000000000000000000000001',
      registryAddress: REGISTRY,
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
