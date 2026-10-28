// SPDX-License-Identifier: Apache-2.0
import { ethers } from 'ethers';
import type { TripleStore } from '@origintrail-official/dkg-storage';
import type { OnChainPublishResult } from '@origintrail-official/dkg-chain';
import { readConfirmedGraphKnowledgeAssetMetadataEnvelope, type ConfirmedGraphKnowledgeAssetMetadataEnvelope } from './metadata.js';
import { MintAdoptionRefusedError } from './adopt-existing-mint.js';

/**
 * Whether an adopted mint is already recorded locally. The run that minted it
 * may have recorded it before failing, or the node's chain reconcile may have
 * materialized it. Either record must describe exactly the sealed content and
 * this transaction; then the publish keeps it instead of adding a second set
 * of rows. Anything else refuses before the publish writes.
 */
export async function adoptedMintAlreadyRecorded(
  store: TripleStore,
  expected: { contextGraphId: string; ual: string } & Omit<ConfirmedGraphKnowledgeAssetMetadataEnvelope, 'transactionHash' | 'subGraphName' | 'batchId'>,
  mint: OnChainPublishResult,
): Promise<boolean> {
  const existing = await readConfirmedGraphKnowledgeAssetMetadataEnvelope(store, expected);
  if (existing.state === 'absent') return false;
  const recorded = existing.state === 'confirmed' ? existing.envelope : undefined;
  const hex = (bytes?: Uint8Array) => (bytes ? ethers.hexlify(bytes) : undefined);
  if (
    recorded
    && recorded.assertionVersion === expected.assertionVersion
    && recorded.assertionGraph === expected.assertionGraph
    && recorded.publicTripleCount === expected.publicTripleCount
    && recorded.privateTripleCount === expected.privateTripleCount
    && hex(recorded.privateMerkleRoot) === hex(expected.privateMerkleRoot)
    && hex(recorded.merkleRoot) === hex(expected.merkleRoot)
    && recorded.batchId === (mint.kaId ?? mint.batchId)
    && (recorded.transactionHash === undefined || recorded.transactionHash.toLowerCase() === mint.txHash.toLowerCase())
  ) {
    return true;
  }
  throw new MintAdoptionRefusedError('existing-record-conflict', mint.kaId ?? mint.batchId,
    `the local record of ${expected.ual} is ${existing.state === 'invalid' ? 'unreadable' : 'for other content or another transaction'}`);
}

