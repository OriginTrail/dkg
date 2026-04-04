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
  /** Absent for updates (no new KAs minted). */
  startKAId?: bigint;
  /** Absent for updates (no new KAs minted). */
  endKAId?: bigint;
  txHash: string;
  blockNumber: number;
  blockTimestamp: number;
  publisherAddress: string;
  gasUsed?: bigint;
  effectiveGasPrice?: bigint;
  gasCostWei?: bigint;
  tokenAmount?: bigint;
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
  /** Set by createParanet when V9 registry is used (on-chain paranetId as hex). */
  paranetId?: string;
}

export interface KAUpdateVerification {
  verified: boolean;
  /** The merkle root stored on-chain for this batch (from KnowledgeBatchUpdated event). */
  onChainMerkleRoot?: Uint8Array;
  /** The block number of the on-chain update transaction. */
  blockNumber?: number;
  /** The transaction index within the block (for deterministic same-block ordering). */
  txIndex?: number;
}

export interface ChainEvent {
  type: string;
  blockNumber: number;
  data: Record<string, unknown>;
}

export interface EventFilter {
  eventTypes: string[];
  fromBlock?: number;
  /** Upper block bound (inclusive). Limits scan range to prevent expensive queries. */
  toBlock?: number;
}

export interface CreateParanetParams {
  /**
   * Human-readable paranet name. The on-chain paranetId is derived as
   * keccak256(bytes(name)) — only the hash goes to the chain. The cleartext
   * name is never stored on-chain unless revealOnChain is true.
   */
  name?: string;
  description?: string;
  /** 0 = open, 1 = permissioned (V9). */
  accessPolicy?: number;
  /** If true, immediately reveal name+description on-chain after creation. Default: false. */
  revealOnChain?: boolean;
  /** Legacy/mock: explicit id when not using chain registry. */
  paranetId?: string;
  metadata?: Record<string, string>;
}

/** One paranet entry from chain (e.g. ParanetCreated events). */
export interface ParanetOnChain {
  /** bytes32 hex — keccak256(bytes(name)). */
  paranetId: string;
  creator: string;
  accessPolicy: number;
  blockNumber: number;
  metadataRevealed: boolean;
  /** Only set if metadata was revealed on-chain. */
  name?: string;
  /** Only set if metadata was revealed on-chain. */
  description?: string;
}

// ----- FairSwap types -----

export interface FairSwapPurchaseInfo {
  purchaseId: bigint;
  buyer: string;
  seller: string;
  kcId: bigint;
  kaId: bigint;
  price: bigint;
  state: number; // 0=None, 1=Initiated, 2=Fulfilled, 3=KeyRevealed, 4=Completed, 5=Disputed, 6=Refunded, 7=Expired
}

// ----- Context Graph types -----

export interface CreateContextGraphParams {
  participantIdentityIds: bigint[];
  requiredSignatures: number;
  metadataBatchId?: bigint;
}

export interface CreateContextGraphResult extends TxResult {
  contextGraphId: bigint;
}

export interface AddBatchToContextGraphParams {
  contextGraphId: bigint;
  batchId: bigint;
  merkleRoot?: Uint8Array;
  signerSignatures: Array<{ identityId: bigint; r: Uint8Array; vs: Uint8Array }>;
}

export interface PublishToContextGraphParams extends PublishParams {
  contextGraphId: bigint;
  participantSignatures: Array<{ identityId: bigint; r: Uint8Array; vs: Uint8Array }>;
}

// ----- Permanent Publishing types -----

export interface PermanentPublishParams {
  kaCount: number;
  publisherNodeIdentityId: bigint;
  merkleRoot: Uint8Array;
  publicByteSize: bigint;
  tokenAmount: bigint;
  publisherSignature: { r: Uint8Array; vs: Uint8Array };
  receiverSignatures: Array<{ identityId: bigint; r: Uint8Array; vs: Uint8Array }>;
}

// ----- Publishing Conviction Account types -----

export interface ConvictionAccountInfo {
  accountId: bigint;
  admin: string;
  balance: bigint;
  initialDeposit: bigint;
  lockEpochs: number;
  conviction: bigint;
  discountBps: number;
}

// ----- V10 publish types -----

export interface V10PublishParams {
  publishOperationId: string;
  contextGraphId: bigint;
  merkleRoot: Uint8Array;
  knowledgeAssetsAmount: number;
  byteSize: bigint;
  epochs: number;
  tokenAmount: bigint;
  isImmutable: boolean;
  paymaster: string;
  convictionAccountId: bigint;
  publisherNodeIdentityId: bigint;
  publisherSignature: { r: Uint8Array; vs: Uint8Array };
  ackSignatures: Array<{ identityId: bigint; r: Uint8Array; vs: Uint8Array }>;
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

