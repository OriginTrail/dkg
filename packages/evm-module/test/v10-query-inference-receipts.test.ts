// Receipt batches of the query/inference pool (OT-RFC-27), end to end:
// QueryInferenceSettlement on the real account and staking stacks, with
// wallet and Conviction Account subscriptions, Core Node sellers and session keys
// that sign requests.
//
// Groups:
//   - a happy batch of several groups: what counts per node and epoch, the
//     budget fills, the nonce bits, the stake factor captured once, and the
//     events with their receipt digests;
//   - the Core Node gate: a profile with no place in the sharding table, an
//     admin key, an address that is no node's, and a node with no score in the
//     current epoch;
//   - the objective faults F1 to F8 of OT-RFC-27, one by one, each reverting
//     the whole batch with its group, its item and its code, high s included;
//   - the group checks: an unknown subscription or budget, an empty group, a minimum
//     above the group's value, and the batch deadline, the end of the subscription's
//     epoch, which no revocation or expiry of a Conviction Account grant
//     moves;
//   - the nonce bitmap's words, and the bounds of a batch, the pause and
//     activation.
//
// A subscription and the grant it was funded under is in
// v10-query-inference-grant-lifetime.test.ts.

import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { loadFixture, time } from '@nomicfoundation/hardhat-network-helpers';
import { expect } from 'chai';
import { BaseContract, ethers, Result } from 'ethers';
import hre from 'hardhat';

import { QueryInferenceStorage } from '../typechain';
import { eventsOf } from './helpers/account-stack';
import {
  ServiceBudget,
  CLASS_INFERENCE,
  CLASS_QUERY,
  DAY,
  Domain,
  TRAC,
  budget,
  requestOf,
  subscriptionIdOf,
  walletRequestOf,
} from './helpers/conviction-service';
import {
  Fault,
  Receipt,
  ReceiptGroup,
  ReceiptItem,
  SCALE18,
  SECP256K1_HALF_N,
  SECP256K1_N,
  ServiceRequest,
  digestOfDigests,
  fullReceipt,
  hardhatWallet,
  itemOf,
  openConvictionAccount,
  queryInferenceDomain,
  receiptDigestOf,
  requestDigestOf,
  scoreNode,
  signCompact,
  signedItems,
  stakeFactorOf,
  stakeOn,
} from './helpers/query-inference';
import {
  PRICE,
  CAP,
  ReceiptsHelpers,
  SELLER_STAKE,
  Seller,
  deployReceiptsStack,
  receiptsHelpers,
} from './helpers/query-inference-receipts';

/** This suite's own fixture, so loadFixture keeps a snapshot for it alone. */
async function deployFixture() {
  return deployReceiptsStack();
}

type Fixture = Awaited<ReturnType<typeof deployFixture>>;

