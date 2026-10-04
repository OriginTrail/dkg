import type { OnChainPublishResult } from './chain-adapter.js';

export interface ExistingMintProvenanceReader {
  /**
   * Adopt-existing-mint support: for a kaId the contract reports as already
   * minted, verify chain truth (single merkle root == expectedMerkleRoot,
   * KA bound to expectedContextGraphId) and recover the mint transaction's
   * provenance from the `KnowledgeAssetCreated` event log. Returns a
   * synthesized OnChainPublishResult equivalent to what the original mint
   * receipt would have produced, or `null` when the log cannot be recovered
   * (pruned / non-archive RPCs) — callers must then rethrow their original
   * error, never synthesize a txHash (finalization-handler invariant).
   * Throws AdoptExistingMintRefusalError (KA_ID_COLLISION / KA_SUPERSEDED /
   * KA_CG_MISMATCH) when chain truth contradicts the caller's content.
   */
  getMintedKnowledgeAssetProvenance?(
    kaId: bigint,
    expectedMerkleRoot: Uint8Array,
    expectedContextGraphId: bigint,
  ): Promise<OnChainPublishResult | null>;

}
