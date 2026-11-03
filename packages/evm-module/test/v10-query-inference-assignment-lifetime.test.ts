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

import { ConvictionServiceStorage, QueryInferenceSettlement, QueryInferenceStorage, ServiceSubscriptions } from '../typechain';
import { CLASS_INFERENCE, DAY, TRAC, bucket, costOf, requestOf, signTerms, subscriptionIdOf } from './helpers/conviction-service';
import { Fault, ReceiptItem, hardhatWallet, openConvictionAccount, queryInferenceDomain } from './helpers/query-inference';
import {
  COMMITTED_TIER_BPS as BPS,
  FundingContext,
  deployFundingStack,
  fundingHelpers,
} from './helpers/query-inference-funding';
import {
  CAP,
  ReceiptsContext,
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
  let QIS: QueryInferenceStorage;
  let CSS: ConvictionServiceStorage;
  let SS: ServiceSubscriptions;
  let QS: QueryInferenceSettlement;
  let owner: SignerWithAddress;
  let buyer2: SignerWithAddress;
  let s1: Seller;
  const key = hardhatWallet(60); // the buyer's session key
  const ctx = { key } as ReceiptsContext;

  // The receipt suite's own setup, both of its sellers included.
  beforeEach(async () => {
    hre.helpers.resetDeploymentsJson();
    f = ctx.f = await loadFixture(deployReceiptsFixture);
    ({ QIS, CSS, SS, QS } = f);
    ctx.domain = await queryInferenceDomain(QIS);
    owner = f.accounts[20];
    buyer2 = f.accounts[22];
    s1 = await seller(40, SELLER_STAKE);
    await seller(42, SELLER_STAKE);
  });

  const { latest, epochNow, epochStart, seller, submit, accept, requestFor, itemFor } = receiptsHelpers(ctx);

  // -------------------------------------------------------------------------
  // A period and the assignment it was funded under
  // -------------------------------------------------------------------------

  describe('a period keeps the assignment it was funded under', () => {
    let epoch: bigint;

    beforeEach(async () => {
      epoch = await epochNow();
    });

    const fundFrom = async (accountId: bigint, e: bigint): Promise<string> => {
      await SS.connect(buyer2).fundFromConviction(
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
        nonce: await CSS.assignmentNonce(accountId),
      };
      await SS.connect(owner).assign(terms, '0x', await signTerms(buyer2, SS, terms));
    };

    const refusedAs = async (p: string, item: ReceiptItem, fault: bigint) =>
      expect(submit(s1, [{ subscriptionId: p, bucketIndex: 0n, items: [item] }]))
        .to.be.revertedWithCustomError(QS, 'ReceiptFault')
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
      await SS.connect(owner).revoke(accountId, buyer2.address);
      const revokedAt = (await CSS.getAssignment(accountId, buyer2.address)).revokedAt;
      const during = itemFor(await requestFor(p, 0, s1, { nonce: 0n, issuedAt: revokedAt + 60n }));
      await time.setNextBlockTimestamp(revokedAt + 120n);
      await refusedAs(p, during, Fault.InactiveAssignment);

      await reassign(accountId, (await latest()) + 400n * DAY);
      expect(await CSS.isAssignmentActive(accountId, buyer2.address)).to.equal(true);
      await refusedAs(p, during, Fault.InactiveAssignment);
      // Nor does a request issued under the new assignment count in the period funded under the old one.
      await refusedAs(p, itemFor(await requestFor(p, 0, s1, { nonce: 1n })), Fault.InactiveAssignment);
      expect(await QIS.bucketClaimed(p, 0n)).to.equal(0n);
    });

    it('a request issued after the assignment expired is refused before a renewal and after it, and one served before the expiry lands', async () => {
      const expiresAt = (await epochStart(epoch + 1n)) - DAY;
      const { accountId } = await openConvictionAccount({
        ...f,
        owner,
        assignee: buyer2,
        committed: 100_000n * TRAC,
        limit: 1_000n * TRAC,
        expiresAt,
      });
      const p = await fundFrom(accountId, epoch);
      const served = itemFor(await requestFor(p, 0, s1, { nonce: 0n, issuedAt: expiresAt - 1n }));
      const late = itemFor(await requestFor(p, 0, s1, { nonce: 1n, issuedAt: expiresAt }));
      await time.setNextBlockTimestamp(expiresAt + 60n);
      await refusedAs(p, late, Fault.InactiveAssignment);

      // Renewed after it expired, by a new assignment: the period keeps the expiry it was funded under.
      await reassign(accountId, expiresAt + 400n * DAY);
      await refusedAs(p, late, Fault.InactiveAssignment);
      await time.setNextBlockTimestamp(expiresAt + 7_200n);
      await accept(s1, [{ subscriptionId: p, bucketIndex: 0n, items: [served] }]);
      expect(await QIS.bucketClaimed(p, 0n)).to.equal(served.valueWei);
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
      const firstNonce = (await CSS.getAssignment(accountId, buyer2.address)).nonce;
      await SS.connect(owner).revoke(accountId, buyer2.address);
      const firstEnd = (await CSS.getAssignment(accountId, buyer2.address)).revokedAt;
      await reassign(accountId, (await latest()) + 400n * DAY);
      const q = await fundFrom(accountId, epoch + 1n);
      const secondNonce = (await CSS.getAssignment(accountId, buyer2.address)).nonce;

      // The old period takes no request issued now; the new one, from its start, does.
      await refusedAs(p, itemFor(await requestFor(p, 0, s1, { nonce: 0n })), Fault.InactiveAssignment);
      expect([(await CSS.getSubscription(p)).assignmentNonce, (await CSS.getSubscription(q)).assignmentNonce]).to.deep.equal([
        firstNonce,
        secondNonce,
      ]);
      const start = await epochStart(epoch + 1n);
      await time.setNextBlockTimestamp(start);
      await accept(s1, [{ subscriptionId: q, bucketIndex: 0n, items: [itemFor(await requestFor(q, 0, s1, { nonce: 0n, issuedAt: start }))] }]);

      // Revoking the new assignment ends the new period's requests from then
      // on, and its request served before lands later.
      const served = itemFor(await requestFor(q, 0, s1, { nonce: 1n, issuedAt: start + 10n }));
      await time.setNextBlockTimestamp(start + 20n);
      await SS.connect(owner).revoke(accountId, buyer2.address);
      const secondEnd = (await CSS.getAssignment(accountId, buyer2.address)).revokedAt;
      await time.setNextBlockTimestamp(secondEnd + 7_200n);
      await refusedAs(q, itemFor(await requestFor(q, 0, s1, { nonce: 2n, issuedAt: secondEnd })), Fault.InactiveAssignment);
      await accept(s1, [{ subscriptionId: q, bucketIndex: 0n, items: [served] }]);

      // Each period keeps the end of its own assignment.
      expect(await CSS.assignmentEnd(accountId, buyer2.address, firstNonce)).to.equal(firstEnd);
      expect(await CSS.assignmentEnd(accountId, buyer2.address, secondNonce)).to.equal(secondEnd);
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
      const firstNonce = (await CSS.getAssignment(accountId, buyer2.address)).nonce;
      // Set to expire inside the period, then replaced while still live.
      const expiresAt = (await latest()) + 3_600n;
      await SS.connect(owner).updateAssignmentCaps(accountId, buyer2.address, { maxCostPerPeriod: 1_000n * TRAC, expiresAt });
      await reassign(accountId, expiresAt + 400n * DAY);
      expect(await CSS.assignmentEnd(accountId, buyer2.address, firstNonce)).to.equal(expiresAt);

      // Before it, the period is topped up, and a request issued after the
      // top-up lands, against the bucket's raised cap.
      await SS.connect(buyer2).topUpFromConviction(p, [bucket(0, CLASS_INFERENCE, 5n * TRAC, CAP)], ethers.ZeroHash);
      const s = await CSS.getSubscription(p);
      expect(await QS.fundedCap(p, 0n)).to.equal((15n * TRAC * (10_000n - s.discountBps)) / 10_000n);
      const served = itemFor(await requestFor(p, 0, s1, { nonce: 0n, issuedAt: expiresAt - 1n }));
      await time.setNextBlockTimestamp(expiresAt - 1n);
      await accept(s1, [{ subscriptionId: p, bucketIndex: 0n, items: [served] }]);
      expect(await QIS.bucketClaimed(p, 0n)).to.equal(served.valueWei);

      // From its expiry on, neither: the key's new assignment reopens nothing.
      await time.setNextBlockTimestamp(expiresAt);
      await refusedAs(p, itemFor(await requestFor(p, 0, s1, { nonce: 1n, issuedAt: expiresAt })), Fault.InactiveAssignment);
      await expect(SS.connect(buyer2).topUpFromConviction(p, [bucket(0, CLASS_INFERENCE, TRAC, CAP)], ethers.ZeroHash))
        .to.be.revertedWithCustomError(SS, 'AssignmentExpired')
        .withArgs(accountId, buyer2.address);
    });
  });
});

