// Finalization of receipt claims against the funded cap (OT-RFC-27), end to
// end on the real account and staking stacks.
//
// Groups:
//   - under the cap: the whole claim counts as R and QueryInferenceScore in
//     the epoch after the period, for the seller the ref names, whoever calls;
//   - over the cap: every exposed seller shrinks by the same ratio, in either
//     order of batches and of finalizations;
//   - a Conviction Account bucket, funded through the built Conviction Account
//     path, finalizes against its discounted cap, at two tiers;
//   - the window: too early before the epoch's batch deadline, void from the
//     second epoch after the period on;
//   - skips with a reason, never a revert: an unscored seller beside scored
//     ones, a double finalization, unknown periods and buckets, nothing
//     claimed; the pause and activation refuse the whole call;
//   - the receipt grace schedule and a re-assignment after revocation: neither
//     lets a batch land once a claim of its bucket is finalized.

import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { loadFixture, takeSnapshot, time } from '@nomicfoundation/hardhat-network-helpers';
import { expect } from 'chai';
import { BaseContract, ContractTransactionReceipt, Result } from 'ethers';
import hre from 'hardhat';

import { QueryInferenceStorage } from '../typechain';
import {
  Bucket,
  CLASS_INFERENCE,
  CLASS_QUERY,
  DAY,
  Domain,
  TRAC,
  bucket,
  requestOf,
  signTerms,
  subscriptionIdOf,
  walletRequestOf,
} from './helpers/conviction-service';
import {
  Fault,
  SCALE18,
  SettlementStack,
  createNode,
  deploySettlementStack,
  hardhatWallet,
  openConvictionAccount,
  queryInferenceDomain,
  scoreNode,
  signedItems,
  stakeFactorOf,
} from './helpers/query-inference';

/** Why a claim was skipped: `QueryInferenceSettlement.Skip`, in declaration order. */
const Skip = {
  None: 0n,
  UnknownPeriod: 1n,
  UnknownBucket: 2n,
  AlreadyFinalized: 3n,
  TooEarly: 4n,
  Void: 5n,
  NothingClaimed: 6n,
  NoScore: 7n,
} as const;

const UNIT_ASK = 10n ** 15n; // a thousandth of a TRAC per unit
const PRICE_CAP = 10n ** 15n;

type Seller = { identityId: bigint; operational: SignerWithAddress };

/** This suite's own fixture, so loadFixture keeps a snapshot for it alone. */
async function deployFixture(): Promise<SettlementStack> {
  return deploySettlementStack();
}

