/**
 * `EVMChainAdapter.getMaxKaNumberForAuthor` — OT-RFC-43 Option 1 / issue #1080.
 *
 * Verifies the wiring of the on-chain getter:
 *   1. Prefers the O(1) `getMaxKaNumberForAuthor(address) -> int256` view (a
 *      single eth_call) and does NOT scan logs when the view answers.
 *   2. Falls back to a PAGINATED, RPC-safe (<= 2000-block window) log scan when
 *      the view is absent or the selector call cannot be decoded on older
 *      deployments. The fallback must never use the old unbounded
 *      `queryFilter(filter, 0)` shape that overflowed provider eth_getLogs caps.
 *   3. Propagates transient RPC failures instead of hiding them behind a
 *      historical crawl on the same provider.
 *
 * Private state is injected via `as any`, the same convention the rest of the
 * chain unit tests use.
 */
import { describe, it, expect, vi } from 'vitest';
import { ethers } from 'ethers';
import { EVMChainAdapter, type EVMAdapterConfig } from '../src/evm-adapter.js';

const DEPLOYER_PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const ADMIN_PK = '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a';

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

const AUTHOR = ethers.getAddress('0x1111111111111111111111111111111111111111');
const pack = (n: bigint) => (BigInt(AUTHOR) << 96n) | n; // packed kaId for AUTHOR
const EMPTY_VIEW_RESULT = 'could not decode result data (value="0x", info={ method: "getMaxKaNumberForAuthor", signature: "getMaxKaNumberForAuthor(address)" }, code=BAD_DATA, version=6.16.0)';

/** A ContractMethod-shaped mock: a function carrying a `.staticCall`. */
function viewMock(impl: () => Promise<bigint>) {
  const fn: any = vi.fn();
  fn.staticCall = vi.fn(impl);
  return fn;
}

function makeAdapter(storage: any, head = 0) {
  const a = new EVMChainAdapter(minimalConfig());
  storage.target ??= '0x2222222222222222222222222222222222222222';
  (a as any).contracts = { knowledgeAssetStorage: storage };
  (a as any).provider = {
    getBlockNumber: vi.fn(async () => head),
    getCode: vi.fn(async () => '0x6000'),
  };
  return a;
}

