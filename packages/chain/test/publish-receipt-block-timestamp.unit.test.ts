import { ethers } from 'ethers';
import { describe, expect, it, vi } from 'vitest';
import { loadAbi } from '../src/evm-adapter-abi.js';
import { PublishMethods } from '../src/evm-adapter-publish.js';

const TX_HASH = `0x${'ab'.repeat(32)}`;
const BLOCK_HASH = `0x${'cd'.repeat(32)}`;
const PUBLISHER = '0x2222222222222222222222222222222222222222';
const AUTHOR = '0x1111111111111111111111111111111111111111';
const STORAGE = '0x4444444444444444444444444444444444444444';
const STORAGE_V9 = '0x5555555555555555555555555555555555555555';
const BATCH_ID = 9n;
const KA_ID = (BigInt(AUTHOR) << 96n) | 7n;
const MERKLE_ROOT = Uint8Array.from({ length: 32 }, (_, index) => index);
const TIMESTAMP = 1_234_567;

function v10Receipt() {
  const iface = new ethers.Interface(loadAbi('DKGKnowledgeAssets'));
  const created = iface.encodeEventLog(iface.getEvent('KnowledgeAssetCreated')!, [
    KA_ID, AUTHOR, 'receipt-timestamp-test', ethers.hexlify(MERKLE_ROOT), 2048n, 1n, 2n, 100n, false,
  ]);
  const minted = iface.encodeEventLog(iface.getEvent('KnowledgeAssetsMinted')!, [KA_ID, PUBLISHER, KA_ID, KA_ID + 1n]);
  return {
    iface,
    receipt: {
      hash: TX_HASH,
      status: 1,
      blockNumber: 123,
      blockHash: BLOCK_HASH,
      index: 4,
      from: AUTHOR,
      logs: [
        { address: STORAGE, topics: created.topics, data: created.data },
        { address: STORAGE, topics: minted.topics, data: minted.data },
      ],
    },
  };
}

function v9Receipt() {
  const iface = new ethers.Interface(loadAbi('KnowledgeAssetsStorage'));
  const created = iface.encodeEventLog(iface.getEvent('KnowledgeBatchCreated')!, [
    BATCH_ID, PUBLISHER, ethers.hexlify(MERKLE_ROOT), 2048n, 2n, 1n, 2n, 1n, 100n, 5n, false,
  ]);
  return {
    iface,
    receipt: {
      hash: TX_HASH,
      status: 1,
      blockNumber: 123,
      blockHash: BLOCK_HASH,
      index: 4,
      from: AUTHOR,
      logs: [{ address: STORAGE_V9, topics: created.topics, data: created.data }],
    },
  };
}

function adapter(format: 'v10' | 'v9' = 'v10', storages: Array<'v10' | 'v9'> = [format]) {
  const v10 = v10Receipt();
  const v9 = v9Receipt();
  const receipt = format === 'v10' ? v10.receipt : v9.receipt;
  const finalizedBlockTimestamp = vi.fn(async () => TIMESTAMP);
  const chain = Object.assign(Object.create(PublishMethods.prototype), {
    init: vi.fn(async () => undefined),
    contracts: {
      ...(storages.includes('v10') ? { knowledgeAssetStorage: { interface: v10.iface, target: STORAGE } } : {}),
      ...(storages.includes('v9') ? { knowledgeAssetsStorage: { interface: v9.iface, target: STORAGE_V9 } } : {}),
    },
    getTransactionReceiptWithFailover: vi.fn(async () => receipt),
    getFinalizedBlockTimestamp: finalizedBlockTimestamp,
  }) as PublishMethods;
  return { chain, finalizedBlockTimestamp };
}

