// The query/inference pool (OT-RFC-27) paid through StakingV10 10.1.0 claims,
// end to end on the development deploy of the staking, account and
// subscription stacks (StakingV10 and StakingKPI wired to the settlement, the
// activation epoch at the deployment epoch, λ 0.5):
//   - a node's gross reward for an epoch is its score share of the
//     publishing pool plus its gross from the query/inference pool; the
//     operator fee comes off the sum and the delegators split the rest by
//     score, across tiers;
//   - rollover: epochs with no counted value pay nothing from the pool, and
//     the next epoch with value pays their money with its own, to a node's
//     first claim of it;
//   - a claim reads ended epochs and calls nothing first: it pays an epoch from
//     the first second of the next, and the pool holds back no claim,
//     withdrawal, relock or redelegation;
//   - conservation: the vault StakingV10 pays from, ConvictionStakingStorage,
//     receives every wallet payment and holds every TRAC a claim credits;
//   - StakingKPI.getNetNodeRewards reads queryInferenceGross and equals what the
//     claims pay, before an epoch's split and once it is recorded;
//   - a position that left a node by a redelegation, or its token by a relock,
//     in an epoch with both pools takes its share of that node's reward at its
//     next claim, through the reward carry, once, with the operator fee split
//     once;
//   - with the pool's activation epoch unset, claims read nothing from it;
//   - with the settlement out of the Hub, the emergency switch, a batch reverts
//     and a claim pays without the pool, for good;
//   - a Conviction Account's money (PublishingConviction 10.2.0,
//     ServiceSubscriptions 1.2.0) through claims over its whole lock: a 
//     subscription's cost in its epoch beside a wallet subscription, a subscription's cost alone
//     rolled over, a publishing spend and the closed windows' unused allowance in the
//     publishing pool; the commitment is booked exactly once, and the vault
//     keeps only the floors once everything is withdrawn.
//
// A withdrawal mid-epoch, and the epoch in progress it leaves to claim, is in
// v10-query-inference-withdrawal.test.ts.

import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { loadFixture, takeSnapshot, time } from '@nomicfoundation/hardhat-network-helpers';
import { expect } from 'chai';
import { ContractTransactionReceipt, ContractTransactionResponse } from 'ethers';
import hre from 'hardhat';

import { QueryInferenceSettlement, QueryInferenceStorage } from '../typechain';
import { STAKER_SHARD_ID, TREASURY_SHARD_ID } from './helpers/account-stack';
import {
  CLASS_INFERENCE,
  DAY,
  Domain,
  TRAC,
  Terms,
  budget,
  costOf,
  requestOf,
  signTerms,
  subscriptionIdOf,
} from './helpers/conviction-service';
import { SCALE18, hardhatWallet, queryInferenceDomain, signedItems } from './helpers/query-inference';
import {
  RewardsHelpers,
  Seller,
  TIER_12,
  UNIT_PRICE,
  deployRewardsStack,
  rewardsHelpers,
} from './helpers/query-inference-rewards';

/** This suite's own fixture, so loadFixture keeps a snapshot for it alone. */
async function deployFixture() {
  return deployRewardsStack();
}

type Fixture = Awaited<ReturnType<typeof deployFixture>>;