describe('@integration Receipt batches of the query/inference pool', function () {
  let f: Fixture;
  let h: ReceiptsHelpers;
  let domain: Domain;
  let buyer: SignerWithAddress;
  let buyer2: SignerWithAddress;
  let owner: SignerWithAddress;
  let s1: Seller;
  let s2: Seller;
  const key = hardhatWallet(60); // the buyer's session key
  const otherKey = hardhatWallet(61);

  beforeEach(async () => {
    hre.helpers.resetDeploymentsJson();
    f = await loadFixture(deployFixture);
    domain = await queryInferenceDomain(f.QIS);
    h = receiptsHelpers({ f, domain, key });
    owner = f.accounts[20];
    buyer = f.accounts[21];
    buyer2 = f.accounts[22];
    s1 = await h.seller(40, SELLER_STAKE);
    s2 = await h.seller(42, SELLER_STAKE);
  });

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  const plain = (r: unknown) => (r as Result).toObject();
  const forward = async (contract: BaseContract, fn: string, args: unknown[] = []) =>
    f.Hub.forwardCall(await contract.getAddress(), contract.interface.encodeFunctionData(fn, args));

  /** Fund a wallet subscription of `epoch` for `who`, signed for by `sessionKey`. */
  const walletFund = async (
    who: SignerWithAddress,
    epoch: bigint,
    budgets: ServiceBudget[],
    sessionKey: string = key.address,
  ): Promise<string> => {
    const value = budgets.reduce((a, b) => a + b.value, 0n);
    await f.Token.mint(who.address, value);
    await f.Token.connect(who).approve(await f.SSW.getAddress(), value);
    await f.SSW.connect(who).fundFromWallet(walletRequestOf(epoch, { budgets, sessionKey }));
    return subscriptionIdOf(who.address, epoch);
  };

  /** `count` signed items of a subscription's budget for `by`, from nonce `firstNonce`, issued now. */
  const items = async (
    subscriptionId: string,
    budgetIndex: number,
    by: Seller,
    count: number,
    opts: { firstNonce?: bigint; units?: bigint; price?: bigint; issuedAt?: bigint; wallet?: ethers.HDNodeWallet } = {},
  ) => {
    const b = await f.SSS.getBudget(subscriptionId, budgetIndex);
    return signedItems({
      domain,
      wallet: opts.wallet ?? key,
      subscriptionId,
      serviceId: b.serviceId,
      seller: by.identityId,
      firstNonce: opts.firstNonce,
      count,
      units: opts.units,
      price: opts.price ?? PRICE,
      issuedAt: opts.issuedAt ?? (await h.latest()),
    });
  };

  // -------------------------------------------------------------------------
  // A happy batch
  // -------------------------------------------------------------------------

  describe('a happy batch', () => {
    let a: string;
    let b: string;

    beforeEach(async () => {
      const now = await h.epochNow();
      a = await walletFund(buyer, now, [
        budget(0, CLASS_INFERENCE, 10n * TRAC, CAP),
        budget(1, CLASS_QUERY, 5n * TRAC, CAP),
      ]);
      b = await walletFund(buyer2, now, [budget(3, CLASS_INFERENCE, 8n * TRAC, CAP)], otherKey.address);
    });

    it('counts several groups at once: per node and epoch, the budget fills, the nonce bits, and the events', async () => {
      const epoch = await h.epochNow();
      const g0 = await items(a, 0, s1, 3, { units: 700n });
      const g1 = await items(a, 1, s1, 2, { firstNonce: 3n, units: 1_100n, price: 2n * PRICE });
      const g2 = await items(b, 0, s1, 4, { units: 5n, price: CAP, wallet: otherKey });
      const groups: ReceiptGroup[] = [
        { subscriptionId: a, budgetIndex: 0n, minCounted: 0n, items: g0.items },
        { subscriptionId: a, budgetIndex: 1n, minCounted: 0n, items: g1.items },
        { subscriptionId: b, budgetIndex: 0n, minCounted: 0n, items: g2.items },
      ];
      const s18 = await f.QS.stakeFactor(s1.identityId);
      expect(s18).to.equal(stakeFactorOf(SELLER_STAKE, await f.Params.maximumStake()));

      await scoreNode(f.RSS, epoch, s1.identityId);
      const returned = await f.QS.connect(s1.operational).submitReceiptBatch.staticCall(groups);
      const receipt = await h.accept(s1, groups);

      const values = [3n * 700n * PRICE, 2n * 1_100n * 2n * PRICE, 4n * 5n * CAP];
      // Each group's score is floored on its own.
      const scores = values.map((v) => (v * s18) / SCALE18);
      const r = values[0] + values[1] + values[2];
      const score = scores[0] + scores[1] + scores[2];
      expect(plain(await f.QIS.getNodeEpoch(s1.identityId, epoch))).to.deep.equal({ servedValue: r, weightedValue: score });
      expect(plain(await f.QIS.getNodeEpoch(s2.identityId, epoch))).to.deep.equal({ servedValue: 0n, weightedValue: 0n });
      expect(plain(await f.QIS.getEpochTotals(epoch))).to.deep.equal({
        totalServed: r,
        totalWeighted: score,
        lambdaBps: await f.QIS.lambdaBps(),
      });
      expect(await f.QIS.budgetUsed(a, 0n)).to.equal(values[0]);
      expect(await f.QIS.budgetUsed(a, 1n)).to.equal(values[1]);
      expect(await f.QIS.budgetUsed(b, 0n)).to.equal(values[2]);
      expect(await f.QS.budgetLeft(a, 0n)).to.equal(10n * TRAC - values[0]);
      expect(await f.QS.budgetLeft(a, 1n)).to.equal(5n * TRAC - values[1]);
      expect(await f.QS.budgetLeft(b, 0n)).to.equal(8n * TRAC - values[2]);

      // One nonce space per subscription and seller, across its budgets: nonces 0 to 4 of a.
      expect(await f.QIS.nonceWord(a, s1.identityId, 0n)).to.equal(0b11111n);
      expect(await f.QIS.nonceWord(b, s1.identityId, 0n)).to.equal(0b1111n);
      expect(await f.QIS.nonceWord(a, s2.identityId, 0n)).to.equal(0n);

      // The receipt digests, per group and for the batch.
      const digests = [g0, g1, g2].map((g) =>
        g.requests.map((r, i) => receiptDigestOf(domain, requestDigestOf(domain, r), g.receipts[i])),
      );
      const landed = eventsOf(receipt, f.QS, 'ReceiptsLanded');
      expect(
        landed.map((e) => [e.subscriptionId, e.budgetIndex, e.seller, e.itemCount, e.value, e.counted, e.stakeFactor18, e.groupDigest]),
      ).to.deep.equal([
        [a, 0n, s1.identityId, 3n, values[0], values[0], s18, digestOfDigests(digests[0])],
        [a, 1n, s1.identityId, 2n, values[1], values[1], s18, digestOfDigests(digests[1])],
        [b, 0n, s1.identityId, 4n, values[2], values[2], s18, digestOfDigests(digests[2])],
      ]);
      const batchDigest = digestOfDigests(digests.flat());
      expect(returned).to.equal(batchDigest);
      const [accepted] = eventsOf(receipt, f.QS, 'ReceiptBatchAccepted');
      expect([accepted.seller, accepted.batchDigest, accepted.itemCount, accepted.value, accepted.counted, accepted.stakeFactor18]).to.deep.equal([
        s1.identityId,
        batchDigest,
        9n,
        r,
        r,
        s18,
      ]);

      // No TRAC moves.
      const tokenAddress = (await f.Token.getAddress()).toLowerCase();
      expect(receipt.logs.filter((l) => l.address.toLowerCase() === tokenAddress)).to.have.length(0);
    });

    it('verifies the digest hashRequest returns and records the one hashReceipt returns, at the widest values a batch takes', async () => {
      const widest = (1n << 96n) - 1n;
      const widestId = ethers.toBeHex(ethers.MaxUint256, 32);
      const now = await h.epochNow();
      const wide = await walletFund(owner, now, [
        budget(0, CLASS_INFERENCE, TRAC, widest),
        { serviceId: widestId, serviceClass: CLASS_QUERY, value: TRAC, maxPricePerUnit: widest },
      ]);
      const expiry = (1n << 40n) - 1n;
      const widestUnits = (1n << 64n) - 1n;
      const asked: Array<[number, ServiceRequest, Receipt]> = [];
      // The widest price and value, in one unit of the widest maximum, under the widest nonce.
      let r = await h.requestFor(wide, 0, s1, {
        nonce: widestUnits,
        pricePerUnit: widest,
        maxUnits: widestUnits,
        maxValueWei: widest,
        expiry,
      });
      asked.push([0, r, { resultCommitment: widestId, units: 1n, valueWei: widest, completedAt: r.issuedAt }]);
      // The widest units, at a price of one wei, in the budget of the widest id.
      r = await h.requestFor(wide, 1, s1, {
        nonce: 0n,
        pricePerUnit: 1n,
        maxUnits: widestUnits,
        maxValueWei: widest,
        expiry,
      });
      asked.push([1, r, { resultCommitment: ethers.id('narrow'), units: widestUnits, valueWei: widestUnits, completedAt: r.issuedAt }]);

      const groups: ReceiptGroup[] = [];
      const expected: string[] = [];
      for (const [budgetIndex, request, rec] of asked) {
        // Signed over the contract's own digest, not one built off chain: any
        // other digest in the batch recovers another key and fails BadSignature.
        const requestDigest = await f.QS.hashRequest(request);
        expected.push(await f.QS.hashReceipt({ requestDigest, ...rec }));
        groups.push({
          subscriptionId: wide,
          budgetIndex: BigInt(budgetIndex),
          minCounted: 0n,
          items: [itemOf(request, rec, signCompact(key, requestDigest))],
        });
      }

      await scoreNode(f.RSS, now, s1.identityId);
      const returned = await f.QS.connect(s1.operational).submitReceiptBatch.staticCall(groups);
      const receipt = await h.accept(s1, groups);
      const landed = eventsOf(receipt, f.QS, 'ReceiptsLanded');
      expect(landed.map((e) => e.groupDigest)).to.deep.equal(expected.map((digest) => digestOfDigests([digest])));
      expect(returned).to.equal(digestOfDigests(expected));
      // Each group claims its whole value and counts what its budget holds.
      expect(landed.map((e) => [e.value, e.counted])).to.deep.equal([
        [widest, TRAC],
        [widestUnits, TRAC],
      ]);
      expect(await f.QIS.budgetUsed(wide, 0n)).to.equal(TRAC);
      expect(await f.QIS.budgetUsed(wide, 1n)).to.equal(TRAC);
    });

    it('later batches add to the totals, another seller counts in the same budget apart, and a group above what the budget has left counts that much', async () => {
      const epoch = await h.epochNow();
      const first = await items(a, 0, s1, 2, { units: 1_000n });
      await h.accept(s1, [{ subscriptionId: a, budgetIndex: 0n, minCounted: 0n, items: first.items }]);
      const second = await items(a, 0, s1, 3, { firstNonce: 2n, units: 1_000n });
      await h.accept(s1, [{ subscriptionId: a, budgetIndex: 0n, minCounted: 0n, items: second.items }]);
      const other = await items(a, 0, s2, 2, { units: 1_000n });
      await h.accept(s2, [{ subscriptionId: a, budgetIndex: 0n, minCounted: 0n, items: other.items }]);

      expect((await f.QIS.getNodeEpoch(s1.identityId, epoch)).servedValue).to.equal(5n * 1_000n * PRICE);
      expect((await f.QIS.getNodeEpoch(s2.identityId, epoch)).servedValue).to.equal(2n * 1_000n * PRICE);
      expect((await f.QIS.getEpochTotals(epoch)).totalServed).to.equal(7n * 1_000n * PRICE);
      expect(await f.QIS.budgetUsed(a, 0n)).to.equal(7n * 1_000n * PRICE);
      expect(await f.QIS.nonceWord(a, s1.identityId, 0n)).to.equal(0b11111n);
      expect(await f.QIS.nonceWord(a, s2.identityId, 0n)).to.equal(0b11n);

      // The budget funded 10 TRAC; a group of 30 TRAC more lands for what is
      // left of it, and its nonces are all used.
      const big = await items(a, 0, s2, 3, { firstNonce: 2n, units: 10n ** 10n, price: 10n ** 9n });
      await h.accept(s2, [{ subscriptionId: a, budgetIndex: 0n, minCounted: 0n, items: big.items }]);
      expect(await f.QIS.budgetUsed(a, 0n)).to.equal(10n * TRAC);
      expect(await f.QS.budgetLeft(a, 0n)).to.equal(0n);
      expect((await f.QIS.getNodeEpoch(s2.identityId, epoch)).servedValue).to.equal(10n * TRAC - 5n * 1_000n * PRICE);
      expect((await f.QIS.getEpochTotals(epoch)).totalServed).to.equal(10n * TRAC);
      expect(await f.QIS.nonceWord(a, s2.identityId, 0n)).to.equal(0b11111n);
    });

    it('the stake factor is captured once per batch and never revised: a later stake change moves only later batches', async () => {
      const cap = await f.Params.maximumStake();
      const epoch = await h.epochNow();
      const first = await items(a, 0, s1, 1);
      await h.accept(s1, [{ subscriptionId: a, budgetIndex: 0n, minCounted: 0n, items: first.items }]);
      const before = await f.QIS.getNodeEpoch(s1.identityId, epoch);
      const v = 1_000n * PRICE;
      expect(before.weightedValue).to.equal((v * stakeFactorOf(SELLER_STAKE, cap)) / SCALE18);

      await stakeOn({ ...f, operational: s1.operational }, s1.identityId, 2n * SELLER_STAKE);
      expect((await f.QIS.getNodeEpoch(s1.identityId, epoch)).weightedValue).to.equal(before.weightedValue);
      const second = await items(a, 0, s1, 1, { firstNonce: 1n });
      await h.accept(s1, [{ subscriptionId: a, budgetIndex: 0n, minCounted: 0n, items: second.items }]);
      expect((await f.QIS.getNodeEpoch(s1.identityId, epoch)).weightedValue).to.equal(
        before.weightedValue + (v * stakeFactorOf(3n * SELLER_STAKE, cap)) / SCALE18,
      );
    });

    it('a seller with a profile and a place in the table but no stake factor counts with a score of 0', async () => {
      // A challenge snapshot of 0 limits the factor at 0, as for proofs.
      await f.RSS.setNodeChallengeStakeSnapshot(s1.identityId, 0n);
      const g = await items(a, 0, s1, 2);
      await h.accept(s1, [{ subscriptionId: a, budgetIndex: 0n, minCounted: 0n, items: g.items }]);
      expect(plain(await f.QIS.getNodeEpoch(s1.identityId, await h.epochNow()))).to.deep.equal({
        servedValue: 2n * 1_000n * PRICE,
        weightedValue: 0n,
      });
    });
  });

  // -------------------------------------------------------------------------
  // The Core Node gate
  // -------------------------------------------------------------------------

  describe('the Core Node gate', () => {
    let a: string;
    beforeEach(async () => {
      a = await walletFund(buyer, await h.epochNow(), [budget(0, CLASS_INFERENCE, 10n * TRAC, CAP)]);
    });

    it('a node with a profile but no place in the sharding table is refused', async () => {
      const minimum = await f.Params.minimumStake();
      const unstaked = await h.seller(44, 0n);
      const below = await h.seller(46, minimum - 1n);
      for (const s of [unstaked, below]) {
        const g = await items(a, 0, s, 1);
        await expect(h.submit(s, [{ subscriptionId: a, budgetIndex: 0n, minCounted: 0n, items: g.items }]))
          .to.be.revertedWithCustomError(f.QS, 'NodeNotInShardingTable')
          .withArgs(s.identityId);
      }
    });

    it("the node's admin key is refused, as an address that is no node's key", async () => {
      const g = await items(a, 0, s1, 1);
      for (const sender of [s1.admin, buyer, f.accounts[50]]) {
        await expect(f.QS.connect(sender).submitReceiptBatch([{ subscriptionId: a, budgetIndex: 0n, minCounted: 0n, items: g.items }]))
          .to.be.revertedWithCustomError(f.QS, 'ProfileDoesntExist')
          .withArgs(0n);
      }
      await h.accept(s1, [{ subscriptionId: a, budgetIndex: 0n, minCounted: 0n, items: g.items }]);
    });

    it('a node with no node score in the current epoch is refused, whatever its score in another, and lands once it has one', async () => {
      const epoch = await h.epochNow();
      const g = await items(a, 0, s1, 1);
      const groups = [{ subscriptionId: a, budgetIndex: 0n, minCounted: 0n, items: g.items }];
      await expect(f.QS.connect(s1.operational).submitReceiptBatch(groups))
        .to.be.revertedWithCustomError(f.QS, 'NoNodeScore')
        .withArgs(s1.identityId, epoch);

      await scoreNode(f.RSS, epoch + 1n, s1.identityId);
      await expect(f.QS.connect(s1.operational).submitReceiptBatch(groups))
        .to.be.revertedWithCustomError(f.QS, 'NoNodeScore')
        .withArgs(s1.identityId, epoch);
      expect(await f.QIS.budgetUsed(a, 0n)).to.equal(0n);
      expect(await f.QIS.nonceWord(a, s1.identityId, 0n)).to.equal(0n);

      await scoreNode(f.RSS, epoch, s1.identityId);
      await f.QS.connect(s1.operational).submitReceiptBatch(groups);
      expect(await f.QIS.budgetUsed(a, 0n)).to.equal(g.items[0].valueWei);

      // Nor does the score of an epoch that has ended open the one after it.
      await time.increaseTo(await h.epochStart(epoch + 2n));
      await expect(f.QS.connect(s1.operational).submitReceiptBatch(groups))
        .to.be.revertedWithCustomError(f.QS, 'NoNodeScore')
        .withArgs(s1.identityId, epoch + 2n);
    });
  });

  // -------------------------------------------------------------------------
  // The faults of OT-RFC-27
  // -------------------------------------------------------------------------

  describe('the faults, one by one', () => {
    let a: string;
    let epoch: bigint;

    beforeEach(async () => {
      epoch = await h.epochNow();
      a = await walletFund(buyer, epoch, [
        budget(0, CLASS_INFERENCE, 10n * TRAC, CAP),
        budget(1, CLASS_QUERY, 10n * TRAC, CAP),
      ]);
    });

    /**
     * A batch of two good groups, then `bad` as the third item of the second
     * group. Asserts it reverts with that position and `fault`, and that
     * nothing was written: all or nothing.
     */
    const expectFault = async (bad: ReceiptItem, fault: bigint) => {
      const good0 = await items(a, 0, s1, 2);
      const good1 = await items(a, 1, s1, 2, { firstNonce: 2n });
      const groups: ReceiptGroup[] = [
        { subscriptionId: a, budgetIndex: 0n, minCounted: 0n, items: good0.items },
        { subscriptionId: a, budgetIndex: 1n, minCounted: 0n, items: [...good1.items, bad] },
      ];
      const before = [
        await f.QIS.nonceWord(a, s1.identityId, 0n),
        await f.QIS.budgetUsed(a, 0n),
        await f.QIS.budgetUsed(a, 1n),
        plain(await f.QIS.getNodeEpoch(s1.identityId, epoch)),
        plain(await f.QIS.getEpochTotals(epoch)),
      ];
      await expect(h.submit(s1, groups)).to.be.revertedWithCustomError(f.QS, 'ReceiptFault').withArgs(1n, 2n, fault);
      expect([
        await f.QIS.nonceWord(a, s1.identityId, 0n),
        await f.QIS.budgetUsed(a, 0n),
        await f.QIS.budgetUsed(a, 1n),
        plain(await f.QIS.getNodeEpoch(s1.identityId, epoch)),
        plain(await f.QIS.getEpochTotals(epoch)),
      ]).to.deep.equal(before);
    };

    it('F1, an invalid signature: another key, a malformed signature, or a high s', async () => {
      const r = await h.requestFor(a, 1, s1);
      await expectFault(h.itemFor(r, {}, otherKey), Fault.BadSignature);
      await expectFault({ ...h.itemFor(r), sigR: ethers.ZeroHash }, Fault.BadSignature);
      await expectFault({ ...h.itemFor(r), sigVS: ethers.toBeHex(SECP256K1_N - 1n, 32) }, Fault.BadSignature);
    });

    it('F1: the high-s form of a signature is refused, and its low-s twin from the same signer accepted', async () => {
      // A compact signature has 255 bits of s, so the high-s twin of a real
      // key's signature almost never fits. Recover instead the signer of a
      // chosen high s, and fund a subscription whose session key is that signer.
      const now = await h.epochNow();
      const b = await f.SSS.getBudget(a, 0n);
      const r: ServiceRequest = {
        subscriptionId: subscriptionIdOf(buyer2.address, now),
        serviceId: b.serviceId,
        seller: s1.identityId,
        nonce: 0n,
        pricePerUnit: PRICE,
        maxUnits: 10n,
        maxValueWei: 10n * PRICE,
        // After the subscription's funding below, so within it; the twin lands once
        // the request is served, at this time.
        issuedAt: (await h.latest()) + 100n,
        expiry: (await h.latest()) + DAY,
      };
      const digest = requestDigestOf(domain, r);
      const sigR = signCompact(key, ethers.id('any digest')).sigR; // any valid x-coordinate
      const highS = SECP256K1_HALF_N + 1n;
      expect(highS < 1n << 255n).to.equal(true);
      const signer = ethers.getAddress(
        ethers.dataSlice(
          await hre.ethers.provider.call({
            to: '0x0000000000000000000000000000000000000001',
            data: ethers.AbiCoder.defaultAbiCoder().encode(
              ['bytes32', 'uint8', 'bytes32', 'uint256'],
              [digest, 27, sigR, highS],
            ),
          }),
          12,
        ),
      );
      await walletFund(buyer2, now, [budget(0, CLASS_INFERENCE, 10n * TRAC, CAP)], signer);
      const receipt = fullReceipt(r);
      const high = itemOf(r, receipt, { sigR, sigVS: ethers.toBeHex(highS, 32) });
      const low = itemOf(r, receipt, { sigR, sigVS: ethers.toBeHex((1n << 255n) | (SECP256K1_N - highS), 32) });

      await expect(h.submit(s1, [{ subscriptionId: r.subscriptionId, budgetIndex: 0n, minCounted: 0n, items: [high] }]))
        .to.be.revertedWithCustomError(f.QS, 'ReceiptFault')
        .withArgs(0n, 0n, Fault.BadSignature);
      await time.setNextBlockTimestamp(r.issuedAt);
      await h.accept(s1, [{ subscriptionId: r.subscriptionId, budgetIndex: 0n, minCounted: 0n, items: [low] }]);
      expect(await f.QIS.budgetUsed(r.subscriptionId, 0n)).to.equal(10n * PRICE);
    });

    it('F2, the wrong seller, subscription or budget: the contract fills them in, so the signature fails', async () => {
      // Signed for seller 2, sent by seller 1.
      await expectFault(h.itemFor(await h.requestFor(a, 1, s2)), Fault.BadSignature);
      // Signed for budget 0, claimed in budget 1.
      await expectFault(h.itemFor(await h.requestFor(a, 0, s1)), Fault.BadSignature);
      // Signed for another subscription of the same session key, claimed in this one.
      const other = await walletFund(buyer2, epoch, [budget(1, CLASS_QUERY, 10n * TRAC, CAP)]);
      expect((await f.SSS.getBudget(other, 0n)).serviceId).to.equal((await f.SSS.getBudget(a, 1n)).serviceId);
      await expectFault(h.itemFor(await h.requestFor(other, 0, s1)), Fault.BadSignature);
      // The same request, claimed where it was signed for, is accepted.
      await h.accept(s1, [{ subscriptionId: other, budgetIndex: 0n, minCounted: 0n, items: [h.itemFor(await h.requestFor(other, 0, s1))] }]);
    });

    it('F3, an inactive Conviction Account grant: a request issued at or after its revocation, or its expiry', async () => {
      const { accountId } = await openConvictionAccount({
        ...f,
        owner,
        buyer: buyer2,
        committed: 100_000n * TRAC,
        limit: 1_000n * TRAC,
      });
      const r0 = requestOf(accountId, epoch, { budgets: [budget(0, CLASS_INFERENCE, 10n * TRAC, CAP)], sessionKey: key.address });
      await f.SS.connect(buyer2).fundFromAccount(r0);
      const p = subscriptionIdOf(buyer2.address, epoch);

      // Issued before the revocation: accepted, also after it.
      const before = await h.requestFor(p, 0, s1, { nonce: 0n });
      await f.SS.connect(owner).removeBuyer(accountId, buyer2.address);
      const revokedAt = (await f.SSS.getGrant(accountId, buyer2.address)).revokedAt;
      expect(before.issuedAt).to.be.lessThan(revokedAt);
      await h.accept(s1, [{ subscriptionId: p, budgetIndex: 0n, minCounted: 0n, items: [h.itemFor(before)] }]);

      const at = h.itemFor(await h.requestFor(p, 0, s1, { nonce: 1n, issuedAt: revokedAt }));
      await expect(h.submit(s1, [{ subscriptionId: p, budgetIndex: 0n, minCounted: 0n, items: [at] }]))
        .to.be.revertedWithCustomError(f.QS, 'ReceiptFault')
        .withArgs(0n, 0n, Fault.InactiveGrant);

      // A grant that expires inside its subscription: refused from the expiry on.
      const buyer3 = f.accounts[23];
      const expiresAt = (await h.epochStart(epoch + 1n)) - 1_000n;
      const second = await openConvictionAccount({
        ...f,
        owner,
        buyer: buyer3,
        committed: 100_000n * TRAC,
        limit: 1_000n * TRAC,
        expiresAt,
      });
      await f.SS.connect(buyer3).fundFromAccount(
        requestOf(second.accountId, epoch, { budgets: [budget(0, CLASS_INFERENCE, 10n * TRAC, CAP)], sessionKey: key.address }),
      );
      const q = subscriptionIdOf(buyer3.address, epoch);
      const afterExpiry = h.itemFor(await h.requestFor(q, 0, s1, { nonce: 0n, issuedAt: expiresAt }));
      await expect(h.submit(s1, [{ subscriptionId: q, budgetIndex: 0n, minCounted: 0n, items: [afterExpiry] }]))
        .to.be.revertedWithCustomError(f.QS, 'ReceiptFault')
        .withArgs(0n, 0n, Fault.InactiveGrant);
      const justBefore = h.itemFor(await h.requestFor(q, 0, s1, { nonce: 1n, issuedAt: expiresAt - 1n }));
      await time.setNextBlockTimestamp(expiresAt - 1n);
      await h.accept(s1, [{ subscriptionId: q, budgetIndex: 0n, minCounted: 0n, items: [justBefore] }]);
    });

    it('F4, a duplicate: a nonce from an earlier batch, twice in one group, or in two budgets of the subscription', async () => {
      const first = await items(a, 0, s1, 1, { firstNonce: 9n });
      await h.accept(s1, [{ subscriptionId: a, budgetIndex: 0n, minCounted: 0n, items: first.items }]);
      await expectFault(h.itemFor(await h.requestFor(a, 1, s1, { nonce: 9n })), Fault.DuplicateNonce);
      // Nonce 2 is the second group's first good item.
      await expectFault(h.itemFor(await h.requestFor(a, 1, s1, { nonce: 2n, maxUnits: 999n })), Fault.DuplicateNonce);
      // Nonce 0 is the first group's, in budget 0.
      await expectFault(h.itemFor(await h.requestFor(a, 1, s1, { nonce: 0n, maxUnits: 999n })), Fault.DuplicateNonce);
      // Another seller's nonces are its own.
      await h.accept(s2, [{ subscriptionId: a, budgetIndex: 1n, minCounted: 0n, items: [h.itemFor(await h.requestFor(a, 1, s2, { nonce: 9n }))] }]);
    });

    it('F5, an expired authorization: before the subscription, completed before issue, after expiry or after the batch', async () => {
      const s = await f.SSS.getSubscription(a);
      const r = await h.requestFor(a, 1, s1);
      // A minute on, so a receipt completed after its expiry is not also after the batch.
      await time.increase(60n);
      const cases: Array<[Partial<ServiceRequest>, Partial<Receipt>]> = [
        [{ issuedAt: s.startsAt - 1n }, {}],
        [{}, { completedAt: r.issuedAt - 1n }],
        [{ expiry: r.issuedAt + 5n }, { completedAt: r.issuedAt + 6n }],
        // Inside the subscription and before expiry, but an hour after the batch.
        [{}, { completedAt: r.issuedAt + 3_600n }],
      ];
      for (const [request, receipt] of cases) {
        const bad = { ...r, ...request };
        await expectFault(h.itemFor(bad, { completedAt: bad.issuedAt, ...receipt }), Fault.OutsideTime);
      }
      // At the bounds it is accepted: issued at the subscription's start, completed
      // at expiry, in a batch at that time, the last second of the subscription.
      const last = s.endsAt - 1n;
      const edge = { ...r, issuedAt: s.startsAt, expiry: last };
      await h.acceptAt(last, s1, [{ subscriptionId: a, budgetIndex: 1n, minCounted: 0n, items: [h.itemFor(edge, { completedAt: last })] }]);
    });

    it('F5: a subscription of the next epoch takes no batch, and no stake factor, ahead of its time, and a receipt lands only once it is completed', async () => {
      const p = await walletFund(buyer2, epoch + 1n, [budget(0, CLASS_INFERENCE, 10n * TRAC, CAP)]);
      const s = await f.SSS.getSubscription(p);
      expect(s.startsAt).to.equal(await h.epochStart(epoch + 1n));
      const r = await h.requestFor(p, 0, s1, { nonce: 0n, issuedAt: s.startsAt });
      const item = h.itemFor(r); // completed when issued, at the subscription's start
      await expect(h.submit(s1, [{ subscriptionId: p, budgetIndex: 0n, minCounted: 0n, items: [item] }]))
        .to.be.revertedWithCustomError(f.QS, 'GroupFault')
        .withArgs(0n, Fault.OutsideEpoch);
      expect(await f.QIS.budgetUsed(p, 0n)).to.equal(0n);
      expect(plain(await f.QIS.getNodeEpoch(s1.identityId, epoch + 1n))).to.deep.equal({ servedValue: 0n, weightedValue: 0n });

      // The seller's stake triples before the subscription starts; the batch, once
      // the request is served, captures the stake factor of its own time.
      await stakeOn({ ...f, operational: s1.operational }, s1.identityId, 2n * SELLER_STAKE);
      await h.acceptAt(s.startsAt, s1, [{ subscriptionId: p, budgetIndex: 0n, minCounted: 0n, items: [item] }]);
      const v = 1_000n * PRICE;
      expect(plain(await f.QIS.getNodeEpoch(s1.identityId, epoch + 1n))).to.deep.equal({
        servedValue: v,
        weightedValue: (v * stakeFactorOf(3n * SELLER_STAKE, await f.Params.maximumStake())) / SCALE18,
      });
      expect(await f.QIS.budgetUsed(p, 0n)).to.equal(v);

      // Within the running subscription too: completed one second after the batch
      // is refused, completed in the batch's own second is accepted.
      const now = await h.latest();
      const soon = await h.requestFor(p, 0, s1, { nonce: 50n, issuedAt: now });
      const done = h.itemFor(soon, { completedAt: now + 11n });
      await time.setNextBlockTimestamp(now + 10n);
      await expect(h.submit(s1, [{ subscriptionId: p, budgetIndex: 0n, minCounted: 0n, items: [done] }]))
        .to.be.revertedWithCustomError(f.QS, 'ReceiptFault')
        .withArgs(0n, 0n, Fault.OutsideTime);
      await time.setNextBlockTimestamp(now + 11n);
      await h.accept(s1, [{ subscriptionId: p, budgetIndex: 0n, minCounted: 0n, items: [done] }]);
    });

    it("F6, a price or price-cap breach: a zero price, or one above the budget's cap", async () => {
      await expectFault(h.itemFor(await h.requestFor(a, 1, s1, { pricePerUnit: 0n, maxValueWei: 0n })), Fault.PriceOutOfRange);
      await expectFault(
        h.itemFor(await h.requestFor(a, 1, s1, { pricePerUnit: CAP + 1n, maxValueWei: 1_000n * (CAP + 1n) })),
        Fault.PriceOutOfRange,
      );
      await h.accept(s1, [
        {
          subscriptionId: a,
          budgetIndex: 1n,
          minCounted: 0n,
          items: [h.itemFor(await h.requestFor(a, 1, s1, { pricePerUnit: CAP, maxValueWei: 1_000n * CAP }))],
        },
      ]);
    });

    it('F7, impossible arithmetic: zero units, more than the maximum, a value other than units × price, or above the maximum', async () => {
      const r = await h.requestFor(a, 1, s1);
      await expectFault(h.itemFor(r, { units: 0n, valueWei: 0n }), Fault.BadArithmetic);
      await expectFault(h.itemFor(r, { units: r.maxUnits + 1n, valueWei: (r.maxUnits + 1n) * PRICE }), Fault.BadArithmetic);
      await expectFault(h.itemFor(r, { units: 10n, valueWei: 10n * PRICE + 1n }), Fault.BadArithmetic);
      await expectFault(h.itemFor(r, { units: 10n, valueWei: 10n * PRICE - 1n }), Fault.BadArithmetic);
      const capped = { ...r, maxValueWei: r.maxUnits * PRICE - 1n };
      await expectFault(h.itemFor(capped), Fault.BadArithmetic);
      // Fewer units than the maximum, at exactly the signed price, are accepted.
      await h.accept(s1, [{ subscriptionId: a, budgetIndex: 1n, minCounted: 0n, items: [h.itemFor(r, { units: 10n, valueWei: 10n * PRICE })] }]);
      expect(await f.QIS.budgetUsed(a, 1n)).to.equal(10n * PRICE);
    });

    it('F8, an inconsistent result commitment: zero', async () => {
      await expectFault(h.itemFor(await h.requestFor(a, 1, s1), { resultCommitment: ethers.ZeroHash }), Fault.ZeroResultCommitment);
    });
  });

  // -------------------------------------------------------------------------
  // The group checks
  // -------------------------------------------------------------------------

  describe('the group checks and the batch deadline', () => {
    let a: string;
    let epoch: bigint;

    beforeEach(async () => {
      epoch = await h.epochNow();
      a = await walletFund(buyer, epoch, [budget(0, CLASS_INFERENCE, 10n * TRAC, CAP)]);
    });

    it("an unknown subscription, an unknown budget, an empty group and a minimum above the group's value are refused, with the group index", async () => {
      const good = await items(a, 0, s1, 1);
      const more = await items(a, 0, s1, 1, { firstNonce: 1n });
      const unknown = ethers.id('never-funded');
      for (const [group, fault] of [
        [{ subscriptionId: unknown, budgetIndex: 0n, minCounted: 0n, items: good.items }, Fault.UnknownSubscription],
        [{ subscriptionId: a, budgetIndex: 1n, minCounted: 0n, items: good.items }, Fault.UnknownBudget],
        [{ subscriptionId: a, budgetIndex: 0n, minCounted: 0n, items: [] }, Fault.EmptyGroup],
        [{ subscriptionId: a, budgetIndex: 0n, minCounted: more.items[0].valueWei + 1n, items: more.items }, Fault.BelowMinCounted],
      ] as Array<[ReceiptGroup, bigint]>) {
        await expect(h.submit(s1, [{ subscriptionId: a, budgetIndex: 0n, minCounted: 0n, items: good.items }, group]))
          .to.be.revertedWithCustomError(f.QS, 'GroupFault')
          .withArgs(1n, fault);
      }
      // An unknown subscription or budget has nothing left.
      expect(await f.QS.budgetLeft(unknown, 0n)).to.equal(0n);
      expect(await f.QS.budgetLeft(a, 1n)).to.equal(0n);
    });

    it("a batch lands up to the last second of its subscription's epoch, and at the epoch's end is refused, though the seller has a score in the new epoch", async () => {
      const issuedAt = await h.latest();
      const first = await items(a, 0, s1, 1, { issuedAt });
      const second = await items(a, 0, s1, 1, { issuedAt, firstNonce: 1n });
      const deadline = await h.epochStart(epoch + 1n);
      expect((await f.SSS.getSubscription(a)).endsAt).to.equal(deadline);
      expect(await f.Chronos.epochAtTimestamp(deadline - 1n)).to.equal(epoch);
      expect(await f.Chronos.epochAtTimestamp(deadline)).to.equal(epoch + 1n);

      await scoreNode(f.RSS, epoch + 1n, s1.identityId);
      await h.acceptAt(deadline - 1n, s1, [{ subscriptionId: a, budgetIndex: 0n, minCounted: 0n, items: first.items }]);
      expect(await f.QIS.budgetUsed(a, 0n)).to.equal(first.items[0].valueWei);
      await expect(h.submitAt(deadline, s1, [{ subscriptionId: a, budgetIndex: 0n, minCounted: 0n, items: second.items }]))
        .to.be.revertedWithCustomError(f.QS, 'GroupFault')
        .withArgs(0n, Fault.OutsideEpoch);
      expect(await f.QIS.budgetUsed(a, 0n)).to.equal(first.items[0].valueWei);
    });

    /** An opted-in account whose buyer, buyer2, funds a one-budget subscription of `e`. */
    const accountSubscriptionOf = async (e: bigint) => {
      const { accountId } = await openConvictionAccount({
        ...f,
        owner,
        buyer: buyer2,
        committed: 100_000n * TRAC,
        limit: 1_000n * TRAC,
      });
      await f.SS.connect(buyer2).fundFromAccount(
        requestOf(accountId, e, { budgets: [budget(0, CLASS_INFERENCE, 10n * TRAC, CAP)], sessionKey: key.address }),
      );
      return { accountId, p: subscriptionIdOf(buyer2.address, e) };
    };

    it('a revocation does not cut a funded subscription short: a request served before it lands until the epoch ends, one issued after it never does', async () => {
      const { accountId, p } = await accountSubscriptionOf(epoch);
      const served = await items(p, 0, s1, 2);
      // Revoked ten minutes after the requests were served.
      await time.setNextBlockTimestamp(served.requests[0].issuedAt + 600n);
      await f.SS.connect(owner).removeBuyer(accountId, buyer2.address);
      const revokedAt = (await f.SSS.getGrant(accountId, buyer2.address)).revokedAt;
      await scoreNode(f.RSS, epoch + 1n, s1.identityId);

      // Two hours after the revocation, the seller's batch lands.
      await h.acceptAt(revokedAt + 7_200n, s1, [{ subscriptionId: p, budgetIndex: 0n, minCounted: 0n, items: [served.items[0]] }]);
      expect(await f.QIS.budgetUsed(p, 0n)).to.equal(served.items[0].valueWei);
      // The subscription keeps the deadline of every subscription of its epoch: the epoch's end.
      const deadline = await h.epochStart(epoch + 1n);
      expect((await f.SSS.getSubscription(p)).endsAt).to.equal(deadline);
      expect((await f.SSS.getSubscription(a)).endsAt).to.equal(deadline);
      // A request issued at the revocation or later is refused, item by item.
      const after = h.itemFor(await h.requestFor(p, 0, s1, { nonce: 9n, issuedAt: revokedAt }));
      await expect(h.submit(s1, [{ subscriptionId: p, budgetIndex: 0n, minCounted: 0n, items: [after] }]))
        .to.be.revertedWithCustomError(f.QS, 'ReceiptFault')
        .withArgs(0n, 0n, Fault.InactiveGrant);
      // The other served request lands in the last second before the deadline, and at the deadline nothing does.
      const third = h.itemFor(await h.requestFor(p, 0, s1, { nonce: 8n, issuedAt: served.requests[0].issuedAt }));
      await h.acceptAt(deadline - 1n, s1, [{ subscriptionId: p, budgetIndex: 0n, minCounted: 0n, items: [served.items[1]] }]);
      await expect(h.submitAt(deadline, s1, [{ subscriptionId: p, budgetIndex: 0n, minCounted: 0n, items: [third] }]))
        .to.be.revertedWithCustomError(f.QS, 'GroupFault')
        .withArgs(0n, Fault.OutsideEpoch);
    });

    it('an expiry the owner brings forward does not cut the subscription short either', async () => {
      const { accountId, p } = await accountSubscriptionOf(epoch);
      const served = await items(p, 0, s1, 2);
      const expiresAt = served.requests[0].issuedAt + 600n;
      await f.SS.connect(owner).setBuyerLimits(accountId, buyer2.address, {
        maxCostPerEpoch: 1_000n * TRAC,
        expiresAt,
      });

      await h.acceptAt(expiresAt + 7_200n, s1, [{ subscriptionId: p, budgetIndex: 0n, minCounted: 0n, items: [served.items[0]] }]);
      expect(await f.QIS.budgetUsed(p, 0n)).to.equal(served.items[0].valueWei);
      const after = h.itemFor(await h.requestFor(p, 0, s1, { nonce: 9n, issuedAt: expiresAt }));
      await expect(h.submit(s1, [{ subscriptionId: p, budgetIndex: 0n, minCounted: 0n, items: [after] }]))
        .to.be.revertedWithCustomError(f.QS, 'ReceiptFault')
        .withArgs(0n, 0n, Fault.InactiveGrant);
      // The deadline is still the epoch's end: the other served request lands in its last second.
      const deadline = await h.epochStart(epoch + 1n);
      expect((await f.SSS.getSubscription(p)).endsAt).to.equal(deadline);
      await h.acceptAt(deadline - 1n, s1, [{ subscriptionId: p, budgetIndex: 0n, minCounted: 0n, items: [served.items[1]] }]);
      expect(await f.QIS.budgetUsed(p, 0n)).to.equal(served.items[0].valueWei + served.items[1].valueWei);
    });

    it('a subscription funded ahead and revoked before it starts takes no request, and its cost rolls forward with the rest of the money', async () => {
      const next = epoch + 1n;
      const { accountId, p } = await accountSubscriptionOf(next);
      await f.SS.connect(owner).removeBuyer(accountId, buyer2.address);
      const revokedAt = (await f.SSS.getGrant(accountId, buyer2.address)).revokedAt;
      const s = await f.SSS.getSubscription(p);
      expect(revokedAt).to.be.lessThan(s.startsAt);

      // A request in the subscription was issued once the grant had ended; one
      // issued before the revocation lies before the subscription. Each is refused
      // item by item, the subscription's deadline still ahead.
      const inSubscription = h.itemFor(await h.requestFor(p, 0, s1, { nonce: 0n, issuedAt: s.startsAt }));
      await expect(h.submitAt(s.startsAt + 60n, s1, [{ subscriptionId: p, budgetIndex: 0n, minCounted: 0n, items: [inSubscription] }]))
        .to.be.revertedWithCustomError(f.QS, 'ReceiptFault')
        .withArgs(0n, 0n, Fault.InactiveGrant);
      const early = h.itemFor(await h.requestFor(p, 0, s1, { nonce: 1n, issuedAt: revokedAt - 1n }));
      await expect(h.submit(s1, [{ subscriptionId: p, budgetIndex: 0n, minCounted: 0n, items: [early] }]))
        .to.be.revertedWithCustomError(f.QS, 'ReceiptFault')
        .withArgs(0n, 0n, Fault.OutsideTime);
      expect(s.endsAt).to.equal(await h.epochStart(next + 1n));

      // Nothing breaks: the epochs end with no value in them, so their pools are
      // 0 and their money, the subscription's cost with the rest, stays booked under
      // them, for the first epoch in which value counts.
      await time.increaseTo(s.endsAt);
      expect(await f.QS.epochPool(epoch)).to.equal(0n);
      expect(await f.QS.epochPool(next)).to.equal(0n);
      expect(await f.QIS.fundingIn(epoch)).to.deep.equal([10n * TRAC, 0n]);
      expect(await f.QIS.fundingIn(next)).to.deep.equal([0n, s.cost]);
      const later = await walletFund(owner, next + 1n, [budget(0, CLASS_INFERENCE, TRAC, CAP)]);
      const g = await items(later, 0, s1, 1);
      await h.accept(s1, [{ subscriptionId: later, budgetIndex: 0n, minCounted: 0n, items: g.items }]);
      expect(await f.QS.epochPool(next + 1n)).to.equal(TRAC + s.cost + 10n * TRAC);
    });
  });

  // -------------------------------------------------------------------------
  // The bitmap, the bounds, the pause and activation
  // -------------------------------------------------------------------------

  describe('the nonce bitmap and the batch bounds', () => {
    let a: string;

    beforeEach(async () => {
      a = await walletFund(buyer, await h.epochNow(), [budget(0, CLASS_INFERENCE, 10n * TRAC, CAP)]);
    });

    it('a word holds 256 nonces: 0, 255, 256, 511, 512 and the largest nonce land in their words and bits', async () => {
      const top = (1n << 64n) - 1n;
      const nonces = [0n, 255n, 256n, 511n, 512n, top];
      const group = await Promise.all(nonces.map(async (nonce) => h.itemFor(await h.requestFor(a, 0, s1, { nonce }))));
      await h.accept(s1, [{ subscriptionId: a, budgetIndex: 0n, minCounted: 0n, items: group }]);
      expect(await f.QIS.nonceWord(a, s1.identityId, 0n)).to.equal((1n << 255n) | 1n);
      expect(await f.QIS.nonceWord(a, s1.identityId, 1n)).to.equal((1n << 255n) | 1n);
      expect(await f.QIS.nonceWord(a, s1.identityId, 2n)).to.equal(1n);
      expect(await f.QIS.nonceWord(a, s1.identityId, top >> 8n)).to.equal(1n << 255n);
      expect(await f.QIS.nonceWord(a, s1.identityId, 3n)).to.equal(0n);
    });

    it('non-monotone nonces in one group write back each word, and a duplicate across words is still caught', async () => {
      const group = await Promise.all(
        [5n, 300n, 6n, 301n].map(async (nonce) => h.itemFor(await h.requestFor(a, 0, s1, { nonce }))),
      );
      await h.accept(s1, [{ subscriptionId: a, budgetIndex: 0n, minCounted: 0n, items: group }]);
      expect(await f.QIS.nonceWord(a, s1.identityId, 0n)).to.equal((1n << 5n) | (1n << 6n));
      expect(await f.QIS.nonceWord(a, s1.identityId, 1n)).to.equal((1n << 44n) | (1n << 45n));
      const again = await Promise.all(
        [7n, 302n, 5n].map(async (nonce) => h.itemFor(await h.requestFor(a, 0, s1, { nonce, maxUnits: 999n }))),
      );
      await expect(h.submit(s1, [{ subscriptionId: a, budgetIndex: 0n, minCounted: 0n, items: again }]))
        .to.be.revertedWithCustomError(f.QS, 'ReceiptFault')
        .withArgs(0n, 2n, Fault.DuplicateNonce);
    });

    it('takes 1 to maxGroupsPerBatch groups and 1 to maxItemsPerBatch items, from QueryInferenceStorage', async () => {
      await forward(f.QIS, 'setMaxGroupsPerBatch', [2n]);
      await forward(f.QIS, 'setMaxItemsPerBatch', [4n]);
      const g = await items(a, 0, s1, 5);
      const group = (from: number, to: number): ReceiptGroup => ({
        subscriptionId: a,
        budgetIndex: 0n,
        minCounted: 0n,
        items: g.items.slice(from, to),
      });
      for (const [groups, groupCount, itemCount] of [
        [[], 0n, 0n],
        [[group(0, 1), group(1, 2), group(2, 3)], 3n, 3n],
        [[group(0, 5)], 1n, 5n],
        [[group(0, 3), group(3, 5)], 2n, 5n],
        [[group(0, 0)], 1n, 0n],
      ] as Array<[ReceiptGroup[], bigint, bigint]>) {
        await expect(h.submit(s1, groups))
          .to.be.revertedWithCustomError(f.QS, 'BatchOutOfBounds')
          .withArgs(groupCount, itemCount);
      }
      await h.accept(s1, [group(0, 2), group(2, 4)]);
      expect(await f.QIS.budgetUsed(a, 0n)).to.equal(4n * 1_000n * PRICE);
    });

    it('is refused while QueryInferenceStorage is paused, and goes on once it is not', async () => {
      const g = await items(a, 0, s1, 1);
      await forward(f.QIS, 'setPaused', [true]);
      await expect(h.submit(s1, [{ subscriptionId: a, budgetIndex: 0n, minCounted: 0n, items: g.items }])).to.be.revertedWithCustomError(
        f.QS,
        'QueryInferencePaused',
      );
      await forward(f.QIS, 'setPaused', [false]);
      await h.accept(s1, [{ subscriptionId: a, budgetIndex: 0n, minCounted: 0n, items: g.items }]);
    });

    it('is refused before the activation epoch and while it is unset', async () => {
      const g = await items(a, 0, s1, 1);
      const fresh = (await (
        await hre.ethers.getContractFactory('QueryInferenceStorage')
      ).deploy(await f.Hub.getAddress())) as unknown as QueryInferenceStorage;
      await fresh.waitForDeployment();
      await f.Hub.setContractAddress('QueryInferenceStorage', await fresh.getAddress());
      await forward(fresh, 'initialize');
      await forward(f.QS, 'initialize');
      const now = await h.epochNow();
      await expect(h.submit(s1, [{ subscriptionId: a, budgetIndex: 0n, minCounted: 0n, items: g.items }]))
        .to.be.revertedWithCustomError(f.QS, 'QueryInferenceNotActive')
        .withArgs(0n, now);
      await forward(fresh, 'setActivationEpoch', [now + 1n]);
      await expect(h.submit(s1, [{ subscriptionId: a, budgetIndex: 0n, minCounted: 0n, items: g.items }]))
        .to.be.revertedWithCustomError(f.QS, 'QueryInferenceNotActive')
        .withArgs(now + 1n, now);
    });
  });
});
