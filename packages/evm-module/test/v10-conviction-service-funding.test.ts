// Conviction Account service spending (OT-RFC-27) end to end: funding a plan
// period, on ServiceSubscriptions and ConvictionServiceStorage registered in the
// Hub, drawing through the real PublishingConviction 10.2.0 on the real account
// stack. A funding pays as a wallet does: its whole cost is booked as due in
// QueryInferenceStorage, in the epoch after the period, and nothing reaches the
// staker pool.
//
// Groups:
//   - fund, happy path: every discount tier, the 1-wei floor, the top-up branch,
//     each with its cost due after the period;
//   - fund, refusals: the period limit, the period's epoch, the buckets, the
//     assignment, the allowance, an expired account, a wired treasury, the gate
//     on coverServiceCost, a mismatched draw and an account scheduled in full,
//     each without partial effect;
//   - period records: the record is always visible, and a buyer key funds one
//     period per epoch;
//   - no TRAC moves: no Token log, an unchanged vault, and an unchanged staker
//     pool, for a base-only funding and a top-up funding alike;
//   - views: previewCost, and currentWindowAllowance against
//     getRemainingAllowance.
//
// The opt-in and the assignments are in v10-conviction-service-assignments.test.ts,
// and the allowance shared with publishing in
// v10-conviction-service-publishing.test.ts.

import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { loadFixture, time } from '@nomicfoundation/hardhat-network-helpers';
import { expect } from 'chai';
import { ContractTransactionReceipt, ethers } from 'ethers';
import hre from 'hardhat';

import { MockSkewedServiceDraw } from '../typechain';
import { STAKER_SHARD_ID, blockTime, eventsOf } from './helpers/account-stack';
import {
  CLASS_INFERENCE,
  CLASS_QUERY,
  DAY,
  SESSION_KEY,
  TRAC,
  Terms,
  bucket,
  costOf,
  requestOf,
  valueFor,
} from './helpers/conviction-service';
import { COMMITTED, ServiceHelpers, ServiceStack, deployServiceStack, serviceHelpers } from './helpers/conviction-service-stack';
import { deployScheduleHarness } from './helpers/scheduled-accounts';

const MAX_UINT96 = (1n << 96n) - 1n;
// No discount, so a cost equals its value; the window allowance is 1,000 TRAC.
const SMALL = 12_000n * TRAC + 5n;
// The committed amounts that open each discount tier, and the tier.
const TIERS: Array<[bigint, bigint]> = [
  [1_000n * TRAC, 0n],
  [25_000n * TRAC, 1_000n],
  [50_000n * TRAC, 2_000n],
  [100_000n * TRAC, 3_000n],
  [250_000n * TRAC, 4_000n],
  [500_000n * TRAC, 5_000n],
  [1_000_000n * TRAC, 7_500n],
];
// A limit that no test of the draw itself reaches.
const WIDE: Partial<Terms> = { maxCostPerPeriod: 50_000n * TRAC };

/** This suite's own fixture, so loadFixture keeps a snapshot for it alone. */
async function deployFixture() {
  return deployServiceStack();
}

