// A Conviction Account period and the lifetime of the assignment it is funded
// under (OT-RFC-27), end to end on the real account and staking stacks, each
// group on the stack and setup of the suite it belongs to:
//   - receipt batches: a period keeps the assignment it was funded under, so a
//     new assignment of the buyer key revives no request, and one replaced
//     while still live keeps its period open to requests and top-ups until its
//     own expiry;
//   - plan-period funding: a Conviction Account period funded ahead, or topped
//     up before it starts, is refused if its assignment expires before the
//     period starts, the assignment it was funded under included.

import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { loadFixture, time } from '@nomicfoundation/hardhat-network-helpers';
import { expect } from 'chai';
import { ethers } from 'ethers';
import hre from 'hardhat';

import { CLASS_INFERENCE, DAY, TRAC, bucket, costOf, requestOf, signTerms, subscriptionIdOf } from './helpers/conviction-service';
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
  // A period and the assignment it was funded under
  // -------------------------------------------------------------------------

  describe('a period keeps the assignment it was funded under', () => {
    let epoch: bigint;

    beforeEach(async () => {
      epoch = await h.epochNow();
    });

    const fundFrom = async (accountId: bigint, e: bigint): Promise<string> => {
      await f.SS.connect(buyer2).fundFromConviction(
        requestOf(accountId, e, { buckets: [bucket(0, CLASS_INFERENCE, 10n * TRAC, CAP)], sessionKey: key.address }),
      );
      return subscriptionIdOf(buyer2.address, e);
    };

    /** A new assignment of buyer2 over `accountId`, with both parties' consent. */
    const reassign = async (accountId: bigint, expiresAt: bigint) => {
      const terms = {
        accountId,
        assignee: buyer2.address,
        maxCostPerPeriod: 1_000n * TRAC,
        expiresAt,
        nonce: await f.CSS.assignmentNonce(accountId),
      };
      await f.SS.connect(owner).assign(terms, '0x', await signTerms(buyer2, f.SS, terms));
    };

    const refusedAs = async (p: string, item: ReceiptItem, fault: bigint) =>
      expect(h.submit(s1, [{ subscriptionId: p, bucketIndex: 0n, minCounted: 0n, items: [item] }]))
        .to.be.revertedWithCustomError(f.QS, 'ReceiptFault')
        .withArgs(0n, 0n, fault);

    it('a request issued while the assignment was revoked is refused before a new assignment of the buyer key, and after it', async () => {
      const { accountId } = await openConvictionAccount({
        ...f,
        owner,
        assignee: buyer2,
        committed: 100_000n * TRAC,
        limit: 1_000n * TRAC,
      });
      const p = await fundFrom(accountId, epoch);
      await f.SS.connect(owner).revoke(accountId, buyer2.address);
      const revokedAt = (await f.CSS.getAssignment(accountId, buyer2.address)).revokedAt;
      const during = h.itemFor(await h.requestFor(p, 0, s1, { nonce: 0n, issuedAt: revokedAt + 60n }));
      await time.setNextBlockTimestamp(revokedAt + 120n);
      await refusedAs(p, during, Fault.InactiveAssignment);

      await reassign(accountId, (await h.latest()) + 400n * DAY);
      expect(await f.CSS.isAssignmentActive(accountId, buyer2.address)).to.equal(true);
      await refusedAs(p, during, Fault.InactiveAssignment);
      // Nor does a request issued under the new assignment count in the period funded under the old one.
      await refusedAs(p, h.itemFor(await h.requestFor(p, 0, s1, { nonce: 1n })), Fault.InactiveAssignment);
      expect(await f.QIS.bucketFilled(p, 0n)).to.equal(0n);
    });

    it('a request issued after the assignment expired is refused before a renewal and after it, and one served before the expiry lands until the epoch ends', async () => {
      const epochEnd = await h.epochStart(epoch + 1n);
      const expiresAt = epochEnd - DAY;
      const { accountId } = await openConvictionAccount({
        ...f,
        owner,
        assignee: buyer2,
        committed: 100_000n * TRAC,
        limit: 1_000n * TRAC,
        expiresAt,
      });
      const p = await fundFrom(accountId, epoch);
      const served = h.itemFor(await h.requestFor(p, 0, s1, { nonce: 0n, issuedAt: expiresAt - 1n }));
      const late = h.itemFor(await h.requestFor(p, 0, s1, { nonce: 1n, issuedAt: expiresAt }));
      await time.setNextBlockTimestamp(expiresAt + 60n);
      await refusedAs(p, late, Fault.InactiveAssignment);

      // Renewed after it expired, by a new assignment: the period keeps the expiry it was funded under.
      await reassign(accountId, expiresAt + 400n * DAY);
      await refusedAs(p, late, Fault.InactiveAssignment);
      await time.setNextBlockTimestamp(expiresAt + 7_200n);
      await h.accept(s1, [{ subscriptionId: p, bucketIndex: 0n, minCounted: 0n, items: [served] }]);
      expect(await f.QIS.bucketFilled(p, 0n)).to.equal(served.valueWei);

      // The expiry moves no deadline: a request served before it lands in the
      // epoch's last second, and at the epoch's end another does not.
      const atLast = h.itemFor(await h.requestFor(p, 0, s1, { nonce: 2n, issuedAt: expiresAt - 1n }));
      const atEnd = h.itemFor(await h.requestFor(p, 0, s1, { nonce: 3n, issuedAt: expiresAt - 1n }));
      await scoreNode(f.RSS, epoch + 1n, s1.identityId);
      await h.acceptAt(epochEnd - 1n, s1, [{ subscriptionId: p, bucketIndex: 0n, minCounted: 0n, items: [atLast] }]);
      expect(await f.QIS.bucketFilled(p, 0n)).to.equal(served.valueWei + atLast.valueWei);
      await expect(h.submitAt(epochEnd, s1, [{ subscriptionId: p, bucketIndex: 0n, minCounted: 0n, items: [atEnd] }]))
        .to.be.revertedWithCustomError(f.QS, 'GroupFault')
        .withArgs(0n, Fault.OutsideEpoch);
    });

    it('a period funded under the new assignment follows it, beside the period of the old one', async () => {
      const { accountId } = await openConvictionAccount({
        ...f,
        owner,
        assignee: buyer2,
        committed: 100_000n * TRAC,
        limit: 1_000n * TRAC,
      });
      const p = await fundFrom(accountId, epoch);
      const firstNonce = (await f.CSS.getAssignment(accountId, buyer2.address)).nonce;
      await f.SS.connect(owner).revoke(accountId, buyer2.address);
      const firstEnd = (await f.CSS.getAssignment(accountId, buyer2.address)).revokedAt;
      await reassign(accountId, (await h.latest()) + 400n * DAY);
      const q = await fundFrom(accountId, epoch + 1n);
      const secondNonce = (await f.CSS.getAssignment(accountId, buyer2.address)).nonce;

      // The old period takes no request issued now; the new one, from its start, does.
      await refusedAs(p, h.itemFor(await h.requestFor(p, 0, s1, { nonce: 0n })), Fault.InactiveAssignment);
      expect([(await f.CSS.getSubscription(p)).assignmentNonce, (await f.CSS.getSubscription(q)).assignmentNonce]).to.deep.equal([
        firstNonce,
        secondNonce,
      ]);
      const start = await h.epochStart(epoch + 1n);
      await h.acceptAt(start, s1, [{ subscriptionId: q, bucketIndex: 0n, minCounted: 0n, items: [h.itemFor(await h.requestFor(q, 0, s1, { nonce: 0n, issuedAt: start }))] }]);

      // Revoking the new assignment ends the new period's requests from then
      // on, and its request served before lands later.
      const served = h.itemFor(await h.requestFor(q, 0, s1, { nonce: 1n, issuedAt: start + 10n }));
      await time.setNextBlockTimestamp(start + 20n);
      await f.SS.connect(owner).revoke(accountId, buyer2.address);
      const secondEnd = (await f.CSS.getAssignment(accountId, buyer2.address)).revokedAt;
      await time.setNextBlockTimestamp(secondEnd + 7_200n);
      await refusedAs(q, h.itemFor(await h.requestFor(q, 0, s1, { nonce: 2n, issuedAt: secondEnd })), Fault.InactiveAssignment);
      await h.accept(s1, [{ subscriptionId: q, bucketIndex: 0n, minCounted: 0n, items: [served] }]);

      // Each period keeps the end of its own assignment.
      expect(await f.CSS.assignmentEnd(accountId, buyer2.address, firstNonce)).to.equal(firstEnd);
      expect(await f.CSS.assignmentEnd(accountId, buyer2.address, secondNonce)).to.equal(secondEnd);
    });

    it("an assignment replaced while still live keeps its period open, to requests and top-ups alike, until its own expiry", async () => {
      const { accountId } = await openConvictionAccount({
        ...f,
        owner,
        assignee: buyer2,
        committed: 100_000n * TRAC,
        limit: 1_000n * TRAC,
      });
      const p = await fundFrom(accountId, epoch);
      const firstNonce = (await f.CSS.getAssignment(accountId, buyer2.address)).nonce;
      // Set to expire inside the period, then replaced while still live.
      const expiresAt = (await h.latest()) + 3_600n;
      await f.SS.connect(owner).updateAssignmentCaps(accountId, buyer2.address, { maxCostPerPeriod: 1_000n * TRAC, expiresAt });
      await reassign(accountId, expiresAt + 400n * DAY);
      expect(await f.CSS.assignmentEnd(accountId, buyer2.address, firstNonce)).to.equal(expiresAt);

      // Before it, the period is topped up, and a request issued after the
      // top-up lands, against the bucket's raised value, at the period's discount.
      await f.SS.connect(buyer2).topUpFromConviction(p, [bucket(0, CLASS_INFERENCE, 5n * TRAC, CAP)], ethers.ZeroHash);
      const s = await f.CSS.getSubscription(p);
      expect(await f.QS.bucketLeft(p, 0n)).to.equal(15n * TRAC);
      const served = h.itemFor(await h.requestFor(p, 0, s1, { nonce: 0n, issuedAt: expiresAt - 1n }));
      await h.acceptAt(expiresAt - 1n, s1, [{ subscriptionId: p, bucketIndex: 0n, minCounted: 0n, items: [served] }]);
      expect(await f.QIS.bucketFilled(p, 0n)).to.equal(served.valueWei);
      expect(await f.QS.bucketLeft(p, 0n)).to.equal(15n * TRAC - served.valueWei);
      expect((await f.QIS.getNodeEpoch(s1.identityId, epoch)).r).to.equal((served.valueWei * (10_000n - s.discountBps)) / 10_000n);

      // From its expiry on, neither: the key's new assignment reopens nothing.
      await time.setNextBlockTimestamp(expiresAt);
      await refusedAs(p, h.itemFor(await h.requestFor(p, 0, s1, { nonce: 1n, issuedAt: expiresAt })), Fault.InactiveAssignment);
      await expect(f.SS.connect(buyer2).topUpFromConviction(p, [bucket(0, CLASS_INFERENCE, TRAC, CAP)], ethers.ZeroHash))
        .to.be.revertedWithCustomError(f.SS, 'AssignmentExpired')
        .withArgs(accountId, buyer2.address);
    });
  });
});

