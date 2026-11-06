// How the receipt batches of the query/inference pool (OT-RFC-27) count, end to
// end on the real account and staking stacks: a group counts in the transaction
// that lands it, up to what the buyer's budget has left.
//
// Groups:
//   - landing order: a batch fills the budget at face value and joins the
//     node's and the epoch's totals, the next batch takes what is left, the
//     nonces of its whole group stay used, and what has landed never shrinks;
//   - minCounted: a group refuses to land for less, or for nothing, and burns
//     no nonce, so its seller keeps the receipts for a later top-up;
//   - a Conviction Account budget, funded through the built Conviction Account
//     path, counts at its discount at any fill, at two tiers;
//   - the stake factor: taken once per batch, and score = R × S;
//   - the deadline: only the subscription's own epoch, to its last second, whatever
//     becomes of the grant;
//   - the score gate: a node score in the current epoch;
//   - top-ups: what they lift, and until when;
//   - the epoch's λ: fixed when its first value counts;
//   - the pause, activation and the settlement out of the Hub.
//
// What a batch checks item by item is in v10-query-inference-receipts.test.ts,
// and the pool that the counted value shares in v10-query-inference-pool.test.ts.

import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { loadFixture, takeSnapshot, time } from '@nomicfoundation/hardhat-network-helpers';
import { expect } from 'chai';
import { BaseContract, ContractTransactionReceipt, ethers } from 'ethers';
import hre from 'hardhat';

import { QueryInferenceSettlement, QueryInferenceStorage } from '../typechain';
import { blockTime, eventsOf } from './helpers/account-stack';
import {
  BPS,
  ServiceBudget,
  CLASS_INFERENCE,
  CLASS_QUERY,
  Domain,
  TRAC,
  budget,
  requestOf,
  signTerms,
  subscriptionIdOf,
  walletRequestOf,
} from './helpers/conviction-service';
import {
  Fault,
  ReceiptGroup,
  ReceiptItem,
  SCALE18,
  ServiceRequest,
  hardhatWallet,
  openConvictionAccount,
  queryInferenceDomain,
  scoreNode,
  stakeFactorOf,
  stakeOn,
} from './helpers/query-inference';
import { PRICE, CAP, ReceiptsHelpers, Seller, deployReceiptsStack, receiptsHelpers } from './helpers/query-inference-receipts';

const STAKE_S_50 = 1_250_000n * TRAC; // S = sqrt(0.25) = 0.5
const STAKE_S_90 = 4_050_000n * TRAC; // S = sqrt(0.81) = 0.9
const COMMITTED_30 = 100_000n * TRAC; // an account's commitment for a 30 % discount
const COMMITTED_75 = 1_000_000n * TRAC; // and for a 75 % discount

/** This suite's own fixture, so loadFixture keeps a snapshot for it alone. */
async function deployFixture() {
  return deployReceiptsStack();
}

type Fixture = Awaited<ReturnType<typeof deployFixture>>;

