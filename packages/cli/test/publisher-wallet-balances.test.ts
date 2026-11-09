import { describe, expect, it } from 'vitest';
import type { ChainAdapter, V10PublishingConvictionAccountInfo } from '@origintrail-official/dkg-chain';
import { createPublisherWalletBalanceReader } from '../src/publisher-wallet-balances.js';

const NOW_MS = 1_700_000_000_000;
const nowMs = () => NOW_MS;

function account(overrides: Partial<V10PublishingConvictionAccountInfo> = {}): V10PublishingConvictionAccountInfo {
  return {
    owner: '0x0000000000000000000000000000000000000001', committedTRAC: 1_000n, baseEpochAllowance: 100n,
    createdAtEpoch: 1, expiresAtEpoch: 12, createdAtTimestamp: 1, expiresAtTimestamp: NOW_MS / 1000 + 3_600,
    discountBps: 0, topUpBuffer: 0n, agentCount: 1, lastSettledWindow: 0, fullySwept: false,
    remainingAllowance: 500n, currentEpoch: 3, ...overrides,
  };
}

/** An adapter with the balance read and, optionally, the PCA reads. */
function adapter(options: {
  balances?: () => Promise<{ native: bigint | null; trac: bigint | null }>;
  accountId?: () => Promise<bigint>;
  info?: () => Promise<V10PublishingConvictionAccountInfo | null>;
} = {}): ChainAdapter {
  return {
    ...(options.balances ? { readPublisherWalletBalances: async () => await options.balances!() } : {}),
    ...(options.accountId ? { getConvictionAgentAccountId: async () => await options.accountId!() } : {}),
    ...(options.info ? { getPublishingConvictionAccountInfo: async () => await options.info!() } : {}),
  } as unknown as ChainAdapter;
}

describe('publisher wallet balance reader (#3591)', () => {
  it('reads each wallet through its own adapter', async () => {
    const asked: string[] = [];
    const balances = (native: bigint, trac: bigint | null) => ({
      readPublisherWalletBalances: async (address: string) => {
        asked.push(address);
        return { native, trac };
      },
    }) as unknown as ChainAdapter;
    const read = createPublisherWalletBalanceReader(new Map([
      ['0xa', balances(5n, 7n)],
      ['0xb', balances(1n, null)],
    ]), nowMs);

    expect(await read('0xa')).toEqual({ native: 5n, trac: 7n, pca: null });
    expect(await read('0xb')).toEqual({ native: 1n, trac: null, pca: null });
    expect(asked).toEqual(['0xa', '0xb']);
  });

  it('answers unknown for an unknown wallet or an adapter that cannot read', async () => {
    const read = createPublisherWalletBalanceReader(new Map([['0xa', {} as ChainAdapter]]), nowMs);

    expect(await read('0xa')).toEqual({ native: null, trac: null, pca: null });
    expect(await read('0xmissing')).toEqual({ native: null, trac: null });
  });

  it('reads what the wallet\'s Publishing Conviction Account can still cover this epoch', async () => {
    const funds = async () => ({ native: 9n, trac: 0n });
    const read = createPublisherWalletBalanceReader(new Map([
      ['agent', adapter({ balances: funds, accountId: async () => 7n, info: async () => account() })],
      ['no-agent', adapter({ balances: funds, accountId: async () => 0n, info: async () => account() })],
      ['expired', adapter({ balances: funds, accountId: async () => 7n, info: async () => account({ expiresAtTimestamp: NOW_MS / 1000 }) })],
      ['missing-account', adapter({ balances: funds, accountId: async () => 7n, info: async () => null })],
      ['no-allowance-read', adapter({ balances: funds, accountId: async () => 7n, info: async () => account({ remainingAllowance: undefined }) })],
    ]), nowMs);

    expect(await read('agent')).toEqual({ native: 9n, trac: 0n, pca: 500n });
    expect(await read('no-agent')).toEqual({ native: 9n, trac: 0n, pca: 0n });
    expect(await read('expired')).toEqual({ native: 9n, trac: 0n, pca: 0n });
    expect(await read('missing-account')).toEqual({ native: 9n, trac: 0n, pca: 0n });
    expect(await read('no-allowance-read')).toEqual({ native: 9n, trac: 0n, pca: null });
  });

  it('asks for the account strictly, so a failed read is unknown and never zero coverage', async () => {
    const asked: unknown[] = [];
    const reverting = {
      getConvictionAgentAccountId: async () => 7n,
      getPublishingConvictionAccountInfo: async (_accountId: bigint, opts: unknown) => {
        asked.push(opts);
        throw Object.assign(new Error('call revert'), { code: 'CALL_EXCEPTION' });
      },
    } as unknown as ChainAdapter;
    const read = createPublisherWalletBalanceReader(new Map([['reverting', reverting]]), nowMs);

    expect(await read('reverting')).toEqual({ native: null, trac: null, pca: null });
    expect(asked).toEqual([{ extended: true, strict: true }]);
  });

  it('fails each part on its own', async () => {
    const read = createPublisherWalletBalanceReader(new Map([
      ['pca-down', adapter({ balances: async () => ({ native: 9n, trac: 1n }), accountId: async () => { throw new Error('rpc down'); }, info: async () => account() })],
      ['balances-down', adapter({ balances: async () => { throw new Error('rpc down'); }, accountId: async () => 7n, info: async () => account() })],
    ]), nowMs);

    expect(await read('pca-down')).toEqual({ native: 9n, trac: 1n, pca: null });
    expect(await read('balances-down')).toEqual({ native: null, trac: null, pca: 500n });
  });
});
