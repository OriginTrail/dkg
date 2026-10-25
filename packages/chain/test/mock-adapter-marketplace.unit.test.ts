/**
 * MockChainAdapter OT-RFC-27 marketplace surface — in-memory mirror of
 * `Marketplace.sol` (see src/mock-adapter-marketplace.ts). Covers the design
 * doc's contract-test matrix chainless: fund→claim→finalize→reward happy
 * path, pro-rata floor over-claim, replay rejection (incl. whole-batch
 * atomicity), wrong-seller digest binding, expired authorizations, session
 * key rotation, non-core seller rejection, pool rollover, and λ / stake
 * factor edge values. Authorization signatures are REAL EIP-191 signatures
 * over the shared `DKG_MKT_AUTH_V1` digest from the domain package, so the
 * replay/binding failures exercise the same crypto the contract verifies.
 */
import { describe, it, expect } from 'vitest';
import { ethers } from 'ethers';
import {
  computeAuthDigest,
  eip191SignDigest,
  offeringIdFor,
} from '@origintrail-official/dkg-marketplace';
import type { ReceiptClaimInput } from '../src/chain-adapter-marketplace.js';
import { MockChainAdapter } from '../src/mock-adapter.js';
import {
  MOCK_MARKETPLACE_ADDRESS,
  MockMarketplaceState,
} from '../src/mock-adapter-marketplace.js';
import { NoChainAdapter } from '../src/no-chain-adapter.js';

const SCALE18 = 10n ** 18n;
const TRAC = 10n ** 18n;
const OFFERING_ID = offeringIdFor('mock-marketplace-offering');
const RESULT_COMMITMENT = ethers.sha256(ethers.toUtf8Bytes('mock result'));

// Deterministic wallets — the repo audit bans Wallet.createRandom.
const buyerWallet = new ethers.Wallet('0x' + '21'.repeat(32));
const sellerAWallet = new ethers.Wallet('0x' + '22'.repeat(32));
const sellerBWallet = new ethers.Wallet('0x' + '23'.repeat(32));
const sessionWallet = new ethers.Wallet('0x' + '24'.repeat(32));
const otherSessionWallet = new ethers.Wallet('0x' + '25'.repeat(32));

let nextCallId = 0;

interface Harness {
  state: MockMarketplaceState;
  buyer: MockChainAdapter;
  sellerA: MockChainAdapter;
  sellerB: MockChainAdapter;
}

/** Buyer + two seller adapters settling against ONE shared marketplace. */
function createHarness(): Harness {
  const buyer = new MockChainAdapter('mock:31337', buyerWallet.address);
  const state = buyer.__marketplaceState();
  const sellerA = new MockChainAdapter('mock:31337', sellerAWallet.address);
  sellerA.seedIdentity(sellerAWallet.address, 7n);
  sellerA.__attachMarketplaceState(state);
  const sellerB = new MockChainAdapter('mock:31337', sellerBWallet.address);
  sellerB.seedIdentity(sellerBWallet.address, 8n);
  sellerB.__attachMarketplaceState(state);
  return { state, buyer, sellerA, sellerB };
}

async function authorizedClaim(h: Harness, opts: {
  sellerIdentityId: bigint;
  servedUnits: bigint;
  askPerUnitWei: bigint;
  epoch?: bigint;
  maxUnits?: bigint;
  expiry?: bigint;
  callId?: string;
  signer?: ethers.Wallet;
}): Promise<ReceiptClaimInput> {
  const callId = opts.callId ?? ethers.id(`mock-marketplace-call-${nextCallId++}`);
  const fields = {
    chainId: 31337n,
    marketplaceAddress: MOCK_MARKETPLACE_ADDRESS,
    buyer: buyerWallet.address,
    sellerIdentityId: opts.sellerIdentityId,
    offeringId: OFFERING_ID,
    callId,
    epoch: opts.epoch ?? 1n,
    maxUnits: opts.maxUnits ?? opts.servedUnits,
    askPerUnitWei: opts.askPerUnitWei,
    expiry: opts.expiry ?? h.state.nowSeconds + 3600n,
  };
  const authSignature = await eip191SignDigest(opts.signer ?? sessionWallet, computeAuthDigest(fields));
  return {
    buyer: fields.buyer,
    epoch: fields.epoch,
    offeringId: fields.offeringId,
    callId: fields.callId,
    maxUnits: fields.maxUnits,
    askPerUnitWei: fields.askPerUnitWei,
    expiry: fields.expiry,
    servedUnits: opts.servedUnits,
    resultCommitment: RESULT_COMMITMENT,
    authSignature,
  };
}

