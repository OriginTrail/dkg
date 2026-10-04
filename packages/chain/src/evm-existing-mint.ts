// SPDX-License-Identifier: Apache-2.0
import { ethers, type Contract } from 'ethers';
import type { ScanProvider } from './evm-adapter-base.js';
import type { CanonicalFinalizationReceipt, CanonicalFinalizationReceiptReadOptions, KnowledgeAssetVersionSnapshot, OnChainPublishResult } from './chain-adapter.js';
import { projectAdoptedMintPublishResult, type AdoptedMintPublishResult } from './existing-mint-provenance.js';
import { AdoptExistingMintRefusalError } from './adopt-existing-mint-refusal-error.js';

import type { CanonicalFinalizationPublishResolution } from './canonical-finalization-publish.js';

export interface EvmExistingMintPorts {
  storage?: Contract;
  storageBinding: Readonly<{ address: string; generation: number; isCurrent(): boolean }>;
  readRoots(storage: Contract, kaId: bigint): Promise<Array<{ publisher: string; merkleRoot: string; timestamp: bigint }>>;
  readContextGraphId(kaId: bigint): Promise<bigint | null>;
  resolveDeployBlock(address: string): Promise<{ fromBlock: number; head: number; scanProviders: ReadonlyArray<ScanProvider> }>;
  readBlockTimestamp(blockNumber: number): Promise<number>;
  readCreationLogs(storage: Contract, kaId: bigint, from: number, to: number, providers: ReadonlyArray<ScanProvider>): Promise<ReadonlyArray<ethers.EventLog | ethers.Log>>;
  resolveCanonicalPublish(txHash: string, options: CanonicalFinalizationReceiptReadOptions): Promise<CanonicalFinalizationPublishResolution>;
  isReceiptFinalAndCanonical(receipt: CanonicalFinalizationReceipt): Promise<boolean>;
  readCurrentVersion(kaId: bigint): Promise<KnowledgeAssetVersionSnapshot | null>;
  versionIsCurrent(kaId: bigint, snapshot: KnowledgeAssetVersionSnapshot): Promise<boolean>;
}

/**
 * Adopt-existing-mint (ChainAdapter.getMintedKnowledgeAssetProvenance):
 * verify chain truth for an already-minted kaId and recover the mint tx's
 * provenance from the KnowledgeAssetCreated log. See chain-adapter.ts for
 * the contract. Verification failures throw typed errors; an unrecoverable
 * log (pruned RPC) returns null so the caller rethrows its original error.
 */
