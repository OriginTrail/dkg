import { ethers } from 'ethers';
import { describe, expect, it, vi } from 'vitest';
import { PublishMethods } from '../src/evm-adapter-publish.js';
import { EvmReceiptFinalityReader } from '../src/evm-adapter-receipt-finality.js';
import { loadAbi } from '../src/evm-adapter-abi.js';

const KA_ID = 42n;
const CG_ID = 7n;
const ROOT = `0x${'ab'.repeat(32)}`;
const HASH = `0x${'cd'.repeat(32)}`;
const BLOCK_HASH = `0x${'ef'.repeat(32)}`;
const ADDRESS = '0x1111111111111111111111111111111111111111';

function fixture(finalityConfirmations = 1) {
  const storageInterface = new ethers.Interface(loadAbi('DKGKnowledgeAssets'));
  const roots = [{ publisher: ADDRESS, merkleRoot: ROOT, timestamp: 100n }];
  const log = {
    args: { id: KA_ID, merkleRoot: ROOT, author: ADDRESS },
    transactionHash: HASH, blockNumber: 10, blockHash: BLOCK_HASH, transactionIndex: 2,
  };
  const storage = { target: ADDRESS, interface: storageInterface,
    filters: { KnowledgeAssetCreated: vi.fn(() => ({})) } };
  const receipt = { txHash: HASH, blockNumber: 10, txIndex: 2, blockTimestamp: 100,
    batchId: KA_ID, kaId: KA_ID, startKAId: KA_ID, endKAId: KA_ID,
    merkleRoot: ethers.getBytes(ROOT), publisherAddress: ADDRESS,
    authorAddress: '0x2222222222222222222222222222222222222222', knowledgeAssetsContract: ADDRESS };
  const rawReceipt = { hash: HASH, status: 1, blockNumber: 10, blockHash: BLOCK_HASH, index: 2 };
  const readContract = vi.fn(async (_contract, _label, method) =>
    method === 'getMerkleRoots' ? roots : CG_ID);
  const queryEventLogsPage = vi.fn(async (..._args: unknown[]) => ({ logs: [log] }));
  const readPublishReceipt = vi.fn(async () => ({ receipt: rawReceipt, publish: receipt }));
  const provider = { getBlockNumber: vi.fn(async () => 10),
    getBlock: vi.fn(async (number: number) => ({ number, hash: BLOCK_HASH })) };
  const finalityProviderRead = vi.fn(async (_label, read) => read(provider));
  const chain = Object.assign(Object.create(PublishMethods.prototype), {
    init: vi.fn(async () => undefined),
    contracts: { knowledgeAssetStorage: storage, contextGraphStorage: {} },
    readContract, queryEventLogsPage, readPublishReceipt,
    getTransactionWithFailover: vi.fn(async () => null),
    receiptFinality: new EvmReceiptFinalityReader(finalityConfirmations, finalityProviderRead),
    resolveKaStorageDeployBlock: vi.fn(async () => ({ fromBlock: 1, head: 10, scanProviders: [] })),
    getBlockTimestamp: vi.fn(async (_block: number) => 100),
  }) as PublishMethods;
  return { chain, roots, log, receipt, rawReceipt, queryEventLogsPage, readPublishReceipt,
    provider, finalityProviderRead };
}

function longHistoryFixture() {
  const f = fixture();
  const mintBlock = 5_000;
  f.roots[0].timestamp = BigInt(mintBlock * 12);
  f.log.blockNumber = mintBlock;
  f.rawReceipt.blockNumber = mintBlock;
  f.receipt.blockNumber = mintBlock;
  f.provider.getBlockNumber.mockResolvedValue(10_000);
  Reflect.get(f.chain, 'resolveKaStorageDeployBlock').mockResolvedValue({ fromBlock: 1, head: 10_000, scanProviders: [] });
  Reflect.get(f.chain, 'getBlockTimestamp').mockImplementation(async (block: number) => block * 12);
  f.queryEventLogsPage.mockImplementation(async (...args) => ({
    logs: Number(args[2]) <= mintBlock && Number(args[3]) >= mintBlock ? [f.log] : [],
  }));
  return f;
}

