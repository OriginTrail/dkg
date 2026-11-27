// A Conviction Account subscription and the lifetime of the grant it is funded
// under (OT-RFC-27), end to end on the real account and staking stacks, each
// group on the stack and setup of the suite it belongs to:
//   - receipt batches: a subscription keeps the grant it was funded under, so a
//     new grant to the buyer revives no request, and one replaced
//     while still live keeps its subscription open to requests and top-ups until its
//     own expiry;
//   - subscription funding: a Conviction Account subscription funded ahead, or topped
//     up before it starts, is refused if its grant expires before the
//     subscription starts, the grant it was funded under included.

import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { loadFixture, time } from '@nomicfoundation/hardhat-network-helpers';
import { expect } from 'chai';
import { ethers } from 'ethers';
import hre from 'hardhat';

import { CLASS_INFERENCE, DAY, TRAC, budget, costOf, requestOf, signTerms, subscriptionIdOf } from './helpers/conviction-service';
import { Fault, ReceiptItem, hardhatWallet, openConvictionAccount, queryInferenceDomain, scoreNode } from './helpers/query-inference';
import {
  COMMITTED_TIER_BPS as BPS,
  FundingHelpers,
  deployFundingStack,
  fundingHelpers,
} from './helpers/query-inference-funding';
import {
  CAP,
  ReceiptsHelpers,
  SELLER_STAKE,
  Seller,
  deployReceiptsStack,
  receiptsHelpers,
} from './helpers/query-inference-receipts';

/** The receipt suite's stack, under a fixture function of this file's own, so loadFixture keeps a snapshot for it. */
async function deployReceiptsFixture() {
  return deployReceiptsStack();
}

/** The funding suite's stack, under a fixture function of this file's own, so loadFixture keeps a snapshot for it. */
async function deployFundingFixture() {
  return deployFundingStack();
}

