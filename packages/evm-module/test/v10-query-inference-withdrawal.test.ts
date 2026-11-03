// A withdrawal mid-epoch through StakingV10 10.1.0 claims, with the
// query/inference pool (OT-RFC-27), end to end on the development deploy of
// the staking, account and plan-period stacks (StakingV10 and StakingKPI
// wired to the settlement, the activation epoch at the deployment epoch,
// λ 0.5): once the epoch in progress has ended, the withdrawn position's
// share of both pools, its carries of that epoch included, is claimed for
// the staker the withdrawal paid, once: the score the position had earned by
// its withdrawal over the node's score at the end of the epoch, so with no
// proof after it exactly what staying would have paid, while proofs after
// it, which RandomSampling scores over the stake left, add to the positions
// still staked alone; and the node's other positions are as they were.

import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { loadFixture, mine, takeSnapshot, time } from '@nomicfoundation/hardhat-network-helpers';
import { expect } from 'chai';
import hre from 'hardhat';

import {
  CGWeightTreeStorage,
  ContextGraphStorage,
  ContextGraphValueStorage,
  DKGKnowledgeAssets,
  RandomSampling,
} from '../typechain';
import { TRAC } from './helpers/conviction-service';
import { SCALE18, hardhatWallet, queryInferenceDomain } from './helpers/query-inference';
import { RewardsContext, Seller, TIER_12, deployRewardsStack, rewardsHelpers } from './helpers/query-inference-rewards';

/** This suite's own fixture, so loadFixture keeps a snapshot for it alone. */
async function deployFixture() {
  return deployRewardsStack();
}

type Fixture = Awaited<ReturnType<typeof deployFixture>>;

