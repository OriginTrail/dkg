import type { ethers } from 'ethers';
import type { RpcUsageWindow } from './rpc-usage.js';

/**
 * The Publishing-Conviction-Account read methods the funded-wallet selector
 * needs from the conviction mixin. Declared as a shared interface so a rename or
 * signature change in `ConvictionMethods` (which `implements ConvictionReader`)
 * is caught at compile time, rather than only at runtime through the base-class
 * structural cast in `isConvictionFundedAgent`.
 */
export interface ConvictionReader {
  getConvictionAgentAccountId(agent: string): Promise<bigint>;
  getConvictionAccountLockDurationEpochs(accountId: bigint): Promise<number>;
  convictionAccountCanCover(accountId: bigint, baseCost: bigint): Promise<boolean>;
  listPublishingConvictionAccountsForWallets?(wallets: string[]): Promise<PcaAccountRelation[]>;
  listDesignatableNodes?(opts?: { fresh?: boolean }): Promise<ShardingTableNode[]>;
  getPublishingConvictionContracts?(): Promise<PcaContracts>;
  requestPublishingConvictionRpc?(method: PcaRpcMethod, params?: unknown[]): Promise<unknown>;
}

/** Inputs for one adapter-owned, cost-aware publisher planning decision. */
export interface PublisherPublishPlanRequest {
  contextGraphId: bigint;
  effectiveByteSize: bigint;
  /** Caller override. When omitted, a covering PCA may select its own lock. */
  explicitPublishEpochs?: number;
  /** Direct-spend lifetime used when no covering PCA-specific plan applies. */
  defaultPublishEpochs: number;
  /** Exact signer pin for an explicit publisher address/private key. */
  publisherAddress?: string;
}

/** Final signer-dependent values that must be fixed before publish side effects. */
export interface PublisherPublishPlan {
  publisherAddress: string;
  publishEpochs: number;
  tokenAmount: bigint;
}

/** A PCA the node relates to (GAP-1): `owned` (a node wallet holds the NFT),
 *  `agent` (a node op wallet is its registered publishing agent), or `both`. */
export type PcaRelation = 'owned' | 'agent' | 'both';
export interface PcaAccountRelation {
  accountId: bigint;
  relation: PcaRelation;
}

/** A node from the on-chain sharding table, eligible to be designated as a
 *  PCA `primaryNode`. `nodeId` is a display-only self-reported id; `identityId`
 *  is the value passed as `primaryNode`. `ask`/`stake` are wei. */
export interface ShardingTableNode {
  nodeId: string;
  identityId: bigint;
  ask: bigint;
  stake: bigint;
}

/** Browser-bootstrap contract addresses + chain params for wallet-signed PCA actions. */
export interface PcaContracts {
  nft: string;
  token: string;
  chainId: string;
  rpcUrls: string[];
  walletRpcUrls?: string[];
}

export type PcaRpcMethod =
  | 'eth_chainId'
  | 'eth_call'
  | 'eth_getTransactionReceipt'
  | 'eth_getTransactionByHash'
  | 'eth_blockNumber'
  | 'eth_getBlockByNumber';

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

/**
 * How the EVM adapter sizes the TRAC allowance it requests from an
 * operational signer before a V10 publish or update.
 *
 * - `per-publish` (default, backward-compatible) — approve exactly what
 *   this publish needs (floored at the on-chain `1n` minimum). Re-approve
 *   on every publish where `tokenAmount > currentAllowance`. Cheapest blast
 *   radius if the KA contract is ever compromised; most expensive gas
 *   profile because every dynamic-priced publish triggers an approve tx.
 *
 * - `replenishing` (recommended for mainnet operators) — approve a
 *   configurable target ceiling (default 1000 TRAC) and refill only when
 *   `currentAllowance` drops below `target × refillBelowFraction` (default
 *   10%). One approve per ~9 publishes' worth of TRAC, capped exposure.
 *
 * - `unlimited` (V9 pattern) — approve `MaxUint256` once per wallet; never
 *   approve again. Lowest gas, widest blast radius. Choose only if you
 *   trust the KA contract address absolutely.
 *
 * Computed by `computeApprovalAction` in `evm-adapter.ts`. Operators set
 * this via the daemon config (`chain.approvalPolicy` block in
 * `dkg.config.yaml`); the field threads through `DKGAgentConfig.chainConfig`
 * → `EVMAdapterBaseConfig`.
 */
export type ApprovalPolicyMode = 'per-publish' | 'replenishing' | 'unlimited';

export interface ApprovalPolicy {
  /** Sizing strategy. Defaults to `'per-publish'`. */
  mode: ApprovalPolicyMode;
  /**
   * `replenishing` only. Ceiling to approve to when topping up. Defaults
   * to 1000 TRAC (`10n ** 21n` wei-TRAC). Always raised to at least the
   * current publish's `tokenAmount` so the immediate publish succeeds even
   * if the operator misconfigured `targetAllowance` too low.
   */
  targetAllowance?: bigint;
  /**
   * `replenishing` only. Refill when `currentAllowance < target ×
   * refillBelowFraction`. Defaults to `0.1` (refill at 10% remaining).
   * Clamped to `[0, 1]`.
   */
  refillBelowFraction?: number;
}