describe('@integration Conviction Account service spending (ServiceSubscriptions)', function () {
  let f: ServiceStack;
  let h: ServiceHelpers;

  let epLen: bigint;
  let lock: bigint;
  let owner: SignerWithAddress;
  let buyer: SignerWithAddress;
  let stranger: SignerWithAddress;
  let buyer2: SignerWithAddress;
  let treasury: SignerWithAddress;

  beforeEach(async () => {
    hre.helpers.resetDeploymentsJson();
    f = await loadFixture(deployFixture);
    epLen = await f.Chronos.epochLength();
    lock = await f.Params.publishingConvictionEpochs();
    owner = f.accounts[20];
    buyer = f.accounts[21];
    stranger = f.accounts[22];
    buyer2 = f.accounts[25];
    treasury = f.accounts[28];
    h = serviceHelpers({ f, owner, buyer, epLen, lock });
  });

  // -------------------------------------------------------------------------
  // Fund, happy path
  // -------------------------------------------------------------------------

  describe('fund, happy path', () => {
    for (const [committed, bps] of TIERS) {
      it(`at the ${Number(bps) / 100} % tier: the cost, the events, the record, the buckets and the usage`, async () => {
        const { accountId, createdAt } = await h.openAccount({ committed: committed + 11n, caps: WIDE });
        const r = requestOf(accountId, await h.epochNow(), {
          buckets: [bucket(0, CLASS_INFERENCE, 7n * TRAC + 3n), bucket(1, CLASS_QUERY, 3n * TRAC + 1n)],
        });
        const value = 10n * TRAC + 4n;
        const cost = costOf(value, bps);
        expect(await f.SS.previewCost(accountId, value)).to.deep.equal([cost, bps]);

        const { subscriptionId, cost: returned, receipt } = await h.fund(r);
        expect(returned).to.equal(cost);
        expect(subscriptionId).to.equal(await f.SS.subscriptionIdOf(buyer.address, r.epoch));
        const ts = await blockTime(receipt);
        const epoch = await f.Chronos.epochAtTimestamp(ts);
        expect(epoch).to.equal(r.epoch);
        const periodEnd = await f.Chronos.timestampForEpoch(epoch + 1n);
        const window = (ts - createdAt) / epLen;

        const [covered] = await eventsOf(receipt, f.PC, 'ServiceCostCovered');
        expect([...covered]).to.deep.equal([accountId, buyer.address, subscriptionId, value, cost, epoch, window, cost, 0n]);

        const funded = await eventsOf(receipt, f.SS, 'PeriodFunded');
        expect(funded).to.have.length(1);
        const pf = funded[0];
        expect([
          pf.subscriptionId,
          pf.accountId,
          pf.assignee,
          pf.epoch,
          pf.sessionKey,
          pf.planDigest,
          pf.periodStart,
          pf.periodEnd,
          pf.value,
          pf.cost,
          pf.discountBps,
        ]).to.deep.equal([
          subscriptionId,
          accountId,
          buyer.address,
          r.epoch,
          SESSION_KEY,
          r.planDigest,
          ts,
          periodEnd,
          value,
          cost,
          bps,
        ]);
        const asTuples = (bs: Array<{ bucketId: string; serviceClass: bigint; value: bigint; maxAskWeiPerUnit: bigint }>) =>
          bs.map((b) => [b.bucketId, b.serviceClass, b.value, b.maxAskWeiPerUnit]);
        expect(asTuples(pf.buckets)).to.deep.equal(asTuples(r.buckets));

        const s = await f.CSS.getSubscription(subscriptionId);
        expect(h.plain(s)).to.deep.equal({
          accountId,
          assignee: buyer.address,
          assignmentNonce: (await f.CSS.getAssignment(accountId, buyer.address)).nonce,
          sessionKey: SESSION_KEY,
          epoch: r.epoch,
          planDigest: r.planDigest,
          periodStart: ts,
          periodEnd,
          fundedEpoch: epoch,
          fundedWindow: window,
          discountBps: bps,
          bucketCount: 2n,
          value,
          cost,
          drawnFromWindow: cost,
          drawnFromTopUp: 0n,
        });
        expect(asTuples(await f.CSS.getBuckets(subscriptionId))).to.deep.equal(asTuples(r.buckets));
        expect(await f.CSS.accountSubscriptionCount(accountId)).to.equal(1n);
        expect(await f.CSS.accountSubscriptionAt(accountId, 0n)).to.equal(subscriptionId);

        expect(h.plain(await f.CSS.getUsage(accountId, buyer.address))).to.deep.equal({ periods: 1n });
        expect(await f.PCS.windowSpent(accountId, window)).to.equal(cost);

        // The whole cost is due in the epoch after the period, as a wallet
        // period's value is, and nothing in any other epoch or ledger.
        expect(await f.QIS.convictionDue(epoch + 1n)).to.equal(cost);
        expect(await f.QIS.convictionDue(epoch)).to.equal(0n);
        expect(await f.QIS.convictionDue(epoch + 2n)).to.equal(0n);
        expect(await f.QIS.walletDue(epoch + 1n)).to.equal(0n);
        expect(await h.creditedRanges(receipt)).to.have.length(0);
      });
    }

    it('the 1-wei floor: a value the discount rounds to 0 costs 1 wei', async () => {
      const { accountId } = await h.openAccount({ committed: 1_000_000n * TRAC, caps: WIDE });
      const { cost, receipt } = await h.fund(await h.inference(accountId, 3n));
      expect(cost).to.equal(1n);
      const [covered] = await eventsOf(receipt, f.PC, 'ServiceCostCovered');
      expect([covered.value, covered.cost, covered.drawnFromWindow]).to.deep.equal([3n, 1n, 1n]);
      expect(await f.QIS.convictionDue((await h.epochNow()) + 1n)).to.equal(1n);
      expect((await f.CSS.getSubscription(await f.SS.subscriptionIdOf(buyer.address, await h.epochNow()))).cost).to.equal(1n);
    });

    it('once the window is spent, the cost comes from the top-up buffer, is due after the period, and reaches no staker pool', async () => {
      const { accountId, createdAt } = await h.openAccount({ caps: WIDE });
      const B = COMMITTED / lock;
      const spend = await h.fund(await h.inference(accountId, valueFor(B, 3_000n)));
      expect(spend.cost).to.equal(B);
      await h.topUp(accountId, 2_000n * TRAC);
      const { first, last } = await h.spanOf(createdAt);
      const pool = await h.poolSnapshot(first - 1n, last + 1n);

      const next = await h.epochNext();
      const r = await h.inference(accountId, 1_000n * TRAC, { epoch: next });
      const { subscriptionId, cost, receipt } = await h.fund(r);
      expect(cost).to.equal(700n * TRAC);

      const [covered] = await eventsOf(receipt, f.PC, 'ServiceCostCovered');
      expect([covered.drawnFromWindow, covered.drawnFromTopUp]).to.deep.equal([0n, cost]);
      expect(await h.creditedRanges(receipt)).to.have.length(0);
      expect(await h.poolSnapshot(first - 1n, last + 1n)).to.deep.equal(pool);

      // The period funded ahead is due after its own epoch; the first one after the current.
      expect(await f.QIS.convictionDue(next + 1n)).to.equal(cost);
      expect(await f.QIS.convictionDue(next)).to.equal(B);
      expect(await f.PCS.topUpBalance(accountId)).to.equal(2_000n * TRAC - cost);
      const s = await f.CSS.getSubscription(subscriptionId);
      expect([s.drawnFromWindow, s.drawnFromTopUp]).to.deep.equal([0n, cost]);
    });

    it('a draw split between the window and the top-up buffer is due in full after the period', async () => {
      const { accountId } = await h.openAccount({ caps: WIDE });
      const B = COMMITTED / lock;
      await h.fund(await h.inference(accountId, valueFor(B - 100n * TRAC, 3_000n)));
      await h.topUp(accountId, 1_000n * TRAC);
      const next = await h.epochNext();
      const { cost, receipt } = await h.fund(await h.inference(accountId, valueFor(300n * TRAC, 3_000n), { epoch: next }));
      expect(cost).to.equal(300n * TRAC);
      const [covered] = await eventsOf(receipt, f.PC, 'ServiceCostCovered');
      expect([covered.drawnFromWindow, covered.drawnFromTopUp]).to.deep.equal([100n * TRAC, 200n * TRAC]);
      expect(await h.creditedRanges(receipt)).to.have.length(0);
      expect(await f.QIS.convictionDue(next + 1n)).to.equal(300n * TRAC);
      expect(await f.QIS.convictionDue(next)).to.equal(B - 100n * TRAC);
    });
  });

  // -------------------------------------------------------------------------
  // Fund, refusals
  // -------------------------------------------------------------------------

  describe('fund, refusals', () => {
    describe('the limit', () => {
      let accountId: bigint;

      // No discount, so a cost equals its value.
      beforeEach(async () => {
        ({ accountId } = await h.openAccount({ committed: SMALL, caps: { maxCostPerPeriod: 40n * TRAC } }));
      });

      const both = async (inferenceValue: bigint, queryValue: bigint, epoch?: bigint) =>
        requestOf(accountId, epoch ?? (await h.epochNow()), {
          buckets: [bucket(0, CLASS_INFERENCE, inferenceValue), bucket(1, CLASS_QUERY, queryValue)],
        });

      it('the period limit, over both classes', async () => {
        await expect(f.SS.connect(buyer).fundFromConviction(await both(25n * TRAC, 16n * TRAC)))
          .to.be.revertedWithCustomError(f.SS, 'CapExceeded')
          .withArgs('maxCostPerPeriod', 40n * TRAC, 41n * TRAC);
        await h.fund(await both(25n * TRAC, 15n * TRAC));
      });

      it('both service classes are always allowed, alone or together, up to the limit', async () => {
        const query = requestOf(accountId, await h.epochNow(), { buckets: [bucket(0, CLASS_QUERY, 40n * TRAC)] });
        await h.fund(query);
        await h.fund(await h.inference(accountId, 40n * TRAC, { epoch: await h.epochNext() }));
        await h.assignAs(await h.termsFor(accountId, buyer2.address, { maxCostPerPeriod: 40n * TRAC }), buyer2);
        await h.fund(await both(1n, 40n * TRAC - 1n), buyer2);
      });

      it('the limit is per period: every period of the same buyer key may reach it', async () => {
        await h.fund(await h.inference(accountId, 40n * TRAC));
        await h.fund(await h.inference(accountId, 40n * TRAC, { epoch: await h.epochNext() }));
        await time.increase(epLen);
        await h.fund(await h.inference(accountId, 40n * TRAC, { epoch: await h.epochNext() }));
        expect((await f.CSS.getUsage(accountId, buyer.address)).periods).to.equal(3n);
      });
    });

    it("the period's epoch: only the current epoch or the next one, once per buyer key", async () => {
      const { accountId } = await h.openAccount({ committed: SMALL });
      await time.increase(2n * epLen);
      const now = await h.epochNow();
      for (const epoch of [0n, now - 1n, now + 2n, now + 100n]) {
        await expect(f.SS.connect(buyer).fundFromConviction(await h.inference(accountId, TRAC, { epoch })), `epoch ${epoch}`)
          .to.be.revertedWithCustomError(f.SS, 'InvalidFundingRequest')
          .withArgs('epoch');
      }
      await h.fund(await h.inference(accountId, TRAC, { epoch: now }));
      await h.fund(await h.inference(accountId, TRAC, { epoch: now + 1n }));
      for (const epoch of [now, now + 1n]) {
        await expect(f.SS.connect(buyer).fundFromConviction(await h.inference(accountId, TRAC, { epoch })))
          .to.be.revertedWithCustomError(f.SS, 'PeriodAlreadyFunded')
          .withArgs(await f.SS.subscriptionIdOf(buyer.address, epoch));
      }
    });

    it('a zero session key is refused', async () => {
      const { accountId } = await h.openAccount({ committed: SMALL });
      await expect(
        f.SS.connect(buyer).fundFromConviction(await h.inference(accountId, TRAC, { sessionKey: ethers.ZeroAddress })),
      ).to.be.revertedWithCustomError(f.SS, 'ZeroSessionKey');
      await h.fund(await h.inference(accountId, TRAC));
    });

    it('the buckets: none, too many, unsorted, duplicate, zero value, unknown class, zero ask, and a sum beyond uint96', async () => {
      const { accountId } = await h.openAccount({ committed: SMALL, caps: WIDE });
      const max = Number(await f.CSS.maxBucketsPerPeriod());
      const many = (n: number) => Array.from({ length: n }, (_, i) => bucket(i, CLASS_INFERENCE, TRAC));
      const cases: Array<[ReturnType<typeof bucket>[], string]> = [
        [[], 'bucketCount'],
        [many(max + 1), 'bucketCount'],
        [[bucket(2, CLASS_INFERENCE, TRAC), bucket(1, CLASS_INFERENCE, TRAC)], 'bucketOrder'],
        [[bucket(1, CLASS_INFERENCE, TRAC), bucket(1, CLASS_QUERY, TRAC)], 'bucketOrder'],
        [[bucket(1, CLASS_INFERENCE, 0n)], 'bucketValue'],
        [[bucket(1, 0n, TRAC)], 'serviceClass'],
        [[bucket(1, 3n, TRAC)], 'serviceClass'],
        [[bucket(1, CLASS_QUERY, TRAC, 0n)], 'maxAskWeiPerUnit'],
        [[bucket(1, CLASS_INFERENCE, MAX_UINT96), bucket(2, CLASS_QUERY, 1n)], 'value'],
      ];
      for (const [buckets, reason] of cases) {
        await expect(f.SS.connect(buyer).fundFromConviction(requestOf(accountId, await h.epochNow(), { buckets })), reason)
          .to.be.revertedWithCustomError(f.SS, 'InvalidFundingRequest')
          .withArgs(reason);
      }
      const { subscriptionId } = await h.fund(requestOf(accountId, await h.epochNow(), { buckets: many(max) }));
      expect((await f.CSS.getSubscription(subscriptionId)).bucketCount).to.equal(BigInt(max));
      expect(await f.CSS.getBuckets(subscriptionId)).to.have.length(max);
    });

    it('NotAssigned, AssignmentRevoked, AssignmentExpired and ServiceSpendingDisabled', async () => {
      const { accountId } = await h.openAccount({ committed: SMALL });
      await expect(f.SS.connect(stranger).fundFromConviction(await h.inference(accountId, TRAC)))
        .to.be.revertedWithCustomError(f.SS, 'NotAssigned')
        .withArgs(accountId, stranger.address);
      await expect(f.SS.connect(buyer).fundFromConviction(await h.inference(424242n, TRAC)))
        .to.be.revertedWithCustomError(f.SS, 'ServiceSpendingDisabled')
        .withArgs(424242n);
      await f.SS.connect(owner).setServiceSpending(accountId, false);
      await expect(f.SS.connect(buyer).fundFromConviction(await h.inference(accountId, TRAC)))
        .to.be.revertedWithCustomError(f.SS, 'ServiceSpendingDisabled')
        .withArgs(accountId);
      await f.SS.connect(owner).setServiceSpending(accountId, true);
      await f.SS.connect(owner).revoke(accountId, buyer.address);
      await expect(f.SS.connect(buyer).fundFromConviction(await h.inference(accountId, TRAC)))
        .to.be.revertedWithCustomError(f.SS, 'AssignmentRevoked')
        .withArgs(accountId, buyer.address);

      const short = await h.termsFor(accountId, buyer2.address, { expiresAt: (await h.latest()) + 5n * DAY });
      await h.assignAs(short, buyer2);
      await h.fund(await h.inference(accountId, TRAC), buyer2);
      await time.increaseTo(short.expiresAt);
      await expect(f.SS.connect(buyer2).fundFromConviction(await h.inference(accountId, TRAC)))
        .to.be.revertedWithCustomError(f.SS, 'AssignmentExpired')
        .withArgs(accountId, buyer2.address);
    });

    it('InsufficientAllowance, with no partial effect', async () => {
      const { accountId } = await h.openAccount({ committed: SMALL, caps: WIDE });
      await h.topUp(accountId, 100n * TRAC);
      await h.fund(await h.inference(accountId, 600n * TRAC));
      const before = await h.fundingState(accountId, buyer.address, 0n);
      const next = await h.epochNext();
      const r = await h.inference(accountId, 501n * TRAC, { epoch: next });
      const epoch = await f.Chronos.getCurrentEpoch();
      await expect(f.SS.connect(buyer).fundFromConviction(r))
        .to.be.revertedWithCustomError(f.SS, 'InsufficientAllowance')
        .withArgs(accountId, epoch, 501n * TRAC, 500n * TRAC);
      expect(await h.fundingState(accountId, buyer.address, 0n)).to.deep.equal(before);
      expect(await f.CSS.subscriptionExists(await f.SS.subscriptionIdOf(buyer.address, r.epoch))).to.equal(false);

      // Exactly what is left: the window, then the buffer.
      const { receipt } = await h.fund(await h.inference(accountId, 500n * TRAC, { epoch: next }));
      const [covered] = await eventsOf(receipt, f.PC, 'ServiceCostCovered');
      expect([covered.drawnFromWindow, covered.drawnFromTopUp]).to.deep.equal([400n * TRAC, 100n * TRAC]);
    });

    it('AccountExpired, for an assignment that outlives the account', async () => {
      const { accountId } = await h.openAccount({ committed: SMALL });
      const acct = await f.PCS.getAccount(accountId);
      expect((await f.CSS.getAssignment(accountId, buyer.address)).expiresAt).to.be.greaterThan(acct.expiresAtTimestamp);
      await time.increaseTo(acct.expiresAtTimestamp);
      await expect(f.SS.connect(buyer).fundFromConviction(await h.inference(accountId, TRAC)))
        .to.be.revertedWithCustomError(f.SS, 'AccountExpired')
        .withArgs(accountId, acct.expiresAtEpoch);
    });

    it('a wired treasury pauses funding with ServiceFundingPausedTreasuryWired', async () => {
      const { accountId } = await h.openAccount({ committed: SMALL });
      await f.Params.setProtocolTreasury(treasury.address);
      await expect(f.SS.connect(buyer).fundFromConviction(await h.inference(accountId, TRAC)))
        .to.be.revertedWithCustomError(f.SS, 'ServiceFundingPausedTreasuryWired')
        .withArgs(treasury.address);
      await f.Params.setProtocolTreasury(ethers.ZeroAddress);
      await h.fund(await h.inference(accountId, TRAC));
    });

    it('coverServiceCost called from any address but ServiceSubscriptions reverts OnlyServiceSubscriptions', async () => {
      const { accountId } = await h.openAccount({ committed: SMALL });
      const nft = await h.impersonate(await f.NFT.getAddress());
      for (const caller of [owner, buyer, stranger, f.accounts[0], nft]) {
        await expect(f.PC.connect(caller).coverServiceCost(accountId, buyer.address, ethers.id('x'), TRAC))
          .to.be.revertedWithCustomError(f.PC, 'OnlyServiceSubscriptions')
          .withArgs(caller.address);
      }
    });

    it('a draw that does not match the cost or the window computed here reverts DrawMismatch', async () => {
      const discounted = await h.openAccount({ caps: WIDE });
      const plain = await h.openAccount({ committed: SMALL, caps: WIDE });
      const Skew = await hre.ethers.getContractFactory('MockSkewedServiceDraw');
      const skew = (await Skew.deploy()) as unknown as MockSkewedServiceDraw;
      await f.Hub.setContractAddress('PublishingConviction', await skew.getAddress());

      // The stand-in charges the undiscounted value.
      await expect(f.SS.connect(buyer).fundFromConviction(await h.inference(discounted.accountId, 10n * TRAC)))
        .to.be.revertedWithCustomError(f.SS, 'DrawMismatch')
        .withArgs(7n * TRAC, 10n * TRAC, 0n, 0n);
      // With no discount the cost matches, and a wrong window is refused.
      await skew.setWindow(5n);
      await expect(f.SS.connect(buyer).fundFromConviction(await h.inference(plain.accountId, 10n * TRAC)))
        .to.be.revertedWithCustomError(f.SS, 'DrawMismatch')
        .withArgs(10n * TRAC, 10n * TRAC, 0n, 5n);
    });

    it('an account scheduled in full after it opted in is refused with EmissionAlreadyScheduled, with no partial effect', async () => {
      // Only a 10.0.8 or 10.1.0 build could schedule an account in full; the
      // harness does it to one that opted in at use time.
      const { accountId } = await h.openAccount({ committed: SMALL, caps: WIDE });
      const harness = await deployScheduleHarness(f.Hub);
      await harness.scheduleInFull(accountId);
      const before = await h.fundingState(accountId, buyer.address, 0n);
      await expect(f.SS.connect(buyer).fundFromConviction(await h.inference(accountId, TRAC)))
        .to.be.revertedWithCustomError(f.SS, 'EmissionAlreadyScheduled')
        .withArgs(accountId);
      expect(await h.fundingState(accountId, buyer.address, 0n)).to.deep.equal(before);
    });
  });

  // -------------------------------------------------------------------------
  // Period records
  // -------------------------------------------------------------------------

  describe('period records', () => {
    it('every period starts at the block time during its epoch, or at its epoch start ahead of it, so its record reads as existing', async () => {
      const { accountId } = await h.openAccount({ committed: SMALL });
      const ids: string[] = [];
      for (let i = 0; i < 3; i++) {
        // The current epoch first, then the next one, then, an epoch later, the next one again.
        if (i === 2) await time.increase(epLen);
        const epoch = i === 0 ? await h.epochNow() : await h.epochNext();
        const { subscriptionId, receipt } = await h.fund(await h.inference(accountId, TRAC, { epoch }));
        const s = await f.CSS.getSubscription(subscriptionId);
        const ts = await blockTime(receipt);
        const epochStart = await f.Chronos.timestampForEpoch(epoch);
        expect(s.periodStart).to.equal(ts > epochStart ? ts : epochStart);
        expect(s.periodEnd).to.equal(await f.Chronos.timestampForEpoch(epoch + 1n));
        expect(s.periodStart).to.be.greaterThan(0n);
        expect(await f.CSS.subscriptionExists(subscriptionId)).to.equal(true);
        ids.push(subscriptionId);
      }
      expect(await f.CSS.accountSubscriptionCount(accountId)).to.equal(3n);
      for (let i = 0; i < ids.length; i++) {
        expect(await f.CSS.accountSubscriptionAt(accountId, BigInt(i))).to.equal(ids[i]);
      }
    });

    it('a second funding for an epoch reverts PeriodAlreadyFunded and changes nothing; another buyer key may fund that epoch', async () => {
      const { accountId } = await h.openAccount({ committed: SMALL });
      const r = requestOf(accountId, await h.epochNow(), {
        buckets: [bucket(0, CLASS_INFERENCE, 2n * TRAC), bucket(1, CLASS_QUERY, TRAC)],
      });
      const { subscriptionId } = await h.fund(r);
      const before = await h.fundingState(accountId, buyer.address, 0n);
      const record = h.plain(await f.CSS.getSubscription(subscriptionId));
      await expect(f.SS.connect(buyer).fundFromConviction(r))
        .to.be.revertedWithCustomError(f.SS, 'PeriodAlreadyFunded')
        .withArgs(subscriptionId);
      // A different plan for the same epoch is the same period.
      await expect(f.SS.connect(buyer).fundFromConviction({ ...r, buckets: [bucket(0, CLASS_INFERENCE, TRAC)] }))
        .to.be.revertedWithCustomError(f.SS, 'PeriodAlreadyFunded')
        .withArgs(subscriptionId);
      expect(await h.fundingState(accountId, buyer.address, 0n)).to.deep.equal(before);
      expect(h.plain(await f.CSS.getSubscription(subscriptionId))).to.deep.equal(record);
      expect(await f.CSS.getBuckets(subscriptionId)).to.have.length(2);

      await h.assignAs(await h.termsFor(accountId, buyer2.address), buyer2);
      const other = await h.fund(r, buyer2);
      expect(other.subscriptionId).to.not.equal(subscriptionId);
      expect(await f.CSS.accountSubscriptionCount(accountId)).to.equal(2n);
    });

    it('the storage itself refuses a record whose periodStart is 0, which would read as absent, from any Hub writer', async () => {
      // A Hub owner write, which the storage admits as it admits any Hub contract.
      const id = ethers.id('ghost');
      const record = {
        accountId: 1n,
        assignee: buyer.address,
        assignmentNonce: 0n,
        sessionKey: SESSION_KEY,
        epoch: 1n,
        planDigest: ethers.ZeroHash,
        periodStart: 0n,
        periodEnd: 0n,
        fundedEpoch: 1n,
        fundedWindow: 0n,
        discountBps: 0n,
        bucketCount: 1n,
        value: TRAC,
        cost: TRAC,
        drawnFromWindow: TRAC,
        drawnFromTopUp: 0n,
      };
      const buckets = [bucket(0, CLASS_INFERENCE, TRAC)];
      await expect(f.CSS.createSubscription(id, record, buckets))
        .to.be.revertedWithCustomError(f.CSS, 'ZeroPeriodStart')
        .withArgs(id);
      expect(await f.CSS.subscriptionExists(id)).to.equal(false);
      expect(await f.CSS.getBuckets(id)).to.have.length(0);
      expect(await f.CSS.accountSubscriptionCount(1n)).to.equal(0n);

      // With a start, the same write records the period once; a second write
      // under the id is refused, so its buckets are never appended twice.
      const started = { ...record, periodStart: 1_700_000_000n, periodEnd: 1_700_000_000n + DAY };
      await f.CSS.createSubscription(id, started, buckets);
      expect(await f.CSS.subscriptionExists(id)).to.equal(true);
      await expect(f.CSS.createSubscription(id, started, buckets))
        .to.be.revertedWithCustomError(f.CSS, 'SubscriptionExists')
        .withArgs(id);
      expect(await f.CSS.getBuckets(id)).to.have.length(1);
      expect(await f.CSS.accountSubscriptionCount(1n)).to.equal(1n);
    });
  });

  // -------------------------------------------------------------------------
  // No TRAC moves
  // -------------------------------------------------------------------------

  describe('no TRAC moves', () => {
    const tokenLogs = async (receipt: ContractTransactionReceipt) => {
      const address = (await f.Token.getAddress()).toLowerCase();
      return receipt.logs.filter((l) => l.address.toLowerCase() === address);
    };

    it('a base-only funding moves no token, leaves the vault, and leaves the staker pool unchanged over the span', async () => {
      const { accountId, createdAt } = await h.openAccount({ caps: WIDE });
      const { first, last } = await h.spanOf(createdAt);
      const pool = await h.poolSnapshot(first - 1n, last + 1n);
      const remainder = await f.ES.accumulatedRemainder(STAKER_SHARD_ID);
      const vault = await f.Token.balanceOf(await f.Vault.getAddress());

      const { receipt } = await h.fund(await h.inference(accountId, 1_000n * TRAC));
      expect(await tokenLogs(receipt)).to.have.length(0);
      expect(await h.creditedRanges(receipt)).to.have.length(0);
      expect(await f.Token.balanceOf(await f.Vault.getAddress())).to.equal(vault);
      expect(await h.poolSnapshot(first - 1n, last + 1n)).to.deep.equal(pool);
      expect(await f.ES.accumulatedRemainder(STAKER_SHARD_ID)).to.equal(remainder);
    });

    it('a top-up funding moves no token and leaves the staker pool unchanged too', async () => {
      const { accountId, createdAt } = await h.openAccount({ caps: WIDE });
      await h.fund(await h.inference(accountId, valueFor(COMMITTED / lock, 3_000n)));
      await h.topUp(accountId, 1_000n * TRAC);
      const { first, last } = await h.spanOf(createdAt);
      const pool = await h.poolSnapshot(first - 1n, last + 1n);
      const remainder = await f.ES.accumulatedRemainder(STAKER_SHARD_ID);
      const vault = await f.Token.balanceOf(await f.Vault.getAddress());

      const { receipt } = await h.fund(await h.inference(accountId, 1_000n * TRAC, { epoch: await h.epochNext() }));
      const [covered] = await eventsOf(receipt, f.PC, 'ServiceCostCovered');
      expect(covered.drawnFromTopUp).to.equal(700n * TRAC);
      expect(await tokenLogs(receipt)).to.have.length(0);
      expect(await h.creditedRanges(receipt)).to.have.length(0);
      expect(await f.Token.balanceOf(await f.Vault.getAddress())).to.equal(vault);
      expect(await h.poolSnapshot(first - 1n, last + 1n)).to.deep.equal(pool);
      expect(await f.ES.accumulatedRemainder(STAKER_SHARD_ID)).to.equal(remainder);
    });
  });

  // -------------------------------------------------------------------------
  // Views
  // -------------------------------------------------------------------------

  describe('views', () => {
    it('previewCost: every tier, the floor, a zero value, and an unknown account', async () => {
      for (const [committed, bps] of TIERS) {
        const { accountId } = await h.createAccountFor(owner, committed);
        for (const value of [0n, 1n, 3n, 10n * TRAC + 7n]) {
          expect(await f.SS.previewCost(accountId, value)).to.deep.equal([costOf(value, bps), bps]);
        }
      }
      await expect(f.SS.previewCost(424242n, TRAC)).to.be.revertedWithCustomError(f.PCS, 'UnknownAccount').withArgs(424242n);
    });

    it('currentWindowAllowance follows the block time where getRemainingAllowance maps an epoch start to the previous window', async () => {
      // Create the account a third into an epoch, so its windows straddle epoch starts.
      const start = await f.Chronos.startTime();
      const epochNow = await f.Chronos.getCurrentEpoch();
      await time.increaseTo(start + epochNow * epLen + epLen / 3n);
      const { accountId, createdAt } = await h.openAccount({ committed: SMALL, caps: WIDE });
      const B = SMALL / lock;
      await h.topUp(accountId, 70n * TRAC);
      await h.fund(await h.inference(accountId, 400n * TRAC));
      const createdEpoch = await f.Chronos.epochAtTimestamp(createdAt);
      const createdOffset = createdAt - (await f.Chronos.timestampForEpoch(createdEpoch));

      // In the next epoch, before the creation's time of day, both views read window 0.
      await time.increaseTo((await f.Chronos.timestampForEpoch(createdEpoch + 1n)) + createdOffset / 2n);
      expect(await f.SS.currentWindowAllowance(accountId)).to.deep.equal([0n, B - 400n * TRAC, 70n * TRAC, false]);
      expect(await f.PC.getRemainingAllowance(accountId, createdEpoch + 1n)).to.equal(B - 400n * TRAC + 70n * TRAC);

      // At or after it, the block time is in window 1, which getRemainingAllowance does not see.
      await time.increaseTo((await f.Chronos.timestampForEpoch(createdEpoch + 1n)) + createdOffset + 10n);
      expect(await f.SS.currentWindowAllowance(accountId)).to.deep.equal([1n, B, 70n * TRAC, false]);
      expect(await f.PC.getRemainingAllowance(accountId, createdEpoch + 1n)).to.equal(B - 400n * TRAC + 70n * TRAC);
      // A funding draws on window 1, as currentWindowAllowance said.
      const { receipt } = await h.fund(await h.inference(accountId, 10n * TRAC));
      expect((await eventsOf(receipt, f.PC, 'ServiceCostCovered'))[0].window).to.equal(1n);

      // After expiry the window is capped at the lock, and nothing is left of the base allowance.
      await time.increaseTo((await f.PCS.getAccount(accountId)).expiresAtTimestamp + 1n);
      expect(await f.SS.currentWindowAllowance(accountId)).to.deep.equal([lock, 0n, 70n * TRAC, true]);
    });
  });
});
