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
  publisherAddress?: string;
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
  /** Set by createContextGraph when V9 registry is used (on-chain contextGraphId as hex). */
  contextGraphId?: string;
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

export interface CreateContextGraphParams {
  /**
   * Human-readable context graph name. The on-chain contextGraphId is derived as
   * keccak256(bytes(name)) — only the hash goes to the chain. The cleartext
   * name is never stored on-chain unless revealOnChain is true.
   */
  name?: string;
  description?: string;
  /** 0 = open, 1 = permissioned. */
  accessPolicy?: number;
  /** If true, immediately reveal name+description on-chain after creation. Default: false. */
  revealOnChain?: boolean;
  /** Legacy/mock: explicit id when not using chain registry. */
  contextGraphId?: string;
  metadata?: Record<string, string>;
}

/** One context graph entry from chain (from `NameClaimed` events of ContextGraphNameRegistry). */
export interface ContextGraphOnChain {
  /** bytes32 hex — keccak256(bytes(name)). */
  contextGraphId: string;
  creator: string;
  accessPolicy: number;
  blockNumber: number;
  metadataRevealed: boolean;
  /** Only set if metadata was revealed on-chain. */
  name?: string;
  /** Only set if metadata was revealed on-chain. */
  description?: string;
}

// ----- On-Chain Context Graph types (ContextGraphs contract) -----

export interface CreateOnChainContextGraphParams {
  participantIdentityIds: bigint[];
  participantAgents?: string[];
  requiredSignatures: number;
  metadataBatchId?: bigint;
  publishPolicy?: number;
  publishAuthority?: string;
  publishAuthorityAccountId?: bigint;
}

export interface CreateOnChainContextGraphResult extends Omit<TxResult, 'contextGraphId'> {
  contextGraphId: bigint;
}

export interface VerifyParams {
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

export interface V10PublishDirectParams {
  publishOperationId: string;
  contextGraphId: bigint;
  merkleRoot: Uint8Array;
  knowledgeAssetsAmount: number;
  byteSize: bigint;
  epochs: number;
  tokenAmount: bigint;
  isImmutable: boolean;
  /**
   * Paymaster address. `ethers.ZeroAddress` means the caller pays TRAC
   * directly. Non-zero means the paymaster covers the cost. The adapter
   * splits this field out of the struct and passes it as the second
   * argument to `KnowledgeAssetsV10.publishDirect(PublishParams, paymaster)`.
   */
  paymaster: string;
  publisherNodeIdentityId: bigint;
  publisherSignature: { r: Uint8Array; vs: Uint8Array };
  ackSignatures: Array<{ identityId: bigint; r: Uint8Array; vs: Uint8Array }>;
  /**
   * Write-ahead hook invoked by the adapter *immediately before the
   * concrete publish tx is broadcast* — i.e. after `approve()` and any
   * allowance top-up, after gas estimation / populate / signing have
   * succeeded, and right before `eth_sendRawTransaction` hits the wire.
   * This is the cue phase listeners must use to persist WAL / recovery
   * state: any error before this fires means no publish tx ever existed.
   *
   * The optional `info.txHash` argument carries the signed transaction
   * hash so WAL consumers can log a specific (pre-broadcast) tx
   * identity — critical for P-1 crash recovery. Adapters that can
   * compute the hash (real EVM) SHOULD pass it; mocks MAY pass a
   * synthetic hash that is still stable within a single test run.
   *
   * **Fail-closed contract**: if the hook throws, the adapter MUST
   * NOT broadcast. The signed tx is still local to the adapter's
   * stack frame at that point, so surfacing the error leaves no
   * on-chain side effect and lets the caller retry cleanly.
   *
   * Optional; legacy callers that don't need a precise WAL boundary
   * can omit it. Adapters SHOULD invoke it exactly once per successful
   * broadcast; adapters that cannot provide tx-broadcast granularity
   * (e.g. `NoChainAdapter`) SHOULD NOT invoke it at all.
   *
   * See P-1 / P-1.2 in
   * in `packages/publisher/src/dkg-publisher.ts`.
   *
   * Return type is `Promise<void> | void` so async WAL writes
   * (disk flush, remote gossip) can run to completion before the
   * adapter proceeds to `eth_sendRawTransaction`. Adapters MUST
   * `await` the hook — `() => void` alone does not force synchronous
   * callers in TypeScript, so an `async () => ...` hook passed in
   * here would otherwise race the broadcast.
   */
  onBroadcast?: (info: { txHash: string }) => Promise<void> | void;
}

export interface V10UpdateKCParams {
  kcId: bigint;
  newMerkleRoot: Uint8Array;
  newByteSize: bigint;
  newTokenAmount?: bigint;
  mintAmount?: number;
  burnTokenIds?: bigint[];
  /** When true, the caller asserts the KC was created via V10. Skips probing. */
  v10Origin?: boolean;
  publisherAddress?: string;
  updateOperationId?: string;
  publisherNodeIdentityId?: bigint;
  publisherSignature?: { r: Uint8Array; vs: Uint8Array };
  ackSignatures?: Array<{ identityId: bigint; r: Uint8Array; vs: Uint8Array }>;
  /**
   * Write-ahead hook fired just before the concrete update tx is
   * broadcast, carrying the signed tx hash. See
   * {@link V10PublishDirectParams.onBroadcast} for full semantics
   * (fail-closed contract, exactly-once, Promise return, etc.).
   */
  onBroadcast?: (info: { txHash: string }) => Promise<void> | void;
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
   * Recover a publish transaction by txHash and reconstruct its on-chain publish result.
   * Returns null when the tx is absent, pending, failed, or not a recognized publish tx.
   */
  resolvePublishByTxHash?(txHash: string): Promise<OnChainPublishResult | null>;

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