describe('@integration Receipt batches of the query/inference pool', function () {
  let f: Awaited<ReturnType<typeof deployReceiptsFixture>>;
  let h: ReceiptsHelpers;
  let owner: SignerWithAddress;
  let buyer2: SignerWithAddress;
  let s1: Seller;
  const key = hardhatWallet(60); // the buyer's session key

  // The receipt suite's own setup, both of its sellers included.
  beforeEach(async () => {
    hre.helpers.resetDeploymentsJson();
    f = await loadFixture(deployReceiptsFixture);
    h = receiptsHelpers({ f, domain: await queryInferenceDomain(f.QIS), key });
    owner = f.accounts[20];
    buyer2 = f.accounts[22];
    s1 = await h.seller(40, SELLER_STAKE);
    await h.seller(42, SELLER_STAKE);
  });


  // -------------------------------------------------------------------------
  // A subscription and the grant it was funded under
  // -------------------------------------------------------------------------

  describe('a subscription keeps the grant it was funded under', () => {
    let epoch: bigint;

    beforeEach(async () => {
      epoch = await h.epochNow();
    });

    const fundFrom = async (accountId: bigint, e: bigint): Promise<string> => {
      await f.SS.connect(buyer2).fundFromAccount(
        requestOf(accountId, e, { budgets: [budget(0, CLASS_INFERENCE, 10n * TRAC, CAP)], sessionKey: key.address }),
      );
      return subscriptionIdOf(buyer2.address, e);
    };

    /** A new grant of buyer2 over `accountId`, with both parties' consent. */
    const addAgain = async (accountId: bigint, expiresAt: bigint) => {
      const terms = {
        accountId,
        buyer: buyer2.address,
        maxCostPerEpoch: 1_000n * TRAC,
        expiresAt,
        nonce: await f.SSS.grantNonce(accountId),
      };
      await f.SS.connect(owner).addBuyer(terms, '0x', await signTerms(buyer2, f.SS, terms));
    };

    const refusedAs = async (p: string, item: ReceiptItem, fault: bigint) =>
      expect(h.submit(s1, [{ subscriptionId: p, budgetIndex: 0n, minCounted: 0n, items: [item] }]))
        .to.be.revertedWithCustomError(f.QS, 'ReceiptFault')
        .withArgs(0n, 0n, fault);

    it('a request issued while the grant was revoked is refused before a new grant to the buyer, and after it', async () => {
      const { accountId } = await openConvictionAccount({
        ...f,
        owner,
        buyer: buyer2,
        committed: 100_000n * TRAC,
        limit: 1_000n * TRAC,
      });
      const p = await fundFrom(accountId, epoch);
      await f.SS.connect(owner).removeBuyer(accountId, buyer2.address);
      const revokedAt = (await f.SSS.getGrant(accountId, buyer2.address)).revokedAt;
      const during = h.itemFor(await h.requestFor(p, 0, s1, { nonce: 0n, issuedAt: revokedAt + 60n }));
      await time.setNextBlockTimestamp(revokedAt + 120n);
      await refusedAs(p, during, Fault.InactiveGrant);

      await addAgain(accountId, (await h.latest()) + 400n * DAY);
      expect(await f.SSS.isGrantActive(accountId, buyer2.address)).to.equal(true);
      await refusedAs(p, during, Fault.InactiveGrant);
      // Nor does a request issued under the new grant count in the subscription funded under the old one.
      await refusedAs(p, h.itemFor(await h.requestFor(p, 0, s1, { nonce: 1n })), Fault.InactiveGrant);
      expect(await f.QIS.budgetUsed(p, 0n)).to.equal(0n);
    });

    it('a request issued after the grant expired is refused before a renewal and after it, and one served before the expiry lands until the epoch ends', async () => {
      const epochEnd = await h.epochStart(epoch + 1n);
      const expiresAt = epochEnd - DAY;
      const { accountId } = await openConvictionAccount({
        ...f,
        owner,
        buyer: buyer2,
        committed: 100_000n * TRAC,
        limit: 1_000n * TRAC,
        expiresAt,
      });
      const p = await fundFrom(accountId, epoch);
      const served = h.itemFor(await h.requestFor(p, 0, s1, { nonce: 0n, issuedAt: expiresAt - 1n }));
      const late = h.itemFor(await h.requestFor(p, 0, s1, { nonce: 1n, issuedAt: expiresAt }));
      await time.setNextBlockTimestamp(expiresAt + 60n);
      await refusedAs(p, late, Fault.InactiveGrant);

      // Renewed after it expired, by a new grant: the subscription keeps the expiry it was funded under.
      await addAgain(accountId, expiresAt + 400n * DAY);
      await refusedAs(p, late, Fault.InactiveGrant);
      await time.setNextBlockTimestamp(expiresAt + 7_200n);
      await h.accept(s1, [{ subscriptionId: p, budgetIndex: 0n, minCounted: 0n, items: [served] }]);
      expect(await f.QIS.budgetUsed(p, 0n)).to.equal(served.valueWei);

      // The expiry moves no deadline: a request served before it lands in the
      // epoch's last second, and at the epoch's end another does not.
      const atLast = h.itemFor(await h.requestFor(p, 0, s1, { nonce: 2n, issuedAt: expiresAt - 1n }));
      const atEnd = h.itemFor(await h.requestFor(p, 0, s1, { nonce: 3n, issuedAt: expiresAt - 1n }));
      await scoreNode(f.RSS, epoch + 1n, s1.identityId);
      await h.acceptAt(epochEnd - 1n, s1, [{ subscriptionId: p, budgetIndex: 0n, minCounted: 0n, items: [atLast] }]);
      expect(await f.QIS.budgetUsed(p, 0n)).to.equal(served.valueWei + atLast.valueWei);
      await expect(h.submitAt(epochEnd, s1, [{ subscriptionId: p, budgetIndex: 0n, minCounted: 0n, items: [atEnd] }]))
        .to.be.revertedWithCustomError(f.QS, 'GroupFault')
        .withArgs(0n, Fault.OutsideEpoch);
    });

    it('a subscription funded under the new grant follows it, beside the subscription of the old one', async () => {
      const { accountId } = await openConvictionAccount({
        ...f,
        owner,
        buyer: buyer2,
        committed: 100_000n * TRAC,
        limit: 1_000n * TRAC,
      });
      const p = await fundFrom(accountId, epoch);
      const firstNonce = (await f.SSS.getGrant(accountId, buyer2.address)).nonce;
      await f.SS.connect(owner).removeBuyer(accountId, buyer2.address);
      const firstEnd = (await f.SSS.getGrant(accountId, buyer2.address)).revokedAt;
      await addAgain(accountId, (await h.latest()) + 400n * DAY);
      const q = await fundFrom(accountId, epoch + 1n);
      const secondNonce = (await f.SSS.getGrant(accountId, buyer2.address)).nonce;

      // The old subscription takes no request issued now; the new one, from its start, does.
      await refusedAs(p, h.itemFor(await h.requestFor(p, 0, s1, { nonce: 0n })), Fault.InactiveGrant);
      expect([(await f.SSS.getSubscription(p)).grantNonce, (await f.SSS.getSubscription(q)).grantNonce]).to.deep.equal([
        firstNonce,
        secondNonce,
      ]);
      const start = await h.epochStart(epoch + 1n);
      await h.acceptAt(start, s1, [{ subscriptionId: q, budgetIndex: 0n, minCounted: 0n, items: [h.itemFor(await h.requestFor(q, 0, s1, { nonce: 0n, issuedAt: start }))] }]);

      // Revoking the new grant ends the new subscription's requests from then
      // on, and its request served before lands later.
      const served = h.itemFor(await h.requestFor(q, 0, s1, { nonce: 1n, issuedAt: start + 10n }));
      await time.setNextBlockTimestamp(start + 20n);
      await f.SS.connect(owner).removeBuyer(accountId, buyer2.address);
      const secondEnd = (await f.SSS.getGrant(accountId, buyer2.address)).revokedAt;
      await time.setNextBlockTimestamp(secondEnd + 7_200n);
      await refusedAs(q, h.itemFor(await h.requestFor(q, 0, s1, { nonce: 2n, issuedAt: secondEnd })), Fault.InactiveGrant);
      await h.accept(s1, [{ subscriptionId: q, budgetIndex: 0n, minCounted: 0n, items: [served] }]);

      // Each subscription keeps the end of its own grant.
      expect(await f.SSS.grantEnd(accountId, buyer2.address, firstNonce)).to.equal(firstEnd);
      expect(await f.SSS.grantEnd(accountId, buyer2.address, secondNonce)).to.equal(secondEnd);
    });

    it("a grant replaced while still live keeps its subscription open, to requests and top-ups alike, until its own expiry", async () => {
      const { accountId } = await openConvictionAccount({
        ...f,
        owner,
        buyer: buyer2,
        committed: 100_000n * TRAC,
        limit: 1_000n * TRAC,
      });
      const p = await fundFrom(accountId, epoch);
      const firstNonce = (await f.SSS.getGrant(accountId, buyer2.address)).nonce;
      // Set to expire inside the subscription, then replaced while still live.
      const expiresAt = (await h.latest()) + 3_600n;
      await f.SS.connect(owner).setBuyerLimits(accountId, buyer2.address, { maxCostPerEpoch: 1_000n * TRAC, expiresAt });
      await addAgain(accountId, expiresAt + 400n * DAY);
      expect(await f.SSS.grantEnd(accountId, buyer2.address, firstNonce)).to.equal(expiresAt);

      // Before it, the subscription is topped up, and a request issued after the
      // top-up lands, against the budget's raised value, at the subscription's discount.
      await f.SS.connect(buyer2).topUpFromAccount(p, [budget(0, CLASS_INFERENCE, 5n * TRAC, CAP)], ethers.ZeroHash);
      const s = await f.SSS.getSubscription(p);
      expect(await f.QS.budgetLeft(p, 0n)).to.equal(15n * TRAC);
      const served = h.itemFor(await h.requestFor(p, 0, s1, { nonce: 0n, issuedAt: expiresAt - 1n }));
      await h.acceptAt(expiresAt - 1n, s1, [{ subscriptionId: p, budgetIndex: 0n, minCounted: 0n, items: [served] }]);
      expect(await f.QIS.budgetUsed(p, 0n)).to.equal(served.valueWei);
      expect(await f.QS.budgetLeft(p, 0n)).to.equal(15n * TRAC - served.valueWei);
      expect((await f.QIS.getNodeEpoch(s1.identityId, epoch)).servedValue).to.equal((served.valueWei * (10_000n - s.discountBps)) / 10_000n);

      // From its expiry on, neither: the buyer's new grant reopens nothing.
      await time.setNextBlockTimestamp(expiresAt);
      await refusedAs(p, h.itemFor(await h.requestFor(p, 0, s1, { nonce: 1n, issuedAt: expiresAt })), Fault.InactiveGrant);
      await expect(f.SS.connect(buyer2).topUpFromAccount(p, [budget(0, CLASS_INFERENCE, TRAC, CAP)], ethers.ZeroHash))
        .to.be.revertedWithCustomError(f.SS, 'GrantExpired')
        .withArgs(accountId, buyer2.address);
    });
  });
});

