// The query/inference pool of an epoch (OT-RFC-27), and the gross reward each
// node spends from it, end to end on the development deploy of the staking,
// account and subscription stacks (StakingV10 wired to the settlement, the
// activation epoch at the deployment epoch, λ 0.5). No step runs when an epoch
// ends: its pool is a plain read of what was funded and what counted.
//
// Groups:
//   - an epoch with value: its pool is its money, wallet value and Conviction
//     Account cost alike, with the shares nobody used;
//   - an epoch with no value: its pool is 0 and its money rolls, along an
//     unbroken run, to the next epoch with value, so each epoch's money reaches
//     exactly one pool, also over a seeded run;
//   - the activation epoch, where the run stops;
//   - money funded ahead, which joins the epoch it is funded for;
//   - nothing changes after an epoch's end: its reads, and the claims of
//     StakingV10, from the first second of the next epoch on;
//   - an ended epoch takes no booking, through the funding paths or directly;
//   - the epoch in progress, which reads as if it ended now;
//   - queryInferenceGross: OT-RFC-27's formula at λ 0, 0.5 and 1, at equal and
//     unequal stake factors, its sum over the nodes, short of the pool by under
//     2 wei per node, the R share when ΣQueryInferenceScore is 0, and 0 for a
//     node with no value, which walks no run.
//
// How batches count is in v10-query-inference-counting.test.ts, and the pool
// paid through the operator fee and to delegators by score in
// v10-query-inference-rewards.test.ts.

import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { loadFixture, takeSnapshot, time } from '@nomicfoundation/hardhat-network-helpers';
import { expect } from 'chai';
import hre from 'hardhat';

import { QueryInferenceStorage } from '../typechain';
import { BPS, CLASS_INFERENCE, Domain, TRAC, budget, requestOf, subscriptionIdOf, walletRequestOf } from './helpers/conviction-service';
import { SCALE18, hardhatWallet, openConvictionAccount, queryInferenceDomain } from './helpers/query-inference';
import { RewardsHelpers, Seller, UNIT_PRICE, deployRewardsStack, rewardsHelpers } from './helpers/query-inference-rewards';

const STAKE_S_50 = 1_250_000n * TRAC; // S = sqrt(0.25) = 0.5
const STAKE_S_65 = 2_112_500n * TRAC; // S = sqrt(0.4225) = 0.65
const STAKE_S_90 = 4_050_000n * TRAC; // S = sqrt(0.81) = 0.9

/** This suite's own fixture, so loadFixture keeps a snapshot for it alone. */
async function deployFixture() {
  return deployRewardsStack();
}

type Fixture = Awaited<ReturnType<typeof deployFixture>>;