/** Defaults used when the daemon config omits the field. */
export const DEFAULT_APPROVAL_POLICY: ApprovalPolicy = { mode: 'per-publish' };
export const DEFAULT_REPLENISH_TARGET_ALLOWANCE: bigint = 1000n * (10n ** 18n);
export const DEFAULT_REFILL_BELOW_FRACTION: number = 0.1;

/** Canonical greenfield UAL: did:dkg:{chainId}/{DKGKnowledgeAssets}/{kaId} */
export function buildKnowledgeAssetUal(
  chainId: string,
  knowledgeAssetsContract: string,
  kaId: bigint,
): string {
  return `did:dkg:${chainId}/${knowledgeAssetsContract.toLowerCase()}/${kaId.toString()}`;
}

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
   * don't yet populate it; callers MUST fall back to `0`.
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
  /**
   * Transaction index within the block (GH#842 tiebreaker — see
   * `OnChainPublishResult.txIndex`). Optional for adapter back-compat;
   * callers fall back to `0`.
   */
  txIndex?: number;
  success: boolean;
  /**
   * Effective publisher/signing address used by update-style txs.
   *
   * Required for successful update results that callers will persist as
   * confirmed metadata, unless the adapter also exposes
   * `getLatestMerkleRootPublisher(kaId)` so callers can query the same
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
  /** Chain-truth Merkle-root array length after this update. */
  merkleRootCount?: bigint;
}

export interface ChainEvent {
  type: string;
  blockNumber: number;
  data: Record<string, unknown>;
}

/**
 * Why an off-chain ACK signer pre-flight rejected a recovered signer.
 * Mirrors the two on-chain gates in
 * `KnowledgeAssetsV10._verifyACKSignature` plus an explicit
 * `'rpc-error'` for transient chain-read failures so the publisher
 * can distinguish "definitive rejection" from "couldn't verify".
 * Stable wire surface — the ACKCollector rejection log includes
 * this string verbatim.
 */
export type VerifyACKIdentityReason =
  | 'key-not-registered'      // signer is not an OPERATIONAL_KEY for the claimed identity
  | 'not-in-sharding-table'   // identity exists & key registered, but identity is not in active sharding table
  | 'rpc-error';              // chain read threw — distinct from a definitive negative

export interface VerifyACKIdentityResult {
  valid: boolean;
  /** Present iff `valid === false`. */
  reason?: VerifyACKIdentityReason;
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

export class ContextGraphChainScanPartialError extends Error {
  readonly partialResults: ContextGraphOnChain[];
  readonly scannedToBlock: number;
  readonly failedFromBlock: number;
  readonly failedToBlock: number;

