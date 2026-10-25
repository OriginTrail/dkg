// SPDX-License-Identifier: Apache-2.0

/**
 * OT-RFC-27 marketplace surface of the MockChainAdapter — a full in-memory
 * mirror of `Marketplace.sol` (buckets, session keys, auth replay set,
 * pro-rata floor finalization, stake factor per identity, λ-blended QIF
 * rewards, pool rollover) so agent/router unit tests run chainless.
 *
 * Stateless base-class holder: `MockChainAdapter extends MockMarketplaceMethods`
 * (mock-adapter.ts sits at its ratcheted file-size budget, and a mixin-style
 * interface merge would trip oxlint's no-unsafe-declaration-merging ratchet).
 * Methods take `this: MockChainAdapter` to reach the adapter's identity/epoch
 * surface and keep their marketplace state in a module-level WeakMap.
 *
 * Semantics mirrored 1:1 from the contract, with one documented simplification
 * consistent with how the mock models time elsewhere (`rsEpoch` counter +
 * `__advanceEpoch()`): the settlement deadline predicate is the epoch counter
 * itself — receipts for epoch `e` are accepted while `getCurrentEpoch() <= e`,
 * and finalization / reward claims / rollover open once the counter passed it
 * (`> e`), i.e. grace = 0 in counter terms. `settlementGraceSeconds` is still
 * stored and reported through `marketplaceGetParams`, and
 * `marketplaceSettlementDeadline` synthesizes the timestamp from a fixed mock
 * Chronos schedule (start 0, 3600s epochs) exactly as
 * `Chronos.timestampForEpoch(epoch + 1) + grace` would.
 *
 * Authorization signatures are verified for real: the mock recomputes the
 * shared `DKG_MKT_AUTH_V1` digest (chainId 31337, `MOCK_MARKETPLACE_ADDRESS`)
 * via the domain package and EIP-191-recovers the signer, so replay,
 * wrong-seller and rotated-session-key failures behave exactly as on-chain.
 *
 * Several MockChainAdapter instances can settle against ONE marketplace (a
 * buyer node and seller nodes in one test) by sharing the state object:
 * `seller.__attachMarketplaceState(buyer.__marketplaceState())`.
 */

import { ethers } from 'ethers';
import {
  computeAuthDigest,
  eip191RecoverDigest,
} from '@origintrail-official/dkg-marketplace';
import type { TxResult } from './chain-adapter.js';
import type {
  MarketplaceBucket,
  MarketplaceClaimEpochRewardResult,
  MarketplaceFundSubscriptionParams,
  MarketplaceNodeEpochAccounting,
  MarketplaceParams,
  MarketplaceSellerClaim,
  ReceiptClaimInput,
} from './chain-adapter-marketplace.js';
import type { MockChainAdapter } from './mock-adapter.js';

/** Fixed Marketplace address the mock binds digests to (and reports). */
export const MOCK_MARKETPLACE_ADDRESS = '0x' + 'a7'.repeat(20);

/** Mock Chronos schedule behind `marketplaceSettlementDeadline` (start = 0). */
export const MOCK_MARKETPLACE_EPOCH_LENGTH_SECONDS = 3600n;

const SCALE18 = 10n ** 18n;
const MAX_RECEIPT_BATCH = 100;

interface MockBucket {
  funded: bigint;
  totalClaimed: bigint;
  totalFinalized: bigint;
  finalized: boolean;
}

/**
 * The whole in-memory marketplace: one instance = one deployment. Tests tune
 * params / stake factors / the expiry clock by mutating fields directly.
 */