describe('@integration Subscription funding for the query/inference pool', function () {
  let f: Awaited<ReturnType<typeof deployFundingFixture>>;
  let h: FundingHelpers;
  let owner: SignerWithAddress;
  let buyer: SignerWithAddress;
  let buyer2: SignerWithAddress;

  // The funding suite's own setup.
  beforeEach(async () => {
    hre.helpers.resetDeploymentsJson();
    f = await loadFixture(deployFundingFixture);
    [owner, buyer, buyer2] = [f.accounts[20], f.accounts[21], f.accounts[22]];
    h = fundingHelpers({ f, owner, buyer });
  });


  // -------------------------------------------------------------------------
  // A Conviction Account subscription funded ahead
  // -------------------------------------------------------------------------

  describe('a Conviction Account subscription funded ahead', () => {
    let accountId: bigint;
    let now: bigint;
    let nextStart: bigint;

    beforeEach(async () => {
      accountId = await h.openAccount({ limit: 100n * TRAC });
      now = await h.epochNow();
      nextStart = await h.epochStart(now + 1n);
    });

    const expireAt = async (expiresAt: bigint) =>
      f.SS.connect(owner).setBuyerLimits(accountId, buyer.address, { maxCostPerEpoch: 100n * TRAC, expiresAt });

    it('is refused if the grant expires at or before the next epoch starts, and accepted a second later', async () => {
      for (const expiresAt of [nextStart - 1n, nextStart]) {
        await expireAt(expiresAt);
        await expect(f.SS.connect(buyer).fundFromAccount(requestOf(accountId, now + 1n)))
          .to.be.revertedWithCustomError(f.SS, 'GrantEndsBeforeSubscription')
          .withArgs(accountId, buyer.address, expiresAt, nextStart);
        expect(await f.SSS.subscriptionExists(subscriptionIdOf(buyer.address, now + 1n))).to.equal(false);
        expect(await f.QIS.accountFunding(now + 1n)).to.equal(0n);
      }
      await expireAt(nextStart + 1n);
      await h.caFund(accountId, now + 1n, 10n * TRAC);
    });

    it("the same grant still funds the current epoch's subscription, which it serves until it expires", async () => {
      await expireAt(nextStart - 1n);
      const { subscriptionId } = await h.caFund(accountId, now, 10n * TRAC);
      expect((await f.SSS.getSubscription(subscriptionId)).endsAt).to.equal(nextStart);
    });

    it('a subscription funded ahead is not topped up once its grant is set to expire before it starts', async () => {
      const ahead = await h.caFund(accountId, now + 1n, 10n * TRAC);
      await expireAt(nextStart);
      await expect(f.SS.connect(buyer).topUpFromAccount(ahead.subscriptionId, [budget(0, CLASS_INFERENCE, TRAC)], ethers.ZeroHash))
        .to.be.revertedWithCustomError(f.SS, 'GrantEndsBeforeSubscription')
        .withArgs(accountId, buyer.address, nextStart, nextStart);
      // A running subscription of the current epoch, under a grant that
      // expires before the next epoch, is topped up as before.
      await h.addBuyer(accountId, buyer2, 100n * TRAC);
      await f.SS.connect(owner).setBuyerLimits(accountId, buyer2.address, {
        maxCostPerEpoch: 100n * TRAC,
        expiresAt: nextStart - 1n,
      });
      const running = await h.caFund(accountId, now, 10n * TRAC, buyer2);
      await f.SS.connect(buyer2).topUpFromAccount(running.subscriptionId, [budget(0, CLASS_INFERENCE, TRAC)], ethers.ZeroHash);
      await expireAt(nextStart + 1n);
      await f.SS.connect(buyer).topUpFromAccount(ahead.subscriptionId, [budget(0, CLASS_INFERENCE, TRAC)], ethers.ZeroHash);
    });

    it('a subscription funded ahead takes no top-up once its own grant ends before it starts, though the buyer is added again', async () => {
      const add = [budget(0, CLASS_INFERENCE, TRAC)];
      const booked = async () => f.QIS.accountFunding(now + 1n);

      // Revoked before the subscription starts, then added again.
      const ahead = await h.caFund(accountId, now + 1n, 10n * TRAC);
      await f.SS.connect(owner).removeBuyer(accountId, buyer.address);
      await h.addBuyer(accountId, buyer, 100n * TRAC);
      const before = await booked();
      await expect(f.SS.connect(buyer).topUpFromAccount(ahead.subscriptionId, add, ethers.ZeroHash))
        .to.be.revertedWithCustomError(f.SS, 'GrantExpired')
        .withArgs(accountId, buyer.address);

      // Set to expire before the subscription starts, then replaced while still
      // live: the subscription could never take a request.
      await h.addBuyer(accountId, buyer2, 100n * TRAC);
      const second = await h.caFund(accountId, now + 1n, 10n * TRAC, buyer2);
      const expiresAt = nextStart - 60n;
      await f.SS.connect(owner).setBuyerLimits(accountId, buyer2.address, { maxCostPerEpoch: 100n * TRAC, expiresAt });
      await h.addBuyer(accountId, buyer2, 100n * TRAC);
      const funded = await booked();
      await expect(f.SS.connect(buyer2).topUpFromAccount(second.subscriptionId, add, ethers.ZeroHash))
        .to.be.revertedWithCustomError(f.SS, 'GrantEndsBeforeSubscription')
        .withArgs(accountId, buyer2.address, expiresAt, nextStart);
      expect([before, funded, await booked()]).to.deep.equal([
        costOf(10n * TRAC, BPS),
        2n * costOf(10n * TRAC, BPS),
        2n * costOf(10n * TRAC, BPS),
      ]);
      expect((await f.SSS.getSubscription(second.subscriptionId)).value).to.equal(10n * TRAC);
    });
  });
});