  constructor(
    message: string,
    opts: {
      partialResults: ContextGraphOnChain[];
      scannedToBlock: number;
      failedFromBlock: number;
      failedToBlock: number;
      cause?: unknown;
    },
  ) {
    super(message);
    this.name = 'ContextGraphChainScanPartialError';
    this.partialResults = opts.partialResults;
    this.scannedToBlock = opts.scannedToBlock;
    this.failedFromBlock = opts.failedFromBlock;
    this.failedToBlock = opts.failedToBlock;
    if (opts.cause !== undefined) {
      (this as Error & { cause?: unknown }).cause = opts.cause;
    }
  }
}

export function isContextGraphChainScanPartialError(
  err: unknown,
): err is ContextGraphChainScanPartialError {
  return (
    err instanceof ContextGraphChainScanPartialError ||
    (
      typeof err === 'object' &&
      err !== null &&
      (err as { name?: unknown }).name === 'ContextGraphChainScanPartialError' &&
      Array.isArray((err as { partialResults?: unknown }).partialResults)
    )
  );
}

/**
 * Public ContextGraphNameRegistry list options.
 *
 * Default calls use `listAll` semantics and never mutate daemon watermarks.
 * The two boolean shapes are retained as legacy compatibility wrappers around
 * the paged cursor scanner. Optional and false values remain accepted for
 * source compatibility; only an explicit `true` enables legacy cursor-backed
 * behavior. New cursor-backed daemon scans should use
 * `scanContextGraphRegistryPages`, where callers explicitly acknowledge a page
 * after local apply succeeds.
 */
export type ContextGraphChainListOptions = { mode?: 'listAll' };
export type ContextGraphLegacyIncrementalScanOptions =
  | {
      mode?: never;
      incremental?: boolean;
      pageBudget?: number;
    }
  | {
      mode?: never;
      seedIncrementalWatermark?: boolean;
      resumeFromCursor?: boolean;
      pageBudget?: number;
    };
export type ContextGraphChainScanOptions =
  | ContextGraphChainListOptions
  | ContextGraphLegacyIncrementalScanOptions;

/** Cursor-backed daemon ContextGraphNameRegistry scan modes. */
export type ContextGraphRegistryScanOptions =
  | {
      mode: 'incremental';
      pageBudget?: number;
    }
  | {
      mode: 'seedFull';
    }
  | {
      mode: 'seedFromCursor';
      pageBudget?: number;
    };

export interface ContextGraphRegistryScanPage {
  contextGraphs: ContextGraphOnChain[];
  ack(): Promise<void>;
}

export function buildEvmDeploymentId(input: { chainId: string; hubAddress: string }): string {
  return `${input.chainId}:hub=${input.hubAddress.toLowerCase()}`;
}

export interface ContextGraphRegistryScanCursorKey {
  chainId: string;
  deploymentId: string;
  registryAddress: string;
}

export interface ContextGraphRegistryScanCursorStore {
  load(key: ContextGraphRegistryScanCursorKey): Promise<number | undefined>;
  save(key: ContextGraphRegistryScanCursorKey, nextBlock: number): Promise<void>;
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
   * adapter mirrors this V9 publish to V10 (`createKnowledgeAssets`)
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
  // GAP-4/5 — populated ONLY when getInfo is called with `{ extended: true }`
  // (the S3 budget widget; the publish hot path omits them → zero extra reads),
  // and best-effort within that (an extended-read error leaves them undefined so
  // the UI shows "unknown", distinct from `primaryNode === 0n` = "no node").
  // primaryNode / lastPrimaryNodeChangeEpoch are `accounts()` [9]/[10] (RFC-51);
  // remainingAllowance + currentEpoch are this epoch's spend headroom + index.
  primaryNode?: bigint;
  lastPrimaryNodeChangeEpoch?: number;
  remainingAllowance?: bigint;
  currentEpoch?: number;
}

/**
 * A PCA owned by the bound node's operational wallet, annotated with its
 * OT-RFC-51 node association. `primaryNode` is the node identityId whose
 * publishing allocation this account's committed TRAC funds (0 = none);
 * `fundsThisNode` is true when that equals the bound node's own identity.
 */
export interface NodePublishingConvictionAccount {
  accountId: bigint;
  primaryNode: bigint;
  fundsThisNode: boolean;
  info: V10PublishingConvictionAccountInfo;
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
   * OT-RFC-43 Option 1 (variant 1a) — the deterministic packed KA id this
   * publish claims: `kaId = (uint160(author.address) << 96) | uint96(number)`,
   * pre-allocated off-chain by the KA-number allocator. The on-chain contract
   * enforces `(reservedKaId >> 96) == author.address` at mint and `_safeMint`s
   * exactly this id. REQUIRED by the variant-1a contract (a missing/zero value
   * reverts `KaIdNamespaceMismatch`); optional here only so mock / no-chain
   * adapters and pre-Option-1 callers compile — the real EVM adapter throws if
   * it is absent. Maps to the on-chain struct slot between `authorSchemeVersion`
   * and `identityIds`.
   */
  reservedKaId?: bigint;
  /**
   * OT-RFC-49 — OPTIONAL V10 Merkle root over the curated PUBLIC `_catalog`
   * triples (each leaf `hashTripleV10(s,p,o)`; see `computeCatalogRoot`).
   * This is the curated random-sampling commitment that REPLACED the stripped
   * ciphertext commitment (same on-chain struct slot / byte width). Required
   * by the contract to be `bytes32(0)` for public CGs; for curated CGs either
   * zero (legacy/transitional — picker skips this KC in the curated draw) OR
   * paired with a non-zero `catalogLeafCount`. Defaults to `bytes32(0)`.
   */
  catalogRoot?: Uint8Array;
  /**
   * OT-RFC-49 — OPTIONAL post sort+dedupe catalog leaf count (== the curated
   * `chunkId` draw modulus for random sampling). Same zero-or-paired
   * constraints as `catalogRoot`. Defaults to `0` when omitted.
   */
  catalogLeafCount?: number;
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

export interface V10UpdateKAParams {
  kaId: bigint;
  newMerkleRoot: Uint8Array;
  newByteSize: bigint;
  /** V10 flat-KC Merkle leaf count after update (sorted + deduped). */
  newMerkleLeafCount: number;
  newTokenAmount?: bigint;
  /**
   * When set, the tx submits THIS exact `newTokenAmount` instead of
   * re-deriving it via `computeUpdateNewTokenAmount`. Used to pin the
   * on-chain tx to the floored value that the off-chain ACK collector
   * already signed (via `getUpdateAckDigestFields`), guaranteeing the
   * collected peer signatures verify against the submitted tx with no
   * recompute drift.
   */
  boundNewTokenAmount?: bigint;
  mintAmount?: number;
  burnTokenIds?: bigint[];
  /** When true, the caller asserts the KC was created via V10. Skips probing. */
  v10Origin?: boolean;
  publisherAddress?: string;
  /** Greenfield: ERC-721 owner (required — from `precomputedUpdateAttestation`). */
  authorAddress: string;
  authorR: Uint8Array;
  authorVS: Uint8Array;
  authorSchemeVersion?: number;
  updateOperationId?: string;
  publisherNodeIdentityId?: bigint;
  ackSignatures?: Array<{ identityId: bigint; r: Uint8Array; vs: Uint8Array }>;
  /**
   * OT-RFC-49 — OPTIONAL refreshed V10 Merkle root over the new batch's
   * curated `_catalog` triples. Same zero-or-paired contract as
   * {@link V10PublishParams.catalogRoot}: zero on metadata-only updates and
   * public CGs; both non-zero on curated commitment rotation. Defaults to
   * `bytes32(0)`.
   */
  newCatalogRoot?: Uint8Array;
  /**
   * OT-RFC-49 — OPTIONAL refreshed catalog leaf count for the new batch.
   * Defaults to `0`. Paired with {@link newCatalogRoot}.
   */
  newCatalogLeafCount?: number;
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
  knowledgeAssetId: bigint;
  chunkId: bigint;
  knowledgeAssetStorageContract: string;
  epoch: bigint;
  activeProofPeriodStartBlock: bigint;
  proofingPeriodDurationInBlocks: bigint;
  solved: boolean;
  /**
   * OT-RFC-43 / R3 — curation branch PINNED at issuance. `true` selects the
   * curated proof path (prove the public `_catalog`); `false` the public flat-KC
   * path. Sourced from the challenge, not a live `getAccessPolicy` probe.
   */
  isCurated: boolean;
  /**
   * OT-RFC-49 / WS-B Trap 1 — leaf count PINNED at issuance (== on-chain
   * `getCatalogLeafCount`/`getMerkleLeafCount` at draw time). This is the
   * `chunkId` index space the prover must build its proof against; reading it
   * live would diverge if the KA updated mid-period.
   */
  challengeLeafCount: bigint;
  /**
   * OT-RFC-49 / WS-B Trap 1 — the 32-byte Merkle root PINNED at issuance. The
   * prover MUST rebuild a tree whose root equals THIS value (not a live
   * `getCatalogRoot`/`getLatestMerkleRoot`), else a mid-period update makes an
   * honest proof fail. `submitProof` verifies against this same pinned root.
   */
  challengeRoot: Uint8Array;
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
  constructor() { super('NoEligibleKnowledgeAsset: KC list empty or all sampled KCs expired'); }
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
  kaId: bigint;
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

