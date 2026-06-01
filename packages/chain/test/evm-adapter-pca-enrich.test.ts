/**
 * V10 PCA write methods — custom-error enrichment WIRING (codex round 6).
 *
 * The five `DKGPublishingConvictionNFT` write methods
 * (create / topUp / settle / register / deregister) rethrow raw ethers
 * `CALL_EXCEPTION`s. Providers commonly surface a custom-error revert as
 * `execution reverted (unknown custom error)` + raw `data="0x<selector>"` —
 * the message does NOT carry the error NAME. The daemon route classifier
 * downstream matches only on `err.message` (regex for `NotAccountOwner`,
 * `InvalidAmount`, `ERC721NonexistentToken`, …), so without enrichment those
 * reverts fall through to HTTP 500 instead of 403/4xx.
 *
 * These tests prove only the WIRING (the writes now run enrichEvmError() on
 * throw then rethrow the SAME error); enrichEvmError's own decode matrix is
 * covered by enrich-evm-error-extra.test.ts / evm-adapter.unit.test.ts.
 *
 * Harness mirrors evm-adapter.unit.test.ts: construct the adapter, stub
 * init() to a no-op, inject a minimal fake NFT into the contract cache. No
 * live RPC / Hardhat.
 */
import { describe, it, expect } from 'vitest';
import { Interface, ethers } from 'ethers';
import { EVMChainAdapter, type EVMAdapterConfig } from '../src/evm-adapter.js';

const DEPLOYER_PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

function minimalConfig(overrides: Partial<EVMAdapterConfig> = {}): EVMAdapterConfig {
  return {
    rpcUrl: 'http://127.0.0.1:59998',
    privateKey: DEPLOYER_PK,
    hubAddress: '0x0000000000000000000000000000000000000001',
    chainId: 'evm:31337',
    ...overrides,
  };
}

const NFT_ADDRESS = '0x00000000000000000000000000000000000000Ad';

// `DKGPublishingConvictionNFT` declares `error NotAccountOwner(uint256
// accountId, address caller)` — the owner-gating revert behind the 403
// regression. ABI-encode a real revert payload so the merged error
// interface in evm-adapter can decode the 4-byte selector.
const PCA_ERR_IFACE = new Interface([
  'error NotAccountOwner(uint256 accountId, address caller)',
]);
const NOT_ACCOUNT_OWNER_HEX = PCA_ERR_IFACE.encodeErrorResult('NotAccountOwner', [
  7n,
  '0x00000000000000000000000000000000000000aa',
]);

/** A real provider's opaque custom-error revert: name absent, only `data=`. */
function opaqueCustomErrorRevert(dataHex: string): Error {
  return Object.assign(
    new Error(
      `execution reverted (unknown custom error) (action="sendTransaction", data="${dataHex}", reason=null)`,
    ),
    { code: 'CALL_EXCEPTION' },
  );
}

/**
 * Build an adapter with init() stubbed and a fake NFT injected. The fake
 * exposes only what the write paths touch: getAddress() (create/topUp need
 * it for the allowance probe) plus the write fn under test.
 */
function adapterWithFakeNft(nftOverrides: Record<string, unknown>): EVMChainAdapter {
  const a = new EVMChainAdapter(minimalConfig());
  (a as any).init = async () => undefined;
  const connected: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(nftOverrides)) {
    connected[name] = typeof value === 'function'
      ? { populateTransaction: (...args: unknown[]) => (value as (...args: unknown[]) => unknown)(...args) }
      : value;
  }
  (a as any).contracts.dkgPublishingConvictionNFT = {
    getAddress: async () => NFT_ADDRESS,
    connect: () => connected,
    ...nftOverrides,
  };
  // Leave contracts.token undefined so the allowance/approve branch in
  // create/topUp is skipped — the revert under test comes from the write.
  return a;
}

describe('PCA write methods enrich opaque custom-error reverts on rethrow (codex round 6)', () => {
  it('registerPublishingConvictionAgent: rethrown error message gains the decoded NotAccountOwner name', async () => {
    const a = adapterWithFakeNft({
      registerAgent: async () => {
        throw opaqueCustomErrorRevert(NOT_ACCOUNT_OWNER_HEX);
      },
    });

    const caught = await a
      .registerPublishingConvictionAgent(7n, '0x00000000000000000000000000000000000000aa')
      .then(() => null)
      .catch((e) => e as Error);

    expect(caught).toBeInstanceOf(Error);
    // RED before pcaWrite(): message still only says "unknown custom error".
    expect(caught!.message).toContain('NotAccountOwner');
    expect(caught!.message).not.toContain('unknown custom error');
    // Same error object rethrown (classifier inspects err.message in place).
    expect((caught as any).code).toBe('CALL_EXCEPTION');
  });

  it('topUpPublishingConvictionAccount: opaque revert is enriched on rethrow', async () => {
    const a = adapterWithFakeNft({
      topUp: async () => {
        throw opaqueCustomErrorRevert(NOT_ACCOUNT_OWNER_HEX);
      },
    });

    const caught = await a
      .topUpPublishingConvictionAccount(7n, ethers.parseEther('1'))
      .then(() => null)
      .catch((e) => e as Error);

    expect(caught).toBeInstanceOf(Error);
    expect(caught!.message).toContain('NotAccountOwner');
    expect(caught!.message).not.toContain('unknown custom error');
  });

  it('non-Error / non-custom-error throws propagate unchanged (helper must not swallow or rewrite)', async () => {
    // (a) plain Error with no revert data — the PCA-enrichment helper
    // must not rewrite or swallow the inner classification. The
    // transport (`sendContractTransaction`) is allowed to prefix
    // operator context (RPC endpoint exhaustion) and attach the
    // original via `.cause`, so we assert the original message is
    // preserved as a substring rather than byte-identical.
    const plain = adapterWithFakeNft({
      settle: async () => {
        throw new Error('connect ECONNREFUSED 127.0.0.1:8545');
      },
    });
    const e1 = await plain
      .settlePublishingConvictionAccount(1n)
      .then(() => null)
      .catch((e) => e as Error);
    expect(e1).toBeInstanceOf(Error);
    expect(e1!.message).toContain('connect ECONNREFUSED 127.0.0.1:8545');

    // (b) non-Error throw (string) — propagated as-is, not wrapped.
    const nonError = adapterWithFakeNft({
      deregisterAgent: async () => {
        // eslint-disable-next-line @typescript-eslint/no-throw-literal
        throw 'raw-string-failure';
      },
    });
    let thrown: unknown = Symbol('unset');
    try {
      await nonError.deregisterPublishingConvictionAgent(
        1n,
        '0x00000000000000000000000000000000000000aa',
      );
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBe('raw-string-failure');
  });
});