  // Context Graphs (name-hash commitment via ContextGraphNameRegistry)
  createContextGraph(params: CreateContextGraphParams): Promise<TxResult>;
  submitToContextGraph(kcId: string, contextGraphId: string): Promise<TxResult>;
  /** Reveal cleartext name+description on-chain for a context graph you created. Optional. */
  revealContextGraphMetadata?(contextGraphId: string, name: string, description: string): Promise<TxResult>;
  /** List context graphs from chain via `NameClaimed` events. Optional; not supported on no-chain/mock. */
  listContextGraphsFromChain?(fromBlock?: number): Promise<ContextGraphOnChain[]>;

  // Publishing Conviction Accounts
  createConvictionAccount?(amount: bigint, lockEpochs: number): Promise<{ accountId: bigint } & TxResult>;
  addConvictionFunds?(accountId: bigint, amount: bigint): Promise<TxResult>;
  extendConvictionLock?(accountId: bigint, additionalEpochs: number): Promise<TxResult>;
  getConvictionDiscount?(accountId: bigint): Promise<{ discountBps: number; conviction: bigint }>;
  getConvictionAccountInfo?(accountId: bigint): Promise<ConvictionAccountInfo | null>;

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

  // On-Chain Context Graphs (ContextGraphs contract)
  createOnChainContextGraph?(params: CreateOnChainContextGraphParams): Promise<CreateOnChainContextGraphResult>;
  getContextGraphParticipants?(contextGraphId: bigint): Promise<bigint[] | null>;
  verify?(params: VerifyParams): Promise<TxResult>;
  publishToContextGraph?(params: PublishToContextGraphParams): Promise<OnChainPublishResult>;

  /**
   * V10 publish (KnowledgeAssetsV10 contract — writes to
   * KnowledgeCollectionStorage). Required on every adapter that claims
   * V10 capability; paired with `getKnowledgeAssetsV10Address()` and
   * `getEvmChainId()` below so authors of out-of-tree adapters get a
   * compile-time failure instead of a runtime regression when they
   * implement the tx submission but forget the digest-prefix getters.
   */
  createKnowledgeAssetsV10(params: V10PublishDirectParams): Promise<OnChainPublishResult>;

