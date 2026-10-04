import type { ChainEvent, CanonicalFinalizationReceiptReadOptions, CanonicalFinalizationReceiptResolution, OnChainPublishResult } from './chain-adapter.js';
import { projectAdoptedMintPublishResult, type AdoptedMintPublishResult } from './existing-mint-provenance.js';
import { AdoptExistingMintRefusalError } from './adopt-existing-mint-refusal-error.js';

interface MockMintProvenancePorts {
  collection?: { merkleRoot: Uint8Array; updateContext: { merkleRootsCount: bigint }; cgId: bigint };
  events: readonly ChainEvent[];
  isUnfinalized(txHash: string): boolean;
  blockHash(blockNumber: number): string;
  resolveCanonicalReceipt(txHash: string, options: CanonicalFinalizationReceiptReadOptions): Promise<CanonicalFinalizationReceiptResolution>;
  resolvePublish(txHash: string): Promise<OnChainPublishResult | null>;
}

export async function resolveMockPublishByTxHash(events: readonly ChainEvent[], signerAddress: string, txHash: string): Promise<OnChainPublishResult | null> {
  const created = events.find((event) =>
    (event.type === 'KCCreated' || event.type === 'KnowledgeBatchCreated') && event.data.txHash === txHash,
  );
  const txIndex = created?.data.txIndex;
  if (!created || typeof txIndex !== 'number' || !Number.isSafeInteger(txIndex) || txIndex < 0) {
    return null;
  }

  return {
    batchId: BigInt(String(created.data.kaId ?? created.data.batchId ?? '0')),
    kaId: created.data.kaId != null ? BigInt(String(created.data.kaId)) : undefined,
    merkleRoot: created.data.merkleRoot != null ? fromHex(String(created.data.merkleRoot)) : undefined,
    startKAId: created.data.startKAId != null ? BigInt(String(created.data.startKAId)) : undefined,
    endKAId: created.data.endKAId != null ? BigInt(String(created.data.endKAId)) : undefined,
    txHash,
    blockNumber: created.blockNumber,
    txIndex,
    blockTimestamp: Math.floor(Date.now() / 1000),
    publisherAddress: String(created.data.publisherAddress ?? signerAddress),
    authorAddress: created.data.authorAddress != null
      ? String(created.data.authorAddress)
      : created.data.publisherAddress != null
        ? String(created.data.publisherAddress)
        : undefined,
    tokenAmount: created.data.tokenAmount != null ? BigInt(String(created.data.tokenAmount)) : undefined,
  };
}


export async function getMockMintedKnowledgeAssetProvenance(
  ports: MockMintProvenancePorts,
  kaId: bigint,
  expectedMerkleRoot: Uint8Array,
  expectedContextGraphId: bigint,
): Promise<AdoptedMintPublishResult | null> {
  const collection = ports.collection;
  if (collection === undefined || toHex(collection.merkleRoot).toLowerCase()
    !== toHex(expectedMerkleRoot).toLowerCase()) {
    throw new AdoptExistingMintRefusalError('KA_ID_COLLISION',
      `Mock: minted KA ${kaId} does not match the sealed root`);
  }
  if (collection.updateContext.merkleRootsCount !== 1n) {
    throw new AdoptExistingMintRefusalError('KA_SUPERSEDED', `Mock: minted KA ${kaId} has been updated`);
  }
  if (collection.cgId !== expectedContextGraphId) {
    throw new AdoptExistingMintRefusalError('KA_CG_MISMATCH',
      `Mock: minted KA ${kaId} belongs to another context graph`);
  }
  const events = ports.events.filter((event) => event.type === 'KCCreated'
    && event.data.kaId === kaId.toString());
  if (events.length !== 1) return null;
  const txHash = events[0]!.data.txHash;
  if (typeof txHash !== 'string' || ports.isUnfinalized(txHash)) return null;
  const resolution = await ports.resolveCanonicalReceipt(txHash, {
    expectedBlockNumber: events[0]!.blockNumber,
    expectedBlockHash: ports.blockHash(events[0]!.blockNumber),
  });
  if (resolution.status !== 'confirmed' || resolution.receipt.kaId !== kaId
    || toHex(resolution.receipt.merkleRoot).toLowerCase() !== toHex(expectedMerkleRoot).toLowerCase()) return null;
  const publish = await ports.resolvePublish(txHash);
  return publish === null ? null : projectAdoptedMintPublishResult(publish, resolution.receipt);
}


export function toHex(bytes: Uint8Array): string {
  return '0x' + Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export function fromHex(hex: string): Uint8Array {
  const h = hex.startsWith('0x') ? hex.slice(2) : hex;
  const bytes = new Uint8Array(h.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

