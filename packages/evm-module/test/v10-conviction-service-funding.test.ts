// Conviction Account service spending (OT-RFC-27) end to end: funding a 
// subscription, on ServiceSubscriptions and ServiceSubscriptionsStorage registered in the
// Hub, spending through the real PublishingConviction 10.2.0 on the real account
// stack. A funding pays as a wallet does: its whole cost is booked in
// QueryInferenceStorage, under the subscription's epoch, and nothing reaches the
// staker pool.
//
// Groups:
//   - fund, happy path: every discount tier, the 1-wei floor, the top-up branch,
//     each with its cost under the subscription's epoch;
//   - fund, refusals: the subscription limit, the subscription's epoch, the budgets, the
//     grant, the allowance, an expired account, a wired treasury, the gate
//     on coverServiceCost, a mismatched spend and an account scheduled in full,
//     each without partial effect;
//   - subscription records: the record is always visible, and a buyer funds one
//     subscription per epoch;
//   - no TRAC moves: no Token log, an unchanged vault, and an unchanged staker
//     pool, for a base-only funding and a top-up funding alike;
//   - views: previewCost, and currentWindowAllowance against
//     getRemainingAllowance.
//
// The opt-in and the grants are in v10-conviction-service-grants.test.ts,
// and the allowance shared with publishing in
// v10-conviction-service-publishing.test.ts.

import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { loadFixture, time } from '@nomicfoundation/hardhat-network-helpers';
import { expect } from 'chai';
import { ContractTransactionReceipt, ethers } from 'ethers';
import hre from 'hardhat';