describe('@integration Query/inference rewards through StakingV10 claims', function () {
  let f: Fixture;
  const ctx = { key: hardhatWallet(60) } as RewardsContext;

  beforeEach(async () => {
    hre.helpers.resetDeploymentsJson();
    f = ctx.f = await loadFixture(deployFixture);
    ctx.domain = await queryInferenceDomain(f.QIS);
    ctx.nextAccount = 30;
  });

  const {
    epochNow,
    toEpoch,
    forward,
    vault,
    balanceOf,
    delegate,
    createSeller,
    walletFund,
    claimReceipts,
    finalizeIn,
    publishingPool,
    split,
    positionScore,
    claim,
    owed,
  } = rewardsHelpers(ctx);

  // -------------------------------------------------------------------------
  // A withdrawal mid-epoch: the epoch in progress, claimed once it has ended
  // -------------------------------------------------------------------------

  describe('a withdrawal leaves the epoch in progress claimable', () => {
    /**
     * Value for the nodes of `values` in the epoch after `a`: one wallet
     * period of `a`, whose receipts each node claims and finalizes there at
     * its score, and a publishing pool of `pool` there. Ends inside that
     * epoch, which it returns.
     */
    const valueIn = async (a: bigint, values: Array<[Seller, bigint, bigint]>, pool: bigint) => {
      const p = await walletFund(f.accounts[20], a, 100n * TRAC);
      for (const [s, value] of values) await claimReceipts(s, p, value);
      await finalizeIn(
        a,
        [p],
        values.map(([s, , score]) => [s, score] as [Seller, bigint]),
      );
      await publishingPool(a + 1n, pool);
      return a + 1n;
    };

    const claimWithdrawn = async (tokenId: bigint, to: SignerWithAddress) => {
      const before = await balanceOf(to.address);
      await f.StakingV10.connect(f.accounts[25]).claimWithdrawnEpoch(tokenId);
      return (await balanceOf(to.address)) - before;
    };

    it("pays a node's only position, withdrawn mid-epoch, its share of both pools once the epoch has ended, and once only", async () => {
      const a = await epochNow();
      const n1 = await createSeller(1_250_000n * TRAC, 1_000n);
      const slack = async () => (await balanceOf(await vault())) - (await owed([n1]));
      const start = await slack();
      const e = await valueIn(a, [[n1, 30n * TRAC, 300n * TRAC]], 1_000n * TRAC);
      const score = await positionScore(n1.tokenId, n1, e);
      expect(score).to.be.greaterThan(0n);

      // The withdrawal pays the stake and every ended epoch now.
      const raw = (await f.Vault.getPosition(n1.tokenId)).raw;
      await expect(f.StakingNFT.connect(n1.operational).withdraw(n1.tokenId)).to.changeTokenBalances(
        f.Token,
        [n1.operational.address],
        [raw],
      );
      // The epoch in progress is claimed once it has ended, not before.
      await expect(f.StakingV10.claimWithdrawnEpoch(n1.tokenId))
        .to.be.revertedWithCustomError(f.StakingV10, 'WithdrawnEpochInProgress')
        .withArgs(n1.tokenId, e);
      await toEpoch(e + 1n);
      const paid = await claimWithdrawn(n1.tokenId, n1.operational);
      const s = await split(n1, e);
      expect([s.publishing, s.queryInference]).to.deep.equal([1_000n * TRAC, 100n * TRAC]);
      expect(paid).to.equal((score * s.net) / s.nodeScore);
      expect(paid).to.be.greaterThan(0n);
      await expect(f.StakingV10.claimWithdrawnEpoch(n1.tokenId))
        .to.be.revertedWithCustomError(f.StakingV10, 'NoWithdrawnEpoch')
        .withArgs(n1.tokenId);

      // The operator takes its fee; of both pools the vault keeps only the floors of the split.
      expect(await f.Vault.getOperatorFeeBalance(n1.identityId)).to.equal(s.fee);
      await f.StakingV10.connect(n1.admin).requestOperatorFeeWithdrawal(n1.identityId, s.fee);
      await time.increase(3_600n);
      await f.StakingV10.connect(n1.admin).finalizeOperatorFeeWithdrawal(n1.identityId);
      expect(await owed([n1])).to.equal(0n);
      const left = (await slack()) - start;
      expect(left >= 0n && left < 10n ** 9n, `left ${left}`).to.equal(true);
    });

    it('with no proof after the withdrawal, pays exactly what staying to the end of the epoch and claiming then would have, in both pools', async () => {
      const a = await epochNow();
      const n1 = await createSeller(1_250_000n * TRAC, 1_000n);
      const d1 = f.accounts[10];
      const t1 = await delegate(d1, n1.identityId, 300_000n * TRAC);
      const e = await valueIn(a, [[n1, 30n * TRAC, 300n * TRAC]], 1_000n * TRAC);
      // Every ended epoch claimed, so a claim after e reads e alone.
      await claim(d1, t1);
      const snapshot = await takeSnapshot();

      await toEpoch(e + 1n);
      const stayed = await claim(d1, t1);
      const s = await split(n1, e);
      expect(s.publishing > 0n && s.queryInference > 0n).to.equal(true);
      expect(stayed).to.be.greaterThan(0n);

      await snapshot.restore();
      await f.StakingNFT.connect(d1).withdraw(t1);
      await toEpoch(e + 1n);
      expect(await claimWithdrawn(t1, d1)).to.equal(stayed);
    });

    /**
     * RandomSampling registered and initialized on the Hub, as the
     * development deploy does, and one public knowledge asset of a single
     * leaf in a context graph valued from the current epoch, the only one the
     * value-weighted draw can pick. Returns a proof of it by `node`: a
     * challenge and its proof in the next proof period, which RandomSampling
     * scores over the node's effective stake at that time.
     */
    const realProofs = async () => {
      const noPrivateData = hre.ethers.keccak256(hre.ethers.toUtf8Bytes('DKG_NO_PRIVATE_DATA_V10'));
      const content = hre.ethers.toUtf8Bytes('a withdrawal in the epoch in progress');
      const root = hre.ethers.keccak256(hre.ethers.concat([hre.ethers.keccak256(content), noPrivateData]));
      const owner = f.accounts[0];
      const rs = (await (
        await hre.ethers.getContractFactory('RandomSampling')
      ).deploy(await f.Hub.getAddress())) as unknown as RandomSampling;
      await rs.waitForDeployment();
      await f.Hub.setContractAddress('RandomSampling', await rs.getAddress());
      await forward(rs, 'initialize');
      const tree = (await hre.ethers.getContractAt(
        'CGWeightTreeStorage',
        await f.Hub.getContractAddress('CGWeightTreeStorage'),
      )) as unknown as CGWeightTreeStorage;
      const graphs = (await hre.ethers.getContractAt(
        'ContextGraphStorage',
        await f.Hub.getAssetStorageAddress('ContextGraphStorage'),
      )) as unknown as ContextGraphStorage;
      const assets = (await hre.ethers.getContractAt(
        'DKGKnowledgeAssets',
        await f.Hub.getAssetStorageAddress('DKGKnowledgeAssets'),
      )) as unknown as DKGKnowledgeAssets;
      const values = (await hre.ethers.getContractAt(
        'ContextGraphValueStorage',
        await f.Hub.getContractAddress('ContextGraphValueStorage'),
      )) as unknown as ContextGraphValueStorage;
      await tree.finishBackfill();
      const [publicAccess, openPublishing] = [0, 1];
      await graphs.createContextGraph(
        owner.address,
        [],
        0n,
        publicAccess,
        openPublishing,
        hre.ethers.ZeroAddress,
        0n,
        hre.ethers.ZeroHash,
      );
      const graph = await graphs.getLatestContextGraphId();
      const now = await epochNow();
      const asset = (BigInt(owner.address) << 96n) | 1n;
      await assets.createKnowledgeAsset(
        owner.address,
        owner.address,
        asset,
        'withdrawal',
        root,
        1n,
        128n,
        now,
        now + 5n,
        0n,
        false,
        1n,
      );
      await graphs.registerKnowledgeAssetToContextGraph(graph, asset);
      await values.addCGValueForEpochRange(graph, now, 5n, 1_000n);
      await tree.settle(graph);
      return async (node: Seller) => {
        await mine(await rs.getActiveProofingPeriodDurationInBlocks());
        await rs.updateAndGetActiveProofPeriodStartBlock();
        await rs.connect(node.operational).createChallenge();
        await rs.connect(node.operational).submitProof(content, [noPrivateData]);
      };
    };

    it("with later proofs scored by RandomSampling over the stake left, pays the withdrawn position a quarter of both pools' net for a quarter of the node's final score, and the position still staked three quarters", async () => {
      const a = await epochNow();
      // The node's own tier-0 position and a tier-3 one at 2x, of 3.2M
      // effective stake each: 6.4M together, above the 5M cap of the score's
      // stake factor, and 3.2M, 64% of the cap, once the tier-0 position has
      // left, so a proof after the withdrawal scores 0.8 of one before it
      // (the square root of 0.64). Four proofs before the withdrawal give
      // each position half of 4, and five after it give the position still
      // staked 4 more: the node ends with 8, four times the withdrawn
      // position's 2, with no rounding on the way.
      const n1 = await createSeller(3_200_000n * TRAC, 1_000n);
      const d1 = f.accounts[10];
      const t1 = await delegate(d1, n1.identityId, 1_600_000n * TRAC, 3n);
      expect(await f.Vault.getNodeEffectiveStake(n1.identityId)).to.equal(6_400_000n * TRAC);
      const slack = async () => (await balanceOf(await vault())) - (await owed([n1]));
      const start = await slack();
      const p = await walletFund(f.accounts[20], a, 100n * TRAC);
      await claimReceipts(n1, p, 30n * TRAC);

      // Epoch e, in which the node proves, finalizes the period's value, takes
      // a publishing pool and loses its own position, then proves again.
      const e = a + 1n;
      await toEpoch(e);
      const prove = await realProofs();
      for (let i = 0; i < 4; i++) await prove(n1);
      const before = await f.RSS.getNodeEpochScore(e, n1.identityId);
      expect(before).to.be.greaterThan(0n);
      expect(await positionScore(n1.tokenId, n1, e)).to.equal(before / 2n);
      expect(await positionScore(t1, n1, e)).to.equal(before / 2n);
      const deadline = (await f.Chronos.timestampForEpoch(e)) + (await f.QIS.receiptGraceSecondsAt(a));
      await time.increaseTo(deadline + 1n);
      await f.QS.finalizeClaims([{ subscriptionId: p, bucketIndex: 0n, seller: n1.identityId }]);
      await publishingPool(e, 1_000n * TRAC);

      await f.StakingNFT.connect(n1.operational).withdraw(n1.tokenId);
      expect(await f.Vault.getNodeEffectiveStake(n1.identityId)).to.equal(3_200_000n * TRAC);
      const ownKey = hre.ethers.toBeHex(n1.tokenId, 32);
      const withdrawn = await f.RSS.getEpochNodeDelegatorScore(e, n1.identityId, ownKey);
      expect(withdrawn).to.equal(before / 2n);
      for (let i = 0; i < 5; i++) await prove(n1);

      // The later proofs add to the position still staked, by its stake, and
      // not to the withdrawn one, whose score stays frozen.
      const nodeScore = await f.RSS.getNodeEpochScore(e, n1.identityId);
      expect(nodeScore).to.equal(4n * withdrawn);
      expect(await f.RSS.getEpochNodeDelegatorScore(e, n1.identityId, ownKey)).to.equal(withdrawn);
      const staying = await positionScore(t1, n1, e);
      expect(staying).to.equal(3n * withdrawn);
      expect(withdrawn + staying).to.equal(nodeScore);

      await toEpoch(e + 1n);
      const snapshot = await takeSnapshot();
      const run = async (withdrawnFirst: boolean) => {
        const paid = { withdrawn: 0n, staying: 0n };
        if (withdrawnFirst) paid.withdrawn = await claimWithdrawn(n1.tokenId, n1.operational);
        paid.staying = await claim(d1, t1);
        if (!withdrawnFirst) paid.withdrawn = await claimWithdrawn(n1.tokenId, n1.operational);
        await expect(f.StakingV10.claimWithdrawnEpoch(n1.tokenId))
          .to.be.revertedWithCustomError(f.StakingV10, 'NoWithdrawnEpoch')
          .withArgs(n1.tokenId);
        const stored = await f.Vault.getNetNodeEpochRewards(n1.identityId, e);
        return { paid, stored, s: await split(n1, e), left: (await slack()) - start };
      };
      const first = await run(true);
      await snapshot.restore();
      const last = await run(false);

      expect(last.paid).to.deep.equal(first.paid);
      for (const { paid, stored, s, left } of [first, last]) {
        expect(s.nodeScore).to.equal(nodeScore);
        expect(s.publishing > 0n && s.queryInference > 0n).to.equal(true);
        expect(stored).to.equal(s.net);
        expect(paid.withdrawn).to.equal((withdrawn * s.net) / s.nodeScore);
        expect(paid.staying).to.equal((staying * s.net) / s.nodeScore);
        expect(paid.withdrawn).to.equal(s.net / 4n);
        expect(paid.staying).to.equal((3n * s.net) / 4n);
        // Only the floors of the splits stay behind: well under a gwei of TRAC.
        const delegated = paid.withdrawn + paid.staying;
        expect(delegated <= s.net && s.net - delegated < 10n ** 9n, `${delegated} of ${s.net}`).to.equal(true);
        expect(left >= 0n && left < 10n ** 9n, `left ${left}`).to.equal(true);
      }
    });

    it('pays the carries of the epoch too: the score on a node the position left by a redelegation earlier in it', async () => {
      const a = await epochNow();
      const n1 = await createSeller(1_250_000n * TRAC, 1_000n);
      const n2 = await createSeller(900_000n * TRAC, 500n);
      const d1 = f.accounts[10];
      const t1 = await delegate(d1, n1.identityId, 300_000n * TRAC);
      const e = await valueIn(
        a,
        [
          [n1, 30n * TRAC, 300n * TRAC],
          [n2, 20n * TRAC, 200n * TRAC],
        ],
        1_000n * TRAC,
      );
      await claim(d1, t1);
      // Mid-epoch the position moves to n2, which then proves again.
      await f.StakingNFT.connect(d1).redelegate(t1, n2.identityId);
      const carries = await f.Vault.getRewardCarries(t1);
      expect(carries.map((c) => [c.identityId, c.epoch])).to.deep.equal([[n1.identityId, e]]);
      const index = await f.RSS.getEpochLastScorePerStake(n2.identityId, e);
      const effective = await f.Vault.getNodeEffectiveStake(n2.identityId);
      await f.RSS.setNodeEpochScorePerStake(e, n2.identityId, 2n * index);
      await f.RSS.addToNodeEpochScore(e, n2.identityId, (effective * index) / SCALE18);
      await f.RSS.addToAllNodesEpochScore(e, (effective * index) / SCALE18);
      const snapshot = await takeSnapshot();

      await toEpoch(e + 1n);
      const stayed = await claim(d1, t1);

      await snapshot.restore();
      await f.StakingNFT.connect(d1).withdraw(t1);
      await toEpoch(e + 1n);
      const paid = await claimWithdrawn(t1, d1);
      expect(paid).to.equal(stayed);
      // Its share on each node: n1 through the carry, n2 as the position.
      const key = hre.ethers.toBeHex(t1, 32);
      const [s1, s2] = [await split(n1, e), await split(n2, e)];
      const onN1 = ((await f.RSS.getEpochNodeDelegatorScore(e, n1.identityId, key)) * s1.net) / s1.nodeScore;
      const onN2 = ((await f.RSS.getEpochNodeDelegatorScore(e, n2.identityId, key)) * s2.net) / s2.nodeScore;
      expect([onN1 > 0n, onN2 > 0n]).to.deep.equal([true, true]);
      expect(paid).to.equal(onN1 + onN2);
    });

    it('pays the carry of a relock earlier in the epoch too, which moved the position to a new token', async () => {
      const a = await epochNow();
      const n1 = await createSeller(1_250_000n * TRAC, 1_000n);
      const d1 = f.accounts[10];
      const t1 = await delegate(d1, n1.identityId, 300_000n * TRAC);
      const e = await valueIn(a, [[n1, 30n * TRAC, 300n * TRAC]], 1_000n * TRAC);
      await claim(d1, t1);
      // Mid-epoch the position relocks to the rest state, under a new token,
      // and the node then proves again.
      await f.StakingNFT.connect(d1).relock(t1, 0n);
      const t2 = await f.StakingNFT.nextTokenId();
      const [oldKey, newKey] = [hre.ethers.toBeHex(t1, 32), hre.ethers.toBeHex(t2, 32)];
      const carries = await f.Vault.getRewardCarries(t2);
      expect(carries.map((c) => [c.identityId, c.epoch, c.delegatorKey])).to.deep.equal([[n1.identityId, e, oldKey]]);
      const index = await f.RSS.getEpochLastScorePerStake(n1.identityId, e);
      const effective = await f.Vault.getNodeEffectiveStake(n1.identityId);
      await f.RSS.setNodeEpochScorePerStake(e, n1.identityId, 2n * index);
      await f.RSS.addToNodeEpochScore(e, n1.identityId, (effective * index) / SCALE18);
      await f.RSS.addToAllNodesEpochScore(e, (effective * index) / SCALE18);
      const snapshot = await takeSnapshot();

      await toEpoch(e + 1n);
      const stayed = await claim(d1, t2);

      await snapshot.restore();
      await f.StakingNFT.connect(d1).withdraw(t2);
      await toEpoch(e + 1n);
      const paid = await claimWithdrawn(t2, d1);
      expect(paid).to.equal(stayed);
      // Both keys paid on the node: the old token's score through the carry, the new one's as the position.
      const s = await split(n1, e);
      const scores = [
        await f.RSS.getEpochNodeDelegatorScore(e, n1.identityId, oldKey),
        await f.RSS.getEpochNodeDelegatorScore(e, n1.identityId, newKey),
      ];
      expect(scores.map((x) => x > 0n)).to.deep.equal([true, true]);
      expect(paid).to.equal((scores[0] * s.net) / s.nodeScore + (scores[1] * s.net) / s.nodeScore);
    });

    it("leaves the node's other positions as they were: each claims what it would have", async () => {
      const a = await epochNow();
      const n1 = await createSeller(1_250_000n * TRAC, 1_000n);
      const [d1, d2] = [f.accounts[10], f.accounts[11]];
      const t1 = await delegate(d1, n1.identityId, 300_000n * TRAC);
      const t2 = await delegate(d2, n1.identityId, 120_000n * TRAC, TIER_12);
      const e = await valueIn(a, [[n1, 30n * TRAC, 300n * TRAC]], 1_000n * TRAC);
      for (const [owner, tokenId] of [
        [d1, t1],
        [d2, t2],
        [n1.operational, n1.tokenId],
      ] as Array<[SignerWithAddress, bigint]>) {
        await claim(owner, tokenId);
      }
      const snapshot = await takeSnapshot();

      await toEpoch(e + 1n);
      const stayed = [await claim(d1, t1), await claim(d2, t2), await claim(n1.operational, n1.tokenId)];
      const fee = await f.Vault.getOperatorFeeBalance(n1.identityId);

      await snapshot.restore();
      await f.StakingNFT.connect(d1).withdraw(t1);
      await toEpoch(e + 1n);
      const left = [await claimWithdrawn(t1, d1), await claim(d2, t2), await claim(n1.operational, n1.tokenId)];
      expect(left).to.deep.equal(stayed);
      expect(await f.Vault.getOperatorFeeBalance(n1.identityId)).to.equal(fee);
    });

    it('records nothing for a position with no score in the epoch in progress', async () => {
      const a = await epochNow();
      const n1 = await createSeller(1_250_000n * TRAC, 1_000n);
      const d1 = f.accounts[10];
      const t1 = await delegate(d1, n1.identityId, 300_000n * TRAC);
      // No proof on the node yet in the epoch it withdraws in.
      await toEpoch(a + 1n);
      await f.StakingNFT.connect(d1).withdraw(t1);
      await toEpoch(a + 2n);
      await expect(f.StakingV10.claimWithdrawnEpoch(t1))
        .to.be.revertedWithCustomError(f.StakingV10, 'NoWithdrawnEpoch')
        .withArgs(t1);
    });
  });
});