describe('@integration Counting the receipt batches of the query/inference pool', function () {
  let f: Fixture;
  let h: ReceiptsHelpers;
  let domain: Domain;
  let owner: SignerWithAddress;
  let buyer: SignerWithAddress;
  let buyer2: SignerWithAddress;
  let buyer3: SignerWithAddress;
  let nextAccount: number;
  let nextNonce: bigint;
  const key = hardhatWallet(60);

  beforeEach(async () => {
    hre.helpers.resetDeploymentsJson();
    f = await loadFixture(deployFixture);
    domain = await queryInferenceDomain(f.QIS);
    h = receiptsHelpers({ f, domain, key });
    owner = f.accounts[20];
    buyer = f.accounts[21];
    buyer2 = f.accounts[22];
    buyer3 = f.accounts[25];
    nextAccount = 40;
    nextNonce = 0n;
  });

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  const toEpoch = async (e: bigint) => time.increaseTo(await h.epochStart(e));
  const forward = async (contract: BaseContract, fn: string, args: unknown[] = []) =>
    f.Hub.forwardCall(await contract.getAddress(), contract.interface.encodeFunctionData(fn, args));

  /**
   * A Core Node seller with `stake` TRAC, so its stake factor is sqrt(stake / 5M),
   * under a name of its own: a name already taken reverts the profile.
   */
  const seller = async (stake: bigint): Promise<Seller> => {
    const operational = f.accounts[nextAccount++];
    const admin = f.accounts[nextAccount++];
    const label = `counting seller ${nextAccount}`;
    const receipt = await (
      await f.Profile.connect(operational).createProfile(admin.address, [], label, ethers.id(label), 0n)
    ).wait();
    const identityId = BigInt(receipt!.logs[0].topics[1]);
    await stakeOn({ ...f, operational }, identityId, stake);
    return { identityId, operational, admin };
  };

  const walletFund = async (who: SignerWithAddress, epoch: bigint, budgets: ServiceBudget[]): Promise<string> => {
    const value = budgets.reduce((a, b) => a + b.value, 0n);
    await f.Token.mint(who.address, value);
    await f.Token.connect(who).approve(await f.SSW.getAddress(), value);
    await f.SSW.connect(who).fundFromWallet(walletRequestOf(epoch, { budgets, sessionKey: key.address }));
    return subscriptionIdOf(who.address, epoch);
  };

  /** `buyer`'s wallet subscription of `epoch`, with one budget of `value`. */
  const fundOne = async (epoch: bigint, value: bigint) =>
    walletFund(buyer, epoch, [budget(0, CLASS_INFERENCE, value, CAP)]);

  /** A wallet top-up of `value` to the first budget of `buyer`'s subscription. */
  const topUp = async (p: string, value: bigint) => {
    await f.Token.mint(buyer.address, value);
    await f.Token.connect(buyer).approve(await f.SSW.getAddress(), value);
    await f.SSW.connect(buyer).topUpFromWallet(p, [budget(0, CLASS_INFERENCE, value, CAP)], ethers.ZeroHash);
  };

  /** A subscription of `epoch` that `buyer` funds from an account committing `committed`, with one budget of `value`. */
  const accountSubscription = async (buyer: SignerWithAddress, epoch: bigint, committed: bigint, value: bigint) => {
    const { accountId, terms } = await openConvictionAccount({
      ...f,
      owner,
      buyer,
      committed,
      limit: 1_000n * TRAC,
    });
    await f.SS.connect(buyer).fundFromAccount(
      requestOf(accountId, epoch, { budgets: [budget(0, CLASS_INFERENCE, value, CAP)], sessionKey: key.address }),
    );
    return { accountId, terms, p: subscriptionIdOf(buyer.address, epoch) };
  };

  /** A receipt worth `amount` on a subscription's budget for `by`, signed by the session key, under a nonce of its own. */
  const receiptOf = async (
    by: Seller,
    p: string,
    amount: bigint,
    overrides: Partial<ServiceRequest> = {},
    budgetIndex = 0,
  ): Promise<ReceiptItem> => {
    const price = overrides.pricePerUnit ?? PRICE;
    expect(amount % price).to.equal(0n);
    return h.itemFor(
      await h.requestFor(p, budgetIndex, by, {
        nonce: nextNonce++,
        maxUnits: amount / price,
        maxValueWei: amount,
        ...overrides,
      }),
    );
  };

  const groupOf = (p: string, items: ReceiptItem[], minCounted = 0n, budgetIndex = 0n): ReceiptGroup => ({
    subscriptionId: p,
    budgetIndex,
    minCounted,
    items,
  });

  /** `by`, scored in the current epoch if it was not yet, lands one receipt worth `amount` on a subscription's first budget. */
  const land = async (by: Seller, p: string, amount: bigint, minCounted = 0n) =>
    h.accept(by, [groupOf(p, [await receiptOf(by, p, amount)], minCounted)]);

  /** A batch sent as it is: no score is given first, and no block is mined before it. */
  const send = (by: Seller, groups: ReceiptGroup[]) => f.QS.connect(by.operational).submitReceiptBatch(groups);

  const nodeEpoch = async (by: Seller, epoch: bigint) => {
    const n = await f.QIS.getNodeEpoch(by.identityId, epoch);
    return [n.servedValue, n.weightedValue];
  };

  const totals = async (epoch: bigint) => {
    const t = await f.QIS.getEpochTotals(epoch);
    return [t.totalServed, t.totalWeighted];
  };

  const lambdaOf = async (epoch: bigint) => (await f.QIS.getEpochTotals(epoch)).lambdaBps;

  /** What the groups of a landed batch claimed and counted, in order. */
  const counts = (receipt: ContractTransactionReceipt) =>
    eventsOf(receipt, f.QS, 'ReceiptsLanded').map((e) => [e.value, e.counted]);

  const budgetState = async (p: string, budgetIndex = 0n) => [
    await f.QIS.budgetUsed(p, budgetIndex),
    await f.QS.budgetLeft(p, budgetIndex),
  ];

  const grossOf = async (epoch: bigint, sellers: Seller[]) =>
    Promise.all(sellers.map((s) => f.QS.queryInferenceGross(epoch, s.identityId)));

  /** OT-RFC-27's formula, floored per term as the contract floors it. */
  const formula = (pool: bigint, lambda: bigint, r: bigint, totalServed: bigint, qis: bigint, sumQis: bigint) =>
    (pool * (BPS - lambda) * r) / (BPS * totalServed) + (pool * lambda * qis) / (BPS * sumQis);

  // -------------------------------------------------------------------------
  // Landing order
  // -------------------------------------------------------------------------

  describe('landing order', () => {
    it('one seller within a budget: the budget fills, R and the score join the node and the epoch, and the events say what was claimed and counted', async () => {
      const s1 = await seller(STAKE_S_50);
      const e = await h.epochNow();
      const p = await fundOne(e, 10n * TRAC);
      expect(await budgetState(p)).to.deep.equal([0n, 10n * TRAC]);
      const vaultBefore = await f.Token.balanceOf(await f.Vault.getAddress());

      const items = [await receiptOf(s1, p, 3n * TRAC), await receiptOf(s1, p, TRAC)];
      const receipt = await h.accept(s1, [groupOf(p, items)]);

      expect(await budgetState(p)).to.deep.equal([4n * TRAC, 6n * TRAC]);
      expect(await nodeEpoch(s1, e)).to.deep.equal([4n * TRAC, 2n * TRAC]);
      expect(await totals(e)).to.deep.equal([4n * TRAC, 2n * TRAC]);

      const [landed] = eventsOf(receipt, f.QS, 'ReceiptsLanded');
      expect([
        landed.subscriptionId,
        landed.budgetIndex,
        landed.seller,
        landed.itemCount,
        landed.value,
        landed.counted,
        landed.stakeFactor18,
      ]).to.deep.equal([p, 0n, s1.identityId, 2n, 4n * TRAC, 4n * TRAC, SCALE18 / 2n]);
      const [accepted] = eventsOf(receipt, f.QS, 'ReceiptBatchAccepted');
      expect([accepted.seller, accepted.itemCount, accepted.value, accepted.counted, accepted.stakeFactor18]).to.deep.equal([
        s1.identityId,
        2n,
        4n * TRAC,
        4n * TRAC,
        SCALE18 / 2n,
      ]);

      // It counts in the subscription's own epoch and no other, and no TRAC moves.
      expect(await nodeEpoch(s1, e + 1n)).to.deep.equal([0n, 0n]);
      expect(await totals(e + 1n)).to.deep.equal([0n, 0n]);
      expect(await f.Token.balanceOf(await f.Vault.getAddress())).to.equal(vaultBefore);
    });

    it("budget 100: A lands 80, then B lands 40 and counts 20, and all of B's nonces stay used; in the reverse order B counts 40 and A 60", async () => {
      const a = await seller(STAKE_S_50);
      const b = await seller(STAKE_S_90);
      const e = await h.epochNow();
      const p = await fundOne(e, 100n * TRAC);
      const start = await takeSnapshot();
      // B's 40 is two receipts of 20: the second does not fit.
      const groupOfB = async () =>
        groupOf(p, [await receiptOf(b, p, 20n * TRAC, { nonce: 0n }), await receiptOf(b, p, 20n * TRAC, { nonce: 1n })]);

      await land(a, p, 80n * TRAC);
      const late = await groupOfB();
      expect(counts(await h.accept(b, [late]))).to.deep.equal([[40n * TRAC, 20n * TRAC]]);
      expect(await nodeEpoch(a, e)).to.deep.equal([80n * TRAC, 40n * TRAC]);
      expect(await nodeEpoch(b, e)).to.deep.equal([20n * TRAC, 18n * TRAC]);
      expect(await totals(e)).to.deep.equal([100n * TRAC, 58n * TRAC]);
      expect(await budgetState(p)).to.deep.equal([100n * TRAC, 0n]);
      expect(await f.QIS.nonceWord(p, b.identityId, 0n)).to.equal(0b11n);

      // The part that did not count is spent: a top-up does not bring it back.
      await topUp(p, 60n * TRAC);
      await expect(h.submit(b, [late]))
        .to.be.revertedWithCustomError(f.QS, 'ReceiptFault')
        .withArgs(0n, 0n, Fault.DuplicateNonce);
      expect(await nodeEpoch(b, e)).to.deep.equal([20n * TRAC, 18n * TRAC]);

      await start.restore();
      expect(counts(await h.accept(b, [await groupOfB()]))).to.deep.equal([[40n * TRAC, 40n * TRAC]]);
      expect(counts(await land(a, p, 80n * TRAC))).to.deep.equal([[80n * TRAC, 60n * TRAC]]);
      expect(await nodeEpoch(b, e)).to.deep.equal([40n * TRAC, 36n * TRAC]);
      expect(await nodeEpoch(a, e)).to.deep.equal([60n * TRAC, 30n * TRAC]);
      expect(await totals(e)).to.deep.equal([100n * TRAC, 66n * TRAC]);
      expect(await budgetState(p)).to.deep.equal([100n * TRAC, 0n]);
    });

    it('two groups of one batch on one budget: the second sees what the first filled', async () => {
      const s1 = await seller(STAKE_S_50);
      const e = await h.epochNow();
      const p = await fundOne(e, 100n * TRAC);
      const receipt = await h.accept(s1, [
        groupOf(p, [await receiptOf(s1, p, 70n * TRAC)]),
        groupOf(p, [await receiptOf(s1, p, 50n * TRAC)]),
      ]);
      expect(counts(receipt)).to.deep.equal([
        [70n * TRAC, 70n * TRAC],
        [50n * TRAC, 30n * TRAC],
      ]);
      const [accepted] = eventsOf(receipt, f.QS, 'ReceiptBatchAccepted');
      expect([accepted.itemCount, accepted.value, accepted.counted]).to.deep.equal([2n, 120n * TRAC, 100n * TRAC]);
      expect(await nodeEpoch(s1, e)).to.deep.equal([100n * TRAC, 50n * TRAC]);
      expect(await budgetState(p)).to.deep.equal([100n * TRAC, 0n]);
    });

    it("a late huge claim by the buyer's own node takes only what is left, and what landed stays", async () => {
      const honest = await seller(STAKE_S_50);
      const own = await seller(STAKE_S_50);
      const e = await h.epochNow();
      expect(await f.QIS.lambdaBps()).to.equal(0n); // as this stack leaves it
      const p = await fundOne(e, 100n * TRAC);
      await land(honest, p, 40n * TRAC);

      const huge = 1_000_000_000n * TRAC;
      expect(counts(await land(own, p, huge))).to.deep.equal([[huge, 60n * TRAC]]);
      expect(await nodeEpoch(honest, e)).to.deep.equal([40n * TRAC, 20n * TRAC]);
      expect(await nodeEpoch(own, e)).to.deep.equal([60n * TRAC, 30n * TRAC]);
      expect(await totals(e)).to.deep.equal([100n * TRAC, 50n * TRAC]);

      // The rest of the honest node's work has nothing left to count against,
      // but the pool still pays what landed, at its share.
      expect(counts(await land(honest, p, 40n * TRAC))).to.deep.equal([[40n * TRAC, 0n]]);
      expect(await nodeEpoch(honest, e)).to.deep.equal([40n * TRAC, 20n * TRAC]);
      await toEpoch(e + 1n);
      expect(await grossOf(e, [honest, own])).to.deep.equal([40n * TRAC, 60n * TRAC]);
    });

    it('each budget of a subscription fills on its own, and what is left reads 0 for an unknown subscription or budget', async () => {
      const s1 = await seller(STAKE_S_50);
      const e = await h.epochNow();
      const p = await walletFund(buyer, e, [
        budget(0, CLASS_INFERENCE, 4n * TRAC, CAP),
        budget(1, CLASS_QUERY, 4n * TRAC, CAP),
      ]);
      const receipt = await h.accept(s1, [
        groupOf(p, [await receiptOf(s1, p, 8n * TRAC)]),
        groupOf(p, [await receiptOf(s1, p, 3n * TRAC, {}, 1)], 0n, 1n),
      ]);
      expect(counts(receipt)).to.deep.equal([
        [8n * TRAC, 4n * TRAC],
        [3n * TRAC, 3n * TRAC],
      ]);
      expect(await budgetState(p, 0n)).to.deep.equal([4n * TRAC, 0n]);
      expect(await budgetState(p, 1n)).to.deep.equal([3n * TRAC, TRAC]);
      expect(await nodeEpoch(s1, e)).to.deep.equal([7n * TRAC, (7n * TRAC) / 2n]);

      expect(await f.QS.budgetLeft(p, 2n)).to.equal(0n);
      expect(await f.QS.budgetLeft(hre.ethers.id('never-funded'), 0n)).to.equal(0n);
    });
  });

  // -------------------------------------------------------------------------
  // minCounted
  // -------------------------------------------------------------------------

  describe('minCounted', () => {
    it('budget 100, A and B each serve 80 and A lands first: B with a minimum of 80 reverts and burns nothing, and after a top-up of 60 the same batch lands for 80', async () => {
      const a = await seller(STAKE_S_50);
      const b = await seller(STAKE_S_50);
      const e = await h.epochNow();
      const p = await fundOne(e, 100n * TRAC);
      await land(a, p, 80n * TRAC);

      const batch = [groupOf(p, [await receiptOf(b, p, 80n * TRAC, { nonce: 7n })], 80n * TRAC)];
      await expect(h.submit(b, batch)).to.be.revertedWithCustomError(f.QS, 'GroupFault').withArgs(0n, Fault.BelowMinCounted);
      expect(await f.QIS.nonceWord(p, b.identityId, 0n)).to.equal(0n);
      expect(await nodeEpoch(b, e)).to.deep.equal([0n, 0n]);
      expect(await budgetState(p)).to.deep.equal([80n * TRAC, 20n * TRAC]);

      // A wei short of the minimum is still short of it.
      await topUp(p, 60n * TRAC - 1n);
      await expect(h.submit(b, batch)).to.be.revertedWithCustomError(f.QS, 'GroupFault').withArgs(0n, Fault.BelowMinCounted);

      await topUp(p, 1n);
      expect(await f.QS.budgetLeft(p, 0n)).to.equal(80n * TRAC);
      expect(counts(await h.accept(b, batch))).to.deep.equal([[80n * TRAC, 80n * TRAC]]);
      expect(await f.QIS.nonceWord(p, b.identityId, 0n)).to.equal(1n << 7n);
      expect(await nodeEpoch(a, e)).to.deep.equal([80n * TRAC, 40n * TRAC]);
      expect(await nodeEpoch(b, e)).to.deep.equal([80n * TRAC, 40n * TRAC]);
      expect(await budgetState(p)).to.deep.equal([160n * TRAC, 0n]);
    });

    it('a group on a full budget lands for 0 at a minimum of 0, spending its nonces and leaving the batch\'s other groups to count; any higher minimum reverts the batch', async () => {
      const a = await seller(STAKE_S_50);
      const b = await seller(STAKE_S_50);
      const e = await h.epochNow();
      const p = await walletFund(buyer, e, [
        budget(0, CLASS_INFERENCE, 100n * TRAC, CAP),
        budget(1, CLASS_QUERY, 10n * TRAC, CAP),
      ]);
      await land(a, p, 100n * TRAC);

      const onFull = await receiptOf(b, p, 80n * TRAC, { nonce: 0n });
      const fits = await receiptOf(b, p, 5n * TRAC, { nonce: 1n }, 1);
      await expect(h.submit(b, [groupOf(p, [fits], 0n, 1n), groupOf(p, [onFull], 1n)]))
        .to.be.revertedWithCustomError(f.QS, 'GroupFault')
        .withArgs(1n, Fault.BelowMinCounted);
      expect(await f.QIS.nonceWord(p, b.identityId, 0n)).to.equal(0n);
      expect(await nodeEpoch(b, e)).to.deep.equal([0n, 0n]);
      expect(await f.QIS.budgetUsed(p, 1n)).to.equal(0n);

      const landed = await h.accept(b, [groupOf(p, [fits], 0n, 1n), groupOf(p, [onFull])]);
      expect(counts(landed)).to.deep.equal([
        [5n * TRAC, 5n * TRAC],
        [80n * TRAC, 0n],
      ]);
      expect((await nodeEpoch(b, e))[0]).to.equal(5n * TRAC);
      expect(await f.QIS.budgetUsed(p, 0n)).to.equal(100n * TRAC);
      expect(await f.QIS.budgetUsed(p, 1n)).to.equal(5n * TRAC);
      // Its nonce is spent, so a top-up can't bring that receipt back.
      await expect(h.submit(b, [groupOf(p, [onFull])]))
        .to.be.revertedWithCustomError(f.QS, 'ReceiptFault')
        .withArgs(0n, 0n, Fault.DuplicateNonce);
    });

    it('a second group of a batch below its minimum reverts the whole batch: the first has counted nothing', async () => {
      const s1 = await seller(STAKE_S_50);
      const e = await h.epochNow();
      const p = await fundOne(e, 100n * TRAC);
      const first = groupOf(p, [await receiptOf(s1, p, 70n * TRAC, { nonce: 0n })]);
      const second = await receiptOf(s1, p, 50n * TRAC, { nonce: 1n });
      await expect(h.submit(s1, [first, groupOf(p, [second], 31n * TRAC)]))
        .to.be.revertedWithCustomError(f.QS, 'GroupFault')
        .withArgs(1n, Fault.BelowMinCounted);
      expect(await budgetState(p)).to.deep.equal([0n, 100n * TRAC]);
      expect(await f.QIS.nonceWord(p, s1.identityId, 0n)).to.equal(0n);

      // Exactly at its minimum, the same batch lands.
      const receipt = await h.accept(s1, [first, groupOf(p, [second], 30n * TRAC)]);
      expect(counts(receipt)).to.deep.equal([
        [70n * TRAC, 70n * TRAC],
        [50n * TRAC, 30n * TRAC],
      ]);
      expect(await nodeEpoch(s1, e)).to.deep.equal([100n * TRAC, 50n * TRAC]);
    });
  });

  // -------------------------------------------------------------------------
  // Conviction Account budgets
  // -------------------------------------------------------------------------

  describe('a Conviction Account budget counts at its discount', () => {
    it("at the 75 % tier, R is a quarter of what counts at any fill, the minimum is at face value, and a full budget's R is the subscription's cost", async () => {
      const s1 = await seller(STAKE_S_50);
      const e = await h.epochNow();
      const { p } = await accountSubscription(buyer2, e, COMMITTED_75, 100n * TRAC);
      const subscription = await f.SSS.getSubscription(p);
      expect([subscription.discountBps, subscription.value, subscription.cost]).to.deep.equal([7_500n, 100n * TRAC, 25n * TRAC]);
      expect(await f.QIS.accountFunding(e)).to.equal(25n * TRAC);
      expect(await f.QIS.accountFunding(e + 1n)).to.equal(0n);

      await land(s1, p, 20n * TRAC);
      expect(await nodeEpoch(s1, e)).to.deep.equal([5n * TRAC, (5n * TRAC) / 2n]);
      expect(await budgetState(p)).to.deep.equal([20n * TRAC, 80n * TRAC]);

      await land(s1, p, 30n * TRAC);
      expect(await nodeEpoch(s1, e)).to.deep.equal([(25n * TRAC) / 2n, (25n * TRAC) / 4n]);

      await expect(land(s1, p, 100n * TRAC, 50n * TRAC + 1n))
        .to.be.revertedWithCustomError(f.QS, 'GroupFault')
        .withArgs(0n, Fault.BelowMinCounted);
      expect(counts(await land(s1, p, 100n * TRAC, 50n * TRAC))).to.deep.equal([[100n * TRAC, 50n * TRAC]]);
      expect(await nodeEpoch(s1, e)).to.deep.equal([25n * TRAC, (25n * TRAC) / 2n]);
      expect(await totals(e)).to.deep.equal([25n * TRAC, (25n * TRAC) / 2n]);
      expect(await budgetState(p)).to.deep.equal([100n * TRAC, 0n]);
      expect((await f.QIS.getNodeEpoch(s1.identityId, e)).servedValue).to.equal(subscription.cost);
    });

    it('counts 6.65 of 9.5 at the 30 % tier and 2.375 of 9.5 at the 75 % tier, and their budgets of 10 give 7 and 2.5 when full, their costs', async () => {
      const s1 = await seller(STAKE_S_50);
      const e = await h.epochNow();
      const subscriptions: Array<[string, bigint]> = [];
      for (const [buyer, committed, bps] of [
        [buyer2, COMMITTED_30, 3_000n],
        [buyer3, COMMITTED_75, 7_500n],
      ] as Array<[SignerWithAddress, bigint, bigint]>) {
        const { p } = await accountSubscription(buyer, e, committed, 10n * TRAC);
        const subscription = await f.SSS.getSubscription(p);
        expect(subscription.discountBps).to.equal(bps);
        expect(subscription.cost).to.equal((10n * TRAC * (BPS - bps)) / BPS);
        subscriptions.push([p, subscription.cost]);
      }

      // 9.5 of face value on each budget, as five receipts.
      const groups: ReceiptGroup[] = [];
      for (const [p] of subscriptions) {
        const items: ReceiptItem[] = [];
        for (let i = 0; i < 5; i++) items.push(await receiptOf(s1, p, 19n * (TRAC / 10n)));
        groups.push(groupOf(p, items));
      }
      const face = 95n * (TRAC / 10n);
      expect(counts(await h.accept(s1, groups))).to.deep.equal([
        [face, face],
        [face, face],
      ]);
      expect((await nodeEpoch(s1, e))[0]).to.equal((face * 7n) / 10n + face / 4n);

      // The rest of each budget, however much is claimed.
      for (const [p] of subscriptions) {
        expect(counts(await land(s1, p, TRAC))).to.deep.equal([[TRAC, TRAC / 2n]]);
        expect(await budgetState(p)).to.deep.equal([10n * TRAC, 0n]);
      }
      expect((await nodeEpoch(s1, e))[0]).to.equal(subscriptions[0][1] + subscriptions[1][1]);
      expect(subscriptions.map(([, cost]) => cost)).to.deep.equal([7n * TRAC, (5n * TRAC) / 2n]);
    });

    it('a wallet seller and an account seller at the 75 % tier, each landing 20 with a pool of 50, are paid 40 and 10 at λ 0', async () => {
      const onWallet = await seller(STAKE_S_50);
      const onAccount = await seller(STAKE_S_50);
      const e = await h.epochNow();
      expect(await f.QIS.lambdaBps()).to.equal(0n);
      const wallet = await fundOne(e, 25n * TRAC);
      const { p: account } = await accountSubscription(buyer2, e, COMMITTED_75, 100n * TRAC); // a cost of 25
      expect(await f.QIS.fundingIn(e)).to.deep.equal([25n * TRAC, 25n * TRAC]);

      await land(onWallet, wallet, 20n * TRAC);
      await land(onAccount, account, 20n * TRAC);
      expect((await nodeEpoch(onWallet, e))[0]).to.equal(20n * TRAC);
      expect((await nodeEpoch(onAccount, e))[0]).to.equal(5n * TRAC);

      await toEpoch(e + 1n);
      expect(await f.QS.epochPool(e)).to.equal(50n * TRAC);
      expect(await grossOf(e, [onWallet, onAccount])).to.deep.equal([40n * TRAC, 10n * TRAC]);
    });

    it('each landing floors its own R, so a budget of 1,001 wei at the 75 % tier, at a cost of 250, gives 83 three times, 249 in all', async () => {
      const s1 = await seller(STAKE_S_50);
      const e = await h.epochNow();
      const { p } = await accountSubscription(buyer2, e, COMMITTED_75, 1_001n);
      expect((await f.SSS.getSubscription(p)).cost).to.equal(250n);
      for (const amount of [333n, 333n, 335n]) {
        const item = await receiptOf(s1, p, amount, { pricePerUnit: 1n });
        await h.accept(s1, [groupOf(p, [item])]);
      }
      expect(await nodeEpoch(s1, e)).to.deep.equal([249n, 123n]);
      expect(await budgetState(p)).to.deep.equal([1_001n, 0n]);
    });

    it("a topped-up budget filled completely has an R within 1 wei per top-up of the subscription's cost, and pays no more than the money: 6 wei and a top-up of 6 at the 75 % tier, at a cost of 1 each", async () => {
      const s1 = await seller(STAKE_S_50);
      const e = await h.epochNow();
      const { p } = await accountSubscription(buyer2, e, COMMITTED_75, 6n);
      await f.SS.connect(buyer2).topUpFromAccount(p, [budget(0, CLASS_INFERENCE, 6n, CAP)], ethers.ZeroHash);
      const subscription = await f.SSS.getSubscription(p);
      expect([subscription.value, subscription.cost]).to.deep.equal([12n, 2n]);
      expect(await f.QIS.accountFunding(e)).to.equal(2n);

      await h.accept(s1, [groupOf(p, [await receiptOf(s1, p, 12n, { pricePerUnit: 1n })])]);
      expect(await budgetState(p)).to.deep.equal([12n, 0n]);
      const { servedValue: r } = await f.QIS.getNodeEpoch(s1.identityId, e);
      expect(r).to.equal(3n);
      expect(r).to.be.lte(subscription.cost + 1n);

      await toEpoch(e + 1n);
      expect(await f.QS.epochPool(e)).to.equal(2n);
      expect(await f.QS.queryInferenceGross(e, s1.identityId)).to.be.lte(2n);
    });

    it('a landing whose R floors to 0 fills the budget but is no value: the pool stays 0 and the epoch has not taken its λ', async () => {
      const s1 = await seller(STAKE_S_50);
      const e = await h.epochNow();
      const { p } = await accountSubscription(buyer2, e, COMMITTED_75, 1_001n);
      const dust = await receiptOf(s1, p, 3n, { pricePerUnit: 1n });
      expect(counts(await h.accept(s1, [groupOf(p, [dust])]))).to.deep.equal([[3n, 3n]]);
      expect(await f.QIS.budgetUsed(p, 0n)).to.equal(3n);
      expect(await totals(e)).to.deep.equal([0n, 0n]);
      expect(await f.QS.epochPool(e)).to.equal(0n);
      expect(await grossOf(e, [s1])).to.deep.equal([0n]);

      await forward(f.QIS, 'setLambdaBps', [4_000n]);
      const value = await receiptOf(s1, p, 8n, { pricePerUnit: 1n });
      await h.accept(s1, [groupOf(p, [value])]);
      expect(await lambdaOf(e)).to.equal(4_000n);
      expect(await totals(e)).to.deep.equal([2n, 1n]);
      expect(await f.QS.epochPool(e)).to.equal(250n);
    });
  });

  // -------------------------------------------------------------------------
  // The stake factor
  // -------------------------------------------------------------------------

  describe('the stake factor at landing', () => {
    it('is taken once per batch, score = R × S, and a later stake change moves only later batches', async () => {
      const s1 = await seller(STAKE_S_50);
      const e = await h.epochNow();
      const p = await walletFund(buyer, e, [
        budget(0, CLASS_INFERENCE, 10n * TRAC, CAP),
        budget(1, CLASS_QUERY, 10n * TRAC, CAP),
      ]);
      const half = SCALE18 / 2n;
      expect(await f.QS.stakeFactor(s1.identityId)).to.equal(half);
      const receipt = await h.accept(s1, [
        groupOf(p, [await receiptOf(s1, p, 4n * TRAC)]),
        groupOf(p, [await receiptOf(s1, p, 2n * TRAC, {}, 1)], 0n, 1n),
      ]);
      expect(eventsOf(receipt, f.QS, 'ReceiptsLanded').map((ev) => ev.stakeFactor18)).to.deep.equal([half, half]);
      expect(eventsOf(receipt, f.QS, 'ReceiptBatchAccepted').map((ev) => ev.stakeFactor18)).to.deep.equal([half]);
      expect(await nodeEpoch(s1, e)).to.deep.equal([6n * TRAC, 3n * TRAC]);

      await stakeOn({ ...f, operational: s1.operational }, s1.identityId, STAKE_S_90 - STAKE_S_50);
      expect(await f.QS.stakeFactor(s1.identityId)).to.equal(stakeFactorOf(STAKE_S_90, await f.Params.maximumStake()));
      expect(await f.QS.stakeFactor(s1.identityId)).to.equal((9n * SCALE18) / 10n);
      expect(await nodeEpoch(s1, e)).to.deep.equal([6n * TRAC, 3n * TRAC]);
      expect(await totals(e)).to.deep.equal([6n * TRAC, 3n * TRAC]);

      await land(s1, p, 2n * TRAC);
      expect(await nodeEpoch(s1, e)).to.deep.equal([8n * TRAC, 3n * TRAC + (18n * TRAC) / 10n]);
      expect(await totals(e)).to.deep.equal([8n * TRAC, 3n * TRAC + (18n * TRAC) / 10n]);
    });

    it('takes R at a stake factor with no round form, flooring each group apart', async () => {
      const stake = 500_000n * TRAC;
      const s1 = await seller(stake);
      const s18 = stakeFactorOf(stake, await f.Params.maximumStake());
      expect(await f.QS.stakeFactor(s1.identityId)).to.equal(s18);
      const e = await h.epochNow();
      const p = await fundOne(e, TRAC);
      // 3 and 4 wei at S = 0.316...: 0 and 1, where 7 wei at once would be 2.
      const atOneWei = { pricePerUnit: 1n };
      await h.accept(s1, [
        groupOf(p, [await receiptOf(s1, p, 3n, atOneWei)]),
        groupOf(p, [await receiptOf(s1, p, 4n, atOneWei)]),
      ]);
      expect(await nodeEpoch(s1, e)).to.deep.equal([7n, 1n]);
      expect((7n * s18) / SCALE18).to.equal(2n);

      // At a larger value, each group's score is its R at S.
      const [first, second] = [7n * PRICE, 11n * PRICE];
      await h.accept(s1, [
        groupOf(p, [await receiptOf(s1, p, first)]),
        groupOf(p, [await receiptOf(s1, p, second)]),
      ]);
      expect(await nodeEpoch(s1, e)).to.deep.equal([7n + first + second, 1n + (first * s18) / SCALE18 + (second * s18) / SCALE18]);
    });

    it('stake added since the node took its challenge lifts no factor', async () => {
      const s1 = await seller(STAKE_S_50);
      await f.RSS.setNodeChallengeStakeSnapshot(s1.identityId, STAKE_S_50);
      await stakeOn({ ...f, operational: s1.operational }, s1.identityId, STAKE_S_90 - STAKE_S_50);
      const e = await h.epochNow();
      const p = await fundOne(e, 10n * TRAC);
      await land(s1, p, 2n * TRAC);
      expect(await nodeEpoch(s1, e)).to.deep.equal([2n * TRAC, TRAC]);
    });
  });

  // -------------------------------------------------------------------------
  // The deadline
  // -------------------------------------------------------------------------

  describe("the deadline: the subscription's own epoch", () => {
    it("a batch in the last second of the subscription's epoch lands, and one at the subscription's end is refused", async () => {
      const s1 = await seller(STAKE_S_50);
      const e = await h.epochNow();
      const p = await fundOne(e, 10n * TRAC);
      const { endsAt } = await f.SSS.getSubscription(p);
      expect(endsAt).to.equal(await h.epochStart(e + 1n));
      await scoreNode(f.RSS, e, s1.identityId);
      await scoreNode(f.RSS, e + 1n, s1.identityId);
      const last = groupOf(p, [await receiptOf(s1, p, TRAC, { nonce: 0n })]);
      const tooLate = groupOf(p, [await receiptOf(s1, p, TRAC, { nonce: 1n })]);

      await time.setNextBlockTimestamp(endsAt - 1n);
      const landed = (await (await send(s1, [last])).wait())!;
      expect(await blockTime(landed)).to.equal(endsAt - 1n);
      expect(await nodeEpoch(s1, e)).to.deep.equal([TRAC, TRAC / 2n]);

      await time.setNextBlockTimestamp(endsAt);
      await expect(send(s1, [tooLate])).to.be.revertedWithCustomError(f.QS, 'GroupFault').withArgs(0n, Fault.OutsideEpoch);
      expect(await h.latest()).to.equal(endsAt);
      expect(await f.QIS.nonceWord(p, s1.identityId, 0n)).to.equal(1n);
      expect(await nodeEpoch(s1, e)).to.deep.equal([TRAC, TRAC / 2n]);
      expect(await nodeEpoch(s1, e + 1n)).to.deep.equal([0n, 0n]);
    });

    it('a subscription funded ahead for the next epoch is refused until that epoch, and lands and counts in it', async () => {
      const s1 = await seller(STAKE_S_50);
      const e = await h.epochNow();
      const p = await fundOne(e + 1n, 10n * TRAC);
      const { startsAt } = await f.SSS.getSubscription(p);
      expect(startsAt).to.equal(await h.epochStart(e + 1n));
      const item = await receiptOf(s1, p, TRAC, { issuedAt: startsAt });

      await expect(h.submit(s1, [groupOf(p, [item])])).to.be.revertedWithCustomError(f.QS, 'GroupFault').withArgs(0n, Fault.OutsideEpoch);
      expect(await budgetState(p)).to.deep.equal([0n, 10n * TRAC]);

      await toEpoch(e + 1n);
      await h.accept(s1, [groupOf(p, [item])]);
      expect(await nodeEpoch(s1, e + 1n)).to.deep.equal([TRAC, TRAC / 2n]);
      expect(await nodeEpoch(s1, e)).to.deep.equal([0n, 0n]);
      expect(await budgetState(p)).to.deep.equal([TRAC, 9n * TRAC]);
    });

    it('a subscription of a past epoch is refused, for a request served in time as well, in the next epoch and later', async () => {
      const s1 = await seller(STAKE_S_50);
      const e = await h.epochNow();
      const p = await fundOne(e, 10n * TRAC);
      const served = groupOf(p, [await receiptOf(s1, p, TRAC)]);

      await toEpoch(e + 1n);
      await expect(h.submit(s1, [served])).to.be.revertedWithCustomError(f.QS, 'GroupFault').withArgs(0n, Fault.OutsideEpoch);
      await toEpoch(e + 2n);
      await expect(h.submit(s1, [served])).to.be.revertedWithCustomError(f.QS, 'GroupFault').withArgs(0n, Fault.OutsideEpoch);

      expect(await f.QIS.budgetUsed(p, 0n)).to.equal(0n);
      expect(await f.QIS.nonceWord(p, s1.identityId, 0n)).to.equal(0n);
      for (const epoch of [e, e + 1n, e + 2n]) expect(await nodeEpoch(s1, epoch)).to.deep.equal([0n, 0n]);
    });

    it("a revocation and a new grant move no deadline: a request served before the revocation lands until the epoch's end, one issued after it never does", async () => {
      const s1 = await seller(STAKE_S_50);
      const e = await h.epochNow();
      const { accountId, terms, p } = await accountSubscription(buyer2, e, COMMITTED_30, 10n * TRAC);
      const { endsAt } = await f.SSS.getSubscription(p);
      await land(s1, p, TRAC);

      // Requests served just before the revocation, in the last half hour of
      // the epoch; their batches come later.
      const servedAt = endsAt - 1_900n;
      await time.increaseTo(endsAt - 1_800n);
      await f.SS.connect(owner).removeBuyer(accountId, buyer2.address);
      const served = groupOf(p, [await receiptOf(s1, p, TRAC, { issuedAt: servedAt })]);
      const tooLate = groupOf(p, [await receiptOf(s1, p, TRAC, { issuedAt: servedAt })]);

      // A new grant to the buyer admits no request issued since the revocation.
      const again = { ...terms, nonce: await f.SSS.grantNonce(accountId) };
      await f.SS.connect(owner).addBuyer(again, '0x', await signTerms(buyer2, f.SS, again));
      const issuedAfter = await receiptOf(s1, p, TRAC, { issuedAt: endsAt - 100n });
      await expect(h.submit(s1, [groupOf(p, [issuedAfter])]))
        .to.be.revertedWithCustomError(f.QS, 'ReceiptFault')
        .withArgs(0n, 0n, Fault.InactiveGrant);

      await scoreNode(f.RSS, e + 1n, s1.identityId);
      await time.setNextBlockTimestamp(endsAt - 1n);
      await send(s1, [served]);
      expect((await nodeEpoch(s1, e))[0]).to.equal((2n * TRAC * 7n) / 10n);

      await time.setNextBlockTimestamp(endsAt);
      await expect(send(s1, [tooLate])).to.be.revertedWithCustomError(f.QS, 'GroupFault').withArgs(0n, Fault.OutsideEpoch);
    });
  });

  // -------------------------------------------------------------------------
  // The score gate
  // -------------------------------------------------------------------------

  describe('the score gate', () => {
    it('no node score in the current epoch refuses the batch, a score in the previous epoch does not help, and once the node has proved the same batch lands', async () => {
      const s1 = await seller(STAKE_S_50);
      const e = await h.epochNow();
      const ofE = await fundOne(e, 10n * TRAC);
      const batchOfE = [groupOf(ofE, [await receiptOf(s1, ofE, TRAC)])];
      await expect(send(s1, batchOfE)).to.be.revertedWithCustomError(f.QS, 'NoNodeScore').withArgs(s1.identityId, e);
      expect(await f.QIS.nonceWord(ofE, s1.identityId, 0n)).to.equal(0n);
      expect(await f.QIS.budgetUsed(ofE, 0n)).to.equal(0n);

      await scoreNode(f.RSS, e, s1.identityId);
      await send(s1, batchOfE);
      expect(await nodeEpoch(s1, e)).to.deep.equal([TRAC, TRAC / 2n]);

      await toEpoch(e + 1n);
      expect(await f.RSS.getNodeEpochScore(e, s1.identityId)).to.be.greaterThan(0n);
      const ofNext = await fundOne(e + 1n, 10n * TRAC);
      const batchOfNext = [groupOf(ofNext, [await receiptOf(s1, ofNext, 2n * TRAC)])];
      await expect(send(s1, batchOfNext)).to.be.revertedWithCustomError(f.QS, 'NoNodeScore').withArgs(s1.identityId, e + 1n);
      expect(await nodeEpoch(s1, e + 1n)).to.deep.equal([0n, 0n]);

      await scoreNode(f.RSS, e + 1n, s1.identityId);
      await send(s1, batchOfNext);
      expect(await nodeEpoch(s1, e + 1n)).to.deep.equal([2n * TRAC, TRAC]);
    });
  });

  // -------------------------------------------------------------------------
  // Top-ups
  // -------------------------------------------------------------------------

  describe('top-ups', () => {
    it("a wallet top-up lifts what is left by its value, joins the subscription's epoch, and the next batch to land takes it", async () => {
      const a = await seller(STAKE_S_50);
      const b = await seller(STAKE_S_50);
      const e = await h.epochNow();
      const p = await fundOne(e, 100n * TRAC);
      await land(a, p, 100n * TRAC);
      expect(await f.QS.budgetLeft(p, 0n)).to.equal(0n);

      await topUp(p, 50n * TRAC);
      expect(await f.QS.budgetLeft(p, 0n)).to.equal(50n * TRAC);
      expect(await f.QIS.fundingIn(e)).to.deep.equal([150n * TRAC, 0n]);
      expect(await f.QIS.fundingIn(e + 1n)).to.deep.equal([0n, 0n]);

      // Whoever lands first takes it, whenever it served.
      await land(b, p, 50n * TRAC);
      expect(counts(await land(a, p, 50n * TRAC))).to.deep.equal([[50n * TRAC, 0n]]);
      expect((await nodeEpoch(a, e))[0]).to.equal(100n * TRAC);
      expect((await nodeEpoch(b, e))[0]).to.equal(50n * TRAC);
    });

    it('a top-up to a new budget gives that budget its own fill', async () => {
      const s1 = await seller(STAKE_S_50);
      const e = await h.epochNow();
      const p = await fundOne(e, 10n * TRAC);
      await f.Token.mint(buyer.address, 4n * TRAC);
      await f.Token.connect(buyer).approve(await f.SSW.getAddress(), 4n * TRAC);
      await f.SSW.connect(buyer).topUpFromWallet(p, [budget(1, CLASS_QUERY, 4n * TRAC, CAP)], ethers.ZeroHash);
      expect(await f.QS.budgetLeft(p, 0n)).to.equal(10n * TRAC);
      expect(await f.QS.budgetLeft(p, 1n)).to.equal(4n * TRAC);
      const receipt = await h.accept(s1, [groupOf(p, [await receiptOf(s1, p, 6n * TRAC, {}, 1)], 0n, 1n)]);
      expect(counts(receipt)).to.deep.equal([[6n * TRAC, 4n * TRAC]]);
      expect(await budgetState(p, 0n)).to.deep.equal([0n, 10n * TRAC]);
    });

    it('a Conviction Account top-up lifts what is left at face value and books its cost, at the 75 % tier', async () => {
      const s1 = await seller(STAKE_S_50);
      const e = await h.epochNow();
      const { p } = await accountSubscription(buyer2, e, COMMITTED_75, 100n * TRAC);
      await land(s1, p, 100n * TRAC);
      await f.SS.connect(buyer2).topUpFromAccount(p, [budget(0, CLASS_INFERENCE, 40n * TRAC, CAP)], ethers.ZeroHash);
      expect(await f.QS.budgetLeft(p, 0n)).to.equal(40n * TRAC);
      expect(await f.QIS.fundingIn(e)).to.deep.equal([0n, 35n * TRAC]);
      await land(s1, p, 40n * TRAC);
      const subscription = await f.SSS.getSubscription(p);
      expect(subscription.cost).to.equal(35n * TRAC);
      expect((await nodeEpoch(s1, e))[0]).to.equal(35n * TRAC);
    });

    it("a wallet top-up lands up to the subscription's last second, and is refused at its end and after the epoch's end", async () => {
      const e = await h.epochNow();
      const p = await fundOne(e, 10n * TRAC);
      const { endsAt } = await f.SSS.getSubscription(p);
      await f.Token.mint(buyer.address, 3n * TRAC);
      await f.Token.connect(buyer).approve(await f.SSW.getAddress(), 3n * TRAC);
      const addition = [budget(0, CLASS_INFERENCE, TRAC, CAP)];

      await time.setNextBlockTimestamp(endsAt - 1n);
      await f.SSW.connect(buyer).topUpFromWallet(p, addition, ethers.ZeroHash);
      expect(await f.QS.budgetLeft(p, 0n)).to.equal(11n * TRAC);

      await time.setNextBlockTimestamp(endsAt);
      await expect(f.SSW.connect(buyer).topUpFromWallet(p, addition, ethers.ZeroHash))
        .to.be.revertedWithCustomError(f.SSW, 'SubscriptionEnded')
        .withArgs(p, endsAt);
      expect(await h.latest()).to.equal(endsAt);

      await toEpoch(e + 2n);
      await expect(f.SSW.connect(buyer).topUpFromWallet(p, addition, ethers.ZeroHash))
        .to.be.revertedWithCustomError(f.SSW, 'SubscriptionEnded')
        .withArgs(p, endsAt);
      expect(await f.QS.budgetLeft(p, 0n)).to.equal(11n * TRAC);
      expect(await f.QIS.fundingIn(e)).to.deep.equal([11n * TRAC, 0n]);
      expect(await f.QIS.fundingIn(e + 1n)).to.deep.equal([0n, 0n]);
    });
  });

  // -------------------------------------------------------------------------
  // The epoch's λ
  // -------------------------------------------------------------------------

  describe("the epoch's λ", () => {
    const POOL = 1_000n * TRAC;

    /** A at the stake cap and B at a hundredth of it, stake factors 1 and 0.1, so λ moves their shares. */
    const sellers = async () => {
      const cap = await f.Params.maximumStake();
      const a = await seller(cap);
      const b = await seller(cap / 100n);
      expect(await f.QS.stakeFactor(a.identityId)).to.equal(SCALE18);
      expect(await f.QS.stakeFactor(b.identityId)).to.equal(SCALE18 / 10n);
      return { a, b };
    };

    /** A pool of 1,000 with A at R 200, QIS 200 and B at R 800, QIS 80: ΣR 1,000, ΣQIS 280. */
    const grossAt = (lambda: bigint) => [
      formula(POOL, lambda, 200n * TRAC, 1_000n * TRAC, 200n * TRAC, 280n * TRAC),
      formula(POOL, lambda, 800n * TRAC, 1_000n * TRAC, 80n * TRAC, 280n * TRAC),
    ];

    it('the first value fixes it: a change after that moves only later epochs, even after two changes, with no reward claimed yet', async () => {
      const { a, b } = await sellers();
      const e = await h.epochNow();
      await forward(f.QIS, 'setLambdaBps', [5_000n]);
      const p = await fundOne(e, POOL);
      expect(await lambdaOf(e)).to.equal(0n); // no value yet: nothing is fixed

      await land(a, p, 200n * TRAC);
      expect(await lambdaOf(e)).to.equal(5_000n);

      // A change within the epoch: its second batch keeps the λ of the first.
      await forward(f.QIS, 'setLambdaBps', [10_000n]);
      expect(await f.QIS.lambdaBps()).to.equal(10_000n);
      await land(b, p, 800n * TRAC);
      expect(await lambdaOf(e)).to.equal(5_000n);
      expect(await totals(e)).to.deep.equal([1_000n * TRAC, 280n * TRAC]);
      const fixed = grossAt(5_000n);
      expect(fixed[0]).to.equal(100n * TRAC + (500n * TRAC * 200n) / 280n);
      expect(fixed[1]).to.equal(400n * TRAC + (500n * TRAC * 80n) / 280n);
      expect(await grossOf(e, [a, b])).to.deep.equal(fixed);

      // A change after its end: the same.
      await toEpoch(e + 1n);
      await forward(f.QIS, 'setLambdaBps', [2_000n]);
      expect(await lambdaOf(e)).to.equal(5_000n);
      expect(await grossOf(e, [a, b])).to.deep.equal(fixed);
      expect(fixed[0] + fixed[1] <= POOL).to.equal(true);
      expect(POOL - fixed[0] - fixed[1] < 4n).to.equal(true);

      // The next epoch takes what is in force when its first value counts, and keeps it.
      const next = await fundOne(e + 1n, 10n * TRAC);
      await land(a, next, TRAC);
      expect(await lambdaOf(e + 1n)).to.equal(2_000n);
      await forward(f.QIS, 'setLambdaBps', [7_000n]);
      await land(b, next, TRAC);
      expect(await lambdaOf(e + 1n)).to.equal(2_000n);

      await toEpoch(e + 2n);
      const third = await fundOne(e + 2n, 10n * TRAC);
      await land(a, third, TRAC);
      expect(await lambdaOf(e + 2n)).to.equal(7_000n);

      expect(await lambdaOf(e)).to.equal(5_000n);
      expect(await lambdaOf(e + 1n)).to.equal(2_000n);
      expect(await grossOf(e, [a, b])).to.deep.equal(fixed);
    });

    it('an epoch with no value yet takes each change at once, the current one included, whatever money it has', async () => {
      const { a, b } = await sellers();
      const e = await h.epochNow();
      await forward(f.QIS, 'setLambdaBps', [5_000n]);
      const p = await fundOne(e, POOL);
      await forward(f.QIS, 'setLambdaBps', [1_000n]);
      await forward(f.QIS, 'setLambdaBps', [3_000n]);
      expect(await lambdaOf(e)).to.equal(0n);

      await land(a, p, 200n * TRAC);
      await land(b, p, 800n * TRAC);
      expect(await lambdaOf(e)).to.equal(3_000n);
      expect(await grossOf(e, [a, b])).to.deep.equal(grossAt(3_000n));
    });

    it('its grosses never sum above the pool at λ 0 and at λ 1 either, whatever is set after the first value', async () => {
      const { a, b } = await sellers();
      const e = await h.epochNow();
      const start = await takeSnapshot();
      for (const [atFirstValue, after] of [
        [0n, 10_000n],
        [10_000n, 0n],
      ]) {
        await start.restore();
        await forward(f.QIS, 'setLambdaBps', [atFirstValue]);
        const p = await fundOne(e, POOL);
        await land(a, p, 200n * TRAC);
        await forward(f.QIS, 'setLambdaBps', [after]);
        await land(b, p, 800n * TRAC);
        await toEpoch(e + 1n);
        await forward(f.QIS, 'setLambdaBps', [after]);

        const gross = await grossOf(e, [a, b]);
        expect(gross).to.deep.equal(grossAt(atFirstValue));
        expect(gross[0] + gross[1] <= POOL).to.equal(true);
      }
    });
  });

  // -------------------------------------------------------------------------
  // The pause, activation and the settlement out of the Hub
  // -------------------------------------------------------------------------

  describe('the pause, activation and the settlement out of the Hub', () => {
    it('while paused, a batch reverts, what has landed stays, and the same batch lands once it is off', async () => {
      const s1 = await seller(STAKE_S_50);
      const e = await h.epochNow();
      const p = await fundOne(e, 10n * TRAC);
      await land(s1, p, TRAC);
      const batch = [groupOf(p, [await receiptOf(s1, p, TRAC)])];

      await forward(f.QIS, 'setPaused', [true]);
      await expect(send(s1, batch)).to.be.revertedWithCustomError(f.QS, 'QueryInferencePaused');
      expect(await nodeEpoch(s1, e)).to.deep.equal([TRAC, TRAC / 2n]);

      await forward(f.QIS, 'setPaused', [false]);
      await send(s1, batch);
      expect(await nodeEpoch(s1, e)).to.deep.equal([2n * TRAC, TRAC]);
    });

    it('with activation unset, and before the activation epoch, a batch reverts', async () => {
      const s1 = await seller(STAKE_S_50);
      const e = await h.epochNow();
      const p = await fundOne(e, 10n * TRAC);
      const batch = [groupOf(p, [await receiptOf(s1, p, TRAC)])];
      await scoreNode(f.RSS, e, s1.identityId);

      const fresh = (await (
        await hre.ethers.getContractFactory('QueryInferenceStorage')
      ).deploy(await f.Hub.getAddress())) as unknown as QueryInferenceStorage;
      await fresh.waitForDeployment();
      await f.Hub.setContractAddress('QueryInferenceStorage', await fresh.getAddress());
      await forward(fresh, 'initialize');
      await forward(f.QS, 'initialize');

      await expect(send(s1, batch)).to.be.revertedWithCustomError(f.QS, 'QueryInferenceNotActive').withArgs(0n, e);
      await forward(fresh, 'setActivationEpoch', [e + 1n]);
      await expect(send(s1, batch)).to.be.revertedWithCustomError(f.QS, 'QueryInferenceNotActive').withArgs(e + 1n, e);
    });

    it('with the settlement out of the Hub a batch reverts and burns nothing, and a fresh settlement over the same storage lands it', async () => {
      const s1 = await seller(STAKE_S_50);
      const e = await h.epochNow();
      const p = await fundOne(e, 10n * TRAC);
      await land(s1, p, TRAC);
      const batch = [groupOf(p, [await receiptOf(s1, p, 2n * TRAC, { nonce: 200n })])];

      // A contract registered after it, so it is not the Hub's last entry, as in a full deployment.
      await f.Hub.setContractAddress('RegisteredAfterTheSettlement', f.accounts[9].address);
      await f.Hub.removeContractByName('QueryInferenceSettlement');
      expect(await f.StakingV10.queryInferenceSettlement()).to.equal(ethers.ZeroAddress);
      await expect(send(s1, batch))
        .to.be.revertedWithCustomError(f.QIS, 'UnauthorizedAccess')
        .withArgs('Only Contracts in Hub');
      expect(await f.QIS.nonceWord(p, s1.identityId, 0n)).to.equal(1n); // the first batch's alone
      expect(await nodeEpoch(s1, e)).to.deep.equal([TRAC, TRAC / 2n]);

      const fresh = (await (
        await hre.ethers.getContractFactory('QueryInferenceSettlement')
      ).deploy(await f.Hub.getAddress())) as unknown as QueryInferenceSettlement;
      await fresh.waitForDeployment();
      await f.Hub.setContractAddress('QueryInferenceSettlement', await fresh.getAddress());
      await forward(fresh, 'initialize');
      await fresh.connect(s1.operational).submitReceiptBatch(batch);
      expect(await nodeEpoch(s1, e)).to.deep.equal([3n * TRAC, (3n * TRAC) / 2n]);
    });

    it("with the settlement removed as the Hub's last entry a batch reverts too, in the Hub's own lookup of the sender", async () => {
      const s1 = await seller(STAKE_S_50);
      const e = await h.epochNow();
      const p = await fundOne(e, 10n * TRAC);
      await land(s1, p, TRAC);
      const batch = [groupOf(p, [await receiptOf(s1, p, 2n * TRAC)])];

      await f.Hub.removeContractByName('QueryInferenceSettlement');
      await expect(send(s1, batch)).to.be.revertedWithPanic(0x32);
      expect(await nodeEpoch(s1, e)).to.deep.equal([TRAC, TRAC / 2n]);
    });
  });
});
