import type { ethers } from 'ethers';

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
  /**
   * Chain-confirmed author identity for this publish. Sourced from the
   * `KnowledgeCollectionCreated` event's indexed `author` topic, which the
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
}

export interface UpdateKAParams {
  batchId: bigint;
  newMerkleRoot: Uint8Array;
  newPublicByteSize: bigint;
  /** Optional signer hint; adapters may resolve the original publisher on-chain instead. */
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
  /**
   * Effective publisher/signing address used by update-style txs.
   *
   * Required for successful update results that callers will persist as
   * confirmed metadata, unless the adapter also exposes
   * `getLatestMerkleRootPublisher(kcId)` so callers can query the same
   * chain-truth address after the receipt. Publish-style result shapes
   * use `OnChainPublishResult.publisherAddress` instead.
   */
  publisherAddress?: string;
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
  publishPolicy?: number;
  blockNumber: number;
  metadataRevealed: boolean;
  /** Only set if metadata was revealed on-chain. */
  name?: string;
  /** Only set if metadata was revealed on-chain. */
  description?: string;
}

// ----- On-Chain Context Graph types (ContextGraphs contract) -----

/**
 * Per SPEC_CG_MEMORY_MODEL: every CG is hosted by the network's sharding
 * table at publish time and the ACK quorum is the system parameter
 * `parametersStorage.minimumRequiredSignatures()`. CGs do not declare
 * per-CG hosting committees or per-CG quorum.
 *
 * `accessPolicy` and `publishPolicy` are REQUIRED (Codex PR #595
 * round-5): the previous all-optional shape let `{}` silently create a
 * public + open-contribution CG, which is a privilege widening relative
 * to the safe defaults the MCP/UI surfaces use. Callers must state both
 * dials explicitly so migrations from the pre-LU2 signature can't
 * accidentally leak data.
 */
