// SPDX-License-Identifier: Apache-2.0

/**
 * OT-RFC-27 NeuroSymbolic Marketplace — the marketplace capability fragment of
 * the `ChainAdapter` interface, split into its own module because
 * `chain-adapter.ts` sits at its ratcheted file-size budget.
 *
 * Every member is optional-capability style (like the Random Sampling and PCA
 * surfaces): adapters that cannot settle marketplace receipts simply omit the
 * methods, and `supportsMarketplace()` is the authoritative runtime gate —
 * callers MUST check it (or absence) before routing into the write surface.
 * The EVM adapter returns `true` only once the `Marketplace` contract is
 * resolved from the Hub; `NoChainAdapter` returns `false` with throwing stubs.
 *
 * `ReceiptClaimInput` is the shared wire shape owned by the domain package
 * `@origintrail-official/dkg-marketplace` (which has no workspace deps, so the
 * import direction chain → marketplace cannot cycle). It maps 1:1 onto the
 * contract's `MarketplaceLib.ReceiptClaim` tuple; the adapter renames
 * `askPerUnitWei` → `askPerUnit` at the ABI boundary.
 */
import type { ReceiptClaimInput } from '@origintrail-official/dkg-marketplace';
import type { TxResult } from './chain-adapter.js';

export type { ReceiptClaimInput } from '@origintrail-official/dkg-marketplace';

export interface MarketplaceFundSubscriptionParams {
  /** uint96 TRAC wei moved into the epoch pool (`transferFrom` the signer). */
  amountWei: bigint;
  /**
   * Session key to register/rotate for the buyer. Omitted (or the zero
   * address) keeps the current key — the contract rejects that when the buyer
   * has none, because the bucket would be unspendable.
   */
  sessionKey?: string;
  /** Chronos epoch the bucket belongs to — current or current+1. */
  epoch: bigint;
}

/** Mirrors `MarketplaceLib.Bucket` (`getBucket`). All wei values. */
export interface MarketplaceBucket {
  funded: bigint;
  totalClaimed: bigint;
  totalFinalized: bigint;
  finalized: boolean;
}

/** Mirrors `MarketplaceLib.SellerClaim` (`getSellerClaim`). */
export interface MarketplaceSellerClaim {
  claimed: bigint;
  /** Σ claimValue·S18/1e18 with the stake factor captured at acceptance. */
  qiRaw: bigint;
  /** Explicit bucket-claimant membership (set on the first accepted claim). */
  enrolled: boolean;
}

/** Mirrors the `getNodeEpochAccounting(epoch, identityId)` tuple. */
export interface MarketplaceNodeEpochAccounting {
  /** R_i(e) — the node's finalized receipt value. */
  finalizedValue: bigint;
  /** Q_i(e) — the node's stake-weighted QueryInferenceScore. */
  qiScore: bigint;
  /** ΣR over the epoch. */
  totalFinalizedValue: bigint;
  /** ΣQ over the epoch. */
  totalQiScore: bigint;
  /** The epoch reward pool (wei). */
  pool: bigint;
  /** Whether this node already claimed its epoch reward. */
  claimed: boolean;
}

/** Mirrors `getParams()`. */
export interface MarketplaceParams {
  /** λ_QIF in 18-decimal fixed point (0.4e18 default). */
  lambdaQif18: bigint;
  /** Receipts for epoch e are accepted until `epochEnd(e) + grace`. */
  settlementGraceSeconds: bigint;
  /** Node-side serve guidance (stored for discoverability, not enforced). */
  softCeilingBps: number;
  /**
   * Wash-trading guard: epoch rewards are capped at
   * `rewardCapMultiple · R_i(e)` (default 10, 0 = uncapped).
   */
  rewardCapMultiple: number;
}

/** Mirrors `getEpochRewardDistribution(epoch)` (all wei). */
export interface MarketplaceEpochRewardDistribution {
  pool: bigint;
  distributed: bigint;
  /** `pool − distributed`; stays in the contract (governance follow-up). */
  undistributed: bigint;
}

