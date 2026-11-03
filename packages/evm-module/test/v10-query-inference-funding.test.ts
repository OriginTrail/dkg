// Plan-period funding for the query/inference pool (OT-RFC-27), end to end:
// QueryInferenceStorage, ConvictionServiceStorage, ServiceSubscriptions and
// ServiceSubscriptionsWallet registered in the Hub, on the real account stack.
//
// Groups:
//   - wallet funding: the whole value into the vault with no fee, even with a
//     treasury wired; the record under account 0 and PeriodFunded;
//   - the period: one epoch, the current one (from now to the boundary) or the
//     next (from its start), no other; one per buyer key and epoch, shared by
//     wallet and Conviction Account periods;
//   - the money due: in the epoch after the period, for fundings and top-ups
//     alike, whatever the receipt grace, which stays below one epoch, from a
//     wallet and from a Conviction Account, each in its own ledger;
//   - wallet top-ups and upgrades: caps unchanged, new buckets appended, the
//     value into the vault and due after the period;
//   - Conviction Account top-ups and upgrades: the draw at the account's tier
//     and its cost due after the period, the period limit counting the
//     period's earlier cost, and the usage without another period; a top-up
//     only while the assignment the period was funded under is live, so a new
//     assignment of the key after a revocation or an expiry reopens nothing,
//     while one replaced still live tops up until its own expiry;
//   - refusals: a zero key, before activation or while it is unset (from a
//     wallet and from an account alike), paused, an unknown or ended period, a
//     wrong source or buyer, a changed cap, and the bucket rules; each without
//     partial effect;
//   - a wallet payment the Token answers with false, after every storage write
//     of a funding or a top-up: refused, and all of them undone.
//
// A Conviction Account period funded ahead, and its assignment, is in
// v10-query-inference-assignment-lifetime.test.ts.

import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { loadFixture, time } from '@nomicfoundation/hardhat-network-helpers';
import { expect } from 'chai';
import { BaseContract, ethers, Result } from 'ethers';
import hre from 'hardhat';

import { FalseReturnERC20, QueryInferenceStorage } from '../typechain';
import { blockTime, eventsOf } from './helpers/account-stack';
import {
  CLASS_INFERENCE,
  CLASS_QUERY,
  SESSION_KEY,
  TRAC,
  WalletRequest,
  activateQueryInference,
  bucket,
  costOf,
  requestOf,
  subscriptionIdOf,
  walletRequestOf,
} from './helpers/conviction-service';
import {
  COMMITTED_TIER_BPS as BPS,
  FundingHelpers,
  deployFundingStack,
  fundingHelpers,
} from './helpers/query-inference-funding';

/** This suite's own fixture, so loadFixture keeps a snapshot for it alone. */
async function deployFixture() {
  return deployFundingStack();
}

type Fixture = Awaited<ReturnType<typeof deployFixture>>;

