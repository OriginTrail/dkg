import { describe, it, expect } from 'vitest';
import { EVMChainAdapter, type EVMAdapterConfig } from '../src/evm-adapter.js';
import { ContextGraphChainScanPartialError } from '../src/chain-adapter.js';
import { CG_REGISTRY_MAX_SCAN_PAGES, CG_REGISTRY_REORG_BUFFER_BLOCKS } from '../src/evm-adapter-base.js';

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

function minimalConfig(overrides: Partial<EVMAdapterConfig> = {}): EVMAdapterConfig {
  return {
    rpcUrl: 'http://127.0.0.1:59998',
    privateKey: DEPLOYER_PK,
    adminPrivateKey: ADMIN_PK,
    hubAddress: '0x0000000000000000000000000000000000000001',
    chainId: 'evm:31337',
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

    const partial = await adapter.listContextGraphsFromChain(undefined, { incremental: true }).catch((err) => err);

    expect(partial).toBeInstanceOf(ContextGraphChainScanPartialError);
    expect(partial.partialResults).toHaveLength(1);
    expect(partial.scannedToBlock).toBe(1_999);
    expect(partial.failedFromBlock).toBe(2_000);
    expect(partial.failedToBlock).toBe(3_999);
    expect((adapter as any).contextGraphRegistryScanWatermarks.get(REGISTRY.toLowerCase())).toBe(2_000);

    registry.queryFilter.reset();
    registry.queryFilter.setImpl(async () => []);
    await adapter.listContextGraphsFromChain(undefined, { incremental: true });

    expect(registry.queryFilter.calls[0][1]).toBe(1_950);
    expect(registry.queryFilter.calls[0][2]).toBe(2_100);
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

    const partial = await adapter.listContextGraphsFromChain(undefined, { incremental: true }).catch((err) => err);

    expect(partial).toBeInstanceOf(ContextGraphChainScanPartialError);
    expect(partial.partialResults).toHaveLength(1);
    expect(partial.failedFromBlock).toBe(2_000);
    expect(partial.failedToBlock).toBe(2_100);
    expect((adapter as any).contextGraphRegistryScanWatermarks.get(REGISTRY.toLowerCase())).toBe(2_000);
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
    expect((adapter as any).contextGraphRegistryScanWatermarks.get(REGISTRY.toLowerCase())).toBeUndefined();
  });

  it('can seed the incremental watermark from an explicit successful full scan', async () => {
    const registry = makeRegistry();
    const { adapter, provider } = makeAdapter(registry, 4_000);
    registry.queryFilter.setImpl(async () => []);

    await expect(adapter.hasContextGraphRegistryScanWatermark()).resolves.toBe(false);

    await adapter.listContextGraphsFromChain(undefined, { seedIncrementalWatermark: true });

    expect((adapter as any).contextGraphRegistryScanWatermarks.get(REGISTRY.toLowerCase())).toBe(4_001);
    await expect(adapter.hasContextGraphRegistryScanWatermark()).resolves.toBe(true);

    provider.getCode = seam(async () => {
      throw new Error('eth_getCode should not be called after watermark seeding');
    });
    registry.queryFilter.clear();

    await adapter.listContextGraphsFromChain(undefined, { incremental: true });

    expect(provider.getCode.calls).toEqual([]);
    expect(registry.queryFilter.calls.map(([, lo, hi]: [unknown, number, number]) => [lo, hi])).toEqual([
      [4_001 - CG_REGISTRY_REORG_BUFFER_BLOCKS, 4_000],
    ]);
  });

  it('reports no registry scan watermark after preflight cache invalidation', async () => {
    const registry = makeRegistry();
    const { adapter } = makeAdapter(registry, 4_000);
    registry.queryFilter.setImpl(async () => []);

    await adapter.listContextGraphsFromChain(undefined, { seedIncrementalWatermark: true });
    await expect(adapter.hasContextGraphRegistryScanWatermark()).resolves.toBe(true);

    adapter.invalidatePublishPreflightCache();

    await expect(adapter.hasContextGraphRegistryScanWatermark()).resolves.toBe(false);
  });

  it('rethrows later page failures for public list-all scans', async () => {
    const registry = makeRegistry();
    const { adapter, provider } = makeAdapter(registry, 2_100);
    provider.getBlockNumber.queueOnce({ type: 'return', value: Promise.resolve(2_100) });
    registry.queryFilter.queueOnce({ type: 'return', value: Promise.resolve([]) });
    registry.queryFilter.queueOnce({ type: 'throw', error: new Error('range too wide') });

    await expect(adapter.listContextGraphsFromChain()).rejects.toThrow('range too wide');
    expect((adapter as any).contextGraphRegistryScanWatermarks.get(REGISTRY.toLowerCase())).toBeUndefined();
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
    (adapter as any).contextGraphRegistryScanWatermarks.set(REGISTRY.toLowerCase(), 2_050);

    await adapter.listContextGraphsFromChain(undefined, { incremental: true });

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

    await expect(adapter.listContextGraphsFromChain(undefined, { incremental: true })).rejects.toThrow(
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