/** `claimEpochReward` result carrying the paid amount from `EpochRewardClaimed`. */
export interface MarketplaceClaimEpochRewardResult extends TxResult {
  /** `pool(e) · QIF_i(e) / 1e18` in TRAC wei, paid to the calling wallet. */
  rewardWei: bigint;
}

/**
 * The OT-RFC-27 marketplace method group merged into {@link ChainAdapter}.
 * See `Marketplace.sol` for the authoritative on-chain semantics each method
 * wraps; the mock adapter mirrors them in memory so agent tests run chainless.
 */
export interface ChainAdapterMarketplace {
  /**
   * Authoritative runtime gate for the marketplace surface. `false` (or an
   * absent method) means every `marketplace*` call below will throw.
   */
  supportsMarketplace?(): boolean;

  /**
   * Current Chronos epoch — the epoch read the marketplace flows key buckets
   * and settlement on. Pre-dates this fragment on the EVM and mock adapters;
   * declared here so `ChainAdapter` consumers can reach it without casting.
   */
  getCurrentEpoch?(): Promise<bigint>;

  /**
   * Deployed `Marketplace` contract address. Required by buyers to compute
   * the shared `DKG_MKT_AUTH_V1` authorization digest (the digest binds
   * chainId + marketplace address so authorizations cannot replay across
   * deployments). Pairs with `getEvmChainId()`.
   */
  marketplaceGetAddress?(): Promise<string>;

  /**
   * Fund a non-refundable period subscription (TRAC `approve` +
   * `fundSubscription`) and register/rotate the buyer's session key.
   */
  marketplaceFundSubscription?(params: MarketplaceFundSubscriptionParams): Promise<TxResult>;

  /**
   * Submit a batch of buyer-authorized receipt claims. The seller identity is
   * resolved on-chain from the submitting operational wallet; any objective
   * fault (replay, expiry, over-units, bad signature, unknown bucket) rejects
   * the WHOLE batch, and batches are bounded to `MAX_RECEIPT_BATCH` (100).
   */
  marketplaceSubmitReceiptBatch?(claims: ReceiptClaimInput[]): Promise<TxResult>;

  /**
   * Finalize a (buyer, epoch) bucket after the settlement deadline.
   * Permissionless and paginated: `maxSellers` bounds the claimants processed
   * per call (omitted or 0n = all remaining); a stored cursor lets repeated
   * calls finish a bucket too large for one block.
   */
  marketplaceFinalizeBucket?(buyer: string, epoch: bigint, maxSellers?: bigint): Promise<TxResult>;

  /**
   * Claim the node's epoch reward `min(pool(e) · QIF_i(e),
   * rewardCapMultiple · R_i(e))`; paid to the calling operational wallet once
   * every bucket of the epoch is finalized.
   */
  marketplaceClaimEpochReward?(identityId: bigint, epoch: bigint): Promise<MarketplaceClaimEpochRewardResult>;

  /** Roll a settled epoch pool with zero finalized value into the current epoch. */
  marketplaceRollEpochPool?(epoch: bigint): Promise<TxResult>;

  marketplaceGetBucket?(buyer: string, epoch: bigint): Promise<MarketplaceBucket>;

  marketplaceGetSellerClaim?(buyer: string, epoch: bigint, identityId: bigint): Promise<MarketplaceSellerClaim>;

  marketplaceGetNodeEpochAccounting?(epoch: bigint, identityId: bigint): Promise<MarketplaceNodeEpochAccounting>;

  /** The buyer's registered session key (zero address when none). */
  marketplaceGetActiveSessionKey?(buyer: string): Promise<string>;

  marketplaceGetParams?(): Promise<MarketplaceParams>;

  /** Paid-out vs remaining reward wei for an epoch (reward-cap remainder). */
  marketplaceGetEpochRewardDistribution?(epoch: bigint): Promise<MarketplaceEpochRewardDistribution>;

  /**
   * Receipts for `epoch` are accepted until this unix timestamp (inclusive);
   * finalization and reward claims open strictly after it.
   */
  marketplaceSettlementDeadline?(epoch: bigint): Promise<bigint>;
}
