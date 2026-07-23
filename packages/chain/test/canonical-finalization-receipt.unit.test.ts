import { describe, expect, it, vi } from 'vitest';
import { PublishMethods } from '../src/evm-adapter-publish.js';

const TX_HASH = `0x${'ab'.repeat(32)}`;
const BLOCK_HASH = `0x${'cd'.repeat(32)}`;
const PUBLISHER = '0x2222222222222222222222222222222222222222';
const AUTHOR = '0x1111111111111111111111111111111111111111';
const KA_ID = (BigInt(AUTHOR) << 96n) | 7n;
const MERKLE_ROOT = Uint8Array.from({ length: 32 }, (_, index) => index);

function adapter(overrides: Record<string, unknown> = {}) {
  return Object.assign(Object.create(PublishMethods.prototype), {
    init: vi.fn(async () => undefined),
    contracts: { knowledgeAssetStorage: {} },
    getTransactionReceiptWithFailover: vi.fn(async () => null),
    getTransactionWithFailover: vi.fn(async () => null),
    parseV10PublishReceipt: vi.fn(async () => null),
    ...overrides,
  }) as PublishMethods;
}

describe('canonical finalization receipt capability', () => {
  it('distinguishes pending transactions from unknown hashes', async () => {
    const pending = adapter({
      getTransactionWithFailover: vi.fn(async () => ({ hash: TX_HASH })),
    });
    await expect(pending.resolveCanonicalFinalizationReceipt(TX_HASH))
      .resolves.toEqual({ status: 'pending' });

    const unknown = adapter();
    await expect(unknown.resolveCanonicalFinalizationReceipt(TX_HASH))
      .resolves.toEqual({ status: 'not-found' });
  });

  it('rejects a mined failed transaction instead of retrying it as unknown', async () => {
    const chain = adapter({
      getTransactionReceiptWithFailover: vi.fn(async () => ({
        hash: TX_HASH,
        status: 0,
        blockNumber: 123,
        blockHash: BLOCK_HASH,
        index: 4,
      })),
    });

    await expect(chain.resolveCanonicalFinalizationReceipt(TX_HASH))
      .resolves.toEqual({ status: 'rejected' });
  });

  it('rejects a receipt whose persisted block identity is no longer canonical', async () => {
    const receipt = {
      hash: TX_HASH,
      status: 1,
      blockNumber: 123,
      blockHash: BLOCK_HASH,
      index: 4,
    };
    const chain = adapter({
      getTransactionReceiptWithFailover: vi.fn(async () => receipt),
    });

    await expect(chain.resolveCanonicalFinalizationReceipt(TX_HASH, {
      expectedBlockNumber: 123,
      expectedBlockHash: `0x${'ef'.repeat(32)}`,
    })).resolves.toEqual({ status: 'reorged' });
  });

  it('returns mandatory block and ordering provenance for a confirmed publish', async () => {
    const receipt = {
      hash: TX_HASH,
      status: 1,
      blockNumber: 123,
      blockHash: BLOCK_HASH,
      index: 4,
    };
    const chain = adapter({
      getTransactionReceiptWithFailover: vi.fn(async () => receipt),
      parseV10PublishReceipt: vi.fn(async () => ({
        batchId: KA_ID,
        kaId: KA_ID,
        startKAId: KA_ID,
        endKAId: KA_ID,
        txHash: TX_HASH,
        blockNumber: 123,
        txIndex: 4,
        merkleRoot: MERKLE_ROOT,
        publisherAddress: PUBLISHER,
        authorAddress: AUTHOR,
      })),
    });

    await expect(chain.resolveCanonicalFinalizationReceipt(TX_HASH)).resolves.toEqual({
      status: 'confirmed',
      receipt: {
        txHash: TX_HASH,
        blockNumber: 123,
        blockHash: BLOCK_HASH,
        txIndex: 4,
        merkleRoot: MERKLE_ROOT,
        publisherAddress: PUBLISHER,
        authorAddress: AUTHOR,
        batchId: KA_ID,
        kaId: KA_ID,
        startKAId: KA_ID,
        endKAId: KA_ID,
      },
    });
  });

  it('resolves a legacy V9 receipt and derives its singleton KA range', async () => {
    const receipt = {
      hash: TX_HASH,
      status: 1,
      blockNumber: 123,
      blockHash: BLOCK_HASH,
      index: 4,
    };
    const legacyBatchId = 19n;
    const parseV9PublishReceipt = vi.fn(async () => ({
      batchId: legacyBatchId,
      txHash: TX_HASH,
      blockNumber: 123,
      txIndex: 4,
      merkleRoot: MERKLE_ROOT,
      publisherAddress: PUBLISHER,
    }));
    const chain = adapter({
      contracts: { knowledgeAssetsStorage: {} },
      getTransactionReceiptWithFailover: vi.fn(async () => receipt),
      parseV9PublishReceipt,
    });

    await expect(chain.resolveCanonicalFinalizationReceipt(TX_HASH)).resolves.toEqual({
      status: 'confirmed',
      receipt: {
        txHash: TX_HASH,
        blockNumber: 123,
        blockHash: BLOCK_HASH,
        txIndex: 4,
        merkleRoot: MERKLE_ROOT,
        publisherAddress: PUBLISHER,
        batchId: legacyBatchId,
        kaId: legacyBatchId,
        startKAId: legacyBatchId,
        endKAId: legacyBatchId,
      },
    });
    expect(chain.parseV10PublishReceipt).not.toHaveBeenCalled();
    expect(parseV9PublishReceipt).toHaveBeenCalledWith(receipt, {});
  });
});