describe('EVMChainAdapter.getMaxKaNumberForAuthor — view + bounded fallback (#1080)', () => {
  it('uses the O(1) on-chain view and never scans logs when the view answers', async () => {
    const queryFilter = vi.fn();
    const storage = {
      getMaxKaNumberForAuthor: viewMock(async () => 5n),
      filters: { KnowledgeAssetCreated: vi.fn(() => 'F') },
      queryFilter,
    };
    const a = makeAdapter(storage, 9_999_999);

    expect(await a.getMaxKaNumberForAuthor(AUTHOR)).toBe(5n);
    expect(storage.getMaxKaNumberForAuthor.staticCall).toHaveBeenCalledTimes(1);
    expect(storage.getMaxKaNumberForAuthor.staticCall).toHaveBeenCalledWith(AUTHOR);
    expect(queryFilter).not.toHaveBeenCalled();
    expect((a as any).provider.getBlockNumber).not.toHaveBeenCalled();
  });

  it('returns -1n for a never-minted author (allocator next number = 0)', async () => {
    const storage = {
      getMaxKaNumberForAuthor: viewMock(async () => -1n),
      filters: { KnowledgeAssetCreated: vi.fn(() => 'F') },
      queryFilter: vi.fn(),
    };
    expect(await makeAdapter(storage).getMaxKaNumberForAuthor(AUTHOR)).toBe(-1n);
    expect(storage.queryFilter).not.toHaveBeenCalled();
  });

  it('falls back to a paginated bounded scan when the view is absent', async () => {
    const head = 5_000;
    const queryFilter = vi.fn(async (_f: unknown, lo: number, hi: number) =>
      lo <= 2500 && 2500 <= hi ? [{ args: { id: pack(7n) } }] : [],
    );
    const storage = {
      filters: { KnowledgeAssetCreated: vi.fn(() => 'F') },
      queryFilter,
    };
    const a = makeAdapter(storage, head);

    expect(await a.getMaxKaNumberForAuthor(AUTHOR)).toBe(7n);
    expect(queryFilter).toHaveBeenCalledTimes(3);
    for (const [, lo, hi] of queryFilter.mock.calls as unknown as [unknown, number, number][]) {
      expect(typeof lo).toBe('number');
      expect(typeof hi).toBe('number');
      expect(hi - lo + 1).toBeLessThanOrEqual(2000);
    }
    expect(queryFilter.mock.calls).toEqual([
      ['F', 0, 1999],
      ['F', 2000, 3999],
      ['F', 4000, 5000],
    ]);
  });

  it('falls back to the bounded scan when an older deployment cannot decode the view result', async () => {
    const badData: any = new Error(EMPTY_VIEW_RESULT);
    badData.code = 'BAD_DATA';
    const view = viewMock(async () => {
      throw badData;
    });
    const queryFilter = vi.fn(async () => [{ args: { id: pack(3n) } }]);
    const storage = {
      getMaxKaNumberForAuthor: view,
      filters: { KnowledgeAssetCreated: vi.fn(() => 'F') },
      queryFilter,
    };

    expect(await makeAdapter(storage, 1_500).getMaxKaNumberForAuthor(AUTHOR)).toBe(3n);
    expect(view.staticCall).toHaveBeenCalledTimes(1);
    expect(queryFilter).toHaveBeenCalledWith('F', 0, 1500);
  });

  it('fails loudly instead of scanning empty logs when the resolved storage address has no code', async () => {
    const badData: any = new Error(EMPTY_VIEW_RESULT);
    badData.code = 'BAD_DATA';
    const queryFilter = vi.fn(async () => []);
    const storage = {
      target: '0x3333333333333333333333333333333333333333',
      getMaxKaNumberForAuthor: viewMock(async () => {
        throw badData;
      }),
      filters: { KnowledgeAssetCreated: vi.fn(() => 'F') },
      queryFilter,
    };
    const a = makeAdapter(storage, 100);
    (a as any).provider.getCode.mockResolvedValueOnce('0x');

    await expect(a.getMaxKaNumberForAuthor(AUTHOR)).rejects.toThrow(
      'no contract code is deployed there',
    );
    expect((a as any).provider.getCode).toHaveBeenCalledWith(storage.target);
    expect(queryFilter).not.toHaveBeenCalled();
    expect((a as any).provider.getBlockNumber).not.toHaveBeenCalled();
  });

  it('returns -1n when neither the view nor legacy logs yields a number', async () => {
    const storage = {
      filters: { KnowledgeAssetCreated: vi.fn(() => 'F') },
      queryFilter: vi.fn(async () => []),
    };
    expect(await makeAdapter(storage, 100).getMaxKaNumberForAuthor(AUTHOR)).toBe(-1n);
  });

  it('rethrows a transient RPC error from the view instead of crawling logs', async () => {
    const err: any = new Error('rate limited');
    err.code = 'SERVER_ERROR';
    const queryFilter = vi.fn(async () => [{ args: { id: pack(9n) } }]);
    const storage = {
      getMaxKaNumberForAuthor: viewMock(async () => {
        throw err;
      }),
      filters: { KnowledgeAssetCreated: vi.fn(() => 'F') },
      queryFilter,
    };
    await expect(
      makeAdapter(storage, 100).getMaxKaNumberForAuthor(AUTHOR),
    ).rejects.toThrow('rate limited');
    expect(queryFilter).not.toHaveBeenCalled();
  });

  it('rethrows non-selector CALL_EXCEPTION errors instead of treating them as absent view', async () => {
    const err: any = new Error('execution reverted: Paused');
    err.code = 'CALL_EXCEPTION';
    const queryFilter = vi.fn(async () => [{ args: { id: pack(9n) } }]);
    const storage = {
      getMaxKaNumberForAuthor: viewMock(async () => {
        throw err;
      }),
      filters: { KnowledgeAssetCreated: vi.fn(() => 'F') },
      queryFilter,
    };
    await expect(
      makeAdapter(storage, 100).getMaxKaNumberForAuthor(AUTHOR),
    ).rejects.toThrow('Paused');
    expect(queryFilter).not.toHaveBeenCalled();
  });

  it('rethrows malformed BAD_DATA instead of treating every decode failure as an absent view', async () => {
    const err: any = new Error(
      'could not decode result data (value="0x1234", info={ method: "getMaxKaNumberForAuthor", signature: "getMaxKaNumberForAuthor(address)" }, code=BAD_DATA, version=6.16.0)',
    );
    err.code = 'BAD_DATA';
    const queryFilter = vi.fn(async () => [{ args: { id: pack(9n) } }]);
    const storage = {
      getMaxKaNumberForAuthor: viewMock(async () => {
        throw err;
      }),
      filters: { KnowledgeAssetCreated: vi.fn(() => 'F') },
      queryFilter,
    };
    await expect(
      makeAdapter(storage, 100).getMaxKaNumberForAuthor(AUTHOR),
    ).rejects.toThrow('0x1234');
    expect(queryFilter).not.toHaveBeenCalled();
  });

  it('rethrows generic missing-revert-data errors instead of hiding call failures behind a scan', async () => {
    const err: any = new Error('missing revert data');
    err.code = 'CALL_EXCEPTION';
    const queryFilter = vi.fn(async () => [{ args: { id: pack(9n) } }]);
    const storage = {
      getMaxKaNumberForAuthor: viewMock(async () => {
        throw err;
      }),
      filters: { KnowledgeAssetCreated: vi.fn(() => 'F') },
      queryFilter,
    };
    await expect(
      makeAdapter(storage, 100).getMaxKaNumberForAuthor(AUTHOR),
    ).rejects.toThrow('missing revert data');
    expect(queryFilter).not.toHaveBeenCalled();
  });
});