export class MockMarketplaceState {
  /** λ_QIF, 18-decimal fixed point. Contract default 0.4e18. */
  lambdaQif18 = 400_000_000_000_000_000n;
  /** Reported through getParams; the deadline predicate is the epoch counter. */
  settlementGraceSeconds = MOCK_MARKETPLACE_EPOCH_LENGTH_SECONDS / 4n;
  softCeilingBps = 9500;
  /** Unix-seconds clock authorization expiry is checked against. */
  nowSeconds = BigInt(Math.floor(Date.now() / 1000));
  /** identityId → S18 at acceptance; absent = SCALE18 (node at the stake cap). */
  readonly stakeFactor18ByIdentity = new Map<bigint, bigint>();
  /** `${buyer}|${epoch}` → bucket. */
  readonly buckets = new Map<string, MockBucket>();
  readonly bucketSellers = new Map<string, bigint[]>();
  /** `${buyer}|${epoch}|${identityId}` → claim accruals. */
  readonly sellerClaims = new Map<string, { claimed: bigint; qiRaw: bigint }>();
  /** sessionKey (lowercase) → buyer (lowercase). */
  readonly sessionKeyOwner = new Map<string, string>();
  /** buyer (lowercase) → sessionKey (as registered). */
  readonly activeSessionKey = new Map<string, string>();
  readonly consumedAuth = new Set<string>();
  /** epoch → wei. */
  readonly epochPool = new Map<string, bigint>();
  readonly epochBuyers = new Map<string, string[]>();
  readonly openBuckets = new Map<string, bigint>();
  /** `${epoch}|${identityId}` → R_i / Q_i. */
  readonly nodeFinalizedValue = new Map<string, bigint>();
  readonly nodeQiScore = new Map<string, bigint>();
  readonly epochTotalFinalizedValue = new Map<string, bigint>();
  readonly epochTotalQiScore = new Map<string, bigint>();
  readonly rewardClaimed = new Set<string>();
  /** TRAC "transferred out" per wallet (lowercase) — the payout ledger tests assert. */
  readonly rewardsPaidWei = new Map<string, bigint>();
  private nextTxSeq = 1;

  stakeFactor18(identityId: bigint): bigint {
    return this.stakeFactor18ByIdentity.get(identityId) ?? SCALE18;
  }

  txResult(): TxResult {
    const seq = this.nextTxSeq++;
    return {
      hash: ethers.id(`mock-marketplace-tx-${seq}`),
      blockNumber: seq,
      txIndex: 0,
      success: true,
    };
  }
}

/** Per-adapter state, lazily created; `__attachMarketplaceState` shares one. */
const marketplaceStates = new WeakMap<object, MockMarketplaceState>();

function stateFor(adapter: object): MockMarketplaceState {
  let state = marketplaceStates.get(adapter);
  if (!state) {
    state = new MockMarketplaceState();
    marketplaceStates.set(adapter, state);
  }
  return state;
}

function bucketKey(buyer: string, epoch: bigint): string {
  return `${buyer.toLowerCase()}|${epoch}`;
}

function claimKey(buyer: string, epoch: bigint, identityId: bigint): string {
  return `${bucketKey(buyer, epoch)}|${identityId}`;
}

function nodeKey(epoch: bigint, identityId: bigint): string {
  return `${epoch}|${identityId}`;
}

function addTo(map: Map<string, bigint>, key: string, amount: bigint): void {
  map.set(key, (map.get(key) ?? 0n) + amount);
}

function mockRevert(detail: string): never {
  throw new Error(`Mock marketplace: ${detail}`);
}

export class MockMarketplaceMethods {
  supportsMarketplace(this: MockChainAdapter): boolean {
    return true;
  }

  /** Test seam: the in-memory marketplace this adapter settles against. */
  __marketplaceState(this: MockChainAdapter): MockMarketplaceState {
    return stateFor(this);
  }

  /** Test seam: share ONE marketplace between buyer and seller mock adapters. */
  __attachMarketplaceState(this: MockChainAdapter, state: MockMarketplaceState): void {
    marketplaceStates.set(this, state);
  }

  async marketplaceGetAddress(this: MockChainAdapter): Promise<string> {
    return MOCK_MARKETPLACE_ADDRESS;
  }

  async marketplaceFundSubscription(
    this: MockChainAdapter,
    params: MarketplaceFundSubscriptionParams,
  ): Promise<TxResult> {
    const state = stateFor(this);
    const buyer = this.signerAddress.toLowerCase();
    if (params.amountWei <= 0n) {
      mockRevert('ZeroTokenAmount()');
    }
    const currentEpoch = await this.getCurrentEpoch();
    if (params.epoch !== currentEpoch && params.epoch !== currentEpoch + 1n) {
      mockRevert(`InvalidSubscriptionEpoch(${params.epoch}, ${currentEpoch})`);
    }

    const sessionKey = params.sessionKey ?? ethers.ZeroAddress;
    if (sessionKey === ethers.ZeroAddress) {
      if (!state.activeSessionKey.has(buyer)) {
        mockRevert(`NoActiveSessionKey(${this.signerAddress})`);
      }
    } else {
      const keyOwner = state.sessionKeyOwner.get(sessionKey.toLowerCase());
      if (keyOwner !== undefined && keyOwner !== buyer) {
        mockRevert(`SessionKeyAlreadyBound(${sessionKey}, ${keyOwner})`);
      }
      state.sessionKeyOwner.set(sessionKey.toLowerCase(), buyer);
      state.activeSessionKey.set(buyer, sessionKey);
    }

    const key = bucketKey(buyer, params.epoch);
    let bucket = state.buckets.get(key);
    const firstFunding = (bucket?.funded ?? 0n) === 0n;
    if (!bucket) {
      bucket = { funded: 0n, totalClaimed: 0n, totalFinalized: 0n, finalized: false };
      state.buckets.set(key, bucket);
    }
    bucket.funded += params.amountWei;
    addTo(state.epochPool, params.epoch.toString(), params.amountWei);
    if (firstFunding) {
      const buyers = state.epochBuyers.get(params.epoch.toString()) ?? [];
      buyers.push(buyer);
      state.epochBuyers.set(params.epoch.toString(), buyers);
      addTo(state.openBuckets, params.epoch.toString(), 1n);
    }
    return state.txResult();
  }