async function fund(h: Harness, amountWei: bigint, epoch = 1n, sessionKey: string | undefined = sessionWallet.address) {
  return h.buyer.marketplaceFundSubscription({ amountWei, sessionKey, epoch });
}

describe('MockChainAdapter marketplace — capability + funding', () => {
  it('reports the capability, address and default params', async () => {
    const h = createHarness();
    expect(h.buyer.supportsMarketplace()).toBe(true);
    await expect(h.buyer.marketplaceGetAddress()).resolves.toBe(MOCK_MARKETPLACE_ADDRESS);
    const params = await h.buyer.marketplaceGetParams();
    expect(params.lambdaQif18).toBe(400_000_000_000_000_000n);
    expect(params.settlementGraceSeconds).toBe(900n);
    expect(params.softCeilingBps).toBe(9500);
    expect(params.rewardCapMultiple).toBe(10);
    // Chronos mirror: timestampForEpoch(epoch + 1) + grace over the 3600s mock schedule.
    await expect(h.buyer.marketplaceSettlementDeadline(1n)).resolves.toBe(3600n + 900n);
    // Unknown lookups answer Solidity's zero-init shapes.
    const bucket = await h.buyer.marketplaceGetBucket(buyerWallet.address, 1n);
    expect(bucket).toEqual({ funded: 0n, totalClaimed: 0n, totalFinalized: 0n, finalized: false });
    await expect(h.buyer.marketplaceGetActiveSessionKey(buyerWallet.address)).resolves.toBe(ethers.ZeroAddress);
    // Chain-time read: backed by the same clock the expiry checks enforce.
    h.state.nowSeconds = 7_777n;
    await expect(h.buyer.getLatestBlockTimestamp()).resolves.toBe(7_777n);
  });

  it('funds a bucket, registers the session key and accrues the epoch pool', async () => {
    const h = createHarness();
    await expect(h.buyer.getCurrentEpoch()).resolves.toBe(1n);
    const tx = await fund(h, 10n * TRAC);
    expect(tx.success).toBe(true);
    await expect(h.buyer.marketplaceGetActiveSessionKey(buyerWallet.address)).resolves.toBe(sessionWallet.address);
    const bucket = await h.sellerA.marketplaceGetBucket(buyerWallet.address, 1n);
    expect(bucket.funded).toBe(10n * TRAC);
    const accounting = await h.sellerA.marketplaceGetNodeEpochAccounting(1n, 7n);
    expect(accounting.pool).toBe(10n * TRAC);
    // Re-funding the same bucket keeps the key without naming it again.
    await h.buyer.marketplaceFundSubscription({ amountWei: TRAC, epoch: 1n });
    expect((await h.buyer.marketplaceGetBucket(buyerWallet.address, 1n)).funded).toBe(11n * TRAC);
  });

  it('rejects the contract funding faults', async () => {
    const h = createHarness();
    await expect(fund(h, 0n)).rejects.toThrow('ZeroTokenAmount');
    // No registered key yet, so omitting the session key is rejected.
    await expect(h.buyer.marketplaceFundSubscription({ amountWei: TRAC, epoch: 1n }))
      .rejects.toThrow('NoActiveSessionKey');
    // Only current or current+1 epochs accept funding.
    await expect(fund(h, TRAC, 3n)).rejects.toThrow('InvalidSubscriptionEpoch');
    await expect(fund(h, TRAC, 2n)).resolves.toMatchObject({ success: true });
    // Bindings are per-buyer: another buyer binding the same session key is
    // harmless (no global squatting surface) and both bindings work.
    const otherBuyer = new MockChainAdapter('mock:31337', sellerBWallet.address);
    otherBuyer.__attachMarketplaceState(h.state);
    await expect(otherBuyer.marketplaceFundSubscription({
      amountWei: TRAC, sessionKey: sessionWallet.address, epoch: 1n,
    })).resolves.toMatchObject({ success: true });
    await expect(otherBuyer.marketplaceGetActiveSessionKey(sellerBWallet.address))
      .resolves.toBe(sessionWallet.address);
    await expect(h.buyer.marketplaceGetActiveSessionKey(buyerWallet.address))
      .resolves.toBe(sessionWallet.address);
  });

  it('zero-ask claims are rejected and never enroll the seller', async () => {
    const h = createHarness();
    await fund(h, TRAC);
    const zeroAsk = await authorizedClaim(h, { sellerIdentityId: 7n, servedUnits: 5n, askPerUnitWei: 0n });
    await expect(h.sellerA.marketplaceSubmitReceiptBatch([zeroAsk])).rejects.toThrow('ZeroClaimValue');
    const sellerClaim = await h.sellerA.marketplaceGetSellerClaim(buyerWallet.address, 1n, 7n);
    expect(sellerClaim).toEqual({ claimed: 0n, qiRaw: 0n, enrolled: false });
    // The bucket still finalizes (nothing was enrolled with zero value).
    h.sellerA.__advanceEpoch();
    await expect(h.sellerA.marketplaceFinalizeBucket(buyerWallet.address, 1n))
      .resolves.toMatchObject({ success: true });
  });
});