export async function getEvmMintedKnowledgeAssetProvenance(
  ports: EvmExistingMintPorts,
  kaId: bigint,
  expectedMerkleRoot: Uint8Array,
  expectedContextGraphId: bigint,
): Promise<AdoptedMintPublishResult | null> {
  const storage = ports.storage;
  const binding = ports.storageBinding;
  if (!storage || !binding.isCurrent()) return null;
  const expectedHex = ethers.hexlify(expectedMerkleRoot).toLowerCase();

  // 1. Chain root must be EXACTLY the locally sealed root, and exactly one
  //    version (a superseded mint must go through named recovery — adopting
  //    index 0 would later stamp vmCurrentAssertion to a stale version).
  const roots: Array<{ publisher: string; merkleRoot: string; timestamp: bigint }> =
    await ports.readRoots(storage, kaId);
  if (!binding.isCurrent()) return null;
  if (!roots || roots.length === 0) {
    throw new AdoptExistingMintRefusalError(
      'KA_ID_COLLISION',
      `adopt-existing-mint: kaId ${kaId} reported minted but has no on-chain merkle roots`,
    );
  }
  if (ethers.hexlify(roots[0].merkleRoot).toLowerCase() !== expectedHex) {
    throw new AdoptExistingMintRefusalError(
      'KA_ID_COLLISION',
      `adopt-existing-mint: kaId ${kaId} on-chain root ${ethers.hexlify(roots[0].merkleRoot)} `
        + `does not match locally sealed root ${expectedHex} — refusing to adopt someone else's content`,
    );
  }
  if (roots.length > 1) {
    throw new AdoptExistingMintRefusalError(
      'KA_SUPERSEDED',
      `adopt-existing-mint: kaId ${kaId} has ${roots.length} merkle roots (updated since mint); use named recovery`,
    );
  }

  // 2. CG binding: the minted KA must belong to the CG this publish targets.
  {
    const boundCg = await ports.readContextGraphId(kaId);
    if (!binding.isCurrent()) return null;
    if (boundCg === null) return null;
    if (boundCg !== expectedContextGraphId) {
      throw new AdoptExistingMintRefusalError(
        'KA_CG_MISMATCH',
        `adopt-existing-mint: kaId ${kaId} bound to CG ${boundCg}, expected ${expectedContextGraphId}`,
      );
    }
  }

  const observation = await readExistingMintObservation(ports, storage, kaId, Number(roots[0].timestamp));
  if (observation === null || !binding.isCurrent()) return null;
  const { receipt, publish, eventRoot } = observation;
  // Content refusals are deliberately outside the best-effort read boundary.
  if (receipt.kaId !== kaId || receipt.startKAId !== kaId || receipt.endKAId !== kaId
    || ethers.hexlify(receipt.merkleRoot).toLowerCase() !== expectedHex) {
    throw new AdoptExistingMintRefusalError('KA_ID_COLLISION',
      `adopt-existing-mint: kaId ${kaId} receipt does not match the sealed mint`);
  }
  if (eventRoot !== expectedHex) {
    throw new AdoptExistingMintRefusalError('KA_ID_COLLISION',
      `adopt-existing-mint: kaId ${kaId} mint-event root does not match sealed root`);
  }
  // Receipt recovery may await archive RPCs for a long time. The early roots
  // read cannot authorize writing v1 after a concurrent update: refresh the
  // coherent finalized version, then validate its current physical lease.
  let current: KnowledgeAssetVersionSnapshot | null;
  try { current = await ports.readCurrentVersion(kaId); } catch { return null; }
  if (!current || !binding.isCurrent()
    || current.knowledgeAssetStorageAddress?.toLowerCase() !== binding.address
    || current.knowledgeAssetStorageGeneration !== binding.generation
    || current.knowledgeAssetId !== kaId
    || !Number.isSafeInteger(current.blockNumber) || current.blockNumber < receipt.blockNumber
    || typeof current.rootCount !== 'bigint' || current.rootCount < 1n) return null;
  if (current.rootCount > 1n) {
    throw new AdoptExistingMintRefusalError('KA_SUPERSEDED',
      `adopt-existing-mint: kaId ${kaId} was updated while recovering the mint; use named recovery`);
  }
  if (current.latestRoot.toLowerCase() !== expectedHex) {
    throw new AdoptExistingMintRefusalError('KA_ID_COLLISION',
      `adopt-existing-mint: kaId ${kaId} current root does not match sealed root`);
  }
  if (current.latestPublisher.toLowerCase() !== roots[0].publisher.toLowerCase()
    || (receipt.authorAddress !== undefined
      && current.latestAuthor.toLowerCase() !== receipt.authorAddress.toLowerCase())) return null;
  try { if (!await ports.versionIsCurrent(kaId, current) || !binding.isCurrent()) return null; } catch { return null; }
  // Retain the receipt parser's provenance. These three overrides come from
  // the verified storage/seal state rather than a second event decoder.
  const adopted = projectAdoptedMintPublishResult(publish, receipt);
  if (!adopted) return null;
  return { ...adopted, merkleRoot: expectedMerkleRoot,
    blockTimestamp: Number(roots[0].timestamp), publisherAddress: roots[0].publisher };
}


/** Pruned/unavailable RPC evidence leaves adoption unavailable; no refusals are thrown here. */
async function readExistingMintObservation(ports: EvmExistingMintPorts, storage: Contract, kaId: bigint, mintTs: number): Promise<{
  receipt: CanonicalFinalizationReceipt; publish: OnChainPublishResult; eventRoot: string;
} | null> {
  try {
    // Storage records block.timestamp verbatim: locate the mint within a
    // bounded padded window, including adjacent blocks sharing a timestamp.
    const { fromBlock, head, scanProviders } = await ports.resolveDeployBlock(String(storage.target));
    let lo = fromBlock;
    let hi = head;
    while (lo < hi) {
      const mid = lo + Math.floor((hi - lo) / 2);
      const ts = await ports.readBlockTimestamp(mid);
      if (ts >= mintTs) hi = mid; else lo = mid + 1;
    }
    const padding = 128;
    const logs = await ports.readCreationLogs(storage, kaId,
      Math.max(fromBlock, lo - padding), Math.min(head, lo + padding), scanProviders);
    if (logs.length === 0) return null;
    const found = logs[0];
    const args = 'args' in found && (found as ethers.EventLog).args
      ? (found as ethers.EventLog).args : storage.interface.parseLog(found)?.args;
    if (!args || BigInt(args.id) !== kaId) return null;
    const canonical = await ports.resolveCanonicalPublish(found.transactionHash, {
      expectedBlockNumber: found.blockNumber, expectedBlockHash: found.blockHash,
    });
    if (canonical.status !== 'confirmed') return null;
    // Matching the recovered log is necessary, but only the live receipt
    // gate proves the configured confirmation depth and hash at that height.
    if (!await ports.isReceiptFinalAndCanonical(canonical.receipt)) return null;
    return { receipt: canonical.receipt, publish: canonical.publish,
      eventRoot: ethers.hexlify(args.merkleRoot).toLowerCase() };
  } catch {
    return null;
  }
}