  /**
   * OPTIONAL RPC-usage capability: drain the raw JSON-RPC request counts
   * accumulated since the previous drain (a DELTA window — summing drains over
   * time yields exact request totals, the provider-billing unit). The EVM
   * adapter counts at its HTTP transport; the mock adapter returns an
   * always-empty window (it has no RPC transport). Consumed by the daemon's
   * minutely `rpc_usage` telemetry log line.
   */
  drainRpcUsage?(): RpcUsageWindow;

  // Identity
  registerIdentity(proof: IdentityProof): Promise<bigint>;
  getIdentityId(): Promise<bigint>;
  /**
   * OT-RFC-39 — resolve an arbitrary operational EOA to its on-chain
   * identityId. Returns 0n for addresses that are not registered
   * node operators. Cheap view-only read against `IdentityStorage`;
   * suitable for per-request authorization probes. Optional because
   * legacy mock chains have no identity registry.
   */
  getIdentityIdForAddress?(address: string): Promise<bigint>;
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
    submitToContextGraph(kaId: string, contextGraphId: string): Promise<TxResult>;
    /** Reveal cleartext name+description on-chain for a context graph you created. Optional. */
    revealContextGraphMetadata?(contextGraphId: string, name: string, description: string): Promise<TxResult>;
    /** List context graphs from chain via `NameClaimed` events. Optional; not supported on no-chain/mock. */
    listContextGraphsFromChain?(fromBlock?: number, options?: ContextGraphChainScanOptions): Promise<ContextGraphOnChain[]>;
    /**
     * Daemon cursor-backed ContextGraphNameRegistry scan. Each yielded page must
     * be acknowledged after the caller has applied it locally; only then may the
     * adapter advance durable scan progress.
     */
    scanContextGraphRegistryPages?(options: ContextGraphRegistryScanOptions): AsyncIterable<ContextGraphRegistryScanPage>;
    /** True when the adapter has a registry scan watermark for its currently bound ContextGraphNameRegistry. */
    hasContextGraphRegistryScanWatermark?(): Promise<boolean>;

  /**
   * Live owner lookup for a PCA NFT — wraps `DKGPublishingConvictionNFT.ownerOf(accountId)`.
   * Used by the daemon's curated-CG registration preflight to populate the
   * coherence-required publishAuthority. Registration authorization is then
   * checked separately: the tx signer must be this owner or an agent registered
   * to the exact PCA.
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
  getConvictionAgentAccountId?(agent: string, opts?: { strict?: boolean }): Promise<bigint>;

  /**
   * GAP-1 — enumerate every PCA the given wallets relate to: `owned` (the wallet
   * holds the NFT) and/or `agent` (the wallet is a registered publishing agent).
   * Deduped, relation-tagged, sorted asc.
   */
  listPublishingConvictionAccountsForWallets?(wallets: string[]): Promise<PcaAccountRelation[]>;