  /** Read minimumRequiredSignatures from ParametersStorage. Used by ACKCollector. */
  getMinimumRequiredSignatures?(): Promise<number>;

  /**
   * Read the per-Context-Graph `requiredSignatures` value (M-of-N quorum)
   * from `ContextGraphStorage`. Returns 0 if the CG has no on-chain entry,
   * or `undefined` if the adapter does not implement the lookup.
   *
   * Spec §06_PUBLISH: every publish to a CG must collect at least
   * `requiredSignatures` participant ACKs before it can confirm on chain.
   * This is per-CG governance and supersedes the global ParametersStorage
   * minimum, which is only the network-wide floor.
   */
  getContextGraphRequiredSignatures?(contextGraphId: bigint): Promise<number>;

  /** Verify that a recovered signer address is a registered operational key for the given identity. */
  verifyACKIdentity?(recoveredAddress: string, claimedIdentityId: bigint): Promise<boolean>;

  /**
   * Verify that a recovered signer address owns the claimed identity without
   * requiring the identity to be a staked core node. Used for private CG sync
   * auth where participants may be non-staked identities.
   */
  verifySyncIdentity?(recoveredAddress: string, claimedIdentityId: bigint): Promise<boolean>;

  /**
   * Sign an ACK digest for V10 StorageACK (core nodes only).
   * Returns { r, vs } signature components or undefined if not capable.
   * The private key never leaves the adapter implementation.
   */
  signACKDigest?(digest: Uint8Array): Promise<{ r: Uint8Array; vs: Uint8Array } | undefined>;

  /** @deprecated Use signACKDigest instead. Will be removed in V10.1. */
  getACKSignerKey?(): string | undefined;

  /** V10 update (works with KnowledgeCollectionStorage). */
  updateKnowledgeCollectionV10?(params: V10UpdateKCParams): Promise<TxResult>;

  /**
   * Whether this adapter supports V10 publish paths. Required — this is
   * the authoritative runtime capability gate for V10. Adapters that
   * cannot publish (NoChainAdapter, offline adapters) MUST return false so
   * callers never route into throwing stubs. EVM adapters return true only
   * after `KnowledgeAssetsV10` is actually resolved on-chain.
   *
   * Runtime probes across the repo use `chain.isV10Ready?.()` (falsy =>
   * not V10); making it required tightens the TypeScript side without
   * breaking the defensive runtime optional-call style.
   */
  isV10Ready(): boolean;

  /**
   * Returns the deployed address of `KnowledgeAssetsV10` on this chain.
   * Required — the publisher uses it to build the H5-prefixed publish
   * digests, and any adapter that implements `createKnowledgeAssetsV10`
   * must also implement this so the digest inputs match the on-chain
   * contract that will verify them. Throws if the contract is not deployed.
   */
  getKnowledgeAssetsV10Address(): Promise<string>;

  /**
   * Returns the numeric EVM chain id (e.g. 31337n for hardhat). Distinct
   * from `chainId` above, which is namespaced (`evm:31337`, `mock:31337`)
   * and not directly parseable with `BigInt()`. Required — used by the
   * publisher to build the H5-prefixed publish digests.
   */
  getEvmChainId(): Promise<bigint>;

  // V8 backward compatibility (used by mock adapter, will be removed)
  createKnowledgeCollection?(params: CreateKCParams): Promise<TxResult>;
  updateKnowledgeCollection?(params: UpdateKCParams): Promise<TxResult>;
}

// ----- Backward-compat deprecated aliases -----

/** @deprecated Use VerifyParams instead. */
export type AddBatchToContextGraphParams = VerifyParams;
/** @deprecated Use CreateOnChainContextGraphParams instead. */
export type CreateContextGraphParamsLegacy = CreateOnChainContextGraphParams;
