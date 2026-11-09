// SPDX-License-Identifier: Apache-2.0
/**
 * `listBuyerAccounts` (evm-adapter-marketplace.ts): the accounts whose
 * `BuyerAdded` events name a buyer, ascending, each once, read up to the head
 * on every call. The adapter's own code runs against an in-memory event log
 * that answers its page reads, so no chain is needed.
 */
import { describe, expect, it } from 'vitest';
import { ethers } from 'ethers';
import { EVMChainAdapter } from '../src/evm-adapter.js';

const BUYER = ethers.getAddress('0x00000000000000000000000000000000000000b1');
const OTHER_BUYER = ethers.getAddress('0x00000000000000000000000000000000000000b2');

interface Granted { contract: string; block: number; accountId: bigint; buyer: string }

/**
 * An adapter whose Hub binds `ServiceSubscriptions` at `chain.contract`,
 * deployed at `chain.deployBlock`, with its head at `chain.head`. Its page
 * reads answer from `chain.events` and are recorded in `chain.reads`.
 */
function adapter() {
  const a: any = new EVMChainAdapter({
    rpcUrl: 'http://127.0.0.1:1',
    privateKey: ethers.Wallet.createRandom().privateKey,
    hubAddress: '0x0000000000000000000000000000000000000001',
    chainId: 'evm:31337',
    allowNoAdminSigner: true,
    staticNetwork: false,
  });
  const chain = {
    contract: ethers.getAddress('0x00000000000000000000000000000000000000c1'),
    deployBlock: 100,
    head: 200,
    events: [] as Granted[],
    reads: [] as Array<{ contract: string; from: number; to: number }>,
  };
  a.init = async () => undefined;
  a.resolveContract = async (name: string) => {
    expect(name).toBe('ServiceSubscriptions');
    const contract = chain.contract;
    return { getAddress: async () => contract, filters: { BuyerAdded: (accountId: null, buyer: string) => ({ contract, accountId, buyer }) } };
  };
  a.resolveContractDeployBlock = async (address: string) => {
    expect(address.toLowerCase()).toBe(chain.contract.toLowerCase());
    return { fromBlock: chain.deployBlock, head: chain.head, scanProviders: [] };
  };
  a.queryEventLogsPage = async (_contract: unknown, filter: { contract: string; buyer: string }, lo: number, hi: number) => {
    chain.reads.push({ contract: filter.contract, from: lo, to: hi });
    const logs = chain.events
      .filter((e) => e.contract === filter.contract && e.buyer === filter.buyer && e.block >= lo && e.block <= hi)
      .map((e) => ({ blockNumber: e.block, topics: [ethers.id('BuyerAdded'), ethers.toBeHex(e.accountId, 32), ethers.zeroPadValue(e.buyer, 32)] }));
    return { logs, provider: undefined };
  };
  const grant = (block: number, accountId: bigint, buyer = BUYER) => chain.events.push({ contract: chain.contract, block, accountId, buyer });
  return { a, chain, grant };
}

describe('the accounts that granted a buyer', () => {
  it('are every account whose BuyerAdded names the buyer, ascending and once each, up to the head', async () => {
    const { a, chain, grant } = adapter();
    grant(100, 7n);
    grant(150, 3n);
    grant(160, 7n);
    grant(170, 9n, OTHER_BUYER);
    grant(200, 12n);
    expect(await a.listBuyerAccounts(BUYER)).toEqual([3n, 7n, 12n]);
    expect(await a.listBuyerAccounts(OTHER_BUYER)).toEqual([9n]);
    // Read from the deployment.
    expect(Math.min(...chain.reads.map((r) => r.from))).toBe(chain.deployBlock);
  });

  it('take in the grants made since the last read, at the new head too', async () => {
    const { a, chain, grant } = adapter();
    grant(120, 5n);
    expect(await a.listBuyerAccounts(BUYER)).toEqual([5n]);
    chain.head = 400;
    grant(260, 2n);
    grant(400, 30n);
    expect(await a.listBuyerAccounts(BUYER)).toEqual([2n, 5n, 30n]);
    chain.head = 401;
    expect(await a.listBuyerAccounts(BUYER)).toEqual([2n, 5n, 30n]);
  });

  it('follow the chain when blocks near the head are replaced', async () => {
    const { a, chain, grant } = adapter();
    grant(120, 5n);
    grant(195, 8n);
    expect(await a.listBuyerAccounts(BUYER)).toEqual([5n, 8n]);
    // A short reorg drops the grant at block 195 and lands another at 199.
    chain.events = chain.events.filter((e) => e.block !== 195);
    grant(199, 11n);
    chain.head = 205;
    expect(await a.listBuyerAccounts(BUYER)).toEqual([5n, 11n]);
  });

  it("are the new contract's alone once the Hub binds another ServiceSubscriptions", async () => {
    const { a, chain, grant } = adapter();
    grant(120, 5n);
    expect(await a.listBuyerAccounts(BUYER)).toEqual([5n]);
    chain.contract = ethers.getAddress('0x00000000000000000000000000000000000000c2');
    chain.deployBlock = 300;
    chain.head = 350;
    grant(310, 6n);
    expect(await a.listBuyerAccounts(BUYER)).toEqual([6n]);
    expect(chain.reads.filter((r) => r.contract === chain.contract).map((r) => r.from)[0]).toBe(300);
  });

  it('are none before any grant, read all the same from the deployment to the head', async () => {
    const { a, chain } = adapter();
    expect(await a.listBuyerAccounts(BUYER)).toEqual([]);
    expect(chain.reads.at(-1)?.to).toBe(chain.head);
  });
});
