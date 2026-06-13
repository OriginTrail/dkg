import { describe, it, expect, vi } from 'vitest';
import { EVMChainAdapter, type EVMAdapterConfig } from '../src/evm-adapter.js';
import { ContextGraphChainScanPartialError } from '../src/chain-adapter.js';
import { CG_REGISTRY_MAX_SCAN_PAGES, CG_REGISTRY_REORG_BUFFER_BLOCKS } from '../src/evm-adapter-base.js';

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
    getAddress: vi.fn(async () => REGISTRY),
    filters: { NameClaimed: vi.fn(() => 'NameClaimedFilter') },
    interface: {
      parseLog: vi.fn(({ data }: { data: string }) => {
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
    queryFilter: vi.fn(async () => []),
    connect: vi.fn(),
    ...overrides,
  } as any;
}

function makeAdapter(registry: any, head = 0, config: Partial<EVMAdapterConfig> = {}) {
  const adapter = new EVMChainAdapter(minimalConfig(config));
  registry.connect = vi.fn(() => registry);
  const provider = {
    getBlockNumber: vi.fn(async () => head),
    getCode: vi.fn(async (_address: string, block?: number) =>
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
      queryFilter: vi.fn(async (_filter: unknown, lo: number, hi: number) =>
        lo <= 3_500 && 3_500 <= hi
          ? [{ topics: [], data: '0x01', blockNumber: 3_500 }]
          : [],
      ),
    });
    const { adapter, provider } = makeAdapter(registry, head);
    provider.getCode = vi.fn(async (_address: string, block?: number) =>
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
    expect(registry.queryFilter.mock.calls.map(([, lo, hi]: [unknown, number, number]) => [lo, hi])).toEqual([
      [1_500, 3_499],
      [3_500, 5_499],
      [5_500, 5_500],
    ]);
  });

  it('throws explicit partial scan failures with scanned-prefix results and resumes with a reorg buffer', async () => {
    const registry = makeRegistry();
    const { adapter, provider } = makeAdapter(registry, 4_999);
    provider.getBlockNumber
      .mockResolvedValueOnce(4_999)
      .mockResolvedValueOnce(2_100);
    registry.queryFilter
      .mockResolvedValueOnce([{ topics: [], data: '0x01', blockNumber: 10 }])
      .mockRejectedValueOnce(new Error('range too wide'));

    const partial = await adapter.listContextGraphsFromChain(undefined, { incremental: true }).catch((err) => err);

    expect(partial).toBeInstanceOf(ContextGraphChainScanPartialError);
    expect(partial.partialResults).toHaveLength(1);
    expect(partial.scannedToBlock).toBe(1_999);
    expect(partial.failedFromBlock).toBe(2_000);
    expect(partial.failedToBlock).toBe(3_999);
    expect((adapter as any).contextGraphRegistryScanWatermarks.get(REGISTRY.toLowerCase())).toBe(2_000);

    registry.queryFilter.mockReset();
    registry.queryFilter.mockResolvedValue([]);
    await adapter.listContextGraphsFromChain(undefined, { incremental: true });

    expect(registry.queryFilter.mock.calls[0][1]).toBe(1_950);
    expect(registry.queryFilter.mock.calls[0][2]).toBe(2_100);
  });

  it('does not advance the incremental watermark when parsing a later page fails', async () => {
    const registry = makeRegistry({
      interface: {
        parseLog: vi.fn(({ data }: { data: string }) => {
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
    provider.getBlockNumber.mockResolvedValueOnce(2_100);
    registry.queryFilter
      .mockResolvedValueOnce([{ topics: [], data: '0x01', blockNumber: 10 }])
      .mockResolvedValueOnce([{ topics: [], data: '0xbad', blockNumber: 2_000 }]);

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
    provider.getBlockNumber
      .mockResolvedValueOnce(2_100)
      .mockResolvedValueOnce(2_100);
    registry.queryFilter.mockResolvedValue([]);

    await adapter.listContextGraphsFromChain();
    await adapter.listContextGraphsFromChain();

    expect(registry.queryFilter.mock.calls.map(([, lo, hi]: [unknown, number, number]) => [lo, hi])).toEqual([
      [0, 1_999],
      [2_000, 2_100],
      [0, 1_999],
      [2_000, 2_100],
    ]);
    expect((adapter as any).contextGraphRegistryScanWatermarks.get(REGISTRY.toLowerCase())).toBeUndefined();
  });

  it('rethrows later page failures for public list-all scans', async () => {
    const registry = makeRegistry();
    const { adapter, provider } = makeAdapter(registry, 2_100);
    provider.getBlockNumber.mockResolvedValueOnce(2_100);
    registry.queryFilter.mockResolvedValueOnce([]).mockRejectedValueOnce(new Error('range too wide'));

    await expect(adapter.listContextGraphsFromChain()).rejects.toThrow('range too wide');
    expect((adapter as any).contextGraphRegistryScanWatermarks.get(REGISTRY.toLowerCase())).toBeUndefined();
  });

  it('does not require deploy-block probing when fromBlock is explicit', async () => {
    const registry = makeRegistry();
    const { adapter, provider } = makeAdapter(registry, 2_100);
    provider.getCode = vi.fn(async () => {
      throw new Error('eth_getCode should not be called');
    });
    registry.queryFilter.mockResolvedValue([]);

    await adapter.listContextGraphsFromChain(1_234);

    expect(provider.getCode).not.toHaveBeenCalled();
    expect(registry.queryFilter.mock.calls.map(([, lo, hi]: [unknown, number, number]) => [lo, hi])).toEqual([
      [1_234, 2_100],
    ]);
  });

  it('resumes incremental scans from the watermark without deploy-block probing', async () => {
    const registry = makeRegistry();
    const { adapter, provider } = makeAdapter(registry, 2_100);
    provider.getCode = vi.fn(async () => {
      throw new Error('eth_getCode should not be called');
    });
    registry.queryFilter.mockResolvedValue([]);
    (adapter as any).contextGraphRegistryScanWatermarks.set(REGISTRY.toLowerCase(), 2_050);

    await adapter.listContextGraphsFromChain(undefined, { incremental: true });

    expect(provider.getCode).not.toHaveBeenCalled();
    expect(registry.queryFilter.mock.calls.map(([, lo, hi]: [unknown, number, number]) => [lo, hi])).toEqual([
      [2_050 - CG_REGISTRY_REORG_BUFFER_BLOCKS, 2_100],
    ]);
  });

  it('allows default registry scans beyond the old 3M page-count cap', async () => {
    const registry = makeRegistry();
    const { adapter } = makeAdapter(registry, 4_000_000);
    registry.queryFilter.mockResolvedValue([]);

    await expect(adapter.listContextGraphsFromChain()).resolves.toEqual([]);

    expect(registry.queryFilter).toHaveBeenCalledTimes(Math.ceil((4_000_000 + 1) / 2_000));
  });

  it('lets larger cgRegistryScanPageSize extend the block span at the same page budget', async () => {
    const registry = makeRegistry();
    const head = 20_000_000;
    const pageSize = 10_000;
    const { adapter } = makeAdapter(registry, head, { cgRegistryScanPageSize: pageSize });
    registry.queryFilter.mockResolvedValue([]);

    await expect(adapter.listContextGraphsFromChain()).resolves.toEqual([]);

    expect(registry.queryFilter).toHaveBeenCalledTimes(Math.ceil((head + 1) / pageSize));
  });

  it('throws before queryFilter when the bounded registry scan would exceed the page budget', async () => {
    const registry = makeRegistry();
    const defaultPageSize = 2_000;
    const defaultBlockBudget = CG_REGISTRY_MAX_SCAN_PAGES * defaultPageSize;
    const { adapter } = makeAdapter(registry, defaultBlockBudget);

    await expect(adapter.listContextGraphsFromChain()).rejects.toThrow(
      new RegExp(`ContextGraphNameRegistry scan would need.*budget ${CG_REGISTRY_MAX_SCAN_PAGES} pages`),
    );
    expect(registry.queryFilter).not.toHaveBeenCalled();
  });

  it('keeps degraded non-archive genesis fallback complete beyond the page budget', async () => {
    const registry = makeRegistry();
    const defaultPageSize = 2_000;
    const defaultBlockBudget = CG_REGISTRY_MAX_SCAN_PAGES * defaultPageSize;
    const { adapter, provider } = makeAdapter(registry, defaultBlockBudget);
    provider.getCode = vi.fn(async () => {
      throw new Error('missing trie node (pruned node)');
    });
    registry.queryFilter.mockResolvedValue([]);

    await expect(adapter.listContextGraphsFromChain()).resolves.toEqual([]);

    expect(registry.queryFilter).toHaveBeenCalledTimes(CG_REGISTRY_MAX_SCAN_PAGES + 1);
  });

  it('honors cgRegistryScanPageSize and defaults invalid values', () => {
    const tuned = new EVMChainAdapter(minimalConfig({ cgRegistryScanPageSize: 10_000.5 }));
    expect((tuned as any).cgRegistryScanPageSize).toBe(10_000);

    const defaulted = new EVMChainAdapter(minimalConfig({ cgRegistryScanPageSize: 0.5 }));
    expect((defaulted as any).cgRegistryScanPageSize).toBe(2_000);
  });
});