describe('MockChainAdapter marketplace — receipt batches', () => {
  it('settles the full fund → claim → finalize → reward happy path', async () => {
    const h = createHarness();
    // Uncapped path (rewardCapMultiple = 0): identical to pre-cap behavior —
    // the sole claimant's QIF reward sweeps the whole pool.
    h.state.rewardCapMultiple = 0;
    await fund(h, 10n * TRAC);
    const ask = 500_000_000_000n; // 0.5 µTRAC per token-unit, the devnet ask
    const claims = [
      await authorizedClaim(h, { sellerIdentityId: 7n, servedUnits: 640n, askPerUnitWei: ask, maxUnits: 1000n }),
      await authorizedClaim(h, { sellerIdentityId: 7n, servedUnits: 360n, askPerUnitWei: ask, maxUnits: 1000n }),
    ];
    await h.sellerA.marketplaceSubmitReceiptBatch(claims);

    const expectedValue = 1000n * ask;
    const sellerClaim = await h.sellerA.marketplaceGetSellerClaim(buyerWallet.address, 1n, 7n);
    expect(sellerClaim.claimed).toBe(expectedValue);
    expect(sellerClaim.qiRaw).toBe(expectedValue); // default S18 = 1e18
    expect(sellerClaim.enrolled).toBe(true);
    expect((await h.buyer.marketplaceGetBucket(buyerWallet.address, 1n)).totalClaimed).toBe(expectedValue);

    // Settlement opens once the epoch counter passes the bucket's epoch.
    await expect(h.sellerA.marketplaceFinalizeBucket(buyerWallet.address, 1n))
      .rejects.toThrow('SettlementStillOpen');
    h.sellerA.__advanceEpoch();
    await h.sellerA.marketplaceFinalizeBucket(buyerWallet.address, 1n);
    const bucket = await h.sellerA.marketplaceGetBucket(buyerWallet.address, 1n);
    expect(bucket.finalized).toBe(true);
    expect(bucket.totalFinalized).toBe(expectedValue); // within funding → 1:1

    // Sole claimant: QIF = (1−λ) + λ = 1e18, so the reward is the whole pool.
    const { rewardWei } = await h.sellerA.marketplaceClaimEpochReward(7n, 1n);
    expect(rewardWei).toBe(10n * TRAC);
    expect(h.state.rewardsPaidWei.get(sellerAWallet.address.toLowerCase())).toBe(10n * TRAC);
    await expect(h.sellerA.marketplaceClaimEpochReward(7n, 1n)).rejects.toThrow('RewardAlreadyClaimed');
    expect((await h.sellerA.marketplaceGetNodeEpochAccounting(1n, 7n)).claimed).toBe(true);
  });

  it('rejects replays — and a single bad claim voids the whole batch', async () => {
    const h = createHarness();
    await fund(h, TRAC);
    const claim = await authorizedClaim(h, { sellerIdentityId: 7n, servedUnits: 5n, askPerUnitWei: 100n });
    const digest = computeAuthDigest({
      chainId: 31337n,
      marketplaceAddress: MOCK_MARKETPLACE_ADDRESS,
      buyer: claim.buyer,
      sellerIdentityId: 7n,
      offeringId: claim.offeringId,
      callId: claim.callId,
      epoch: claim.epoch,
      maxUnits: claim.maxUnits,
      askPerUnitWei: claim.askPerUnitWei,
      expiry: claim.expiry,
    });
    await expect(h.sellerA.marketplaceIsAuthConsumed(digest)).resolves.toBe(false);
    await h.sellerA.marketplaceSubmitReceiptBatch([claim]);
    // The durable replay guard is readable (cold-restart seller pre-check).
    await expect(h.sellerA.marketplaceIsAuthConsumed(digest)).resolves.toBe(true);
    await expect(h.sellerA.marketplaceSubmitReceiptBatch([claim]))
      .rejects.toThrow('AuthorizationAlreadyConsumed');

    // Batch atomicity: the fresh claim rides with a replay and must NOT land.
    const fresh = await authorizedClaim(h, { sellerIdentityId: 7n, servedUnits: 3n, askPerUnitWei: 100n });
    await expect(h.sellerA.marketplaceSubmitReceiptBatch([fresh, claim]))
      .rejects.toThrow('AuthorizationAlreadyConsumed');
    expect((await h.sellerA.marketplaceGetSellerClaim(buyerWallet.address, 1n, 7n)).claimed).toBe(500n);
    // Intra-batch duplicates are a replay too.
    const dup = await authorizedClaim(h, { sellerIdentityId: 7n, servedUnits: 2n, askPerUnitWei: 100n });
    await expect(h.sellerA.marketplaceSubmitReceiptBatch([dup, dup]))
      .rejects.toThrow('AuthorizationAlreadyConsumed');
    // The voided batch consumed nothing: the same fresh claim lands alone.
    await h.sellerA.marketplaceSubmitReceiptBatch([fresh]);
    expect((await h.sellerA.marketplaceGetSellerClaim(buyerWallet.address, 1n, 7n)).claimed).toBe(800n);
  });

  it('enforces the per-claim objective-fault checks', async () => {
    const h = createHarness();
    await fund(h, TRAC);

    // The digest binds the seller identity: an authorization written for
    // seller 8 fails signature verification when seller 7 submits it.
    const forSellerB = await authorizedClaim(h, { sellerIdentityId: 8n, servedUnits: 5n, askPerUnitWei: 100n });
    await expect(h.sellerA.marketplaceSubmitReceiptBatch([forSellerB]))
      .rejects.toThrow('InvalidAuthorizationSignature');
    // ...while the authorized seller settles it fine.
    await expect(h.sellerB.marketplaceSubmitReceiptBatch([forSellerB])).resolves.toMatchObject({ success: true });

    // A signature from a key that is not the registered session key fails.
    const wrongKey = await authorizedClaim(h, {
      sellerIdentityId: 7n, servedUnits: 5n, askPerUnitWei: 100n, signer: otherSessionWallet,
    });
    await expect(h.sellerA.marketplaceSubmitReceiptBatch([wrongKey]))
      .rejects.toThrow('InvalidAuthorizationSignature');

    const expired = await authorizedClaim(h, {
      sellerIdentityId: 7n, servedUnits: 5n, askPerUnitWei: 100n, expiry: h.state.nowSeconds - 1n,
    });
    await expect(h.sellerA.marketplaceSubmitReceiptBatch([expired])).rejects.toThrow('AuthorizationExpired');

    const zeroUnits = await authorizedClaim(h, {
      sellerIdentityId: 7n, servedUnits: 0n, askPerUnitWei: 100n, maxUnits: 5n,
    });
    await expect(h.sellerA.marketplaceSubmitReceiptBatch([zeroUnits])).rejects.toThrow('ZeroServedUnits');

    const overMax = await authorizedClaim(h, {
      sellerIdentityId: 7n, servedUnits: 6n, askPerUnitWei: 100n, maxUnits: 5n,
    });
    await expect(h.sellerA.marketplaceSubmitReceiptBatch([overMax])).rejects.toThrow('ServedOverMaxUnits');

    const unfunded = await authorizedClaim(h, { sellerIdentityId: 7n, servedUnits: 5n, askPerUnitWei: 100n, epoch: 2n });
    await expect(h.sellerA.marketplaceSubmitReceiptBatch([unfunded])).rejects.toThrow('BucketNotFunded');

    // A wallet with no registered node identity is not a core node.
    const nonCore = new MockChainAdapter('mock:31337', otherSessionWallet.address);
    nonCore.__attachMarketplaceState(h.state);
    const anyClaim = await authorizedClaim(h, { sellerIdentityId: 9n, servedUnits: 5n, askPerUnitWei: 100n });
    await expect(nonCore.marketplaceSubmitReceiptBatch([anyClaim])).rejects.toThrow('NotACoreNode');
    await expect(h.sellerA.marketplaceSubmitReceiptBatch([])).rejects.toThrow('EmptyReceiptBatch');
  });

  it('closes the settlement window; rotation keeps historically bound keys settling', async () => {
    const h = createHarness();
    await fund(h, TRAC);
    // Rotate the session key: the active key changes, but the retired key
    // stays in the buyer's bound set.
    await h.buyer.marketplaceFundSubscription({
      amountWei: TRAC, sessionKey: otherSessionWallet.address, epoch: 1n,
    });
    await expect(h.buyer.marketplaceGetActiveSessionKey(buyerWallet.address))
      .resolves.toBe(otherSessionWallet.address);
    // Authorizations signed by the retired key STILL settle (the buyer cannot
    // consume service and then rotate to stiff the seller)...
    const oldKey = await authorizedClaim(h, { sellerIdentityId: 7n, servedUnits: 5n, askPerUnitWei: 100n });
    await expect(h.sellerA.marketplaceSubmitReceiptBatch([oldKey]))
      .resolves.toMatchObject({ success: true });
    // ...the rotated key authorizes too...
    const newKey = await authorizedClaim(h, {
      sellerIdentityId: 7n, servedUnits: 5n, askPerUnitWei: 100n, signer: otherSessionWallet,
    });
    await h.sellerA.marketplaceSubmitReceiptBatch([newKey]);
    // ...and a key the buyer never bound is rejected.
    const strangerWallet = new ethers.Wallet('0x' + '26'.repeat(32));
    const neverBound = await authorizedClaim(h, {
      sellerIdentityId: 7n, servedUnits: 5n, askPerUnitWei: 100n, signer: strangerWallet,
    });
    await expect(h.sellerA.marketplaceSubmitReceiptBatch([neverBound]))
      .rejects.toThrow('InvalidAuthorizationSignature');

    // Past the epoch, receipts for it are no longer accepted.
    h.sellerA.__advanceEpoch();
    const late = await authorizedClaim(h, {
      sellerIdentityId: 7n, servedUnits: 2n, askPerUnitWei: 100n, signer: otherSessionWallet,
    });
    await expect(h.sellerA.marketplaceSubmitReceiptBatch([late])).rejects.toThrow('SettlementClosed');
  });

  it('a finalized bucket accepts no claims and enrollment stays single-entry', async () => {
    const h = createHarness();
    await fund(h, TRAC);
    // Several claims from one seller: one membership entry, every value accrued.
    for (const servedUnits of [3n, 4n]) {
      await h.sellerA.marketplaceSubmitReceiptBatch([
        await authorizedClaim(h, { sellerIdentityId: 7n, servedUnits, askPerUnitWei: 100n }),
      ]);
    }
    expect(h.state.bucketSellers.get(`${buyerWallet.address.toLowerCase()}|1`)).toEqual([7n]);

    h.sellerA.__advanceEpoch();
    await h.sellerA.marketplaceFinalizeBucket(buyerWallet.address, 1n);
    // The seller is credited exactly once: 700, not a multiple of it.
    expect((await h.sellerA.marketplaceGetNodeEpochAccounting(1n, 7n)).finalizedValue).toBe(700n);

    // Claims against the finalized bucket are rejected ahead of the window
    // check (mirrors ClaimsClosedForBucket ordering in `_acceptClaim`).
    const late = await authorizedClaim(h, { sellerIdentityId: 7n, servedUnits: 1n, askPerUnitWei: 100n });
    await expect(h.sellerA.marketplaceSubmitReceiptBatch([late])).rejects.toThrow('ClaimsClosedForBucket');
  });
});

