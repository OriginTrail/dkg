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
} from '../../typechain';

const SCALE18 = 10n ** 18n;
const ONE_AND_HALF_X = (15n * SCALE18) / 10n;
const STAKER_POOL_INDEX = 1n;

type Fixture = {
  accounts: SignerWithAddress[];
  Hub: Hub;
  Token: Token;
  Chronos: Chronos;
  Profile: Profile;
  StakingV10: StakingV10;
  NFT: DKGStakingConvictionNFT;
  CSS: ConvictionStakingStorage;
  RSS: RandomSamplingStorage;
  EpochStorage: EpochStorage;
};

async function deployFixture(): Promise<Fixture> {
  await hre.deployments.fixture([
    'AskStorage',
    'DKGStakingConvictionNFT',
    'StakingV10',
    'Profile',
    'EpochStorage',
    'RandomSampling',
    'RandomSamplingStorage',
  ]);

  const accounts = await hre.ethers.getSigners();
  const Hub = await hre.ethers.getContract<Hub>('Hub');
  await Hub.setContractAddress('HubOwner', accounts[0].address);

  return {
    accounts,
    Hub,
    Token: await hre.ethers.getContract<Token>('Token'),
    Chronos: await hre.ethers.getContract<Chronos>('Chronos'),
    Profile: await hre.ethers.getContract<Profile>('Profile'),
    StakingV10: await hre.ethers.getContract<StakingV10>('StakingV10'),
    NFT: await hre.ethers.getContract<DKGStakingConvictionNFT>('DKGStakingConvictionNFT'),
    CSS: await hre.ethers.getContract<ConvictionStakingStorage>('ConvictionStakingStorage'),
    RSS: await hre.ethers.getContract<RandomSamplingStorage>('RandomSamplingStorage'),
    EpochStorage: await hre.ethers.getContract<EpochStorage>('EpochStorageV8'),
  };
}

async function createProfile(Profile: Profile, operational: SignerWithAddress, admin: SignerWithAddress) {
  const nodeId = `0x${randomBytes(32).toString('hex')}`;
  const tx = await Profile.connect(operational).createProfile(
    admin.address,
    [],
    `Boost expiry repro ${Math.floor(Math.random() * 1_000_000)}`,
    nodeId,
    0,
  );
  const receipt = await tx.wait();
  return Number(receipt!.logs[0].topics[1]);
}

function computeReward(
  effectiveStake: bigint,
  scorePerStake36: bigint,
  epochPool: bigint,
  nodeScore18: bigint,
  allNodesScore18: bigint,
) {
  const delegatorScore18 = (effectiveStake * scorePerStake36) / SCALE18;
  const grossNodeRewards = (epochPool * nodeScore18) / allNodesScore18;
  return (delegatorScore18 * grossNodeRewards) / nodeScore18;
}

describe('@security boost expiry reward boundary', function () {
  it('credits an exact-expiry checkpoint at base rate once the boost has expired', async function () {
    hre.helpers.resetDeploymentsJson();
    const {
      accounts,
      Token,
      Chronos,
      Profile,
      StakingV10,
      NFT,
      CSS,
      RSS,
      EpochStorage,
    } = await loadFixture(deployFixture);

    const staker = accounts[1];
    const admin = accounts[2];
    const identityId = await createProfile(Profile, staker, admin);

    const raw = hre.ethers.parseEther('1000');
    await Token.mint(staker.address, raw);
    await Token.connect(staker).approve(await StakingV10.getAddress(), raw);
    await NFT.connect(staker).createConviction(identityId, raw, 1);

    const pos = await CSS.getPosition(1);
    const expiryTimestamp = pos.expiryTimestamp;
    const expiryEpoch = await Chronos.epochAtTimestamp(expiryTimestamp);

    const scorePerStake36 = hre.ethers.parseEther('0.01');
    const nodeScore18 = hre.ethers.parseEther('100');
    const allNodesScore18 = nodeScore18;
    const epochPool = hre.ethers.parseEther('1000');

    // Simulate a proof scored at exactly the boost-expiry second.
    // RandomSampling.submitProof settles CSS with `<= expiryTimestamp`, so the
    // live stake is base-rate from this timestamp onward; the claim splitter
    // should not treat this checkpoint as boosted.
    await time.setNextBlockTimestamp(Number(expiryTimestamp));
    await RSS.connect(accounts[0]).setNodeEpochScorePerStake(
      expiryEpoch,
      identityId,
      scorePerStake36,
    );
    const checkpoint = await RSS.getEpochCheckpoint(identityId, expiryEpoch, 0);
    expect(checkpoint.timestamp).to.equal(expiryTimestamp);

    await RSS.connect(accounts[0]).setNodeEpochScore(expiryEpoch, identityId, nodeScore18);
    await RSS.connect(accounts[0]).setAllNodesEpochScore(expiryEpoch, allNodesScore18);
    await EpochStorage.connect(accounts[0]).addTokensToEpochRange(
      STAKER_POOL_INDEX,
      expiryEpoch,
      expiryEpoch,
      epochPool,
    );

    const baseRateReward = computeReward(
      raw,
      scorePerStake36,
      epochPool,
      nodeScore18,
      allNodesScore18,
    );
    const boostedReward = computeReward(
      (raw * ONE_AND_HALF_X) / SCALE18,
      scorePerStake36,
      epochPool,
      nodeScore18,
      allNodesScore18,
    );

    expect(boostedReward).to.be.gt(baseRateReward);

    await Token.mint(await CSS.getAddress(), boostedReward);

    const nextEpochStart = await Chronos.timestampForEpoch(expiryEpoch + 1n);
    await time.increaseTo(Number(nextEpochStart) + 1);

    await expect(NFT.connect(staker).claim(1))
      .to.emit(StakingV10, 'RewardsClaimed')
      .withArgs(1n, baseRateReward);

    expect((await CSS.getPosition(1)).raw).to.equal(raw + baseRateReward);
  });
});
