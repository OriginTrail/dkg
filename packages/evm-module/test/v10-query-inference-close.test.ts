// The epoch close of the query/inference pool (OT-RFC-27), and the gross
// reward each node draws from it, end to end on the real account and staking
// stacks with wallet-funded periods, and Conviction Account cost booked as due
// beside them.
//
// Groups:
//   - frozen inputs: the pool, λ, ΣR and ΣQueryInferenceScore of a closed
//     epoch, which no later change moves;
//   - the epoch's money: what is due in it from wallets and from Conviction
//     Accounts, both reported by EpochClosed, plus the carry;
//   - rollover: epochs with no finalized value, empty ones included, carry
//     their whole money to the next epoch with finalized value;
//   - order: epochs close one at a time, after they end, at most maxSteps per
//     call; ensureClosed is bounded by maxCloseStepsPerClaim and reverts
//     QueryInferenceCloseBehind while behind, which closeEpochs clears;
//   - conservation over a seeded run of fundings, top-ups, batches,
//     finalizations and void claims: the money due in closed epochs equals
//     their pools plus the carry;
//   - queryInferenceGross: OT-RFC-27's formula at λ 0, 0.5 and 1, the R share
//     when ΣQueryInferenceScore is 0, and 0 for an open epoch, an empty pool
//     or a node with no value.

import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { loadFixture, takeSnapshot, time } from '@nomicfoundation/hardhat-network-helpers';
import { expect } from 'chai';
import { BaseContract, ContractTransactionReceipt, Result } from 'ethers';
import hre from 'hardhat';

import { QueryInferenceStorage } from '../typechain';
import { CLASS_INFERENCE, Domain, TRAC, bucket, subscriptionIdOf, walletRequestOf } from './helpers/conviction-service';
import {
  SCALE18,
  SettlementStack,
  createNode,
  deploySettlementStack,
  hardhatWallet,
  queryInferenceDomain,
  scoreNode,
  signedItems,
} from './helpers/query-inference';

const UNIT_ASK = 10n ** 15n;
const BPS = 10_000n;

type Seller = { identityId: bigint; operational: SignerWithAddress };

/** This suite's own fixture, so loadFixture keeps a snapshot for it alone. */
async function deployFixture(): Promise<SettlementStack> {
  return deploySettlementStack();
}