export interface CreateOnChainContextGraphParams {
  /** 0 = public/discoverable, 1 = private/curated. */
  accessPolicy: number;
  /** 0 = curated publishing, 1 = open publishing. */
  publishPolicy: number;
  participantAgents?: string[];
  metadataBatchId?: bigint;
  publishAuthority?: string;
  publishAuthorityAccountId?: bigint;
  /**
   * OT-RFC-38 / LU-6 Phase B — opt-in stable wire identifier the
   * curator commits to at create time. Intended to be
   * `keccak256(bytes(cleartextId))` so the SWM gossip topic, envelope
   * `contextGraphId`, signing payload, and host-mode store key are all
   * chain-derivable AND privacy-preserving (cleartext never leaves
   * the curator's local node). Hosting cores in the sharding table
   * use this to auto-subscribe to the SWM topic on receipt of the
   * `ContextGraphCreated` event — no off-chain discovery channel is
   * required for registered CGs.
   *
   * Omit (or pass `'0x' + '0'.repeat(64)`) to opt out — host-mode
   * discovery for that CG then relies on the gossip-beacon path
   * (Option β) exclusively. We recommend always passing a non-zero
   * hash; the opt-out branch exists only to keep the contract
   * surface forward-compatible.
   */
  nameHash?: string;
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
  /**
   * V10 Merkle leaf count of the published flat-KC payload. Required: the
   * adapter mirrors this V9 publish to V10 (`createKnowledgeAssetsV10`)
   * and `RandomSampling` reads `merkleLeafCount` from on-chain storage to
   * pick / verify `chunkId`. Hard-coding it would corrupt every bridged
   * KC whose tree has more than one leaf. Callers must supply the value
   * from `V10MerkleTree.leafCount`.
   */
  merkleLeafCount: number;
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

// ----- V10 Publishing Conviction NFT types -----

/** Mirrors `DKGPublishingConvictionNFT.getAccountInfo`; adapter returns
 *  null when the NFT is undeployed or the account is missing. */
export interface V10PublishingConvictionAccountInfo {
  owner: string;
  committedTRAC: bigint;
  baseEpochAllowance: bigint;
  createdAtEpoch: number;
  expiresAtEpoch: number;
  createdAtTimestamp: number;
  expiresAtTimestamp: number;
  discountBps: number;
  topUpBuffer: bigint;
  agentCount: number;
  lastSettledWindow: number;
  fullySwept: boolean;
}

// ----- V10 publish types -----

/**
 * Compact `(r, vs)` form of a 65-byte EIP-712 / EIP-191 / EIP-1271
 * signature. `r` is the standard 32-byte secp256k1 r value; `vs` packs
 * `s` in the low 255 bits and `(v - 27)` in the top bit, matching
 * `ECDSA.tryRecover(bytes32, bytes32, bytes32)` in the contract.
 */
export interface CompactSignature {
  r: Uint8Array;
  vs: Uint8Array;
}

/**
 * RFC-001 §3 author attestation. EIP-712 typed-data signature over
 * `AuthorAttestation(uint256 contextGraphId, bytes32 merkleRoot,
 * address authorAddress, uint8 schemeVersion)` with domain
 * `(name="KnowledgeAssetsV10", version="10.1", chainId, verifyingContract)`.
 *
 * - `address`: the author identity. EOA → ECDSA recovery branch.
 *   Smart-contract wallet (incl. EIP-7702-delegated EOAs with
 *   `code.length > 0`) → IERC1271.isValidSignature dispatch.
 * - `signature`: compact `(r, vs)` form.
 * - `schemeVersion`: 1 (only currently-supported scheme; multi-sig /
 *   threshold / passkey-aggregated will bump this in a future RFC).
 */
export interface V10AuthorAttestation {
  address: string;
  signature: CompactSignature;
  schemeVersion: number;
}

export interface V10PublishParams {
  publishOperationId: string;
  contextGraphId: bigint;
  /**
   * Optional signer hint selected by the caller for the publish. Adapters
   * with signer pools MUST use this address for the concrete tx when present
   * (or throw clearly if unavailable/unauthorized), so the off-chain
   * authorship/ACK signatures and on-chain attribution stay bound
   * to the same key.
   */
  publisherAddress?: string;
  merkleRoot: Uint8Array;
  knowledgeAssetsAmount: number;
  byteSize: bigint;
  epochs: number;
  tokenAmount: bigint;
  isImmutable: boolean;
  /** V10 flat-KC Merkle leaf count (sorted + deduped); stored on-chain for RandomSampling. */
  merkleLeafCount: number;
  /**
   * Self-claimed publishing-factor attribution target. RFC-001 §4 — this
   * is now informational only on-chain; no per-publish signature is
   * required from the core node. The contract validates only that the id
   * is a known sharding-table member.
   */
  publisherNodeIdentityId: bigint;
  /** RFC-001 §3 — required EIP-712 author attestation. */
  author: V10AuthorAttestation;
  ackSignatures: Array<{ identityId: bigint; r: Uint8Array; vs: Uint8Array }>;
  /**
   * RFC-39 Phase A.5 — OPTIONAL Merkle root over `[keccak256(ct_i)]` in
   * `swmMessageIndex` order for this batch's ciphertext chunks. Required
   * by the contract to be `bytes32(0)` for public CGs; for curated CGs
   * either zero (legacy/transitional — picker skips this KC in the
   * curated draw) OR paired with a non-zero `ciphertextChunkCount`.
   * Defaults to `bytes32(0)` when omitted.
   */
  ciphertextChunksRoot?: Uint8Array;
  /**
   * RFC-39 Phase A.5 — OPTIONAL number of ciphertext chunks in this
   * batch (== curated leaf count for random sampling). Same zero-or-paired
   * constraints as `ciphertextChunksRoot`. Defaults to `0` when omitted.
   */
  ciphertextChunkCount?: number;
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
   * See P-1 / P-1.2 in BUGS_FOUND.md and the `chain:writeahead` phase
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
  /** V10 flat-KC Merkle leaf count after update (sorted + deduped). */
  newMerkleLeafCount: number;
  newTokenAmount?: bigint;
  mintAmount?: number;
  burnTokenIds?: bigint[];
  /** When true, the caller asserts the KC was created via V10. Skips probing. */
  v10Origin?: boolean;
  publisherAddress?: string;
  updateOperationId?: string;
  publisherNodeIdentityId?: bigint;
  ackSignatures?: Array<{ identityId: bigint; r: Uint8Array; vs: Uint8Array }>;
  /**
   * RFC-39 Phase A.5 — OPTIONAL refreshed Merkle root over the new
   * batch's ciphertext chunks. Same zero-or-paired contract as
   * {@link V10PublishParams.ciphertextChunksRoot}: zero on metadata-only
   * updates and public CGs; both non-zero on curated commitment
   * rotation. Defaults to `bytes32(0)`.
   */
  newCiphertextChunksRoot?: Uint8Array;
  /**
   * RFC-39 Phase A.5 — OPTIONAL refreshed ciphertext chunk count for the
   * new batch. Defaults to `0`. Paired with
   * {@link newCiphertextChunksRoot}.
   */
  newCiphertextChunkCount?: number;
  /**
   * Write-ahead hook fired just before the concrete update tx is
   * broadcast, carrying the signed tx hash. See
   * {@link V10PublishParams.onBroadcast} for full semantics
   * (fail-closed contract, exactly-once, Promise return, etc.).
   */
  onBroadcast?: (info: { txHash: string }) => Promise<void> | void;
}

/**
 * @deprecated Renamed to {@link V10PublishParams} after RFC-001 unified
 * `publish`/`publishDirect` into a single entrypoint. Existing imports
 * will compile but new code should use `V10PublishParams`.
 */
export type V10PublishDirectParams = V10PublishParams;

// ----- Random Sampling (V10 RandomSampling.sol) -----

/**
 * Mirrors the on-chain `RandomSamplingLib.Challenge` struct verbatim.
 * Returned by `getNodeChallenge` and `createChallenge`. Note that
 * `contextGraphId` is intentionally NOT part of this struct on-chain
 * (V8 signature compat) — it travels via the `ChallengeGenerated` event
 * topic, which `createChallenge` decodes from its tx receipt and
 * surfaces alongside the challenge.
 */
export interface NodeChallenge {
  knowledgeCollectionId: bigint;
  chunkId: bigint;
  knowledgeCollectionStorageContract: string;
  epoch: bigint;
  activeProofPeriodStartBlock: bigint;
  proofingPeriodDurationInBlocks: bigint;
  solved: boolean;
}

/** Result of `getActiveProofPeriodStatus()` (V10 RandomSampling.sol). */
export interface ProofPeriodStatus {
  activeProofPeriodStartBlock: bigint;
  /**
   * True when `block.number < activeProofPeriodStartBlock + duration`.
   * False between periods (briefly, since the contract auto-advances on
   * `updateAndGetActiveProofPeriodStartBlock`). Off-chain pollers should
   * treat `false` as "skip this tick, retry on the next block".
   */
  isValid: boolean;
  /**
   * Currently-active proofing period duration in blocks, as the contract
   * computes it for the current epoch (read via
   * `RandomSampling.getActiveProofingPeriodDurationInBlocks()` →
   * `RandomSamplingStorage.getEpochProofingPeriodDurationInBlocks(currentEpoch)`).
   *
   * The chain's `updateAndGetActiveProofPeriodStartBlock()` rolls the
   * cursor forward using THIS value, not the duration baked into a
   * cached `NodeChallenge`. Off-chain wall-clock staleness checks must
   * therefore consult this live value (Codex round 2 on PR #369): if a
   * governance action changes the proofing duration mid-flight, the
   * cached `existing.proofingPeriodDurationInBlocks` no longer reflects
   * the on-chain expiry boundary, and rotating off `existing.duration`
   * alone would re-introduce the same `kc-not-synced` deadlock that
   * the unsolved-stale check exists to prevent.
   *
   * Optional only because legacy adapters that pre-date this field may
   * not populate it; consumers MUST treat `undefined` as "skip the
   * live-duration staleness path and fall back to the cached duration".
   */
  proofingPeriodDurationInBlocks?: bigint;
}

/**
 * Result of `createChallenge`. Carries the freshly-decoded challenge + cgId.
 *
 * `Omit<TxResult, 'contextGraphId'>` because the V9 `TxResult.contextGraphId`
 * is a `string` (legacy ContextGraphNameRegistry hex) — V10 random sampling
 * uses `bigint` ContextGraphs ids, so the field is rebound here. Same
 * pattern as `CreateOnChainContextGraphResult`.
 */
export interface CreateChallengeResult extends Omit<TxResult, 'contextGraphId'> {
  /** Decoded from `RandomSamplingStorage.getNodeChallenge` after the tx. */
  challenge: NodeChallenge;
  /** Decoded from the indexed `ChallengeGenerated(contextGraphId)` event topic. */
  contextGraphId: bigint;
}

/**
 * Thrown by `createChallenge` when `_pickWeightedChallenge` finds no
 * public, active CG holds non-zero per-epoch value at the current epoch.
 * Off-chain prover MUST treat this as "skip this period silently, retry
 * on the next" — it is not a malfunction, it is the documented
 * retry-next-period contract.
 */
export class NoEligibleContextGraphError extends Error {
  readonly name = 'NoEligibleContextGraphError';
  constructor() { super('NoEligibleContextGraph: no public CG holds non-zero per-epoch value'); }
}

/**
 * Thrown by `createChallenge` when the chosen CG's KC list is empty or
 * every resampled KC was expired after `MAX_KC_RETRIES = 10`. Same
 * retry-next-period contract as {@link NoEligibleContextGraphError}.
 */
export class NoEligibleKnowledgeCollectionError extends Error {
  readonly name = 'NoEligibleKnowledgeCollectionError';
  constructor() { super('NoEligibleKnowledgeCollection: KC list empty or all sampled KCs expired'); }
}

/**
 * Thrown by `submitProof` when the recomputed merkle root from the
 * supplied chunk + proof does not equal the on-chain expected root.
 * Indicates either (a) data corruption in the local triple store, or
 * (b) the proof builder used the wrong merkle scheme. Non-retryable;
 * the prover SHOULD log loudly and drop the period — retrying with the
 * same data will keep failing.
 */
export class MerkleRootMismatchError extends Error {
  readonly name = 'MerkleRootMismatchError';
  constructor(
    readonly computedMerkleRoot: string,
    readonly expectedMerkleRoot: string,
  ) {
    super(`MerkleRootMismatchError: computed=${computedMerkleRoot} expected=${expectedMerkleRoot}`);
  }
}

/**
 * Thrown by `submitProof` when `block.number` has rolled past the
 * challenge's proof period before the tx confirmed. Non-retryable for
 * this period; the prover MUST drop and rebuild on the next period
 * (the contract message is "This challenge is no longer active").
 */
export class ChallengeNoLongerActiveError extends Error {
  readonly name = 'ChallengeNoLongerActiveError';
  constructor() { super('ChallengeNoLongerActive: proof period rolled over before submission'); }
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

export interface OperationalWalletRegistrationResult {
  identityId: bigint;
  registered: string[];
  alreadyRegistered: string[];
  taken: Array<{ address: string; identityId: bigint }>;
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
  /**
   * Stable identifier for the SPECIFIC deployment this adapter is
   * bound to (not just the chain). `chainId` alone is too coarse —
   * every Hardhat instance shares `evm:31337`, and a single chain can
   * host multiple independent DKG deployments. Consumers that need
   * deployment-scoped namespacing (e.g. signed-delegation scopes
   * that must not be replayable across deployments) should bind to
   * this instead of `chainId`.
   *
   * EVM: `${chainId}:hub=${hubAddress.toLowerCase()}`. Mock: just
   * `chainId` (single in-memory deployment per process).
   */
  deploymentId: string;

