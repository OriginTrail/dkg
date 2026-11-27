// SPDX-License-Identifier: Apache-2.0
/**
 * evm-adapter-marketplace.ts, without a chain:
 * - `decodeReceiptBatch`: a landed batch, read from the logs of its receipt.
 * - `listBuyerAccounts`: the adapter keeps its `BuyerAdded` scan between reads,
 *   so a repeat read covers only the new blocks and the reorg tail.
 */
import { describe, expect, it } from 'vitest';
import { ethers } from 'ethers';
import { loadAbi } from '../src/evm-adapter-abi.js';
import { EVMChainAdapter } from '../src/evm-adapter.js';
import { CG_REGISTRY_REORG_BUFFER_BLOCKS } from '../src/evm-adapter-constants.js';
import { decodeReceiptBatch } from '../src/evm-adapter-marketplace.js';

describe('decodeReceiptBatch', () => {
  const settlement = new ethers.Interface(loadAbi('QueryInferenceSettlement'));
  const SETTLEMENT = ethers.getAddress('0x00000000000000000000000000000000000000c1');

  it('reads the accepted batch and its landed groups, from the settlement only', () => {
    const log = (address: string, name: string, args: unknown[]) => ({ address, ...settlement.encodeEventLog(name, args) });
    const subscriptionId = ethers.keccak256('0x07');
    const logs = [
      log(SETTLEMENT, 'ReceiptsLanded', [subscriptionId, 0, 9, 2, 300n, 300n, 10n ** 18n, ethers.keccak256('0x08')]),
      log(SETTLEMENT, 'ReceiptsLanded', [subscriptionId, 1, 9, 1, 200n, 150n, 10n ** 18n, ethers.keccak256('0x09')]),
      log(ethers.getAddress('0x00000000000000000000000000000000000000c2'), 'ReceiptsLanded', [subscriptionId, 2, 9, 1, 1n, 1n, 1n, ethers.ZeroHash]),
      log(SETTLEMENT, 'ReceiptBatchAccepted', [9, ethers.keccak256('0x0a'), 3, 500n, 450n, 10n ** 18n]),
    ];
    expect(decodeReceiptBatch(logs, SETTLEMENT.toLowerCase())).toEqual({
      seller: 9n,
      batchDigest: ethers.keccak256('0x0a'),
      itemCount: 3,
      value: 500n,
      counted: 450n,
      stakeFactor18: 10n ** 18n,
      groups: [
        { subscriptionId, budgetIndex: 0, seller: 9n, itemCount: 2, value: 300n, counted: 300n, stakeFactor18: 10n ** 18n, groupDigest: ethers.keccak256('0x08') },
        { subscriptionId, budgetIndex: 1, seller: 9n, itemCount: 1, value: 200n, counted: 150n, stakeFactor18: 10n ** 18n, groupDigest: ethers.keccak256('0x09') },
      ],
    });
    expect(decodeReceiptBatch(logs.slice(0, 3), SETTLEMENT)).toBeNull();
  });
});

