// SPDX-License-Identifier: Apache-2.0
/**
 * `extendKnowledgeAssetLifetime`, which keeps a seller's offer asset stored:
 *   - on the EVM adapter, paid at the rate `KnowledgeAssetsLifecycle` asks of
 *     an extension (ask × bytes × epochs / 1024, at least 1 wei), approved to
 *     the lifecycle contract first, sent from the wallet asked for or else the
 *     one a publish would pay from (gas, and the TRAC the extension costs), and
 *     answered with the end epoch read after it (its contract calls and the
 *     wallets' balances stubbed; the cli's serving test extends a real asset
 *     on Hardhat);
 *   - on the mock, charged at 1 wei per KiB and epoch, and refused once the
 *     asset has expired;
 *   - absent on NoChainAdapter, as every marketplace method is.
 */
import { describe, expect, it } from 'vitest';
import { ethers } from 'ethers';
import { EVMChainAdapter } from '../src/evm-adapter.js';
import { MockChainAdapter } from '../src/mock-adapter.js';
import { NoChainAdapter } from '../src/no-chain-adapter.js';
import { marketplaceChainOf } from '../src/marketplace.js';

const KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const SECOND_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b63b91100';
const LIFECYCLE = ethers.getAddress('0x00000000000000000000000000000000000000a1');
const ONE = 10n ** 18n;

/**
 * An EVM adapter whose chain reads and sends are stubbed: the asset holds `byteSize` bytes through `endEpoch`, at
 * `ask`. Each wallet holds what `funding` says by its lowercased address, and 1 ETH and 1 TRAC otherwise.
 */
function stubbedAdapter(ask: bigint, byteSize: bigint, endEpoch: bigint, wallets: { additionalKeys?: string[]; funding?: Map<string, { native: bigint; trac: bigint }> } = {}) {
  const adapter = new EVMChainAdapter({
    rpcUrl: 'http://127.0.0.1:59998', privateKey: KEY, hubAddress: '0x0000000000000000000000000000000000000001', chainId: 'evm:31337',
    ...(wallets.additionalKeys ? { additionalKeys: wallets.additionalKeys } : {}),
  });
  const calls: { approvals: unknown[][]; sends: unknown[][] } = { approvals: [], sends: [] };
  const context = { byteSize, endEpoch };
  Object.assign(adapter, {
    init: async () => undefined,
    getWalletFunding: async (address: string) => wallets.funding?.get(address.toLowerCase()) ?? { native: ONE, trac: ONE },
    contracts: { knowledgeAssetStorage: {}, askStorage: {} },
    readContract: async (_c: unknown, label: string) => (label === 'askStorage.getStakeWeightedAverageAsk' ? ask : undefined),
    readKnowledgeAssetUpdateContext: async () => ({ ...context }),
    resolveContract: async (name: string) => ({ name, getAddress: async () => LIFECYCLE }),
    ensureV10ApproveTrac: async (...args: unknown[]) => { calls.approvals.push(args); },
    marketplaceSend: async (contract: () => Promise<{ name: string }>, method: string, args: unknown[], opts: unknown) => {
      calls.sends.push([(await contract()).name, method, args, opts]);
      context.endEpoch += BigInt(args[1] as number);
      return { hash: ethers.ZeroHash, blockNumber: 7, index: 0, status: 1 };
    },
  });
  return { adapter, calls };
}