  // Identity
  registerIdentity(proof: IdentityProof): Promise<bigint>;
  getIdentityId(): Promise<bigint>;
  ensureProfile(options?: { nodeName?: string; stakeAmount?: bigint; lockTier?: number }): Promise<bigint>;

  // V9 UAL reservation (publisher address is derived from signer)
  reserveUALRange(count: number): Promise<ReservedRange>;

  // V9 batch minting
  batchMintKnowledgeAssets(params: BatchMintParams): Promise<BatchMintResult>;

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

  /**
   * Verify that a knowledge-batch update emitted the expected merkle root
   * for the given batchId and txHash, and that the publisher address
   * matches the original batch publisher. Returns chain-verified merkle
   * root and block number so the caller can bind the gossip payload to
   * on-chain state.
   */
  verifyKAUpdate?(txHash: string, batchId: bigint, publisherAddress: string): Promise<KAUpdateVerification>;

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

  /**
   * Live owner lookup for a PCA NFT — wraps `DKGPublishingConvictionNFT.ownerOf(accountId)`.
   * Used by the daemon's curated-CG registration preflight to enforce
   * `local curator == ownerOf(pcaAccountId)` so an agent wallet cannot
   * impersonate ownership when tying a CG to a PCA.
   */
  getPublishingConvictionAccountOwner?(accountId: bigint): Promise<string>;