describe('@integration Finalization of receipt claims against the funded cap', function () {
  let f: SettlementStack;
  let domain: Domain;
  let buyer: SignerWithAddress;
  let buyer2: SignerWithAddress;
  let buyer3: SignerWithAddress;
  let owner: SignerWithAddress;
  let keeper: SignerWithAddress;
  let nextAccount: number;
  const key = hardhatWallet(60);

  beforeEach(async () => {
    hre.helpers.resetDeploymentsJson();
    f = await loadFixture(deployFixture);
    domain = await queryInferenceDomain(f.QIS);
    owner = f.accounts[20];
    buyer = f.accounts[21];
    buyer2 = f.accounts[22];
    buyer3 = f.accounts[25];
    keeper = f.accounts[24];
    nextAccount = 40;
  });

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  const latest = async () => BigInt(await time.latest());
  const epochNow = async () => f.Chronos.getCurrentEpoch();
  const epochStart = async (e: bigint) => f.Chronos.timestampForEpoch(e);
  const forward = async (contract: BaseContract, fn: string, args: unknown[] = []) =>
    f.Hub.forwardCall(await contract.getAddress(), contract.interface.encodeFunctionData(fn, args));

  /** A Core Node seller with `stake` TRAC, so its stake factor is sqrt(stake / 5M). */
  const seller = async (stake: bigint): Promise<Seller> => {
    const operational = f.accounts[nextAccount++];
    const admin = f.accounts[nextAccount++];
    return { identityId: await createNode({ ...f, operational, admin, stake }), operational };
  };

  const walletFund = async (who: SignerWithAddress, epoch: bigint, buckets: Bucket[]): Promise<string> => {
    const value = buckets.reduce((a, b) => a + b.value, 0n);
    await f.Token.mint(who.address, value);
    await f.Token.connect(who).approve(await f.SSW.getAddress(), value);
    await f.SSW.connect(who).fundFromWallet(walletRequestOf(epoch, { buckets, sessionKey: key.address }));
    return subscriptionIdOf(who.address, epoch);
  };

  /** `by` claims `amount` wei on a period's bucket, as `count` equal receipts, from nonce `firstNonce`. */
  const claim = async (
    by: Seller,
    subscriptionId: string,
    bucketIndex: number,
    amount: bigint,
    opts: { count?: number; firstNonce?: bigint; issuedAt?: bigint } = {},
  ) => {
    const count = opts.count ?? 1;
    expect(amount % (UNIT_ASK * BigInt(count))).to.equal(0n);
    const b = await f.CSS.getBucket(subscriptionId, bucketIndex);
    const { items } = signedItems({
      domain,
      wallet: key,
      subscriptionId,
      bucketId: b.bucketId,
      seller: by.identityId,
      firstNonce: opts.firstNonce,
      count,
      units: amount / UNIT_ASK / BigInt(count),
      ask: UNIT_ASK,
      issuedAt: opts.issuedAt ?? (await latest()),
    });
    await f.QS.connect(by.operational).submitReceiptBatch([{ subscriptionId, bucketIndex: BigInt(bucketIndex), items }]);
  };

  /** The epoch's batch deadline: its end plus the grace of its periods. */
  const deadlineOf = async (epoch: bigint) =>
    (await epochStart(epoch + 1n)) + (await f.QIS.receiptGraceSecondsAt(epoch));

  /** Move past the batch deadline of `epoch`'s periods: into epoch + 1, its finalization window. */
  const openWindow = async (epoch: bigint) => {
    await time.increaseTo((await deadlineOf(epoch)) + 1n);
    expect(await epochNow()).to.equal(epoch + 1n);
  };

  const ref = (subscriptionId: string, bucketIndex: number, by: Seller) => ({
    subscriptionId,
    bucketIndex: BigInt(bucketIndex),
    seller: by.identityId,
  });

  const finalize = async (refs: ReturnType<typeof ref>[], from: SignerWithAddress = keeper) =>
    (await (await f.QS.connect(from).finalizeClaims(refs)).wait())!;

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

  const skipped = (receipt: ContractTransactionReceipt) =>
    eventsOf(receipt, f.QS, 'ClaimSkipped').map((e) => [e.subscriptionId, e.bucketIndex, e.seller, e.reason]);

  const nodeEpoch = async (by: Seller, epoch: bigint) => {
    const n = await f.QIS.getNodeEpoch(by.identityId, epoch);
    return [n.r, n.score];
  };

  const totals = async (qis: QueryInferenceStorage, epoch: bigint) => {
    const t = await qis.getEpochTotals(epoch);
    return [t.sumR, t.sumScore];
  };

  // -------------------------------------------------------------------------
  // Under and over the cap
  // -------------------------------------------------------------------------

  describe('under the cap', () => {
    it('the whole claim counts in the epoch after the period, for the seller the ref names, whoever calls', async () => {
      const s1 = await seller(1_250_000n * TRAC); // S = 0.5
      const e = await epochNow();
      const p = await walletFund(buyer, e, [bucket(0, CLASS_INFERENCE, 10n * TRAC, PRICE_CAP)]);
      await claim(s1, p, 0, 4n * TRAC, { count: 2 });
      expect(await f.QS.fundedCap(p, 0n)).to.equal(10n * TRAC);

      await openWindow(e);
      await scoreNode(f.RSS, e + 1n, s1.identityId);
      const vaultBefore = await f.Token.balanceOf(await f.Vault.getAddress());
      expect(await f.QS.connect(keeper).finalizeClaims.staticCall([ref(p, 0, s1)])).to.equal(1n);
      const receipt = await finalize([ref(p, 0, s1)]);

      const [ev] = eventsOf(receipt, f.QS, 'ClaimsFinalized');
      expect([ev.subscriptionId, ev.bucketIndex, ev.seller, ev.epoch, ev.claimed, ev.value, ev.score]).to.deep.equal([
        p,
        0n,
        s1.identityId,
        e + 1n,
        4n * TRAC,
        4n * TRAC,
        2n * TRAC,
      ]);
      expect((await f.QIS.getSellerClaim(p, 0n, s1.identityId)).finalized).to.equal(true);
      expect(await nodeEpoch(s1, e + 1n)).to.deep.equal([4n * TRAC, 2n * TRAC]);
      expect(await totals(f.QIS, e + 1n)).to.deep.equal([4n * TRAC, 2n * TRAC]);
      // Nothing counts in the period's own epoch, and no TRAC moves.
      expect(await nodeEpoch(s1, e)).to.deep.equal([0n, 0n]);
      expect(await totals(f.QIS, e)).to.deep.equal([0n, 0n]);
      expect(await f.Token.balanceOf(await f.Vault.getAddress())).to.equal(vaultBefore);
      expect(skipped(receipt)).to.have.length(0);
    });

    it("a period funded ahead counts in the epoch after its own, whatever epoch its batches landed in", async () => {
      const s1 = await seller(1_250_000n * TRAC);
      const e = await epochNow();
      const p = await walletFund(buyer, e + 1n, [bucket(0, CLASS_INFERENCE, 10n * TRAC, PRICE_CAP)]);
      await time.increaseTo(await epochStart(e + 1n));
      await claim(s1, p, 0, 3n * TRAC);
      // A batch in the grace, inside e + 2, for the same period.
      await time.increaseTo((await epochStart(e + 2n)) + 60n);
      await claim(s1, p, 0, 2n * TRAC, { firstNonce: 1n, issuedAt: (await epochStart(e + 2n)) - 10n });

      await openWindow(e + 1n);
      await scoreNode(f.RSS, e + 2n, s1.identityId);
      await finalize([ref(p, 0, s1)]);
      expect(await nodeEpoch(s1, e + 2n)).to.deep.equal([5n * TRAC, (5n * TRAC) / 2n]);
      expect(await nodeEpoch(s1, e + 1n)).to.deep.equal([0n, 0n]);
    });
  });

  describe('over the cap', () => {
    it('A and B, claiming 80 each of 100 at stake factors 0.9 and 0.5, finalize 50 each with scores 45 and 25, in both orders', async () => {
      const a = await seller(4_050_000n * TRAC); // S = sqrt(0.81) = 0.9
      const b = await seller(1_250_000n * TRAC); // S = 0.5
      const cap = await f.Params.maximumStake();
      expect(await f.QS.stakeFactor(a.identityId)).to.equal(stakeFactorOf(4_050_000n * TRAC, cap));
      expect(await f.QS.stakeFactor(a.identityId)).to.equal((9n * SCALE18) / 10n);
      expect(await f.QS.stakeFactor(b.identityId)).to.equal(SCALE18 / 2n);
      const e = await epochNow();
      const p = await walletFund(buyer, e, [bucket(0, CLASS_INFERENCE, 100n * TRAC, PRICE_CAP)]);
      const start = await takeSnapshot();

      const results: bigint[][][] = [];
      for (const [first, second] of [
        [a, b],
        [b, a],
      ]) {
        await start.restore();
        await claim(first, p, 0, 80n * TRAC, { count: 4 });
        await claim(second, p, 0, 80n * TRAC, { count: 8 });
        expect(await f.QIS.bucketClaimed(p, 0n)).to.equal(160n * TRAC);
        await openWindow(e);
        await scoreNode(f.RSS, e + 1n, a.identityId);
        await scoreNode(f.RSS, e + 1n, b.identityId);
        await finalize([ref(p, 0, second)]);
        await finalize([ref(p, 0, first)], second.operational);
        results.push([await nodeEpoch(a, e + 1n), await nodeEpoch(b, e + 1n), await totals(f.QIS, e + 1n)]);
      }
      expect(results[0]).to.deep.equal([
        [50n * TRAC, 45n * TRAC],
        [50n * TRAC, 25n * TRAC],
        [100n * TRAC, 70n * TRAC],
      ]);
      expect(results[1]).to.deep.equal(results[0]);
    });

    it('rounds every share down, so the finalized values never exceed the cap', async () => {
      const sellers = [await seller(1_250_000n * TRAC), await seller(1_250_000n * TRAC), await seller(1_250_000n * TRAC)];
      const e = await epochNow();
      const p = await walletFund(buyer, e, [bucket(0, CLASS_INFERENCE, 10n * TRAC + 1n, PRICE_CAP)]);
      for (const s of sellers) await claim(s, p, 0, 7n * TRAC);
      await openWindow(e);
      for (const s of sellers) await scoreNode(f.RSS, e + 1n, s.identityId);
      await finalize(sellers.map((s) => ref(p, 0, s)));
      const each = (7n * TRAC * (10n * TRAC + 1n)) / (21n * TRAC);
      for (const s of sellers) expect((await nodeEpoch(s, e + 1n))[0]).to.equal(each);
      const [sumR] = await totals(f.QIS, e + 1n);
      expect(sumR).to.equal(3n * each);
      expect(sumR <= 10n * TRAC + 1n).to.equal(true);
    });

    it("each bucket has its own cap: an over-claimed bucket shrinks, another bucket of the period does not", async () => {
      const s1 = await seller(1_250_000n * TRAC);
      const e = await epochNow();
      const p = await walletFund(buyer, e, [
        bucket(0, CLASS_INFERENCE, 4n * TRAC, PRICE_CAP),
        bucket(1, CLASS_QUERY, 4n * TRAC, PRICE_CAP),
      ]);
      await claim(s1, p, 0, 8n * TRAC);
      await claim(s1, p, 1, 3n * TRAC, { firstNonce: 1n });
      await openWindow(e);
      await scoreNode(f.RSS, e + 1n, s1.identityId);
      await finalize([ref(p, 0, s1), ref(p, 1, s1)]);
      expect(await nodeEpoch(s1, e + 1n)).to.deep.equal([7n * TRAC, (7n * TRAC) / 2n]);
    });
  });

  // -------------------------------------------------------------------------
  // Conviction Account buckets
  // -------------------------------------------------------------------------

  describe('Conviction Account buckets', () => {
    it('finalize against the discounted cap: 7 of 10 at the 30 % tier, 2.5 of 10 at the 75 % tier', async () => {
      const s1 = await seller(1_250_000n * TRAC);
      const e = await epochNow();
      const periods: Array<[string, bigint, bigint]> = [];
      for (const [assignee, committed, bps] of [
        [buyer2, 100_000n * TRAC, 3_000n],
        [buyer3, 1_000_000n * TRAC, 7_500n],
      ] as Array<[SignerWithAddress, bigint, bigint]>) {
        const { accountId } = await openConvictionAccount({
          ...f,
          owner,
          assignee,
          committed,
          limit: 100n * TRAC,
        });
        expect((await f.SS.previewCost(accountId, TRAC))[1]).to.equal(bps);
        await f.SS.connect(assignee).fundFromConviction(
          requestOf(accountId, e, {
            buckets: [bucket(0, CLASS_INFERENCE, 10n * TRAC, PRICE_CAP)],
            sessionKey: key.address,
          }),
        );
        const p = subscriptionIdOf(assignee.address, e);
        expect((await f.CSS.getSubscription(p)).discountBps).to.equal(bps);
        periods.push([p, bps, (10n * TRAC * (10_000n - bps)) / 10_000n]);
      }

      // The 95 % soft ceiling is face value: 9.5 claimed in each bucket.
      for (const [p] of periods) await claim(s1, p, 0, 95n * (TRAC / 10n), { count: 5 });
      expect(await f.QS.fundedCap(periods[0][0], 0n)).to.equal(7n * TRAC);
      expect(await f.QS.fundedCap(periods[1][0], 0n)).to.equal((5n * TRAC) / 2n);

      await openWindow(e);
      await scoreNode(f.RSS, e + 1n, s1.identityId);
      const receipt = await finalize(periods.map(([p]) => ref(p, 0, s1)));
      const finalized = eventsOf(receipt, f.QS, 'ClaimsFinalized').map((ev) => [ev.subscriptionId, ev.claimed, ev.value]);
      expect(finalized).to.deep.equal(periods.map(([p, , cap]) => [p, 95n * (TRAC / 10n), cap]));
      expect((await nodeEpoch(s1, e + 1n))[0]).to.equal(7n * TRAC + (5n * TRAC) / 2n);
    });

    it('a claim under the discounted cap finalizes in full', async () => {
      const s1 = await seller(1_250_000n * TRAC);
      const e = await epochNow();
      const { accountId } = await openConvictionAccount({
        ...f,
        owner,
        assignee: buyer2,
        committed: 100_000n * TRAC,
        limit: 100n * TRAC,
      });
      await f.SS.connect(buyer2).fundFromConviction(
        requestOf(accountId, e, { buckets: [bucket(0, CLASS_INFERENCE, 10n * TRAC, PRICE_CAP)], sessionKey: key.address }),
      );
      const p = subscriptionIdOf(buyer2.address, e);
      await claim(s1, p, 0, 6n * TRAC);
      await openWindow(e);
      await scoreNode(f.RSS, e + 1n, s1.identityId);
      await finalize([ref(p, 0, s1)]);
      expect((await nodeEpoch(s1, e + 1n))[0]).to.equal(6n * TRAC);
    });
  });

  // -------------------------------------------------------------------------
  // The window
  // -------------------------------------------------------------------------

  describe('the window: during the epoch after the period, after its batch deadline', () => {
    it('is too early during the period and up to the deadline, opens a second after it, and is void from e + 2 on', async () => {
      const s1 = await seller(1_250_000n * TRAC);
      const s2 = await seller(1_250_000n * TRAC);
      const e = await epochNow();
      const p = await walletFund(buyer, e, [bucket(0, CLASS_INFERENCE, 10n * TRAC, PRICE_CAP)]);
      await claim(s1, p, 0, TRAC);
      await claim(s2, p, 0, TRAC);
      await scoreNode(f.RSS, e, s1.identityId);

      let receipt = await finalize([ref(p, 0, s1)]);
      expect(skipped(receipt)).to.deep.equal([[p, 0n, s1.identityId, Skip.TooEarly]]);

      const deadline = await deadlineOf(e);
      expect(await f.QS.batchDeadline(p)).to.equal(deadline);
      await scoreNode(f.RSS, e + 1n, s1.identityId);
      await scoreNode(f.RSS, e + 1n, s2.identityId);
      await time.setNextBlockTimestamp(deadline);
      receipt = await finalize([ref(p, 0, s1)]);
      expect(skipped(receipt)).to.deep.equal([[p, 0n, s1.identityId, Skip.TooEarly]]);
      receipt = await finalize([ref(p, 0, s1)]);
      expect(skipped(receipt)).to.have.length(0);
      expect((await nodeEpoch(s1, e + 1n))[0]).to.equal(TRAC);

      // s2's claim is left until e + 1 ends: it is void, and never counts.
      await time.increaseTo(await epochStart(e + 2n));
      await scoreNode(f.RSS, e + 2n, s2.identityId);
      receipt = await finalize([ref(p, 0, s2)]);
      expect(skipped(receipt)).to.deep.equal([[p, 0n, s2.identityId, Skip.Void]]);
      expect((await f.QIS.getSellerClaim(p, 0n, s2.identityId)).finalized).to.equal(false);
      expect(await nodeEpoch(s2, e + 1n)).to.deep.equal([0n, 0n]);
      expect(await nodeEpoch(s2, e + 2n)).to.deep.equal([0n, 0n]);
    });
  });

  // -------------------------------------------------------------------------
  // Skips, not reverts
  // -------------------------------------------------------------------------

  describe('skips with a reason', () => {
    it('an unscored seller is skipped while the others in the call finalize, and finalizes once it scores', async () => {
      const s1 = await seller(1_250_000n * TRAC);
      const s2 = await seller(1_250_000n * TRAC);
      const e = await epochNow();
      const p = await walletFund(buyer, e, [bucket(0, CLASS_INFERENCE, 10n * TRAC, PRICE_CAP)]);
      await claim(s1, p, 0, TRAC);
      await claim(s2, p, 0, 2n * TRAC);
      // A score in the period's own epoch is not one in the epoch after it.
      await scoreNode(f.RSS, e, s2.identityId);
      await openWindow(e);
      await scoreNode(f.RSS, e + 1n, s1.identityId);

      expect(await f.QS.connect(keeper).finalizeClaims.staticCall([ref(p, 0, s2), ref(p, 0, s1)])).to.equal(1n);
      let receipt = await finalize([ref(p, 0, s2), ref(p, 0, s1)]);
      expect(skipped(receipt)).to.deep.equal([[p, 0n, s2.identityId, Skip.NoScore]]);
      expect((await nodeEpoch(s1, e + 1n))[0]).to.equal(TRAC);
      expect((await f.QIS.getSellerClaim(p, 0n, s2.identityId)).finalized).to.equal(false);

      await scoreNode(f.RSS, e + 1n, s2.identityId);
      receipt = await finalize([ref(p, 0, s2)]);
      expect(skipped(receipt)).to.have.length(0);
      expect((await nodeEpoch(s2, e + 1n))[0]).to.equal(2n * TRAC);
    });

    it('a double finalization is skipped, within one call and in a later one, and counts once', async () => {
      const s1 = await seller(1_250_000n * TRAC);
      const e = await epochNow();
      const p = await walletFund(buyer, e, [bucket(0, CLASS_INFERENCE, 10n * TRAC, PRICE_CAP)]);
      await claim(s1, p, 0, TRAC);
      await openWindow(e);
      await scoreNode(f.RSS, e + 1n, s1.identityId);
      let receipt = await finalize([ref(p, 0, s1), ref(p, 0, s1)]);
      expect(skipped(receipt)).to.deep.equal([[p, 0n, s1.identityId, Skip.AlreadyFinalized]]);
      receipt = await finalize([ref(p, 0, s1)], s1.operational);
      expect(skipped(receipt)).to.deep.equal([[p, 0n, s1.identityId, Skip.AlreadyFinalized]]);
      expect(await nodeEpoch(s1, e + 1n)).to.deep.equal([TRAC, TRAC / 2n]);
      // Also once e + 1 has ended: a finalized claim reads as finalized, not void.
      await time.increaseTo(await epochStart(e + 2n));
      receipt = await finalize([ref(p, 0, s1)]);
      expect(skipped(receipt)).to.deep.equal([[p, 0n, s1.identityId, Skip.AlreadyFinalized]]);
    });

    it('an unknown period, an unknown bucket and a seller with nothing claimed are skipped', async () => {
      const s1 = await seller(1_250_000n * TRAC);
      const s2 = await seller(1_250_000n * TRAC);
      const e = await epochNow();
      const p = await walletFund(buyer, e, [bucket(0, CLASS_INFERENCE, 10n * TRAC, PRICE_CAP)]);
      await claim(s1, p, 0, TRAC);
      await openWindow(e);
      await scoreNode(f.RSS, e + 1n, s1.identityId);
      await scoreNode(f.RSS, e + 1n, s2.identityId);
      const unknown = hre.ethers.id('never-funded');
      const receipt = await finalize([ref(unknown, 0, s1), ref(p, 1, s1), ref(p, 0, s2), ref(p, 0, s1)]);
      expect(skipped(receipt)).to.deep.equal([
        [unknown, 0n, s1.identityId, Skip.UnknownPeriod],
        [p, 1n, s1.identityId, Skip.UnknownBucket],
        [p, 0n, s2.identityId, Skip.NothingClaimed],
      ]);
      expect(await totals(f.QIS, e + 1n)).to.deep.equal([TRAC, TRAC / 2n]);
      expect(await f.QS.fundedCap(unknown, 0n)).to.equal(0n);
      expect(await f.QS.fundedCap(p, 1n)).to.equal(0n);
      // An empty call finalizes nothing.
      expect(await f.QS.finalizeClaims.staticCall([])).to.equal(0n);
    });

    it('the whole call is refused while paused, and before activation', async () => {
      const s1 = await seller(1_250_000n * TRAC);
      const e = await epochNow();
      const p = await walletFund(buyer, e, [bucket(0, CLASS_INFERENCE, 10n * TRAC, PRICE_CAP)]);
      await claim(s1, p, 0, TRAC);
      await openWindow(e);
      await scoreNode(f.RSS, e + 1n, s1.identityId);
      await forward(f.QIS, 'setPaused', [true]);
      await expect(f.QS.finalizeClaims([ref(p, 0, s1)])).to.be.revertedWithCustomError(f.QS, 'QueryInferencePaused');
      await forward(f.QIS, 'setPaused', [false]);

      const fresh = (await (
        await hre.ethers.getContractFactory('QueryInferenceStorage')
      ).deploy(await f.Hub.getAddress())) as unknown as QueryInferenceStorage;
      await fresh.waitForDeployment();
      await f.Hub.setContractAddress('QueryInferenceStorage', await fresh.getAddress());
      await forward(fresh, 'initialize');
      await forward(f.QS, 'initialize');
      await expect(f.QS.finalizeClaims([ref(p, 0, s1)]))
        .to.be.revertedWithCustomError(f.QS, 'QueryInferenceNotActive')
        .withArgs(0n, e + 1n);
    });
  });

  // -------------------------------------------------------------------------
  // Nothing reopens a finalized bucket
  // -------------------------------------------------------------------------

  describe('nothing reopens a finalized bucket', () => {
    const lateItem = async (p: string, s1: Seller, nonce: bigint, issuedAt: bigint) =>
      signedItems({
        domain,
        wallet: key,
        subscriptionId: p,
        bucketId: (await f.CSS.getBucket(p, 0n)).bucketId,
        seller: s1.identityId,
        firstNonce: nonce,
        count: 1,
        ask: UNIT_ASK,
        issuedAt,
      }).items;

    it("a grace change made during e + 1, after a finalization, applies from the next epoch's periods: e's batches stay closed", async () => {
      const s1 = await seller(1_250_000n * TRAC);
      const e = await epochNow();
      const p = await walletFund(buyer, e, [bucket(0, CLASS_INFERENCE, 10n * TRAC, PRICE_CAP)]);
      await claim(s1, p, 0, 2n * TRAC);
      await openWindow(e);
      await scoreNode(f.RSS, e + 1n, s1.identityId);
      await finalize([ref(p, 0, s1)]);

      // The grace is raised to its longest during e + 1: e's deadline does not move.
      const epLen = await f.Chronos.epochLength();
      await forward(f.QIS, 'setReceiptGraceSeconds', [epLen - 1n]);
      expect(await f.QIS.receiptGraceSecondsAt(e)).to.equal(3_600n);
      expect(await f.QIS.receiptGraceSecondsAt(e + 1n)).to.equal(3_600n);
      expect(await f.QIS.receiptGraceSecondsAt(e + 2n)).to.equal(epLen - 1n);
      expect(await f.QS.batchDeadline(p)).to.equal((await epochStart(e + 1n)) + 3_600n);
      const late = await lateItem(p, s1, 7n, (await epochStart(e + 1n)) - 100n);
      await expect(f.QS.connect(s1.operational).submitReceiptBatch([{ subscriptionId: p, bucketIndex: 0n, items: late }]))
        .to.be.revertedWithCustomError(f.QS, 'GroupFault')
        .withArgs(0n, Fault.PastDeadline);
      expect(await f.QIS.bucketClaimed(p, 0n)).to.equal(2n * TRAC);
    });

    it("a grace change made during e applies to the next epoch's periods, not to e's", async () => {
      const s1 = await seller(1_250_000n * TRAC);
      const e = await epochNow();
      const p = await walletFund(buyer, e, [bucket(0, CLASS_INFERENCE, 10n * TRAC, PRICE_CAP)]);
      await forward(f.QIS, 'setReceiptGraceSeconds', [7_200n]);
      expect(await f.QIS.receiptGraceSecondsAt(e)).to.equal(3_600n);
      expect(await f.QIS.receiptGraceSecondsAt(e + 1n)).to.equal(7_200n);
      expect(await f.QS.batchDeadline(p)).to.equal((await epochStart(e + 1n)) + 3_600n);
      await time.increaseTo((await epochStart(e + 1n)) + 3_601n);
      const late = await lateItem(p, s1, 0n, (await epochStart(e + 1n)) - 100n);
      await expect(f.QS.connect(s1.operational).submitReceiptBatch([{ subscriptionId: p, bucketIndex: 0n, items: late }]))
        .to.be.revertedWithCustomError(f.QS, 'GroupFault')
        .withArgs(0n, Fault.PastDeadline);
    });

    it('the epoch keeps its own grace while a later one is scheduled', async () => {
      const s1 = await seller(1_250_000n * TRAC);
      const e = await epochNow();
      const p = await walletFund(buyer, e, [bucket(0, CLASS_INFERENCE, 10n * TRAC, PRICE_CAP)]);
      const late = signedItems({
        domain,
        wallet: key,
        subscriptionId: p,
        bucketId: (await f.CSS.getBucket(p, 0n)).bucketId,
        seller: s1.identityId,
        firstNonce: 7n,
        count: 1,
        ask: UNIT_ASK,
        issuedAt: (await epochStart(e + 1n)) - 100n,
      });
      await forward(f.QIS, 'setReceiptGraceSeconds', [60n]);
      await time.setNextBlockTimestamp((await epochStart(e + 1n)) + 3_600n);
      await f.QS.connect(s1.operational).submitReceiptBatch([{ subscriptionId: p, bucketIndex: 0n, items: late.items }]);
      expect(await f.QIS.bucketClaimed(p, 0n)).to.equal(late.items[0].valueWei);
    });

    it('a re-assignment after revocation reopens batches only before the window opens, never after a claim is final', async () => {
      const s1 = await seller(1_250_000n * TRAC);
      const e = await epochNow();
      const { accountId, terms } = await openConvictionAccount({
        ...f,
        owner,
        assignee: buyer2,
        committed: 100_000n * TRAC,
        limit: 100n * TRAC,
      });
      await f.SS.connect(buyer2).fundFromConviction(
        requestOf(accountId, e, { buckets: [bucket(0, CLASS_INFERENCE, 10n * TRAC, PRICE_CAP)], sessionKey: key.address }),
      );
      const p = subscriptionIdOf(buyer2.address, e);
      await claim(s1, p, 0, TRAC);
      // Revoked in the last half hour of e: the period's deadline falls in
      // e + 1, before the epoch's.
      await time.increaseTo((await epochStart(e + 1n)) - 1_800n);
      await f.SS.connect(owner).revoke(accountId, buyer2.address);
      const revokedAt = (await f.CSS.getAssignment(accountId, buyer2.address)).revokedAt;
      expect(await f.QS.batchDeadline(p)).to.equal(revokedAt + 3_600n);
      expect(revokedAt + 3_600n).to.be.lessThan(await deadlineOf(e));

      // In e + 1, past the period's own deadline but not the epoch's: too early.
      await time.increaseTo(revokedAt + 3_601n);
      expect(await epochNow()).to.equal(e + 1n);
      await scoreNode(f.RSS, e + 1n, s1.identityId);
      let receipt = await finalize([ref(p, 0, s1)]);
      expect(skipped(receipt)).to.deep.equal([[p, 0n, s1.identityId, Skip.TooEarly]]);

      // A new assignment moves the period's deadline back out, and a batch lands.
      const again = { ...terms, nonce: await f.CSS.assignmentNonce(accountId), expiresAt: terms.expiresAt };
      await f.SS.connect(owner).assign(again, '0x', await signTerms(buyer2, f.SS, again));
      await claim(s1, p, 0, TRAC, { firstNonce: 1n, issuedAt: (await epochStart(e + 1n)) - 100n });

      await openWindow(e);
      receipt = await finalize([ref(p, 0, s1)]);
      expect(skipped(receipt)).to.have.length(0);
      expect((await nodeEpoch(s1, e + 1n))[0]).to.equal(2n * TRAC);

      // Once the window is open, no batch lands, whatever the assignment.
      await f.SS.connect(owner).revoke(accountId, buyer2.address);
      const third = { ...terms, nonce: await f.CSS.assignmentNonce(accountId), expiresAt: (await latest()) + 400n * DAY };
      await f.SS.connect(owner).assign(third, '0x', await signTerms(buyer2, f.SS, third));
      const late = await lateItem(p, s1, 2n, (await epochStart(e + 1n)) - 100n);
      await expect(f.QS.connect(s1.operational).submitReceiptBatch([{ subscriptionId: p, bucketIndex: 0n, items: late }]))
        .to.be.revertedWithCustomError(f.QS, 'GroupFault')
        .withArgs(0n, Fault.PastDeadline);
    });
  });
});