describe('publish receipt block timestamp lookup', () => {
  it('reads the receipt block header by default, exactly as before', async () => {
    const { chain, finalizedBlockTimestamp } = adapter();
    const publish = await chain.resolvePublishByTxHash(TX_HASH);
    expect(publish).toMatchObject({
      kaId: KA_ID,
      blockNumber: 123,
      txIndex: 4,
      blockTimestamp: TIMESTAMP,
      txHash: TX_HASH,
    });
    expect(finalizedBlockTimestamp).toHaveBeenCalledTimes(1);
    expect(finalizedBlockTimestamp).toHaveBeenCalledWith(123, BLOCK_HASH, {});
  });

  it('skips the header lookup for a caller that never reads the timestamp and changes no other fact', async () => {
    const full = adapter();
    const skipped = adapter();

    const withTimestamp = await full.chain.resolvePublishByTxHash(TX_HASH);
    const withoutTimestamp = await skipped.chain.resolvePublishByTxHash(TX_HASH, { skipBlockTimestamp: true });

    expect(skipped.finalizedBlockTimestamp).not.toHaveBeenCalled();
    expect(withoutTimestamp).toEqual({ ...withTimestamp, blockTimestamp: 0 });
    // The facts graph-scoped verification consumes are byte-identical.
    expect(withoutTimestamp?.merkleRoot).toEqual(MERKLE_ROOT);
    expect(withoutTimestamp?.kaId).toBe(KA_ID);
    expect(withoutTimestamp?.txHash).toBe(TX_HASH);
    expect(withoutTimestamp?.blockNumber).toBe(123);
    expect(withoutTimestamp?.txIndex).toBe(4);
  });

  it('still reports no publish for a failed or missing receipt when the lookup is skipped', async () => {
    const { chain } = adapter();
    (chain as unknown as { getTransactionReceiptWithFailover: unknown }).getTransactionReceiptWithFailover =
      vi.fn(async () => ({ hash: TX_HASH, status: 0, blockNumber: 123, blockHash: BLOCK_HASH, index: 4 }));
    await expect(chain.resolvePublishByTxHash(TX_HASH, { skipBlockTimestamp: true })).resolves.toBeNull();
    (chain as unknown as { getTransactionReceiptWithFailover: unknown }).getTransactionReceiptWithFailover =
      vi.fn(async () => null);
    await expect(chain.resolvePublishByTxHash(TX_HASH, { skipBlockTimestamp: true })).resolves.toBeNull();
  });

  it('keeps a cancelled call cancelled even when the lookup is skipped', async () => {
    const { chain } = adapter();
    const controller = new AbortController();
    controller.abort(new Error('cancelled'));
    (chain as unknown as { getTransactionReceiptWithFailover: unknown }).getTransactionReceiptWithFailover =
      vi.fn(async (_hash: string, options: { signal?: AbortSignal }) => {
        options.signal?.throwIfAborted();
        return null;
      });
    await expect(chain.resolvePublishByTxHash(TX_HASH, {
      signal: controller.signal,
      skipBlockTimestamp: true,
    })).rejects.toThrow('cancelled');
  });

  describe('the same policy for the legacy receipt format', () => {
    it('reads the header once by default and skips it on request, with identical facts otherwise', async () => {
      const full = adapter('v9');
      const skipped = adapter('v9');

      const withTimestamp = await full.chain.resolvePublishByTxHash(TX_HASH);
      const withoutTimestamp = await skipped.chain.resolvePublishByTxHash(TX_HASH, { skipBlockTimestamp: true });

      expect(withTimestamp).toMatchObject({ batchId: BATCH_ID, blockNumber: 123, txIndex: 4, blockTimestamp: TIMESTAMP });
      expect(full.finalizedBlockTimestamp).toHaveBeenCalledTimes(1);
      expect(skipped.finalizedBlockTimestamp).not.toHaveBeenCalled();
      expect(withoutTimestamp).toEqual({ ...withTimestamp, blockTimestamp: 0 });
      expect(withoutTimestamp?.merkleRoot).toEqual(MERKLE_ROOT);
    });

    it('falls back from the current to the legacy decoder with a single header read', async () => {
      const both = adapter('v9', ['v10', 'v9']);
      const publish = await both.chain.resolvePublishByTxHash(TX_HASH);
      expect(publish).toMatchObject({ batchId: BATCH_ID, blockTimestamp: TIMESTAMP });
      // The current-format decoder finds nothing and must not have looked at the header.
      expect(both.finalizedBlockTimestamp).toHaveBeenCalledTimes(1);

      const skippedBoth = adapter('v9', ['v10', 'v9']);
      await skippedBoth.chain.resolvePublishByTxHash(TX_HASH, { skipBlockTimestamp: true });
      expect(skippedBoth.finalizedBlockTimestamp).not.toHaveBeenCalled();
    });

    it('keeps the direct parsers reading the header unless told otherwise', async () => {
      const v10 = adapter('v10');
      const v9 = adapter('v9');
      const v10Receipt = (await v10.chain.getTransactionReceiptWithFailover!(TX_HASH, {})) as never;
      const v9ReceiptValue = (await v9.chain.getTransactionReceiptWithFailover!(TX_HASH, {})) as never;
      expect(await v10.chain.parseV10PublishReceipt(v10Receipt)).toMatchObject({ blockTimestamp: TIMESTAMP });
      expect(await v9.chain.parseV9PublishReceipt(v9ReceiptValue)).toMatchObject({ blockTimestamp: TIMESTAMP });
      expect(v10.finalizedBlockTimestamp).toHaveBeenCalledTimes(1);
      expect(v9.finalizedBlockTimestamp).toHaveBeenCalledTimes(1);
      expect(await v10.chain.parseV10PublishReceipt(v10Receipt, { skipBlockTimestamp: true })).toMatchObject({ blockTimestamp: 0 });
      expect(await v9.chain.parseV9PublishReceipt(v9ReceiptValue, { skipBlockTimestamp: true })).toMatchObject({ blockTimestamp: 0 });
      expect(v10.finalizedBlockTimestamp).toHaveBeenCalledTimes(1);
      expect(v9.finalizedBlockTimestamp).toHaveBeenCalledTimes(1);
    });
  });
});