describe('@integration The epoch close of the query/inference pool', function () {
  let f: SettlementStack;
  let QIS: QueryInferenceStorage;
  let domain: Domain;
  let nextAccount: number;
  const key = hardhatWallet(60);

  beforeEach(async () => {
    hre.helpers.resetDeploymentsJson();
    f = await loadFixture(deployFixture);
    QIS = f.QIS;
    domain = await queryInferenceDomain(QIS);
    nextAccount = 40;
  });

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  const latest = async () => BigInt(await time.latest());
  const epochNow = async () => f.Chronos.getCurrentEpoch();
  const epochStart = async (e: bigint) => f.Chronos.timestampForEpoch(e);
  const toEpoch = async (e: bigint) => time.increaseTo(await epochStart(e));
  const forward = async (contract: BaseContract, fn: string, args: unknown[] = []) =>
    f.Hub.forwardCall(await contract.getAddress(), contract.interface.encodeFunctionData(fn, args));

  const seller = async (stake: bigint): Promise<Seller> => {
    const operational = f.accounts[nextAccount++];
    const admin = f.accounts[nextAccount++];
    return { identityId: await createNode({ ...f, operational, admin, stake }), operational };
  };

  /** A wallet period of `epoch` for buyer `who`, one bucket of `value`. */
  const walletFund = async (who: SignerWithAddress, epoch: bigint, value: bigint): Promise<string> => {
    await f.Token.mint(who.address, value);
    await f.Token.connect(who).approve(await f.SSW.getAddress(), value);
    await f.SSW.connect(who).fundFromWallet(
      walletRequestOf(epoch, { buckets: [bucket(0, CLASS_INFERENCE, value, UNIT_ASK)], sessionKey: key.address }),
    );
    return subscriptionIdOf(who.address, epoch);
  };

  const claim = async (by: Seller, subscriptionId: string, amount: bigint, firstNonce = 0n) => {
    const { items } = signedItems({
      domain,
      wallet: key,
      subscriptionId,
      bucketId: (await f.CSS.getBucket(subscriptionId, 0n)).bucketId,
      seller: by.identityId,
      firstNonce,
      count: 1,
      units: amount / UNIT_ASK,
      ask: UNIT_ASK,
      issuedAt: await latest(),
    });
    await f.QS.connect(by.operational).submitReceiptBatch([{ subscriptionId, bucketIndex: 0n, items }]);
  };

  /** Move into the finalization window of `epoch`'s periods, score `sellers` there, and finalize their claims on `periods`. */
  const finalizeIn = async (epoch: bigint, periods: string[], sellers: Seller[]) => {
    const deadline = (await epochStart(epoch + 1n)) + (await QIS.receiptGraceSecondsAt(epoch));
    if ((await latest()) <= deadline) await time.increaseTo(deadline + 1n);
    for (const s of sellers) await scoreNode(f.RSS, epoch + 1n, s.identityId);
    await f.QS.finalizeClaims(
      periods.flatMap((p) => sellers.map((s) => ({ subscriptionId: p, bucketIndex: 0n, seller: s.identityId }))),
    );
  };

  const closeAll = async () => (await (await f.QS.closeEpochs(255n)).wait())!;

  const eventsOf = (receipt: ContractTransactionReceipt, contract: BaseContract, name: string) => {
    const out: Result[] = [];
    for (const log of receipt.logs) {
      try {
        const parsed = contract.interface.parseLog({ topics: [...log.topics], data: log.data });
        if (parsed?.name === name) out.push(parsed.args);
      } catch {
        // another contract's log
      }
    }
    return out;
  };

  const closedEvents = (receipt: ContractTransactionReceipt) =>
    eventsOf(receipt, f.QS, 'EpochClosed').map((e) => [
      e.epoch,
      e.walletDue,
      e.convictionDue,
      e.carryIn,
      e.pool,
      e.sumR,
      e.sumScore,
      e.lambdaBps,
    ]);

  const record = async (e: bigint) => {
    const c = await QIS.getEpochClose(e);
    return [c.pool, c.lambdaBps, c.closed];
  };

  // -------------------------------------------------------------------------
  // Frozen inputs
  // -------------------------------------------------------------------------

  describe('frozen inputs', () => {
    it('freezes the pool, λ and the totals; later changes to λ, bookings and credits leave them', async () => {
      const s1 = await seller(1_250_000n * TRAC); // S = 0.5
      const s2 = await seller(4_050_000n * TRAC); // S = 0.9
      const e = await epochNow();
      expect(await QIS.activationEpoch()).to.equal(e);
      await forward(QIS, 'setLambdaBps', [5_000n]); // from e + 1
      const p = await walletFund(f.accounts[21], e, 10n * TRAC);
      await claim(s1, p, 4n * TRAC);
      await claim(s2, p, 2n * TRAC);
      await finalizeIn(e, [p], [s1, s2]);
      const score = 2n * TRAC + (18n * TRAC) / 10n;
      expect(await QIS.getEpochTotals(e + 1n)).to.deep.equal([6n * TRAC, score]);

      // Only ended epochs close: during e + 1, a close reaches e.
      expect(await f.QS.closeEpochs.staticCall(10n)).to.equal(e);
      await toEpoch(e + 2n);
      const receipt = await closeAll();
      expect(closedEvents(receipt)).to.deep.equal([
        [e, 0n, 0n, 0n, 0n, 0n, 0n, 0n],
        [e + 1n, 10n * TRAC, 0n, 0n, 10n * TRAC, 6n * TRAC, score, 5_000n],
      ]);
      expect(await record(e)).to.deep.equal([0n, 0n, true]);
      expect(await record(e + 1n)).to.deep.equal([10n * TRAC, 5_000n, true]);
      expect([await QIS.closedThrough(), await QIS.carry()]).to.deep.equal([e + 1n, 0n]);
      expect(await f.QS.epochPool(e + 1n)).to.equal(10n * TRAC);
      const gross = [await f.QS.queryInferenceGross(e + 1n, s1.identityId), await f.QS.queryInferenceGross(e + 1n, s2.identityId)];

      // λ moves for later epochs only; the closed epoch takes no booking and no credit.
      await forward(QIS, 'setLambdaBps', [10_000n]);
      expect(await record(e + 1n)).to.deep.equal([10n * TRAC, 5_000n, true]);
      await expect(QIS.addWalletDue(e + 1n, 1n)).to.be.revertedWithCustomError(QIS, 'EpochClosed');
      await expect(QIS.finalizeClaim(p, 0n, s1.identityId, e + 1n, 1n, 1n)).to.be.revertedWithCustomError(
        QIS,
        'EpochClosed',
      );
      expect(await QIS.getEpochTotals(e + 1n)).to.deep.equal([6n * TRAC, score]);
      expect([await f.QS.queryInferenceGross(e + 1n, s1.identityId), await f.QS.queryInferenceGross(e + 1n, s2.identityId)]).to.deep.equal(gross);
    });
  });

  // -------------------------------------------------------------------------
  // The epoch's money
  // -------------------------------------------------------------------------

  describe("the epoch's money", () => {
    it('Conviction Account cost due in an epoch joins its pool beside the wallet value, and both are reported', async () => {
      const s1 = await seller(1_250_000n * TRAC);
      const e = await epochNow();
      const p = await walletFund(f.accounts[21], e, 10n * TRAC);
      // Booked as ServiceSubscriptions books a period's cost; the Hub owner
      // passes onlyContracts.
      await QIS.addConvictionDue(e + 1n, 4n * TRAC);
      await QIS.addConvictionDue(e + 1n, 3n);
      await claim(s1, p, TRAC);
      await finalizeIn(e, [p], [s1]);
      await toEpoch(e + 2n);

      const receipt = await closeAll();
      expect(closedEvents(receipt).map(([epoch, wallet, conviction, carryIn, pool]) => [epoch, wallet, conviction, carryIn, pool])).to.deep.equal([
        [e, 0n, 0n, 0n, 0n],
        [e + 1n, 10n * TRAC, 4n * TRAC + 3n, 0n, 14n * TRAC + 3n],
      ]);
      expect(await f.QS.epochPool(e + 1n)).to.equal(14n * TRAC + 3n);
      expect(await f.QS.queryInferenceGross(e + 1n, s1.identityId)).to.equal(14n * TRAC + 3n);
    });

    it('Conviction Account cost alone rolls over like wallet value, and is paid with the next finalized value', async () => {
      const s1 = await seller(1_250_000n * TRAC);
      const e = await epochNow();
      await QIS.addConvictionDue(e + 1n, 6n * TRAC); // no value finalized in e + 1
      await toEpoch(e + 1n);
      const p = await walletFund(f.accounts[21], e + 1n, 2n * TRAC);
      await QIS.addConvictionDue(e + 2n, TRAC);
      await claim(s1, p, TRAC);
      await finalizeIn(e + 1n, [p], [s1]);
      await toEpoch(e + 3n);

      const receipt = await closeAll();
      expect(closedEvents(receipt).map(([epoch, wallet, conviction, carryIn, pool]) => [epoch, wallet, conviction, carryIn, pool])).to.deep.equal([
        [e, 0n, 0n, 0n, 0n],
        [e + 1n, 0n, 6n * TRAC, 0n, 0n],
        [e + 2n, 2n * TRAC, TRAC, 6n * TRAC, 9n * TRAC],
      ]);
      expect(await QIS.carry()).to.equal(0n);
      expect(await f.QS.queryInferenceGross(e + 2n, s1.identityId)).to.equal(9n * TRAC);
    });
  });

  // -------------------------------------------------------------------------
  // Rollover
  // -------------------------------------------------------------------------

  describe('rollover', () => {
    it('epochs with no finalized value, empty ones included, carry their money to the next epoch that has some', async () => {
      const s1 = await seller(1_250_000n * TRAC);
      const e = await epochNow();
      await walletFund(f.accounts[21], e, 10n * TRAC); // due e + 1, never claimed
      await toEpoch(e + 1n);
      const p1 = await walletFund(f.accounts[21], e + 1n, 20n * TRAC); // due e + 2
      await claim(s1, p1, TRAC); // claimed, but left void
      // No period of e + 2: nothing is due in e + 3.
      await toEpoch(e + 3n);
      const p3 = await walletFund(f.accounts[21], e + 3n, 5n * TRAC); // due e + 4
      await claim(s1, p3, TRAC);
      await finalizeIn(e + 3n, [p3], [s1]);
      await toEpoch(e + 5n);

      const receipt = await closeAll();
      expect(closedEvents(receipt).map(([epoch, due, , carryIn, pool]) => [epoch, due, carryIn, pool])).to.deep.equal([
        [e, 0n, 0n, 0n],
        [e + 1n, 10n * TRAC, 0n, 0n],
        [e + 2n, 20n * TRAC, 10n * TRAC, 0n],
        [e + 3n, 0n, 30n * TRAC, 0n],
        [e + 4n, 5n * TRAC, 30n * TRAC, 35n * TRAC],
      ]);
      for (const epoch of [e, e + 1n, e + 2n, e + 3n]) expect(await f.QS.epochPool(epoch)).to.equal(0n);
      expect(await f.QS.epochPool(e + 4n)).to.equal(35n * TRAC);
      expect(await QIS.carry()).to.equal(0n);
      // The only node with value takes the whole pool, carry included.
      expect(await f.QS.queryInferenceGross(e + 4n, s1.identityId)).to.equal(35n * TRAC);
    });

    it('a carry waits in closed epochs until value is finalized again', async () => {
      const e = await epochNow();
      await walletFund(f.accounts[21], e, 7n * TRAC);
      await toEpoch(e + 4n);
      await closeAll();
      expect([await QIS.closedThrough(), await QIS.carry()]).to.deep.equal([e + 3n, 7n * TRAC]);
    });
  });

  // -------------------------------------------------------------------------
  // Order and bounds
  // -------------------------------------------------------------------------

  describe('order and bounds', () => {
    it('epochs close in order, one per step, only once they have ended', async () => {
      const e = await epochNow();
      expect(await QIS.closedThrough()).to.equal(e - 1n);
      let receipt = await closeAll();
      expect(closedEvents(receipt)).to.have.length(0);

      await toEpoch(e + 3n);
      receipt = (await (await f.QS.closeEpochs(0n)).wait())!;
      expect(closedEvents(receipt)).to.have.length(0);
      for (const expected of [e, e + 1n]) {
        expect(await f.QS.closeEpochs.staticCall(1n)).to.equal(expected);
        receipt = (await (await f.QS.closeEpochs(1n)).wait())!;
        expect(closedEvents(receipt).map(([epoch]) => epoch)).to.deep.equal([expected]);
      }
      receipt = await closeAll();
      expect(closedEvents(receipt).map(([epoch]) => epoch)).to.deep.equal([e + 2n]);
      // The current epoch has not ended.
      receipt = await closeAll();
      expect(closedEvents(receipt)).to.have.length(0);
      expect(await QIS.closedThrough()).to.equal(e + 2n);
      expect((await QIS.getEpochClose(e + 3n)).closed).to.equal(false);
    });

    it('ensureClosed closes up to its epoch within maxCloseStepsPerClaim, reverts while behind, and closeEpochs clears it', async () => {
      await forward(QIS, 'setMaxCloseStepsPerClaim', [2n]);
      const e = await epochNow();
      await toEpoch(e + 5n);

      await expect(f.QS.ensureClosed(e + 4n))
        .to.be.revertedWithCustomError(f.QS, 'QueryInferenceCloseBehind')
        .withArgs(e + 1n, e + 4n);
      expect(await QIS.closedThrough()).to.equal(e - 1n);

      // Within the bound, it closes only what it needs.
      expect(await f.QS.ensureClosed.staticCall(e + 1n)).to.equal(e + 1n);
      await f.QS.ensureClosed(e + 1n);
      expect(await QIS.closedThrough()).to.equal(e + 1n);
      await f.QS.ensureClosed(e); // already closed: nothing to do

      await f.QS.closeEpochs(10n);
      expect(await QIS.closedThrough()).to.equal(e + 4n);
      await f.QS.ensureClosed(e + 4n);

      // An epoch that has not ended cannot be closed.
      await expect(f.QS.ensureClosed(e + 5n))
        .to.be.revertedWithCustomError(f.QS, 'QueryInferenceCloseBehind')
        .withArgs(e + 4n, e + 5n);
      // An epoch before activation never closes, and needs no close.
      expect(await f.QS.ensureClosed.staticCall(e - 1n)).to.equal(e + 4n);
      expect(await f.QS.ensureClosed.staticCall(0n)).to.equal(e + 4n);
    });

    it('with activation unset, nothing closes and ensureClosed returns at once', async () => {
      const fresh = (await (
        await hre.ethers.getContractFactory('QueryInferenceStorage')
      ).deploy(await f.Hub.getAddress())) as unknown as QueryInferenceStorage;
      await fresh.waitForDeployment();
      await f.Hub.setContractAddress('QueryInferenceStorage', await fresh.getAddress());
      await forward(fresh, 'initialize');
      await forward(f.QS, 'initialize');
      await toEpoch((await epochNow()) + 3n);
      expect(await f.QS.closeEpochs.staticCall(10n)).to.equal(0n);
      expect(await f.QS.ensureClosed.staticCall(2n)).to.equal(0n);
      const receipt = await closeAll();
      expect(closedEvents(receipt)).to.have.length(0);
    });

    it('closes run while paused, so rewards are never stranded', async () => {
      const e = await epochNow();
      await walletFund(f.accounts[21], e, 3n * TRAC);
      await forward(QIS, 'setPaused', [true]);
      await toEpoch(e + 3n);
      await closeAll();
      expect([await QIS.closedThrough(), await QIS.carry()]).to.deep.equal([e + 2n, 3n * TRAC]);
    });
  });

  // -------------------------------------------------------------------------
  // Conservation
  // -------------------------------------------------------------------------

  describe('conservation', () => {
    it('over a seeded run, the money due in closed epochs equals their pools plus the carry, at every close', async () => {
      let seed = 0x2f6e2b1n;
      const rand = (n: bigint) => {
        seed = (seed * 6364136223846793005n + 1442695040888963407n) & ((1n << 64n) - 1n);
        return (seed >> 33n) % n;
      };
      const sellers = [await seller(1_250_000n * TRAC), await seller(4_050_000n * TRAC), await seller(500_000n * TRAC)];
      const start = await epochNow();
      const periodsOf = new Map<bigint, string[]>();
      let paid = 0n;
      let buyerIndex = 100;
      let claims = 0;
      let carried = 0;
      let paidOut = 0;

      for (let epoch = start; epoch < start + 8n; epoch++) {
        // Fundings for this epoch and the next, and top-ups of this epoch's.
        for (const target of [epoch, epoch + 1n]) {
          const fundings = Number(rand(3n));
          for (let i = 0; i < fundings; i++) {
            const value = (1n + rand(40n)) * TRAC + rand(1_000n) * UNIT_ASK;
            const p = await walletFund(f.accounts[buyerIndex++], target, value);
            paid += value;
            periodsOf.set(target, [...(periodsOf.get(target) ?? []), p]);
          }
        }
        for (const p of periodsOf.get(epoch) ?? []) {
          if (rand(3n) !== 0n) continue;
          const buyer = (await f.CSS.getSubscription(p)).assignee;
          const value = (1n + rand(5n)) * TRAC;
          const who = f.accounts.find((a) => a.address === buyer)!;
          await f.Token.mint(who.address, value);
          await f.Token.connect(who).approve(await f.SSW.getAddress(), value);
          await f.SSW.connect(who).topUpFromWallet(p, [bucket(0, CLASS_INFERENCE, value, UNIT_ASK)], hre.ethers.ZeroHash);
          paid += value;
        }
        // Claims on this epoch's periods, some above their funded value.
        for (const p of periodsOf.get(epoch) ?? []) {
          for (const [i, s] of sellers.entries()) {
            if (rand(2n) === 0n) continue;
            await claim(s, p, (1n + rand(30n)) * TRAC, BigInt(i) * 1_000n);
            claims++;
          }
        }
        // Into the next epoch: finalize most of this epoch's claims, leave the rest void.
        if (rand(4n) !== 0n) {
          const periods = periodsOf.get(epoch) ?? [];
          const scored = sellers.filter(() => rand(4n) !== 0n);
          await finalizeIn(epoch, periods, scored);
        } else {
          await toEpoch(epoch + 1n);
        }

        await closeAll();
        const closed = await QIS.closedThrough();
        let due = 0n;
        let pools = 0n;
        for (let e = start; e <= closed; e++) {
          const [wallet, conviction] = await QIS.dueIn(e);
          due += wallet + conviction;
          pools += await f.QS.epochPool(e);
        }
        expect(due, `epoch ${closed}`).to.equal(pools + (await QIS.carry()));
        expect(due <= paid).to.equal(true);
        if ((await QIS.carry()) > 0n) carried++;
        if ((await f.QS.epochPool(closed)) > 0n) paidOut++;
      }
      // The run covers claims, epochs that paid out and epochs that rolled over.
      expect([claims > 10, carried > 0, paidOut > 1]).to.deep.equal([true, true, true]);
    });
  });

  // -------------------------------------------------------------------------
  // queryInferenceGross
  // -------------------------------------------------------------------------

  describe('queryInferenceGross', () => {
    /** OT-RFC-27's formula, floored per term as the contract floors it. */
    const formula = (pool: bigint, lambda: bigint, r: bigint, sumR: bigint, qis: bigint, sumQis: bigint) =>
      (pool * (BPS - lambda) * r) / (BPS * sumR) +
      (sumQis === 0n ? (pool * lambda * r) / (BPS * sumR) : (pool * lambda * qis) / (BPS * sumQis));

    it("a 20 % share of a 5,000 TRAC pool is 1,000 TRAC at λ 0, as in OT-RFC-27's example, and the blend at 0.5 and 1", async () => {
      // A: R 200 at S 0.9 (QIS 180); B: R 800 at S 0.65 (QIS 520). ΣR 1,000, ΣQIS 700.
      const a = await seller(4_050_000n * TRAC);
      const b = await seller(2_112_500n * TRAC);
      expect(await f.QS.stakeFactor(b.identityId)).to.equal((65n * SCALE18) / 100n);
      const e = await epochNow();
      const snapshot = await takeSnapshot();
      const results: Record<string, bigint[]> = {};
      for (const lambda of [0n, 5_000n, 10_000n]) {
        await snapshot.restore();
        await forward(QIS, 'setLambdaBps', [lambda]);
        const p = await walletFund(f.accounts[21], e, 5_000n * TRAC);
        await claim(a, p, 200n * TRAC);
        await claim(b, p, 800n * TRAC);
        await finalizeIn(e, [p], [a, b]);
        expect(await f.QS.queryInferenceGross(e + 1n, a.identityId)).to.equal(0n); // still open
        await toEpoch(e + 2n);
        await closeAll();
        expect(await QIS.getEpochTotals(e + 1n)).to.deep.equal([1_000n * TRAC, 700n * TRAC]);
        const gross = [
          await f.QS.queryInferenceGross(e + 1n, a.identityId),
          await f.QS.queryInferenceGross(e + 1n, b.identityId),
        ];
        expect(gross[0]).to.equal(formula(5_000n * TRAC, lambda, 200n * TRAC, 1_000n * TRAC, 180n * TRAC, 700n * TRAC));
        expect(gross[1]).to.equal(formula(5_000n * TRAC, lambda, 800n * TRAC, 1_000n * TRAC, 520n * TRAC, 700n * TRAC));
        expect(gross[0] + gross[1] <= 5_000n * TRAC).to.equal(true);
        expect(5_000n * TRAC - gross[0] - gross[1] <= 4n).to.equal(true);
        results[String(lambda)] = gross;
      }
      expect(results['0']).to.deep.equal([1_000n * TRAC, 4_000n * TRAC]);
      // 0.5 × 5,000 × 0.2 + 0.5 × 5,000 × 180 / 700
      expect(results['5000'][0]).to.equal(500n * TRAC + (2_500n * TRAC * 180n) / 700n);
      expect(results['10000'][0]).to.equal((5_000n * TRAC * 180n) / 700n);
    });

    it('takes the R share for the stake-weighted term when ΣQIS is 0', async () => {
      const a = await seller(1_250_000n * TRAC);
      const b = await seller(1_250_000n * TRAC);
      for (const s of [a, b]) await f.RSS.setNodeChallengeStakeSnapshot(s.identityId, 0n);
      const e = await epochNow();
      await forward(QIS, 'setLambdaBps', [5_000n]);
      const p = await walletFund(f.accounts[21], e, 9n * TRAC);
      await claim(a, p, TRAC);
      await claim(b, p, 2n * TRAC);
      await finalizeIn(e, [p], [a, b]);
      await toEpoch(e + 2n);
      await closeAll();
      expect(await QIS.getEpochTotals(e + 1n)).to.deep.equal([3n * TRAC, 0n]);
      expect(await f.QS.queryInferenceGross(e + 1n, a.identityId)).to.equal(3n * TRAC);
      expect(await f.QS.queryInferenceGross(e + 1n, b.identityId)).to.equal(6n * TRAC);
    });

    it('is 0 for an open epoch, an empty pool, and a node with no value', async () => {
      const a = await seller(1_250_000n * TRAC);
      const idle = await seller(1_250_000n * TRAC);
      const e = await epochNow();
      const p = await walletFund(f.accounts[21], e, 4n * TRAC);
      await claim(a, p, TRAC);
      await finalizeIn(e, [p], [a]);
      expect(await f.QS.queryInferenceGross(e + 1n, a.identityId)).to.equal(0n);
      expect(await f.QS.epochPool(e + 1n)).to.equal(0n);
      await toEpoch(e + 2n);
      await closeAll();
      expect(await f.QS.queryInferenceGross(e + 1n, a.identityId)).to.equal(4n * TRAC);
      expect(await f.QS.queryInferenceGross(e + 1n, idle.identityId)).to.equal(0n);
      // Epoch e had no value and no money: its pool is 0.
      expect(await f.QS.epochPool(e)).to.equal(0n);
      expect(await f.QS.queryInferenceGross(e, a.identityId)).to.equal(0n);
    });
  });
});
