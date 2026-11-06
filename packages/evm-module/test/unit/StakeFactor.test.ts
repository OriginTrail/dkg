// The stake factor a receipt batch captures (OT-RFC-27):
// S = sqrt(min(stake, maximumStake) / maximumStake), with 18 decimals, where
// the stake is the lower of the node's live effective stake and the snapshot
// its current proof challenge took, or the live stake with no snapshot.
//
// It equals RandomSampling's formula at zero stake, at the minimum stake, at
// the cap and above it, with and without a snapshot: against a model of that
// formula, and against RandomSampling.calculateNodeScore itself, which for a
// node with no publishing is S × 0.002. RandomSampling keeps its own copy of
// the formula, so a group below compares the two to the wei, through a node
// score that tells every factor apart.

import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { loadFixture, takeSnapshot } from '@nomicfoundation/hardhat-network-helpers';
import { expect } from 'chai';
import hre from 'hardhat';

import { AskStorage, ProfileStorage, RandomSampling } from '../../typechain';
import { deployAccountStack } from '../helpers/account-stack';
import { ACCOUNT_STACK_TAGS, TRAC, registerServiceContracts } from '../helpers/conviction-service';
import { SCALE18, createNode, stakeFactorOf, stakeOn } from '../helpers/query-inference';

async function deployFixture() {
  const stack = await deployAccountStack([...ACCOUNT_STACK_TAGS, 'RandomSampling']);
  const { QS } = await registerServiceContracts(stack.Hub, { settlement: true });
  return {
    ...stack,
    QS: QS!,
    RS: await hre.ethers.getContract<RandomSampling>('RandomSampling'),
    Ask: await hre.ethers.getContract<AskStorage>('AskStorage'),
    ProfileStorage: await hre.ethers.getContract<ProfileStorage>('ProfileStorage'),
  };
}