describe('@integration Plan-period funding for the query/inference pool', function () {
  let QIS: QueryInferenceStorage;
  let CSS: ConvictionServiceStorage;
  let SS: ServiceSubscriptions;
  let owner: SignerWithAddress;
  let buyer: SignerWithAddress;
  let buyer2: SignerWithAddress;
  const ctx = {} as FundingContext;

  // The funding suite's own setup.
  beforeEach(async () => {
    hre.helpers.resetDeploymentsJson();
    const f = await loadFixture(deployFundingFixture);
    ({ QIS, CSS, SS } = f);
    [owner, buyer, buyer2] = [f.accounts[20], f.accounts[21], f.accounts[22]];
    Object.assign(ctx, { f, owner, buyer });
  });

  const { epochNow, epochStart, openAccount, assign, caFund } = fundingHelpers(ctx);

  // -------------------------------------------------------------------------
  // A Conviction Account period funded ahead
  // -------------------------------------------------------------------------

  describe('a Conviction Account period funded ahead', () => {
    let accountId: bigint;
    let now: bigint;
    let nextStart: bigint;

    beforeEach(async () => {
      accountId = await openAccount({ limit: 100n * TRAC });
      now = await epochNow();
      nextStart = await epochStart(now + 1n);
    });

    const expireAt = async (expiresAt: bigint) =>
      SS.connect(owner).updateAssignmentCaps(accountId, buyer.address, { maxCostPerPeriod: 100n * TRAC, expiresAt });

    it('is refused if the assignment expires at or before the next epoch starts, and accepted a second later', async () => {
      for (const expiresAt of [nextStart - 1n, nextStart]) {
        await expireAt(expiresAt);
        await expect(SS.connect(buyer).fundFromConviction(requestOf(accountId, now + 1n)))
          .to.be.revertedWithCustomError(SS, 'AssignmentEndsBeforePeriod')
          .withArgs(accountId, buyer.address, expiresAt, nextStart);
        expect(await CSS.subscriptionExists(subscriptionIdOf(buyer.address, now + 1n))).to.equal(false);
        expect(await QIS.convictionDue(now + 2n)).to.equal(0n);
      }
      await expireAt(nextStart + 1n);
      await caFund(accountId, now + 1n, 10n * TRAC);
    });

    it("the same assignment still funds the current epoch's period, which it serves until it expires", async () => {
      await expireAt(nextStart - 1n);
      const { subscriptionId } = await caFund(accountId, now, 10n * TRAC);
      expect((await CSS.getSubscription(subscriptionId)).periodEnd).to.equal(nextStart);
    });

    it('a period funded ahead is not topped up once its assignment is set to expire before it starts', async () => {
      const ahead = await caFund(accountId, now + 1n, 10n * TRAC);
      await expireAt(nextStart);
      await expect(SS.connect(buyer).topUpFromConviction(ahead.subscriptionId, [bucket(0, CLASS_INFERENCE, TRAC)], ethers.ZeroHash))
        .to.be.revertedWithCustomError(SS, 'AssignmentEndsBeforePeriod')
        .withArgs(accountId, buyer.address, nextStart, nextStart);
      // A running period of the current epoch, under an assignment that
      // expires before the next epoch, is topped up as before.
      await assign(accountId, buyer2, 100n * TRAC);
      await SS.connect(owner).updateAssignmentCaps(accountId, buyer2.address, {
        maxCostPerPeriod: 100n * TRAC,
        expiresAt: nextStart - 1n,
      });
      const running = await caFund(accountId, now, 10n * TRAC, buyer2);
      await SS.connect(buyer2).topUpFromConviction(running.subscriptionId, [bucket(0, CLASS_INFERENCE, TRAC)], ethers.ZeroHash);
      await expireAt(nextStart + 1n);
      await SS.connect(buyer).topUpFromConviction(ahead.subscriptionId, [bucket(0, CLASS_INFERENCE, TRAC)], ethers.ZeroHash);
    });

    it('a period funded ahead takes no top-up once its own assignment ends before it starts, though the buyer key is assigned again', async () => {
      const add = [bucket(0, CLASS_INFERENCE, TRAC)];
      const due = async () => QIS.convictionDue(now + 2n);

      // Revoked before the period starts, then assigned again.
      const ahead = await caFund(accountId, now + 1n, 10n * TRAC);
      await SS.connect(owner).revoke(accountId, buyer.address);
      await assign(accountId, buyer, 100n * TRAC);
      const before = await due();
      await expect(SS.connect(buyer).topUpFromConviction(ahead.subscriptionId, add, ethers.ZeroHash))
        .to.be.revertedWithCustomError(SS, 'AssignmentExpired')
        .withArgs(accountId, buyer.address);

      // Set to expire before the period starts, then replaced while still
      // live: the period could never take a request.
      await assign(accountId, buyer2, 100n * TRAC);
      const second = await caFund(accountId, now + 1n, 10n * TRAC, buyer2);
      const expiresAt = nextStart - 60n;
      await SS.connect(owner).updateAssignmentCaps(accountId, buyer2.address, { maxCostPerPeriod: 100n * TRAC, expiresAt });
      await assign(accountId, buyer2, 100n * TRAC);
      const funded = await due();
      await expect(SS.connect(buyer2).topUpFromConviction(second.subscriptionId, add, ethers.ZeroHash))
        .to.be.revertedWithCustomError(SS, 'AssignmentEndsBeforePeriod')
        .withArgs(accountId, buyer2.address, expiresAt, nextStart);
      expect([before, funded, await due()]).to.deep.equal([
        costOf(10n * TRAC, BPS),
        2n * costOf(10n * TRAC, BPS),
        2n * costOf(10n * TRAC, BPS),
      ]);
      expect((await CSS.getSubscription(second.subscriptionId)).value).to.equal(10n * TRAC);
    });
  });
});