describe('@integration Query/inference rewards through StakingV10 claims', function () {
  let f: Fixture;
  let h: RewardsHelpers;
  let domain: Domain;
  const key = hardhatWallet(60);

  beforeEach(async () => {
    hre.helpers.resetDeploymentsJson();
    f = await loadFixture(deployFixture);
    domain = await queryInferenceDomain(f.QIS);
    h = rewardsHelpers({ f, domain, firstAccount: 30, key });
  });

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------


  // -------------------------------------------------------------------------

  it('is wired by the development deploy: StakingV10 and StakingKPI read the settlement, active from the deployment epoch', async () => {
    expect(await f.StakingV10.version()).to.equal('10.1.0');
    expect(await f.KPI.version()).to.equal('10.1.0');
    expect(await f.StakingV10.queryInferenceSettlement()).to.equal(await f.QS.getAddress());
    expect(await f.StakingV10.queryInferenceStorage()).to.equal(await f.QIS.getAddress());
    expect(await f.KPI.queryInferenceSettlement()).to.equal(await f.QS.getAddress());
    expect(await f.QIS.activationEpoch()).to.equal(await h.epochNow());
    expect(await f.QIS.lambdaBps()).to.equal(5_000n);
    // The money lives in the vault StakingV10 pays from.
    expect(await f.SSW.stakingStorageAddress()).to.equal(await f.StakingV10.convictionStorage());
    expect(await f.StakingV10.convictionStorage()).to.equal(await h.vault());
  });

  it('pays a wallet-funded pool with the publishing pool, through the operator fee, to every delegator by score', async () => {
    const e = await h.epochNow();
    const n1 = await h.createSeller(1_250_000n * TRAC, 1_000n); // 10% fee
    const n2 = await h.createSeller(2_000_000n * TRAC, 2_000n); // 20% fee
    const d1 = f.accounts[10];
    const d2 = f.accounts[11];
    const t1 = await h.delegate(d1, n1.identityId, 200_000n * TRAC);
    const t2 = await h.delegate(d2, n1.identityId, 100_000n * TRAC, TIER_12);

    const p = await h.walletFund(f.accounts[20], e, 100n * TRAC);
    await h.scoreEpoch(e, n1, 300n * TRAC);
    await h.scoreEpoch(e, n2, 100n * TRAC);
    await h.claimReceipts(n1, p, 30n * TRAC);
    await h.claimReceipts(n2, p, 50n * TRAC);
    await h.publishingPool(e, 1_000n * TRAC);
    await h.toEpoch(e + 1n);

    // Ended, and split by no claim yet: the KPI reads what the claims then pay.
    const previewed = [await f.KPI.getNetNodeRewards(n1.identityId, e), await f.KPI.getNetNodeRewards(n2.identityId, e)];

    const feeBefore = [await f.Vault.getOperatorFeeBalance(n1.identityId), await f.Vault.getOperatorFeeBalance(n2.identityId)];
    // Each position's score in e, from the stake it had there: a claim compounds into it.
    const score1 = await h.positionScore(t1, n1, e);
    const score2 = await h.positionScore(t2, n1, e);
    const scoreOperator1 = await h.positionScore(n1.tokenId, n1, e);
    const scoreOperator2 = await h.positionScore(n2.tokenId, n2, e);
    const paid1 = await h.claim(d1, t1);
    expect(await f.QS.epochPool(e)).to.equal(100n * TRAC);

    const s1 = await h.split(n1, e);
    const s2 = await h.split(n2, e);
    // The two sellers share the whole pool, less the floors.
    expect(s1.queryInference + s2.queryInference).to.be.closeTo(100n * TRAC, 2n);
    expect(s1.queryInference).to.be.greaterThan(0n);
    expect(s1.publishing).to.equal(750n * TRAC); // 300 of 400 score
    expect(await f.Vault.getNetNodeEpochRewards(n1.identityId, e)).to.equal(s1.net);
    expect((await f.Vault.getOperatorFeeBalance(n1.identityId)) - feeBefore[0]).to.equal(s1.fee);
    expect(previewed[0]).to.equal(s1.net);

    // Every position on the node takes its score share of the net, whatever its tier.
    expect(paid1).to.equal((score1 * s1.net) / s1.nodeScore);
    await expect(f.StakingNFT.connect(d2).claim(t2))
      .to.emit(f.StakingV10, 'RewardsClaimed')
      .withArgs(t2, (score2 * s1.net) / s1.nodeScore);
    const paidOperator = await h.claim(n1.operational, n1.tokenId);
    expect(paidOperator).to.equal((scoreOperator1 * s1.net) / s1.nodeScore);
    // The fee is split once per node and epoch.
    expect((await f.Vault.getOperatorFeeBalance(n1.identityId)) - feeBefore[0]).to.equal(s1.fee);

    const paid2 = await h.claim(n2.operational, n2.tokenId);
    expect(paid2).to.equal((scoreOperator2 * s2.net) / s2.nodeScore);
    expect((await f.Vault.getOperatorFeeBalance(n2.identityId)) - feeBefore[1]).to.equal(s2.fee);
    expect(previewed[1]).to.equal(s2.net);
    expect(await f.KPI.getNetNodeRewards(n2.identityId, e)).to.equal(s2.net);

    // Delegators never take more than the net; only the floors of the score
    // splits stay behind, well under a gwei of TRAC.
    const delegated = paid1 + (score2 * s1.net) / s1.nodeScore + paidOperator;
    expect(delegated <= s1.net).to.equal(true);
    expect(s1.net - delegated < 10n ** 9n).to.equal(true);
  });

  it('rollover: an epoch with no counted value pays nothing from the pool, and the next epoch with value pays its money too', async () => {
    const a = await h.epochNow();
    const n1 = await h.createSeller(1_250_000n * TRAC, 1_000n);
    const d1 = f.accounts[10];
    const t1 = await h.delegate(d1, n1.identityId, 250_000n * TRAC);

    await h.walletFund(f.accounts[20], a, 10n * TRAC); // a's money, which no receipt counts for
    await h.scoreEpoch(a, n1, 100n * TRAC); // the node proves, but sells nothing in a
    await h.toEpoch(a + 1n);
    await h.scoreEpoch(a + 1n, n1, 100n * TRAC);
    const p1 = await h.walletFund(f.accounts[21], a + 1n, 20n * TRAC);
    await h.claimReceipts(n1, p1, 5n * TRAC);
    await h.toEpoch(a + 2n);

    expect(await f.KPI.getNetNodeRewards(n1.identityId, a)).to.equal(0n);
    const previewed = await f.KPI.getNetNodeRewards(n1.identityId, a + 1n);
    const score = await h.positionScore(t1, n1, a + 1n);
    const paid = await h.claim(d1, t1); // one claim over a and a + 1

    expect(await f.QS.epochPool(a)).to.equal(0n);
    expect(await f.QS.epochPool(a + 1n)).to.equal(30n * TRAC);
    const rolled = await h.split(n1, a);
    const s = await h.split(n1, a + 1n);
    expect([rolled.gross, rolled.net]).to.deep.equal([0n, 0n]);
    // The only node with value takes the whole pool, the rolled money included.
    expect(s.queryInference).to.equal(30n * TRAC);
    expect(s.net).to.equal(27n * TRAC);
    expect(previewed).to.equal(s.net);
    expect(paid).to.equal((score * s.net) / s.nodeScore);
    expect(await f.Vault.getOperatorFeeBalance(n1.identityId)).to.equal(3n * TRAC);
  });

  it("a node's first claim of an epoch after a rollover run pays the rolled money, which no later epoch pays again", async () => {
    const a = await h.epochNow();
    // Equal stakes, and so equal stake factors, so the shares come out exact.
    const n1 = await h.createSeller(1_250_000n * TRAC, 1_000n);
    const n2 = await h.createSeller(1_250_000n * TRAC, 1_000n);
    const score = 100n * TRAC;

    // Three epochs of money in which n1 proves and no receipt counts.
    for (const [i, money] of [10n, 20n, 30n].entries()) {
      const epoch = a + BigInt(i);
      if (i > 0) await h.toEpoch(epoch);
      await h.walletFund(f.accounts[20], epoch, money * TRAC);
      await h.scoreEpoch(epoch, n1, score);
    }

    // The run ends in e, in which both nodes count value: 3 to 1.
    const e = a + 3n;
    await h.toEpoch(e);
    const p = await h.walletFund(f.accounts[21], e, 40n * TRAC);
    await h.scoreEpoch(e, n1, score);
    await h.scoreEpoch(e, n2, score);
    await h.claimReceipts(n1, p, 30n * TRAC);
    await h.claimReceipts(n2, p, 10n * TRAC);

    // The epoch after it pays only its own money.
    await h.toEpoch(e + 1n);
    const q = await h.walletFund(f.accounts[21], e + 1n, 5n * TRAC);
    await h.scoreEpoch(e + 1n, n1, score);
    await h.claimReceipts(n1, q, 1n * TRAC);
    await h.toEpoch(e + 2n);

    // Nothing has run since: each pool is a plain read, and no split is recorded.
    for (let x = a; x < e; x++) {
      expect(await f.QS.epochPool(x), `epoch ${x}`).to.equal(0n);
      expect(await f.QS.queryInferenceGross(x, n1.identityId), `epoch ${x}`).to.equal(0n);
    }
    expect(await f.QS.epochPool(e)).to.equal(100n * TRAC);
    expect(await f.QS.epochPool(e + 1n)).to.equal(5n * TRAC);
    expect(await f.Vault.isOperatorFeeClaimedForEpoch(n1.identityId, e)).to.equal(false);
    expect(await f.Vault.isOperatorFeeClaimedForEpoch(n2.identityId, e)).to.equal(false);

    // n1 takes 3/4 of the 100 and all of the 5, so 80, and n2 1/4 of the 100, so
    // 25, each less its 10% fee, and that is all 105 of the money.
    const owedBefore = await h.owed([n1, n2]);
    expect(await h.claim(n1.operational, n1.tokenId)).to.equal(72n * TRAC);
    expect(await f.Vault.getNetNodeEpochRewards(n1.identityId, e)).to.equal((135n * TRAC) / 2n);
    expect(await f.Vault.getOperatorFeeBalance(n1.identityId)).to.equal(8n * TRAC);
    expect(await h.claim(n2.operational, n2.tokenId)).to.equal((45n * TRAC) / 2n);
    expect(await f.Vault.getNetNodeEpochRewards(n2.identityId, e)).to.equal((45n * TRAC) / 2n);
    expect(await f.Vault.getOperatorFeeBalance(n2.identityId)).to.equal((5n * TRAC) / 2n);
    expect((await h.owed([n1, n2])) - owedBefore).to.equal(105n * TRAC);
    // A node with no value in an epoch takes nothing from its pool.
    expect(await f.QS.queryInferenceGross(e + 1n, n2.identityId)).to.equal(0n);
  });

  it('a claim in the very first second of the next epoch pays the epoch, and one in its last second does not yet', async () => {
    const a = await h.epochNow();
    const n1 = await h.createSeller(1_250_000n * TRAC, 1_000n);
    const d1 = f.accounts[10];
    const t1 = await h.delegate(d1, n1.identityId, 250_000n * TRAC);
    const e = await h.valueIn(a + 1n, [[n1, 30n * TRAC, 300n * TRAC]], 1_000n * TRAC);
    const boundary = await f.Chronos.timestampForEpoch(e + 1n);
    const score = await h.positionScore(t1, n1, e);

    await time.setNextBlockTimestamp(boundary - 1n);
    expect(await h.claim(d1, t1)).to.equal(0n);
    expect(await h.epochNow()).to.equal(e);
    expect(await f.Vault.isOperatorFeeClaimedForEpoch(n1.identityId, e)).to.equal(false);

    await time.setNextBlockTimestamp(boundary);
    const paid = await h.claim(d1, t1);
    expect(BigInt(await time.latest())).to.equal(boundary);
    expect(await h.epochNow()).to.equal(e + 1n);
    const s = await h.split(n1, e);
    expect([s.publishing, s.queryInference]).to.deep.equal([1_000n * TRAC, 100n * TRAC]);
    expect(await f.Vault.getNetNodeEpochRewards(n1.identityId, e)).to.equal(s.net);
    expect(paid).to.be.greaterThan(0n);
    expect(paid).to.equal((score * s.net) / s.nodeScore);
  });

  it('a claim calls nothing first and the pool holds nothing back: with many epochs ended, nothing run and the pool paused, claims and a withdrawal pay, and a relock and a redelegation need only the claim', async () => {
    const a = await h.epochNow();
    const n1 = await h.createSeller(1_250_000n * TRAC, 1_000n);
    const d = [f.accounts[10], f.accounts[11], f.accounts[12]];
    const t = [
      await h.delegate(d[0], n1.identityId, 250_000n * TRAC),
      await h.delegate(d[1], n1.identityId, 250_000n * TRAC),
      await h.delegate(d[2], n1.identityId, 250_000n * TRAC),
    ];
    const p = await h.walletFund(f.accounts[20], a, 40n * TRAC);
    await h.scoreEpoch(a, n1, 100n * TRAC);
    await h.claimReceipts(n1, p, 8n * TRAC);

    // The settlement has no step to run first: a claim only reads its views, and
    // all it can write is its wiring and the batches.
    const writes: string[] = [];
    f.QS.interface.forEachFunction((fn) => {
      if (!fn.constant) writes.push(fn.name);
    });
    expect(writes.sort()).to.deep.equal(['initialize', 'setStatus', 'submitReceiptBatch']);

    await h.forward(f.QIS, 'setPaused', [true]);
    await h.toEpoch(a + 48n);
    const n2 = await h.createSeller(1_250_000n * TRAC, 0n);
    const s = await h.split(n1, a);
    expect(s.queryInference).to.equal(40n * TRAC);
    const scores = [
      await h.positionScore(t[0], n1, a),
      await h.positionScore(t[1], n1, a),
      await h.positionScore(t[2], n1, a),
    ];
    const rewards = scores.map((score) => (score * s.net) / s.nodeScore);
    expect(rewards.every((reward) => reward > 0n)).to.equal(true);

    // A redelegation needs the claim before it, as ever, and nothing else.
    await expect(f.StakingNFT.connect(d[0]).redelegate(t[0], n2.identityId)).to.be.revertedWithCustomError(
      f.StakingV10,
      'UnclaimedEpochs',
    );
    expect(await h.claim(d[0], t[0])).to.equal(rewards[0]);
    await f.StakingNFT.connect(d[0]).redelegate(t[0], n2.identityId);
    expect((await f.Vault.getPosition(t[0])).identityId).to.equal(n2.identityId);

    // A withdrawal claims first, and pays the stake with the reward compounded in.
    const paidOut = 250_000n * TRAC + rewards[1];
    await expect(f.StakingNFT.connect(d[1]).withdraw(t[1])).to.changeTokenBalances(
      f.Token,
      [d[1].address, await h.vault()],
      [paidOut, -paidOut],
    );

    // So does a relock need only a claim, which anyone can make.
    await f.StakingV10.connect(f.accounts[25]).claimFor(t[2]);
    expect((await f.Vault.getPosition(t[2])).raw).to.equal(250_000n * TRAC + rewards[2]);
    await f.StakingNFT.connect(d[2]).relock(t[2], 0n);
    expect((await f.Vault.getPosition(await f.StakingNFT.nextTokenId())).raw).to.equal(250_000n * TRAC + rewards[2]);
  });

  it('conservation: the vault receives every wallet payment and holds every TRAC the claims credit', async () => {
    const a = await h.epochNow();
    const n1 = await h.createSeller(1_250_000n * TRAC, 1_000n);
    const n2 = await h.createSeller(800_000n * TRAC, 500n);
    const nodes = [n1, n2];
    const d = [f.accounts[10], f.accounts[11], f.accounts[12]];
    const t = [
      await h.delegate(d[0], n1.identityId, 300_000n * TRAC),
      await h.delegate(d[1], n1.identityId, 120_000n * TRAC),
      await h.delegate(d[2], n2.identityId, 90_000n * TRAC),
    ];
    const positions: Array<[SignerWithAddress, bigint]> = [
      [d[0], t[0]],
      [d[1], t[1]],
      [d[2], t[2]],
      [n1.operational, n1.tokenId],
      [n2.operational, n2.tokenId],
    ];
    const bystanders = [f.SSW, f.QS, f.QIS, f.StakingV10, f.Ledger, f.StakingNFT];
    const slack = async () => (await h.balanceOf(await h.vault())) - (await h.owed(nodes));
    const start = await slack();

    // Both nodes prove in a, as a batch needs.
    await h.scoreEpoch(a, n1, 200n * TRAC);
    await h.scoreEpoch(a, n2, 100n * TRAC);

    // Wallet payments over three subscriptions move into the vault, and nowhere else.
    let funded = 0n;
    const subscriptions: string[][] = [[], []];
    for (const [i, [epoch, value]] of ([
      [a, 37n * TRAC],
      [a, 13n * TRAC],
      [a + 1n, 50n * TRAC],
    ] as const).entries()) {
      if (epoch > (await h.epochNow())) await h.toEpoch(epoch);
      const before = await h.balanceOf(await h.vault());
      subscriptions[Number(epoch - a)].push(await h.walletFund(f.accounts[20 + i], epoch, value));
      expect((await h.balanceOf(await h.vault())) - before).to.equal(value);
      funded += value;
      if (epoch === a) {
        await h.claimReceipts(n1, subscriptions[0][subscriptions[0].length - 1], 6n * TRAC);
        await h.claimReceipts(n2, subscriptions[0][subscriptions[0].length - 1], 4n * TRAC);
      }
    }
    for (const c of bystanders) expect(await h.balanceOf(c), await c.getAddress()).to.equal(0n);
    // The wallet money is not owed to anyone yet: it is the vault's slack.
    expect((await slack()) - start).to.equal(funded);

    // a's subscriptions counted in a; n1 proves in a + 1, and a + 1's subscription counts there.
    await h.scoreEpoch(a + 1n, n1, 150n * TRAC);
    await h.claimReceipts(n1, subscriptions[1][0], 9n * TRAC);
    await h.toEpoch(a + 2n);

    // Claims credit TRAC without moving any: what they credit comes out of the slack.
    const vaultBefore = await h.balanceOf(await h.vault());
    for (const [owner, tokenId] of positions) await h.claim(owner, tokenId);
    expect(await h.balanceOf(await h.vault())).to.equal(vaultBefore);
    const pools = (await f.QS.epochPool(a)) + (await f.QS.epochPool(a + 1n));
    expect(pools).to.equal(funded);
    const credited = funded - ((await slack()) - start);
    expect(credited <= pools).to.equal(true);
    // Only the floors of the splits stay behind: well under a gwei of TRAC.
    expect(pools - credited < 10n ** 9n).to.equal(true);

    // Every credit is paid from the vault: positions withdraw, operators take their fees.
    for (const [owner, tokenId] of positions) await f.StakingNFT.connect(owner).withdraw(tokenId);
    for (const n of nodes) {
      const fee = await f.Vault.getOperatorFeeBalance(n.identityId);
      await f.StakingV10.connect(n.admin).requestOperatorFeeWithdrawal(n.identityId, fee);
    }
    await time.increase(3_600n);
    for (const n of nodes) await f.StakingV10.connect(n.admin).finalizeOperatorFeeWithdrawal(n.identityId);
    expect(await h.owed(nodes)).to.equal(0n);
    expect((await slack()) - start).to.equal(funded - credited);
    for (const c of bystanders) expect(await h.balanceOf(c), await c.getAddress()).to.equal(0n);
  });

  it('StakingKPI reads queryInferenceGross and equals what the claims pay: while the epoch runs, once it has ended, and once its split is recorded', async () => {
    const a = await h.epochNow();
    const n1 = await h.createSeller(1_250_000n * TRAC, 1_500n);
    const d1 = f.accounts[10];
    const t1 = await h.delegate(d1, n1.identityId, 400_000n * TRAC, TIER_12);
    const p = await h.walletFund(f.accounts[20], a, 25n * TRAC);
    await h.scoreEpoch(a, n1, 80n * TRAC);
    await h.claimReceipts(n1, p, 7n * TRAC);
    await h.publishingPool(a, 300n * TRAC);

    const running = await f.KPI.getNetNodeRewards(n1.identityId, a);
    await h.toEpoch(a + 1n);
    const ended = await f.KPI.getNetNodeRewards(n1.identityId, a);
    const score = await h.positionScore(t1, n1, a);
    const paid = await h.claim(d1, t1);
    const recorded = await f.KPI.getNetNodeRewards(n1.identityId, a);
    const s = await h.split(n1, a);

    expect([running, ended, recorded]).to.deep.equal([s.net, s.net, s.net]);
    expect(s.queryInference).to.equal(25n * TRAC);
    expect(s.publishing).to.equal(300n * TRAC);
    expect(s.net).to.equal((325n * TRAC * 85n) / 100n);
    expect(paid).to.equal((score * s.net) / s.nodeScore);
  });

  // -------------------------------------------------------------------------
  // Through reward carries
  // -------------------------------------------------------------------------

  describe("through reward carries, on scores the node's proofs left", () => {
    const keyOf = (tokenId: bigint) => hre.ethers.toBeHex(tokenId, 32);

    /** `node` proves once more in `e`: its score per stake doubles, over the stake now on it. */
    const proveAgain = async (node: Seller, e: bigint) => {
      const index = await f.RSS.getEpochLastScorePerStake(node.identityId, e);
      const added = ((await f.Vault.getNodeEffectiveStake(node.identityId)) * index) / SCALE18;
      await f.RSS.setNodeEpochScorePerStake(e, node.identityId, 2n * index);
      await f.RSS.addToNodeEpochScore(e, node.identityId, added);
      await f.RSS.addToAllNodesEpochScore(e, added);
      return index;
    };

    /** A tier-0 position's score from the proof `proveAgain` added at `index`, which is all it holds on that node. */
    const scoreSince = (raw: bigint, index: bigint) => (raw * index) / SCALE18;

    /** A score's share of what `node` split for `e`. */
    const shareOf = (score: bigint, s: { net: bigint; nodeScore: bigint }) => (score * s.net) / s.nodeScore;

    it("a redelegation: the next claim pays the score on the node left through the carry, from both pools, whichever position splits that node first, with its fee once", async () => {
      const a = await h.epochNow();
      const n1 = await h.createSeller(1_250_000n * TRAC, 1_000n);
      const n2 = await h.createSeller(900_000n * TRAC, 500n);
      const d1 = f.accounts[10];
      const raw = 300_000n * TRAC;
      const t1 = await h.delegate(d1, n1.identityId, raw);
      const e = await h.valueIn(
        a,
        [
          [n1, 30n * TRAC, 300n * TRAC],
          [n2, 20n * TRAC, 200n * TRAC],
        ],
        1_000n * TRAC,
      );
      // Every ended epoch claimed, which a redelegation needs.
      expect(await h.claim(d1, t1)).to.equal(0n);

      // Mid-epoch the position moves to n2, which then proves again.
      const scoreOnN1 = await h.positionScore(t1, n1, e);
      const operatorScore = await h.positionScore(n1.tokenId, n1, e);
      await f.StakingNFT.connect(d1).redelegate(t1, n2.identityId);
      const carries = await f.Vault.getRewardCarries(t1);
      expect(carries.map((c) => [c.identityId, c.epoch, c.delegatorKey])).to.deep.equal([[n1.identityId, e, keyOf(t1)]]);
      expect(await f.RSS.getEpochNodeDelegatorScore(e, n1.identityId, keyOf(t1))).to.equal(scoreOnN1);
      const scoreOnN2 = scoreSince(raw, await proveAgain(n2, e));
      await h.toEpoch(e + 1n);
      const snapshot = await takeSnapshot();

      const run = async (carryFirst: boolean) => {
        // Claiming first, the carry itself splits n1's reward for e.
        if (!carryFirst) await h.claim(n1.operational, n1.tokenId);
        expect(await f.Vault.isOperatorFeeClaimedForEpoch(n1.identityId, e)).to.equal(!carryFirst);
        const paid = await h.claim(d1, t1);
        const operatorPaid = carryFirst ? await h.claim(n1.operational, n1.tokenId) : undefined;
        return { paid, operatorPaid, s1: await h.split(n1, e), s2: await h.split(n2, e) };
      };
      const first = await run(true);
      const { s1, s2 } = first;
      expect(s1.publishing > 0n && s1.queryInference > 0n).to.equal(true);
      expect(s2.publishing > 0n && s2.queryInference > 0n).to.equal(true);
      expect(first.paid).to.equal(shareOf(scoreOnN1, s1) + shareOf(scoreOnN2, s2));
      expect(first.operatorPaid).to.equal(shareOf(operatorScore, s1));
      // One split per node, the fee in it once, and the carry gone.
      expect(await f.Vault.getNetNodeEpochRewards(n1.identityId, e)).to.equal(s1.net);
      expect(await f.Vault.getOperatorFeeBalance(n1.identityId)).to.equal(s1.fee);
      expect(await f.Vault.getNetNodeEpochRewards(n2.identityId, e)).to.equal(s2.net);
      expect(await f.Vault.getOperatorFeeBalance(n2.identityId)).to.equal(s2.fee);
      expect(await f.Vault.getRewardCarries(t1)).to.have.length(0);
      // A later claim pays none of it again.
      await h.toEpoch(e + 2n);
      expect(await h.claim(d1, t1)).to.equal(0n);

      await snapshot.restore();
      const last = await run(false);
      expect(last.paid).to.equal(first.paid);
      expect(await f.Vault.getOperatorFeeBalance(n1.identityId)).to.equal(s1.fee);
      expect(await f.Vault.getRewardCarries(t1)).to.have.length(0);
    });

    it("a relock: the new token's next claim pays the old token's score through the carry and its own as the position, from both pools, on one split", async () => {
      const a = await h.epochNow();
      const n1 = await h.createSeller(1_250_000n * TRAC, 1_000n);
      const d1 = f.accounts[10];
      const raw = 300_000n * TRAC;
      const t1 = await h.delegate(d1, n1.identityId, raw);
      const e = await h.valueIn(a, [[n1, 30n * TRAC, 300n * TRAC]], 1_000n * TRAC);
      expect(await h.claim(d1, t1)).to.equal(0n);

      // Mid-epoch the position relocks to the rest state, under a new token,
      // and the node then proves again.
      const oldScore = await h.positionScore(t1, n1, e);
      await f.StakingNFT.connect(d1).relock(t1, 0n);
      const t2 = await f.StakingNFT.nextTokenId();
      const carries = await f.Vault.getRewardCarries(t2);
      expect(carries.map((c) => [c.identityId, c.epoch, c.delegatorKey])).to.deep.equal([[n1.identityId, e, keyOf(t1)]]);
      expect(await f.RSS.getEpochNodeDelegatorScore(e, n1.identityId, keyOf(t1))).to.equal(oldScore);
      const newScore = scoreSince(raw, await proveAgain(n1, e));
      await h.toEpoch(e + 1n);

      const paid = await h.claim(d1, t2);
      const s = await h.split(n1, e);
      expect(s.publishing > 0n && s.queryInference > 0n).to.equal(true);
      expect(paid).to.equal(shareOf(oldScore, s) + shareOf(newScore, s));
      expect(await f.Vault.getNetNodeEpochRewards(n1.identityId, e)).to.equal(s.net);
      expect(await f.Vault.getOperatorFeeBalance(n1.identityId)).to.equal(s.fee);
      expect(await f.Vault.getRewardCarries(t2)).to.have.length(0);
      await h.toEpoch(e + 2n);
      expect(await h.claim(d1, t2)).to.equal(0n);
    });

    it("a relock and then a redelegation: the claim reads the node left only through the carries of both tokens, which split it with both pools", async () => {
      const a = await h.epochNow();
      const n1 = await h.createSeller(1_250_000n * TRAC, 1_000n);
      const n2 = await h.createSeller(900_000n * TRAC, 500n);
      const d1 = f.accounts[10];
      const raw = 300_000n * TRAC;
      const t1 = await h.delegate(d1, n1.identityId, raw);
      const e = await h.valueIn(a, [[n1, 30n * TRAC, 300n * TRAC]], 1_000n * TRAC);
      expect(await h.claim(d1, t1)).to.equal(0n);

      const oldScore = await h.positionScore(t1, n1, e);
      await f.StakingNFT.connect(d1).relock(t1, 0n);
      const t2 = await f.StakingNFT.nextTokenId();
      const newScore = scoreSince(raw, await proveAgain(n1, e));
      await f.StakingNFT.connect(d1).redelegate(t2, n2.identityId);
      const carries = await f.Vault.getRewardCarries(t2);
      expect(carries.map((c) => [c.identityId, c.epoch, c.delegatorKey])).to.deep.equal([
        [n1.identityId, e, keyOf(t1)],
        [n1.identityId, e, keyOf(t2)],
      ]);
      await h.toEpoch(e + 1n);

      // n2 has no proof in e, so the claim's own walk does not touch n1.
      expect(await f.Vault.isOperatorFeeClaimedForEpoch(n1.identityId, e)).to.equal(false);
      const paid = await h.claim(d1, t2);
      const s = await h.split(n1, e);
      expect(s.publishing > 0n && s.queryInference > 0n).to.equal(true);
      expect(paid).to.equal(shareOf(oldScore, s) + shareOf(newScore, s));
      expect(await f.Vault.getNetNodeEpochRewards(n1.identityId, e)).to.equal(s.net);
      expect(await f.Vault.getOperatorFeeBalance(n1.identityId)).to.equal(s.fee);
      expect(await f.Vault.getRewardCarries(t2)).to.have.length(0);
    });
  });

  it('with the activation epoch unset, a claim reads nothing from the pool', async () => {
    const fresh = (await (
      await hre.ethers.getContractFactory('QueryInferenceStorage')
    ).deploy(await f.Hub.getAddress())) as unknown as QueryInferenceStorage;
    await fresh.waitForDeployment();
    await f.Hub.setContractAddress('QueryInferenceStorage', await fresh.getAddress());
    await h.forward(fresh, 'initialize');
    for (const c of [f.QS, f.StakingV10, f.KPI]) await h.forward(c, 'initialize');
    expect(await f.StakingV10.queryInferenceStorage()).to.equal(await fresh.getAddress());

    const a = await h.epochNow();
    const n1 = await h.createSeller(1_250_000n * TRAC, 1_000n);
    const d1 = f.accounts[10];
    const t1 = await h.delegate(d1, n1.identityId, 250_000n * TRAC);
    await h.scoreEpoch(a, n1, 100n * TRAC);
    await h.publishingPool(a, 500n * TRAC);
    await h.toEpoch(a + 40n);

    const s = await h.split(n1, a);
    expect(s.queryInference).to.equal(0n);
    expect(await f.KPI.getNetNodeRewards(n1.identityId, a)).to.equal(s.net);
    const score = await h.positionScore(t1, n1, a);
    const paid = await h.claim(d1, t1);
    expect(paid).to.equal((score * s.net) / s.nodeScore);
    expect(paid).to.be.greaterThan(0n);
    expect(await fresh.activationEpoch()).to.equal(0n);
  });

  it('with the settlement out of the Hub, a batch reverts and a claim pays without the pool, for good, while a node-epoch no claim has split keeps its share', async () => {
    const a = await h.epochNow();
    const n1 = await h.createSeller(1_250_000n * TRAC, 1_000n);
    const n2 = await h.createSeller(1_250_000n * TRAC, 1_000n);
    const [d1, d2] = [f.accounts[10], f.accounts[11]];
    const t1 = await h.delegate(d1, n1.identityId, 250_000n * TRAC);
    const t2 = await h.delegate(d2, n1.identityId, 250_000n * TRAC);
    const e = await h.valueIn(
      a,
      [
        [n1, 30n * TRAC, 300n * TRAC],
        [n2, 10n * TRAC, 100n * TRAC],
      ],
      1_000n * TRAC,
    );
    await h.toEpoch(e + 1n);
    const withPool = await h.split(n1, e);
    expect(withPool.queryInference).to.be.greaterThan(0n);
    // The node's reward with the publishing pool alone, 10% off.
    const publishingNet = (withPool.publishing * 9n) / 10n;
    const publishingFee = withPool.publishing - publishingNet;

    // The switch: StakingV10 and StakingKPI read the Hub at each use.
    await f.Hub.removeContractByName('QueryInferenceSettlement');
    expect(await f.StakingV10.queryInferenceSettlement()).to.equal(hre.ethers.ZeroAddress);
    expect(await f.KPI.queryInferenceSettlement()).to.equal(hre.ethers.ZeroAddress);

    // Funding goes on until the pause, but no batch lands: the storage takes
    // writes only from Hub contracts.
    const p = await h.walletFund(f.accounts[21], e + 1n, 10n * TRAC);
    await h.scoreEpoch(e + 1n, n1, 100n * TRAC);
    await expect(h.claimReceipts(n1, p, 1n * TRAC))
      .to.be.revertedWithCustomError(f.QIS, 'UnauthorizedAccess')
      .withArgs('Only Contracts in Hub');

    // A claim pays without the pool, and fixes the node's split of the epoch.
    expect(await f.KPI.getNetNodeRewards(n1.identityId, e)).to.equal(publishingNet);
    const score1 = await h.positionScore(t1, n1, e);
    expect(await h.claim(d1, t1)).to.equal((score1 * publishingNet) / withPool.nodeScore);
    expect(await f.Vault.getNetNodeEpochRewards(n1.identityId, e)).to.equal(publishingNet);
    expect(await f.Vault.getOperatorFeeBalance(n1.identityId)).to.equal(publishingFee);

    // Registered again, batches land again.
    await f.Hub.setContractAddress('QueryInferenceSettlement', await f.QS.getAddress());
    await h.forward(f.QS, 'initialize');
    expect(await f.StakingV10.queryInferenceSettlement()).to.equal(await f.QS.getAddress());
    await h.claimReceipts(n1, p, 1n * TRAC);

    // That split stays, for good: the node's other position takes its share of
    // it, and the pool's share is never paid.
    expect(await f.QS.queryInferenceGross(e, n1.identityId)).to.equal(withPool.queryInference);
    expect(await f.KPI.getNetNodeRewards(n1.identityId, e)).to.equal(publishingNet);
    const score2 = await h.positionScore(t2, n1, e);
    expect(await h.claim(d2, t2)).to.equal((score2 * publishingNet) / withPool.nodeScore);
    expect(await f.Vault.getNetNodeEpochRewards(n1.identityId, e)).to.equal(publishingNet);
    expect(await f.Vault.getOperatorFeeBalance(n1.identityId)).to.equal(publishingFee);

    // The node no claim split while the settlement was out takes the pool.
    const s2 = await h.split(n2, e);
    expect(s2.queryInference).to.be.greaterThan(0n);
    const operatorScore = await h.positionScore(n2.tokenId, n2, e);
    expect(await h.claim(n2.operational, n2.tokenId)).to.equal((operatorScore * s2.net) / s2.nodeScore);
    expect(await f.Vault.getNetNodeEpochRewards(n2.identityId, e)).to.equal(s2.net);
  });

  it('the pool activates only once StakingV10 reads it: refused under a StakingV10 without that view, as 10.0.4 is, accepted under 10.1.0', async () => {
    const fresh = (await (
      await hre.ethers.getContractFactory('QueryInferenceStorage')
    ).deploy(await f.Hub.getAddress())) as unknown as QueryInferenceStorage;
    await fresh.waitForDeployment();
    await f.Hub.setContractAddress('QueryInferenceStorage', await fresh.getAddress());
    await h.forward(fresh, 'initialize');
    await h.forward(f.QS, 'initialize');
    const now = await h.epochNow();
    const staking = await f.StakingV10.getAddress();
    expect(await f.StakingV10.queryInferenceStorage()).to.equal(await fresh.getAddress());

    // A StakingV10 with no queryInferenceStorage(), as 10.0.4: it would split
    // every epoch from activation on without the pool. A Chronos stands in.
    const epLen = await f.Chronos.epochLength();
    const noView = await (await (await hre.ethers.getContractFactory('Chronos')).deploy(1n, epLen)).getAddress();
    await f.Hub.setContractAddress('StakingV10', noView);
    await expect(h.forward(fresh, 'setActivationEpoch', [now]))
      .to.be.revertedWithCustomError(fresh, 'PoolNotWired')
      .withArgs('StakingV10');
    await f.Hub.setContractAddress('StakingV10', staking);
    await h.forward(fresh, 'setActivationEpoch', [now]);
    expect(await fresh.activationEpoch()).to.equal(now);
  });

  it('a settlement replaced in the Hub serves claims, withdrawals and StakingKPI with neither StakingV10 nor StakingKPI re-initialized', async () => {
    // A new settlement over the same storage, registered and initialized as a
    // logic upgrade is; StakingV10 and StakingKPI are left as they are.
    const fresh = (await (
      await hre.ethers.getContractFactory('QueryInferenceSettlement')
    ).deploy(await f.Hub.getAddress())) as unknown as QueryInferenceSettlement;
    await fresh.waitForDeployment();
    await f.Hub.setContractAddress('QueryInferenceSettlement', await fresh.getAddress());
    await h.forward(fresh, 'initialize');

    const e = await h.epochNow();
    const n1 = await h.createSeller(1_250_000n * TRAC, 1_000n);
    const d1 = f.accounts[10];
    const t1 = await h.delegate(d1, n1.identityId, 200_000n * TRAC);
    const p = await h.walletFund(f.accounts[20], e, 100n * TRAC);
    await h.scoreEpoch(e, n1, 300n * TRAC);
    const { items } = signedItems({
      domain,
      wallet: key,
      subscriptionId: p,
      serviceId: (await f.SSS.getBudget(p, 0n)).serviceId,
      seller: n1.identityId,
      count: 1,
      units: (30n * TRAC) / UNIT_PRICE,
      price: UNIT_PRICE,
      issuedAt: await h.latest(),
    });
    await fresh.connect(n1.operational).submitReceiptBatch([{ subscriptionId: p, budgetIndex: 0n, minCounted: 0n, items }]);
    await h.publishingPool(e, 1_000n * TRAC);
    await h.toEpoch(e + 1n);

    // The claim reads the new settlement and pays both pools.
    const previewed = await f.KPI.getNetNodeRewards(n1.identityId, e);
    const score = await h.positionScore(t1, n1, e);
    const paid = await h.claim(d1, t1);
    const s = await h.split(n1, e);
    expect(s.queryInference).to.equal(100n * TRAC);
    expect(await fresh.queryInferenceGross(e, n1.identityId)).to.equal(100n * TRAC);
    expect(previewed).to.equal(s.net);
    expect(paid).to.equal((score * s.net) / s.nodeScore);

    // A withdrawal an epoch later goes through it too.
    await h.toEpoch(e + 2n);
    await f.StakingNFT.connect(d1).withdraw(t1);
    expect([await f.StakingV10.queryInferenceSettlement(), await f.KPI.queryInferenceSettlement()]).to.deep.equal([
      await fresh.getAddress(),
      await fresh.getAddress(),
    ]);
  });

  it("pays a Conviction Account's money through claims over its whole lock: the commitment is booked once, and the vault keeps only the floors", async () => {
    // A lock of three windows, so the account's whole life and every booking
    // it makes fall inside the run, and a stand-in for KnowledgeAssetsLifecycle,
    // the only caller the publishing NFT's coverPublishingCost admits. With no
    // treasury wired, nothing is booked to it.
    await f.Params.setPublishingConvictionEpochs(3n);
    const kal = f.accounts[5];
    await f.Hub.setContractAddress('KnowledgeAssetsLifecycle', kal.address);
    expect(await f.Params.protocolTreasury()).to.equal(hre.ethers.ZeroAddress);

    const a = await h.epochNow();
    const n1 = await h.createSeller(1_250_000n * TRAC, 1_000n);
    const n2 = await h.createSeller(800_000n * TRAC, 2_000n);
    const nodes = [n1, n2];
    const [d1, d2] = [f.accounts[10], f.accounts[11]];
    const positions: Array<[SignerWithAddress, bigint]> = [
      [d1, await h.delegate(d1, n1.identityId, 300_000n * TRAC)],
      [d2, await h.delegate(d2, n2.identityId, 150_000n * TRAC)],
      [n1.operational, n1.tokenId],
      [n2.operational, n2.tokenId],
    ];
    const slack = async () => (await h.balanceOf(await h.vault())) - (await h.owed(nodes));
    const start = await slack();

    // Both nodes prove in every epoch of the run, once each.
    const scored = new Set<bigint>();
    const scoreAll = async (epoch: bigint) => {
      if (scored.has(epoch)) return;
      scored.add(epoch);
      await h.scoreEpoch(epoch, n1, 200n * TRAC);
      await h.scoreEpoch(epoch, n2, 100n * TRAC);
    };

    // Every transaction of the account, and what each booked in EpochStorage.
    const accountTxs: ContractTransactionReceipt[] = [];
    const send = async (tx: Promise<ContractTransactionResponse>) => {
      const receipt = (await (await tx).wait())!;
      accountTxs.push(receipt);
      return receipt;
    };
    const esAddress = (await f.EpochStorage.getAddress()).toLowerCase();
    const credits = (receipts: ContractTransactionReceipt[], shardId: bigint) =>
      receipts
        .flatMap((r) => r.logs)
        .filter((log) => log.address.toLowerCase() === esAddress)
        .map((log) => f.EpochStorage.interface.parseLog({ topics: [...log.topics], data: log.data }))
        .filter((ev) => ev?.name === 'TokensAddedToEpochRange' && ev.args.shardId === shardId)
        .map((ev) => ({ end: ev!.args.endEpoch as bigint, amount: ev!.args.tokenAmount as bigint }));
    const booked = (receipts: ContractTransactionReceipt[], shardId = STAKER_SHARD_ID) =>
      credits(receipts, shardId).reduce((sum, c) => sum + c.amount, 0n);

    // The account, committed with `committed mod lock` dust; its TRAC moves
    // into the vault now, and nothing is booked yet.
    const [owner, agent, buyer, walletBuyer] = [f.accounts[22], f.accounts[23], f.accounts[24], f.accounts[25]];
    const committed = 30_000n * TRAC + 7n;
    await f.Token.mint(owner.address, committed);
    await f.Token.connect(owner).approve(await f.NFT.getAddress(), committed);
    const vaultBefore = await h.balanceOf(await h.vault());
    const created = await send(f.NFT.connect(owner).createAccount(committed, 0));
    expect((await h.balanceOf(await h.vault())) - vaultBefore).to.equal(committed);
    expect(booked([created])).to.equal(0n);
    const accountId = await f.NFT.totalSupply();
    const account = await f.PCS.getAccount(accountId);
    expect(account.lockDurationEpochs).to.equal(3n);
    const bps = account.discountBps;
    const B = committed / 3n;
    await f.NFT.connect(owner).registerAgent(accountId, agent.address);
    await f.SS.connect(owner).setServiceSpending(accountId, true);
    const terms: Terms = {
      accountId,
      buyer: buyer.address,
      maxCostPerEpoch: 1_000n * TRAC,
      expiresAt: BigInt(await time.latest()) + 400n * DAY,
      nonce: await f.SSS.grantNonce(accountId),
    };
    await f.SS.connect(owner).addBuyer(terms, '0x', await signTerms(buyer, f.SS, terms));
    const accountSubscription = async (epoch: bigint, value: bigint) => {
      await send(
        f.SS.connect(buyer).fundFromAccount(
          requestOf(accountId, epoch, { budgets: [budget(0, CLASS_INFERENCE, value, UNIT_PRICE)], sessionKey: key.address }),
        ),
      );
      return subscriptionIdOf(buyer.address, epoch);
    };
    const settle = async () => send(f.NFT.settle(accountId));
    /** Move time to at least `ts`. */
    const notBefore = async (ts: bigint) => {
      if ((await h.latest()) < ts) await time.increaseTo(ts);
    };

    // Epoch a, the account's first window: a subscription from the account, a
    // wallet subscription beside it, and a publish over 2 epochs. The subscription's cost
    // is booked in a and moves no TRAC; the publish books its spend into the
    // publishing pool. Both nodes prove, and their receipts land.
    const vaultNow = await h.balanceOf(await h.vault());
    const pA = await accountSubscription(a, 20n * TRAC);
    const costA = costOf(20n * TRAC, bps);
    expect(await f.QIS.accountFunding(a)).to.equal(costA);
    expect(await h.balanceOf(await h.vault())).to.equal(vaultNow);
    expect(booked(accountTxs.slice(-1))).to.equal(0n);
    const pW = await h.walletFund(walletBuyer, a, 5n * TRAC);
    const publishCost = costOf(900n * TRAC, bps);
    const published = await send(f.NFT.connect(kal).coverPublishingCost(agent.address, 900n * TRAC, a, 2n));
    expect(booked([published])).to.equal(publishCost);
    expect(await f.QIS.accountFunding(a)).to.equal(costA);
    await scoreAll(a);
    await h.claimReceipts(n1, pA, 6n * TRAC);
    await h.claimReceipts(n2, pA, 3n * TRAC);
    await h.claimReceipts(n2, pW, 5n * TRAC);

    // Epoch a + 1, in which window 0 closes: what it did not spend reaches the
    // publishing pool. The account funds a subscription of a + 1 that sells nothing,
    // so its cost rolls over alone.
    await h.toEpoch(a + 1n);
    await scoreAll(a + 1n);
    await notBefore(account.createdAtTimestamp + (await f.Chronos.epochLength()) + 1n);
    const window0 = await settle();
    expect(booked([window0])).to.equal(B - costA - publishCost);
    expect(await f.PCS.windowSpent(accountId, 0n)).to.equal(costA + publishCost);
    const pB = await accountSubscription(a + 1n, 8n * TRAC);
    const costB = costOf(8n * TRAC, bps);
    expect(pB).to.equal(subscriptionIdOf(buyer.address, a + 1n));
    expect(await f.QIS.accountFunding(a + 1n)).to.equal(costB);

    // Epoch a + 2: window 1 closes with only the subscription's cost spent; a wallet
    // subscription of a + 2 sells, so a + 2 pays the rolled-over account cost too.
    await h.toEpoch(a + 2n);
    await scoreAll(a + 2n);
    const pW2 = await h.walletFund(walletBuyer, a + 2n, 4n * TRAC);
    await h.claimReceipts(n1, pW2, 2n * TRAC);
    await notBefore(account.createdAtTimestamp + 2n * (await f.Chronos.epochLength()) + 1n);
    const window1 = await settle();
    expect(booked([window1])).to.equal(B - costB);

    // Epoch a + 3: the lock ends, and its last window, which carries the dust,
    // is booked with the final sweep.
    await notBefore(account.expiresAtTimestamp + 1n);
    await scoreAll(await h.epochNow());
    const window2 = await settle();
    expect(booked([window2])).to.equal(committed - 2n * B);
    expect((await f.PCS.getAccount(accountId)).fullySwept).to.equal(true);

    // The commitment is booked exactly once: as query/inference cost in the
    // subscription's epoch, into the publishing pool, or to the treasury (nothing, with
    // none wired).
    const costs = (await f.QIS.accountFunding(a)) + (await f.QIS.accountFunding(a + 1n));
    expect(costs).to.equal(costA + costB);
    expect(booked(accountTxs, TREASURY_SHARD_ID)).to.equal(0n);
    expect(booked(accountTxs) + costs).to.equal(committed);

    // Both nodes prove in every epoch the bookings reach, then every position claims.
    const lastEpoch = credits(accountTxs, STAKER_SHARD_ID).reduce((m, c) => (c.end > m ? c.end : m), a);
    expect(lastEpoch).to.be.greaterThan(a + 4n);
    for (let e = (await h.epochNow()) + 1n; e <= lastEpoch; e++) {
      await h.toEpoch(e);
      await scoreAll(e);
    }
    await scoreAll(await h.epochNow());
    await h.toEpoch(lastEpoch + 1n);

    // The KPI reads what the claims then pay: the account cost beside a
    // wallet's in a, the rolled-over account cost in a + 2, and the windows'
    // allowance in the publishing pool after the lock.
    const kpiCases: Array<[Seller, bigint]> = [
      [n1, a],
      [n2, a],
      [n1, a + 2n],
      [n2, lastEpoch],
    ];
    const previewed: bigint[] = [];
    for (const [n, e] of kpiCases) previewed.push(await f.KPI.getNetNodeRewards(n.identityId, e));

    const vaultBeforeClaims = await h.balanceOf(await h.vault());
    for (const [owner_, tokenId] of positions) await h.claim(owner_, tokenId);
    expect(await h.balanceOf(await h.vault())).to.equal(vaultBeforeClaims);
    expect(await f.QS.epochPool(a)).to.equal(costA + 5n * TRAC);
    expect(await f.QS.epochPool(a + 1n)).to.equal(0n);
    expect(await f.QS.epochPool(a + 2n)).to.equal(costB + 4n * TRAC);
    for (const [i, [n, e]] of kpiCases.entries()) {
      expect(await f.Vault.getNetNodeEpochRewards(n.identityId, e), `node ${n.identityId}, epoch ${e}`).to.equal(previewed[i]);
      expect((await h.split(n, e)).net, `node ${n.identityId}, epoch ${e}`).to.equal(previewed[i]);
    }

    // Every credit is paid from the vault: positions withdraw, operators take
    // their fees. The account's commitment and the wallet payments are all
    // paid out but the floors of the splits, which stay in the vault.
    for (const [owner_, tokenId] of positions) await f.StakingNFT.connect(owner_).withdraw(tokenId);
    for (const n of nodes) {
      const fee = await f.Vault.getOperatorFeeBalance(n.identityId);
      await f.StakingV10.connect(n.admin).requestOperatorFeeWithdrawal(n.identityId, fee);
    }
    await time.increase(3_600n);
    for (const n of nodes) await f.StakingV10.connect(n.admin).finalizeOperatorFeeWithdrawal(n.identityId);
    expect(await h.owed(nodes)).to.equal(0n);
    const left = (await slack()) - start;
    expect(left >= 0n, `left ${left}`).to.equal(true);
    expect(left < 10n ** 10n, `left ${left}`).to.equal(true);
    for (const c of [f.SSW, f.SS, f.QS, f.QIS, f.StakingV10, f.Ledger, f.StakingNFT, f.NFT]) {
      expect(await h.balanceOf(c), await c.getAddress()).to.equal(0n);
    }
  });
});