  async marketplaceSubmitReceiptBatch(
    this: MockChainAdapter,
    claims: ReceiptClaimInput[],
  ): Promise<TxResult> {
    const state = stateFor(this);
    if (claims.length === 0) {
      mockRevert('EmptyReceiptBatch()');
    }
    if (claims.length > MAX_RECEIPT_BATCH) {
      mockRevert(`ReceiptBatchTooLarge(${claims.length})`);
    }
    const identityId = await this.getIdentityId();
    if (identityId === 0n || !(await this.isShardingTableMember(identityId))) {
      mockRevert(`NotACoreNode(${this.signerAddress})`);
    }
    const stakeFactor18 = state.stakeFactor18(identityId);
    const currentEpoch = await this.getCurrentEpoch();
    const chainId = await this.getEvmChainId();

    // The contract rejects the whole batch on any objective fault (the revert
    // rolls everything back), so the mock validates every claim BEFORE it
    // applies any accrual — in the contract's exact per-claim check order.
    const accruals: Array<{ claim: ReceiptClaimInput; authDigest: string; value: bigint }> = [];
    const batchConsumed = new Set<string>();
    for (const claim of claims) {
      const key = bucketKey(claim.buyer, claim.epoch);
      if ((state.buckets.get(key)?.funded ?? 0n) === 0n) {
        mockRevert(`BucketNotFunded(${claim.buyer}, ${claim.epoch})`);
      }
      if (currentEpoch > claim.epoch) {
        mockRevert(`SettlementClosed(${claim.epoch}, ${currentEpoch})`);
      }
      if (state.nowSeconds > claim.expiry) {
        mockRevert(`AuthorizationExpired(${claim.callId}, ${claim.expiry})`);
      }
      if (claim.servedUnits === 0n) {
        mockRevert(`ZeroServedUnits(${claim.callId})`);
      }
      if (claim.servedUnits > claim.maxUnits) {
        mockRevert(`ServedOverMaxUnits(${claim.callId}, ${claim.servedUnits}, ${claim.maxUnits})`);
      }

      const authDigest = computeAuthDigest({
        chainId,
        marketplaceAddress: MOCK_MARKETPLACE_ADDRESS,
        buyer: claim.buyer,
        sellerIdentityId: identityId,
        offeringId: claim.offeringId,
        callId: claim.callId,
        epoch: claim.epoch,
        maxUnits: claim.maxUnits,
        askPerUnitWei: claim.askPerUnitWei,
        expiry: claim.expiry,
      });
      if (state.consumedAuth.has(authDigest) || batchConsumed.has(authDigest)) {
        mockRevert(`AuthorizationAlreadyConsumed(${authDigest})`);
      }
      batchConsumed.add(authDigest);

      const sessionKey = state.activeSessionKey.get(claim.buyer.toLowerCase());
      let recovered: string;
      try {
        recovered = eip191RecoverDigest(authDigest, claim.authSignature);
      } catch {
        recovered = ethers.ZeroAddress;
      }
      if (!sessionKey || recovered.toLowerCase() !== sessionKey.toLowerCase()) {
        mockRevert(`InvalidAuthorizationSignature(${authDigest}, ${recovered}, ${sessionKey ?? ethers.ZeroAddress})`);
      }

      accruals.push({ claim, authDigest, value: claim.servedUnits * claim.askPerUnitWei });
    }

    for (const { claim, authDigest, value } of accruals) {
      state.consumedAuth.add(authDigest);
      const key = bucketKey(claim.buyer, claim.epoch);
      const bucket = state.buckets.get(key)!;
      bucket.totalClaimed += value;
      const ck = claimKey(claim.buyer, claim.epoch, identityId);
      let sellerClaim = state.sellerClaims.get(ck);
      if (!sellerClaim) {
        sellerClaim = { claimed: 0n, qiRaw: 0n };
        state.sellerClaims.set(ck, sellerClaim);
        const sellers = state.bucketSellers.get(key) ?? [];
        sellers.push(identityId);
        state.bucketSellers.set(key, sellers);
      }
      sellerClaim.claimed += value;
      sellerClaim.qiRaw += (value * stakeFactor18) / SCALE18;
    }
    return state.txResult();
  }