  /**
   * Reverse lookup: which PCA (if any) is `agent` registered against?
   *
   * Mirrors `DKGPublishingConvictionNFT.agentToAccountId(agent)`.
   * Returns `0n` for any non-registered address. The publisher SDK uses
   * this to decide, before constructing the publish tx, whether the
   * publishing wallet is eligible for the PCA discount branch in
   * `KnowledgeAssetsV10.publish()`. The contract takes the discount
   * branch only when (1) the wallet is a registered agent, (2) the
   * PCA is not past `expiresAtTimestamp`, AND
   * (3) `publishEpochs == lockDurationEpochs`. Any miss falls through
   * to direct spend at full price (no revert), so the SDK proactively
   * coerces `publishEpochs` to keep the discount.
   *
   * Optional on the adapter surface so mock-chain unit tests that
   * don't model PCA registration can omit the implementation. The
   * publisher gracefully treats `undefined` as "no PCA path active".
   */
  getConvictionAgentAccountId?(agent: string): Promise<bigint>;

  /**
   * Returns the V10 NFT-backed PCA's `lockDurationEpochs` for the given
   * `accountId` — i.e. the snapshotted publishing-conviction-epochs the
   * account was created against. `0` when the account doesn't exist or
   * the NFT contract isn't deployed.
   *
   * The publisher SDK uses this together with
   * `getConvictionAgentAccountId` to coerce a publish's epochs to the
   * exact lifetime the PCA's escrow was sized for — otherwise the
   * publish silently falls through to direct spend at full price (the
   * contract's PCA eligibility check fails the `==` constraint).
   */
  getConvictionAccountLockDurationEpochs?(accountId: bigint): Promise<number>;