describe('existing mint provenance', () => {
  it('recovers the actual transaction only after verifying root, graph and receipt finality', async () => {
    const f = fixture();
    await expect(f.chain.getMintedKnowledgeAssetProvenance(KA_ID, ethers.getBytes(ROOT), CG_ID))
      .resolves.toEqual(f.receipt);
    expect(f.readPublishReceipt).toHaveBeenCalledWith(HASH, {
      expectedBlockNumber: 10, expectedBlockHash: BLOCK_HASH,
    }, 'canonical finalization receipt');
    expect(f.provider.getBlock).toHaveBeenCalledWith(10);
  });

  it.each([
    ['a different sealed root', `0x${'01'.repeat(32)}`, CG_ID, 'KA_ID_COLLISION'],
    ['a different graph', ROOT, CG_ID + 1n, 'KA_CG_MISMATCH'],
  ])('refuses %s before scanning provenance', async (_name, root, graph, code) => {
    const f = fixture();
    await expect(f.chain.getMintedKnowledgeAssetProvenance(KA_ID, ethers.getBytes(root), graph))
      .rejects.toMatchObject({ code });
    expect(f.queryEventLogsPage).not.toHaveBeenCalled();
  });

  it('refuses an updated asset instead of finalizing its superseded version', async () => {
    const f = fixture();
    f.roots.push({ ...f.roots[0] });
    await expect(f.chain.getMintedKnowledgeAssetProvenance(KA_ID, ethers.getBytes(ROOT), CG_ID))
      .rejects.toMatchObject({ code: 'KA_SUPERSEDED' });
  });

  it('leaves an unrecoverable event without synthesized provenance', async () => {
    const f = fixture();
    f.queryEventLogsPage.mockResolvedValue({ logs: [] });
    await expect(f.chain.getMintedKnowledgeAssetProvenance(KA_ID, ethers.getBytes(ROOT), CG_ID))
      .resolves.toBeNull();
  });

  it('requires the graph storage capability to prove binding', async () => {
    const f = fixture();
    Reflect.get(f.chain, 'contracts').contextGraphStorage = undefined;
    await expect(f.chain.getMintedKnowledgeAssetProvenance(KA_ID, ethers.getBytes(ROOT), CG_ID))
      .resolves.toBeNull();
  });

  it.each(['pending', 'not-found', 'reorged', 'rejected'] as const)('does not adopt a %s receipt', async (status) => {
    const f = fixture();
    if (status === 'pending' || status === 'not-found') {
      f.readPublishReceipt.mockResolvedValue({ receipt: null, publish: null } as never);
      Reflect.get(f.chain, 'getTransactionWithFailover').mockResolvedValue(status === 'pending' ? {} : null);
    } else if (status === 'rejected') f.rawReceipt.status = 0;
    else f.rawReceipt.blockHash = `0x${'01'.repeat(32)}`;
    await expect(f.chain.getMintedKnowledgeAssetProvenance(KA_ID, ethers.getBytes(ROOT), CG_ID))
      .resolves.toBeNull();
  });

  it('holds a matching head mint below the configured confirmation depth', async () => {
    const f = fixture(12);
    await expect(f.chain.getMintedKnowledgeAssetProvenance(KA_ID, ethers.getBytes(ROOT), CG_ID)).resolves.toBeNull();
    expect(f.provider.getBlockNumber).toHaveBeenCalledOnce();
    f.provider.getBlockNumber.mockResolvedValue(21);
    await expect(f.chain.getMintedKnowledgeAssetProvenance(KA_ID, ethers.getBytes(ROOT), CG_ID)).resolves.toEqual(f.receipt);
  });

  it('holds a matching receipt whose block hash no longer occupies its height', async () => {
    const f = fixture();
    f.provider.getBlock.mockResolvedValue({ number: 10, hash: `0x${'01'.repeat(32)}` });
    await expect(f.chain.getMintedKnowledgeAssetProvenance(KA_ID, ethers.getBytes(ROOT), CG_ID)).resolves.toBeNull();
  });

  it('finds a mid-history mint using block timestamps and a range-aware event read', async () => {
    const f = longHistoryFixture();
    await expect(f.chain.getMintedKnowledgeAssetProvenance(KA_ID, ethers.getBytes(ROOT), CG_ID))
      .resolves.toMatchObject({ txHash: HASH, blockNumber: 5_000, blockTimestamp: 60_000 });
    expect(f.queryEventLogsPage.mock.calls[0].slice(2, 4)).toEqual([4_872, 5_128]);
  });

  it('cannot recover from a wrong head-only scan window', async () => {
    const f = longHistoryFixture();
    Reflect.get(f.chain, 'getBlockTimestamp').mockResolvedValue(0);
    await expect(f.chain.getMintedKnowledgeAssetProvenance(KA_ID, ethers.getBytes(ROOT), CG_ID)).resolves.toBeNull();
    expect(f.queryEventLogsPage.mock.calls[0].slice(2, 4)).toEqual([9_872, 10_000]);
  });

  it.each(['merkleRoot', 'kaId', 'startKAId', 'endKAId'] as const)('refuses a confirmed receipt with a mismatched %s', async field => {
    const f = fixture();
    if (field === 'merkleRoot') f.receipt.merkleRoot = ethers.getBytes(`0x${'01'.repeat(32)}`);
    else f.receipt[field] = KA_ID + 1n;
    await expect(f.chain.getMintedKnowledgeAssetProvenance(KA_ID, ethers.getBytes(ROOT), CG_ID))
      .rejects.toMatchObject({ code: 'KA_ID_COLLISION' });
  });

  it.each(['queryEventLogsPage', 'readPublishReceipt', 'finalityProviderRead'] as const)('returns unavailable when %s fails', async read => {
    const f = fixture();
    f[read].mockRejectedValue(new Error('RPC unavailable'));
    await expect(f.chain.getMintedKnowledgeAssetProvenance(KA_ID, ethers.getBytes(ROOT), CG_ID)).resolves.toBeNull();
  });

  it('refuses a creation event whose root differs from storage', async () => {
    const f = fixture();
    f.log.args.merkleRoot = `0x${'01'.repeat(32)}`;
    await expect(f.chain.getMintedKnowledgeAssetProvenance(KA_ID, ethers.getBytes(ROOT), CG_ID))
      .rejects.toMatchObject({ code: 'KA_ID_COLLISION' });
  });
});
