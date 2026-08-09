import { ethers } from 'ethers';
import { describe, expect, it, vi } from 'vitest';
import { EVMChainAdapter, type EVMAdapterConfig } from '../src/evm-adapter.js';
import {
  CONTEXT_GRAPH_NAME_HASH_ENUMERATION_CONCURRENCY,
  CONTEXT_GRAPH_NAME_HASH_FAST_ENUMERATION_MAX_IDS,
} from '../src/context-graph-name-hash-resolver.js';
import { CG_REGISTRY_MAX_SCAN_PAGES } from '../src/evm-adapter-base.js';

const PRIVATE_KEY =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
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

function fixture(initialHashes: ReadonlyArray<string | null> = [NAME_HASH]) {
  const adapter: any = new EVMChainAdapter(minimalConfig());
  adapter.initialized = true;
  adapter.init = vi.fn(async () => {});
  let storageAddress = '0x00000000000000000000000000000000000000c6';
  const contextGraphStorage = {
    getAddress: vi.fn(async () => storageAddress),
  };
  adapter.contracts = { contextGraphStorage };
  let anchorHash = `0x${'11'.repeat(32)}`;
  adapter.captureContextGraphNameHashIndexAnchor = vi.fn(async () => ({
    blockNumber: 100,
    blockHash: anchorHash,
  }));
  adapter.loadContextGraphNameHashIndexAnchorHash = vi.fn(async () => anchorHash);

  let latestId = BigInt(initialHashes.length);
  const hashes = new Map<bigint, string | null>(
    initialHashes.map((hash, index) => [BigInt(index + 1), hash]),
  );
  const readContractWithOptions = vi.fn(async (
    _contract: unknown,
    _label: string,
    method: string,
    args: readonly unknown[],
    _options: { signal?: AbortSignal },
  ) => {
    if (method === 'getLatestContextGraphId') return latestId;
    if (method === 'getNameHash') {
      return hashes.get(BigInt(args[0] as bigint)) ?? ethers.ZeroHash;
    }
    throw new Error(`Unexpected contract read ${method}`);
  });
  adapter.readContractWithOptions = readContractWithOptions;
  const currentProvider = {};
  adapter.loadCurrentContextGraphNameHashProviderHighWaters = vi.fn(async () => {
    const current = BigInt(await readContractWithOptions(
      contextGraphStorage,
      'cgStorage.getLatestContextGraphId',
      'getLatestContextGraphId',
      [],
      {},
    ));
    return {
      latestId: current,
      providerHighWaters: new Map([[currentProvider, current]]),
    };
  });
  adapter.getContextGraphNameHashRetryingNull = vi.fn(async (
    contextGraphId: bigint,
    signal?: AbortSignal,
  ) => {
    const raw = await readContractWithOptions(
      contextGraphStorage,
      'cgStorage.getNameHash',
      'getNameHash',
      [contextGraphId],
      { signal },
    );
    return !raw || raw === ethers.ZeroHash ? null : String(raw).toLowerCase();
  });
  const resolveContractDeployBlock = vi.fn(async () => {
    throw new Error('historical deploy lookup must not run on the fast path');
  });
  const queryEventLogsPage = vi.fn(async () => {
    throw new Error('historical log query must not run on the fast path');
  });
  adapter.resolveContractDeployBlock = resolveContractDeployBlock;
  adapter.queryEventLogsPage = queryEventLogsPage;

  return {
    adapter,
    hashes,
    readContractWithOptions,
    resolveContractDeployBlock,
    queryEventLogsPage,
    setLatestId(value: bigint) {
      latestId = value;
    },
    setStorageAddress(value: string) {
      storageAddress = value;
    },
    setAnchorHash(value: string) {
      anchorHash = value;
    },
  };
}