  async marketplaceFinalizeBucket(
    this: MockChainAdapter,
    buyer: string,
    epoch: bigint,
  ): Promise<TxResult> {
    const state = stateFor(this);
    const currentEpoch = await this.getCurrentEpoch();
    if (currentEpoch <= epoch) {
      mockRevert(`SettlementStillOpen(${epoch}, ${currentEpoch})`);
    }
    const key = bucketKey(buyer, epoch);
    const bucket = state.buckets.get(key);
    if (!bucket || bucket.funded === 0n) {
      mockRevert(`BucketNotFunded(${buyer}, ${epoch})`);
    }
    if (bucket.finalized) {
      mockRevert(`BucketAlreadyFinalized(${buyer}, ${epoch})`);
    }

    const proRata = bucket.totalClaimed > bucket.funded;
    let totalFinalized = 0n;
    for (const identityId of state.bucketSellers.get(key) ?? []) {
      const sellerClaim = state.sellerClaims.get(claimKey(buyer, epoch, identityId))!;
      const finalizedValue = proRata
        ? (sellerClaim.claimed * bucket.funded) / bucket.totalClaimed
        : sellerClaim.claimed;
      // Q_i accrues proportionally to the finalized share, exactly like the
      // contract, so the acceptance-time stake factor survives pro-rating.
      const qiScore = (sellerClaim.qiRaw * finalizedValue) / sellerClaim.claimed;
      addTo(state.nodeFinalizedValue, nodeKey(epoch, identityId), finalizedValue);
      addTo(state.nodeQiScore, nodeKey(epoch, identityId), qiScore);
      addTo(state.epochTotalFinalizedValue, epoch.toString(), finalizedValue);
      addTo(state.epochTotalQiScore, epoch.toString(), qiScore);
      totalFinalized += finalizedValue;
    }
    bucket.totalFinalized = totalFinalized;
    bucket.finalized = true;
    addTo(state.openBuckets, epoch.toString(), -1n);
    return state.txResult();
  }

  async marketplaceClaimEpochReward(
    this: MockChainAdapter,
    identityId: bigint,
    epoch: bigint,
  ): Promise<MarketplaceClaimEpochRewardResult> {
    const state = stateFor(this);
    const currentEpoch = await this.getCurrentEpoch();
    if (currentEpoch <= epoch) {
      mockRevert(`SettlementStillOpen(${epoch}, ${currentEpoch})`);
    }
    const remaining = state.openBuckets.get(epoch.toString()) ?? 0n;
    if (remaining !== 0n) {
      mockRevert(`OpenBucketsRemaining(${epoch}, ${remaining})`);
    }
    const totalR = state.epochTotalFinalizedValue.get(epoch.toString()) ?? 0n;
    if (totalR === 0n) {
      mockRevert(`NothingFinalizedForEpoch(${epoch})`);
    }
    if (state.rewardClaimed.has(nodeKey(epoch, identityId))) {
      mockRevert(`RewardAlreadyClaimed(${epoch}, ${identityId})`);
    }
    if (identityId === 0n || (await this.getIdentityId()) !== identityId) {
      mockRevert(`NotOperationalWallet(${identityId}, ${this.signerAddress})`);
    }

    // QIF_i(e) = (1−λ)·R_i/ΣR + λ·Q_i/ΣQ — the contract's exact fixed-point
    // ordering, including the zero-ΣQ guard (that λ-share stays undistributed).
    const totalQ = state.epochTotalQiScore.get(epoch.toString()) ?? 0n;
    const lambda18 = state.lambdaQif18;
    const rTerm18 = ((SCALE18 - lambda18) * (state.nodeFinalizedValue.get(nodeKey(epoch, identityId)) ?? 0n)) / totalR;
    const qTerm18 = totalQ > 0n
      ? (lambda18 * (state.nodeQiScore.get(nodeKey(epoch, identityId)) ?? 0n)) / totalQ
      : 0n;
    const rewardWei = ((state.epochPool.get(epoch.toString()) ?? 0n) * (rTerm18 + qTerm18)) / SCALE18;

    state.rewardClaimed.add(nodeKey(epoch, identityId));
    addTo(state.rewardsPaidWei, this.signerAddress.toLowerCase(), rewardWei);
    return { ...state.txResult(), rewardWei };
  }

