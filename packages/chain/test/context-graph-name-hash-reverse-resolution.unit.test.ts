import { describe, expect, it, vi } from 'vitest';
import { EVMChainAdapter, type EVMAdapterConfig } from '../src/evm-adapter.js';
import { CG_REGISTRY_MAX_SCAN_PAGES } from '../src/evm-adapter-base.js';

const PRIVATE_KEY =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const STORAGE = '0x00000000000000000000000000000000000000c6';
const NAME_HASH = `0x${'ab'.repeat(32)}`;
const OTHER_HASH = `0x${'cd'.repeat(32)}`;

function minimalConfig(): EVMAdapterConfig {
  return {
    rpcUrl: 'http://127.0.0.1:59998',
    privateKey: PRIVATE_KEY,
    hubAddress: '0x0000000000000000000000000000000000000001',
    chainId: 'evm:31337',
    staticNetwork: false,
    cgRegistryScanPageSize: 2,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function fixture(pages: ReadonlyArray<ReadonlyArray<bigint>> = [[42n]]) {
  const adapter: any = new EVMChainAdapter(minimalConfig());
  adapter.initialized = true;
  adapter.init = vi.fn(async () => {});
  const provider = {};
  const filter = { exactNameHash: NAME_HASH };
  const filterFactory = vi.fn(() => filter);
  const parseLog = vi.fn(({ data }: { data: string }) => ({
    name: 'ContextGraphCreated',
    args: { contextGraphId: BigInt(data) },
  }));
  const storage = {
    getAddress: vi.fn(async () => STORAGE),
    filters: { ContextGraphCreated: filterFactory },
    interface: { parseLog },
  };
  adapter.contracts = { contextGraphStorage: storage };
  adapter.resolveContractDeployBlock = vi.fn(async () => ({
    fromBlock: 100,
    head: 100 + pages.length * 2 - 1,
    scanProviders: [{ provider, backendHead: 100 + pages.length * 2 - 1 }],
  }));
  const queryEventLogsPage = vi.fn(async (...args: unknown[]) => {
    const lo = Number(args[2]);
    const pageIndex = Math.floor((lo - 100) / 2);
    return {
      logs: (pages[pageIndex] ?? []).map((id) => ({
        topics: [],
        data: id.toString(),
      })),
      provider,
    };
  });
  adapter.queryEventLogsPage = queryEventLogsPage;
  adapter.getContextGraphNameHash = vi.fn(async () => NAME_HASH);
  return {
    adapter,
    filter,
    filterFactory,
    queryEventLogsPage,
  };
}

describe('ContextGraphCreated name-hash reverse resolution', () => {
  it('queries the exact indexed topic in deploy-anchored pages and verifies the live slot', async () => {
    const { adapter, filter, filterFactory, queryEventLogsPage } = fixture([
      [],
      [42n],
      [],
    ]);

    await expect(adapter.resolveContextGraphIdByNameHash(NAME_HASH)).resolves.toBe(42n);

    expect(filterFactory).toHaveBeenCalledWith(null, null, NAME_HASH);
    expect(queryEventLogsPage.mock.calls.map((call) => [call[1], call[2], call[3]])).toEqual([
      [filter, 100, 101],
      [filter, 102, 103],
      [filter, 104, 105],
    ]);
    expect(adapter.getContextGraphNameHash).toHaveBeenCalledWith(42n);

    expect(queryEventLogsPage).toHaveBeenCalledTimes(3);
  });

  it('single-flights concurrent callers and lets one caller stop waiting', async () => {
    const { adapter, queryEventLogsPage } = fixture();
    const pending = deferred<{ logs: Array<{ topics: string[]; data: string }>; provider: object }>();
    queryEventLogsPage.mockImplementation(() => pending.promise);
    const controller = new AbortController();

    const aborted = adapter.resolveContextGraphIdByNameHash(NAME_HASH, {
      signal: controller.signal,
    });
    const survivor = adapter.resolveContextGraphIdByNameHash(NAME_HASH);
    controller.abort(new Error('caller stopped'));

    await expect(aborted).rejects.toThrow('caller stopped');
    pending.resolve({
      logs: [{ topics: [], data: '42' }],
      provider: {},
    });
    await expect(survivor).resolves.toBe(42n);
    expect(queryEventLogsPage).toHaveBeenCalledTimes(1);
  });

  it('rescans a positive result so a later duplicate fails closed', async () => {
    const { adapter, queryEventLogsPage } = fixture([[42n]]);
    await expect(adapter.resolveContextGraphIdByNameHash(NAME_HASH)).resolves.toBe(42n);

    queryEventLogsPage.mockResolvedValue({
      logs: [
        { topics: [], data: '42' },
        { topics: [], data: '43' },
      ],
      provider: {},
    });
    await expect(adapter.resolveContextGraphIdByNameHash(NAME_HASH)).rejects.toThrow(
      /ambiguous.*2 numeric ids/i,
    );
  });

  it('fails closed when one name hash was committed to multiple numeric slots', async () => {
    const { adapter } = fixture([[42n, 43n]]);
    await expect(adapter.resolveContextGraphIdByNameHash(NAME_HASH)).rejects.toThrow(
      /ambiguous.*2 numeric ids/i,
    );
    expect(adapter.getContextGraphNameHash).not.toHaveBeenCalled();
  });

  it('rejects an over-budget historical span before issuing any page query', async () => {
    const { adapter, queryEventLogsPage } = fixture();
    adapter.resolveContractDeployBlock = vi.fn(async () => ({
      fromBlock: 100,
      head: 100 + (CG_REGISTRY_MAX_SCAN_PAGES * 2),
      scanProviders: [{ provider: {}, backendHead: 100 + (CG_REGISTRY_MAX_SCAN_PAGES * 2) }],
    }));

    await expect(adapter.resolveContextGraphIdByNameHash(NAME_HASH)).rejects.toThrow(
      new RegExp(`budget ${CG_REGISTRY_MAX_SCAN_PAGES} pages`),
    );
    expect(queryEventLogsPage).not.toHaveBeenCalled();
  });

  it('fails closed when the live slot no longer matches the indexed commitment', async () => {
    const { adapter } = fixture([[42n]]);
    adapter.getContextGraphNameHash = vi.fn(async () => OTHER_HASH);
    await expect(adapter.resolveContextGraphIdByNameHash(NAME_HASH)).rejects.toThrow(
      /currently commits.*expected/i,
    );
  });

  it('short-caches an exact-topic miss and retries after the TTL', async () => {
    vi.useFakeTimers({ now: 0 });
    try {
      const { adapter, queryEventLogsPage } = fixture([[]]);
      await expect(adapter.resolveContextGraphIdByNameHash(NAME_HASH)).resolves.toBeNull();
      await expect(adapter.resolveContextGraphIdByNameHash(NAME_HASH)).resolves.toBeNull();
      expect(queryEventLogsPage).toHaveBeenCalledTimes(1);

      vi.setSystemTime(30_001);
      queryEventLogsPage.mockResolvedValueOnce({
        logs: [{ topics: [], data: '42' }],
        provider: {},
      });
      await expect(adapter.resolveContextGraphIdByNameHash(NAME_HASH)).resolves.toBe(42n);
      expect(queryEventLogsPage).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects malformed inputs before chain initialisation and treats zero as opt-out', async () => {
    const { adapter } = fixture();
    await expect(adapter.resolveContextGraphIdByNameHash('not-a-hash')).rejects.toThrow(
      /bytes32 nameHash/,
    );
    await expect(adapter.resolveContextGraphIdByNameHash(`0x${'00'.repeat(32)}`)).resolves.toBeNull();
    expect(adapter.init).not.toHaveBeenCalled();
  });
});