  // ----- V10 Publishing Conviction NFT write+read surface -----
  // Wraps `DKGPublishingConvictionNFT`. Optional; owner-gated writes
  // MUST surface the owner revert (→ 403), never swallow it.

  createPublishingConvictionAccount?(committedTRAC: bigint): Promise<{ accountId: bigint } & TxResult>;
  topUpPublishingConvictionAccount?(accountId: bigint, amount: bigint): Promise<TxResult>;
  registerPublishingConvictionAgent?(accountId: bigint, agent: string): Promise<TxResult>;
  deregisterPublishingConvictionAgent?(accountId: bigint, agent: string): Promise<TxResult>;
  isPublishingConvictionAgent?(accountId: bigint, agent: string): Promise<boolean>;
  settlePublishingConvictionAccount?(accountId: bigint): Promise<TxResult>;
  getPublishingConvictionAccountInfo?(accountId: bigint): Promise<V10PublishingConvictionAccountInfo | null>;

  /**
   * Sign an arbitrary message hash using the node's primary operational key.
   * Used for self-signing as receiver or context graph participant.
   */
  signMessage?(messageHash: Uint8Array): Promise<{ r: Uint8Array; vs: Uint8Array }>;

  /**
   * Sign EIP-712 typed data with the adapter's primary signer. Used by
   * RFC-001 author attestations which use the `\x19\x01` framing rather
   * than the EIP-191 prefix that {@link signMessage} applies.
   *
   * Returns the full 65-byte serialized signature ({@link ethers.Signature}
   * format). The serialization is `r || s || v` so callers can feed it
   * straight into `ethers.Signature.from` to extract `(r, vs)`.
   *
   * Optional — adapters that hold no signing keys (NoChainAdapter) MUST
   * NOT implement it. Adapters that implement {@link signMessage} SHOULD
   * also implement this for the publisher author-signing path.
   */
  signTypedData?(
    domain: ethers.TypedDataDomain,
    types: Record<string, Array<{ name: string; type: string }>>,
    value: Record<string, unknown>,
  ): Promise<string>;

  /**
   * Reserve the adapter signer that should be used for a publish to the given
   * context graph and return its address. Signer-pool implementations should
   * advance their cursor atomically here so concurrent publishers do not bind
   * multiple off-chain signatures to the same tx signer by accident. Used by
   * publishers that need the off-chain signature address to match the eventual
   * tx signer.
   */
  getAuthorizedPublisherAddress?(contextGraphId: bigint): Promise<string>;

  /**
   * Sign with a specific adapter-held address. Adapters with signer pools
   * should implement this so callers can bind a context-graph-selected
   * publisher address to the digest signatures generated before tx submit.
   */
  signMessageAs?(address: string, messageHash: Uint8Array): Promise<{ r: Uint8Array; vs: Uint8Array }>;

  /**
   * Sign EIP-712 typed data with a specific adapter-held address. RFC-001
   * author attestations route through here for adapters with signer
   * pools so the typed-data signer matches the eventual tx signer.
   *
   * Returns the full 65-byte serialized signature; callers feed it into
   * `ethers.Signature.from` to derive `(r, vs)`. See {@link signTypedData}
   * for the no-pool variant. Optional for the same reason as
   * {@link signMessageAs}.
   */
  signTypedDataAs?(
    address: string,
    domain: ethers.TypedDataDomain,
    types: Record<string, Array<{ name: string; type: string }>>,
    value: Record<string, unknown>,
  ): Promise<string>;

  /**
   * Return `true` iff `address` has deployed bytecode on this chain.
   *
   * RFC-001 / V10 author attestations dispatch on `authorAddress.code.length`
   * inside the on-chain `_verifyAuthorAttestation` (`KnowledgeAssetsV10.sol`):
   * EOAs route through `ECDSA.tryRecover`, smart-contract wallets through
   * `IERC1271.isValidSignature`. The off-chain seal-integrity preflights
   * (in `assertionFinalize`, the selection-based VM publish path, and the
   * publisher's `precomputedAttestation` recompute) need the same
   * dispatch — otherwise an EIP-1271 / EIP-7702 signature that the chain
   * would accept is rejected before it ever reaches the contract. Adapters
   * skip the off-chain ECDSA recover-and-compare check whenever this
   * helper returns `true` and let the on-chain verifier be the source of
   * truth. Optional: adapters without a chain (mock / no-chain) leave this
   * undefined and the EOA path remains in effect (no regression — those
   * paths never reach the on-chain contract anyway).
   */
  hasContractCode?(address: string): Promise<boolean>;