  async marketplaceRollEpochPool(this: MockChainAdapter, epoch: bigint): Promise<TxResult> {
    const state = stateFor(this);
    const currentEpoch = await this.getCurrentEpoch();
    if (currentEpoch <= epoch) {
      mockRevert(`SettlementStillOpen(${epoch}, ${currentEpoch})`);
    }
    const remaining = state.openBuckets.get(epoch.toString()) ?? 0n;
    if (remaining !== 0n) {
      mockRevert(`OpenBucketsRemaining(${epoch}, ${remaining})`);
    }
    if ((state.epochTotalFinalizedValue.get(epoch.toString()) ?? 0n) !== 0n) {
      mockRevert(`EpochHasFinalizedValue(${epoch})`);
    }
    const amount = state.epochPool.get(epoch.toString()) ?? 0n;
    if (amount === 0n) {
      mockRevert(`EmptyEpochPool(${epoch})`);
    }
    state.epochPool.set(epoch.toString(), 0n);
    addTo(state.epochPool, currentEpoch.toString(), amount);
    return state.txResult();
  }

  async marketplaceGetBucket(
    this: MockChainAdapter,
    buyer: string,
    epoch: bigint,
  ): Promise<MarketplaceBucket> {
    const bucket = stateFor(this).buckets.get(bucketKey(buyer, epoch));
    return {
      funded: bucket?.funded ?? 0n,
      totalClaimed: bucket?.totalClaimed ?? 0n,
      totalFinalized: bucket?.totalFinalized ?? 0n,
      finalized: bucket?.finalized ?? false,
    };
  }

  async marketplaceGetSellerClaim(
    this: MockChainAdapter,
    buyer: string,
    epoch: bigint,
    identityId: bigint,
  ): Promise<MarketplaceSellerClaim> {
    const sellerClaim = stateFor(this).sellerClaims.get(claimKey(buyer, epoch, identityId));
    return { claimed: sellerClaim?.claimed ?? 0n, qiRaw: sellerClaim?.qiRaw ?? 0n };
  }

  async marketplaceGetNodeEpochAccounting(
    this: MockChainAdapter,
    epoch: bigint,
    identityId: bigint,
  ): Promise<MarketplaceNodeEpochAccounting> {
    const state = stateFor(this);
    return {
      finalizedValue: state.nodeFinalizedValue.get(nodeKey(epoch, identityId)) ?? 0n,
      qiScore: state.nodeQiScore.get(nodeKey(epoch, identityId)) ?? 0n,
      totalFinalizedValue: state.epochTotalFinalizedValue.get(epoch.toString()) ?? 0n,
      totalQiScore: state.epochTotalQiScore.get(epoch.toString()) ?? 0n,
      pool: state.epochPool.get(epoch.toString()) ?? 0n,
      claimed: state.rewardClaimed.has(nodeKey(epoch, identityId)),
    };
  }

  async marketplaceGetActiveSessionKey(this: MockChainAdapter, buyer: string): Promise<string> {
    return stateFor(this).activeSessionKey.get(buyer.toLowerCase()) ?? ethers.ZeroAddress;
  }

  async marketplaceGetParams(this: MockChainAdapter): Promise<MarketplaceParams> {
    const state = stateFor(this);
    return {
      lambdaQif18: state.lambdaQif18,
      settlementGraceSeconds: state.settlementGraceSeconds,
      softCeilingBps: state.softCeilingBps,
    };
  }

  async marketplaceSettlementDeadline(this: MockChainAdapter, epoch: bigint): Promise<bigint> {
    // Chronos.timestampForEpoch(epoch + 1) + grace over the fixed mock
    // schedule: start 0, epoch e spans [(e−1)·len, e·len).
    return epoch * MOCK_MARKETPLACE_EPOCH_LENGTH_SECONDS + stateFor(this).settlementGraceSeconds;
  }
}