describe('MockChainAdapter marketplace — finalization, QIF rewards, rollover', () => {
  it('pro-rates an over-claimed bucket with floor semantics and no order priority', async () => {
    const h = createHarness();
    await fund(h, 1000n);
    await h.sellerA.marketplaceSubmitReceiptBatch([
      await authorizedClaim(h, { sellerIdentityId: 7n, servedUnits: 7n, askPerUnitWei: 100n }),
    ]);
    await h.sellerB.marketplaceSubmitReceiptBatch([
      await authorizedClaim(h, { sellerIdentityId: 8n, servedUnits: 6n, askPerUnitWei: 100n }),
    ]);
    h.sellerA.__advanceEpoch();
    h.sellerB.__advanceEpoch();
    await h.sellerA.marketplaceFinalizeBucket(buyerWallet.address, 1n);
    await expect(h.sellerB.marketplaceFinalizeBucket(buyerWallet.address, 1n))
      .rejects.toThrow('BucketAlreadyFinalized');

    // claimed 700 + 600 = 1300 > funded 1000 → floor(claimed·1000/1300) each.
    const accountingA = await h.sellerA.marketplaceGetNodeEpochAccounting(1n, 7n);
    const accountingB = await h.sellerB.marketplaceGetNodeEpochAccounting(1n, 8n);
    expect(accountingA.finalizedValue).toBe(538n);
    expect(accountingB.finalizedValue).toBe(461n);
    expect(accountingA.totalFinalizedValue).toBe(999n); // 1-wei floor residue stays pooled
    expect((await h.buyer.marketplaceGetBucket(buyerWallet.address, 1n)).totalFinalized).toBe(999n);

    // Default λ = 0.4e18, equal stake factors → QIF follows the R ratio.
    const lambda = h.state.lambdaQif18;
    const qifA = ((SCALE18 - lambda) * 538n) / 999n + (lambda * 538n) / 999n;
    const { rewardWei } = await h.sellerA.marketplaceClaimEpochReward(7n, 1n);
    expect(rewardWei).toBe((1000n * qifA) / SCALE18);
  });

  it('paginated finalization (maxSellers cursor) equals the one-shot sweep', async () => {
    const run = async (maxSellers?: bigint) => {
      const h = createHarness();
      await fund(h, 1000n);
      await h.sellerA.marketplaceSubmitReceiptBatch([
        await authorizedClaim(h, { sellerIdentityId: 7n, servedUnits: 7n, askPerUnitWei: 100n }),
      ]);
      await h.sellerB.marketplaceSubmitReceiptBatch([
        await authorizedClaim(h, { sellerIdentityId: 8n, servedUnits: 6n, askPerUnitWei: 100n }),
      ]);
      h.sellerA.__advanceEpoch();
      if (maxSellers === undefined) {
        await h.sellerA.marketplaceFinalizeBucket(buyerWallet.address, 1n);
      } else {
        // One claimant per call: the first page leaves the bucket open...
        await h.sellerA.marketplaceFinalizeBucket(buyerWallet.address, 1n, maxSellers);
        expect((await h.sellerA.marketplaceGetBucket(buyerWallet.address, 1n)).finalized).toBe(false);
        await expect(h.sellerA.marketplaceClaimEpochReward(7n, 1n)).rejects.toThrow('OpenBucketsRemaining');
        // ...and the second page closes it.
        await h.sellerA.marketplaceFinalizeBucket(buyerWallet.address, 1n, maxSellers);
      }
      return {
        bucket: await h.sellerA.marketplaceGetBucket(buyerWallet.address, 1n),
        acctA: await h.sellerA.marketplaceGetNodeEpochAccounting(1n, 7n),
        acctB: await h.sellerB.marketplaceGetNodeEpochAccounting(1n, 8n),
      };
    };

    const oneShot = await run();
    const paginated = await run(1n);
    expect(paginated.bucket).toEqual(oneShot.bucket);
    expect(paginated.acctA).toEqual(oneShot.acctA);
    expect(paginated.acctB).toEqual(oneShot.acctB);
    expect(oneShot.bucket.finalized).toBe(true);
  });

  it('caps the epoch reward at rewardCapMultiple·R_i and reports the remainder', async () => {
    const h = createHarness();
    await fund(h, 10n * TRAC);
    // Tiny finalized value in a big pool: uncapped QIF would sweep the pool.
    await h.sellerA.marketplaceSubmitReceiptBatch([
      await authorizedClaim(h, { sellerIdentityId: 7n, servedUnits: 5n, askPerUnitWei: 100n }),
    ]);
    h.sellerA.__advanceEpoch();
    await h.sellerA.marketplaceFinalizeBucket(buyerWallet.address, 1n);

    // Default cap multiple 10 → payout = 10 · 500 wei, not 10 TRAC.
    const { rewardWei } = await h.sellerA.marketplaceClaimEpochReward(7n, 1n);
    expect(rewardWei).toBe(5000n);
    expect(h.state.rewardsPaidWei.get(sellerAWallet.address.toLowerCase())).toBe(5000n);
    await expect(h.sellerA.marketplaceGetEpochRewardDistribution(1n)).resolves.toEqual({
      pool: 10n * TRAC,
      distributed: 5000n,
      undistributed: 10n * TRAC - 5000n,
    });
  });

  it('blends rewards by λ and the per-identity stake factor', async () => {
    const h = createHarness();
    // λ = 1e18: pure Q_i/ΣQ. Seller B's stake factor is a quarter of A's,
    // so with equal claimed value Q_B = Q_A/4 → rewards split 4:1.
    h.state.lambdaQif18 = SCALE18;
    h.state.stakeFactor18ByIdentity.set(8n, SCALE18 / 4n);
    await fund(h, 1000n);
    await h.sellerA.marketplaceSubmitReceiptBatch([
      await authorizedClaim(h, { sellerIdentityId: 7n, servedUnits: 4n, askPerUnitWei: 100n }),
    ]);
    await h.sellerB.marketplaceSubmitReceiptBatch([
      await authorizedClaim(h, { sellerIdentityId: 8n, servedUnits: 4n, askPerUnitWei: 100n }),
    ]);
    h.sellerA.__advanceEpoch();
    h.sellerB.__advanceEpoch();
    await h.sellerA.marketplaceFinalizeBucket(buyerWallet.address, 1n);
    expect((await h.sellerA.marketplaceClaimEpochReward(7n, 1n)).rewardWei).toBe(800n);
    expect((await h.sellerB.marketplaceClaimEpochReward(8n, 1n)).rewardWei).toBe(200n);

    // λ = 0: pure R_i/ΣR — the stake factor no longer matters.
    const h2 = createHarness();
    h2.state.lambdaQif18 = 0n;
    h2.state.stakeFactor18ByIdentity.set(8n, 0n);
    await fund(h2, 1000n);
    await h2.sellerA.marketplaceSubmitReceiptBatch([
      await authorizedClaim(h2, { sellerIdentityId: 7n, servedUnits: 3n, askPerUnitWei: 100n }),
    ]);
    await h2.sellerB.marketplaceSubmitReceiptBatch([
      await authorizedClaim(h2, { sellerIdentityId: 8n, servedUnits: 1n, askPerUnitWei: 100n }),
    ]);
    h2.sellerA.__advanceEpoch();
    h2.sellerB.__advanceEpoch();
    await h2.sellerA.marketplaceFinalizeBucket(buyerWallet.address, 1n);
    expect((await h2.sellerA.marketplaceClaimEpochReward(7n, 1n)).rewardWei).toBe(750n);
    expect((await h2.sellerB.marketplaceClaimEpochReward(8n, 1n)).rewardWei).toBe(250n);

    // ΣQ = 0 (every claimant at zero stake) + λ = 1e18: the λ term guards
    // division-by-zero and that pool share stays undistributed.
    const h3 = createHarness();
    h3.state.lambdaQif18 = SCALE18;
    h3.state.stakeFactor18ByIdentity.set(7n, 0n);
    await fund(h3, 1000n);
    await h3.sellerA.marketplaceSubmitReceiptBatch([
      await authorizedClaim(h3, { sellerIdentityId: 7n, servedUnits: 2n, askPerUnitWei: 100n }),
    ]);
    h3.sellerA.__advanceEpoch();
    await h3.sellerA.marketplaceFinalizeBucket(buyerWallet.address, 1n);
    expect((await h3.sellerA.marketplaceClaimEpochReward(7n, 1n)).rewardWei).toBe(0n);
  });

  it('gates rewards on settled epochs and rolls unused pools forward', async () => {
    const h = createHarness();
    await fund(h, 5n * TRAC);
    h.sellerA.__advanceEpoch();
    // The funded bucket is still open → no rewards, no rollover.
    await expect(h.sellerA.marketplaceClaimEpochReward(7n, 1n)).rejects.toThrow('OpenBucketsRemaining');
    await expect(h.sellerA.marketplaceRollEpochPool(1n)).rejects.toThrow('OpenBucketsRemaining');
    // Finalizing the claimless bucket closes it with zero finalized value...
    await h.sellerA.marketplaceFinalizeBucket(buyerWallet.address, 1n);
    await expect(h.sellerA.marketplaceClaimEpochReward(7n, 1n)).rejects.toThrow('NothingFinalizedForEpoch');
    // ...which is exactly the RFC rollover case: the pool moves to the current epoch.
    await h.sellerA.marketplaceRollEpochPool(1n);
    expect((await h.sellerA.marketplaceGetNodeEpochAccounting(1n, 7n)).pool).toBe(0n);
    expect((await h.sellerA.marketplaceGetNodeEpochAccounting(2n, 7n)).pool).toBe(5n * TRAC);
    await expect(h.sellerA.marketplaceRollEpochPool(1n)).rejects.toThrow('EmptyEpochPool');
    await expect(h.sellerA.marketplaceRollEpochPool(2n)).rejects.toThrow('SettlementStillOpen');

    // An epoch WITH finalized value never rolls.
    const h2 = createHarness();
    await fund(h2, 1000n);
    await h2.sellerA.marketplaceSubmitReceiptBatch([
      await authorizedClaim(h2, { sellerIdentityId: 7n, servedUnits: 1n, askPerUnitWei: 100n }),
    ]);
    h2.sellerA.__advanceEpoch();
    await h2.sellerA.marketplaceFinalizeBucket(buyerWallet.address, 1n);
    await expect(h2.sellerA.marketplaceRollEpochPool(1n)).rejects.toThrow('EpochHasFinalizedValue');
    // And claiming someone else's identity from this wallet is rejected.
    await expect(h2.sellerA.marketplaceClaimEpochReward(8n, 1n)).rejects.toThrow('NotOperationalWallet');
  });
});

