// Subscription funding for the query/inference pool (OT-RFC-27), end to end:
// QueryInferenceStorage, ServiceSubscriptionsStorage, ServiceSubscriptions and
// ServiceSubscriptionsWallet registered in the Hub, on the real account stack.
//
// Groups:
//   - wallet funding: the whole value into the vault with no fee, even with a
//     treasury wired; the record under account 0 and SubscriptionFunded;
//   - the subscription: one epoch, the current one (from now to the boundary) or the
//     next (from its start), no other; one per buyer and epoch, shared by
//     wallet and Conviction Account subscriptions;
//   - the money: under the subscription's own epoch, for fundings and top-ups alike,
//     from a wallet and from a Conviction Account, each in its own ledger;
//   - wallet top-ups and upgrades: limits unchanged, new budgets appended, the
//     value into the vault and booked under the subscription's epoch;
//   - Conviction Account top-ups and upgrades: the spend at the account's tier
//     and its cost under the subscription's epoch, the subscription limit counting the
//     subscription's earlier cost, and the usage without another subscription; a top-up
//     only while the grant the subscription was funded under is live, so a new
//     grant to the buyer after a revocation or an expiry reopens nothing,
//     while one replaced still live tops up until its own expiry;
//   - refusals: a zero key, before activation or while it is unset (from a
//     wallet and from an account alike), paused, an unknown or ended subscription, a
//     wrong source or buyer, a changed cap, and the budget rules; each without
//     partial effect;
//   - a wallet payment the Token answers with false, after every storage write
//     of a funding or a top-up: refused, and all of them undone.
//
// A Conviction Account subscription funded ahead, and its grant, is in
// v10-query-inference-grant-lifetime.test.ts.

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
  budget,
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