  /**
   * B-staked-nodes — the full on-chain sharding table of nodes designatable as a
   * PCA `primaryNode`. `opts.fresh` bypasses adapter-side cache.
   */
  listDesignatableNodes?(opts?: { fresh?: boolean }): Promise<ShardingTableNode[]>;

  /**
   * Browser-bootstrap contract addresses + chain params for the HW signing
   * layer. The browser needs the PCA NFT address, TRAC token address, chain id,
   * and safe RPC URLs; Hub/logic/ShardingTable stay daemon-side.
  */
  getPublishingConvictionContracts?(): Promise<PcaContracts>;

  /**
   * Daemon-internal read-only JSON-RPC bridge used by `/api/pca/rpc`. The HTTP
   * route owns the allowlist; adapters forward allowed reads without exposing
   * endpoint URLs.
   */
  requestPublishingConvictionRpc?(method: PcaRpcMethod, params?: unknown[]): Promise<unknown>;

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

  /**
   * Whether the PCA `accountId` can cover the DISCOUNTED cost of a publish
   * whose undiscounted base cost is `baseCost`, right now (discount tier
   * applied, compared against the account's remaining current-window
   * allowance + top-up buffer; `false` when expired/exhausted/missing).
   *
   * The publisher SDK gates the `publishEpochs → lockDurationEpochs`
   * coercion on this, so a registered-but-unfundable agent (a consent-free
   * squat, or any account short for this specific publish) keeps the
   * caller's requested lifetime instead of snapping to the PCA lock and
   * direct-spending at that lifetime/full price. Adapters that omit this
   * method cannot prove coverage and therefore remain on direct spend.
   */
  convictionAccountCanCover?(accountId: bigint, baseCost: bigint): Promise<boolean>;

  // ----- V10 Publishing Conviction NFT write+read surface -----
  // Wraps `DKGPublishingConvictionNFT`. Optional; owner-gated writes
  // MUST surface the owner revert (→ 403), never swallow it.

  createPublishingConvictionAccount?(committedTRAC: bigint, primaryNode?: bigint): Promise<{ accountId: bigint } & TxResult>;
  topUpPublishingConvictionAccount?(accountId: bigint, amount: bigint): Promise<TxResult>;
  registerPublishingConvictionAgent?(accountId: bigint, agent: string): Promise<TxResult>;
  deregisterPublishingConvictionAgent?(accountId: bigint, agent: string): Promise<TxResult>;
  clearPublishingConvictionAgents?(accountId: bigint): Promise<TxResult>;
  registerPublishingConvictionAgents?(accountId: bigint, agents: string[]): Promise<TxResult>;
  isPublishingConvictionAgent?(accountId: bigint, agent: string): Promise<boolean>;
  settlePublishingConvictionAccount?(accountId: bigint): Promise<TxResult>;
  getPublishingConvictionAccountInfo?(accountId: bigint, opts?: { extended?: boolean }): Promise<V10PublishingConvictionAccountInfo | null>;

  /**
   * OT-RFC-51 designated primary node for a PCA — `accounts(accountId).primaryNode`.
   * The node identityId whose publishing allocation this account's committed TRAC
   * funds. Returns `0n` when unset, the account is missing, or the NFT is undeployed.
   */
  getConvictionPrimaryNode?(accountId: bigint): Promise<bigint>;

  /**
   * Addresses + numeric chain id for the browser wallet-connect path (so a PCA
   * owner can sign owner-gated txs client-side). Excludes the node RPC URL by
   * design — the browser uses its own wallet provider for reads + signing.
   */
  getPcaContractContext?(): Promise<{
    chainId: number;
    hubAddress: string;
    nftAddress: string;
    tokenAddress: string;
    publishingConvictionAddress: string;
    clearAgentsSupported: boolean;
  }>;

  /**
   * Enumerate the PCAs owned by the bound operational wallet (ERC721Enumerable
   * `balanceOf` + `tokenOfOwnerByIndex`), each annotated with its OT-RFC-51
   * `primaryNode` association and whether it funds this node's own identity.
   * These are exactly the accounts the bound wallet can manage (owner-gated
   * writes). Throws {@link PcaUnavailableError} (→ 503) when the NFT is undeployed.
   */
  listNodePublishingConvictionAccounts?(): Promise<NodePublishingConvictionAccount[]>;

  /**
   * OT-RFC-51 owner-gated re-designation of a PCA's primary node (moves FUTURE
   * epochs' publishing allocation to `primaryNode`). Owner revert MUST surface
   * (→ 403); the on-chain rate-limit (once per epoch) surfaces as a revert too.
   */
  setPublishingConvictionPrimaryNode?(accountId: bigint, primaryNode: bigint): Promise<TxResult>;

