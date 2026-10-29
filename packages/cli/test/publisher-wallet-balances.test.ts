import { describe, expect, it } from 'vitest';
import type { ChainAdapter } from '@origintrail-official/dkg-chain';
import { createPublisherWalletBalanceReader } from '../src/publisher-wallet-balances.js';

describe('publisher wallet balance reader (#3591)', () => {
  it('reads each wallet through its own adapter', async () => {
    const asked: string[] = [];
    const adapter = (native: bigint, trac: bigint | null) => ({
      readPublisherWalletBalances: async (address: string) => {
        asked.push(address);
        return { native, trac };
      },
    }) as unknown as ChainAdapter;
    const read = createPublisherWalletBalanceReader(new Map([
      ['0xa', adapter(5n, 7n)],
      ['0xb', adapter(1n, null)],
    ]));

    expect(await read('0xa')).toEqual({ native: 5n, trac: 7n });
    expect(await read('0xb')).toEqual({ native: 1n, trac: null });
    expect(asked).toEqual(['0xa', '0xb']);
  });

  it('answers unreadable for an unknown wallet or an adapter that cannot read balances', async () => {
    const read = createPublisherWalletBalanceReader(new Map([['0xa', {} as ChainAdapter]]));

    expect(await read('0xa')).toEqual({ native: null, trac: null });
    expect(await read('0xmissing')).toEqual({ native: null, trac: null });
  });
});