  /**
   * Verify that a KnowledgeBatchUpdated event exists for the given batchId and txHash,
   * and that the publisher address matches the original batch publisher.
   * Returns chain-verified merkle root and block number so the caller can bind
   * the gossip payload to on-chain state (instead of trusting gossip-supplied values).
   */
  verifyKAUpdate?(txHash: string, batchId: bigint, publisherAddress: string): Promise<KAUpdateVerification>;

  // V9 storage extension
  extendStorage(params: ExtendStorageParams): Promise<TxResult>;

  // V9 namespace transfer
  transferNamespace(newOwner: string): Promise<TxResult>;

  /**
   * Verify that a publisher address owns the UAL range [startKAId, endKAId] on-chain.
   * Used by receiving nodes to reject PublishRequests with spoofed publisher/range.
   */
  verifyPublisherOwnsRange?(publisherAddress: string, startKAId: bigint, endKAId: bigint): Promise<boolean>;

  // Block height (used by ChainEventPoller to seed the scan cursor)
  getBlockNumber?(): Promise<number>;

  // Events
  listenForEvents(filter: EventFilter): AsyncIterable<ChainEvent>;

  // Paranets
  createParanet(params: CreateParanetParams): Promise<TxResult>;
  submitToParanet(kcId: string, paranetId: string): Promise<TxResult>;
  /** Reveal cleartext name+description on-chain for a paranet you created. Optional. */
  revealParanetMetadata?(paranetId: string, name: string, description: string): Promise<TxResult>;
  /** List paranets from chain (V9 registry ParanetCreated events). Optional; not supported on no-chain/mock. */
  listParanetsFromChain?(fromBlock?: number): Promise<ParanetOnChain[]>;

  // Publishing Conviction Accounts
  createConvictionAccount?(amount: bigint, lockEpochs: number): Promise<{ accountId: bigint } & TxResult>;
  addConvictionFunds?(accountId: bigint, amount: bigint): Promise<TxResult>;
  extendConvictionLock?(accountId: bigint, additionalEpochs: number): Promise<TxResult>;
  getConvictionDiscount?(accountId: bigint): Promise<{ discountBps: number; conviction: bigint }>;
  getConvictionAccountInfo?(accountId: bigint): Promise<ConvictionAccountInfo | null>;

  // FairSwap (Private Knowledge Exchange)
  initiatePurchase?(seller: string, kcId: bigint, kaId: bigint, price: bigint): Promise<{ purchaseId: bigint } & TxResult>;
  fulfillPurchase?(purchaseId: bigint, encryptedDataRoot: Uint8Array, keyCommitment: Uint8Array): Promise<TxResult>;
  revealKey?(purchaseId: bigint, key: Uint8Array): Promise<TxResult>;
  disputeDelivery?(purchaseId: bigint, proof: Uint8Array): Promise<TxResult>;
  claimPayment?(purchaseId: bigint): Promise<TxResult>;
  claimRefund?(purchaseId: bigint): Promise<TxResult>;
  getFairSwapPurchase?(purchaseId: bigint): Promise<FairSwapPurchaseInfo | null>;

  // Permanent Publishing
  publishKnowledgeAssetsPermanent?(params: PermanentPublishParams): Promise<OnChainPublishResult>;

  // Staking Conviction
  stakeWithLock?(identityId: bigint, amount: bigint, lockEpochs: number): Promise<TxResult>;
  getDelegatorConvictionMultiplier?(identityId: bigint, delegator: string): Promise<{ multiplier: number }>;

  /**
   * Sign an arbitrary message hash using the node's primary operational key.
   * Used for self-signing as receiver or context graph participant.
   */
  signMessage?(messageHash: Uint8Array): Promise<{ r: Uint8Array; vs: Uint8Array }>;

  // Context Graphs
  createContextGraph?(params: CreateContextGraphParams): Promise<CreateContextGraphResult>;
  addBatchToContextGraph?(params: AddBatchToContextGraphParams): Promise<TxResult>;
  publishToContextGraph?(params: PublishToContextGraphParams): Promise<OnChainPublishResult>;

  // V10 publish (KnowledgeAssetsV10 contract — writes to KnowledgeCollectionStorage)
  createKnowledgeAssetsV10?(params: V10PublishParams): Promise<OnChainPublishResult>;

  /** Read minimumRequiredSignatures from ParametersStorage. Used by ACKCollector. */
  getMinimumRequiredSignatures?(): Promise<number>;

  // V8 backward compatibility (used by mock adapter, will be removed)
  createKnowledgeCollection?(params: CreateKCParams): Promise<TxResult>;
  updateKnowledgeCollection?(params: UpdateKCParams): Promise<TxResult>;
}