  /**
   * Enumerate the operational wallets registered as publishing agents on
   * `accountId` (mirrors `getRegisteredAgents`). Checksummed addresses;
   * `[]` when the account has none or the NFT is undeployed. Optional —
   * adapters that omit it surface as "no agent enumeration" (daemon → 503).
   */
  getPublishingConvictionAgents?(accountId: bigint): Promise<string[]>;

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
   * Return an authorized signer for early, cost-independent publisher work.
   * This does not prove that the signer can fund a later publish. Once the
   * payload size exists, publishers should use
   * {@link resolvePublisherPublishPlan} before binding signatures.
   */
  getAuthorizedPublisherAddress?(contextGraphId: bigint): Promise<string>;

  /**
   * Resolve authorization, candidate-specific PCA lifetime/pricing, strict
   * fundability, and signer-pool rotation as one adapter-owned operation.
   * Publishers call this before ACK collection or encrypted staging so no
   * publish-bound identity is derived from a provisional signer.
   */
  resolvePublisherPublishPlan?(
    request: PublisherPublishPlanRequest,
  ): Promise<PublisherPublishPlan>;

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
   * V10 capability; paired with `getKnowledgeAssetsLifecycleAddress()` and
   * `getEvmChainId()` below so authors of out-of-tree adapters get a
   * compile-time failure instead of a runtime regression when they
   * implement the tx submission but forget the digest-prefix getters.
   *
   * Post-RFC-001 the on-chain entrypoint is the unified `publish` (no
   * separate `publishDirect`); the adapter auto-selects PCA-discount vs.
   * direct-spend based on `agentToAccountId(msg.sender)`.
   */
  createKnowledgeAssets(params: V10PublishParams): Promise<OnChainPublishResult>;

  /**
   * OT-RFC-43 Option 1 — highest per-author KA `number` already minted on chain
   * for `author`, or `-1n` if the author has never minted. Used by the allocator's
   * cold-start reconciliation (`nextNumber = max(local, chainMax) + 1`) so a
   * stale-local-DB / fresh device never re-hands a burned `(author, number)`.
   * EVM adapters prefer the O(1) `DKGKnowledgeAssets.getMaxKaNumberForAuthor`
   * view when available and may fall back to a bounded historical
   * `KnowledgeAssetCreated` scan for older deployments. Optional: adapters that
   * cannot reconcile chain state may omit it (the allocator then trusts its local
   * store and relies on the contract's `_safeMint` revert as backstop).
   */
  getMaxKaNumberForAuthor?(author: string): Promise<bigint>;

  /** Deployed `DKGKnowledgeAssets` (or legacy `KnowledgeCollectionStorage`) address. */
  getDKGKnowledgeAssetsAddress?(): Promise<string>;

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

  /**
   * Same gate as `verifyACKIdentity`, but returns the FAILING gate so callers
   * can produce diagnostics that an operator can act on (key registration vs
   * stake/sharding-table eligibility vs RPC outage). The publisher's ACK
   * collector uses this to log a precise rejection reason instead of the
   * three-failure-modes-look-the-same legacy "not registered" string.
   *
   * `valid: true` MUST imply that `verifyACKIdentity` would also return `true`
   * for the same inputs at the same chain height. Adapters that don't or
   * can't distinguish the gates may omit this method.
   */
  verifyACKIdentityDetailed?(
    recoveredAddress: string,
    claimedIdentityId: bigint,
  ): Promise<VerifyACKIdentityResult>;

  /** Idempotently register local operational wallets for an existing identity. */
  ensureOperationalWalletsRegistered?(options?: {
    identityId?: bigint;
    additionalAddresses?: string[];
  }): Promise<OperationalWalletRegistrationResult>;

  /**
   * Add a single operational wallet to the node identity via
   * `Profile.addOperationalWallets(identityId, [address])`. Signed by the
   * configured admin key (the on-chain `onlyAdmin` gate). Throws when no admin
   * key is configured, the configured admin is not an on-chain ADMIN_KEY for
   * the identity, or the identity has no profile. `identityId` defaults to the
   * bound node's own identity.
   */
  addOperationalWallet?(address: string, options?: { identityId?: bigint }): Promise<TxResult>;

  /**
   * Remove a single operational wallet from the node identity via
   * `Identity.removeKey(identityId, keccak(address))` (Profile has no remove
   * path). Signed by the configured admin key. REFUSES to remove the bound
   * primary operational wallet (the one that resolves the node's identityId) —
   * the contract's only guard is `CannotDeleteOnlyOperationalKey`, which would
   * not stop orphaning the node's own identity resolution while other keys
   * remain. `identityId` defaults to the bound node's own identity.
   */
  removeOperationalWallet?(address: string, options?: { identityId?: bigint }): Promise<TxResult>;

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
  updateKnowledgeCollectionV10?(params: V10UpdateKAParams): Promise<TxResult>;