describe('NoChainAdapter marketplace stubs', () => {
  it('answers supportsMarketplace() false and throws on every marketplace method', async () => {
    const none = new NoChainAdapter();
    expect(none.supportsMarketplace()).toBe(false);
    await expect(none.getCurrentEpoch()).rejects.toThrow('No blockchain configured');
    await expect(none.marketplaceGetAddress()).rejects.toThrow('No blockchain configured');
    await expect(none.getLatestBlockTimestamp()).rejects.toThrow('No blockchain configured');
    await expect(none.marketplaceIsAuthConsumed('0x' + '00'.repeat(32))).rejects.toThrow('No blockchain configured');
    await expect(none.marketplaceFundSubscription({ amountWei: 1n, epoch: 1n }))
      .rejects.toThrow('No blockchain configured');
    await expect(none.marketplaceSubmitReceiptBatch([])).rejects.toThrow('No blockchain configured');
    await expect(none.marketplaceFinalizeBucket(buyerWallet.address, 1n)).rejects.toThrow('No blockchain configured');
    await expect(none.marketplaceClaimEpochReward(1n, 1n)).rejects.toThrow('No blockchain configured');
    await expect(none.marketplaceRollEpochPool(1n)).rejects.toThrow('No blockchain configured');
    await expect(none.marketplaceGetBucket(buyerWallet.address, 1n)).rejects.toThrow('No blockchain configured');
    await expect(none.marketplaceGetSellerClaim(buyerWallet.address, 1n, 1n)).rejects.toThrow('No blockchain configured');
    await expect(none.marketplaceGetNodeEpochAccounting(1n, 1n)).rejects.toThrow('No blockchain configured');
    await expect(none.marketplaceGetActiveSessionKey(buyerWallet.address)).rejects.toThrow('No blockchain configured');
    await expect(none.marketplaceGetParams()).rejects.toThrow('No blockchain configured');
    await expect(none.marketplaceGetEpochRewardDistribution(1n)).rejects.toThrow('No blockchain configured');
    await expect(none.marketplaceSettlementDeadline(1n)).rejects.toThrow('No blockchain configured');
  });
});
