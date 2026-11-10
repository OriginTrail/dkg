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
  const SUBSCRIPTIONS = ethers.getAddress('0x00000000000000000000000000000000000000a1');
  const DEPLOYED = 10_000;
  const topic = (value: bigint | string) => ethers.zeroPadValue(typeof value === 'bigint' ? ethers.toBeHex(value) : value, 32);
  const buyerAdded = (accountId: bigint, blockNumber: number) => ({ blockNumber, topics: [ethers.id('BuyerAdded'), topic(accountId), topic(BUYER)] });

  /** An adapter whose chain is `logs` up to `chain.head`, recording each page it reads and each lookup it makes. */
  function adapterOver(chain: { head: number; logs: Array<ReturnType<typeof buyerAdded>>; anchor?: number }) {
    const pages: Array<[number, number]> = [];
    const lookups = { deployBlock: 0, head: 0 };
    const serviceSubscriptions = { getAddress: async () => SUBSCRIPTIONS, filters: { BuyerAdded: () => ({}) } };
    const adapter = Object.assign(Object.create(EVMChainAdapter.prototype), {
      init: async () => undefined,
      resolveContract: async () => serviceSubscriptions,
      resolveContractDeployBlock: async () => {
        lookups.deployBlock += 1;
        return { fromBlock: chain.anchor ?? DEPLOYED, head: chain.head, scanProviders: [], ...(chain.anchor === 0 ? { degradedFromGenesis: true } : {}) };
      },
      resolveLogScanHead: async () => {
        lookups.head += 1;
        return { head: chain.head, scanProviders: [] };
      },
      queryEventLogsPage: async (_contract: unknown, _filter: unknown, lo: number, hi: number) => {
        pages.push([lo, hi]);
        return { logs: chain.logs.filter((l) => l.blockNumber >= lo && l.blockNumber <= hi), provider: {} };
      },
    }) as { listBuyerAccounts(buyer: string): Promise<bigint[]> };
    return { adapter, pages, lookups };
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
    const chain = { head: 25_000, logs: [buyerAdded(7n, 12_345)], anchor: 0 };
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
});