describe('@integration Plan-period funding for the query/inference pool', function () {
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
  // A Conviction Account period funded ahead
  // -------------------------------------------------------------------------

  describe('a Conviction Account period funded ahead', () => {
    let accountId: bigint;
    let now: bigint;
    let nextStart: bigint;

    beforeEach(async () => {
      accountId = await h.openAccount({ limit: 100n * TRAC });
      now = await h.epochNow();
      nextStart = await h.epochStart(now + 1n);
    });

    const expireAt = async (expiresAt: bigint) =>
      f.SS.connect(owner).updateAssignmentCaps(accountId, buyer.address, { maxCostPerPeriod: 100n * TRAC, expiresAt });

    it('is refused if the assignment expires at or before the next epoch starts, and accepted a second later', async () => {
      for (const expiresAt of [nextStart - 1n, nextStart]) {
        await expireAt(expiresAt);
        await expect(f.SS.connect(buyer).fundFromConviction(requestOf(accountId, now + 1n)))
          .to.be.revertedWithCustomError(f.SS, 'AssignmentEndsBeforePeriod')
          .withArgs(accountId, buyer.address, expiresAt, nextStart);
        expect(await f.CSS.subscriptionExists(subscriptionIdOf(buyer.address, now + 1n))).to.equal(false);
        expect(await f.QIS.convictionFunding(now + 1n)).to.equal(0n);
      }
      await expireAt(nextStart + 1n);
      await h.caFund(accountId, now + 1n, 10n * TRAC);
    });

    it("the same assignment still funds the current epoch's period, which it serves until it expires", async () => {
      await expireAt(nextStart - 1n);
      const { subscriptionId } = await h.caFund(accountId, now, 10n * TRAC);
      expect((await f.CSS.getSubscription(subscriptionId)).periodEnd).to.equal(nextStart);
    });

    it('a period funded ahead is not topped up once its assignment is set to expire before it starts', async () => {
      const ahead = await h.caFund(accountId, now + 1n, 10n * TRAC);
      await expireAt(nextStart);
      await expect(f.SS.connect(buyer).topUpFromConviction(ahead.subscriptionId, [bucket(0, CLASS_INFERENCE, TRAC)], ethers.ZeroHash))
        .to.be.revertedWithCustomError(f.SS, 'AssignmentEndsBeforePeriod')
        .withArgs(accountId, buyer.address, nextStart, nextStart);
      // A running period of the current epoch, under an assignment that
      // expires before the next epoch, is topped up as before.
      await h.assign(accountId, buyer2, 100n * TRAC);
      await f.SS.connect(owner).updateAssignmentCaps(accountId, buyer2.address, {
        maxCostPerPeriod: 100n * TRAC,
        expiresAt: nextStart - 1n,
      });
      const running = await h.caFund(accountId, now, 10n * TRAC, buyer2);
      await f.SS.connect(buyer2).topUpFromConviction(running.subscriptionId, [bucket(0, CLASS_INFERENCE, TRAC)], ethers.ZeroHash);
      await expireAt(nextStart + 1n);
      await f.SS.connect(buyer).topUpFromConviction(ahead.subscriptionId, [bucket(0, CLASS_INFERENCE, TRAC)], ethers.ZeroHash);
    });

    it('a period funded ahead takes no top-up once its own assignment ends before it starts, though the buyer key is assigned again', async () => {
      const add = [bucket(0, CLASS_INFERENCE, TRAC)];
      const booked = async () => f.QIS.convictionFunding(now + 1n);

      // Revoked before the period starts, then assigned again.
      const ahead = await h.caFund(accountId, now + 1n, 10n * TRAC);
      await f.SS.connect(owner).revoke(accountId, buyer.address);
      await h.assign(accountId, buyer, 100n * TRAC);
      const before = await booked();
      await expect(f.SS.connect(buyer).topUpFromConviction(ahead.subscriptionId, add, ethers.ZeroHash))
        .to.be.revertedWithCustomError(f.SS, 'AssignmentExpired')
        .withArgs(accountId, buyer.address);

      // Set to expire before the period starts, then replaced while still
      // live: the period could never take a request.
      await h.assign(accountId, buyer2, 100n * TRAC);
      const second = await h.caFund(accountId, now + 1n, 10n * TRAC, buyer2);
      const expiresAt = nextStart - 60n;
      await f.SS.connect(owner).updateAssignmentCaps(accountId, buyer2.address, { maxCostPerPeriod: 100n * TRAC, expiresAt });
      await h.assign(accountId, buyer2, 100n * TRAC);
      const funded = await booked();
      await expect(f.SS.connect(buyer2).topUpFromConviction(second.subscriptionId, add, ethers.ZeroHash))
        .to.be.revertedWithCustomError(f.SS, 'AssignmentEndsBeforePeriod')
        .withArgs(accountId, buyer2.address, expiresAt, nextStart);
      expect([before, funded, await booked()]).to.deep.equal([
        costOf(10n * TRAC, BPS),
        2n * costOf(10n * TRAC, BPS),
        2n * costOf(10n * TRAC, BPS),
      ]);
      expect((await f.CSS.getSubscription(second.subscriptionId)).value).to.equal(10n * TRAC);
    });
  });
});