  // On-Chain Context Graphs (ContextGraphs contract)
  createOnChainContextGraph?(params: CreateOnChainContextGraphParams): Promise<CreateOnChainContextGraphResult>;
  verify?(params: VerifyParams): Promise<TxResult>;
  publishToContextGraph?(params: PublishToContextGraphParams): Promise<OnChainPublishResult>;

  /**
   * V10 publish (KnowledgeAssetsV10 contract — writes to
   * KnowledgeCollectionStorage). Required on every adapter that claims
   * V10 capability; paired with `getKnowledgeAssetsV10Address()` and
   * `getEvmChainId()` below so authors of out-of-tree adapters get a
   * compile-time failure instead of a runtime regression when they
   * implement the tx submission but forget the digest-prefix getters.
   *
   * Post-RFC-001 the on-chain entrypoint is the unified `publish` (no
   * separate `publishDirect`); the adapter auto-selects PCA-discount vs.
   * direct-spend based on `agentToAccountId(msg.sender)`.
   */
  createKnowledgeAssetsV10(params: V10PublishParams): Promise<OnChainPublishResult>;

  /** Read minimumRequiredSignatures from ParametersStorage. Used by ACKCollector. */
  getMinimumRequiredSignatures?(): Promise<number>;

  /**
   * Sharding-table membership check (Codex PR #595 round-4 follow-up).
   *
   * SPEC_CG_MEMORY_MODEL §4.3 promises that only sharding-table members
   * can ACK a VM publish. The agent's verify path calls this on every
   * resolved signer identityId and DROPS any approval whose signer is
   * not in the sharding table. Adapters that can't probe membership
   * (test mocks, legacy in-tree fakes) return `true` for any non-zero
   * identityId — those environments aren't security-sensitive.
   *
   * Implementation maps to `ShardingTableStorage.nodeExists(uint72)`.
   */
  isShardingTableMember?(identityId: bigint): Promise<boolean>;

  /** Verify that a recovered signer address is a registered operational key for the given identity. */
  verifyACKIdentity?(recoveredAddress: string, claimedIdentityId: bigint): Promise<boolean>;

  /** Idempotently register local operational wallets for an existing identity. */
  ensureOperationalWalletsRegistered?(options?: {
    identityId?: bigint;
    additionalAddresses?: string[];
  }): Promise<OperationalWalletRegistrationResult>;

  // ----- Network State Registry (RFC 04 v0.3 / Issue #461) -----
  //
  // Surfaces the per-profile relay-capability flag. Multiaddrs themselves
  // are NOT exposed here — they live in per-round attestation KCs that
  // submitProofV2 mints (Phase 2), not on Profile (RFC 04 §5.2).
  //
  // The read method takes an explicit identityId so consumers can resolve
  // any node's flag (their own or a peer's). The write method resolves
  // the caller's identityId from the bound signer and calls the
  // onlyIdentityOwner-gated update entry point on Profile.sol — an
  // operator wanting to flip another node's flag would need that
  // node's admin/operational key, which the adapter intentionally
  // does not facilitate.

  /** RFC 04 — read the relay-capability flag on a node profile. */
  getRelayCapable?(identityId: bigint): Promise<boolean>;

  /**
   * RFC 04 — flip the bound signer's own relay-capability flag.
   * Resolves the caller's identityId from the signer; throws when
   * no profile is registered.
   */
  setRelayCapable?(relayCapable: boolean): Promise<TxResult>;

  /**
   * Confirm that an address is registered as an OPERATIONAL_KEY for an identity.
   * V10 ACK signing refuses to proceed when this capability is missing, but the
   * method stays optional to preserve the public ChainAdapter interface for
   * adapters that never advertise StorageACK support.
   */
  isOperationalWalletRegistered?(identityId: bigint, address: string): Promise<boolean>;

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

  /**
   * V10 update (works with KnowledgeCollectionStorage). Successful update txs
   * must either return `TxResult.publisherAddress` or support
   * `getLatestMerkleRootPublisher` so callers can persist confirmed metadata
   * with real chain attribution.
   */
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
   * Whether the adapter has resolved the V10 RandomSampling contracts
   * needed by the off-chain prover. Optional for non-prover adapters;
   * when present, bind layers should use it as the deployment-capability
   * check rather than only testing method presence.
   */
  isRandomSamplingReady?(): boolean;

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