describe('@integration Plan-period funding for the query/inference pool', function () {
  let f: Fixture;
  let h: FundingHelpers;

  let epLen: bigint;
  let owner: SignerWithAddress;
  let buyer: SignerWithAddress;
  let buyer2: SignerWithAddress;
  let stranger: SignerWithAddress;
  let treasury: SignerWithAddress;

  /** The stack each test runs on, and the helpers built from it; the one place either is set. */
  const use = (stack: Fixture) => {
    f = stack;
    [owner, buyer, buyer2, stranger, treasury] = [20, 21, 22, 23, 28].map((i) => f.accounts[i]);
    h = fundingHelpers({ f, owner, buyer });
  };

  beforeEach(async () => {
    hre.helpers.resetDeploymentsJson();
    use(await loadFixture(deployFixture));
    epLen = await f.Chronos.epochLength();
  });

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  const plain = (r: unknown) => (r as Result).toObject();
  const vaultBalance = async () => f.Token.balanceOf(await f.Vault.getAddress());
  const forward = async (contract: BaseContract, fn: string, args: unknown[] = []) =>
    f.Hub.forwardCall(await contract.getAddress(), contract.interface.encodeFunctionData(fn, args));

  /**
   * Point the Hub at a fresh QueryInferenceStorage whose activation epoch is
   * unset, and re-initialize both funding contracts onto it: the state between
   * a deployment's Hub transaction and its activation.
   */
  const useInactiveStorage = async () => {
    const fresh = (await (
      await hre.ethers.getContractFactory('QueryInferenceStorage')
    ).deploy(await f.Hub.getAddress())) as unknown as QueryInferenceStorage;
    await fresh.waitForDeployment();
    await f.Hub.setContractAddress('QueryInferenceStorage', await fresh.getAddress());
    await forward(fresh, 'initialize');
    await forward(f.SS, 'initialize');
    await forward(f.SSW, 'initialize');
    // The settlement too, which the activation needs reading this storage.
    const settlement = await hre.ethers.getContractAt(
      'QueryInferenceSettlement',
      await f.Hub.getContractAddress('QueryInferenceSettlement'),
    );
    await forward(settlement, 'initialize');
    // A new object: loadFixture hands every test the one it first returned.
    use({ ...f, QIS: fresh });
  };

  const tuples = (bs: Array<{ bucketId: string; serviceClass: bigint; value: bigint; maxAskWeiPerUnit: bigint }>) =>
    bs.map((b) => [b.bucketId, b.serviceClass, b.value, b.maxAskWeiPerUnit]);

  /** Approve the wallet contract for `amount` from `who`, minting it first. */
  const allow = async (who: SignerWithAddress, amount: bigint) => {
    await f.Token.mint(who.address, amount);
    await f.Token.connect(who).approve(await f.SSW.getAddress(), amount);
  };

  const valueOf = (r: { buckets: Array<{ value: bigint }> }) => r.buckets.reduce((a, b) => a + b.value, 0n);

  /** Fund a wallet period, with the approval it needs. */
  const walletFund = async (r: WalletRequest, sender: SignerWithAddress = buyer) => {
    await allow(sender, valueOf(r));
    const receipt = (await (await f.SSW.connect(sender).fundFromWallet(r)).wait())!;
    return { subscriptionId: subscriptionIdOf(sender.address, r.epoch), receipt };
  };

  /** A wallet top-up, with the approval it needs. */
  const walletTopUp = async (
    subscriptionId: string,
    additions: ReturnType<typeof bucket>[],
    sender: SignerWithAddress = buyer,
    planDigest: string = ethers.id('plan-topped-up'),
  ) => {
    await allow(sender, additions.reduce((a, b) => a + b.value, 0n));
    return (await (await f.SSW.connect(sender).topUpFromWallet(subscriptionId, additions, planDigest)).wait())!;
  };

  // -------------------------------------------------------------------------
  // A payment the Token answers with false
  // -------------------------------------------------------------------------

  describe('a wallet payment the Token answers with false', () => {
    let Falsy: FalseReturnERC20;
    let epoch: bigint;

    beforeEach(async () => {
      Falsy = (await (
        await hre.ethers.getContractFactory('FalseReturnERC20')
      ).deploy('False', 'FALSE')) as unknown as FalseReturnERC20;
      await Falsy.waitForDeployment();
      await f.Hub.setContractAddress('Token', await Falsy.getAddress());
      await forward(f.SSW, 'initialize');
      expect(await f.SSW.tokenContract()).to.equal(await Falsy.getAddress());
      epoch = await h.epochNow();
      await Falsy.mint(buyer.address, 100n * TRAC);
      await Falsy.connect(buyer).approve(await f.SSW.getAddress(), 100n * TRAC);
    });

    /** Everything a funding or a top-up writes or moves, for the period of `subscriptionId`. */
    const stateOf = async (subscriptionId: string) => ({
      exists: await f.CSS.subscriptionExists(subscriptionId),
      record: plain(await f.CSS.getSubscription(subscriptionId)),
      buckets: tuples(await f.CSS.getBuckets(subscriptionId)),
      storedBuckets: await f.CSS.storedBucketCount(subscriptionId),
      walletPeriods: await f.CSS.accountSubscriptionCount(0n),
      due: [await f.QIS.walletDue(epoch), await f.QIS.walletDue(epoch + 1n), await f.QIS.walletDue(epoch + 2n)],
      balances: [await Falsy.balanceOf(buyer.address), await Falsy.balanceOf(await f.Vault.getAddress())],
    });

    it('a funding is refused TokenTransferFailed, with no record, bucket, list entry, money due or balance left of it', async () => {
      const r = walletRequestOf(epoch, {
        buckets: [bucket(0, CLASS_INFERENCE, 7n * TRAC), bucket(1, CLASS_QUERY, 3n * TRAC)],
      });
      const subscriptionId = subscriptionIdOf(buyer.address, epoch);
      const before = await stateOf(subscriptionId);
      expect(before.exists).to.equal(false);

      await Falsy.setTransferFromReturnsFalse(true);
      await expect(f.SSW.connect(buyer).fundFromWallet(r)).to.be.revertedWithCustomError(f.SSW, 'TokenTransferFailed');
      expect(await stateOf(subscriptionId)).to.deep.equal(before);

      // The same request goes through once the Token pays.
      await Falsy.setTransferFromReturnsFalse(false);
      await f.SSW.connect(buyer).fundFromWallet(r);
      const after = await stateOf(subscriptionId);
      expect(after.exists).to.equal(true);
      expect(after.walletPeriods).to.equal(before.walletPeriods + 1n);
      expect(after.due[1]).to.equal(10n * TRAC);
      expect(after.balances).to.deep.equal([before.balances[0] - 10n * TRAC, before.balances[1] + 10n * TRAC]);
    });

    it('a top-up of a funded period is refused TokenTransferFailed, with its record, buckets, list entry, money due and balances as they were', async () => {
      const subscriptionId = subscriptionIdOf(buyer.address, epoch);
      await f.SSW.connect(buyer).fundFromWallet(walletRequestOf(epoch, { buckets: [bucket(0, CLASS_INFERENCE, 7n * TRAC)] }));
      const before = await stateOf(subscriptionId);
      const digest = (await f.CSS.getSubscription(subscriptionId)).planDigest;
      // An addition to the stored bucket, and an appended one.
      const additions = [bucket(0, CLASS_INFERENCE, TRAC), bucket(1, CLASS_QUERY, 2n * TRAC)];
      const newDigest = ethers.id('another plan');

      await Falsy.setTransferFromReturnsFalse(true);
      await expect(f.SSW.connect(buyer).topUpFromWallet(subscriptionId, additions, newDigest)).to.be.revertedWithCustomError(
        f.SSW,
        'TokenTransferFailed',
      );
      expect(await stateOf(subscriptionId)).to.deep.equal(before);
      expect((await f.CSS.getSubscription(subscriptionId)).planDigest).to.equal(digest);

      // The same top-up goes through once the Token pays.
      await Falsy.setTransferFromReturnsFalse(false);
      await f.SSW.connect(buyer).topUpFromWallet(subscriptionId, additions, newDigest);
      const after = await stateOf(subscriptionId);
      expect(after.storedBuckets).to.equal(before.storedBuckets + 1n);
      expect(after.due[1]).to.equal(10n * TRAC);
      expect(after.balances).to.deep.equal([before.balances[0] - 3n * TRAC, before.balances[1] + 3n * TRAC]);
    });
  });

  // -------------------------------------------------------------------------
  // Wallet funding
  // -------------------------------------------------------------------------

  describe('wallet funding', () => {
    it('moves the whole value into the vault, books it due after the period, records it under account 0 and emits PeriodFunded', async () => {
      const epoch = await h.epochNow();
      const r = walletRequestOf(epoch, {
        buckets: [bucket(0, CLASS_INFERENCE, 7n * TRAC + 3n), bucket(1, CLASS_QUERY, 3n * TRAC + 1n)],
      });
      const value = 10n * TRAC + 4n;
      await allow(buyer, value);
      const [buyerBefore, vaultBefore] = [await f.Token.balanceOf(buyer.address), await vaultBalance()];

      const returned = await f.SSW.connect(buyer).fundFromWallet.staticCall(r);
      const receipt = (await (await f.SSW.connect(buyer).fundFromWallet(r)).wait())!;
      const subscriptionId = subscriptionIdOf(buyer.address, epoch);
      expect(returned).to.equal(subscriptionId);
      expect(await f.SS.subscriptionIdOf(buyer.address, epoch)).to.equal(subscriptionId);
      const ts = await blockTime(receipt);
      const periodEnd = await h.epochStart(epoch + 1n);

      expect(await f.Token.balanceOf(buyer.address)).to.equal(buyerBefore - value);
      expect(await vaultBalance()).to.equal(vaultBefore + value);
      expect(await f.QIS.walletDue(epoch + 1n)).to.equal(value);
      expect(await f.QIS.walletDue(epoch)).to.equal(0n);

      expect(plain(await f.CSS.getSubscription(subscriptionId))).to.deep.equal({
        accountId: 0n,
        assignee: buyer.address,
        assignmentNonce: 0n,
        sessionKey: SESSION_KEY,
        periodId: ethers.toBeHex(epoch, 32),
        planDigest: r.planDigest,
        periodStart: ts,
        periodEnd,
        fundedEpoch: epoch,
        fundedWindow: 0n,
        discountBps: 0n,
        bucketCount: 2n,
        value,
        cost: value,
        drawnFromWindow: 0n,
        drawnFromTopUp: 0n,
      });
      expect(tuples(await f.CSS.getBuckets(subscriptionId))).to.deep.equal(tuples(r.buckets));
      expect(await f.CSS.accountSubscriptionCount(0n)).to.equal(1n);
      expect(await f.CSS.accountSubscriptionAt(0n, 0n)).to.equal(subscriptionId);

      const [pf] = await eventsOf(receipt, f.SSW, 'PeriodFunded');
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
      ]).to.deep.equal([subscriptionId, 0n, buyer.address, epoch, SESSION_KEY, r.planDigest, ts, periodEnd, value, value, 0n]);
      expect(tuples(pf.buckets)).to.deep.equal(tuples(r.buckets));

      // The one token move is buyer -> vault, for the whole value.
      const tokenAddress = (await f.Token.getAddress()).toLowerCase();
      const transfers = receipt.logs
        .filter((l) => l.address.toLowerCase() === tokenAddress)
        .map((l) => f.Token.interface.parseLog({ topics: [...l.topics], data: l.data }))
        .filter((l) => l?.name === 'Transfer');
      expect(transfers.map((t) => [t!.args.from, t!.args.to, t!.args.value])).to.deep.equal([
        [buyer.address, await f.Vault.getAddress(), value],
      ]);
    });

    it('takes no fee with a protocol treasury wired: the whole value still lands in the vault', async () => {
      await f.Params.setProtocolTreasury(treasury.address);
      const vaultBefore = await vaultBalance();
      const treasuryBefore = await f.Token.balanceOf(treasury.address);
      const r = walletRequestOf(await h.epochNow(), { buckets: [bucket(0, CLASS_INFERENCE, 50n * TRAC)] });
      await walletFund(r);
      expect(await vaultBalance()).to.equal(vaultBefore + 50n * TRAC);
      expect(await f.Token.balanceOf(treasury.address)).to.equal(treasuryBefore);
      expect(await f.QIS.walletDue(r.epoch + 1n)).to.equal(50n * TRAC);
    });

    it('a short allowance or balance reverts in the Token, with no partial effect', async () => {
      const r = walletRequestOf(await h.epochNow());
      await f.Token.connect(buyer).approve(await f.SSW.getAddress(), valueOf(r) - 1n);
      await expect(f.SSW.connect(buyer).fundFromWallet(r)).to.be.revertedWithCustomError(f.Token, 'ERC20InsufficientAllowance');
      expect(await f.CSS.subscriptionExists(subscriptionIdOf(buyer.address, r.epoch))).to.equal(false);
      expect(await f.QIS.walletDue(r.epoch + 1n)).to.equal(0n);
    });

    it('applies the bucket rules: none, too many, unsorted, duplicate, zero value, unknown class, zero ask, a sum beyond uint96', async () => {
      const epoch = await h.epochNow();
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
        [[bucket(1, CLASS_INFERENCE, (1n << 96n) - 1n), bucket(2, CLASS_QUERY, 1n)], 'value'],
      ];
      for (const [buckets, reason] of cases) {
        await expect(f.SSW.connect(buyer).fundFromWallet(walletRequestOf(epoch, { buckets })), reason)
          .to.be.revertedWithCustomError(f.SSW, 'InvalidFundingRequest')
          .withArgs(reason);
      }
      await walletFund(walletRequestOf(epoch, { buckets: many(max) }));
    });
  });

  // -------------------------------------------------------------------------
  // The period
  // -------------------------------------------------------------------------

  describe('the period: one epoch, the current or the next', () => {
    it('a current-epoch period funded mid-epoch runs from now to the epoch boundary', async () => {
      await time.increase(epLen / 3n);
      const epoch = await h.epochNow();
      const { subscriptionId, receipt } = await walletFund(walletRequestOf(epoch));
      const s = await f.CSS.getSubscription(subscriptionId);
      const ts = await blockTime(receipt);
      expect(ts).to.be.greaterThan(await h.epochStart(epoch));
      expect([s.periodStart, s.periodEnd]).to.deep.equal([ts, await h.epochStart(epoch + 1n)]);
    });

    it('a period funded ahead for the next epoch starts at that epoch, and its money is due the epoch after', async () => {
      const next = (await h.epochNow()) + 1n;
      const r = walletRequestOf(next);
      const { subscriptionId } = await walletFund(r);
      const s = await f.CSS.getSubscription(subscriptionId);
      expect([s.periodStart, s.periodEnd, s.fundedEpoch]).to.deep.equal([
        await h.epochStart(next),
        await h.epochStart(next + 1n),
        next - 1n,
      ]);
      expect(await f.QIS.walletDue(next + 1n)).to.equal(valueOf(r));
      expect(await f.QIS.walletDue(next)).to.equal(0n);

      // The same for a Conviction Account period.
      const accountId = await h.openAccount({ assignee: buyer2 });
      const ca = await h.caFund(accountId, next, 10n * TRAC, buyer2);
      const record = await f.CSS.getSubscription(ca.subscriptionId);
      expect([record.periodStart, record.periodEnd]).to.deep.equal([await h.epochStart(next), await h.epochStart(next + 1n)]);
    });

    it('any other epoch is refused, for a wallet period and an account period alike', async () => {
      const accountId = await h.openAccount();
      await time.increase(2n * epLen);
      const now = await h.epochNow();
      for (const epoch of [0n, 1n, now - 1n, now + 2n, now + 1_000n]) {
        await expect(f.SSW.connect(buyer).fundFromWallet(walletRequestOf(epoch)), `wallet, epoch ${epoch}`)
          .to.be.revertedWithCustomError(f.SSW, 'InvalidFundingRequest')
          .withArgs('epoch');
        await expect(
          f.SS.connect(buyer).fundFromConviction(requestOf(accountId, epoch)),
          `account, epoch ${epoch}`,
        )
          .to.be.revertedWithCustomError(f.SS, 'InvalidFundingRequest')
          .withArgs('epoch');
      }
    });

    it('one period per buyer key and epoch, shared by wallet and account periods; another buyer key funds its own', async () => {
      const accountId = await h.openAccount();
      const now = await h.epochNow();

      const { subscriptionId } = await walletFund(walletRequestOf(now));
      await allow(buyer, 10n * TRAC);
      await expect(f.SSW.connect(buyer).fundFromWallet(walletRequestOf(now)))
        .to.be.revertedWithCustomError(f.SSW, 'PeriodAlreadyFunded')
        .withArgs(subscriptionId);
      await expect(f.SS.connect(buyer).fundFromConviction(requestOf(accountId, now)))
        .to.be.revertedWithCustomError(f.SS, 'PeriodAlreadyFunded')
        .withArgs(subscriptionId);

      // The next epoch from an account, and then not from a wallet.
      const next = await h.caFund(accountId, now + 1n, 10n * TRAC);
      await expect(f.SSW.connect(buyer).fundFromWallet(walletRequestOf(now + 1n)))
        .to.be.revertedWithCustomError(f.SSW, 'PeriodAlreadyFunded')
        .withArgs(next.subscriptionId);

      // Another buyer key has its own period for the same epoch.
      const other = await walletFund(walletRequestOf(now), buyer2);
      expect(other.subscriptionId).to.not.equal(subscriptionId);
      expect(await f.CSS.accountSubscriptionCount(0n)).to.equal(2n);
    });

    it('after the boundary, the next epoch is the current one and the epoch after it can be funded ahead', async () => {
      const now = await h.epochNow();
      await walletFund(walletRequestOf(now));
      await walletFund(walletRequestOf(now + 1n));
      await time.increaseTo(await h.epochStart(now + 1n));
      await expect(f.SSW.connect(buyer).fundFromWallet(walletRequestOf(now)))
        .to.be.revertedWithCustomError(f.SSW, 'InvalidFundingRequest')
        .withArgs('epoch');
      await walletFund(walletRequestOf(now + 2n));
      expect(await f.QIS.walletDue(now + 3n)).to.equal(10n * TRAC);
    });
  });

  // -------------------------------------------------------------------------
  // The money due
  // -------------------------------------------------------------------------

  describe('the money due', () => {
    it('is booked to the epoch after the period, never the funding epoch, summing per epoch over buyers and top-ups', async () => {
      const now = await h.epochNow();
      const a = await walletFund(walletRequestOf(now, { buckets: [bucket(0, CLASS_INFERENCE, 4n * TRAC)] }));
      await walletFund(walletRequestOf(now, { buckets: [bucket(0, CLASS_QUERY, 6n * TRAC)] }), buyer2);
      await walletTopUp(a.subscriptionId, [bucket(0, CLASS_INFERENCE, TRAC)]);
      expect(await f.QIS.walletDue(now)).to.equal(0n);
      expect(await f.QIS.walletDue(now + 1n)).to.equal(11n * TRAC);
      expect(await f.QIS.walletDue(now + 2n)).to.equal(0n);
    });

    it('the receipt grace stays at most half an epoch, so the batch deadline always falls in the due epoch; a change to it moves no booking', async () => {
      for (const bad of [0n, epLen / 2n + 1n, epLen]) {
        await expect(forward(f.QIS, 'setReceiptGraceSeconds', [bad]))
          .to.be.revertedWithCustomError(f.QIS, 'InvalidParameter')
          .withArgs('receiptGraceSeconds');
      }
      // A change applies to the next epoch's periods: fund one, under the longest grace.
      await forward(f.QIS, 'setReceiptGraceSeconds', [epLen / 2n]);
      const next = (await h.epochNow()) + 1n;
      const { subscriptionId } = await walletFund(walletRequestOf(next));
      const s = await f.CSS.getSubscription(subscriptionId);
      expect(await f.QIS.receiptGraceSecondsAt(next)).to.equal(epLen / 2n);
      const deadline = s.periodEnd + (await f.QIS.receiptGraceSecondsAt(next));
      expect(await f.Chronos.epochAtTimestamp(deadline)).to.equal(next + 1n);
      expect(await f.QIS.walletDue(next + 1n)).to.equal(10n * TRAC);

      // A later change to the grace leaves the booking, and later bookings, in the same epoch.
      await forward(f.QIS, 'setReceiptGraceSeconds', [60n]);
      await walletTopUp(subscriptionId, [bucket(0, CLASS_INFERENCE, TRAC)]);
      expect(await f.QIS.walletDue(next + 1n)).to.equal(11n * TRAC);
    });
  });

  // -------------------------------------------------------------------------
  // Wallet top-ups and upgrades
  // -------------------------------------------------------------------------

  describe('wallet top-ups and upgrades', () => {
    let subscriptionId: string;
    let epoch: bigint;
    const first = () => bucket(1, CLASS_INFERENCE, 6n * TRAC, 2_000n);
    const second = () => bucket(4, CLASS_QUERY, 4n * TRAC, 50n);

    beforeEach(async () => {
      epoch = await h.epochNow();
      ({ subscriptionId } = await walletFund(walletRequestOf(epoch, { buckets: [first(), second()] })));
    });

    it('a top-up adds to stored buckets and an upgrade appends new ones, at the period end, with the value into the vault', async () => {
      const additions = [
        bucket(0, CLASS_QUERY, 2n * TRAC, 70n), // new, sorts first but is appended last
        { ...first(), value: TRAC }, // tops up index 0
        bucket(9, CLASS_INFERENCE, 3n * TRAC, 900n), // new
      ];
      const vaultBefore = await vaultBalance();
      const planDigest = ethers.id('plan-2');
      const receipt = await walletTopUp(subscriptionId, additions, buyer, planDigest);

      expect(await vaultBalance()).to.equal(vaultBefore + 6n * TRAC);
      expect(await f.QIS.walletDue(epoch + 1n)).to.equal(16n * TRAC);
      expect(tuples(await f.CSS.getBuckets(subscriptionId))).to.deep.equal(
        tuples([
          { ...first(), value: 7n * TRAC },
          second(),
          bucket(0, CLASS_QUERY, 2n * TRAC, 70n),
          bucket(9, CLASS_INFERENCE, 3n * TRAC, 900n),
        ]),
      );
      const s = await f.CSS.getSubscription(subscriptionId);
      expect([s.value, s.cost, s.bucketCount, s.planDigest, s.drawnFromWindow, s.drawnFromTopUp]).to.deep.equal([
        16n * TRAC,
        16n * TRAC,
        4n,
        planDigest,
        0n,
        0n,
      ]);

      const [ev] = await eventsOf(receipt, f.SSW, 'PeriodToppedUp');
      expect([ev.subscriptionId, ev.accountId, ev.assignee, ev.value, ev.cost, ev.planDigest]).to.deep.equal([
        subscriptionId,
        0n,
        buyer.address,
        6n * TRAC,
        6n * TRAC,
        planDigest,
      ]);
      expect(tuples(ev.additions)).to.deep.equal(tuples(additions));
    });

    it('a period funded ahead is topped up before it starts', async () => {
      const next = await walletFund(walletRequestOf(epoch + 1n));
      await walletTopUp(next.subscriptionId, [bucket(0, CLASS_INFERENCE, TRAC)]);
      expect((await f.CSS.getSubscription(next.subscriptionId)).value).to.equal(11n * TRAC);
      expect(await f.QIS.walletDue(epoch + 2n)).to.equal(11n * TRAC);
    });

    it('caps never change within a period: a stored bucket must repeat its class and price cap', async () => {
      for (const changed of [
        { ...first(), maxAskWeiPerUnit: 2_001n },
        { ...first(), serviceClass: CLASS_QUERY },
        { ...second(), maxAskWeiPerUnit: 49n },
      ]) {
        await expect(f.SSW.connect(buyer).topUpFromWallet(subscriptionId, [changed], ethers.ZeroHash))
          .to.be.revertedWithCustomError(f.SSW, 'BucketTermsChanged')
          .withArgs(changed.bucketId);
      }
    });

    it('applies the bucket rules to the additions, and to the period as a whole', async () => {
      const max = Number(await f.CSS.maxBucketsPerPeriod());
      const fresh = (n: number) => Array.from({ length: n }, (_, i) => bucket(100 + i, CLASS_INFERENCE, TRAC));
      const cases: Array<[ReturnType<typeof bucket>[], string]> = [
        [[], 'bucketCount'],
        [fresh(max - 1), 'bucketCount'], // two stored plus max − 1 new
        [[bucket(5, CLASS_INFERENCE, TRAC), bucket(3, CLASS_INFERENCE, TRAC)], 'bucketOrder'],
        [[{ ...first(), value: TRAC }, { ...first(), value: TRAC }], 'bucketOrder'],
        [[{ ...first(), value: 0n }], 'bucketValue'],
        [[bucket(7, CLASS_INFERENCE, 0n)], 'bucketValue'],
        [[bucket(7, 3n, TRAC)], 'serviceClass'],
        [[bucket(7, CLASS_QUERY, TRAC, 0n)], 'maxAskWeiPerUnit'],
        [[{ ...first(), value: (1n << 96n) - 1n }], 'value'],
      ];
      for (const [additions, reason] of cases) {
        await expect(f.SSW.connect(buyer).topUpFromWallet(subscriptionId, additions, ethers.ZeroHash), reason)
          .to.be.revertedWithCustomError(f.SSW, 'InvalidFundingRequest')
          .withArgs(reason);
      }
      await walletTopUp(subscriptionId, fresh(max - 2));
      expect((await f.CSS.getSubscription(subscriptionId)).bucketCount).to.equal(BigInt(max));
    });

    it('refuses an unknown period, another buyer key, an account period, and a period that has ended, with no partial effect', async () => {
      const unknown = ethers.id('never-funded');
      await expect(f.SSW.connect(buyer).topUpFromWallet(unknown, [first()], ethers.ZeroHash))
        .to.be.revertedWithCustomError(f.SSW, 'PeriodNotFound')
        .withArgs(unknown);
      await allow(stranger, TRAC);
      await expect(f.SSW.connect(stranger).topUpFromWallet(subscriptionId, [first()], ethers.ZeroHash))
        .to.be.revertedWithCustomError(f.SSW, 'NotPeriodBuyer')
        .withArgs(subscriptionId, stranger.address);

      const accountId = await h.openAccount();
      const ca = await h.caFund(accountId, epoch + 1n, 10n * TRAC);
      await expect(f.SSW.connect(buyer).topUpFromWallet(ca.subscriptionId, [ca.r.buckets[0]], ethers.ZeroHash))
        .to.be.revertedWithCustomError(f.SSW, 'WrongFundingSource')
        .withArgs(ca.subscriptionId, accountId);
      await expect(f.SS.connect(buyer).topUpFromConviction(subscriptionId, [first()], ethers.ZeroHash))
        .to.be.revertedWithCustomError(f.SS, 'WrongFundingSource')
        .withArgs(subscriptionId, 0n);

      const s = await f.CSS.getSubscription(subscriptionId);
      await time.increaseTo(s.periodEnd);
      await expect(f.SSW.connect(buyer).topUpFromWallet(subscriptionId, [{ ...first(), value: TRAC }], ethers.ZeroHash))
        .to.be.revertedWithCustomError(f.SSW, 'PeriodEnded')
        .withArgs(subscriptionId, s.periodEnd);
      expect(plain(await f.CSS.getSubscription(subscriptionId))).to.deep.equal(plain(s));
      expect(await f.QIS.walletDue(epoch + 1n)).to.equal(10n * TRAC);
    });
  });

  // -------------------------------------------------------------------------
  // Conviction Account top-ups and upgrades
  // -------------------------------------------------------------------------

  describe('Conviction Account top-ups and upgrades', () => {
    let accountId: bigint;
    let subscriptionId: string;
    let epoch: bigint;

    beforeEach(async () => {
      accountId = await h.openAccount({ limit: 30n * TRAC });
      epoch = await h.epochNow();
      ({ subscriptionId } = await h.caFund(accountId, epoch, 20n * TRAC));
    });

    it('draws at the account tier, books the cost due after the period, adds to the record and counts no new period', async () => {
      const additions = [bucket(0, CLASS_INFERENCE, 10n * TRAC), bucket(3, CLASS_QUERY, 5n * TRAC)];
      const cost = costOf(15n * TRAC, BPS);
      const vaultBefore = await vaultBalance();
      const returned = await f.SS.connect(buyer).topUpFromConviction.staticCall(subscriptionId, additions, ethers.id('p2'));
      expect(returned).to.equal(cost);
      const receipt = (await (await f.SS.connect(buyer).topUpFromConviction(subscriptionId, additions, ethers.id('p2'))).wait())!;

      const [covered] = await eventsOf(receipt, f.PC, 'ServiceCostCovered');
      expect([covered.subscriptionId, covered.value, covered.cost]).to.deep.equal([subscriptionId, 15n * TRAC, cost]);

      const s = await f.CSS.getSubscription(subscriptionId);
      const fundedCost = costOf(20n * TRAC, BPS);
      expect([s.value, s.cost, s.drawnFromWindow + s.drawnFromTopUp, s.bucketCount]).to.deep.equal([
        35n * TRAC,
        fundedCost + cost,
        fundedCost + cost,
        2n,
      ]);
      expect(tuples(await f.CSS.getBuckets(subscriptionId))).to.deep.equal(
        tuples([bucket(0, CLASS_INFERENCE, 30n * TRAC), bucket(3, CLASS_QUERY, 5n * TRAC)]),
      );
      expect((await f.CSS.getUsage(accountId, buyer.address)).periods).to.equal(1n);
      // The funding's cost and the top-up's are both due after the period, in
      // the Conviction Account ledger. No TRAC moves, and nothing is booked to
      // the wallet ledger.
      expect(await f.QIS.convictionDue(epoch + 1n)).to.equal(fundedCost + cost);
      expect(await f.QIS.convictionDue(epoch)).to.equal(0n);
      expect(await f.QIS.convictionDue(epoch + 2n)).to.equal(0n);
      expect(await vaultBalance()).to.equal(vaultBefore);
      expect(await f.QIS.walletDue(epoch + 1n)).to.equal(0n);

      const [ev] = await eventsOf(receipt, f.SS, 'PeriodToppedUp');
      expect([ev.subscriptionId, ev.accountId, ev.assignee, ev.value, ev.cost, ev.planDigest]).to.deep.equal([
        subscriptionId,
        accountId,
        buyer.address,
        15n * TRAC,
        cost,
        ethers.id('p2'),
      ]);
    });

    it("the period limit counts the period's earlier cost, under the limit stored at this block", async () => {
      // 20 TRAC cost 14 at the 30 % tier; the limit is 30.
      const room = valueFor(30n * TRAC - costOf(20n * TRAC, BPS));
      await expect(f.SS.connect(buyer).topUpFromConviction(subscriptionId, [bucket(0, CLASS_INFERENCE, room + 2n)], ethers.ZeroHash))
        .to.be.revertedWithCustomError(f.SS, 'CapExceeded')
        .withArgs('maxCostPerPeriod', 30n * TRAC, costOf(20n * TRAC, BPS) + costOf(room + 2n, BPS));
      await f.SS.connect(owner).updateAssignmentCaps(accountId, buyer.address, {
        maxCostPerPeriod: 40n * TRAC,
        expiresAt: (await f.CSS.getAssignment(accountId, buyer.address)).expiresAt,
      });
      await f.SS.connect(buyer).topUpFromConviction(subscriptionId, [bucket(0, CLASS_INFERENCE, room + 2n)], ethers.ZeroHash);
    });

    it('needs the opt-in and a live assignment, from the period buyer key, before the period ends', async () => {
      const add = [bucket(0, CLASS_INFERENCE, TRAC)];
      await expect(f.SS.connect(buyer2).topUpFromConviction(subscriptionId, add, ethers.ZeroHash))
        .to.be.revertedWithCustomError(f.SS, 'NotPeriodBuyer')
        .withArgs(subscriptionId, buyer2.address);
      await f.SS.connect(owner).setServiceSpending(accountId, false);
      await expect(f.SS.connect(buyer).topUpFromConviction(subscriptionId, add, ethers.ZeroHash))
        .to.be.revertedWithCustomError(f.SS, 'ServiceSpendingDisabled')
        .withArgs(accountId);
      await f.SS.connect(owner).setServiceSpending(accountId, true);
      await f.SS.connect(buyer).topUpFromConviction(subscriptionId, add, ethers.ZeroHash);
      await f.SS.connect(owner).revoke(accountId, buyer.address);
      await expect(f.SS.connect(buyer).topUpFromConviction(subscriptionId, add, ethers.ZeroHash))
        .to.be.revertedWithCustomError(f.SS, 'AssignmentRevoked')
        .withArgs(accountId, buyer.address);

      const s = await f.CSS.getSubscription(subscriptionId);
      await time.increaseTo(s.periodEnd);
      await expect(f.SS.connect(buyer).topUpFromConviction(subscriptionId, add, ethers.ZeroHash))
        .to.be.revertedWithCustomError(f.SS, 'PeriodEnded')
        .withArgs(subscriptionId, s.periodEnd);
    });

    /** What a refused top-up must leave as it was: the record, its buckets, the cost due and the allowance. */
    const untouched = async (id: string, account: bigint) => [
      plain(await f.CSS.getSubscription(id)),
      tuples(await f.CSS.getBuckets(id)),
      await f.QIS.convictionDue(epoch + 1n),
      await f.SS.currentWindowAllowance(account),
    ];

    it("a new assignment of the buyer key reopens no period whose own assignment has ended: after a revocation or an expiry, a top-up is refused and draws nothing", async () => {
      const add = [bucket(0, CLASS_INFERENCE, 10n * TRAC)];
      const fundedUnder = (await f.CSS.getSubscription(subscriptionId)).assignmentNonce;

      // Revoked ten minutes after the funding, then assigned again ten minutes
      // later, with room for the top-up.
      await time.increase(600n);
      await f.SS.connect(owner).revoke(accountId, buyer.address);
      const revokedAt = (await f.CSS.getAssignment(accountId, buyer.address)).revokedAt;
      await time.increase(600n);
      await h.assign(accountId, buyer, 1_000n * TRAC);
      expect(await f.CSS.isAssignmentActive(accountId, buyer.address)).to.equal(true);
      expect(await f.CSS.assignmentEnd(accountId, buyer.address, fundedUnder)).to.equal(revokedAt);

      const before = await untouched(subscriptionId, accountId);
      await expect(f.SS.connect(buyer).topUpFromConviction(subscriptionId, add, ethers.ZeroHash))
        .to.be.revertedWithCustomError(f.SS, 'AssignmentExpired')
        .withArgs(accountId, buyer.address);
      expect(await untouched(subscriptionId, accountId)).to.deep.equal(before);
      // One period per buyer key and epoch, so the key is served again from
      // its next period not yet funded, which the new assignment tops up.
      await expect(f.SS.connect(buyer).fundFromConviction(requestOf(accountId, epoch)))
        .to.be.revertedWithCustomError(f.SS, 'PeriodAlreadyFunded')
        .withArgs(subscriptionId);
      const next = await h.caFund(accountId, epoch + 1n, 10n * TRAC);
      await f.SS.connect(buyer).topUpFromConviction(next.subscriptionId, add, ethers.ZeroHash);

      // The same for an assignment that expired inside the period and was
      // renewed by a new one.
      await h.assign(accountId, buyer2, 1_000n * TRAC);
      const second = await h.caFund(accountId, epoch, 10n * TRAC, buyer2);
      const expiresAt = (await h.latest()) + 3_600n;
      expect(expiresAt).to.be.lessThan((await f.CSS.getSubscription(second.subscriptionId)).periodEnd);
      await f.SS.connect(owner).updateAssignmentCaps(accountId, buyer2.address, { maxCostPerPeriod: 1_000n * TRAC, expiresAt });
      await time.increaseTo(expiresAt + 60n);
      await h.assign(accountId, buyer2, 1_000n * TRAC);
      const renewed = await untouched(second.subscriptionId, accountId);
      await expect(f.SS.connect(buyer2).topUpFromConviction(second.subscriptionId, add, ethers.ZeroHash))
        .to.be.revertedWithCustomError(f.SS, 'AssignmentExpired')
        .withArgs(accountId, buyer2.address);
      expect(await untouched(second.subscriptionId, accountId)).to.deep.equal(renewed);
    });

    it("a period whose assignment was replaced while still live is topped up until that assignment's own expiry, and from then on refused", async () => {
      const add = [bucket(0, CLASS_INFERENCE, 10n * TRAC)];
      const s = await f.CSS.getSubscription(subscriptionId);
      // The period's assignment is set to expire inside the period, then
      // replaced while it is still live.
      const expiresAt = (await h.latest()) + 3_600n;
      expect(expiresAt).to.be.lessThan(s.periodEnd);
      await f.SS.connect(owner).updateAssignmentCaps(accountId, buyer.address, { maxCostPerPeriod: 30n * TRAC, expiresAt });
      await h.assign(accountId, buyer, 1_000n * TRAC);
      expect(await f.CSS.assignmentEnd(accountId, buyer.address, s.assignmentNonce)).to.equal(expiresAt);

      // Until then the period takes requests, and so a top-up, drawn and
      // booked as any other, under the key's new assignment's limit.
      await time.setNextBlockTimestamp(expiresAt - 1n);
      await f.SS.connect(buyer).topUpFromConviction(subscriptionId, add, ethers.ZeroHash);
      const booked = costOf(20n * TRAC, BPS) + costOf(10n * TRAC, BPS);
      expect(await f.QIS.convictionDue(epoch + 1n)).to.equal(booked);
      expect((await f.CSS.getSubscription(subscriptionId)).cost).to.equal(booked);

      // From its expiry on, the period takes no request, and no top-up.
      const before = await untouched(subscriptionId, accountId);
      await time.setNextBlockTimestamp(expiresAt);
      await expect(f.SS.connect(buyer).topUpFromConviction(subscriptionId, add, ethers.ZeroHash))
        .to.be.revertedWithCustomError(f.SS, 'AssignmentExpired')
        .withArgs(accountId, buyer.address);
      expect(await untouched(subscriptionId, accountId)).to.deep.equal(before);
    });

    it('caps never change within a period, and an unknown period is refused', async () => {
      await expect(f.SS.connect(buyer).topUpFromConviction(subscriptionId, [bucket(0, CLASS_INFERENCE, TRAC, 1n)], ethers.ZeroHash))
        .to.be.revertedWithCustomError(f.SS, 'BucketTermsChanged')
        .withArgs(bucket(0, CLASS_INFERENCE, TRAC).bucketId);
      const unknown = ethers.id('never-funded');
      await expect(f.SS.connect(buyer).topUpFromConviction(unknown, [bucket(0, CLASS_INFERENCE, TRAC)], ethers.ZeroHash))
        .to.be.revertedWithCustomError(f.SS, 'PeriodNotFound')
        .withArgs(unknown);
    });
  });

  // -------------------------------------------------------------------------
  // The session key, the pause and activation
  // -------------------------------------------------------------------------

  describe('the session key, the pause and activation', () => {
    it('a zero session key is refused from a wallet and from an account', async () => {
      const accountId = await h.openAccount();
      const now = await h.epochNow();
      await expect(f.SSW.connect(buyer).fundFromWallet(walletRequestOf(now, { sessionKey: ethers.ZeroAddress })))
        .to.be.revertedWithCustomError(f.SSW, 'ZeroSessionKey');
      await expect(f.SS.connect(buyer).fundFromConviction(requestOf(accountId, now, { sessionKey: ethers.ZeroAddress })))
        .to.be.revertedWithCustomError(f.SS, 'ZeroSessionKey');
    });

    it('while paused, no funding or top-up runs, from a wallet or an account; unpaused, they go on', async () => {
      const accountId = await h.openAccount();
      const now = await h.epochNow();
      const wallet = await walletFund(walletRequestOf(now));
      const ca = await h.caFund(accountId, now + 1n, 10n * TRAC);
      await forward(f.QIS, 'setPaused', [true]);
      const add = [bucket(0, CLASS_INFERENCE, TRAC)];
      for (const call of [
        f.SSW.connect(buyer).fundFromWallet(walletRequestOf(now + 1n)),
        f.SSW.connect(buyer).topUpFromWallet(wallet.subscriptionId, add, ethers.ZeroHash),
        f.SS.connect(buyer2).fundFromConviction(requestOf(accountId, now)),
        f.SS.connect(buyer).topUpFromConviction(ca.subscriptionId, add, ethers.ZeroHash),
      ]) {
        await expect(call).to.be.revertedWithCustomError(f.SSW, 'QueryInferencePaused');
      }
      await forward(f.QIS, 'setPaused', [false]);
      await walletTopUp(wallet.subscriptionId, add);
      await f.SS.connect(buyer).topUpFromConviction(ca.subscriptionId, add, ethers.ZeroHash);
    });

    it('wallet funding and top-ups are refused until the activation epoch: activation unset, then ahead, then reached', async () => {
      await useInactiveStorage();
      const now = await h.epochNow();
      expect(await f.QIS.activationEpoch()).to.equal(0n);
      await allow(buyer, 10n * TRAC);
      await expect(f.SSW.connect(buyer).fundFromWallet(walletRequestOf(now)))
        .to.be.revertedWithCustomError(f.SSW, 'QueryInferenceNotActive')
        .withArgs(0n, now);

      await activateQueryInference(f.Hub, f.QIS, now + 1n);
      await expect(f.SSW.connect(buyer).fundFromWallet(walletRequestOf(now + 1n)))
        .to.be.revertedWithCustomError(f.SSW, 'QueryInferenceNotActive')
        .withArgs(now + 1n, now);
      await expect(f.SSW.connect(buyer).topUpFromWallet(ethers.id('x'), [bucket(0, CLASS_INFERENCE, TRAC)], ethers.ZeroHash))
        .to.be.revertedWithCustomError(f.SSW, 'QueryInferenceNotActive')
        .withArgs(now + 1n, now);

      await time.increaseTo(await h.epochStart(now + 1n));
      const { subscriptionId } = await walletFund(walletRequestOf(now + 1n));
      await walletTopUp(subscriptionId, [bucket(0, CLASS_INFERENCE, TRAC)]);
      expect(await f.QIS.walletDue(now + 2n)).to.equal(11n * TRAC);
    });

    it('Conviction Account funding and top-ups are refused until the activation epoch too, so no cost is due in an epoch that never closes', async () => {
      const accountId = await h.openAccount();
      const now = await h.epochNow();
      // A period funded while active, to try a top-up against later.
      const active = await h.caFund(accountId, now + 1n, 10n * TRAC);
      await useInactiveStorage();
      expect(await f.QIS.activationEpoch()).to.equal(0n);
      const add = [bucket(0, CLASS_INFERENCE, TRAC)];
      const allowance = await f.SS.currentWindowAllowance(accountId);
      await expect(f.SS.connect(buyer2).fundFromConviction(requestOf(accountId, now)))
        .to.be.revertedWithCustomError(f.SS, 'QueryInferenceNotActive')
        .withArgs(0n, now);
      await expect(f.SS.connect(buyer).topUpFromConviction(active.subscriptionId, add, ethers.ZeroHash))
        .to.be.revertedWithCustomError(f.SS, 'QueryInferenceNotActive')
        .withArgs(0n, now);

      await activateQueryInference(f.Hub, f.QIS, now + 1n);
      await expect(f.SS.connect(buyer2).fundFromConviction(requestOf(accountId, now + 1n)))
        .to.be.revertedWithCustomError(f.SS, 'QueryInferenceNotActive')
        .withArgs(now + 1n, now);
      expect(await f.SS.currentWindowAllowance(accountId)).to.deep.equal(allowance);

      await time.increaseTo(await h.epochStart(now + 1n));
      await h.assign(accountId, buyer2, 1_000n * TRAC);
      await h.caFund(accountId, now + 1n, 10n * TRAC, buyer2);
      await f.SS.connect(buyer).topUpFromConviction(active.subscriptionId, add, ethers.ZeroHash);
      expect(await f.QIS.convictionDue(now + 2n)).to.equal(costOf(10n * TRAC, BPS) + costOf(TRAC, BPS));
    });
  });

  /** The smallest value whose cost at the 30 % tier is exactly `cost`. */
  function valueFor(cost: bigint): bigint {
    return (cost * 10_000n + (10_000n - BPS) - 1n) / (10_000n - BPS);
  }
});
