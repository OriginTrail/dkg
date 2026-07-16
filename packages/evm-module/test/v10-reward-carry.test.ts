// =============================================================================
// V10 — reward-carry regression suite (audit fix, v10.0.3)
// =============================================================================
//
// Mid-epoch `redelegate` flips `pos.identityId`, and `relock` re-keys the
// position under a fresh tokenId. Pre-fix, the delegator score already
// settled in RandomSamplingStorage under the OLD (epoch, identityId,
// delegatorKey) slot was never read again by `StakingV10._claim` (which
// reads only the position's CURRENT node + key) — silently forfeiting up
// to one epoch's rewards.
//
// The fix records a `RewardCarry` pointer in ConvictionStakingStorage at
// redelegate/relock time and integrates matured carries (epoch closed) in
// the next claim, via the same `_nodeEpochReward` math as the main loop.
//
// Scenarios covered:
//   1. redelegate A→B mid-epoch: old-node stint pays out on next claim;
//      immature carries are NOT consumed by a same-epoch claim.
//   2. round-trip A→B→A: the (A, E) carry is skipped (main loop already
//      integrates that slot) — no double-count.
//   3. relock: stint score under the OLD tokenId's key pays out on the
//      NEW tokenId's claim.

import { randomBytes } from 'crypto';

import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { loadFixture, time } from '@nomicfoundation/hardhat-network-helpers';
import { expect } from 'chai';
import hre from 'hardhat';

import {
  Chronos,
  ConvictionStakingStorage,
  DKGStakingConvictionNFT,
  EpochStorage,
  Hub,
  Profile,
  RandomSamplingStorage,
  StakingV10,
  Token,
} from '../typechain';

const SCALE18 = 10n ** 18n;
const SIX_X = 6n * SCALE18;

type Fixture = {
  accounts: SignerWithAddress[];
  Hub: Hub;
  NFT: DKGStakingConvictionNFT;
  StakingV10: StakingV10;
  ConvictionStakingStorage: ConvictionStakingStorage;
  RandomSamplingStorage: RandomSamplingStorage;
  Profile: Profile;
  Token: Token;
  Chronos: Chronos;
  EpochStorage: EpochStorage;
};

async function deployFixture(): Promise<Fixture> {
  await hre.deployments.fixture([
    'DKGStakingConvictionNFT',
    'StakingV10',
    'Profile',
  ]);

  const accounts = await hre.ethers.getSigners();
  const Hub = await hre.ethers.getContract<Hub>('Hub');
  // HubOwner grant lets the test drive privileged storage setters
  // (score injection) directly.
  await Hub.setContractAddress('HubOwner', accounts[0].address);

  return {
    accounts,
    Hub,
    NFT: await hre.ethers.getContract<DKGStakingConvictionNFT>(
      'DKGStakingConvictionNFT',
    ),
    StakingV10: await hre.ethers.getContract<StakingV10>('StakingV10'),
    ConvictionStakingStorage:
      await hre.ethers.getContract<ConvictionStakingStorage>(
        'ConvictionStakingStorage',
      ),
    RandomSamplingStorage:
      await hre.ethers.getContract<RandomSamplingStorage>(
        'RandomSamplingStorage',
      ),
    Profile: await hre.ethers.getContract<Profile>('Profile'),
    Token: await hre.ethers.getContract<Token>('Token'),
    Chronos: await hre.ethers.getContract<Chronos>('Chronos'),
    EpochStorage: await hre.ethers.getContract<EpochStorage>('EpochStorageV8'),
  };
}