describe('listBuyerAccounts', () => {
  const BUYER = ethers.getAddress('0x00000000000000000000000000000000000000b1');
  const OTHER_BUYER = ethers.getAddress('0x00000000000000000000000000000000000000b2');
  const SUBSCRIPTIONS = ethers.getAddress('0x00000000000000000000000000000000000000a1');
  const REPLACEMENT = ethers.getAddress('0x00000000000000000000000000000000000000a2');
  const DEPLOYED = 10_000;
  const topic = (value: bigint | string) => ethers.zeroPadValue(typeof value === 'bigint' ? ethers.toBeHex(value) : value, 32);
  const buyerAdded = (accountId: bigint, blockNumber: number, buyer = BUYER, address = SUBSCRIPTIONS) => (
    { address, blockNumber, topics: [ethers.id('BuyerAdded'), topic(accountId), topic(buyer)] }
  );

  interface FakeChain {
    head: number;
    logs: Array<ReturnType<typeof buyerAdded>>;
    /** The Hub's ServiceSubscriptions address, and each address's deploy block (a deploy-block search that fell back to genesis gives 0). */
    subscriptions?: string;
    deployedAt?: Record<string, number>;
  }

  /**
   * An adapter built as the node builds one, whose chain is `logs` up to `chain.head`. It records each page
   * it reads, by contract, and each lookup it makes. Only the chain reads are stubbed: the scan it keeps is
   * the adapter's own.
   */
  function adapterOver(chain: FakeChain) {
    const pages: Array<[number, number]> = [];
    const pagesByContract = new Map<string, Array<[number, number]>>();
    const lookups = { deployBlock: 0, head: 0 };
    const contractAt = (address: string) => ({
      getAddress: async () => address,
      filters: { BuyerAdded: (_accountId: unknown, buyer: string) => ({ buyer }) },
    });
    const real = new EVMChainAdapter({
      rpcUrl: 'http://127.0.0.1:1',
      privateKey: `0x${'11'.repeat(32)}`,
      hubAddress: '0x0000000000000000000000000000000000000001',
      chainId: 'evm:31337',
      allowNoAdminSigner: true,
      staticNetwork: false,
    });
    const adapter = Object.assign(real, {
      init: async () => undefined,
      resolveContract: async () => contractAt(chain.subscriptions ?? SUBSCRIPTIONS),
      resolveContractDeployBlock: async (address: string) => {
        lookups.deployBlock += 1;
        const fromBlock = chain.deployedAt?.[address] ?? DEPLOYED;
        return { fromBlock, head: chain.head, scanProviders: [], ...(fromBlock === 0 ? { degradedFromGenesis: true } : {}) };
      },
      resolveLogScanHead: async () => {
        lookups.head += 1;
        return { head: chain.head, scanProviders: [] };
      },
      queryEventLogsPage: async (contract: { getAddress(): Promise<string> }, filter: { buyer: string }, lo: number, hi: number) => {
        const address = await contract.getAddress();
        pages.push([lo, hi]);
        pagesByContract.set(address, [...(pagesByContract.get(address) ?? []), [lo, hi]]);
        const logs = chain.logs.filter((l) => l.address === address && l.topics[2] === topic(filter.buyer)
          && l.blockNumber >= lo && l.blockNumber <= hi);
        return { logs, provider: {} };
      },
    }) as unknown as { listBuyerAccounts(buyer: string): Promise<bigint[]> };
    return { adapter, pages, pagesByContract, lookups };
  }

  it('keeps the scan between reads: a repeat read covers only the new blocks and the reorg tail', async () => {
    const chain = { head: 20_000, logs: [buyerAdded(7n, 12_345)] };
    const { adapter, pages, lookups } = adapterOver(chain);
    expect(await adapter.listBuyerAccounts(BUYER)).toEqual([7n]);
    expect(pages).toEqual([[10_000, 19_999], [20_000, 20_000]]);
    expect(lookups).toEqual({ deployBlock: 1, head: 0 });

    pages.length = 0;
    chain.head = 20_010;
    chain.logs.push(buyerAdded(9n, 20_005));
    expect(await adapter.listBuyerAccounts(BUYER)).toEqual([7n, 9n]);
    expect(pages).toEqual([[20_001 - CG_REGISTRY_REORG_BUFFER_BLOCKS, 20_010]]);
    // A repeat read only looks up the head.
    expect(lookups).toEqual({ deployBlock: 1, head: 1 });
  });

  it('does not search for the deploy block again after a read that fell back to genesis', async () => {
    const chain = { head: 25_000, logs: [buyerAdded(7n, 12_345)], deployedAt: { [SUBSCRIPTIONS]: 0 } };
    const { adapter, pages, lookups } = adapterOver(chain);
    expect(await adapter.listBuyerAccounts(BUYER)).toEqual([7n]);
    expect(pages[0]).toEqual([0, 9_999]);
    pages.length = 0;
    chain.head = 25_005;
    expect(await adapter.listBuyerAccounts(BUYER)).toEqual([7n]);
    expect(lookups).toEqual({ deployBlock: 1, head: 1 });
    expect(pages).toEqual([[25_001 - CG_REGISTRY_REORG_BUFFER_BLOCKS, 25_005]]);
  });

  it('drops an account whose only BuyerAdded a reorg removed from the tail', async () => {
    const chain = { head: 20_000, logs: [buyerAdded(7n, 12_345), buyerAdded(9n, 19_990)] };
    const { adapter } = adapterOver(chain);
    expect(await adapter.listBuyerAccounts(BUYER)).toEqual([7n, 9n]);
    chain.logs = chain.logs.filter((l) => l.blockNumber !== 19_990);
    expect(await adapter.listBuyerAccounts(BUYER)).toEqual([7n]);
  });

  it('gives each adapter a scan of its own', async () => {
    const chain = { head: 20_000, logs: [buyerAdded(7n, 12_345)] };
    const first = adapterOver(chain);
    await first.adapter.listBuyerAccounts(BUYER);
    const second = adapterOver(chain);
    await second.adapter.listBuyerAccounts(BUYER);
    expect(second.pages[0]).toEqual([DEPLOYED, 19_999]);
  });

  it('keeps a scan per buyer: another buyer reads from the deployment and gets only its own accounts', async () => {
    const chain = { head: 20_000, logs: [buyerAdded(7n, 12_345), buyerAdded(9n, 11_000, OTHER_BUYER)] };
    const { adapter, pages } = adapterOver(chain);
    expect(await adapter.listBuyerAccounts(BUYER)).toEqual([7n]);
    pages.length = 0;
    // Buyer B's account is older than the reorg tail of A's scan, so a scan shared with A would miss it.
    expect(await adapter.listBuyerAccounts(OTHER_BUYER)).toEqual([9n]);
    expect(pages).toEqual([[DEPLOYED, 19_999], [20_000, 20_000]]);
    // And A's next read still covers only its tail.
    pages.length = 0;
    expect(await adapter.listBuyerAccounts(BUYER)).toEqual([7n]);
    expect(pages).toEqual([[20_001 - CG_REGISTRY_REORG_BUFFER_BLOCKS, 20_000]]);
  });

  it('keeps a scan per contract: a replacement ServiceSubscriptions is read from its own deployment', async () => {
    const chain: FakeChain = {
      head: 20_000,
      logs: [buyerAdded(7n, 12_345), buyerAdded(11n, 16_000, BUYER, REPLACEMENT)],
      deployedAt: { [SUBSCRIPTIONS]: DEPLOYED, [REPLACEMENT]: 15_000 },
    };
    const { adapter, pagesByContract } = adapterOver(chain);
    expect(await adapter.listBuyerAccounts(BUYER)).toEqual([7n]);
    // The Hub now names a replacement contract.
    chain.subscriptions = REPLACEMENT;
    expect(await adapter.listBuyerAccounts(BUYER)).toEqual([11n]);
    expect(pagesByContract.get(REPLACEMENT)).toEqual([[15_000, 20_000]]);
  });
});
