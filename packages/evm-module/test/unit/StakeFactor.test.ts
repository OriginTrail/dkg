// The stake factor a receipt batch captures (OT-RFC-27):
// S = sqrt(min(stake, maximumStake) / maximumStake), with 18 decimals, where
// the stake is the lower of the node's live effective stake and the snapshot
// its current proof challenge took, or the live stake with no snapshot.
//
// It equals RandomSampling's formula at zero stake, at the minimum stake, at
// the cap and above it, with and without a snapshot: against a model of that
// formula, and against RandomSampling.calculateNodeScore itself, which for a
// node with no publishing is S × 0.002.

import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers';
import { expect } from 'chai';
import hre from 'hardhat';

import {
  ConvictionStakingStorage,
  DKGStakingConvictionNFT,
  Hub,
  ParametersStorage,
  Profile,
  QueryInferenceSettlement,
  RandomSampling,
  RandomSamplingStorage,
  StakingV10,
  Token,
} from '../../typechain';
import { ACCOUNT_STACK_TAGS, TRAC, registerServiceContracts } from '../helpers/conviction-service';
import { SCALE18, createNode, stakeFactorOf, stakeOn } from '../helpers/query-inference';

async function deployFixture() {
  await hre.deployments.fixture([...ACCOUNT_STACK_TAGS, 'RandomSampling']);
  const Hub = await hre.ethers.getContract<Hub>('Hub');
  const { QS } = await registerServiceContracts(Hub, { settlement: true });
  return {
    accounts: await hre.ethers.getSigners(),
    QS: QS!,
    Token: await hre.ethers.getContract<Token>('Token'),
    Profile: await hre.ethers.getContract<Profile>('Profile'),
    StakingV10: await hre.ethers.getContract<StakingV10>('StakingV10'),
    StakingNFT: await hre.ethers.getContract<DKGStakingConvictionNFT>('DKGStakingConvictionNFT'),
    RSS: await hre.ethers.getContract<RandomSamplingStorage>('RandomSamplingStorage'),
    RS: await hre.ethers.getContract<RandomSampling>('RandomSampling'),
    Params: await hre.ethers.getContract<ParametersStorage>('ParametersStorage'),
    Vault: await hre.ethers.getContract<ConvictionStakingStorage>('ConvictionStakingStorage'),
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