describe('@integration The query/inference pool of an epoch', function () {
  let f: Fixture;
  let h: RewardsHelpers;
  let domain: Domain;
  let buyer: SignerWithAddress;
  let buyer2: SignerWithAddress;
  let accountBuyer: SignerWithAddress;
  const key = hardhatWallet(60);

  beforeEach(async () => {
    hre.helpers.resetDeploymentsJson();
    f = await loadFixture(deployFixture);
    domain = await queryInferenceDomain(f.QIS);
    h = rewardsHelpers({ f, domain, firstAccount: 30, key });
    buyer = f.accounts[21];
    buyer2 = f.accounts[22];
    accountBuyer = f.accounts[24];
  });

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  const epochStart = async (e: bigint) => f.Chronos.timestampForEpoch(e);
  const setLambda = async (value: bigint) => h.forward(f.QIS, 'setLambdaBps', [value]);
  const gross = async (e: bigint, s: Seller) => f.QS.queryInferenceGross(e, s.identityId);
  const funding = async (e: bigint) => {
    const [wallet, conviction] = await f.QIS.fundingIn(e);
    return [wallet, conviction];
  };
  const money = async (e: bigint) => {
    const [wallet, conviction] = await funding(e);
    return wallet + conviction;
  };

  /** `by`, given a node score in the current epoch if it has none yet, lands `amount` on a subscription's budget: its one receipt there. */
  const land = async (by: Seller, p: string, amount: bigint) => {
    const epoch = await h.epochNow();
    if ((await f.RSS.getNodeEpochScore(epoch, by.identityId)) === 0n) await h.scoreEpoch(epoch, by, 100n * TRAC);
    await h.claimReceipts(by, p, amount);
  };

  /** A wallet top-up of `value` to `who`'s subscription. */
  const topUp = async (who: SignerWithAddress, p: string, value: bigint) => {
    await f.Token.mint(who.address, value);
    await f.Token.connect(who).approve(await f.SSW.getAddress(), value);
    await f.SSW.connect(who).topUpFromWallet(p, [budget(0, CLASS_INFERENCE, value, UNIT_PRICE)], hre.ethers.ZeroHash);
  };

  /** A subscription of `epoch` for `accountBuyer`, from an account at the 75 % tier: one budget of `value`, at a quarter of it. */
  const accountSubscription = async (epoch: bigint, value: bigint) => {
    const { accountId } = await openConvictionAccount({
      ...f,
      owner: f.accounts[23],
      buyer: accountBuyer,
      committed: 1_000_000n * TRAC,
      limit: 1_000n * TRAC,
    });
    await f.SS.connect(accountBuyer).fundFromAccount(
      requestOf(accountId, epoch, { budgets: [budget(0, CLASS_INFERENCE, value, UNIT_PRICE)], sessionKey: key.address }),
    );
    return { accountId, p: subscriptionIdOf(accountBuyer.address, epoch) };
  };

  /**
   * A replacement storage with no activation epoch, which the settlement and
   * the funding contracts read from now on, and under whose domain requests are
   * signed from now on.
   */
  const replaceStorage = async () => {
    const fresh = (await (
      await hre.ethers.getContractFactory('QueryInferenceStorage')
    ).deploy(await f.Hub.getAddress())) as unknown as QueryInferenceStorage;
    await fresh.waitForDeployment();
    await f.Hub.setContractAddress('QueryInferenceStorage', await fresh.getAddress());
    await h.forward(fresh, 'initialize');
    for (const c of [f.QS, f.SSW, f.SS]) await h.forward(c, 'initialize');
    domain = await queryInferenceDomain(fresh);
    h = rewardsHelpers({ f, domain, firstAccount: 50, key });
    return fresh;
  };

  /** OT-RFC-27's formula, floored per term as the contract floors it. */
  const formula = (pool: bigint, lambda: bigint, r: bigint, totalServed: bigint, qis: bigint, sumQis: bigint) =>
    (pool * (BPS - lambda) * r) / (BPS * totalServed) +
    (sumQis === 0n ? (pool * lambda * r) / (BPS * totalServed) : (pool * lambda * qis) / (BPS * sumQis));

  // -------------------------------------------------------------------------
  // An epoch with value
  // -------------------------------------------------------------------------

  describe('an epoch with value', () => {
    it('its pool is its money, wallet value and Conviction Account cost alike, and the only node with value takes it all', async () => {
      const s1 = await h.createSeller(STAKE_S_50, 0n);
      const e = await h.epochNow();
      await setLambda(0n); // one term, so one floor: this pool is no round number of wei
      const p = await h.walletFund(buyer, e, 10n * TRAC);
      // Booked as ServiceSubscriptions books a subscription's cost; the Hub owner
      // passes onlyContracts.
      await f.QIS.addAccountFunding(e, 4n * TRAC);
      await f.QIS.addAccountFunding(e, 3n);
      await land(s1, p, TRAC);
      await h.toEpoch(e + 1n);

      expect(await funding(e)).to.deep.equal([10n * TRAC, 4n * TRAC + 3n]);
      expect(await f.QS.epochPool(e)).to.equal(14n * TRAC + 3n);
      expect(await gross(e, s1)).to.equal(14n * TRAC + 3n);
    });

    it("a share nobody used stays in the pool, a shared margin: a wallet's and an account's money with no receipt go to the nodes that served another buyer", async () => {
      const a = await h.createSeller(STAKE_S_50, 0n);
      const b = await h.createSeller(STAKE_S_50, 0n);
      const e = await h.epochNow();
      await setLambda(0n);
      const served = await h.walletFund(buyer, e, 100n * TRAC);
      await h.walletFund(buyer2, e, 50n * TRAC); // no receipt lands on it
      await accountSubscription(e, 100n * TRAC); // at a cost of 25, and no receipt lands on it
      await land(a, served, TRAC);
      await land(b, served, 3n * TRAC);
      await h.toEpoch(e + 1n);

      expect(await funding(e)).to.deep.equal([150n * TRAC, 25n * TRAC]);
      expect(await f.QIS.budgetUsed(served, 0n)).to.equal(4n * TRAC);
      // 4 of it counted, and all of the money is the pool, split by R.
      expect(await f.QS.epochPool(e)).to.equal(175n * TRAC);
      expect(await gross(e, a)).to.equal((175n * TRAC) / 4n);
      expect(await gross(e, b)).to.equal((525n * TRAC) / 4n);
    });
  });

  // -------------------------------------------------------------------------
  // An epoch with no value, and the rollover
  // -------------------------------------------------------------------------

  describe('an epoch with no value', () => {
    it('its pool is 0 and its money rolls: three epochs with no value, one of them with no money either, then one with value pays the sum', async () => {
      const s1 = await h.createSeller(STAKE_S_50, 0n);
      const e = await h.epochNow();
      await h.walletFund(buyer, e, 10n * TRAC);
      await h.toEpoch(e + 1n);
      await h.walletFund(buyer, e + 1n, 20n * TRAC);
      // No subscription of e + 2: no money in it. The money waits for as long as no node sells.
      await h.toEpoch(e + 3n);
      for (const epoch of [e, e + 1n, e + 2n]) {
        expect(await f.QS.epochPool(epoch)).to.equal(0n);
        expect(await gross(epoch, s1)).to.equal(0n);
      }

      const p = await h.walletFund(buyer, e + 3n, 5n * TRAC);
      await land(s1, p, TRAC);
      await h.toEpoch(e + 4n);

      for (const epoch of [e, e + 1n, e + 2n]) expect(await f.QS.epochPool(epoch)).to.equal(0n);
      expect(await f.QS.epochPool(e + 3n)).to.equal(35n * TRAC);
      // The only node with value takes the whole pool, the run included.
      expect(await gross(e + 3n, s1)).to.equal(35n * TRAC);
      // Nothing is left for the epoch after it.
      expect(await f.QS.epochPool(e + 4n)).to.equal(0n);
    });

    it('Conviction Account cost alone rolls like wallet value, and is paid with the next value', async () => {
      const s1 = await h.createSeller(STAKE_S_50, 0n);
      const e = await h.epochNow();
      await setLambda(0n); // one term, so one floor: this pool is no round number of wei
      await f.QIS.addAccountFunding(e, 6n * TRAC); // no value in e
      await h.toEpoch(e + 1n);
      const p = await h.walletFund(buyer, e + 1n, 2n * TRAC);
      await f.QIS.addAccountFunding(e + 1n, TRAC + 1n);
      await land(s1, p, TRAC);
      await f.QIS.addAccountFunding(e + 2n, 5n * TRAC); // no value in e + 2 either
      await h.toEpoch(e + 3n);

      expect(await f.QS.epochPool(e)).to.equal(0n);
      expect(await f.QS.epochPool(e + 1n)).to.equal(9n * TRAC + 1n);
      expect(await gross(e + 1n, s1)).to.equal(9n * TRAC + 1n);
      // That of e + 2 waits on.
      expect(await f.QS.epochPool(e + 2n)).to.equal(0n);
      expect(await funding(e + 2n)).to.deep.equal([0n, 5n * TRAC]);
    });

    it('an epoch with value breaks the run: the money before it is not counted twice', async () => {
      const s1 = await h.createSeller(STAKE_S_50, 0n);
      const e = await h.epochNow();
      await h.walletFund(buyer, e, 10n * TRAC); // no value: it rolls into e + 1
      await h.toEpoch(e + 1n);
      const paid = await h.walletFund(buyer, e + 1n, 20n * TRAC);
      await land(s1, paid, TRAC);
      await h.toEpoch(e + 2n);
      await h.walletFund(buyer, e + 2n, 7n * TRAC); // no value: it rolls into e + 3
      await h.toEpoch(e + 3n);
      const again = await h.walletFund(buyer, e + 3n, 3n * TRAC);
      await land(s1, again, TRAC);
      await h.toEpoch(e + 4n);

      expect(await f.QS.epochPool(e + 1n)).to.equal(30n * TRAC);
      expect(await f.QS.epochPool(e + 2n)).to.equal(0n);
      expect(await f.QS.epochPool(e + 3n)).to.equal(10n * TRAC);
      expect(await gross(e + 1n, s1)).to.equal(30n * TRAC);
      expect(await gross(e + 3n, s1)).to.equal(10n * TRAC);
    });

    it('the money of each epoch reaches exactly one pool, over eight epochs, by summing', async () => {
      const a = await h.createSeller(STAKE_S_50, 0n);
      const b = await h.createSeller(STAKE_S_90, 0n);
      const e = await h.epochNow();
      // Each epoch's money in TRAC, and whether a node counts value in it: a
      // run with an epoch of no money in it, two epochs with value in a row,
      // and a run that the last epoch pays.
      const plan: Array<[bigint, boolean]> = [
        [10n, false],
        [20n, true],
        [30n, false],
        [0n, false],
        [40n, true],
        [50n, true],
        [60n, false],
        [5n, true],
      ];
      for (const [i, [value, sells]] of plan.entries()) {
        const epoch = e + BigInt(i);
        if (i > 0) await h.toEpoch(epoch);
        if (value === 0n) continue;
        const p = await h.walletFund(buyer, epoch, value * TRAC);
        if (sells) {
          await land(a, p, TRAC);
          await land(b, p, 2n * TRAC);
        }
      }
      await h.toEpoch(e + BigInt(plan.length));

      const pools: bigint[] = [];
      for (let i = 0n; i < BigInt(plan.length); i++) pools.push(await f.QS.epochPool(e + i));
      expect(pools).to.deep.equal([0n, 30n, 0n, 0n, 70n, 50n, 0n, 65n].map((n) => n * TRAC));

      // At every epoch, its money so far is its pools so far and the run still rolling.
      let funded = 0n;
      let paid = 0n;
      let rolling = 0n;
      for (const [i, [value, sells]] of plan.entries()) {
        const epoch = e + BigInt(i);
        expect(await funding(epoch)).to.deep.equal([value * TRAC, 0n]);
        funded += value * TRAC;
        paid += pools[i];
        rolling = sells ? 0n : rolling + value * TRAC;
        expect(funded, `epoch ${epoch}`).to.equal(paid + rolling);
        // What the nodes spend adds up to the pool, but the floors.
        const grossPaid = (await gross(epoch, a)) + (await gross(epoch, b));
        expect(grossPaid <= pools[i]).to.equal(true);
        expect(pools[i] - grossPaid < 4n).to.equal(true);
      }
      expect([funded, paid, rolling]).to.deep.equal([215n * TRAC, 215n * TRAC, 0n]);
    });

    it('over a seeded run, the money of the ended epochs is their pools and the run still rolling, at the end of every epoch', async () => {
      let seed = 0x2f6e2b1n;
      const rand = (n: bigint) => {
        seed = (seed * 6364136223846793005n + 1442695040888963407n) & ((1n << 64n) - 1n);
        return (seed >> 33n) % n;
      };
      const sellers = [
        await h.createSeller(STAKE_S_50, 0n),
        await h.createSeller(STAKE_S_90, 0n),
        await h.createSeller(500_000n * TRAC, 0n),
      ];
      const start = await h.epochNow();
      const subscriptionsOf = new Map<bigint, string[]>();
      let booked = 0n;
      let buyerIndex = 100;
      let batches = 0;
      let rolled = 0;
      let paidOut = 0;

      for (let epoch = start; epoch < start + 8n; epoch++) {
        // Fundings for this epoch and the next, and top-ups of this epoch's.
        for (const target of [epoch, epoch + 1n]) {
          const fundings = Number(rand(3n));
          for (let i = 0; i < fundings; i++) {
            const value = (1n + rand(40n)) * TRAC + rand(1_000n) * UNIT_PRICE;
            const p = await h.walletFund(f.accounts[buyerIndex++], target, value);
            booked += value;
            subscriptionsOf.set(target, [...(subscriptionsOf.get(target) ?? []), p]);
          }
        }
        for (const p of subscriptionsOf.get(epoch) ?? []) {
          if (rand(3n) !== 0n) continue;
          const who = (await f.SSS.getSubscription(p)).buyer;
          const value = (1n + rand(5n)) * TRAC;
          await topUp(f.accounts.find((a: SignerWithAddress) => a.address === who)!, p, value);
          booked += value;
        }
        // Batches on this epoch's subscriptions, some above what is left, and in some epochs none.
        if (rand(4n) !== 0n) {
          for (const p of subscriptionsOf.get(epoch) ?? []) {
            for (const s of sellers) {
              if (rand(2n) === 0n || (await f.QS.budgetLeft(p, 0n)) === 0n) continue;
              await land(s, p, (1n + rand(30n)) * TRAC);
              batches++;
            }
          }
        }
        await h.toEpoch(epoch + 1n);

        let funded = 0n;
        let pools = 0n;
        let rolling = 0n;
        for (let e = start; e <= epoch; e++) {
          const m = await money(e);
          const pool = await f.QS.epochPool(e);
          funded += m;
          pools += pool;
          rolling = (await f.QIS.getEpochTotals(e)).totalServed === 0n ? rolling + m : 0n;

          let grossPaid = 0n;
          for (const s of sellers) grossPaid += await gross(e, s);
          expect(grossPaid <= pool, `epoch ${e}`).to.equal(true);
          expect(pool - grossPaid < 6n, `epoch ${e}`).to.equal(true);
        }
        expect(funded, `epoch ${epoch}`).to.equal(pools + rolling);
        expect(funded <= booked).to.equal(true);
        if (rolling > 0n) rolled++;
        if ((await f.QS.epochPool(epoch)) > 0n) paidOut++;
      }
      // The run covers batches, epochs that paid out and epochs that rolled over.
      expect([batches > 10, rolled > 0, paidOut > 1]).to.deep.equal([true, true, true]);
    });
  });

  // -------------------------------------------------------------------------
  // The activation epoch
  // -------------------------------------------------------------------------

  describe('the activation epoch', () => {
    it('the run stops at it: the money of the activation epoch rolls, and money booked before it reaches no pool', async () => {
      const s1 = await h.createSeller(STAKE_S_50, 0n);
      const e = await h.epochNow();
      // A replacement storage, into which a migration books the money of an
      // earlier epoch; the Hub owner passes onlyContracts.
      const fresh = await replaceStorage();
      await fresh.addWalletFunding(e, 7n * TRAC);
      await h.forward(fresh, 'setActivationEpoch', [e + 1n]);

      await h.toEpoch(e + 1n);
      await h.walletFund(buyer, e + 1n, 11n * TRAC); // no value, at the activation epoch
      await h.toEpoch(e + 2n);
      const p = await h.walletFund(buyer, e + 2n, 13n * TRAC);
      await land(s1, p, TRAC);
      await h.toEpoch(e + 3n);

      expect(await fresh.walletFunding(e)).to.equal(7n * TRAC);
      expect(await f.QS.epochPool(e + 2n)).to.equal(24n * TRAC);
      expect(await gross(e + 2n, s1)).to.equal(24n * TRAC);
      expect(await f.QS.epochPool(e)).to.equal(0n);
      expect(await f.QS.epochPool(e + 1n)).to.equal(0n);
    });

    it('an epoch with value at the activation epoch itself has a run of none', async () => {
      const s1 = await h.createSeller(STAKE_S_50, 0n);
      const e = await h.epochNow();
      expect(await f.QIS.activationEpoch()).to.equal(e);
      const p = await h.walletFund(buyer, e, 3n * TRAC);
      await land(s1, p, TRAC);
      expect(await f.QS.epochPool(e)).to.equal(3n * TRAC);
    });

    it('the pool reads 0 before the activation epoch and with activation unset', async () => {
      const s1 = await h.createSeller(STAKE_S_50, 0n);
      const e = await h.epochNow();
      const p = await h.walletFund(buyer, e, 4n * TRAC);
      await land(s1, p, TRAC);
      await h.toEpoch(e + 1n);
      expect(await f.QS.epochPool(e - 1n)).to.equal(0n);
      expect(await gross(e - 1n, s1)).to.equal(0n);
      expect(await gross(e, s1)).to.equal(4n * TRAC);

      await replaceStorage();
      expect(await f.QS.epochPool(e)).to.equal(0n);
      expect(await gross(e, s1)).to.equal(0n);
    });
  });

  // -------------------------------------------------------------------------
  // Money funded ahead
  // -------------------------------------------------------------------------

  describe('money funded ahead', () => {
    it('funded for the next epoch during this one, with its top-up, joins the next epoch only', async () => {
      const s1 = await h.createSeller(STAKE_S_50, 0n);
      const e = await h.epochNow();
      const now = await h.walletFund(buyer, e, 10n * TRAC);
      const ahead = await h.walletFund(buyer, e + 1n, 6n * TRAC);
      await topUp(buyer, ahead, 2n * TRAC);
      await accountSubscription(e + 1n, 100n * TRAC); // at a cost of 25
      expect(await funding(e)).to.deep.equal([10n * TRAC, 0n]);
      expect(await funding(e + 1n)).to.deep.equal([8n * TRAC, 25n * TRAC]);

      await land(s1, now, TRAC);
      expect(await f.QS.epochPool(e)).to.equal(10n * TRAC);

      await h.toEpoch(e + 1n);
      expect(await f.QS.epochPool(e)).to.equal(10n * TRAC);
      expect(await f.QS.epochPool(e + 1n)).to.equal(0n); // no value yet
      await land(s1, ahead, TRAC);
      expect(await f.QS.epochPool(e + 1n)).to.equal(33n * TRAC);

      await h.toEpoch(e + 2n);
      expect(await gross(e, s1)).to.equal(10n * TRAC);
      expect(await gross(e + 1n, s1)).to.equal(33n * TRAC);
    });

    it('funded ahead with no value in this epoch, it joins the same pool as the money that rolls from here, once each', async () => {
      const s1 = await h.createSeller(STAKE_S_50, 0n);
      const e = await h.epochNow();
      await h.walletFund(buyer, e, 10n * TRAC);
      const ahead = await h.walletFund(buyer, e + 1n, 6n * TRAC);
      await h.toEpoch(e + 1n);
      await land(s1, ahead, TRAC);
      await h.toEpoch(e + 2n);
      expect(await f.QS.epochPool(e)).to.equal(0n);
      expect(await f.QS.epochPool(e + 1n)).to.equal(16n * TRAC);
    });
  });

  // -------------------------------------------------------------------------
  // Nothing changes after the epoch's end
  // -------------------------------------------------------------------------

  describe("nothing changes after the epoch's end", () => {
    it('the pool and the gross read the same at the first second of the next epoch, later, after later funding and value, and whatever λ does', async () => {
      const a = await h.createSeller(STAKE_S_50, 0n);
      const b = await h.createSeller(STAKE_S_90, 0n);
      const first = await h.epochNow();
      await h.walletFund(buyer, first, 4n * TRAC); // rolls into e
      const e = first + 1n;
      await h.toEpoch(e);
      const p = await h.walletFund(buyer, e, 10n * TRAC);
      await land(a, p, 4n * TRAC);
      await land(b, p, 2n * TRAC);

      const read = async () => [await f.QS.epochPool(e), await gross(e, a), await gross(e, b)];
      // A pool of 14 at the deploy's λ of 0.5: R 4 and 2, scores 2 and 1.8.
      expect(await f.QIS.lambdaBps()).to.equal(5_000n);
      const totalWeighted = (38n * TRAC) / 10n;
      const final = [
        14n * TRAC,
        formula(14n * TRAC, 5_000n, 4n * TRAC, 6n * TRAC, 2n * TRAC, totalWeighted),
        formula(14n * TRAC, 5_000n, 2n * TRAC, 6n * TRAC, (18n * TRAC) / 10n, totalWeighted),
      ];
      expect(await read()).to.deep.equal(final);

      await h.toEpoch(e + 1n);
      expect(await h.latest()).to.equal(await epochStart(e + 1n));
      expect(await read()).to.deep.equal(final);

      // The next epoch's money and value, and money funded further ahead.
      const later = await h.walletFund(buyer, e + 1n, 6n * TRAC);
      await land(a, later, TRAC);
      await h.walletFund(buyer, e + 2n, 5n * TRAC);
      await topUp(buyer, later, TRAC);
      expect(await read()).to.deep.equal(final);

      await setLambda(10_000n);
      await h.toEpoch(e + 3n);
      await setLambda(0n);
      expect(await read()).to.deep.equal(final);
      expect((await f.QIS.getEpochTotals(e)).lambdaBps).to.equal(5_000n);
      // The later epochs have their own pools.
      expect(await f.QS.epochPool(e + 1n)).to.equal(7n * TRAC);
      expect(await f.QS.epochPool(e + 2n)).to.equal(0n);
    });

    it('a claim in the first second of the next epoch pays the epoch through StakingV10, and compounds into the position', async () => {
      const e = await h.epochNow();
      const n1 = await h.createSeller(STAKE_S_50, 1_000n); // 10% fee
      const d1 = f.accounts[10];
      const t1 = await h.delegate(d1, n1.identityId, 250_000n * TRAC);
      // 100 TRAC of money, 30 counted, and a publishing pool of 40.
      await h.valueIn(e, [[n1, 30n * TRAC, 100n * TRAC]], 40n * TRAC);
      const score = await h.positionScore(t1, n1, e);
      const scoreOperator = await h.positionScore(n1.tokenId, n1, e);
      const rawOperator = (await f.Vault.getPosition(n1.tokenId)).raw;

      const boundary = await epochStart(e + 1n);
      await time.setNextBlockTimestamp(boundary);
      const paid = await h.claim(d1, t1);
      expect(await h.latest()).to.equal(boundary);

      const s = await h.split(n1, e);
      expect([s.queryInference, s.publishing, s.gross, s.fee, s.net]).to.deep.equal([
        100n * TRAC,
        40n * TRAC,
        140n * TRAC,
        14n * TRAC,
        126n * TRAC,
      ]);
      // A sixth of the node's score, and of its net.
      expect(paid).to.equal((score * s.net) / s.nodeScore);
      expect(paid).to.be.closeTo(21n * TRAC, 10n ** 9n);
      const position = await f.Vault.getPosition(t1);
      expect(position.raw).to.equal(250_000n * TRAC + paid);
      expect(position.lastClaimedEpoch).to.equal(e);
      expect(await f.Vault.getNetNodeEpochRewards(n1.identityId, e)).to.equal(s.net);
      expect(await f.Vault.getOperatorFeeBalance(n1.identityId)).to.equal(s.fee);

      // The claim has nothing more to pay, and the node's other position takes its share at its own claim.
      expect(await h.claim(d1, t1)).to.equal(0n);
      const paidOperator = await h.claim(n1.operational, n1.tokenId);
      expect(paidOperator).to.equal((scoreOperator * s.net) / s.nodeScore);
      expect((await f.Vault.getPosition(n1.tokenId)).raw).to.equal(rawOperator + paidOperator);
      expect(await f.Vault.getOperatorFeeBalance(n1.identityId)).to.equal(s.fee);
    });

    it("claims before and after two changes of λ pay at the epoch's λ, so an epoch's nodes are paid at most its pool", async () => {
      const cap = await f.Params.maximumStake();
      const a = await h.createSeller(cap, 0n); // S = 1
      const b = await h.createSeller(cap / 100n, 0n); // S = 0.1
      const slack = async () => (await h.balanceOf(await h.vault())) - (await h.owed([a, b]));
      const before = await slack();
      const e = await h.epochNow();
      expect(await f.QIS.lambdaBps()).to.equal(5_000n);
      const pool = 1_000n * TRAC;
      const p = await h.walletFund(buyer, e, pool);
      await land(a, p, 200n * TRAC);
      await land(b, p, 800n * TRAC);
      // R 200 and 800, scores 200 and 80; each node's only position takes its gross.
      const expected = [100n * TRAC + (500n * TRAC * 200n) / 280n, 400n * TRAC + (500n * TRAC * 80n) / 280n];

      await h.toEpoch(e + 1n);
      expect(await h.claim(b.operational, b.tokenId)).to.equal(expected[1]);
      await setLambda(0n);
      await h.toEpoch(e + 2n);
      await setLambda(10_000n);
      expect(await gross(e, a)).to.equal(expected[0]);
      expect(await h.claim(a.operational, a.tokenId)).to.equal(expected[0]);
      expect(await gross(e, b)).to.equal(expected[1]);

      const paid = expected[0] + expected[1];
      expect(paid <= pool).to.equal(true);
      expect(pool - paid < 4n).to.equal(true);
      expect((await slack()) - before).to.equal(pool - paid);
    });

    it('reads and claims go on while paused', async () => {
      const s1 = await h.createSeller(STAKE_S_50, 0n);
      const e = await h.epochNow();
      const p = await h.walletFund(buyer, e, 3n * TRAC);
      await land(s1, p, TRAC);
      await h.forward(f.QIS, 'setPaused', [true]);
      await h.toEpoch(e + 1n);
      expect(await f.QS.epochPool(e)).to.equal(3n * TRAC);
      expect(await gross(e, s1)).to.equal(3n * TRAC);
      expect(await h.claim(s1.operational, s1.tokenId)).to.equal(3n * TRAC);
    });
  });

  // -------------------------------------------------------------------------
  // An ended epoch takes no booking
  // -------------------------------------------------------------------------

  describe('an ended epoch takes no booking', () => {
    it("through the funding paths: from the subscription's end, a top-up is refused, wallet or Conviction Account, and so is a new subscription of the past epoch", async () => {
      const s1 = await h.createSeller(STAKE_S_50, 0n);
      const e = await h.epochNow();
      const wallet = await h.walletFund(buyer, e, 10n * TRAC);
      const { accountId, p: account } = await accountSubscription(e, 100n * TRAC); // at a cost of 25
      await land(s1, wallet, TRAC);
      const { endsAt } = await f.SSS.getSubscription(wallet);
      expect(endsAt).to.equal(await epochStart(e + 1n));
      const addition = [budget(0, CLASS_INFERENCE, TRAC, UNIT_PRICE)];
      await f.Token.mint(buyer.address, TRAC);
      await f.Token.connect(buyer).approve(await f.SSW.getAddress(), TRAC);

      await time.setNextBlockTimestamp(endsAt);
      await expect(f.SSW.connect(buyer).topUpFromWallet(wallet, addition, hre.ethers.ZeroHash))
        .to.be.revertedWithCustomError(f.SSW, 'SubscriptionEnded')
        .withArgs(wallet, endsAt);
      expect(await h.latest()).to.equal(endsAt);
      await expect(f.SS.connect(accountBuyer).topUpFromAccount(account, addition, hre.ethers.ZeroHash))
        .to.be.revertedWithCustomError(f.SS, 'SubscriptionEnded')
        .withArgs(account, endsAt);

      await f.Token.mint(buyer2.address, TRAC);
      await f.Token.connect(buyer2).approve(await f.SSW.getAddress(), TRAC);
      await expect(f.SSW.connect(buyer2).fundFromWallet(walletRequestOf(e, { budgets: addition, sessionKey: key.address })))
        .to.be.revertedWithCustomError(f.SSW, 'InvalidFundingRequest')
        .withArgs('epoch');
      await expect(f.SS.connect(accountBuyer).fundFromAccount(requestOf(accountId, e, { budgets: addition, sessionKey: key.address })))
        .to.be.revertedWithCustomError(f.SS, 'InvalidFundingRequest')
        .withArgs('epoch');

      expect(await funding(e)).to.deep.equal([10n * TRAC, 25n * TRAC]);
      expect(await f.QS.epochPool(e)).to.equal(35n * TRAC);
      expect(await gross(e, s1)).to.equal(35n * TRAC);
    });

    it("directly: the storage refuses every write to an ended epoch's money and QIF inputs, and takes them for the current epoch and later", async () => {
      const s1 = await h.createSeller(STAKE_S_50, 0n);
      const e = await h.epochNow();
      const p = await h.walletFund(buyer, e, 4n * TRAC);
      await land(s1, p, TRAC);
      await h.toEpoch(e + 1n);
      const before = [await f.QS.epochPool(e), await gross(e, s1)];
      const totals = { totalServed: 1n, totalWeighted: 1n, lambdaBps: 0n };
      const node = { servedValue: 1n, weightedValue: 1n };

      // The Hub owner passes onlyContracts.
      for (const write of [
        () => f.QIS.addWalletFunding(e, 1n),
        () => f.QIS.addAccountFunding(e, 1n),
        () => f.QIS.countReceipts(p, 0n, s1.identityId, e, 1n, 1n, 1n),
        () => f.QIS.setNodeEpoch(s1.identityId, e, node),
        () => f.QIS.setEpochTotals(e, totals),
      ]) {
        await expect(write()).to.be.revertedWithCustomError(f.QIS, 'EpochEnded').withArgs(e, e + 1n);
      }
      expect([await f.QS.epochPool(e), await gross(e, s1)]).to.deep.equal(before);

      await f.QIS.addWalletFunding(e + 1n, 1n);
      await f.QIS.addAccountFunding(e + 2n, 1n);
      expect(await money(e + 1n)).to.equal(1n);
      expect(await money(e + 2n)).to.equal(1n);
    });
  });

  // -------------------------------------------------------------------------
  // The epoch in progress
  // -------------------------------------------------------------------------

  describe('the epoch in progress', () => {
    it('reads as if it ended now: no value reads 0, and money and value move it until the end, which it then keeps', async () => {
      const a = await h.createSeller(STAKE_S_50, 0n);
      const b = await h.createSeller(STAKE_S_90, 0n);
      const e = await h.epochNow();
      expect(await f.QIS.lambdaBps()).to.equal(5_000n);
      const p = await h.walletFund(buyer, e, 10n * TRAC);
      expect(await f.QS.epochPool(e)).to.equal(0n);
      expect(await gross(e, a)).to.equal(0n);

      await land(a, p, 2n * TRAC);
      expect(await f.QS.epochPool(e)).to.equal(10n * TRAC);
      expect(await gross(e, a)).to.equal(10n * TRAC);

      await accountSubscription(e, 24n * TRAC); // at a cost of 6
      expect(await funding(e)).to.deep.equal([10n * TRAC, 6n * TRAC]);
      expect(await gross(e, a)).to.equal(16n * TRAC);
      await topUp(buyer, p, 4n * TRAC);
      expect(await f.QS.epochPool(e)).to.equal(20n * TRAC);
      expect(await gross(e, a)).to.equal(20n * TRAC);

      // R 2 and 6, scores 1 and 5.4, a pool of 20 at λ 0.5: 2.5 + 1.5625, and 7.5 + 8.4375.
      await land(b, p, 6n * TRAC);
      const last = [(40_625n * TRAC) / 10_000n, (159_375n * TRAC) / 10_000n];
      expect([await gross(e, a), await gross(e, b)]).to.deep.equal(last);
      expect(last[0] + last[1]).to.equal(20n * TRAC);

      await h.toEpoch(e + 1n);
      expect(await f.QS.epochPool(e)).to.equal(20n * TRAC);
      expect([await gross(e, a), await gross(e, b)]).to.deep.equal(last);
    });

    it('reads the run behind it, and an epoch still ahead reads 0 whatever is funded for it', async () => {
      const s1 = await h.createSeller(STAKE_S_50, 0n);
      const e = await h.epochNow();
      await h.walletFund(buyer, e, 7n * TRAC);
      await h.toEpoch(e + 1n);
      const p = await h.walletFund(buyer, e + 1n, 3n * TRAC);
      await h.walletFund(buyer, e + 2n, 9n * TRAC);
      expect(await f.QS.epochPool(e + 1n)).to.equal(0n);

      await land(s1, p, TRAC);
      expect(await f.QS.epochPool(e + 1n)).to.equal(10n * TRAC);
      expect(await gross(e + 1n, s1)).to.equal(10n * TRAC);
      expect(await f.QS.epochPool(e + 2n)).to.equal(0n);
      expect(await gross(e + 2n, s1)).to.equal(0n);
    });
  });

  // -------------------------------------------------------------------------
  // queryInferenceGross
  // -------------------------------------------------------------------------

  describe('queryInferenceGross', () => {
    it("a 20 % share of a 5,000 TRAC pool is 1,000 TRAC at λ 0, as in OT-RFC-27's example, and the blend at 0.5 and 1, at unequal stake factors", async () => {
      // A: R 200 at S 0.9 (QIS 180); B: R 800 at S 0.65 (QIS 520). ΣR 1,000, ΣQIS 700.
      const a = await h.createSeller(STAKE_S_90, 0n);
      const b = await h.createSeller(STAKE_S_65, 0n);
      expect(await f.QS.stakeFactor(a.identityId)).to.equal((9n * SCALE18) / 10n);
      expect(await f.QS.stakeFactor(b.identityId)).to.equal((65n * SCALE18) / 100n);
      const e = await h.epochNow();
      const pool = 5_000n * TRAC;
      const snapshot = await takeSnapshot();
      const results: Record<string, bigint[]> = {};
      for (const lambda of [0n, 5_000n, 10_000n]) {
        await snapshot.restore();
        await setLambda(lambda);
        const p = await h.walletFund(buyer, e, pool);
        await land(a, p, 200n * TRAC);
        await land(b, p, 800n * TRAC);
        await h.toEpoch(e + 1n);

        const t = await f.QIS.getEpochTotals(e);
        expect([t.totalServed, t.totalWeighted, t.lambdaBps]).to.deep.equal([1_000n * TRAC, 700n * TRAC, lambda]);
        expect(await f.QS.epochPool(e)).to.equal(pool);
        const result = [await gross(e, a), await gross(e, b)];
        expect(result[0]).to.equal(formula(pool, lambda, 200n * TRAC, 1_000n * TRAC, 180n * TRAC, 700n * TRAC));
        expect(result[1]).to.equal(formula(pool, lambda, 800n * TRAC, 1_000n * TRAC, 520n * TRAC, 700n * TRAC));
        expect(result[0] + result[1] <= pool).to.equal(true);
        expect(pool - result[0] - result[1] <= 4n).to.equal(true);
        results[String(lambda)] = result;
      }
      expect(results['0']).to.deep.equal([1_000n * TRAC, 4_000n * TRAC]);
      // 0.5 × 5,000 × 0.2 + 0.5 × 5,000 × 180 / 700
      expect(results['5000'][0]).to.equal(500n * TRAC + (2_500n * TRAC * 180n) / 700n);
      expect(results['10000'][0]).to.equal((5_000n * TRAC * 180n) / 700n);
    });

    it('at equal stake factors both terms give the same share: 1,000 and 4,000 of 5,000 at λ 0, 0.5 and 1', async () => {
      const a = await h.createSeller(STAKE_S_50, 0n);
      const b = await h.createSeller(STAKE_S_50, 0n);
      const e = await h.epochNow();
      const snapshot = await takeSnapshot();
      for (const lambda of [0n, 5_000n, 10_000n]) {
        await snapshot.restore();
        await setLambda(lambda);
        const p = await h.walletFund(buyer, e, 5_000n * TRAC);
        await land(a, p, 200n * TRAC);
        await land(b, p, 800n * TRAC);
        await h.toEpoch(e + 1n);
        const t = await f.QIS.getEpochTotals(e);
        expect([t.totalServed, t.totalWeighted]).to.deep.equal([1_000n * TRAC, 500n * TRAC]);
        expect([await gross(e, a), await gross(e, b)], `λ ${lambda}`).to.deep.equal([1_000n * TRAC, 4_000n * TRAC]);
      }
    });

    it('sums over the nodes to the pool less under 2 wei per node, at every λ', async () => {
      // Five nodes at five stake factors, receipts that divide no total evenly,
      // and a pool that is no round number of wei.
      const stakes = [4_050_000n, 2_112_500n, 1_250_000n, 500_000n, 123_457n].map((s) => s * TRAC);
      const sellers: Seller[] = [];
      for (const stake of stakes) sellers.push(await h.createSeller(stake, 0n));
      const amounts = [13n, 17n, 19n, 23n, 29n].map((n) => n * 1_000n * UNIT_PRICE);
      const pool = 1_000n * TRAC + 7n;
      const e = await h.epochNow();
      const snapshot = await takeSnapshot();
      let dusty = 0;
      for (const lambda of [0n, 1n, 3_333n, 5_000n, 9_999n, 10_000n]) {
        await snapshot.restore();
        await setLambda(lambda);
        const p = await h.walletFund(buyer, e, pool);
        for (const [i, s] of sellers.entries()) await land(s, p, amounts[i]);
        await h.toEpoch(e + 1n);
        expect(await f.QS.epochPool(e)).to.equal(pool);

        const t = await f.QIS.getEpochTotals(e);
        let paid = 0n;
        for (const s of sellers) {
          const n = await f.QIS.getNodeEpoch(s.identityId, e);
          const grossPaid = await gross(e, s);
          expect(grossPaid).to.equal(formula(pool, lambda, n.servedValue, t.totalServed, n.weightedValue, t.totalWeighted));
          paid += grossPaid;
        }
        // Each node's two terms are floored apart, so each leaves under 1 wei,
        // and a λ of 0 or 1 has one term only.
        const dust = pool - paid;
        const perTerm = lambda === 0n || lambda === BPS ? 1n : 2n;
        expect(dust >= 0n && dust < perTerm * BigInt(sellers.length), `λ ${lambda}: ${dust} wei`).to.equal(true);
        if (dust > 0n) dusty++;
      }
      expect(dusty).to.be.greaterThan(0);
    });

    it('takes the R share for the stake-weighted term when ΣQIS is 0', async () => {
      const a = await h.createSeller(STAKE_S_50, 0n);
      const b = await h.createSeller(STAKE_S_50, 0n);
      for (const s of [a, b]) await f.RSS.setNodeChallengeStakeSnapshot(s.identityId, 0n);
      const e = await h.epochNow();
      await setLambda(5_000n);
      const p = await h.walletFund(buyer, e, 9n * TRAC);
      await land(a, p, TRAC);
      await land(b, p, 2n * TRAC);
      await h.toEpoch(e + 1n);
      const t = await f.QIS.getEpochTotals(e);
      expect([t.totalServed, t.totalWeighted]).to.deep.equal([3n * TRAC, 0n]);
      expect(await gross(e, a)).to.equal(3n * TRAC);
      expect(await gross(e, b)).to.equal(6n * TRAC);
    });

    it('a node with no value in the epoch reads 0, without walking the run behind it, where a node with value walks it', async () => {
      const seller = await h.createSeller(STAKE_S_50, 0n);
      const idle = await h.createSeller(STAKE_S_50, 0n);
      const e = await h.epochNow();
      await h.walletFund(buyer, e, TRAC);
      // An epoch with a run of 30 before it, and the one after it with none.
      const withRun = e + 30n;
      const withoutRun = withRun + 1n;
      for (const epoch of [withRun, withoutRun]) {
        await h.toEpoch(epoch);
        await land(seller, await h.walletFund(buyer, epoch, TRAC), TRAC);
      }
      await h.toEpoch(withoutRun + 1n);

      expect(await gross(withRun, seller)).to.equal(2n * TRAC);
      expect(await gross(withoutRun, seller)).to.equal(TRAC);
      expect(await gross(withRun, idle)).to.equal(0n);
      expect(await gross(withoutRun, idle)).to.equal(0n);

      const gasOf = async (epoch: bigint, s: Seller) => f.QS.queryInferenceGross.estimateGas(epoch, s.identityId);
      expect(await gasOf(withRun, idle)).to.be.closeTo(await gasOf(withoutRun, idle), 100n);
      expect((await gasOf(withRun, seller)) - (await gasOf(withoutRun, seller))).to.be.greaterThan(30n * 5_000n);
    });
  });
});