function historicalFixture(pages: ReadonlyArray<ReadonlyArray<bigint>> = [[42n]]) {
  const base = fixture([]);
  const scannedRegistryHighWater = CONTEXT_GRAPH_NAME_HASH_FAST_ENUMERATION_MAX_IDS + 1n;
  base.setLatestId(scannedRegistryHighWater);
  let headHash = `0x${'33'.repeat(32)}`;
  const provider = {
    getBlock: vi.fn(async (blockNumber: number) => ({ number: blockNumber, hash: headHash })),
  };
  const filter = { exactNameHash: NAME_HASH };
  const filterFactory = vi.fn(() => filter);
  const parseLog = vi.fn(({ data }: { data: string }) => ({
    name: 'ContextGraphCreated',
    args: { contextGraphId: BigInt(data) },
  }));
  const storage = {
    getAddress: vi.fn(async () => '0x00000000000000000000000000000000000000c6'),
    filters: { ContextGraphCreated: filterFactory },
    interface: { parseLog },
  };
  base.adapter.contracts = { contextGraphStorage: storage };
  base.adapter.rebindContract = vi.fn(() => ({
    getLatestContextGraphId: vi.fn(async (options: { blockTag?: number }) => {
      expect(options.blockTag).toBeDefined();
      return scannedRegistryHighWater;
    }),
  }));
  base.resolveContractDeployBlock.mockResolvedValue({
    fromBlock: 100,
    head: 100 + pages.length * 2 - 1,
    scanProviders: [{ provider, backendHead: 100 + pages.length * 2 - 1 }],
  });
  base.queryEventLogsPage.mockImplementation(async (...args: unknown[]) => {
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
  base.adapter.getContextGraphNameHash = vi.fn(async () => NAME_HASH);
  return {
    ...base,
    filter,
    filterFactory,
    provider,
    setHeadHash(value: string) { headHash = value; },
  };
}

function callsForMethod(
  readContractWithOptions: ReturnType<typeof vi.fn>,
  method: string,
): unknown[][] {
  return readContractWithOptions.mock.calls.filter((call) => call[2] === method);
}

describe('current ContextGraph name-hash reverse resolution', () => {
  it('enumerates every current slot and returns the one exact match', async () => {
    const {
      adapter,
      readContractWithOptions,
      resolveContractDeployBlock,
      queryEventLogsPage,
    } = fixture([
      null,
      OTHER_HASH,
      NAME_HASH,
      null,
      OTHER_HASH,
    ]);

    await expect(adapter.resolveContextGraphIdByNameHash(NAME_HASH)).resolves.toBe(3n);

    expect(callsForMethod(readContractWithOptions, 'getLatestContextGraphId')).toHaveLength(2);
    const slotCalls = callsForMethod(readContractWithOptions, 'getNameHash');
    expect(slotCalls).toHaveLength(6);
    expect(slotCalls.map((call) => BigInt(call[3][0])).sort()).toEqual([
      1n, 2n, 3n, 3n, 4n, 5n,
    ]);
    expect(slotCalls.filter((call) => call[4].signal instanceof AbortSignal)).toHaveLength(5);
    expect(slotCalls.filter((call) => call[4].signal === undefined)).toHaveLength(1);
    expect(resolveContractDeployBlock).not.toHaveBeenCalled();
    expect(queryEventLogsPage).not.toHaveBeenCalled();
  });

  it('normalizes an uppercase bytes32 input before current-slot comparison', async () => {
    const { adapter } = fixture([NAME_HASH]);
    const upperCaseHash = `0x${'AB'.repeat(32)}`;
    const load = vi.spyOn(adapter, 'loadContextGraphIdByNameHashFromChain');

    await expect(adapter.resolveContextGraphIdByNameHash(upperCaseHash)).resolves.toBe(1n);
    expect(load).toHaveBeenCalledWith(NAME_HASH);
  });

  it('normalizes an uppercase bytes32 input before the historical exact-topic filter', async () => {
    const { adapter, filterFactory } = historicalFixture([[42n]]);
    const upperCaseHash = `0x${'AB'.repeat(32)}`;

    await expect(adapter.resolveContextGraphIdByNameHash(upperCaseHash)).resolves.toBe(42n);
    expect(filterFactory).toHaveBeenCalledWith(null, null, NAME_HASH);
    expect(adapter.getContextGraphNameHash).toHaveBeenCalledWith(42n);
  });

  it('returns null only after every current slot misses', async () => {
    const { adapter, readContractWithOptions } = fixture([null, OTHER_HASH, null]);

    await expect(adapter.resolveContextGraphIdByNameHash(NAME_HASH)).resolves.toBeNull();
    expect(callsForMethod(readContractWithOptions, 'getNameHash')).toHaveLength(3);
  });

  it('does not let a lower-high-water RPC hide a slot from a current backend', async () => {
    const adapter: any = new EVMChainAdapter(minimalConfig());
    adapter.initialized = true;
    adapter.init = vi.fn(async () => {});
    const primary = { id: 'lagging' };
    const backup = { id: 'current' };
    const storage = { getAddress: vi.fn(async () => '0x00000000000000000000000000000000000000c6') };
    adapter.contracts = { contextGraphStorage: storage };
    adapter.rebindContract = vi.fn((_contract: unknown, provider: unknown) => ({
      getNameHash: vi.fn(async () => provider === primary ? ethers.ZeroHash : NAME_HASH),
    }));
    adapter.loadCurrentContextGraphNameHashProviderHighWaters = vi.fn(async () => ({
      latestId: 1n,
      providerHighWaters: new Map([[primary, 0n], [backup, 1n]]),
    }));

    await expect(adapter.getContextGraphNameHashRetryingNull(1n)).resolves.toBe(NAME_HASH);
    expect(adapter.rebindContract).toHaveBeenCalledTimes(1);
  });

  it('fails closed when same-high-water RPCs disagree on a current slot', async () => {
    const adapter: any = new EVMChainAdapter(minimalConfig());
    adapter.initialized = true;
    adapter.init = vi.fn(async () => {});
    const primary = { id: 'fork-a' };
    const backup = { id: 'fork-b' };
    const storage = { getAddress: vi.fn(async () => '0x00000000000000000000000000000000000000c6') };
    adapter.contracts = { contextGraphStorage: storage };
    adapter.rebindContract = vi.fn((_contract: unknown, provider: unknown) => ({
      getNameHash: vi.fn(async () => provider === primary ? ethers.ZeroHash : NAME_HASH),
    }));
    adapter.loadCurrentContextGraphNameHashProviderHighWaters = vi.fn(async () => ({
      latestId: 1n,
      providerHighWaters: new Map([[primary, 1n], [backup, 1n]]),
    }));

    await expect(adapter.getContextGraphNameHashRetryingNull(1n)).rejects.toThrow(
      /RPC backends disagree on current slot 1/i,
    );
  });

  it('fails closed when any covering RPC cannot read the current slot', async () => {
    const adapter: any = new EVMChainAdapter(minimalConfig());
    adapter.initialized = true;
    adapter.init = vi.fn(async () => {});
    const failing = { id: 'failing' };
    const responding = { id: 'responding' };
    const storage = { getAddress: vi.fn(async () => '0x00000000000000000000000000000000000000c6') };
    adapter.contracts = { contextGraphStorage: storage };
    adapter.rebindContract = vi.fn((_contract: unknown, provider: unknown) => ({
      getNameHash: vi.fn(async () => {
        if (provider === failing) throw new Error('slot read timed out');
        return ethers.ZeroHash;
      }),
    }));
    adapter.loadCurrentContextGraphNameHashProviderHighWaters = vi.fn(async () => ({
      latestId: 2n,
      providerHighWaters: new Map([[failing, 2n], [responding, 2n]]),
    }));

    await expect(adapter.getContextGraphNameHashRetryingNull(2n)).rejects.toThrow(
      /1 of 2 covering RPC backends failed to read current slot 2/i,
    );
    expect(adapter.rebindContract).toHaveBeenCalledTimes(2);
  });

  it('aborts an in-flight provider slot read instead of waiting for its stall timeout', async () => {
    const adapter: any = new EVMChainAdapter(minimalConfig());
    adapter.initialized = true;
    adapter.init = vi.fn(async () => {});
    const provider = { id: 'hung' };
    const storage = { getAddress: vi.fn(async () => '0x00000000000000000000000000000000000000c6') };
    const started = deferred<void>();
    adapter.contracts = { contextGraphStorage: storage };
    adapter.rebindContract = vi.fn(() => ({
      getNameHash: vi.fn(() => {
        started.resolve(undefined);
        return new Promise<string>(() => {});
      }),
    }));
    adapter.loadCurrentContextGraphNameHashProviderHighWaters = vi.fn(async () => ({
      latestId: 1n,
      providerHighWaters: new Map([[provider, 1n]]),
    }));
    const controller = new AbortController();
    const read = adapter.getContextGraphNameHashRetryingNull(1n, controller.signal);
    await started.promise;
    controller.abort(new Error('sibling slot failed'));

    await expect(read).rejects.toThrow('sibling slot failed');
  });

  it('scans past the first match and fails closed on an ambiguous duplicate', async () => {
    const { adapter, readContractWithOptions } = fixture([
      NAME_HASH,
      OTHER_HASH,
      null,
      NAME_HASH,
    ]);

    await expect(adapter.resolveContextGraphIdByNameHash(NAME_HASH)).rejects.toThrow(
      /ambiguous.*2 numeric ids/i,
    );
    expect(callsForMethod(readContractWithOptions, 'getNameHash')).toHaveLength(4);
  });

  it('uses the maximum reachable high-water so a lagging primary cannot hide an appended duplicate', async () => {
    const adapter: any = new EVMChainAdapter(minimalConfig());
    adapter.initialized = true;
    adapter.init = vi.fn(async () => {});
    const lagging = { id: 'lagging' };
    const current = { id: 'current' };
    adapter.providers = [lagging, current];
    adapter.rpcUrls = ['http://lagging.invalid', 'http://current.invalid'];
    adapter.ensureConfiguredStaticChainIdValidated = vi.fn(async () => 31337n);
    adapter.contracts = {
      contextGraphStorage: {
        getAddress: vi.fn(async () => '0x00000000000000000000000000000000000000c6'),
      },
    };
    const getLatestContextGraphId = vi.fn(async (provider: unknown) =>
      provider === lagging ? 1n : 2n);
    const getNameHash = vi.fn(async (provider: unknown, id: bigint) => {
      if (id === 1n) return NAME_HASH;
      return provider === current && id === 2n ? NAME_HASH : ethers.ZeroHash;
    });
    adapter.rebindContract = vi.fn((_contract: unknown, provider: unknown) => ({
      getLatestContextGraphId: () => getLatestContextGraphId(provider),
      getNameHash: (id: bigint) => getNameHash(provider, id),
    }));
    const anchorHash = `0x${'11'.repeat(32)}`;
    adapter.captureContextGraphNameHashIndexAnchor = vi.fn(async () => ({
      blockNumber: 100,
      blockHash: anchorHash,
    }));
    adapter.loadContextGraphNameHashIndexAnchorHash = vi.fn(async () => anchorHash);

    await expect(adapter.resolveContextGraphIdByNameHash(NAME_HASH)).rejects.toThrow(
      /ambiguous.*2 numeric ids/i,
    );
    expect(getLatestContextGraphId).toHaveBeenCalledTimes(2);
    expect(getNameHash).toHaveBeenCalledWith(current, 2n);
    expect(adapter.ensureConfiguredStaticChainIdValidated).toHaveBeenCalledWith(lagging);
    expect(adapter.ensureConfiguredStaticChainIdValidated).toHaveBeenCalledWith(current);
  });

  it('switches above the fast cap before issuing any getNameHash read', async () => {
    const { adapter, readContractWithOptions, setLatestId } = fixture([]);
    setLatestId(CONTEXT_GRAPH_NAME_HASH_FAST_ENUMERATION_MAX_IDS + 1n);
    const historical = vi.spyOn(
      adapter,
      'loadContextGraphIdByNameHashFromHistoricalEvents',
    ).mockResolvedValue(77n);

    await expect(adapter.resolveContextGraphIdByNameHash(NAME_HASH)).resolves.toBe(77n);
    expect(callsForMethod(readContractWithOptions, 'getLatestContextGraphId')).toHaveLength(1);
    expect(callsForMethod(readContractWithOptions, 'getNameHash')).toHaveLength(0);
    expect(historical).toHaveBeenCalledWith(NAME_HASH);
  });

  it('falls back to exact-topic deploy-anchored pages and verifies the live slot', async () => {
    const {
      adapter,
      filter,
      filterFactory,
      queryEventLogsPage,
    } = historicalFixture([[], [42n], []]);

    await expect(adapter.resolveContextGraphIdByNameHash(NAME_HASH)).resolves.toBe(42n);

    expect(filterFactory).toHaveBeenCalledWith(null, null, NAME_HASH);
    expect(queryEventLogsPage.mock.calls.map((call) => [call[1], call[2], call[3]])).toEqual([
      [filter, 100, 101],
      [filter, 102, 103],
      [filter, 104, 105],
    ]);
    expect(adapter.getContextGraphNameHash).toHaveBeenCalledWith(42n);
  });

  it('keeps the historical scan live when one same-head RPC cannot load the anchor block', async () => {
    const scenario = historicalFixture([[42n]]);
    const failingProvider = {
      getBlock: vi.fn(async () => { throw new Error('head block unavailable'); }),
    };
    scenario.resolveContractDeployBlock.mockResolvedValue({
      fromBlock: 100,
      head: 101,
      scanProviders: [
        { provider: failingProvider, backendHead: 101 },
        { provider: scenario.provider, backendHead: 101 },
      ],
    });

    await expect(scenario.adapter.resolveContextGraphIdByNameHash(NAME_HASH)).resolves.toBe(42n);
    expect(failingProvider.getBlock).toHaveBeenCalledWith(101);
    expect(scenario.provider.getBlock).toHaveBeenCalledWith(101);
  });

  it('fails closed when same-height RPCs disagree on the historical anchor hash', async () => {
    const scenario = historicalFixture([[42n]]);
    const forkedProvider = {
      getBlock: vi.fn(async (blockNumber: number) => ({
        number: blockNumber,
        hash: `0x${'44'.repeat(32)}`,
      })),
    };
    scenario.resolveContractDeployBlock.mockResolvedValue({
      fromBlock: 100,
      head: 101,
      scanProviders: [
        { provider: scenario.provider, backendHead: 101 },
        { provider: forkedProvider, backendHead: 101 },
      ],
    });

    await expect(scenario.adapter.resolveContextGraphIdByNameHash(NAME_HASH)).rejects.toThrow(
      /RPC backends disagree on canonical block hash at historical head 101/i,
    );
    expect(scenario.queryEventLogsPage).not.toHaveBeenCalled();
  });

  it('keeps the historical fallback fail-closed on duplicate numeric slots', async () => {
    const { adapter } = historicalFixture([[42n, 43n]]);

    await expect(adapter.resolveContextGraphIdByNameHash(NAME_HASH)).rejects.toThrow(
      /ambiguous.*2 numeric ids/i,
    );
    expect(adapter.getContextGraphNameHash).not.toHaveBeenCalled();
  });

  it('rejects the historical fallback before logs when its page budget is exceeded', async () => {
    const { adapter, resolveContractDeployBlock, queryEventLogsPage } = historicalFixture();
    resolveContractDeployBlock.mockResolvedValue({
      fromBlock: 100,
      head: 100 + (CG_REGISTRY_MAX_SCAN_PAGES * 2),
      scanProviders: [{
        provider: {},
        backendHead: 100 + (CG_REGISTRY_MAX_SCAN_PAGES * 2),
      }],
    });

    await expect(adapter.resolveContextGraphIdByNameHash(NAME_HASH)).rejects.toThrow(
      new RegExp(`budget ${CG_REGISTRY_MAX_SCAN_PAGES} pages`),
    );
    expect(queryEventLogsPage).not.toHaveBeenCalled();
  });

  it('fails closed when the historical candidate no longer matches its live slot', async () => {
    const { adapter } = historicalFixture([[42n]]);
    adapter.getContextGraphNameHash.mockResolvedValue(OTHER_HASH);

    await expect(adapter.resolveContextGraphIdByNameHash(NAME_HASH)).rejects.toThrow(
      /currently commits.*expected/i,
    );
  });

  it('discards a historical result when the adapter binding rotates mid-scan', async () => {
    const fixture = historicalFixture([[42n]]);
    fixture.queryEventLogsPage.mockImplementationOnce(async () => {
      fixture.adapter.invalidatePublishPreflightCache();
      return {
        logs: [{ topics: [], data: '42' }],
        provider: fixture.provider,
      };
    });

    await expect(fixture.adapter.resolveContextGraphIdByNameHash(NAME_HASH)).rejects.toThrow(
      /binding changed during historical scan/i,
    );
    expect(fixture.adapter.getContextGraphNameHash).not.toHaveBeenCalled();
  });

  it('discards a historical result when its canonical head changes mid-scan', async () => {
    const fixture = historicalFixture([[42n]]);
    fixture.queryEventLogsPage.mockImplementationOnce(async () => {
      fixture.setHeadHash(`0x${'44'.repeat(32)}`);
      return {
        logs: [{ topics: [], data: '42' }],
        provider: fixture.provider,
      };
    });

    await expect(fixture.adapter.resolveContextGraphIdByNameHash(NAME_HASH)).rejects.toThrow(
      /canonical chain anchor changed during historical scan/i,
    );
    expect(fixture.adapter.getContextGraphNameHash).not.toHaveBeenCalled();
  });

  it('discards a historical result when a new CG advances the registry after the scanned head', async () => {
    const scenario = historicalFixture([[42n]]);
    scenario.queryEventLogsPage.mockImplementationOnce(async () => {
      scenario.setLatestId(CONTEXT_GRAPH_NAME_HASH_FAST_ENUMERATION_MAX_IDS + 2n);
      return {
        logs: [{ topics: [], data: '42' }],
        provider: scenario.provider,
      };
    });

    await expect(scenario.adapter.resolveContextGraphIdByNameHash(NAME_HASH)).rejects.toThrow(
      /registry high-water changed from 1025 to 1026 during historical scan/i,
    );
    expect(scenario.adapter.getContextGraphNameHash).toHaveBeenCalledWith(42n);
  });

  it('does not negative-cache a historical miss when the registry advances during the scan', async () => {
    const scenario = historicalFixture([[]]);
    scenario.queryEventLogsPage.mockImplementationOnce(async () => {
      scenario.setLatestId(CONTEXT_GRAPH_NAME_HASH_FAST_ENUMERATION_MAX_IDS + 2n);
      return { logs: [], provider: scenario.provider };
    });

    await expect(scenario.adapter.resolveContextGraphIdByNameHash(NAME_HASH)).rejects.toThrow(
      /registry high-water changed from 1025 to 1026 during historical scan/i,
    );

    scenario.setLatestId(CONTEXT_GRAPH_NAME_HASH_FAST_ENUMERATION_MAX_IDS + 1n);
    await expect(scenario.adapter.resolveContextGraphIdByNameHash(NAME_HASH)).resolves.toBeNull();
    expect(scenario.queryEventLogsPage).toHaveBeenCalledTimes(2);
  });

  it('never exceeds four concurrent getNameHash reads and still scans the full range', async () => {
    const { adapter, readContractWithOptions } = fixture(Array.from({ length: 13 }, () => null));
    const release = deferred<void>();
    let active = 0;
    let maxActive = 0;
    readContractWithOptions.mockImplementation(async (
      _contract: unknown,
      _label: string,
      method: string,
      _args: readonly unknown[],
      _options: { signal?: AbortSignal },
    ) => {
      if (method === 'getLatestContextGraphId') return 13n;
      active += 1;
      maxActive = Math.max(maxActive, active);
      await release.promise;
      active -= 1;
      return ethers.ZeroHash;
    });

    const resolution = adapter.resolveContextGraphIdByNameHash(NAME_HASH);
    await vi.waitFor(() => {
      expect(active).toBe(CONTEXT_GRAPH_NAME_HASH_ENUMERATION_CONCURRENCY);
    });
    expect(maxActive).toBe(CONTEXT_GRAPH_NAME_HASH_ENUMERATION_CONCURRENCY);
    release.resolve(undefined);

    await expect(resolution).resolves.toBeNull();
    expect(maxActive).toBe(CONTEXT_GRAPH_NAME_HASH_ENUMERATION_CONCURRENCY);
    expect(callsForMethod(readContractWithOptions, 'getNameHash')).toHaveLength(13);
  });

  it('fails closed on any slot read error and aborts sibling failover reads', async () => {
    const { adapter, readContractWithOptions } = fixture([null, null, NAME_HASH, null]);
    const failure = new Error('all RPC endpoints failed getNameHash(2)');
    const observedSignals: AbortSignal[] = [];
    readContractWithOptions.mockImplementation(async (
      _contract: unknown,
      _label: string,
      method: string,
      args: readonly unknown[],
      options: { signal?: AbortSignal },
    ) => {
      if (method === 'getLatestContextGraphId') return 4n;
      if (options.signal) observedSignals.push(options.signal);
      if (BigInt(args[0] as bigint) === 2n) throw failure;
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => reject(options.signal?.reason);
        options.signal?.addEventListener('abort', onAbort, { once: true });
        setTimeout(resolve, 100);
      });
      return BigInt(args[0] as bigint) === 3n ? NAME_HASH : ethers.ZeroHash;
    });

    await expect(adapter.resolveContextGraphIdByNameHash(NAME_HASH)).rejects.toBe(failure);
    expect(observedSignals).not.toHaveLength(0);
    expect(observedSignals.every((signal) => signal.aborted)).toBe(true);
  });

  it('single-flights concurrent callers and lets one caller stop waiting', async () => {
    const { adapter, readContractWithOptions } = fixture([NAME_HASH]);
    const pending = deferred<string>();
    readContractWithOptions.mockImplementation(async (
      _contract: unknown,
      _label: string,
      method: string,
    ) => method === 'getLatestContextGraphId' ? 1n : pending.promise);
    const controller = new AbortController();

    const aborted = adapter.resolveContextGraphIdByNameHash(NAME_HASH, {
      signal: controller.signal,
    });
    const survivor = adapter.resolveContextGraphIdByNameHash(NAME_HASH);
    controller.abort(new Error('caller stopped'));

    await expect(aborted).rejects.toThrow('caller stopped');
    pending.resolve(NAME_HASH);
    await expect(survivor).resolves.toBe(1n);
    expect(callsForMethod(readContractWithOptions, 'getLatestContextGraphId')).toHaveLength(2);
    expect(callsForMethod(readContractWithOptions, 'getNameHash')).toHaveLength(2);
  });

  it('reuses an unchanged high-water snapshot across different hashes', async () => {
    const { adapter, readContractWithOptions } = fixture([NAME_HASH, OTHER_HASH]);

    await expect(adapter.resolveContextGraphIdByNameHash(NAME_HASH)).resolves.toBe(1n);
    await expect(adapter.resolveContextGraphIdByNameHash(OTHER_HASH)).resolves.toBe(2n);

    expect(callsForMethod(readContractWithOptions, 'getLatestContextGraphId')).toHaveLength(4);
    expect(callsForMethod(readContractWithOptions, 'getNameHash')).toHaveLength(4);
  });

  it('fails closed when a same-count reorg replaces the uniquely indexed slot', async () => {
    const { adapter, hashes, readContractWithOptions } = fixture([NAME_HASH]);
    await expect(adapter.resolveContextGraphIdByNameHash(NAME_HASH)).resolves.toBe(1n);

    hashes.set(1n, OTHER_HASH);
    await expect(adapter.resolveContextGraphIdByNameHash(NAME_HASH)).rejects.toThrow(
      /indexed slot 1 currently commits.*expected/i,
    );

    // Initial scan + initial positive verification + O(1) revalidation. The
    // unchanged counter does not trigger a second full enumeration.
    expect(callsForMethod(readContractWithOptions, 'getNameHash')).toHaveLength(3);
  });

  it('rebuilds on a changed chain anchor and catches a same-count duplicate', async () => {
    const {
      adapter,
      hashes,
      readContractWithOptions,
      setAnchorHash,
    } = fixture([NAME_HASH, OTHER_HASH]);
    await expect(adapter.resolveContextGraphIdByNameHash(NAME_HASH)).resolves.toBe(1n);

    hashes.set(2n, NAME_HASH);
    setAnchorHash(`0x${'22'.repeat(32)}`);
    await expect(adapter.resolveContextGraphIdByNameHash(NAME_HASH)).rejects.toThrow(
      /ambiguous.*2 numeric ids/i,
    );

    // Initial full scan + exact candidate check, then one bounded full rebuild
    // after the retained canonical anchor changed.
    expect(callsForMethod(readContractWithOptions, 'getNameHash')).toHaveLength(5);
  });

  it('scans only appended slots after the high-water mark advances', async () => {
    const { adapter, hashes, readContractWithOptions, setLatestId } = fixture([NAME_HASH]);
    await expect(adapter.resolveContextGraphIdByNameHash(NAME_HASH)).resolves.toBe(1n);

    hashes.set(2n, OTHER_HASH);
    setLatestId(2n);
    await expect(adapter.resolveContextGraphIdByNameHash(OTHER_HASH)).resolves.toBe(2n);

    expect(callsForMethod(readContractWithOptions, 'getNameHash').map(
      (call) => BigInt(call[3][0]),
    )).toEqual([1n, 1n, 2n, 2n]);
  });

  it('indexes a later duplicate from the delta and fails closed', async () => {
    const { adapter, hashes, readContractWithOptions, setLatestId } = fixture([NAME_HASH]);
    await expect(adapter.resolveContextGraphIdByNameHash(NAME_HASH)).resolves.toBe(1n);

    hashes.set(2n, NAME_HASH);
    setLatestId(2n);
    await expect(adapter.resolveContextGraphIdByNameHash(NAME_HASH)).rejects.toThrow(
      /ambiguous.*2 numeric ids/i,
    );
    expect(callsForMethod(readContractWithOptions, 'getNameHash').map(
      (call) => BigInt(call[3][0]),
    )).toEqual([1n, 1n, 2n]);
  });

  it('rebuilds from slot one when the registry high-water mark decreases', async () => {
    const { adapter, hashes, readContractWithOptions, setLatestId } = fixture([
      NAME_HASH,
      OTHER_HASH,
    ]);
    await expect(adapter.resolveContextGraphIdByNameHash(OTHER_HASH)).resolves.toBe(2n);

    hashes.set(1n, OTHER_HASH);
    hashes.delete(2n);
    setLatestId(1n);
    await expect(adapter.resolveContextGraphIdByNameHash(OTHER_HASH)).resolves.toBe(1n);

    expect(callsForMethod(readContractWithOptions, 'getNameHash').map(
      (call) => BigInt(call[3][0]),
    )).toEqual([1n, 2n, 2n, 1n, 1n]);
  });

  it('rebuilds when the ContextGraphStorage address changes', async () => {
    const { adapter, hashes, readContractWithOptions, setStorageAddress } = fixture([NAME_HASH]);
    await expect(adapter.resolveContextGraphIdByNameHash(NAME_HASH)).resolves.toBe(1n);

    hashes.set(1n, OTHER_HASH);
    setStorageAddress('0x00000000000000000000000000000000000000d7');
    await expect(adapter.resolveContextGraphIdByNameHash(OTHER_HASH)).resolves.toBe(1n);

    expect(callsForMethod(readContractWithOptions, 'getNameHash')).toHaveLength(4);
  });

  it('rebuilds when the configured provider identity changes', async () => {
    const { adapter, hashes, readContractWithOptions } = fixture([NAME_HASH]);
    await expect(adapter.resolveContextGraphIdByNameHash(NAME_HASH)).resolves.toBe(1n);

    hashes.set(1n, OTHER_HASH);
    adapter.providers = [{}];
    adapter.rpcUrls = ['http://127.0.0.1:59997'];
    await expect(adapter.resolveContextGraphIdByNameHash(OTHER_HASH)).resolves.toBe(1n);

    expect(callsForMethod(readContractWithOptions, 'getNameHash')).toHaveLength(4);
  });

  it('serializes first refreshes for different hashes onto one slot scan', async () => {
    const { adapter, readContractWithOptions } = fixture([NAME_HASH, OTHER_HASH]);
    const release = deferred<void>();
    readContractWithOptions.mockImplementation(async (
      _contract: unknown,
      _label: string,
      method: string,
      args: readonly unknown[],
    ) => {
      if (method === 'getLatestContextGraphId') return 2n;
      await release.promise;
      return BigInt(args[0] as bigint) === 1n ? NAME_HASH : OTHER_HASH;
    });

    const first = adapter.resolveContextGraphIdByNameHash(NAME_HASH);
    const second = adapter.resolveContextGraphIdByNameHash(OTHER_HASH);
    await vi.waitFor(() => {
      expect(callsForMethod(readContractWithOptions, 'getNameHash')).toHaveLength(2);
    });
    expect(callsForMethod(readContractWithOptions, 'getLatestContextGraphId')).toHaveLength(1);
    release.resolve(undefined);

    await expect(first).resolves.toBe(1n);
    await expect(second).resolves.toBe(2n);
    expect(callsForMethod(readContractWithOptions, 'getLatestContextGraphId')).toHaveLength(4);
    expect(callsForMethod(readContractWithOptions, 'getNameHash')).toHaveLength(4);
  });

  it('leaves the prior high-water intact after a failed delta refresh', async () => {
    const { adapter, hashes, readContractWithOptions, setLatestId } = fixture([NAME_HASH]);
    await expect(adapter.resolveContextGraphIdByNameHash(NAME_HASH)).resolves.toBe(1n);
    hashes.set(2n, OTHER_HASH);
    setLatestId(2n);
    let failDelta = true;
    readContractWithOptions.mockImplementation(async (
      _contract: unknown,
      _label: string,
      method: string,
      args: readonly unknown[],
    ) => {
      if (method === 'getLatestContextGraphId') return 2n;
      const id = BigInt(args[0] as bigint);
      if (id === 2n && failDelta) throw new Error('delta RPC failed');
      return hashes.get(id) ?? ethers.ZeroHash;
    });

    await expect(adapter.resolveContextGraphIdByNameHash(OTHER_HASH)).rejects.toThrow(
      'delta RPC failed',
    );
    failDelta = false;
    await expect(adapter.resolveContextGraphIdByNameHash(OTHER_HASH)).resolves.toBe(2n);

    expect(callsForMethod(readContractWithOptions, 'getNameHash').map(
      (call) => BigInt(call[3][0]),
    )).toEqual([1n, 1n, 2n, 2n, 2n]);
  });

  it('lets an aborted caller leave a shared different-hash refresh usable', async () => {
    const { adapter, readContractWithOptions } = fixture([NAME_HASH, OTHER_HASH]);
    const release = deferred<void>();
    readContractWithOptions.mockImplementation(async (
      _contract: unknown,
      _label: string,
      method: string,
      args: readonly unknown[],
    ) => {
      if (method === 'getLatestContextGraphId') return 2n;
      await release.promise;
      return BigInt(args[0] as bigint) === 1n ? NAME_HASH : OTHER_HASH;
    });
    const controller = new AbortController();
    const abandoned = adapter.resolveContextGraphIdByNameHash(NAME_HASH, {
      signal: controller.signal,
    });
    await vi.waitFor(() => {
      expect(callsForMethod(readContractWithOptions, 'getNameHash')).toHaveLength(2);
    });
    controller.abort(new Error('caller stopped'));
    await expect(abandoned).rejects.toThrow('caller stopped');

    const survivor = adapter.resolveContextGraphIdByNameHash(OTHER_HASH);
    release.resolve(undefined);
    await expect(survivor).resolves.toBe(2n);
    expect(callsForMethod(readContractWithOptions, 'getNameHash')).toHaveLength(4);
  });

  it('discards a refresh invalidated while its slot reads are in flight', async () => {
    const { adapter, readContractWithOptions } = fixture([NAME_HASH]);
    const firstRead = deferred<string>();
    let blockFirst = true;
    readContractWithOptions.mockImplementation(async (
      _contract: unknown,
      _label: string,
      method: string,
    ) => {
      if (method === 'getLatestContextGraphId') return 1n;
      if (blockFirst) return firstRead.promise;
      return NAME_HASH;
    });

    const invalidated = adapter.resolveContextGraphIdByNameHash(NAME_HASH);
    await vi.waitFor(() => {
      expect(callsForMethod(readContractWithOptions, 'getNameHash')).toHaveLength(1);
    });
    adapter.invalidatePublishPreflightCache();
    blockFirst = false;
    firstRead.resolve(NAME_HASH);
    await expect(invalidated).rejects.toThrow(/binding changed during current-slot refresh/i);

    await expect(adapter.resolveContextGraphIdByNameHash(NAME_HASH)).resolves.toBe(1n);
    expect(callsForMethod(readContractWithOptions, 'getNameHash')).toHaveLength(3);
  });

  it('discards a same-count storage rotation after index resolve but before exact verification', async () => {
    const scenario = fixture([NAME_HASH, OTHER_HASH]);
    const loadHighWaters = scenario.adapter.loadCurrentContextGraphNameHashProviderHighWaters;
    let calls = 0;
    loadHighWaters.mockImplementation(async () => {
      calls += 1;
      if (calls === 2) {
        scenario.setStorageAddress('0x00000000000000000000000000000000000000d7');
        scenario.hashes.set(2n, NAME_HASH);
        scenario.adapter.invalidatePublishPreflightCache();
      }
      return {
        latestId: 2n,
        providerHighWaters: new Map([[{}, 2n]]),
      };
    });

    await expect(scenario.adapter.resolveContextGraphIdByNameHash(NAME_HASH)).rejects.toThrow(
      /binding changed during current-slot resolution/i,
    );
  });

  it('clears a cached miss when a different-hash delta discovers new slots', async () => {
    const { adapter, hashes, readContractWithOptions, setLatestId } = fixture([null]);
    await expect(adapter.resolveContextGraphIdByNameHash(NAME_HASH)).resolves.toBeNull();
    await expect(adapter.resolveContextGraphIdByNameHash(NAME_HASH)).resolves.toBeNull();

    hashes.set(2n, NAME_HASH);
    setLatestId(2n);
    await expect(adapter.resolveContextGraphIdByNameHash(OTHER_HASH)).resolves.toBeNull();
    await expect(adapter.resolveContextGraphIdByNameHash(NAME_HASH)).resolves.toBe(2n);

    expect(callsForMethod(readContractWithOptions, 'getNameHash').map(
      (call) => BigInt(call[3][0]),
    )).toEqual([1n, 2n, 2n]);
  });

  it('short-caches a current-state miss and retries after the TTL', async () => {
    vi.useFakeTimers({ now: 0 });
    try {
      const { adapter, hashes, readContractWithOptions, setLatestId } = fixture([null]);
      await expect(adapter.resolveContextGraphIdByNameHash(NAME_HASH)).resolves.toBeNull();
      await expect(adapter.resolveContextGraphIdByNameHash(NAME_HASH)).resolves.toBeNull();
      expect(callsForMethod(readContractWithOptions, 'getNameHash')).toHaveLength(1);

      vi.setSystemTime(30_001);
      hashes.set(2n, NAME_HASH);
      setLatestId(2n);
      await expect(adapter.resolveContextGraphIdByNameHash(NAME_HASH)).resolves.toBe(2n);
      expect(callsForMethod(readContractWithOptions, 'getNameHash')).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('invalidates a cached miss immediately with the adapter-wide cache reset', async () => {
    const { adapter, hashes, readContractWithOptions } = fixture([null]);
    await expect(adapter.resolveContextGraphIdByNameHash(NAME_HASH)).resolves.toBeNull();
    await expect(adapter.resolveContextGraphIdByNameHash(NAME_HASH)).resolves.toBeNull();
    expect(callsForMethod(readContractWithOptions, 'getNameHash')).toHaveLength(1);

    hashes.set(1n, NAME_HASH);
    adapter.invalidatePublishPreflightCache();

    await expect(adapter.resolveContextGraphIdByNameHash(NAME_HASH)).resolves.toBe(1n);
    expect(callsForMethod(readContractWithOptions, 'getNameHash')).toHaveLength(3);
  });

  it('rejects malformed inputs before chain initialisation and treats zero as opt-out', async () => {
    const { adapter } = fixture();
    await expect(adapter.resolveContextGraphIdByNameHash('not-a-hash')).rejects.toThrow(
      /bytes32 nameHash/,
    );
    await expect(adapter.resolveContextGraphIdByNameHash(ethers.ZeroHash)).resolves.toBeNull();
    expect(adapter.init).not.toHaveBeenCalled();
  });
});