import { MockSkewedServiceSpend } from '../typechain';
import { STAKER_SHARD_ID, blockTime, eventsOf } from './helpers/account-stack';
import {
  CLASS_INFERENCE,
  CLASS_QUERY,
  DAY,
  SESSION_KEY,
  TRAC,
  Terms,
  budget,
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
// A limit that no test of the spend itself reaches.
const WIDE: Partial<Terms> = { maxCostPerEpoch: 50_000n * TRAC };

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
      it(`at the ${Number(bps) / 100} % tier: the cost, the events, the record, the budgets and the usage`, async () => {
        const { accountId, createdAt } = await h.openAccount({ committed: committed + 11n, limits: WIDE });
        const r = requestOf(accountId, await h.epochNow(), {
          budgets: [budget(0, CLASS_INFERENCE, 7n * TRAC + 3n), budget(1, CLASS_QUERY, 3n * TRAC + 1n)],
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
        const endsAt = await f.Chronos.timestampForEpoch(epoch + 1n);
        const window = (ts - createdAt) / epLen;

        const [covered] = await eventsOf(receipt, f.PC, 'ServiceCostCovered');
        expect([...covered]).to.deep.equal([accountId, buyer.address, subscriptionId, value, cost, epoch, window, cost, 0n]);

        const funded = await eventsOf(receipt, f.SS, 'SubscriptionFunded');
        expect(funded).to.have.length(1);
        const pf = funded[0];
        expect([
          pf.subscriptionId,
          pf.accountId,
          pf.buyer,
          pf.epoch,
          pf.sessionKey,
          pf.planDigest,
          pf.startsAt,
          pf.endsAt,
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
          endsAt,
          value,
          cost,
          bps,
        ]);
        const asTuples = (bs: Array<{ serviceId: string; serviceClass: bigint; value: bigint; maxPricePerUnit: bigint }>) =>
          bs.map((b) => [b.serviceId, b.serviceClass, b.value, b.maxPricePerUnit]);
        expect(asTuples(pf.budgets)).to.deep.equal(asTuples(r.budgets));

        const s = await f.SSS.getSubscription(subscriptionId);
        expect(h.plain(s)).to.deep.equal({
          accountId,
          buyer: buyer.address,
          grantNonce: (await f.SSS.getGrant(accountId, buyer.address)).nonce,
          sessionKey: SESSION_KEY,
          epoch: r.epoch,
          planDigest: r.planDigest,
          startsAt: ts,
          endsAt,
          fundedEpoch: epoch,
          fundedWindow: window,
          discountBps: bps,
          budgetCount: 2n,
          value,
          cost,
          spentFromWindow: cost,
          spentFromTopUp: 0n,
        });
        expect(asTuples(await f.SSS.getBudgets(subscriptionId))).to.deep.equal(asTuples(r.budgets));
        expect(await f.SSS.accountSubscriptionCount(accountId)).to.equal(1n);
        expect(await f.SSS.accountSubscriptionAt(accountId, 0n)).to.equal(subscriptionId);

        expect(h.plain(await f.SSS.getUsage(accountId, buyer.address))).to.deep.equal({ subscriptions: 1n });
        expect(await f.PCS.windowSpent(accountId, window)).to.equal(cost);

        // The whole cost is booked under the subscription's epoch, as a wallet
        // subscription's value is, and nothing in any other epoch or ledger.
        expect(await f.QIS.accountFunding(epoch)).to.equal(cost);
        expect(await f.QIS.accountFunding(epoch - 1n)).to.equal(0n);
        expect(await f.QIS.accountFunding(epoch + 1n)).to.equal(0n);
        expect(await f.QIS.walletFunding(epoch)).to.equal(0n);
        expect(await h.creditedRanges(receipt)).to.have.length(0);
      });
    }

    it('the 1-wei floor: a value the discount rounds to 0 costs 1 wei', async () => {
      const { accountId } = await h.openAccount({ committed: 1_000_000n * TRAC, limits: WIDE });
      const { cost, receipt } = await h.fund(await h.inference(accountId, 3n));
      expect(cost).to.equal(1n);
      const [covered] = await eventsOf(receipt, f.PC, 'ServiceCostCovered');
      expect([covered.value, covered.cost, covered.spentFromWindow]).to.deep.equal([3n, 1n, 1n]);
      expect(await f.QIS.accountFunding(await h.epochNow())).to.equal(1n);
      expect((await f.SSS.getSubscription(await f.SS.subscriptionIdOf(buyer.address, await h.epochNow()))).cost).to.equal(1n);
    });

    it("once the window is spent, the cost comes from the top-up buffer, is booked under the subscription's epoch, and reaches no staker pool", async () => {
      const { accountId, createdAt } = await h.openAccount({ limits: WIDE });
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
      expect([covered.spentFromWindow, covered.spentFromTopUp]).to.deep.equal([0n, cost]);
      expect(await h.creditedRanges(receipt)).to.have.length(0);
      expect(await h.poolSnapshot(first - 1n, last + 1n)).to.deep.equal(pool);

      // The subscription funded ahead is booked under its own epoch; the first one under the current.
      expect(await f.QIS.accountFunding(next)).to.equal(cost);
      expect(await f.QIS.accountFunding(next - 1n)).to.equal(B);
      expect(await f.PCS.topUpBalance(accountId)).to.equal(2_000n * TRAC - cost);
      const s = await f.SSS.getSubscription(subscriptionId);
      expect([s.spentFromWindow, s.spentFromTopUp]).to.deep.equal([0n, cost]);
    });

    it("a spend split between the window and the top-up buffer is booked in full under the subscription's epoch", async () => {
      const { accountId } = await h.openAccount({ limits: WIDE });
      const B = COMMITTED / lock;
      await h.fund(await h.inference(accountId, valueFor(B - 100n * TRAC, 3_000n)));
      await h.topUp(accountId, 1_000n * TRAC);
      const next = await h.epochNext();
      const { cost, receipt } = await h.fund(await h.inference(accountId, valueFor(300n * TRAC, 3_000n), { epoch: next }));
      expect(cost).to.equal(300n * TRAC);
      const [covered] = await eventsOf(receipt, f.PC, 'ServiceCostCovered');
      expect([covered.spentFromWindow, covered.spentFromTopUp]).to.deep.equal([100n * TRAC, 200n * TRAC]);
      expect(await h.creditedRanges(receipt)).to.have.length(0);
      expect(await f.QIS.accountFunding(next)).to.equal(300n * TRAC);
      expect(await f.QIS.accountFunding(next - 1n)).to.equal(B - 100n * TRAC);
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
        ({ accountId } = await h.openAccount({ committed: SMALL, limits: { maxCostPerEpoch: 40n * TRAC } }));
      });

      const both = async (inferenceValue: bigint, queryValue: bigint, epoch?: bigint) =>
        requestOf(accountId, epoch ?? (await h.epochNow()), {
          budgets: [budget(0, CLASS_INFERENCE, inferenceValue), budget(1, CLASS_QUERY, queryValue)],
        });

      it('the subscription limit, over both classes', async () => {
        await expect(f.SS.connect(buyer).fundFromAccount(await both(25n * TRAC, 16n * TRAC)))
          .to.be.revertedWithCustomError(f.SS, 'LimitExceeded')
          .withArgs('maxCostPerEpoch', 40n * TRAC, 41n * TRAC);
        await h.fund(await both(25n * TRAC, 15n * TRAC));
      });

      it('both service classes are always allowed, alone or together, up to the limit', async () => {
        const query = requestOf(accountId, await h.epochNow(), { budgets: [budget(0, CLASS_QUERY, 40n * TRAC)] });
        await h.fund(query);
        await h.fund(await h.inference(accountId, 40n * TRAC, { epoch: await h.epochNext() }));
        await h.addBuyerAs(await h.termsFor(accountId, buyer2.address, { maxCostPerEpoch: 40n * TRAC }), buyer2);
        await h.fund(await both(1n, 40n * TRAC - 1n), buyer2);
      });

      it('the limit is per subscription: every subscription of the same buyer may reach it', async () => {
        await h.fund(await h.inference(accountId, 40n * TRAC));
        await h.fund(await h.inference(accountId, 40n * TRAC, { epoch: await h.epochNext() }));
        await time.increase(epLen);
        await h.fund(await h.inference(accountId, 40n * TRAC, { epoch: await h.epochNext() }));
        expect((await f.SSS.getUsage(accountId, buyer.address)).subscriptions).to.equal(3n);
      });
    });

    it("the subscription's epoch: only the current epoch or the next one, once per buyer", async () => {
      const { accountId } = await h.openAccount({ committed: SMALL });
      await time.increase(2n * epLen);
      const now = await h.epochNow();
      for (const epoch of [0n, now - 1n, now + 2n, now + 100n]) {
        await expect(f.SS.connect(buyer).fundFromAccount(await h.inference(accountId, TRAC, { epoch })), `epoch ${epoch}`)
          .to.be.revertedWithCustomError(f.SS, 'InvalidFundingRequest')
          .withArgs('epoch');
      }
      await h.fund(await h.inference(accountId, TRAC, { epoch: now }));
      await h.fund(await h.inference(accountId, TRAC, { epoch: now + 1n }));
      for (const epoch of [now, now + 1n]) {
        await expect(f.SS.connect(buyer).fundFromAccount(await h.inference(accountId, TRAC, { epoch })))
          .to.be.revertedWithCustomError(f.SS, 'SubscriptionAlreadyFunded')
          .withArgs(await f.SS.subscriptionIdOf(buyer.address, epoch));
      }
    });

    it('a zero session key is refused', async () => {
      const { accountId } = await h.openAccount({ committed: SMALL });
      await expect(
        f.SS.connect(buyer).fundFromAccount(await h.inference(accountId, TRAC, { sessionKey: ethers.ZeroAddress })),
      ).to.be.revertedWithCustomError(f.SS, 'ZeroSessionKey');
      await h.fund(await h.inference(accountId, TRAC));
    });

    it('the budgets: none, too many, unsorted, duplicate, zero value, unknown class, zero price, and a sum beyond uint96', async () => {
      const { accountId } = await h.openAccount({ committed: SMALL, limits: WIDE });
      const max = Number(await f.SSS.maxBudgetsPerSubscription());
      const many = (n: number) => Array.from({ length: n }, (_, i) => budget(i, CLASS_INFERENCE, TRAC));
      const cases: Array<[ReturnType<typeof budget>[], string]> = [
        [[], 'budgetCount'],
        [many(max + 1), 'budgetCount'],
        [[budget(2, CLASS_INFERENCE, TRAC), budget(1, CLASS_INFERENCE, TRAC)], 'budgetOrder'],
        [[budget(1, CLASS_INFERENCE, TRAC), budget(1, CLASS_QUERY, TRAC)], 'budgetOrder'],
        [[budget(1, CLASS_INFERENCE, 0n)], 'budgetValue'],
        [[budget(1, 0n, TRAC)], 'serviceClass'],
        [[budget(1, 3n, TRAC)], 'serviceClass'],
        [[budget(1, CLASS_QUERY, TRAC, 0n)], 'maxPricePerUnit'],
        [[budget(1, CLASS_INFERENCE, MAX_UINT96), budget(2, CLASS_QUERY, 1n)], 'value'],
      ];
      for (const [budgets, reason] of cases) {
        await expect(f.SS.connect(buyer).fundFromAccount(requestOf(accountId, await h.epochNow(), { budgets })), reason)
          .to.be.revertedWithCustomError(f.SS, 'InvalidFundingRequest')
          .withArgs(reason);
      }
      const { subscriptionId } = await h.fund(requestOf(accountId, await h.epochNow(), { budgets: many(max) }));
      expect((await f.SSS.getSubscription(subscriptionId)).budgetCount).to.equal(BigInt(max));
      expect(await f.SSS.getBudgets(subscriptionId)).to.have.length(max);
    });

    it('NotABuyer, GrantRevoked, GrantExpired and ServiceSpendingDisabled', async () => {
      const { accountId } = await h.openAccount({ committed: SMALL });
      await expect(f.SS.connect(stranger).fundFromAccount(await h.inference(accountId, TRAC)))
        .to.be.revertedWithCustomError(f.SS, 'NotABuyer')
        .withArgs(accountId, stranger.address);
      await expect(f.SS.connect(buyer).fundFromAccount(await h.inference(424242n, TRAC)))
        .to.be.revertedWithCustomError(f.SS, 'ServiceSpendingDisabled')
        .withArgs(424242n);
      await f.SS.connect(owner).setServiceSpending(accountId, false);
      await expect(f.SS.connect(buyer).fundFromAccount(await h.inference(accountId, TRAC)))
        .to.be.revertedWithCustomError(f.SS, 'ServiceSpendingDisabled')
        .withArgs(accountId);
      await f.SS.connect(owner).setServiceSpending(accountId, true);
      await f.SS.connect(owner).removeBuyer(accountId, buyer.address);
      await expect(f.SS.connect(buyer).fundFromAccount(await h.inference(accountId, TRAC)))
        .to.be.revertedWithCustomError(f.SS, 'GrantRevoked')
        .withArgs(accountId, buyer.address);

      const short = await h.termsFor(accountId, buyer2.address, { expiresAt: (await h.latest()) + 5n * DAY });
      await h.addBuyerAs(short, buyer2);
      await h.fund(await h.inference(accountId, TRAC), buyer2);
      await time.increaseTo(short.expiresAt);
      await expect(f.SS.connect(buyer2).fundFromAccount(await h.inference(accountId, TRAC)))
        .to.be.revertedWithCustomError(f.SS, 'GrantExpired')
        .withArgs(accountId, buyer2.address);
    });

    it('InsufficientAllowance, with no partial effect', async () => {
      const { accountId } = await h.openAccount({ committed: SMALL, limits: WIDE });
      await h.topUp(accountId, 100n * TRAC);
      await h.fund(await h.inference(accountId, 600n * TRAC));
      const before = await h.fundingState(accountId, buyer.address, 0n);
      const next = await h.epochNext();
      const r = await h.inference(accountId, 501n * TRAC, { epoch: next });
      const epoch = await f.Chronos.getCurrentEpoch();
      await expect(f.SS.connect(buyer).fundFromAccount(r))
        .to.be.revertedWithCustomError(f.SS, 'InsufficientAllowance')
        .withArgs(accountId, epoch, 501n * TRAC, 500n * TRAC);
      expect(await h.fundingState(accountId, buyer.address, 0n)).to.deep.equal(before);
      expect(await f.SSS.subscriptionExists(await f.SS.subscriptionIdOf(buyer.address, r.epoch))).to.equal(false);

      // Exactly what is left: the window, then the buffer.
      const { receipt } = await h.fund(await h.inference(accountId, 500n * TRAC, { epoch: next }));
      const [covered] = await eventsOf(receipt, f.PC, 'ServiceCostCovered');
      expect([covered.spentFromWindow, covered.spentFromTopUp]).to.deep.equal([400n * TRAC, 100n * TRAC]);
    });

    it('AccountExpired, for a grant that outlives the account', async () => {
      const { accountId } = await h.openAccount({ committed: SMALL });
      const acct = await f.PCS.getAccount(accountId);
      expect((await f.SSS.getGrant(accountId, buyer.address)).expiresAt).to.be.greaterThan(acct.expiresAtTimestamp);
      await time.increaseTo(acct.expiresAtTimestamp);
      await expect(f.SS.connect(buyer).fundFromAccount(await h.inference(accountId, TRAC)))
        .to.be.revertedWithCustomError(f.SS, 'AccountExpired')
        .withArgs(accountId, acct.expiresAtEpoch);
    });

    it('a wired treasury pauses funding with ServiceFundingPausedTreasuryWired', async () => {
      const { accountId } = await h.openAccount({ committed: SMALL });
      await f.Params.setProtocolTreasury(treasury.address);
      await expect(f.SS.connect(buyer).fundFromAccount(await h.inference(accountId, TRAC)))
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

    it('a spend that does not match the cost or the window computed here reverts SpendMismatch', async () => {
      const discounted = await h.openAccount({ limits: WIDE });
      const plain = await h.openAccount({ committed: SMALL, limits: WIDE });
      const Skew = await hre.ethers.getContractFactory('MockSkewedServiceSpend');
      const skew = (await Skew.deploy()) as unknown as MockSkewedServiceSpend;
      await f.Hub.setContractAddress('PublishingConviction', await skew.getAddress());

      // The stand-in charges the undiscounted value.
      await expect(f.SS.connect(buyer).fundFromAccount(await h.inference(discounted.accountId, 10n * TRAC)))
        .to.be.revertedWithCustomError(f.SS, 'SpendMismatch')
        .withArgs(7n * TRAC, 10n * TRAC, 0n, 0n);
      // With no discount the cost matches, and a wrong window is refused.
      await skew.setWindow(5n);
      await expect(f.SS.connect(buyer).fundFromAccount(await h.inference(plain.accountId, 10n * TRAC)))
        .to.be.revertedWithCustomError(f.SS, 'SpendMismatch')
        .withArgs(10n * TRAC, 10n * TRAC, 0n, 5n);
    });

    it('an account scheduled in full after it opted in is refused with EmissionAlreadyScheduled, with no partial effect', async () => {
      // Only a 10.0.8 or 10.1.0 build could schedule an account in full; the
      // harness does it to one that opted in at use time.
      const { accountId } = await h.openAccount({ committed: SMALL, limits: WIDE });
      const harness = await deployScheduleHarness(f.Hub);
      await harness.scheduleInFull(accountId);
      const before = await h.fundingState(accountId, buyer.address, 0n);
      await expect(f.SS.connect(buyer).fundFromAccount(await h.inference(accountId, TRAC)))
        .to.be.revertedWithCustomError(f.SS, 'EmissionAlreadyScheduled')
        .withArgs(accountId);
      expect(await h.fundingState(accountId, buyer.address, 0n)).to.deep.equal(before);
    });
  });

  // -------------------------------------------------------------------------
  // Subscription records
  // -------------------------------------------------------------------------

  describe('subscription records', () => {
    it('every subscription starts at the block time during its epoch, or at its epoch start ahead of it, so its record reads as existing', async () => {
      const { accountId } = await h.openAccount({ committed: SMALL });
      const ids: string[] = [];
      for (let i = 0; i < 3; i++) {
        // The current epoch first, then the next one, then, an epoch later, the next one again.
        if (i === 2) await time.increase(epLen);
        const epoch = i === 0 ? await h.epochNow() : await h.epochNext();
        const { subscriptionId, receipt } = await h.fund(await h.inference(accountId, TRAC, { epoch }));
        const s = await f.SSS.getSubscription(subscriptionId);
        const ts = await blockTime(receipt);
        const epochStart = await f.Chronos.timestampForEpoch(epoch);
        expect(s.startsAt).to.equal(ts > epochStart ? ts : epochStart);
        expect(s.endsAt).to.equal(await f.Chronos.timestampForEpoch(epoch + 1n));
        expect(s.startsAt).to.be.greaterThan(0n);
        expect(await f.SSS.subscriptionExists(subscriptionId)).to.equal(true);
        ids.push(subscriptionId);
      }
      expect(await f.SSS.accountSubscriptionCount(accountId)).to.equal(3n);
      for (let i = 0; i < ids.length; i++) {
        expect(await f.SSS.accountSubscriptionAt(accountId, BigInt(i))).to.equal(ids[i]);
      }
    });

    it('a second funding for an epoch reverts SubscriptionAlreadyFunded and changes nothing; another buyer may fund that epoch', async () => {
      const { accountId } = await h.openAccount({ committed: SMALL });
      const r = requestOf(accountId, await h.epochNow(), {
        budgets: [budget(0, CLASS_INFERENCE, 2n * TRAC), budget(1, CLASS_QUERY, TRAC)],
      });
      const { subscriptionId } = await h.fund(r);
      const before = await h.fundingState(accountId, buyer.address, 0n);
      const record = h.plain(await f.SSS.getSubscription(subscriptionId));
      await expect(f.SS.connect(buyer).fundFromAccount(r))
        .to.be.revertedWithCustomError(f.SS, 'SubscriptionAlreadyFunded')
        .withArgs(subscriptionId);
      // A different plan for the same epoch is the same subscription.
      await expect(f.SS.connect(buyer).fundFromAccount({ ...r, budgets: [budget(0, CLASS_INFERENCE, TRAC)] }))
        .to.be.revertedWithCustomError(f.SS, 'SubscriptionAlreadyFunded')
        .withArgs(subscriptionId);
      expect(await h.fundingState(accountId, buyer.address, 0n)).to.deep.equal(before);
      expect(h.plain(await f.SSS.getSubscription(subscriptionId))).to.deep.equal(record);
      expect(await f.SSS.getBudgets(subscriptionId)).to.have.length(2);

      await h.addBuyerAs(await h.termsFor(accountId, buyer2.address), buyer2);
      const other = await h.fund(r, buyer2);
      expect(other.subscriptionId).to.not.equal(subscriptionId);
      expect(await f.SSS.accountSubscriptionCount(accountId)).to.equal(2n);
    });

    it('the storage itself refuses a record whose startsAt is 0, which would read as absent, from any Hub writer', async () => {
      // A Hub owner write, which the storage admits as it admits any Hub contract.
      const id = ethers.id('ghost');
      const record = {
        accountId: 1n,
        buyer: buyer.address,
        grantNonce: 0n,
        sessionKey: SESSION_KEY,
        epoch: 1n,
        planDigest: ethers.ZeroHash,
        startsAt: 0n,
        endsAt: 0n,
        fundedEpoch: 1n,
        fundedWindow: 0n,
        discountBps: 0n,
        budgetCount: 1n,
        value: TRAC,
        cost: TRAC,
        spentFromWindow: TRAC,
        spentFromTopUp: 0n,
      };
      const budgets = [budget(0, CLASS_INFERENCE, TRAC)];
      await expect(f.SSS.createSubscription(id, record, budgets))
        .to.be.revertedWithCustomError(f.SSS, 'ZeroSubscriptionStart')
        .withArgs(id);
      expect(await f.SSS.subscriptionExists(id)).to.equal(false);
      expect(await f.SSS.getBudgets(id)).to.have.length(0);
      expect(await f.SSS.accountSubscriptionCount(1n)).to.equal(0n);

      // With a start, the same write records the subscription once; a second write
      // under the id is refused, so its budgets are never appended twice.
      const started = { ...record, startsAt: 1_700_000_000n, endsAt: 1_700_000_000n + DAY };
      await f.SSS.createSubscription(id, started, budgets);
      expect(await f.SSS.subscriptionExists(id)).to.equal(true);
      await expect(f.SSS.createSubscription(id, started, budgets))
        .to.be.revertedWithCustomError(f.SSS, 'SubscriptionExists')
        .withArgs(id);
      expect(await f.SSS.getBudgets(id)).to.have.length(1);
      expect(await f.SSS.accountSubscriptionCount(1n)).to.equal(1n);
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
      const { accountId, createdAt } = await h.openAccount({ limits: WIDE });
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
      const { accountId, createdAt } = await h.openAccount({ limits: WIDE });
      await h.fund(await h.inference(accountId, valueFor(COMMITTED / lock, 3_000n)));
      await h.topUp(accountId, 1_000n * TRAC);
      const { first, last } = await h.spanOf(createdAt);
      const pool = await h.poolSnapshot(first - 1n, last + 1n);
      const remainder = await f.ES.accumulatedRemainder(STAKER_SHARD_ID);
      const vault = await f.Token.balanceOf(await f.Vault.getAddress());

      const { receipt } = await h.fund(await h.inference(accountId, 1_000n * TRAC, { epoch: await h.epochNext() }));
      const [covered] = await eventsOf(receipt, f.PC, 'ServiceCostCovered');
      expect(covered.spentFromTopUp).to.equal(700n * TRAC);
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
      const { accountId, createdAt } = await h.openAccount({ committed: SMALL, limits: WIDE });
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
      // A funding spends on window 1, as currentWindowAllowance said.
      const { receipt } = await h.fund(await h.inference(accountId, 10n * TRAC));
      expect((await eventsOf(receipt, f.PC, 'ServiceCostCovered'))[0].window).to.equal(1n);

      // After expiry the window is capped at the lock, and nothing is left of the base allowance.
      await time.increaseTo((await f.PCS.getAccount(accountId)).expiresAtTimestamp + 1n);
      expect(await f.SS.currentWindowAllowance(accountId)).to.deep.equal([lock, 0n, 70n * TRAC, true]);
    });
  });
});