describe('@integration Subscription funding for the query/inference pool', function () {
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

  const tuples = (bs: Array<{ serviceId: string; serviceClass: bigint; value: bigint; maxPricePerUnit: bigint }>) =>
    bs.map((b) => [b.serviceId, b.serviceClass, b.value, b.maxPricePerUnit]);

  /** Approve the wallet contract for `amount` from `who`, minting it first. */
  const allow = async (who: SignerWithAddress, amount: bigint) => {
    await f.Token.mint(who.address, amount);
    await f.Token.connect(who).approve(await f.SSW.getAddress(), amount);
  };

  const valueOf = (r: { budgets: Array<{ value: bigint }> }) => r.budgets.reduce((a, b) => a + b.value, 0n);

  /** Fund a wallet subscription, with the approval it needs. */
  const walletFund = async (r: WalletRequest, sender: SignerWithAddress = buyer) => {
    await allow(sender, valueOf(r));
    const receipt = (await (await f.SSW.connect(sender).fundFromWallet(r)).wait())!;
    return { subscriptionId: subscriptionIdOf(sender.address, r.epoch), receipt };
  };

  /** A wallet top-up, with the approval it needs. */
  const walletTopUp = async (
    subscriptionId: string,
    additions: ReturnType<typeof budget>[],
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

    /** Everything a funding or a top-up writes or moves, for the subscription of `subscriptionId`. */
    const stateOf = async (subscriptionId: string) => ({
      exists: await f.SSS.subscriptionExists(subscriptionId),
      record: plain(await f.SSS.getSubscription(subscriptionId)),
      budgets: tuples(await f.SSS.getBudgets(subscriptionId)),
      storedBudgets: await f.SSS.storedBudgetCount(subscriptionId),
      walletSubscriptions: await f.SSS.accountSubscriptionCount(0n),
      funded: [await f.QIS.walletFunding(epoch), await f.QIS.walletFunding(epoch + 1n), await f.QIS.walletFunding(epoch + 2n)],
      balances: [await Falsy.balanceOf(buyer.address), await Falsy.balanceOf(await f.Vault.getAddress())],
    });

    it('a funding is refused TokenTransferFailed, with no record, budget, list entry, money booked or balance left of it', async () => {
      const r = walletRequestOf(epoch, {
        budgets: [budget(0, CLASS_INFERENCE, 7n * TRAC), budget(1, CLASS_QUERY, 3n * TRAC)],
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
      expect(after.walletSubscriptions).to.equal(before.walletSubscriptions + 1n);
      expect(after.funded).to.deep.equal([10n * TRAC, 0n, 0n]);
      expect(after.balances).to.deep.equal([before.balances[0] - 10n * TRAC, before.balances[1] + 10n * TRAC]);
    });

    it('a top-up of a funded subscription is refused TokenTransferFailed, with its record, budgets, list entry, money booked and balances as they were', async () => {
      const subscriptionId = subscriptionIdOf(buyer.address, epoch);
      await f.SSW.connect(buyer).fundFromWallet(walletRequestOf(epoch, { budgets: [budget(0, CLASS_INFERENCE, 7n * TRAC)] }));
      const before = await stateOf(subscriptionId);
      const digest = (await f.SSS.getSubscription(subscriptionId)).planDigest;
      // An addition to the stored budget, and an appended one.
      const additions = [budget(0, CLASS_INFERENCE, TRAC), budget(1, CLASS_QUERY, 2n * TRAC)];
      const newDigest = ethers.id('another plan');

      await Falsy.setTransferFromReturnsFalse(true);
      await expect(f.SSW.connect(buyer).topUpFromWallet(subscriptionId, additions, newDigest)).to.be.revertedWithCustomError(
        f.SSW,
        'TokenTransferFailed',
      );
      expect(await stateOf(subscriptionId)).to.deep.equal(before);
      expect((await f.SSS.getSubscription(subscriptionId)).planDigest).to.equal(digest);

      // The same top-up goes through once the Token pays.
      await Falsy.setTransferFromReturnsFalse(false);
      await f.SSW.connect(buyer).topUpFromWallet(subscriptionId, additions, newDigest);
      const after = await stateOf(subscriptionId);
      expect(after.storedBudgets).to.equal(before.storedBudgets + 1n);
      expect(after.funded).to.deep.equal([10n * TRAC, 0n, 0n]);
      expect(after.balances).to.deep.equal([before.balances[0] - 3n * TRAC, before.balances[1] + 3n * TRAC]);
    });
  });

  // -------------------------------------------------------------------------
  // Wallet funding
  // -------------------------------------------------------------------------

  describe('wallet funding', () => {
    it("moves the whole value into the vault, books it under the subscription's epoch, records it under account 0 and emits SubscriptionFunded", async () => {
      const epoch = await h.epochNow();
      const r = walletRequestOf(epoch, {
        budgets: [budget(0, CLASS_INFERENCE, 7n * TRAC + 3n), budget(1, CLASS_QUERY, 3n * TRAC + 1n)],
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
      const endsAt = await h.epochStart(epoch + 1n);

      expect(await f.Token.balanceOf(buyer.address)).to.equal(buyerBefore - value);
      expect(await vaultBalance()).to.equal(vaultBefore + value);
      expect(await f.QIS.walletFunding(epoch)).to.equal(value);
      expect(await f.QIS.walletFunding(epoch + 1n)).to.equal(0n);

      expect(plain(await f.SSS.getSubscription(subscriptionId))).to.deep.equal({
        accountId: 0n,
        buyer: buyer.address,
        grantNonce: 0n,
        sessionKey: SESSION_KEY,
        epoch,
        planDigest: r.planDigest,
        startsAt: ts,
        endsAt,
        fundedEpoch: epoch,
        fundedWindow: 0n,
        discountBps: 0n,
        budgetCount: 2n,
        value,
        cost: value,
        spentFromWindow: 0n,
        spentFromTopUp: 0n,
      });
      expect(tuples(await f.SSS.getBudgets(subscriptionId))).to.deep.equal(tuples(r.budgets));
      expect(await f.SSS.accountSubscriptionCount(0n)).to.equal(1n);
      expect(await f.SSS.accountSubscriptionAt(0n, 0n)).to.equal(subscriptionId);

      const [pf] = await eventsOf(receipt, f.SSW, 'SubscriptionFunded');
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
      ]).to.deep.equal([subscriptionId, 0n, buyer.address, epoch, SESSION_KEY, r.planDigest, ts, endsAt, value, value, 0n]);
      expect(tuples(pf.budgets)).to.deep.equal(tuples(r.budgets));

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
      const r = walletRequestOf(await h.epochNow(), { budgets: [budget(0, CLASS_INFERENCE, 50n * TRAC)] });
      await walletFund(r);
      expect(await vaultBalance()).to.equal(vaultBefore + 50n * TRAC);
      expect(await f.Token.balanceOf(treasury.address)).to.equal(treasuryBefore);
      expect(await f.QIS.walletFunding(r.epoch)).to.equal(50n * TRAC);
    });

    it('a short allowance or balance reverts in the Token, with no partial effect', async () => {
      const r = walletRequestOf(await h.epochNow());
      await f.Token.connect(buyer).approve(await f.SSW.getAddress(), valueOf(r) - 1n);
      await expect(f.SSW.connect(buyer).fundFromWallet(r)).to.be.revertedWithCustomError(f.Token, 'ERC20InsufficientAllowance');
      expect(await f.SSS.subscriptionExists(subscriptionIdOf(buyer.address, r.epoch))).to.equal(false);
      expect(await f.QIS.walletFunding(r.epoch)).to.equal(0n);
    });

    it('applies the budget rules: none, too many, unsorted, duplicate, zero value, unknown class, zero price, a sum beyond uint96', async () => {
      const epoch = await h.epochNow();
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
        [[budget(1, CLASS_INFERENCE, (1n << 96n) - 1n), budget(2, CLASS_QUERY, 1n)], 'value'],
      ];
      for (const [budgets, reason] of cases) {
        await expect(f.SSW.connect(buyer).fundFromWallet(walletRequestOf(epoch, { budgets })), reason)
          .to.be.revertedWithCustomError(f.SSW, 'InvalidFundingRequest')
          .withArgs(reason);
      }
      await walletFund(walletRequestOf(epoch, { budgets: many(max) }));
    });
  });

  // -------------------------------------------------------------------------
  // The subscription
  // -------------------------------------------------------------------------

  describe('the subscription: one epoch, the current or the next', () => {
    it('a current-epoch subscription funded mid-epoch runs from now to the epoch boundary', async () => {
      await time.increase(epLen / 3n);
      const epoch = await h.epochNow();
      const { subscriptionId, receipt } = await walletFund(walletRequestOf(epoch));
      const s = await f.SSS.getSubscription(subscriptionId);
      const ts = await blockTime(receipt);
      expect(ts).to.be.greaterThan(await h.epochStart(epoch));
      expect([s.startsAt, s.endsAt]).to.deep.equal([ts, await h.epochStart(epoch + 1n)]);
    });

    it('a subscription funded ahead for the next epoch starts at that epoch, and its money is booked under that epoch', async () => {
      const next = (await h.epochNow()) + 1n;
      const r = walletRequestOf(next);
      const { subscriptionId } = await walletFund(r);
      const s = await f.SSS.getSubscription(subscriptionId);
      expect([s.startsAt, s.endsAt, s.fundedEpoch]).to.deep.equal([
        await h.epochStart(next),
        await h.epochStart(next + 1n),
        next - 1n,
      ]);
      expect(await f.QIS.walletFunding(next)).to.equal(valueOf(r));
      expect(await f.QIS.walletFunding(next - 1n)).to.equal(0n);
      expect(await f.QIS.walletFunding(next + 1n)).to.equal(0n);

      // The same for a Conviction Account subscription.
      const accountId = await h.openAccount({ buyer: buyer2 });
      const ca = await h.caFund(accountId, next, 10n * TRAC, buyer2);
      const record = await f.SSS.getSubscription(ca.subscriptionId);
      expect([record.startsAt, record.endsAt]).to.deep.equal([await h.epochStart(next), await h.epochStart(next + 1n)]);
      expect(await f.QIS.accountFunding(next)).to.equal(record.cost);
      expect(await f.QIS.accountFunding(next - 1n)).to.equal(0n);
      expect(await f.QIS.accountFunding(next + 1n)).to.equal(0n);
    });

    it('any other epoch is refused, for a wallet subscription and an account subscription alike', async () => {
      const accountId = await h.openAccount();
      await time.increase(2n * epLen);
      const now = await h.epochNow();
      for (const epoch of [0n, 1n, now - 1n, now + 2n, now + 1_000n]) {
        await expect(f.SSW.connect(buyer).fundFromWallet(walletRequestOf(epoch)), `wallet, epoch ${epoch}`)
          .to.be.revertedWithCustomError(f.SSW, 'InvalidFundingRequest')
          .withArgs('epoch');
        await expect(
          f.SS.connect(buyer).fundFromAccount(requestOf(accountId, epoch)),
          `account, epoch ${epoch}`,
        )
          .to.be.revertedWithCustomError(f.SS, 'InvalidFundingRequest')
          .withArgs('epoch');
      }
    });

    it('one subscription per buyer and epoch, shared by wallet and account subscriptions; another buyer funds its own', async () => {
      const accountId = await h.openAccount();
      const now = await h.epochNow();

      const { subscriptionId } = await walletFund(walletRequestOf(now));
      await allow(buyer, 10n * TRAC);
      await expect(f.SSW.connect(buyer).fundFromWallet(walletRequestOf(now)))
        .to.be.revertedWithCustomError(f.SSW, 'SubscriptionAlreadyFunded')
        .withArgs(subscriptionId);
      await expect(f.SS.connect(buyer).fundFromAccount(requestOf(accountId, now)))
        .to.be.revertedWithCustomError(f.SS, 'SubscriptionAlreadyFunded')
        .withArgs(subscriptionId);

      // The next epoch from an account, and then not from a wallet.
      const next = await h.caFund(accountId, now + 1n, 10n * TRAC);
      await expect(f.SSW.connect(buyer).fundFromWallet(walletRequestOf(now + 1n)))
        .to.be.revertedWithCustomError(f.SSW, 'SubscriptionAlreadyFunded')
        .withArgs(next.subscriptionId);

      // Another buyer has its own subscription for the same epoch.
      const other = await walletFund(walletRequestOf(now), buyer2);
      expect(other.subscriptionId).to.not.equal(subscriptionId);
      expect(await f.SSS.accountSubscriptionCount(0n)).to.equal(2n);
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
      expect(await f.QIS.walletFunding(now + 2n)).to.equal(10n * TRAC);
      expect(await f.QIS.walletFunding(now + 3n)).to.equal(0n);
    });
  });

  // -------------------------------------------------------------------------
  // The money
  // -------------------------------------------------------------------------

  describe('the money', () => {
    it("is booked under the subscription's own epoch, in no other, summing per epoch over buyers and top-ups", async () => {
      const now = await h.epochNow();
      const a = await walletFund(walletRequestOf(now, { budgets: [budget(0, CLASS_INFERENCE, 4n * TRAC)] }));
      await walletFund(walletRequestOf(now, { budgets: [budget(0, CLASS_QUERY, 6n * TRAC)] }), buyer2);
      await walletTopUp(a.subscriptionId, [budget(0, CLASS_INFERENCE, TRAC)]);
      expect(await f.QIS.walletFunding(now - 1n)).to.equal(0n);
      expect(await f.QIS.walletFunding(now)).to.equal(11n * TRAC);
      expect(await f.QIS.walletFunding(now + 1n)).to.equal(0n);
    });
  });

  // -------------------------------------------------------------------------
  // Wallet top-ups and upgrades
  // -------------------------------------------------------------------------

  describe('wallet top-ups and upgrades', () => {
    let subscriptionId: string;
    let epoch: bigint;
    const first = () => budget(1, CLASS_INFERENCE, 6n * TRAC, 2_000n);
    const second = () => budget(4, CLASS_QUERY, 4n * TRAC, 50n);

    beforeEach(async () => {
      epoch = await h.epochNow();
      ({ subscriptionId } = await walletFund(walletRequestOf(epoch, { budgets: [first(), second()] })));
    });

    it('a top-up adds to stored budgets and an upgrade appends new ones, at the subscription end, with the value into the vault', async () => {
      const additions = [
        budget(0, CLASS_QUERY, 2n * TRAC, 70n), // new, sorts first but is appended last
        { ...first(), value: TRAC }, // tops up index 0
        budget(9, CLASS_INFERENCE, 3n * TRAC, 900n), // new
      ];
      const vaultBefore = await vaultBalance();
      const planDigest = ethers.id('plan-2');
      const receipt = await walletTopUp(subscriptionId, additions, buyer, planDigest);

      expect(await vaultBalance()).to.equal(vaultBefore + 6n * TRAC);
      expect(await f.QIS.walletFunding(epoch)).to.equal(16n * TRAC);
      expect(await f.QIS.walletFunding(epoch + 1n)).to.equal(0n);
      expect(tuples(await f.SSS.getBudgets(subscriptionId))).to.deep.equal(
        tuples([
          { ...first(), value: 7n * TRAC },
          second(),
          budget(0, CLASS_QUERY, 2n * TRAC, 70n),
          budget(9, CLASS_INFERENCE, 3n * TRAC, 900n),
        ]),
      );
      const s = await f.SSS.getSubscription(subscriptionId);
      expect([s.value, s.cost, s.budgetCount, s.planDigest, s.spentFromWindow, s.spentFromTopUp]).to.deep.equal([
        16n * TRAC,
        16n * TRAC,
        4n,
        planDigest,
        0n,
        0n,
      ]);

      const [ev] = await eventsOf(receipt, f.SSW, 'SubscriptionToppedUp');
      expect([ev.subscriptionId, ev.accountId, ev.buyer, ev.value, ev.cost, ev.planDigest]).to.deep.equal([
        subscriptionId,
        0n,
        buyer.address,
        6n * TRAC,
        6n * TRAC,
        planDigest,
      ]);
      expect(tuples(ev.additions)).to.deep.equal(tuples(additions));
    });

    it('a subscription funded ahead is topped up before it starts', async () => {
      const next = await walletFund(walletRequestOf(epoch + 1n));
      await walletTopUp(next.subscriptionId, [budget(0, CLASS_INFERENCE, TRAC)]);
      expect((await f.SSS.getSubscription(next.subscriptionId)).value).to.equal(11n * TRAC);
      expect(await f.QIS.walletFunding(epoch + 1n)).to.equal(11n * TRAC);
      expect(await f.QIS.walletFunding(epoch)).to.equal(10n * TRAC);
    });

    it('limits never change within a subscription: a stored budget must repeat its class and price cap', async () => {
      for (const changed of [
        { ...first(), maxPricePerUnit: 2_001n },
        { ...first(), serviceClass: CLASS_QUERY },
        { ...second(), maxPricePerUnit: 49n },
      ]) {
        await expect(f.SSW.connect(buyer).topUpFromWallet(subscriptionId, [changed], ethers.ZeroHash))
          .to.be.revertedWithCustomError(f.SSW, 'BudgetTermsChanged')
          .withArgs(changed.serviceId);
      }
    });

    it('applies the budget rules to the additions, and to the subscription as a whole', async () => {
      const max = Number(await f.SSS.maxBudgetsPerSubscription());
      const fresh = (n: number) => Array.from({ length: n }, (_, i) => budget(100 + i, CLASS_INFERENCE, TRAC));
      const cases: Array<[ReturnType<typeof budget>[], string]> = [
        [[], 'budgetCount'],
        [fresh(max - 1), 'budgetCount'], // two stored plus max − 1 new
        [[budget(5, CLASS_INFERENCE, TRAC), budget(3, CLASS_INFERENCE, TRAC)], 'budgetOrder'],
        [[{ ...first(), value: TRAC }, { ...first(), value: TRAC }], 'budgetOrder'],
        [[{ ...first(), value: 0n }], 'budgetValue'],
        [[budget(7, CLASS_INFERENCE, 0n)], 'budgetValue'],
        [[budget(7, 3n, TRAC)], 'serviceClass'],
        [[budget(7, CLASS_QUERY, TRAC, 0n)], 'maxPricePerUnit'],
        [[{ ...first(), value: (1n << 96n) - 1n }], 'value'],
      ];
      for (const [additions, reason] of cases) {
        await expect(f.SSW.connect(buyer).topUpFromWallet(subscriptionId, additions, ethers.ZeroHash), reason)
          .to.be.revertedWithCustomError(f.SSW, 'InvalidFundingRequest')
          .withArgs(reason);
      }
      await walletTopUp(subscriptionId, fresh(max - 2));
      expect((await f.SSS.getSubscription(subscriptionId)).budgetCount).to.equal(BigInt(max));
    });

    it('refuses an unknown subscription, another buyer, an account subscription, and a subscription that has ended, with no partial effect', async () => {
      const unknown = ethers.id('never-funded');
      await expect(f.SSW.connect(buyer).topUpFromWallet(unknown, [first()], ethers.ZeroHash))
        .to.be.revertedWithCustomError(f.SSW, 'SubscriptionNotFound')
        .withArgs(unknown);
      await allow(stranger, TRAC);
      await expect(f.SSW.connect(stranger).topUpFromWallet(subscriptionId, [first()], ethers.ZeroHash))
        .to.be.revertedWithCustomError(f.SSW, 'NotSubscriptionBuyer')
        .withArgs(subscriptionId, stranger.address);

      const accountId = await h.openAccount();
      const ca = await h.caFund(accountId, epoch + 1n, 10n * TRAC);
      await expect(f.SSW.connect(buyer).topUpFromWallet(ca.subscriptionId, [ca.r.budgets[0]], ethers.ZeroHash))
        .to.be.revertedWithCustomError(f.SSW, 'WrongFundingSource')
        .withArgs(ca.subscriptionId, accountId);
      await expect(f.SS.connect(buyer).topUpFromAccount(subscriptionId, [first()], ethers.ZeroHash))
        .to.be.revertedWithCustomError(f.SS, 'WrongFundingSource')
        .withArgs(subscriptionId, 0n);

      const s = await f.SSS.getSubscription(subscriptionId);
      await time.increaseTo(s.endsAt);
      await expect(f.SSW.connect(buyer).topUpFromWallet(subscriptionId, [{ ...first(), value: TRAC }], ethers.ZeroHash))
        .to.be.revertedWithCustomError(f.SSW, 'SubscriptionEnded')
        .withArgs(subscriptionId, s.endsAt);
      expect(plain(await f.SSS.getSubscription(subscriptionId))).to.deep.equal(plain(s));
      expect(await f.QIS.walletFunding(epoch)).to.equal(10n * TRAC);
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

    it("spends at the account tier, books the cost under the subscription's epoch, adds to the record and counts no new subscription", async () => {
      const additions = [budget(0, CLASS_INFERENCE, 10n * TRAC), budget(3, CLASS_QUERY, 5n * TRAC)];
      const cost = costOf(15n * TRAC, BPS);
      const vaultBefore = await vaultBalance();
      const returned = await f.SS.connect(buyer).topUpFromAccount.staticCall(subscriptionId, additions, ethers.id('p2'));
      expect(returned).to.equal(cost);
      const receipt = (await (await f.SS.connect(buyer).topUpFromAccount(subscriptionId, additions, ethers.id('p2'))).wait())!;

      const [covered] = await eventsOf(receipt, f.PC, 'ServiceCostCovered');
      expect([covered.subscriptionId, covered.value, covered.cost]).to.deep.equal([subscriptionId, 15n * TRAC, cost]);

      const s = await f.SSS.getSubscription(subscriptionId);
      const fundedCost = costOf(20n * TRAC, BPS);
      expect([s.value, s.cost, s.spentFromWindow + s.spentFromTopUp, s.budgetCount]).to.deep.equal([
        35n * TRAC,
        fundedCost + cost,
        fundedCost + cost,
        2n,
      ]);
      expect(tuples(await f.SSS.getBudgets(subscriptionId))).to.deep.equal(
        tuples([budget(0, CLASS_INFERENCE, 30n * TRAC), budget(3, CLASS_QUERY, 5n * TRAC)]),
      );
      expect((await f.SSS.getUsage(accountId, buyer.address)).subscriptions).to.equal(1n);
      // The funding's cost and the top-up's are both under the subscription's epoch,
      // in the Conviction Account ledger. No TRAC moves, and nothing is booked
      // to the wallet ledger.
      expect(await f.QIS.accountFunding(epoch)).to.equal(fundedCost + cost);
      expect(await f.QIS.accountFunding(epoch - 1n)).to.equal(0n);
      expect(await f.QIS.accountFunding(epoch + 1n)).to.equal(0n);
      expect(await vaultBalance()).to.equal(vaultBefore);
      expect(await f.QIS.walletFunding(epoch)).to.equal(0n);

      const [ev] = await eventsOf(receipt, f.SS, 'SubscriptionToppedUp');
      expect([ev.subscriptionId, ev.accountId, ev.buyer, ev.value, ev.cost, ev.planDigest]).to.deep.equal([
        subscriptionId,
        accountId,
        buyer.address,
        15n * TRAC,
        cost,
        ethers.id('p2'),
      ]);
    });

    it("the subscription limit counts the subscription's earlier cost, under the limit stored at this block", async () => {
      // 20 TRAC cost 14 at the 30 % tier; the limit is 30.
      const room = valueFor(30n * TRAC - costOf(20n * TRAC, BPS));
      await expect(f.SS.connect(buyer).topUpFromAccount(subscriptionId, [budget(0, CLASS_INFERENCE, room + 2n)], ethers.ZeroHash))
        .to.be.revertedWithCustomError(f.SS, 'LimitExceeded')
        .withArgs('maxCostPerEpoch', 30n * TRAC, costOf(20n * TRAC, BPS) + costOf(room + 2n, BPS));
      await f.SS.connect(owner).setBuyerLimits(accountId, buyer.address, {
        maxCostPerEpoch: 40n * TRAC,
        expiresAt: (await f.SSS.getGrant(accountId, buyer.address)).expiresAt,
      });
      await f.SS.connect(buyer).topUpFromAccount(subscriptionId, [budget(0, CLASS_INFERENCE, room + 2n)], ethers.ZeroHash);
    });

    it('needs the opt-in and a live grant, from the subscription buyer, before the subscription ends', async () => {
      const add = [budget(0, CLASS_INFERENCE, TRAC)];
      await expect(f.SS.connect(buyer2).topUpFromAccount(subscriptionId, add, ethers.ZeroHash))
        .to.be.revertedWithCustomError(f.SS, 'NotSubscriptionBuyer')
        .withArgs(subscriptionId, buyer2.address);
      await f.SS.connect(owner).setServiceSpending(accountId, false);
      await expect(f.SS.connect(buyer).topUpFromAccount(subscriptionId, add, ethers.ZeroHash))
        .to.be.revertedWithCustomError(f.SS, 'ServiceSpendingDisabled')
        .withArgs(accountId);
      await f.SS.connect(owner).setServiceSpending(accountId, true);
      await f.SS.connect(buyer).topUpFromAccount(subscriptionId, add, ethers.ZeroHash);
      await f.SS.connect(owner).removeBuyer(accountId, buyer.address);
      await expect(f.SS.connect(buyer).topUpFromAccount(subscriptionId, add, ethers.ZeroHash))
        .to.be.revertedWithCustomError(f.SS, 'GrantRevoked')
        .withArgs(accountId, buyer.address);

      const s = await f.SSS.getSubscription(subscriptionId);
      await time.increaseTo(s.endsAt);
      await expect(f.SS.connect(buyer).topUpFromAccount(subscriptionId, add, ethers.ZeroHash))
        .to.be.revertedWithCustomError(f.SS, 'SubscriptionEnded')
        .withArgs(subscriptionId, s.endsAt);
    });

    /** What a refused top-up must leave as it was: the record, its budgets, the cost booked and the allowance. */
    const untouched = async (id: string, account: bigint) => [
      plain(await f.SSS.getSubscription(id)),
      tuples(await f.SSS.getBudgets(id)),
      await f.QIS.accountFunding(epoch),
      await f.SS.currentWindowAllowance(account),
    ];

    it("a new grant to the buyer reopens no subscription whose own grant has ended: after a revocation or an expiry, a top-up is refused and spends nothing", async () => {
      const add = [budget(0, CLASS_INFERENCE, 10n * TRAC)];
      const fundedUnder = (await f.SSS.getSubscription(subscriptionId)).grantNonce;

      // Revoked ten minutes after the funding, then added again ten minutes
      // later, with room for the top-up.
      await time.increase(600n);
      await f.SS.connect(owner).removeBuyer(accountId, buyer.address);
      const revokedAt = (await f.SSS.getGrant(accountId, buyer.address)).revokedAt;
      await time.increase(600n);
      await h.addBuyer(accountId, buyer, 1_000n * TRAC);
      expect(await f.SSS.isGrantActive(accountId, buyer.address)).to.equal(true);
      expect(await f.SSS.grantEnd(accountId, buyer.address, fundedUnder)).to.equal(revokedAt);

      const before = await untouched(subscriptionId, accountId);
      await expect(f.SS.connect(buyer).topUpFromAccount(subscriptionId, add, ethers.ZeroHash))
        .to.be.revertedWithCustomError(f.SS, 'GrantExpired')
        .withArgs(accountId, buyer.address);
      expect(await untouched(subscriptionId, accountId)).to.deep.equal(before);
      // One subscription per buyer and epoch, so the buyer is served again from
      // its next subscription not yet funded, which the new grant tops up.
      await expect(f.SS.connect(buyer).fundFromAccount(requestOf(accountId, epoch)))
        .to.be.revertedWithCustomError(f.SS, 'SubscriptionAlreadyFunded')
        .withArgs(subscriptionId);
      const next = await h.caFund(accountId, epoch + 1n, 10n * TRAC);
      await f.SS.connect(buyer).topUpFromAccount(next.subscriptionId, add, ethers.ZeroHash);

      // The same for a grant that expired inside the subscription and was
      // renewed by a new one.
      await h.addBuyer(accountId, buyer2, 1_000n * TRAC);
      const second = await h.caFund(accountId, epoch, 10n * TRAC, buyer2);
      const expiresAt = (await h.latest()) + 3_600n;
      expect(expiresAt).to.be.lessThan((await f.SSS.getSubscription(second.subscriptionId)).endsAt);
      await f.SS.connect(owner).setBuyerLimits(accountId, buyer2.address, { maxCostPerEpoch: 1_000n * TRAC, expiresAt });
      await time.increaseTo(expiresAt + 60n);
      await h.addBuyer(accountId, buyer2, 1_000n * TRAC);
      const renewed = await untouched(second.subscriptionId, accountId);
      await expect(f.SS.connect(buyer2).topUpFromAccount(second.subscriptionId, add, ethers.ZeroHash))
        .to.be.revertedWithCustomError(f.SS, 'GrantExpired')
        .withArgs(accountId, buyer2.address);
      expect(await untouched(second.subscriptionId, accountId)).to.deep.equal(renewed);
    });

    it("a subscription whose grant was replaced while still live is topped up until that grant's own expiry, and from then on refused", async () => {
      const add = [budget(0, CLASS_INFERENCE, 10n * TRAC)];
      const s = await f.SSS.getSubscription(subscriptionId);
      // The subscription's grant is set to expire inside the subscription, then
      // replaced while it is still live.
      const expiresAt = (await h.latest()) + 3_600n;
      expect(expiresAt).to.be.lessThan(s.endsAt);
      await f.SS.connect(owner).setBuyerLimits(accountId, buyer.address, { maxCostPerEpoch: 30n * TRAC, expiresAt });
      await h.addBuyer(accountId, buyer, 1_000n * TRAC);
      expect(await f.SSS.grantEnd(accountId, buyer.address, s.grantNonce)).to.equal(expiresAt);

      // Until then the subscription takes requests, and so a top-up, spent and
      // booked as any other, under the buyer's new grant's limit.
      await time.setNextBlockTimestamp(expiresAt - 1n);
      await f.SS.connect(buyer).topUpFromAccount(subscriptionId, add, ethers.ZeroHash);
      const booked = costOf(20n * TRAC, BPS) + costOf(10n * TRAC, BPS);
      expect(await f.QIS.accountFunding(epoch)).to.equal(booked);
      expect((await f.SSS.getSubscription(subscriptionId)).cost).to.equal(booked);

      // From its expiry on, the subscription takes no request, and no top-up.
      const before = await untouched(subscriptionId, accountId);
      await time.setNextBlockTimestamp(expiresAt);
      await expect(f.SS.connect(buyer).topUpFromAccount(subscriptionId, add, ethers.ZeroHash))
        .to.be.revertedWithCustomError(f.SS, 'GrantExpired')
        .withArgs(accountId, buyer.address);
      expect(await untouched(subscriptionId, accountId)).to.deep.equal(before);
    });

    it('limits never change within a subscription, and an unknown subscription is refused', async () => {
      await expect(f.SS.connect(buyer).topUpFromAccount(subscriptionId, [budget(0, CLASS_INFERENCE, TRAC, 1n)], ethers.ZeroHash))
        .to.be.revertedWithCustomError(f.SS, 'BudgetTermsChanged')
        .withArgs(budget(0, CLASS_INFERENCE, TRAC).serviceId);
      const unknown = ethers.id('never-funded');
      await expect(f.SS.connect(buyer).topUpFromAccount(unknown, [budget(0, CLASS_INFERENCE, TRAC)], ethers.ZeroHash))
        .to.be.revertedWithCustomError(f.SS, 'SubscriptionNotFound')
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
      await expect(f.SS.connect(buyer).fundFromAccount(requestOf(accountId, now, { sessionKey: ethers.ZeroAddress })))
        .to.be.revertedWithCustomError(f.SS, 'ZeroSessionKey');
    });

    it('while paused, no funding or top-up runs, from a wallet or an account; unpaused, they go on', async () => {
      const accountId = await h.openAccount();
      const now = await h.epochNow();
      const wallet = await walletFund(walletRequestOf(now));
      const ca = await h.caFund(accountId, now + 1n, 10n * TRAC);
      await forward(f.QIS, 'setPaused', [true]);
      const add = [budget(0, CLASS_INFERENCE, TRAC)];
      for (const call of [
        f.SSW.connect(buyer).fundFromWallet(walletRequestOf(now + 1n)),
        f.SSW.connect(buyer).topUpFromWallet(wallet.subscriptionId, add, ethers.ZeroHash),
        f.SS.connect(buyer2).fundFromAccount(requestOf(accountId, now)),
        f.SS.connect(buyer).topUpFromAccount(ca.subscriptionId, add, ethers.ZeroHash),
      ]) {
        await expect(call).to.be.revertedWithCustomError(f.SSW, 'QueryInferencePaused');
      }
      await forward(f.QIS, 'setPaused', [false]);
      await walletTopUp(wallet.subscriptionId, add);
      await f.SS.connect(buyer).topUpFromAccount(ca.subscriptionId, add, ethers.ZeroHash);
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
      await expect(f.SSW.connect(buyer).topUpFromWallet(ethers.id('x'), [budget(0, CLASS_INFERENCE, TRAC)], ethers.ZeroHash))
        .to.be.revertedWithCustomError(f.SSW, 'QueryInferenceNotActive')
        .withArgs(now + 1n, now);

      await time.increaseTo(await h.epochStart(now + 1n));
      const { subscriptionId } = await walletFund(walletRequestOf(now + 1n));
      await walletTopUp(subscriptionId, [budget(0, CLASS_INFERENCE, TRAC)]);
      expect(await f.QIS.walletFunding(now + 1n)).to.equal(11n * TRAC);
    });

    it('Conviction Account funding and top-ups are refused until the activation epoch too, so no cost is booked in an epoch before it, which no pool reaches', async () => {
      const accountId = await h.openAccount();
      const now = await h.epochNow();
      // A subscription funded while active, to try a top-up against later.
      const active = await h.caFund(accountId, now + 1n, 10n * TRAC);
      await useInactiveStorage();
      expect(await f.QIS.activationEpoch()).to.equal(0n);
      const add = [budget(0, CLASS_INFERENCE, TRAC)];
      const allowance = await f.SS.currentWindowAllowance(accountId);
      await expect(f.SS.connect(buyer2).fundFromAccount(requestOf(accountId, now)))
        .to.be.revertedWithCustomError(f.SS, 'QueryInferenceNotActive')
        .withArgs(0n, now);
      await expect(f.SS.connect(buyer).topUpFromAccount(active.subscriptionId, add, ethers.ZeroHash))
        .to.be.revertedWithCustomError(f.SS, 'QueryInferenceNotActive')
        .withArgs(0n, now);

      await activateQueryInference(f.Hub, f.QIS, now + 1n);
      await expect(f.SS.connect(buyer2).fundFromAccount(requestOf(accountId, now + 1n)))
        .to.be.revertedWithCustomError(f.SS, 'QueryInferenceNotActive')
        .withArgs(now + 1n, now);
      expect(await f.SS.currentWindowAllowance(accountId)).to.deep.equal(allowance);

      await time.increaseTo(await h.epochStart(now + 1n));
      await h.addBuyer(accountId, buyer2, 1_000n * TRAC);
      await h.caFund(accountId, now + 1n, 10n * TRAC, buyer2);
      await f.SS.connect(buyer).topUpFromAccount(active.subscriptionId, add, ethers.ZeroHash);
      expect(await f.QIS.accountFunding(now + 1n)).to.equal(costOf(10n * TRAC, BPS) + costOf(TRAC, BPS));
    });
  });

  /** The smallest value whose cost at the 30 % tier is exactly `cost`. */
  function valueFor(cost: bigint): bigint {
    return (cost * 10_000n + (10_000n - BPS) - 1n) / (10_000n - BPS);
  }
});
