/**
 * `EVMChainAdapter.getMaxKaNumberForAuthor` — OT-RFC-43 Option 1 / issue #1080.
 *
 * Strict O(1): the adapter reads the `getMaxKaNumberForAuthor(address) -> int256`
 * view on DKGKnowledgeAssets (a single eth_call). There is NO log-scan fallback
 * by design — V10 deploys the 10.0.4 contract fresh, so the view is authoritative
 * from genesis; an absent selector / read error must fail loudly, not crawl chain
 * history.
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

/** A ContractMethod-shaped mock: a function carrying a `.staticCall`. */
function viewMock(impl: () => Promise<bigint>) {
  const fn: any = vi.fn();
  fn.staticCall = vi.fn(impl);
  return fn;
}

function makeAdapter(storage: any) {
  const a = new EVMChainAdapter(minimalConfig());
  (a as any).contracts = { knowledgeAssetStorage: storage };
  return a;
}

describe('EVMChainAdapter.getMaxKaNumberForAuthor — strict O(1) on-chain view (#1080)', () => {
  it('returns the high-water number from the int256 view (single eth_call)', async () => {
    const storage = { getMaxKaNumberForAuthor: viewMock(async () => 5n) };
    expect(await makeAdapter(storage).getMaxKaNumberForAuthor(AUTHOR)).toBe(5n);
    expect(storage.getMaxKaNumberForAuthor.staticCall).toHaveBeenCalledTimes(1);
    expect(storage.getMaxKaNumberForAuthor.staticCall).toHaveBeenCalledWith(AUTHOR);
  });

  it('returns -1n for a never-minted author (allocator next number = 0)', async () => {
    const storage = { getMaxKaNumberForAuthor: viewMock(async () => -1n) };
    expect(await makeAdapter(storage).getMaxKaNumberForAuthor(AUTHOR)).toBe(-1n);
  });

  it('propagates a view error — no silent fallback / log crawl', async () => {
    const err: any = new Error('rate limited');
    err.code = 'SERVER_ERROR';
    const storage = {
      getMaxKaNumberForAuthor: viewMock(async () => {
        throw err;
      }),
    };
    await expect(
      makeAdapter(storage).getMaxKaNumberForAuthor(AUTHOR),
    ).rejects.toThrow('rate limited');
  });
});