  /**
   * Resolve the on-chain-derived fields the V10 UPDATE ACK digest binds,
   * so the off-chain ACK collector signs a digest byte-identical to what
   * `updateKnowledgeCollectionV10` submits and the contract verifies.
   *
   * Reads `contextGraphId` (`kaToContextGraph`), `preUpdateMerkleRootCount`
   * (`getMerkleRoots(kaId).length`), and the floored `newTokenAmount`
   * (`computeUpdateNewTokenAmount` → `floorPublishTokenAmount`) exactly as
   * the update tx does. Callers MUST pass the returned `newTokenAmount`
   * back into `updateKnowledgeCollectionV10` as `boundNewTokenAmount` to
   * pin the tx to the signed value with no recompute drift.
   */
  getUpdateAckDigestFields?(params: {
    kaId: bigint;
    newByteSize: bigint;
    userProvidedNewTokenAmount?: bigint;
    mintAmount?: bigint;
    burnTokenIds?: bigint[];
  }): Promise<{
    contextGraphId: bigint;
    preUpdateMerkleRootCount: bigint;
    newTokenAmount: bigint;
    mintAmount: bigint;
    burnTokenIds: bigint[];
  }>;

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
   * digests, and any adapter that implements `createKnowledgeAssets`
   * must also implement this so the digest inputs match the on-chain
   * contract that will verify them. Throws if the contract is not deployed.
   */
  getKnowledgeAssetsLifecycleAddress(): Promise<string>;

  /**
   * Returns the numeric EVM chain id (e.g. 31337n for hardhat). Distinct
   * from `chainId` above, which is namespaced (`evm:31337`, `mock:31337`)
   * and not directly parseable with `BigInt()`. Required — used by the
   * publisher to build the H5-prefixed publish digests.
   */
  getEvmChainId(): Promise<bigint>;

  // V8 backward compatibility (used by mock adapter, will be removed)
  createKnowledgeAsset?(params: CreateKCParams): Promise<TxResult>;
  updateKnowledgeAsset?(params: UpdateKCParams): Promise<TxResult>;

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
  /** @param content raw bytes the chain hashes to the leaf (`leaf = keccak256(content)`): public N-Triple / curated `_catalog` triple bytes */
  submitProof?(content: Uint8Array | `0x${string}`, merkleProof: Uint8Array[]): Promise<TxResult>;

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
  // `kaId` to the canonical merkle root + leaf count + cgId before
  // building a V10 Merkle proof from the local triple store. All four
  // are pure reads; cheap to call per challenge.

  /**
   * Latest on-chain merkle root for the given knowledge collection.
   * Returns 32 raw bytes (use `ethers.hexlify` to render). Throws when
   * `kaId` is unknown to the chain or the V10 storage contract is not
   * deployed on this Hub. Optional so non-V10 / no-chain adapters can
   * stub the prover surface.
   */
  getLatestMerkleRoot?(kaId: bigint): Promise<Uint8Array>;

  /**
   * V10 flat-KC merkle leaf count (sorted + deduped) recorded on-chain
   * for `kaId`. Used by the prover to (a) validate the local extraction
   * matches the published shape before building a proof, and (b) sanity
   * check the on-chain `chunkId = leafIndex` falls within the tree.
   */
  getMerkleLeafCount?(kaId: bigint): Promise<number>;

  /**
   * OT-RFC-49 — on-chain curated `_catalog` Merkle root for `kaId`. Read
   * from `DKGKnowledgeAssets.getCatalogRoot(uint256)`. This REPLACED the
   * stripped `getLatestCiphertextChunksRoot` reader (same on-chain slot).
   *
   * Returns 32 raw bytes. Returns `bytes32(0)` (all-zero) when the KC has
   * no catalog commitment set — either because it is a public KC (legacy
   * V10 plaintext path) or a transitional curated KC published before the
   * catalog commitment existed. RFC-39 random-sampling treats both as
   * unsampleable via the picker's per-KC commitment check. The off-chain
   * prover rebuilds a tree whose root MUST equal this value (or the pinned
   * `challenge.challengeRoot`, which is sourced from it at issuance).
   *
   * Optional so non-V10 / no-chain adapters can stub the surface.
   */
  getCatalogRoot?(kaId: bigint): Promise<Uint8Array>;

  /**
   * OT-RFC-49 — post sort+dedupe catalog leaf count committed on chain for
   * `kaId`. Read from `DKGKnowledgeAssets.getCatalogLeafCount(uint256)`.
   * REPLACED the stripped `getCiphertextChunkCount` reader.
   *
   * Returns `0` for KCs without a catalog commitment (see `getCatalogRoot`
   * for the bisection). Matches the Solidity default-zero mapping. The
   * prover uses this as the curated counterpart of `getMerkleLeafCount`
   * for the on-chain `chunkId = leafIndex` bounds check and to sanity-check
   * the local `_catalog` extraction before building a proof.
   *
   * Optional so non-V10 / no-chain adapters can stub the surface.
   */
  getCatalogLeafCount?(kaId: bigint): Promise<number>;

  /**
   * Address that signed the latest merkle root for `kaId` (the EOA that
   * called `KnowledgeAssetsV10.publish` / update). Mostly observability
   * — the prover does not gate on this — but useful for trace logs and for
   * future sharding / authorship-based reward heuristics. Publishers also use
   * this as the compatibility path for update adapters whose successful
   * `TxResult` cannot directly include `publisherAddress`.
   */
  getLatestMerkleRootPublisher?(kaId: bigint): Promise<string>;