describe('extendKnowledgeAssetLifetime on the EVM adapter', () => {
  it('pays ask × bytes × epochs / 1024, approved to the lifecycle contract first, and reads the new end epoch', async () => {
    const { adapter, calls } = stubbedAdapter(10n ** 15n, 2_048n, 13n);
    const signer = adapter.getSignerAddress();
    const extension = await adapter.extendKnowledgeAssetLifetime(42n, 12);
    const tokenAmount = (10n ** 15n * 2_048n * 12n) / 1024n;
    expect(extension).toEqual({ hash: ethers.ZeroHash, blockNumber: 7, txIndex: 0, success: true, tokenAmount, endEpoch: 25 });
    expect(calls.approvals).toEqual([[expect.objectContaining({ address: signer }), LIFECYCLE, tokenAmount, 'extend knowledge asset']]);
    expect(calls.sends).toEqual([['KnowledgeAssetsLifecycle', 'extendKnowledgeAssetLifetime', [42n, 12, tokenAmount], { from: signer }]]);
  });

  it('pays at least 1 wei, and refuses a wallet that is not the node\'s and a chain without the contracts', async () => {
    const { adapter, calls } = stubbedAdapter(1n, 10n, 3n);
    expect((await adapter.extendKnowledgeAssetLifetime(42n, 1)).tokenAmount).toBe(1n);
    expect(calls.sends[0]![2]).toEqual([42n, 1, 1n]);
    await expect(adapter.extendKnowledgeAssetLifetime(42n, 1, { from: ethers.getAddress(`0x${'0c'.repeat(20)}`) }))
      .rejects.toThrow(/not one of this node's operational wallets/);
    Object.assign(adapter, { contracts: { knowledgeAssetStorage: {} } });
    await expect(adapter.extendKnowledgeAssetLifetime(42n, 1)).rejects.toThrow(/AskStorage not available/);
  });

  it('sends from the wallet a publish would pay from: one with gas and the TRAC it costs, past a primary without TRAC', async () => {
    const tokenAmount = (10n ** 15n * 2_048n * 12n) / 1024n;
    const primary = new ethers.Wallet(KEY).address;
    const second = new ethers.Wallet(SECOND_KEY).address;
    const funding = new Map([[primary.toLowerCase(), { native: ONE, trac: 0n }], [second.toLowerCase(), { native: ONE, trac: tokenAmount }]]);
    const { adapter, calls } = stubbedAdapter(10n ** 15n, 2_048n, 13n, { additionalKeys: [SECOND_KEY], funding });
    expect((await adapter.extendKnowledgeAssetLifetime(42n, 12)).endEpoch).toBe(25);
    expect(calls.approvals.map(([signer]) => (signer as { address: string }).address)).toEqual([second]);
    expect(calls.sends.map((send) => send[3])).toEqual([{ from: second }]);
    // The wallet asked for sends, funded or not.
    await adapter.extendKnowledgeAssetLifetime(42n, 12, { from: primary });
    expect(calls.sends.map((send) => send[3])).toEqual([{ from: second }, { from: primary }]);
    // TRAC short in every wallet: the best-funded one sends, not the next in turn, and the contract says whether
    // its TRAC and the graph's escrow do.
    funding.set(second.toLowerCase(), { native: 2n * ONE, trac: tokenAmount - 1n });
    await adapter.extendKnowledgeAssetLifetime(42n, 12);
    expect(calls.sends.map((send) => send[3])).toEqual([{ from: second }, { from: primary }, { from: second }]);
  });
});

describe('extendKnowledgeAssetLifetime on the mock and without a chain', () => {
  it('extends a held asset at 1 wei per KiB and epoch, and refuses an expired or unknown one', async () => {
    const mock = new MockChainAdapter('mock:31337', ethers.Wallet.createRandom().address);
    mock.__registerKC({ kaId: 5n, contextGraphId: 1n, merkleRootHex: ethers.ZeroHash, chunks: [], byteSize: 4_096n, startEpoch: 1n, endEpoch: 3n, tokenAmount: 100n });
    const extension = await mock.extendKnowledgeAssetLifetime(5n, 12);
    expect(extension).toMatchObject({ success: true, tokenAmount: 48n, endEpoch: 15 });
    expect(await mock.getKnowledgeAssetUpdateContext(5n)).toMatchObject({ endEpoch: 15n, tokenAmount: 148n });
    mock.__registerKC({ kaId: 6n, contextGraphId: 1n, merkleRootHex: ethers.ZeroHash, chunks: [], byteSize: 1n, startEpoch: 1n, endEpoch: 1n });
    expect((await mock.extendKnowledgeAssetLifetime(6n, 1)).tokenAmount).toBe(1n);
    mock.__advanceEpoch();
    mock.__advanceEpoch();
    await expect(mock.extendKnowledgeAssetLifetime(6n, 1)).rejects.toThrow(/expired at epoch 2/);
    await expect(mock.extendKnowledgeAssetLifetime(7n, 1)).rejects.toThrow(/unknown kaId 7/);
  });

  it("reads a held asset's records by the one lookup the extension uses, which refuses an unknown asset", async () => {
    const signer = ethers.Wallet.createRandom().address;
    const mock = new MockChainAdapter('mock:31337', signer);
    mock.__registerKC({ kaId: 5n, contextGraphId: 3n, merkleRootHex: ethers.ZeroHash, chunks: [], merkleLeafCount: 4 });
    expect([
      await mock.getMerkleLeafCount(5n), await mock.getCatalogRoot(5n), await mock.getCatalogLeafCount(5n),
      await mock.getLatestMerkleRootPublisher(5n), await mock.getLatestMerkleRootAuthor(5n), await mock.getKAContextGraphId(5n),
    ]).toEqual([4, new Uint8Array(32), 0, signer, ethers.ZeroAddress, 3n]);
    expect(await mock.getKAContextGraphId(6n)).toBe(0n);
    for (const read of [mock.getMerkleLeafCount, mock.getCatalogRoot, mock.getCatalogLeafCount, mock.getLatestMerkleRootPublisher, mock.getLatestMerkleRootAuthor]) {
      await expect(read.call(mock, 6n)).rejects.toThrow(/unknown kaId 6/);
    }
  });

  it('is absent without a chain, which has no marketplace', () => {
    const none = new NoChainAdapter();
    expect('extendKnowledgeAssetLifetime' in none).toBe(false);
    expect(marketplaceChainOf(none)).toBeNull();
  });
});
