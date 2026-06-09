/**
 * `EVMChainAdapter.getMaxKaNumberForAuthor` — OT-RFC-43 Option 1 / issue #1080.
 *
 * Verifies the wiring of the on-chain getter:
 *   1. Prefers the O(1) `getMaxKaNumberForAuthor(address) -> int256` view (a
 *      single eth_call) and does NOT scan logs.
 *   2. Falls back to a PAGINATED, RPC-safe (<= 2000-block window) log scan when
 *      the view is absent (older contract) or reverts — never the old single
 *      unbounded `queryFilter(filter, 0)` that overflowed the eth_getLogs cap.
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

/** A ContractMethod-shaped mock: a function carrying a `.staticCall`. */
function viewMock(impl: () => Promise<bigint>) {
  const fn: any = vi.fn();
  fn.staticCall = vi.fn(impl);
  return fn;
}

function makeAdapter(storage: any, head = 0) {
  const a = new EVMChainAdapter(minimalConfig());
  (a as any).contracts = { knowledgeAssetStorage: storage };
  (a as any).provider = { getBlockNumber: vi.fn(async () => head) };
  return a;
}

describe('EVMChainAdapter.getMaxKaNumberForAuthor — view + bounded fallback (#1080)', () => {
  it('uses the O(1) on-chain view and never scans logs', async () => {
    const queryFilter = vi.fn();
    const storage = {
      getMaxKaNumberForAuthor: viewMock(async () => 5n),
      filters: { KnowledgeAssetCreated: vi.fn(() => 'F') },
      queryFilter,
    };
    const a = makeAdapter(storage, 9_999_999);

    expect(await a.getMaxKaNumberForAuthor(AUTHOR)).toBe(5n);
    expect(storage.getMaxKaNumberForAuthor.staticCall).toHaveBeenCalledTimes(1);
    expect(queryFilter).not.toHaveBeenCalled();
    // the scan path (and its head lookup) must not run when the view answers
    expect((a as any).provider.getBlockNumber).not.toHaveBeenCalled();
  });

  it('returns -1n from the view for a never-minted author', async () => {
    const storage = {
      getMaxKaNumberForAuthor: viewMock(async () => -1n),
      filters: { KnowledgeAssetCreated: vi.fn(() => 'F') },
      queryFilter: vi.fn(),
    };
    expect(await makeAdapter(storage).getMaxKaNumberForAuthor(AUTHOR)).toBe(-1n);
  });

  it('falls back to a PAGINATED, bounded scan when the view is absent', async () => {
    const head = 5_000;
    const queryFilter = vi.fn(async (_f: unknown, lo: number, hi: number) =>
      lo <= 2500 && 2500 <= hi ? [{ args: { id: pack(7n) } }] : [],
    );
    const storage = {
      // no getMaxKaNumberForAuthor → emulates a pre-10.0.4 deployment
      filters: { KnowledgeAssetCreated: vi.fn(() => 'F') },
      queryFilter,
    };
    const a = makeAdapter(storage, head);

    expect(await a.getMaxKaNumberForAuthor(AUTHOR)).toBe(7n);
    expect(queryFilter).toHaveBeenCalled();
    // every call is a bounded window <= 2000 blocks — never a single [0, latest]
    for (const [, lo, hi] of queryFilter.mock.calls as unknown as [unknown, number, number][]) {
      expect(typeof lo).toBe('number');
      expect(typeof hi).toBe('number');
      expect(hi - lo + 1).toBeLessThanOrEqual(2000);
    }
    // head=5000 @ 2000/window => [0,1999] [2000,3999] [4000,5000]
    expect(queryFilter).toHaveBeenCalledTimes(3);
  });

  it('falls back to the bounded scan when the view reverts', async () => {
    const view = viewMock(async () => {
      throw new Error('execution reverted: function selector not recognized');
    });
    const queryFilter = vi.fn(async () => [{ args: { id: pack(3n) } }]);
    const storage = {
      getMaxKaNumberForAuthor: view,
      filters: { KnowledgeAssetCreated: vi.fn(() => 'F') },
      queryFilter,
    };
    const a = makeAdapter(storage, 1_500);

    expect(await a.getMaxKaNumberForAuthor(AUTHOR)).toBe(3n);
    expect(view.staticCall).toHaveBeenCalledTimes(1);
    expect(queryFilter).toHaveBeenCalled();
  });

  it('returns -1n when neither the view nor any log yields a number', async () => {
    const storage = {
      filters: { KnowledgeAssetCreated: vi.fn(() => 'F') },
      queryFilter: vi.fn(async () => []),
    };
    expect(await makeAdapter(storage, 100).getMaxKaNumberForAuthor(AUTHOR)).toBe(-1n);
  });

  it('rethrows a transient RPC error from the view instead of crawling logs', async () => {
    const transient: any = new Error('rate limited');
    transient.code = 'SERVER_ERROR';
    const queryFilter = vi.fn(async () => [{ args: { id: pack(9n) } }]);
    const storage = {
      getMaxKaNumberForAuthor: viewMock(async () => {
        throw transient;
      }),
      filters: { KnowledgeAssetCreated: vi.fn(() => 'F') },
      queryFilter,
    };
    const a = makeAdapter(storage, 100);
    await expect(a.getMaxKaNumberForAuthor(AUTHOR)).rejects.toThrow('rate limited');
    // A transient error must NOT degrade into a historical log crawl.
    expect(queryFilter).not.toHaveBeenCalled();
  });
});
