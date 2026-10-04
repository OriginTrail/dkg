import type { ethers } from 'ethers';
import type { CanonicalFinalizationReceipt, CanonicalFinalizationReceiptReadOptions, OnChainPublishResult, PublishReceiptReadOptions } from './chain-adapter.js';
import type { CanonicalFinalizationPublishResolution } from './evm-existing-mint.js';

interface CanonicalPublishReadPorts {
  init(): Promise<void>;
  readPublishReceipt(txHash: string, options: PublishReceiptReadOptions, logLabel?: string): Promise<{ receipt: ethers.TransactionReceipt | null; publish: OnChainPublishResult | null }>;
  hasTransaction(txHash: string, options: CanonicalFinalizationReceiptReadOptions): Promise<boolean>;
}

/**
 * Project the strict recovery receipt from the exact receipt/publish pair a
 * caller already read. This is deliberately pure: the caller owns the live
 * canonicality/finality gate, and an incomplete projection simply leaves
 * the existing canonical-receipt fallback in place.
 */
export function projectCanonicalFinalizationReceipt(
  receipt: ethers.TransactionReceipt,
  parsedPublish: OnChainPublishResult,
): CanonicalFinalizationReceipt | null {
  if (
    !parsedPublish.merkleRoot
    || !parsedPublish.publisherAddress
    || !Number.isSafeInteger(receipt.index)
    || receipt.index < 0
    || !receipt.blockHash
  ) {
    return null;
  }
  const kaId = parsedPublish.kaId ?? parsedPublish.batchId;
  const startKAId = parsedPublish.startKAId ?? kaId;
  const endKAId = parsedPublish.endKAId ?? kaId;
  return {
    txHash: receipt.hash,
    blockNumber: receipt.blockNumber,
    blockHash: receipt.blockHash,
    txIndex: receipt.index,
    merkleRoot: parsedPublish.merkleRoot,
    publisherAddress: parsedPublish.publisherAddress,
    ...(parsedPublish.authorAddress
      ? { authorAddress: parsedPublish.authorAddress }
      : {}),
    batchId: parsedPublish.batchId,
    kaId,
    startKAId,
    endKAId,
    ...(parsedPublish.knowledgeAssetsContract
      ? { knowledgeAssetsContract: parsedPublish.knowledgeAssetsContract }
      : {}),
  };
}


/** Shared receipt classification retains the already decoded publish for adoption. */
export async function resolveCanonicalFinalizationPublish(
  ports: CanonicalPublishReadPorts,
  txHash: string,
  options: CanonicalFinalizationReceiptReadOptions = {},
): Promise<CanonicalFinalizationPublishResolution> {
  await ports.init();
  const { receipt, publish: parsedPublish } = await ports.readPublishReceipt(
    txHash,
    options,
    'canonical finalization receipt',
  );
  if (!receipt) {
    const transaction = await ports.hasTransaction(txHash, options);
    return transaction ? { status: 'pending' } : { status: 'not-found' };
  }
  if (receipt.status !== 1) return { status: 'rejected' };
  if (
    (options.expectedBlockHash !== undefined
      && receipt.blockHash.toLowerCase() !== options.expectedBlockHash.toLowerCase())
    || (options.expectedBlockNumber !== undefined
      && receipt.blockNumber !== options.expectedBlockNumber)
  ) {
    return { status: 'reorged' };
  }

  if (!parsedPublish) return { status: 'rejected' };
  const canonicalReceipt = projectCanonicalFinalizationReceipt(receipt, parsedPublish);
  return canonicalReceipt
    ? { status: 'confirmed', receipt: canonicalReceipt, publish: parsedPublish }
    : { status: 'rejected' };
}