describe('@integration V10 — reward carries (redelegate / relock orphan fix)', function () {
  let accounts: SignerWithAddress[];
  let NFT: DKGStakingConvictionNFT;
  let StakingV10Contract: StakingV10;
  let CSS: ConvictionStakingStorage;
  let RSS: RandomSamplingStorage;
  let ProfileContract: Profile;
  let Token: Token;
  let ChronosContract: Chronos;
  let EpochStorageContract: EpochStorage;

  beforeEach(async () => {
    hre.helpers.resetDeploymentsJson();
    const fixture = await loadFixture(deployFixture);
    ({ accounts, NFT, Token } = fixture);
    StakingV10Contract = fixture.StakingV10;
    CSS = fixture.ConvictionStakingStorage;
    RSS = fixture.RandomSamplingStorage;
    ProfileContract = fixture.Profile;
    ChronosContract = fixture.Chronos;
    EpochStorageContract = fixture.EpochStorage;
    nextOperational = 1;
  });

  // One operational signer per profile — the identity registry rejects a
  // second profile under the same operational key.
  let nextOperational = 1;
  const createProfile = async () => {
    const nodeId = '0x' + randomBytes(32).toString('hex');
    const tx = await ProfileContract.connect(
      accounts[nextOperational++],
    ).createProfile(
      accounts[0].address,
      [],
      `Node ${Math.floor(Math.random() * 1_000_000)}`,
      nodeId,
      0,
    );
    const receipt = await tx.wait();
    const identityId = Number(receipt!.logs[0].topics[1]);
    return { nodeId, identityId };
  };

  const mintAndApprove = async (staker: SignerWithAddress, amount: bigint) => {
    await Token.mint(staker.address, amount);
    await Token.connect(staker).approve(
      await StakingV10Contract.getAddress(),
      amount,
    );
  };

  // Inject the full reward surface for `(epoch, identityId)`:
  // score-per-stake (drives delegator settlement), node score +
  // all-nodes score (drives the pool split), and the epoch pool itself.
  const injectEpochRewards = async (
    epoch: bigint,
    identityId: number,
    scorePerStake36: bigint,
    nodeScore18: bigint,
    allNodesScore18: bigint,
    epochPool: bigint,
  ) => {
    if (scorePerStake36 > 0n) {
      await RSS.connect(accounts[0]).setNodeEpochScorePerStake(
        epoch,
        identityId,
        scorePerStake36,
      );
    }
    await RSS.connect(accounts[0]).setNodeEpochScore(
      epoch,
      identityId,
      nodeScore18,
    );
    await RSS.connect(accounts[0]).setAllNodesEpochScore(
      epoch,
      allNodesScore18,
    );
    await EpochStorageContract.connect(accounts[0]).addTokensToEpochRange(
      1,
      epoch,
      epoch,
      epochPool,
    );
  };

  // --------------------------------------------------------------------------
  // Test 1 — redelegate orphan regression + immature-carry protection
  // --------------------------------------------------------------------------
  it('redelegate mid-epoch: old-node stint score pays out on the next claim (was silently forfeited)', async () => {
    const { identityId: nodeA } = await createProfile();
    const { identityId: nodeB } = await createProfile();

    const amount = hre.ethers.parseEther('1000');
    await mintAndApprove(accounts[0], amount);
    await NFT.connect(accounts[0]).createConviction(nodeA, amount, 12);

    const epochE = await ChronosContract.getCurrentEpoch();

    // Node A earns score while the position is staked on it.
    const scorePerStake36 = hre.ethers.parseEther('0.001'); // 1e15
    const nodeScore18 = hre.ethers.parseEther('100');
    const epochPool = hre.ethers.parseEther('1000');
    await injectEpochRewards(
      epochE,
      nodeA,
      scorePerStake36,
      nodeScore18,
      nodeScore18,
      epochPool,
    );

    // Mid-epoch redelegate A→B. Pre-fix this stranded the settled score.
    await expect(NFT.connect(accounts[0]).redelegate(1, nodeB))
      .to.emit(CSS, 'RewardCarryAdded')
      .withArgs(
        1n,
        BigInt(nodeA),
        epochE,
        hre.ethers.zeroPadValue(hre.ethers.toBeHex(1), 32),
      );

    const carries = await CSS.getRewardCarries(1);
    expect(carries.length).to.equal(1);
    expect(carries[0].identityId).to.equal(BigInt(nodeA));
    expect(carries[0].epoch).to.equal(epochE);

    // Same-epoch claim is a no-op: the carry is immature (epoch still
    // open) and must survive untouched.
    const posBefore = await CSS.getPosition(1);
    await NFT.connect(accounts[0]).claim(1);
    expect((await CSS.getRewardCarries(1)).length).to.equal(1);
    expect((await CSS.getPosition(1)).raw).to.equal(posBefore.raw);

    // Close the epoch and claim. The carry matures and pays the A-stint.
    const epochLength = await ChronosContract.epochLength();
    await time.increase(Number(epochLength));

    // Expected: full settled stint on A (6x boosted, pre-expiry).
    const effStake = (amount * SIX_X) / SCALE18;
    const delegatorScore18 = (effStake * scorePerStake36) / SCALE18;
    const grossNodeRewards = (epochPool * nodeScore18) / nodeScore18; // single node
    const expectedReward = (delegatorScore18 * grossNodeRewards) / nodeScore18;
    expect(expectedReward).to.be.greaterThan(0n);

    await expect(NFT.connect(accounts[0]).claim(1))
      .to.emit(StakingV10Contract, 'RewardsClaimed')
      .withArgs(1n, expectedReward)
      .and.to.emit(CSS, 'RewardCarriesCleared');

    const pos = await CSS.getPosition(1);
    expect(pos.raw).to.equal(amount + expectedReward);
    expect(pos.identityId).to.equal(BigInt(nodeB));
    expect((await CSS.getRewardCarries(1)).length).to.equal(0);
  });

  // --------------------------------------------------------------------------
  // Test 2 — round-trip A→B→A: no double-count
  // --------------------------------------------------------------------------
  it('round-trip A→B→A in one epoch: the (A, E) slot is integrated exactly once', async () => {
    const { identityId: nodeA } = await createProfile();
    const { identityId: nodeB } = await createProfile();

    const amount = hre.ethers.parseEther('1000');
    await mintAndApprove(accounts[0], amount);
    await NFT.connect(accounts[0]).createConviction(nodeA, amount, 12);

    const epochE = await ChronosContract.getCurrentEpoch();

    const scorePerStake36 = hre.ethers.parseEther('0.001');
    const nodeScore18 = hre.ethers.parseEther('100');
    const epochPool = hre.ethers.parseEther('1000');
    await injectEpochRewards(
      epochE,
      nodeA,
      scorePerStake36,
      nodeScore18,
      nodeScore18,
      epochPool,
    );

    // Hop 1: A→B records a carry for (A, E).
    await NFT.connect(accounts[0]).redelegate(1, nodeB);
    expect((await CSS.getRewardCarries(1)).length).to.equal(1);

    // Hop 2: B→A. Node B never advanced score-per-stake, so the settled
    // B-score is 0 and NO carry is recorded for (B, E).
    await NFT.connect(accounts[0]).redelegate(1, nodeA);
    expect((await CSS.getRewardCarries(1)).length).to.equal(1);

    const epochLength = await ChronosContract.epochLength();
    await time.increase(Number(epochLength));

    // The main claim loop integrates the (E, A, key) slot (position is
    // back on A); the (A, E) carry MUST be skipped or the stint would be
    // paid twice.
    const effStake = (amount * SIX_X) / SCALE18;
    const delegatorScore18 = (effStake * scorePerStake36) / SCALE18;
    const expectedReward = (delegatorScore18 * epochPool) / nodeScore18;

    await expect(NFT.connect(accounts[0]).claim(1))
      .to.emit(StakingV10Contract, 'RewardsClaimed')
      .withArgs(1n, expectedReward);

    const pos = await CSS.getPosition(1);
    expect(pos.raw).to.equal(amount + expectedReward);
    expect((await CSS.getRewardCarries(1)).length).to.equal(0);
  });

  // --------------------------------------------------------------------------
  // Test 3 — relock: stint score under the old tokenId's key is carried
  // --------------------------------------------------------------------------
  it('relock mid-epoch: stint score under the OLD tokenId key pays out on the new tokenId claim', async () => {
    const { identityId: nodeA } = await createProfile();

    const amount = hre.ethers.parseEther('1000');
    await mintAndApprove(accounts[0], amount);
    // Tier 0 — rest state (1x, no lock) so relock is allowed immediately.
    await NFT.connect(accounts[0]).createConviction(nodeA, amount, 0);

    const epochE = await ChronosContract.getCurrentEpoch();

    const scorePerStake36 = hre.ethers.parseEther('0.001');
    const nodeScore18 = hre.ethers.parseEther('100');
    const epochPool = hre.ethers.parseEther('1000');
    await injectEpochRewards(
      epochE,
      nodeA,
      scorePerStake36,
      nodeScore18,
      nodeScore18,
      epochPool,
    );

    // Burn-mint relock tokenId 1 → 2 under tier 12. The settled stint
    // lives under key bytes32(1); the new position claims under
    // bytes32(2) and pre-fix would never see it.
    await expect(NFT.connect(accounts[0]).relock(1, 12))
      .to.emit(CSS, 'RewardCarryAdded')
      .withArgs(
        2n,
        BigInt(nodeA),
        epochE,
        hre.ethers.zeroPadValue(hre.ethers.toBeHex(1), 32),
      );

    const epochLength = await ChronosContract.epochLength();
    await time.increase(Number(epochLength));

    // Tier-0 stint → 1x effective stake.
    const delegatorScore18 = (amount * scorePerStake36) / SCALE18;
    const expectedReward = (delegatorScore18 * epochPool) / nodeScore18;
    expect(expectedReward).to.be.greaterThan(0n);

    await expect(NFT.connect(accounts[0]).claim(2))
      .to.emit(StakingV10Contract, 'RewardsClaimed')
      .withArgs(2n, expectedReward);

    const pos = await CSS.getPosition(2);
    expect(pos.raw).to.equal(amount + expectedReward);
    expect((await CSS.getRewardCarries(2)).length).to.equal(0);
  });
});