  // ----- Random Sampling (V10 RandomSampling.sol) -----

  /**
   * Generate a fresh challenge for the calling node in the current proof
   * period. Decodes the indexed `contextGraphId` from the
   * `ChallengeGenerated` event (V10 only — V8 didn't index the cgId on
   * the event) so the caller can route the proof builder to the right
   * CG-scoped subgraph in one round trip.
   *
   * Throws {@link NoEligibleContextGraphError} or
   * {@link NoEligibleKnowledgeCollectionError} when the on-chain picker
   * has nothing to land on. Both are documented retry-next-period
   * conditions — callers SHOULD swallow them silently.
   *
   * Optional so non-validator adapters (NoChainAdapter, no-on-chain
   * agents) don't have to stub the prover surface.
   */
  createChallenge?(): Promise<CreateChallengeResult>;

  /**
   * Submit a chunk + merkle proof for the active challenge. Throws
   * {@link MerkleRootMismatchError} on root mismatch (data corruption /
   * wrong merkle scheme — non-retryable for this period) and
   * {@link ChallengeNoLongerActiveError} when the proof window has
   * already closed (also non-retryable; rebuild on next period).
   */
  /** @param leaf 32-byte leaf (`hashTripleV10` or private sub-root), hex string or raw bytes */
  submitProof?(leaf: Uint8Array | `0x${string}`, merkleProof: Uint8Array[]): Promise<TxResult>;

  /**
   * Read the active proof-period state without writing. Cheap; safe to
   * poll every block. Off-chain prover uses the start block to detect
   * rollover and `isValid` to know whether a period is currently open.
   */
  getActiveProofPeriodStatus?(): Promise<ProofPeriodStatus>;

  /**
   * Read the current challenge for an identity from
   * `RandomSamplingStorage`. Returns `null` when the storage entry is
   * empty (typed instead of `Challenge` with all-zeros so callers don't
   * have to special-case it).
   */
  getNodeChallenge?(identityId: bigint): Promise<NodeChallenge | null>;

  /**
   * Read the per-period score for `(epoch, periodStartBlock, identityId)`.
   * Used by smoke tests + observability — the prover itself doesn't need
   * to read this back, the on-chain state IS the source of truth.
   */
  getNodeEpochProofPeriodScore?(
    identityId: bigint,
    epoch: bigint,
    periodStartBlock: bigint,
  ): Promise<bigint>;

  // ----- KC views (V10 KnowledgeCollectionStorage + ContextGraphStorage) -----
  // Used by the off-chain Random Sampling prover to bind a challenged
  // `kcId` to the canonical merkle root + leaf count + cgId before
  // building a V10 Merkle proof from the local triple store. All four
  // are pure reads; cheap to call per challenge.

  /**
   * Latest on-chain merkle root for the given knowledge collection.
   * Returns 32 raw bytes (use `ethers.hexlify` to render). Throws when
   * `kcId` is unknown to the chain or the V10 storage contract is not
   * deployed on this Hub. Optional so non-V10 / no-chain adapters can
   * stub the prover surface.
   */
  getLatestMerkleRoot?(kcId: bigint): Promise<Uint8Array>;

  /**
   * V10 flat-KC merkle leaf count (sorted + deduped) recorded on-chain
   * for `kcId`. Used by the prover to (a) validate the local extraction
   * matches the published shape before building a proof, and (b) sanity
   * check the on-chain `chunkId = leafIndex` falls within the tree.
   */
  getMerkleLeafCount?(kcId: bigint): Promise<number>;

  /**
   * Address that signed the latest merkle root for `kcId` (the EOA that
   * called `KnowledgeAssetsV10.publish` / update). Mostly observability
   * — the prover does not gate on this — but useful for trace logs and for
   * future sharding / authorship-based reward heuristics. Publishers also use
   * this as the compatibility path for update adapters whose successful
   * `TxResult` cannot directly include `publisherAddress`.
   */
  getLatestMerkleRootPublisher?(kcId: bigint): Promise<string>;