describe('@unit Stake factor of a receipt batch', () => {
  let f: Awaited<ReturnType<typeof deployFixture>>;
  let cap: bigint;
  let minimum: bigint;
  let next: number;

  beforeEach(async () => {
    hre.helpers.resetDeploymentsJson();
    f = await loadFixture(deployFixture);
    cap = await f.Params.maximumStake();
    minimum = await f.Params.minimumStake();
    next = 40;
  });

  const node = async (stake: bigint, lockTier = 0n) => {
    const operational: SignerWithAddress = f.accounts[next++];
    const admin: SignerWithAddress = f.accounts[next++];
    const identityId = await createNode({ ...f, operational, admin, stake, lockTier });
    return { identityId, operational };
  };

  /** RandomSampling's node score for a node with no publishing: S × 0.002, floored. */
  const scoreOf = (s18: bigint) => (s18 * ((2n * SCALE18) / 1000n)) / SCALE18;

  it('equals the formula at zero stake, the minimum, between, the cap and above it', async () => {
    // A node's raw stake is capped, so effective stake above the cap comes
    // from a lock multiplier: tier 3 is 2x, tier 1 is 1.5x.
    const cases: Array<[bigint, bigint, bigint]> = [
      [0n, 0n, 0n],
      [minimum, 0n, minimum],
      [123_456_789n * 10n ** 15n, 0n, 123_456_789n * 10n ** 15n],
      [cap, 0n, cap],
      [(cap * 2n) / 3n + 1n, 1n, (((cap * 2n) / 3n + 1n) * 3n) / 2n],
      [(cap * 3n) / 5n, 3n, (cap * 6n) / 5n],
    ];
    for (const [raw, tier, effective] of cases) {
      const { identityId } = await node(raw, tier);
      expect(await f.Vault.getNodeEffectiveStake(identityId), `raw ${raw} at tier ${tier}`).to.equal(effective);
      const s18 = await f.QS.stakeFactor(identityId);
      expect(s18, `raw ${raw} at tier ${tier}`).to.equal(stakeFactorOf(effective, cap));
      expect(await f.RS.calculateNodeScore(identityId), `raw ${raw} at tier ${tier}`).to.equal(scoreOf(s18));
    }
    expect(stakeFactorOf(0n, cap)).to.equal(0n);
    expect(stakeFactorOf(minimum, cap)).to.equal(SCALE18 / 10n); // sqrt(50k / 5M) = 0.1
    expect(stakeFactorOf(cap, cap)).to.equal(SCALE18);
    expect(stakeFactorOf(2n * cap, cap)).to.equal(SCALE18);
  });

  // RandomSampling is not part of this upgrade and exposes its factor only inside
  // the node score, S × inner. With all of the epoch's publishing allocation and
  // an ask at the network price, inner is 0.002 + 0.86 + 0.60 = 1.462, so the score
  // is floor(S × 1.462): above 1, it takes a different value for every S, and it
  // equals floor(s18 × 1.462) only if RandomSampling's S is s18 to the wei.
  describe('to the wei, against RandomSampling', () => {
    const INNER18 = (1_462n * SCALE18) / 1_000n;
    const PRICE = 1_000_000n;

    /** `identityId` takes all of the current epoch's allocation, and its ask is the network price. */
    const asTheOnlyPublisher = async (identityId: bigint) => {
      await f.ES.addEpochPublishingAllocation(identityId, await f.Chronos.getCurrentEpoch(), 1_000n);
      await f.Ask.setTotalActiveStake(1n);
      await f.Ask.setWeightedActiveAskSum(PRICE);
      await f.ProfileStorage.setAsk(identityId, PRICE);
    };

    // Raw stake and lock tier; a raw stake above the cap is refused, so effective
    // stake above it comes from the multiplier (tier 3 is 2x, tier 1 is 1.5x).
    const cases = (): Array<[string, bigint, bigint, bigint]> => [
      ['zero', 0n, 0n, 0n],
      ['a single wei, whose ratio floors to 0', 1n, 0n, 1n],
      ['a few wei, whose ratio floors to 2', 12_345_678n, 0n, 12_345_678n],
      ['one TRAC and some wei', TRAC + 7n, 0n, TRAC + 7n],
      ['the minimum', minimum, 0n, minimum],
      ['between, with arbitrary digits', 123_456_789_012_345_678_901n, 0n, 123_456_789_012_345_678_901n],
      ['one wei below the cap', cap - 1n, 0n, cap - 1n],
      ['the cap', cap, 0n, cap],
      ['just above the cap', (cap * 2n) / 3n + 1n, 1n, (((cap * 2n) / 3n + 1n) * 3n) / 2n],
      ['well above the cap', (cap * 3n) / 5n, 3n, (cap * 6n) / 5n],
    ];

    it('the settlement and RandomSampling compute one stake factor at zero, small stakes, the cap and above it', async () => {
      const seen = new Set<bigint>();
      for (const [label, raw, tier, effective] of cases()) {
        const snapshot = await takeSnapshot();
        const { identityId } = await node(raw, tier);
        await asTheOnlyPublisher(identityId);
        expect(await f.Vault.getNodeEffectiveStake(identityId), label).to.equal(effective);
        const s18 = await f.QS.stakeFactor(identityId);
        expect(s18, label).to.equal(stakeFactorOf(effective, cap));
        expect(await f.RS.calculateNodeScore(identityId), label).to.equal((s18 * INNER18) / SCALE18);
        seen.add(s18);
        await snapshot.restore();
      }
      // The comparison has something to tell apart: every stake below the cap
      // but the single wei has its own factor, and the factor stops at the cap.
      expect(seen.has(0n)).to.equal(true);
      expect(seen.has(SCALE18)).to.equal(true);
      expect(seen.size).to.equal(cases().length - 3);
    });

    it('reads the score as S × 1.462: at the cap, where S is exactly 1', async () => {
      const { identityId } = await node(cap);
      await asTheOnlyPublisher(identityId);
      expect(await f.QS.stakeFactor(identityId)).to.equal(SCALE18);
      expect(await f.RS.calculateNodeScore(identityId)).to.equal(INNER18);
    });
  });

  it('without a snapshot, follows the live effective stake, as a proof does', async () => {
    const { identityId, operational } = await node(minimum);
    expect(await f.RSS.nodeChallengeStakeSnapshotSet(identityId)).to.equal(false);
    expect(await f.QS.stakeFactor(identityId)).to.equal(stakeFactorOf(minimum, cap));
    await stakeOn({ ...f, operational }, identityId, 3n * minimum);
    expect(await f.QS.stakeFactor(identityId)).to.equal(stakeFactorOf(4n * minimum, cap));
  });

  it('with a snapshot, takes the lower of it and the live stake: a stake added since lifts nothing', async () => {
    const { identityId, operational } = await node(minimum);
    // The Hub owner stands in for createChallenge, which takes the snapshot.
    await f.RSS.setNodeChallengeStakeSnapshot(identityId, minimum);
    await stakeOn({ ...f, operational }, identityId, cap - minimum);
    expect(await f.Vault.getNodeEffectiveStake(identityId)).to.equal(cap);
    expect(await f.QS.stakeFactor(identityId)).to.equal(stakeFactorOf(minimum, cap));

    // A snapshot above the live stake: the live stake.
    await f.RSS.setNodeChallengeStakeSnapshot(identityId, 10n * cap);
    expect(await f.QS.stakeFactor(identityId)).to.equal(SCALE18);

    // A snapshot of 0 is a snapshot: the factor is 0.
    await f.RSS.setNodeChallengeStakeSnapshot(identityId, 0n);
    expect(await f.QS.stakeFactor(identityId)).to.equal(0n);
  });

  it('a snapshot at the cap, with the live stake above it, gives exactly 1; one below it, its own factor', async () => {
    const { identityId } = await node((cap * 3n) / 5n, 3n);
    await f.RSS.setNodeChallengeStakeSnapshot(identityId, cap);
    expect(await f.QS.stakeFactor(identityId)).to.equal(SCALE18);
    await f.RSS.setNodeChallengeStakeSnapshot(identityId, cap - 1_000n * TRAC);
    expect(await f.QS.stakeFactor(identityId)).to.equal(stakeFactorOf(cap - 1_000n * TRAC, cap));
  });
});