  /**
   * Verified author identity for the latest merkle-root entry of `kaId`.
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
  getLatestMerkleRootAuthor?(kaId: bigint): Promise<string>;

  /**
   * Context graph id that hosts `kaId`, sourced from
   * `ContextGraphStorage.kaToContextGraph[kaId]`. The on-chain
   * `Challenge` struct intentionally omits cgId (V8 wire compat — see
   * `_generateChallenge` NatSpec); the off-chain prover needs cgId to
   * route the local-extraction queries to the correct CG-scoped data /
   * meta graph URIs. One chain read per challenge.
   *
   * Returns `0n` when `kaId` is unregistered (matches the Solidity
   * default-zero mapping). Callers MUST treat zero as "not found" and
   * skip the period rather than blindly querying CG `_meta:0`.
   */
  getKAContextGraphId?(kaId: bigint): Promise<bigint>;

  /**
   * Number of Knowledge Assets registered to `contextGraphId`, sourced from
   * `ContextGraphStorage.getContextGraphKCCount(uint256)` (the length of the
   * ordered `_contextGraphKAList[cgId]` push-append array).
   *
   * This count is the **per-CG registration ordinal** — a dense, monotonic,
   * comparable integer that the chain-driven VM reconciler uses as its cursor
   * key (Phase B). It is the on-chain "head" for a CG: a node has reconciled
   * up to ordinal `N` means it has promoted the first `N` registered KAs.
   *
   * Returns `0n` for a CG with no registered KAs (or an unknown CG — the
   * Solidity default-zero array length). Optional so non-V10 / no-chain
   * adapters can omit the surface.
   */
  getContextGraphKCCount?(contextGraphId: bigint): Promise<bigint>;

  /**
   * The `kaId` registered at ordinal `index` within `contextGraphId`, sourced
   * from `ContextGraphStorage.getContextGraphKCAt(uint256,uint256)`. `index`
   * is 0-based and MUST be `< getContextGraphKCCount(contextGraphId)` (the
   * Solidity read reverts on out-of-range). Pairs with the count read to walk
   * a CG's registration sequence ordinal-by-ordinal during a reconcile sweep.
   */
  getContextGraphKCAt?(contextGraphId: bigint, index: bigint): Promise<bigint>;

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
   * On-chain liveness probe for `contextGraphId`. Read from
   * `ContextGraphStorage.isContextGraphActive(uint256)`. Returns `true`
   * only when the id is a currently-minted/active context graph on chain.
   *
   * Why a SEPARATE call from {@link getContextGraphAccessPolicy}: the access
   * policy getter returns Solidity's default `0` (= public) for UNKNOWN /
   * unregistered ids, so it is silently permissive. Any decision that
   * downgrades a CG to a less-protected path (e.g. SWM plaintext for an
   * "on-chain public" CG) MUST first prove the slot is live with this probe —
   * otherwise an unregistered numeric id, or stale local/cached state after a
   * devnet reset, would be misclassified as public. Callers pair the two:
   * `isContextGraphActiveOnChain(id) && getContextGraphAccessPolicy(id) === 0`.
   *
   * Optional so non-V10 / no-chain adapters can stub the surface. NOTE:
   * absence is treated as fail-closed by callers (a CG cannot be PROVEN live,
   * so the protected/encrypted path is kept). Adapters that implement
   * `getContextGraphAccessPolicy` SHOULD also implement this so they don't
   * silently strand on-chain-public CGs on the encrypted path.
   * A resolved `false` must mean the chain successfully proved the slot is
   * inactive; transient RPC/read failures should reject so callers can choose
   * their own fail-closed or ACK-backed fallback behavior.
   */
  isContextGraphActiveOnChain?(contextGraphId: bigint): Promise<boolean>;

  /**
   * On-chain publish policy for `contextGraphId`. Read from
   * `ContextGraphStorage.getPublishPolicy(uint256)`. Returns the
   * Solidity tuple `(uint8 publishPolicy, address publishAuthority)`:
   * - `publishPolicy`: `0` = curators-only, `1` = open.
   * - `publishAuthority`: address authorized when the policy is
   *   restricted (zero address when irrelevant).
   *
   * Issue #872 / Codex round-3 use case: non-creator peers do NOT
   * receive `dkg:publishPolicy` triples via SWM (only the creator
   * writes them to local `_meta`). They observe the chain event at
   * subscribe time which populates the in-memory cache, but the
   * cache is lost on daemon restart. To preserve the public+open
   * read-relaxation after a restart for peers, the agent's policy
   * resolver falls back to this RPC when the CG is confirmed
   * registered on-chain but `publishPolicy` is still missing
   * locally. Cheap (single eth_call); callers cache the result.
   *
   * Unregistered ids return `(0, address(0))` from Solidity's
   * default-zero mapping. Callers MUST cross-check registration
   * status before treating the answer as authoritative — a zero
   * publish policy on an unregistered id is NOT a positive "open"
   * signal.
   */
  getContextGraphPublishPolicy?(contextGraphId: bigint): Promise<{
    publishPolicy: number;
    publishAuthority: string;
  }>;

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
