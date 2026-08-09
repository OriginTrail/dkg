import { ethers } from 'ethers';
import { expect, vi } from 'vitest';
import { EVMChainAdapter, type EVMAdapterConfig } from '../src/evm-adapter.js';
import {
  CONTEXT_GRAPH_NAME_HASH_FAST_ENUMERATION_MAX_IDS,
} from '../src/evm-context-graph-name-hash-fence.js';
import type { EvmContextGraphNameHashFence } from '../src/evm-context-graph-name-hash-fence.js';

const PRIVATE_KEY =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
export const NAME_HASH = `0x${'ab'.repeat(32)}`;
export const OTHER_HASH = `0x${'cd'.repeat(32)}`;

export function minimalConfig(): EVMAdapterConfig {
  return {
    rpcUrl: 'http://127.0.0.1:59998',
    privateKey: PRIVATE_KEY,
    hubAddress: '0x0000000000000000000000000000000000000001',
    chainId: 'evm:31337',
    staticNetwork: false,
    cgRegistryScanPageSize: 2,
  };
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export function resolverInternals(adapter: any) {
  const resolver = adapter.getContextGraphNameHashResolver();
  return {
    resolver,
    fence: resolver.source as EvmContextGraphNameHashFence,
  };
}

export function fixture(initialHashes: ReadonlyArray<string | null> = [NAME_HASH]) {
  const adapter: any = new EVMChainAdapter(minimalConfig());
  adapter.initialized = true;
  adapter.init = vi.fn(async () => {});
  let storageAddress = '0x00000000000000000000000000000000000000c6';
  const contextGraphStorage = {
    getAddress: vi.fn(async () => storageAddress),
  };
  adapter.contracts = { contextGraphStorage };
  const currentProvider = {
    getBlock: vi.fn(async (blockNumber: number | string) => ({
      number: typeof blockNumber === 'number' ? blockNumber : 100,
      hash: `0x${'11'.repeat(32)}`,
    })),
  };
  adapter.providers = [currentProvider];
  adapter.rpcUrls = ['http://127.0.0.1:59998'];
  adapter.ensureConfiguredStaticChainIdValidated = vi.fn(async () => 31337n);
  let anchorHash = `0x${'11'.repeat(32)}`;
  adapter.readTipProvider = vi.fn(async () => ({ number: 100, hash: anchorHash }));
  adapter.readProviderRetryingNull = vi.fn(async () => anchorHash);

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
  adapter.rebindContract = vi.fn(() => ({
    getLatestContextGraphId: () => readContractWithOptions(
      contextGraphStorage,
      'cgStorage.getLatestContextGraphId',
      'getLatestContextGraphId',
      [],
      {},
    ),
    getNameHash: (contextGraphId: bigint) => readContractWithOptions(
      contextGraphStorage,
      'cgStorage.getNameHash',
      'getNameHash',
      [contextGraphId],
      {},
    ),
  }));
  const resolveContractDeployBlock = vi.fn(async () => {
    throw new Error('historical deploy lookup must not run on the fast path');
  });
  const queryEventLogsPage = vi.fn(async () => {
    throw new Error('historical log query must not run on the fast path');
  });
  adapter.resolveContractDeployBlock = resolveContractDeployBlock;
  adapter.queryEventLogsPage = queryEventLogsPage;
  const { resolver, fence } = resolverInternals(adapter);

  return {
    adapter,
    resolver,
    fence,
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

export function historicalFixture(pages: ReadonlyArray<ReadonlyArray<bigint>> = [[42n]]) {
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
  const getNameHash = vi.fn(async () => NAME_HASH);
  base.adapter.rebindContract = vi.fn(() => ({
    getLatestContextGraphId: vi.fn(async (options?: { blockTag?: number }) => {
      if (options !== undefined) {
        expect(options.blockTag).toBeDefined();
        return scannedRegistryHighWater;
      }
      return base.readContractWithOptions(
        storage,
        'cgStorage.getLatestContextGraphId',
        'getLatestContextGraphId',
        [],
        {},
      );
    }),
    getNameHash,
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
  return {
    ...base,
    filter,
    filterFactory,
    provider,
    getNameHash,
    setHeadHash(value: string) { headHash = value; },
  };
}

export function callsForMethod(
  readContractWithOptions: ReturnType<typeof vi.fn>,
  method: string,
): unknown[][] {
  return readContractWithOptions.mock.calls.filter((call) => call[2] === method);
}