  /**
   * Verified author identity for the latest merkle-root entry of `kcId`.
   * Sourced from `KnowledgeCollectionStorage.getLatestMerkleRootAuthor`,
   * which returns:
   *   - the address recovered from the EIP-712 author attestation (EOA
   *     publish), or
   *   - the smart-contract author address verified via EIP-1271
   *     `isValidSignature`, or
   *   - `address(0)` when the latest state change was a legacy V8 / V9
   *     publish or a V10.1 update (current update path doesn't sign).
   *
   * Daemon `/api/kc/:id/author` returns the result of this view directly
   * — chain truth, no SPARQL. Optional so non-V10 / no-chain adapters
   * can omit the surface; callers MUST treat `address(0)` as
   * "no attestation on file" rather than as a valid author claim.
   */
  getLatestMerkleRootAuthor?(kcId: bigint): Promise<string>;

  /**
   * Context graph id that hosts `kcId`, sourced from
   * `ContextGraphStorage.kcToContextGraph[kcId]`. The on-chain
   * `Challenge` struct intentionally omits cgId (V8 wire compat — see
   * `_generateChallenge` NatSpec); the off-chain prover needs cgId to
   * route the local-extraction queries to the correct CG-scoped data /
   * meta graph URIs. One chain read per challenge.
   *
   * Returns `0n` when `kcId` is unregistered (matches the Solidity
   * default-zero mapping). Callers MUST treat zero as "not found" and
   * skip the period rather than blindly querying CG `_meta:0`.
   */
  getKCContextGraphId?(kcId: bigint): Promise<bigint>;

  /**
   * On-chain access policy for `contextGraphId`. Read from
   * `ContextGraphStorage.getAccessPolicy(uint256)`. Returns the
   * Solidity enum value: `0` = public/discoverable, `1` = private/curated.
   *
   * OT-RFC-38 / LU-5 use case: when a core node receives a
   * `PublishIntent` with `isEncryptedPayload=true` it MUST independently
   * verify the CG is curated before honoring the opaque-ACK path
   * (otherwise a malicious publisher could bypass merkle verification
   * on a public CG). The local triple store oracle isn't authoritative
   * for a CG the core didn't create — the publisher's meta-graph
   * gossip is race-y with the publish itself — so cores fall back to
   * the chain, which is the source of truth.
   *
   * Returns `0` for unregistered IDs (matches Solidity default-zero
   * mapping; callers can treat as "public/unknown"). Optional so
   * non-V10 / no-chain adapters can stub the surface.
   *
   * Cheap (single eth_call) and called only on the encrypted-payload
   * path, but cores SHOULD cache the result per (chainId, cgId) to
   * avoid one RPC per publish.
   */
  getContextGraphAccessPolicy?(contextGraphId: bigint): Promise<number>;

  /**
   * On-chain participant agent allowlist for `contextGraphId`. Read
   * from `ContextGraphStorage.getParticipantAgents(uint256)`.
   *
   * OT-RFC-38 / LU-6 Phase B use case: a core node that hosts a
   * curated CG without being a member of it (sharding-table-driven
   * host-mode hosting) needs to authenticate incoming gossip envelopes
   * against the curator's agent allowlist. The local triple-store
   * oracle (`DKG_ALLOWED_AGENT` ∪ `DKG_PARTICIPANT_AGENT` in the CG
   * meta graph) only works for CGs the local node CREATED or JOINED
   * (i.e. is a member of); hosting cores have no such meta. Falling
   * back to the chain is the authoritative path.
   *
   * Returns an empty array when the CG has no participant agents
   * registered (unregistered ID, or non-agent-gated CG). Optional so
   * non-V10 / no-chain adapters can stub the surface.
   *
   * Cheap (single eth_call). Hosting cores SHOULD cache the result
   * per (chainId, cgId); the allowlist is mutable on chain but
   * changes slowly, so a 5-minute TTL is a reasonable default.
   */
  getContextGraphParticipantAgents?(contextGraphId: bigint): Promise<string[]>;

  /**
   * OT-RFC-38 / LU-6 Phase B — chain-backed `getNameHash(uint256)`
   * accessor. Returns the curator-committed wire id for `contextGraphId`,
   * or `null` when (a) the id is unregistered, or (b) the curator
   * opted out at create time. Used by hosting cores to derive the SWM
   * gossip topic for CGs they didn't create or join, without an off-
   * chain discovery channel.
   *
   * Adapters are free to cache the result indefinitely: the on-chain
   * value is write-once at create time (no setter exists), so stale
   * entries can't occur.
   */
  getContextGraphNameHash?(contextGraphId: bigint): Promise<string | null>;
}

// ----- Backward-compat deprecated aliases -----

/** @deprecated Use VerifyParams instead. */
export type AddBatchToContextGraphParams = VerifyParams;
/** @deprecated Use CreateOnChainContextGraphParams instead. */
export type CreateContextGraphParamsLegacy = CreateOnChainContextGraphParams;
