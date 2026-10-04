export interface OnChainPublishResult {
  batchId: bigint;
  /** Greenfield: equals `batchId` when tokenId == kaId. */
  kaId?: bigint;
  /** Merkle root emitted by the exact publish transaction being resolved. */
  merkleRoot?: Uint8Array;
  /** `DKGKnowledgeAssets` contract address used in the UAL path segment. */
  knowledgeAssetsContract?: string;
  /** Absent for updates (no new KAs minted). */
  startKAId?: bigint;
  /** Absent for updates (no new KAs minted). */
  endKAId?: bigint;
  txHash: string;
  blockNumber: number;
  /**
   * Transaction index within the block. Required as the tiebreaker in the
   * GH#842 last-writer-wins guard so a publish and a same-block update don't
   * compare equal (which would let a late stale publish-promotion clobber the
   * already-applied update). Optional for back-compat with adapters that
   * don't yet populate it. Best-effort callers may fall back to `0`; recovery
   * paths that persist trusted provenance MUST defer or independently resolve
   * the receipt index rather than inventing ordering evidence.
   */
  txIndex?: number;
  blockTimestamp: number;
  publisherAddress: string;
  /**
   * Chain-confirmed author identity for this publish. Sourced from the
   * `KnowledgeAssetCreated` event's indexed `author` topic, which the
   * V10.1 contract sets to the address recovered (or wallet address
   * verified via EIP-1271) from the EIP-712 author attestation. Absent /
   * `undefined` for legacy V9-ish publishes that go through
   * `KnowledgeCollection.sol` (no attestation), and for adapter paths
   * that don't read the event (callers SHOULD then fall back to
   * `KnowledgeCollectionStorage.getLatestMerkleRootAuthor(batchId)` for
   * the canonical chain truth).
   */
  authorAddress?: string;
  gasUsed?: bigint;
  effectiveGasPrice?: bigint;
  gasCostWei?: bigint;
  tokenAmount?: bigint;
  /**
   * B8 — present only when this publish drew on a Publishing Conviction
   * Account (the `CostCovered` event was emitted). The cost fields are bigint
   * (serialized as decimal strings via the daemon's bigint→string JSON replacer);
   * `epoch` is a small int (number). The UI derives the discount bps from
   * `baseCost`/`discountedCost`. Absent for a normal (non-PCA) publish → the
   * confirmed-discount badge degrades hidden.
   */
  convictionCostCovered?: {
    accountId: bigint;
    epoch: number;
    baseCost: bigint;
    discountedCost: bigint;
    drawnFromEpoch: bigint;
    drawnFromTopUp: bigint;
  };
}

