// SPDX-License-Identifier: Apache-2.0
import type { CanonicalFinalizationReceipt, OnChainPublishResult } from './chain-adapter.js';

/** Verified identity and ordering from the canonical receipt, plus the parsed publish costs. */
export type AdoptedMintPublishResult = CanonicalFinalizationReceipt
  & Omit<OnChainPublishResult, keyof CanonicalFinalizationReceipt> & { tokenAmount: bigint };

/** Required receipt facts win over permissive legacy publish fields. */
export function projectAdoptedMintPublishResult(
  publish: OnChainPublishResult, receipt: CanonicalFinalizationReceipt,
): AdoptedMintPublishResult | null {
  // A current quote or mutable storage balance cannot certify the mint's cost.
  if (typeof publish.tokenAmount !== 'bigint' || publish.tokenAmount < 0n) return null;
  return { ...publish, ...receipt, tokenAmount: publish.tokenAmount };
}

export interface ExistingMintProvenanceReader {
  /**
   * Adopt-existing-mint support: for a kaId the contract reports as already
   * minted, verify chain truth (single merkle root == expectedMerkleRoot,
   * KA bound to expectedContextGraphId) and recover the mint transaction's
   * provenance from the `KnowledgeAssetCreated` event log. Returns a
   * verified canonical receipt with the original mint's parsed cost fields,
   * or `null` when the evidence is unavailable: a read that does not yet
   * show the root or graph binding, or a log or original token amount that
   * cannot be recovered (pruned / non-archive RPCs) — callers must then
   * rethrow their original error, never synthesize a txHash
   * (finalization-handler invariant).
   * Throws AdoptExistingMintRefusalError (KA_ID_COLLISION / KA_SUPERSEDED /
   * KA_CG_MISMATCH) when chain truth contradicts the caller's content.
   */
  getMintedKnowledgeAssetProvenance?(
    kaId: bigint,
    expectedMerkleRoot: Uint8Array,
    expectedContextGraphId: bigint,
  ): Promise<AdoptedMintPublishResult | null>;

}
