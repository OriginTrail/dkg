import { ethers } from 'ethers';
import { describe, expect, it, vi } from 'vitest';
import { PublishMethods } from '../src/evm-adapter-publish.js';
import { loadAbi } from '../src/evm-adapter-abi.js';

const KA_ID = 42n;
const CG_ID = 7n;
const ROOT = `0x${'ab'.repeat(32)}`;
const HASH = `0x${'cd'.repeat(32)}`;
const BLOCK_HASH = `0x${'ef'.repeat(32)}`;
const ADDRESS = '0x1111111111111111111111111111111111111111';

function fixture() {
  const storageInterface = new ethers.Interface(loadAbi('DKGKnowledgeAssets'));
  const roots = [{ publisher: ADDRESS, merkleRoot: ROOT, timestamp: 100n }];
  const log = {
    args: { id: KA_ID, merkleRoot: ROOT, author: ADDRESS },
    transactionHash: HASH, blockNumber: 10, blockHash: BLOCK_HASH, transactionIndex: 2,
  };
  const storage = { target: ADDRESS, interface: storageInterface,
    filters: { KnowledgeAssetCreated: vi.fn(() => ({})) } };
  const receipt = { txHash: HASH, blockNumber: 10, blockHash: BLOCK_HASH,
    txIndex: 2, batchId: KA_ID, kaId: KA_ID, startKAId: KA_ID, endKAId: KA_ID,
    merkleRoot: ethers.getBytes(ROOT), publisherAddress: ADDRESS };
  const readContract = vi.fn(async (_contract, _label, method) =>
    method === 'getMerkleRoots' ? roots : CG_ID);
  const queryEventLogsPage = vi.fn(async () => ({ logs: [log] }));
  const resolveCanonicalFinalizationReceipt = vi.fn(async () => ({ status: 'confirmed', receipt }));
  const chain = Object.assign(Object.create(PublishMethods.prototype), {
    contracts: { knowledgeAssetStorage: storage, contextGraphStorage: {} },
    readContract, queryEventLogsPage, resolveCanonicalFinalizationReceipt,
    resolveKaStorageDeployBlock: vi.fn(async () => ({ fromBlock: 1, head: 10, scanProviders: [] })),
    getBlockTimestamp: vi.fn(async () => 100),
  }) as PublishMethods;
  return { chain, roots, log, receipt, queryEventLogsPage, resolveCanonicalFinalizationReceipt };
}

describe('existing mint provenance', () => {
  it('recovers the actual transaction only after verifying root, graph and receipt finality', async () => {
    const f = fixture();
    await expect(f.chain.getMintedKnowledgeAssetProvenance(KA_ID, ethers.getBytes(ROOT), CG_ID))
      .resolves.toMatchObject({ kaId: KA_ID, txHash: HASH, blockNumber: 10, txIndex: 2 });
    expect(f.resolveCanonicalFinalizationReceipt).toHaveBeenCalledWith(HASH, {
      expectedBlockNumber: 10, expectedBlockHash: BLOCK_HASH,
    });
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

  it.each(['pending', 'not-found', 'reorged', 'rejected'])('does not adopt a %s receipt', async (status) => {
    const f = fixture();
    f.resolveCanonicalFinalizationReceipt.mockResolvedValue({ status } as never);
    await expect(f.chain.getMintedKnowledgeAssetProvenance(KA_ID, ethers.getBytes(ROOT), CG_ID))
      .resolves.toBeNull();
  });

  it('refuses a creation event whose root differs from storage', async () => {
    const f = fixture();
    f.log.args.merkleRoot = `0x${'01'.repeat(32)}`;
    await expect(f.chain.getMintedKnowledgeAssetProvenance(KA_ID, ethers.getBytes(ROOT), CG_ID))
      .rejects.toMatchObject({ code: 'KA_ID_COLLISION' });
  });
});
