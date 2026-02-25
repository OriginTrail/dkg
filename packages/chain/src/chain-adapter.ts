export interface IdentityProof {
  publicKey: Uint8Array;
  signature: Uint8Array;
}

export interface ReservedRange {
  startId: bigint;
  endId: bigint;
}

export interface BatchMintParams {
  publisherNodeIdentityId: bigint;
  merkleRoot: Uint8Array;
  startKAId: bigint;
  endKAId: bigint;
  publicByteSize: bigint;
  epochs: number;
  tokenAmount: bigint;
  publisherSignature: { r: Uint8Array; vs: Uint8Array };
  receiverSignatures: Array<{ identityId: bigint; r: Uint8Array; vs: Uint8Array }>;
}

export interface BatchMintResult extends TxResult {
  batchId: bigint;
}

export interface PublishParams {
  kaCount: number;
  publisherNodeIdentityId: bigint;
  merkleRoot: Uint8Array;
  publicByteSize: bigint;
  epochs: number;
  tokenAmount: bigint;
  publisherSignature: { r: Uint8Array; vs: Uint8Array };
  receiverSignatures: Array<{ identityId: bigint; r: Uint8Array; vs: Uint8Array }>;
}

export interface OnChainPublishResult {
  batchId: bigint;
  startKAId: bigint;
  endKAId: bigint;
  txHash: string;
  blockNumber: number;
  blockTimestamp: number;
  publisherAddress: string;
}

export interface UpdateKAParams {
  batchId: bigint;
  newMerkleRoot: Uint8Array;
  newPublicByteSize: bigint;
}

export interface ExtendStorageParams {
  batchId: bigint;
  additionalEpochs: number;
  tokenAmount: bigint;
}

export interface TxResult {
  hash: string;
  blockNumber: number;
  success: boolean;
}

export interface ChainEvent {
  type: string;
  blockNumber: number;
  data: Record<string, unknown>;
}

export interface EventFilter {
  eventTypes: string[];
  fromBlock?: number;
}

export interface CreateParanetParams {
  paranetId: string;
  metadata: Record<string, string>;
}

// ----- V8 backward-compat types (used by mock adapter and legacy code) -----

export interface CreateKCParams {
  merkleRoot: Uint8Array;
  knowledgeAssetsCount: number;
  signatures: Array<{ identityId: bigint; r: Uint8Array; vs: Uint8Array }>;
}

export interface UpdateKCParams {
  kcId: bigint;
  newMerkleRoot: Uint8Array;
  signatures: Array<{ identityId: bigint; r: Uint8Array; vs: Uint8Array }>;
}

/**
 * Chain-agnostic adapter interface for interacting with the DKG Trust Layer.
 *
 * V9 introduces publisher-namespaced UALs: did:dkg:{chainId}/{publisherAddress}/{localKAId}
 * Publishers reserve ID ranges via their signer address, then batch-mint KAs from those ranges.
 */
export interface ChainAdapter {
  chainType: 'evm' | 'solana';
  chainId: string;

  // Identity
  registerIdentity(proof: IdentityProof): Promise<bigint>;
  getIdentityId(): Promise<bigint>;
  ensureProfile(options?: { nodeName?: string; stakeAmount?: bigint }): Promise<bigint>;

  // V9 UAL reservation (publisher address is derived from signer)
  reserveUALRange(count: number): Promise<ReservedRange>;

  // V9 batch minting
  batchMintKnowledgeAssets(params: BatchMintParams): Promise<BatchMintResult>;

  // V9 single-tx publish (reserve + mint in one call)
  publishKnowledgeAssets(params: PublishParams): Promise<OnChainPublishResult>;

  /**
   * Required TRAC amount for publishing (from stake-weighted ask and byte size).
   * Used so the publisher can approve and send the correct token amount.
   */
  getRequiredPublishTokenAmount?(publicByteSize: bigint, epochs: number): Promise<bigint>;

  // V9 knowledge updates
  updateKnowledgeAssets(params: UpdateKAParams): Promise<TxResult>;

  // V9 storage extension
  extendStorage(params: ExtendStorageParams): Promise<TxResult>;

  // V9 namespace transfer
  transferNamespace(newOwner: string): Promise<TxResult>;

  /**
   * Verify that a publisher address owns the UAL range [startKAId, endKAId] on-chain.
   * Used by receiving nodes to reject PublishRequests with spoofed publisher/range.
   */
  verifyPublisherOwnsRange?(publisherAddress: string, startKAId: bigint, endKAId: bigint): Promise<boolean>;

  // Events
  listenForEvents(filter: EventFilter): AsyncIterable<ChainEvent>;

  // Paranets
  createParanet(params: CreateParanetParams): Promise<TxResult>;
  submitToParanet(kcId: string, paranetId: string): Promise<TxResult>;

  // V8 backward compatibility (used by mock adapter, will be removed)
  createKnowledgeCollection?(params: CreateKCParams): Promise<TxResult>;
  updateKnowledgeCollection?(params: UpdateKCParams): Promise<TxResult>;
}
