import { randomBytes } from 'crypto';

import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers';
import { expect } from 'chai';
import hre from 'hardhat';

import {
  Token,
  Profile,
  StakingStorage,
  ParametersStorage,
  ProfileStorage,
  ShardingTable,
  ShardingTableStorage,
  AskStorage,
  Hub,
  Chronos,
  RandomSamplingStorage,
  RandomSampling,
  EpochStorage,
  DelegatorsInfo,
  ConvictionStaking,
  ConvictionStakeStorage,
} from '../../typechain';

type Fixture = {
  accounts: SignerWithAddress[];
  Token: Token;
  Profile: Profile;
  ConvictionStaking: ConvictionStaking;
  ConvictionStakeStorage: ConvictionStakeStorage;
  StakingStorage: StakingStorage;
  ParametersStorage: ParametersStorage;
  ProfileStorage: ProfileStorage;
  ShardingTable: ShardingTable;
  ShardingTableStorage: ShardingTableStorage;
  AskStorage: AskStorage;
  Hub: Hub;
  Chronos: Chronos;
  RandomSamplingStorage: RandomSamplingStorage;
  RandomSampling: RandomSampling;
  EpochStorage: EpochStorage;
  DelegatorsInfo: DelegatorsInfo;
};

async function deployFixture(): Promise<Fixture> {
  await hre.deployments.fixture([
    'Profile',
    'ConvictionStaking',
    'ConvictionStakeStorage',
    'RandomSampling',
    'EpochStorage',
    'Chronos',
    'RandomSamplingStorage',
    'DelegatorsInfo',
  ]);

  const accounts = await hre.ethers.getSigners();
  const Token = await hre.ethers.getContract<Token>('Token');
  const Profile = await hre.ethers.getContract<Profile>('Profile');
  const ConvictionStaking =
    await hre.ethers.getContract<ConvictionStaking>('ConvictionStaking');
  const ConvictionStakeStorage =
    await hre.ethers.getContract<ConvictionStakeStorage>(
      'ConvictionStakeStorage',
    );
  const StakingStorage =
    await hre.ethers.getContract<StakingStorage>('StakingStorage');
  const ParametersStorage =
    await hre.ethers.getContract<ParametersStorage>('ParametersStorage');
  const ProfileStorage =
    await hre.ethers.getContract<ProfileStorage>('ProfileStorage');
  const ShardingTable =
    await hre.ethers.getContract<ShardingTable>('ShardingTable');
  const ShardingTableStorage =
    await hre.ethers.getContract<ShardingTableStorage>('ShardingTableStorage');
  const AskStorage = await hre.ethers.getContract<AskStorage>('AskStorage');
  const Hub = await hre.ethers.getContract<Hub>('Hub');
  const Chronos = await hre.ethers.getContract<Chronos>('Chronos');
  const RandomSamplingStorage =
    await hre.ethers.getContract<RandomSamplingStorage>(
      'RandomSamplingStorage',
    );
  const RandomSampling =
    await hre.ethers.getContract<RandomSampling>('RandomSampling');
  const EpochStorage =
    await hre.ethers.getContract<EpochStorage>('EpochStorageV8');
  const DelegatorsInfo =
    await hre.ethers.getContract<DelegatorsInfo>('DelegatorsInfo');

  await Hub.setContractAddress('HubOwner', accounts[0].address);

  return {
    accounts,
    Token,
    Profile,
    ConvictionStaking,
    ConvictionStakeStorage,
    StakingStorage,
    ParametersStorage,
    ProfileStorage,
    ShardingTable,
    ShardingTableStorage,
    AskStorage,
    Hub,
    Chronos,
    RandomSamplingStorage,
    RandomSampling,
    EpochStorage,
    DelegatorsInfo,
  };
}

describe('ConvictionStaking - Tracer Bullet', function () {
  let accounts: SignerWithAddress[];
  let Token: Token;
  let Profile: Profile;
  let ConvStaking: ConvictionStaking;
  let ConvStakeStorage: ConvictionStakeStorage;
  let StkStorage: StakingStorage;
  let ParametersStor: ParametersStorage;
  let ShardingTableStor: ShardingTableStorage;
  let Hub_: Hub;
  let Chronos_: Chronos;
  let RandSampling: RandomSampling;
  let RandSamplingStorage: RandomSamplingStorage;
  let DelInfo: DelegatorsInfo;

  const STAKE_AMOUNT = hre.ethers.parseUnits('50000', 18); // 50K TRAC

  const createProfile = async (
    admin?: SignerWithAddress,
    operational?: SignerWithAddress,
  ) => {
    const node = '0x' + randomBytes(32).toString('hex');
    const tx = await Profile.connect(
      operational ?? accounts[1],
    ).createProfile(
      admin ? admin.address : accounts[0],
      [],
      `Node ${Math.floor(Math.random() * 1000)}`,
      node,
      0n,
    );
    const receipt = await tx.wait();
    const identityId = Number(receipt?.logs[0].topics[1]);
    return { nodeId: node, identityId };
  };

  beforeEach(async () => {
    hre.helpers.resetDeploymentsJson();
    ({
      accounts,
      Token,
      Profile,
      ConvictionStaking: ConvStaking,
      ConvictionStakeStorage: ConvStakeStorage,
      StakingStorage: StkStorage,
      ParametersStorage: ParametersStor,
      ShardingTableStorage: ShardingTableStor,
      Hub: Hub_,
      Chronos: Chronos_,
      RandomSampling: RandSampling,
      RandomSamplingStorage: RandSamplingStorage,
      DelegatorsInfo: DelInfo,
    } = await loadFixture(deployFixture));
  });

  // -------------------------------------------------------------------------
  // ConvictionStakeStorage
  // -------------------------------------------------------------------------
  describe('ConvictionStakeStorage', () => {
    it('Should have correct name and version', async () => {
      expect(await ConvStakeStorage.name()).to.equal('ConvictionStakeStorage');
      expect(await ConvStakeStorage.version()).to.equal('1.0.0');
    });

    it('Should allow hub-registered contracts to set effectiveNodeStake', async () => {
      await ConvStakeStorage.setEffectiveNodeStake(1, 1000n);
      expect(await ConvStakeStorage.getEffectiveNodeStake(1)).to.equal(1000n);
    });

    it('Should allow hub-registered contracts to set effectiveTotalStake', async () => {
      await ConvStakeStorage.setEffectiveTotalStake(5000n);
      expect(await ConvStakeStorage.getEffectiveTotalStake()).to.equal(5000n);
    });

    it('Should revert if non-contract calls setter', async () => {
      await expect(
        ConvStakeStorage.connect(accounts[5]).setEffectiveNodeStake(1, 1000n),
      ).to.be.reverted;
    });

    it('Should support increase/decrease for effectiveNodeStake', async () => {
      await ConvStakeStorage.increaseEffectiveNodeStake(1, 1000n);
      expect(await ConvStakeStorage.getEffectiveNodeStake(1)).to.equal(1000n);

      await ConvStakeStorage.increaseEffectiveNodeStake(1, 500n);
      expect(await ConvStakeStorage.getEffectiveNodeStake(1)).to.equal(1500n);

      await ConvStakeStorage.decreaseEffectiveNodeStake(1, 300n);
      expect(await ConvStakeStorage.getEffectiveNodeStake(1)).to.equal(1200n);
    });

    it('Should support increase/decrease for effectiveTotalStake', async () => {
      await ConvStakeStorage.increaseEffectiveTotalStake(2000n);
      expect(await ConvStakeStorage.getEffectiveTotalStake()).to.equal(2000n);

      await ConvStakeStorage.decreaseEffectiveTotalStake(500n);
      expect(await ConvStakeStorage.getEffectiveTotalStake()).to.equal(1500n);
    });
  });

  // -------------------------------------------------------------------------
  // ConvictionStaking identity
  // -------------------------------------------------------------------------
  describe('ConvictionStaking contract metadata', () => {
    it('Should have correct name and version', async () => {
      expect(await ConvStaking.name()).to.equal('ConvictionStaking');
      expect(await ConvStaking.version()).to.equal('1.0.0');
    });

    it('Should support ERC-721 interface', async () => {
      expect(await ConvStaking.supportsInterface('0x80ac58cd')).to.equal(true);
    });

    it('Should support ERC-721 Enumerable interface', async () => {
      expect(await ConvStaking.supportsInterface('0x780e9d63')).to.equal(true);
    });
  });

  // -------------------------------------------------------------------------
  // ConvictionStaking.stake()
  // -------------------------------------------------------------------------
  describe('ConvictionStaking.stake()', () => {
    it('Should revert if staking 0 tokens', async () => {
      const { identityId } = await createProfile();
      await expect(
        ConvStaking.stake(identityId, 0, 0),
      ).to.be.revertedWithCustomError(ConvStaking, 'ZeroStakeAmount');
    });

    it('Should revert if profile does not exist', async () => {
      await expect(
        ConvStaking.stake(9999, STAKE_AMOUNT, 0),
      ).to.be.revertedWithCustomError(ConvStaking, 'ProfileDoesntExist');
    });

    it('Should revert if lock tier is not 0', async () => {
      const { identityId } = await createProfile();
      await expect(
        ConvStaking.stake(identityId, STAKE_AMOUNT, 1),
      ).to.be.revertedWithCustomError(ConvStaking, 'InvalidLockTier');
    });

    it('Should revert if maximum stake exceeded', async () => {
      const { identityId } = await createProfile();
      const maxStake = await ParametersStor.maximumStake();
      const overMax = maxStake + 1n;
      await Token.mint(accounts[0].address, overMax);
      await Token.approve(await ConvStaking.getAddress(), overMax);
      await expect(
        ConvStaking.stake(identityId, overMax, 0),
      ).to.be.revertedWithCustomError(ConvStaking, 'MaximumStakeExceeded');
    });

    it('Should mint an NFT to the staker', async () => {
      const { identityId } = await createProfile();
      await Token.approve(await ConvStaking.getAddress(), STAKE_AMOUNT);
      await ConvStaking.stake(identityId, STAKE_AMOUNT, 0);

      expect(await ConvStaking.balanceOf(accounts[0].address)).to.equal(1);
      expect(await ConvStaking.ownerOf(0)).to.equal(accounts[0].address);
      expect(await ConvStaking.totalSupply()).to.equal(1);
    });

    it('Should transfer TRAC from staker to StakingStorage', async () => {
      const { identityId } = await createProfile();
      await Token.approve(await ConvStaking.getAddress(), STAKE_AMOUNT);

      const stakingStorageAddr = await StkStorage.getAddress();
      const balBefore = await Token.balanceOf(stakingStorageAddr);
      await ConvStaking.stake(identityId, STAKE_AMOUNT, 0);
      const balAfter = await Token.balanceOf(stakingStorageAddr);

      expect(balAfter - balBefore).to.equal(STAKE_AMOUNT);
    });

    it('Should update StakingStorage.nodeStake with raw principal', async () => {
      const { identityId } = await createProfile();
      await Token.approve(await ConvStaking.getAddress(), STAKE_AMOUNT);

      const stakeBefore = await StkStorage.getNodeStake(identityId);
      await ConvStaking.stake(identityId, STAKE_AMOUNT, 0);
      const stakeAfter = await StkStorage.getNodeStake(identityId);

      expect(stakeAfter - stakeBefore).to.equal(STAKE_AMOUNT);
    });

    it('Should update StakingStorage.totalStake', async () => {
      const { identityId } = await createProfile();
      await Token.approve(await ConvStaking.getAddress(), STAKE_AMOUNT);

      const totalBefore = await StkStorage.getTotalStake();
      await ConvStaking.stake(identityId, STAKE_AMOUNT, 0);
      const totalAfter = await StkStorage.getTotalStake();

      expect(totalAfter - totalBefore).to.equal(STAKE_AMOUNT);
    });

    it('Should update ConvictionStakeStorage.effectiveNodeStake (1x for tier 0)', async () => {
      const { identityId } = await createProfile();
      await Token.approve(await ConvStaking.getAddress(), STAKE_AMOUNT);
      await ConvStaking.stake(identityId, STAKE_AMOUNT, 0);

      const effectiveStake = await ConvStakeStorage.getEffectiveNodeStake(
        identityId,
      );
      expect(effectiveStake).to.equal(STAKE_AMOUNT);
    });

    it('Should update ConvictionStakeStorage.effectiveTotalStake', async () => {
      const { identityId } = await createProfile();
      await Token.approve(await ConvStaking.getAddress(), STAKE_AMOUNT);
      await ConvStaking.stake(identityId, STAKE_AMOUNT, 0);

      expect(await ConvStakeStorage.getEffectiveTotalStake()).to.equal(
        STAKE_AMOUNT,
      );
    });

    it('Should store correct position data', async () => {
      const { identityId } = await createProfile();
      await Token.approve(await ConvStaking.getAddress(), STAKE_AMOUNT);
      await ConvStaking.stake(identityId, STAKE_AMOUNT, 0);

      const pos = await ConvStaking.getPosition(0);
      expect(pos.principal).to.equal(STAKE_AMOUNT);
      expect(pos.lockTier).to.equal(0);
      expect(pos.nodeId).to.equal(identityId);
      expect(pos.claimableRewards).to.equal(0);
      expect(pos.withdrawalAmount).to.equal(0);
    });

    it('Should emit Staked event', async () => {
      const { identityId } = await createProfile();
      await Token.approve(await ConvStaking.getAddress(), STAKE_AMOUNT);

      await expect(ConvStaking.stake(identityId, STAKE_AMOUNT, 0))
        .to.emit(ConvStaking, 'Staked')
        .withArgs(0, accounts[0].address, identityId, STAKE_AMOUNT, 0);
    });

    it('Should write delegator stakeBase to StakingStorage', async () => {
      const { identityId } = await createProfile();
      await Token.approve(await ConvStaking.getAddress(), STAKE_AMOUNT);
      await ConvStaking.stake(identityId, STAKE_AMOUNT, 0);

      const delegatorKey = hre.ethers.keccak256(
        hre.ethers.solidityPacked(['address'], [accounts[0].address]),
      );
      const stakeBase = await StkStorage.getDelegatorStakeBase(
        identityId,
        delegatorKey,
      );
      expect(stakeBase).to.equal(STAKE_AMOUNT);
    });

    it('Should register delegator in DelegatorsInfo', async () => {
      const { identityId } = await createProfile();
      await Token.approve(await ConvStaking.getAddress(), STAKE_AMOUNT);
      await ConvStaking.stake(identityId, STAKE_AMOUNT, 0);

      expect(
        await DelInfo.isNodeDelegator(identityId, accounts[0].address),
      ).to.equal(true);
      expect(
        await DelInfo.hasEverDelegatedToNode(identityId, accounts[0].address),
      ).to.equal(true);
    });

    it('Should only insert node in sharding table when stake >= minimumStake', async () => {
      const { identityId } = await createProfile();
      const minStake = await ParametersStor.minimumStake();

      // Stake below minimum
      const belowMin = minStake - 1n;
      await Token.approve(await ConvStaking.getAddress(), belowMin);
      await ConvStaking.stake(identityId, belowMin, 0);

      // Node should NOT be in sharding table
      expect(await ShardingTableStor.nodeExists(identityId)).to.equal(false);
    });

    it('Should insert node in sharding table when stake >= minimumStake', async () => {
      const { identityId } = await createProfile();

      await Token.approve(await ConvStaking.getAddress(), STAKE_AMOUNT);
      await ConvStaking.stake(identityId, STAKE_AMOUNT, 0);

      // Node should be in sharding table (50K > minimumStake)
      expect(await ShardingTableStor.nodeExists(identityId)).to.equal(true);
    });

    it('Should mint sequential NFT IDs for multiple stakes', async () => {
      const { identityId } = await createProfile();
      const amount = hre.ethers.parseUnits('10000', 18);
      await Token.approve(await ConvStaking.getAddress(), amount * 3n);

      await ConvStaking.stake(identityId, amount, 0);
      await ConvStaking.stake(identityId, amount, 0);
      await ConvStaking.stake(identityId, amount, 0);

      expect(await ConvStaking.totalSupply()).to.equal(3);
      expect(await ConvStaking.ownerOf(0)).to.equal(accounts[0].address);
      expect(await ConvStaking.ownerOf(1)).to.equal(accounts[0].address);
      expect(await ConvStaking.ownerOf(2)).to.equal(accounts[0].address);
    });

    it('Should accumulate effectiveNodeStake for multiple positions on same node', async () => {
      const { identityId } = await createProfile();
      const amount = hre.ethers.parseUnits('10000', 18);
      await Token.approve(await ConvStaking.getAddress(), amount * 3n);

      await ConvStaking.stake(identityId, amount, 0);
      await ConvStaking.stake(identityId, amount, 0);
      await ConvStaking.stake(identityId, amount, 0);

      expect(
        await ConvStakeStorage.getEffectiveNodeStake(identityId),
      ).to.equal(amount * 3n);
    });

    it('Should accumulate delegator stakeBase for multiple stakes on same node', async () => {
      const { identityId } = await createProfile();
      const amount = hre.ethers.parseUnits('10000', 18);
      await Token.approve(await ConvStaking.getAddress(), amount * 3n);

      await ConvStaking.stake(identityId, amount, 0);
      await ConvStaking.stake(identityId, amount, 0);
      await ConvStaking.stake(identityId, amount, 0);

      const delegatorKey = hre.ethers.keccak256(
        hre.ethers.solidityPacked(['address'], [accounts[0].address]),
      );
      expect(
        await StkStorage.getDelegatorStakeBase(identityId, delegatorKey),
      ).to.equal(amount * 3n);
    });
  });

  // -------------------------------------------------------------------------
  // RandomSampling scoring integration
  // -------------------------------------------------------------------------
  describe('RandomSampling scoring integration', () => {
    it('Should use effectiveNodeStake for calculateNodeScore', async () => {
      const { identityId } = await createProfile();
      await Token.approve(await ConvStaking.getAddress(), STAKE_AMOUNT);
      await ConvStaking.stake(identityId, STAKE_AMOUNT, 0);

      const score = await RandSampling.calculateNodeScore(identityId);
      expect(score).to.be.gt(0);
    });

    it('Should return 0 score for unstaked node', async () => {
      const { identityId } = await createProfile();
      const score = await RandSampling.calculateNodeScore(identityId);
      expect(score).to.equal(0);
    });

    it('Should change score when effectiveNodeStake diverges from raw nodeStake', async () => {
      // Stake via ConvictionStaking: raw = 50K, effective = 50K
      const { identityId } = await createProfile();
      await Token.approve(await ConvStaking.getAddress(), STAKE_AMOUNT);
      await ConvStaking.stake(identityId, STAKE_AMOUNT, 0);

      const scoreAtBase = await RandSampling.calculateNodeScore(identityId);
      expect(scoreAtBase).to.be.gt(0);

      // Hub owner sets effectiveNodeStake to 4x (200K), raw stays 50K
      const boostedEffective = STAKE_AMOUNT * 4n;
      await ConvStakeStorage.setEffectiveNodeStake(
        identityId,
        boostedEffective,
      );

      const scoreAtBoosted =
        await RandSampling.calculateNodeScore(identityId);

      // Score must increase: sqrt(200K/2M) > sqrt(50K/2M)
      // If RandomSampling were still reading raw nodeStake, score would be unchanged
      expect(scoreAtBoosted).to.be.gt(scoreAtBase);
    });

    it('Should use effectiveNodeStake (not raw) as scorePerStake divisor', async () => {
      // Stake via ConvictionStaking: raw = 50K, effective = 50K
      const { identityId } = await createProfile();
      await Token.approve(await ConvStaking.getAddress(), STAKE_AMOUNT);
      await ConvStaking.stake(identityId, STAKE_AMOUNT, 0);

      // Set effective to 2x raw (simulate future multiplier)
      const doubledEffective = STAKE_AMOUNT * 2n;
      await ConvStakeStorage.setEffectiveNodeStake(
        identityId,
        doubledEffective,
      );

      // Verify the calculateNodeScore uses the boosted value
      const scoreAtDoubled =
        await RandSampling.calculateNodeScore(identityId);

      // Now set effective back to base
      await ConvStakeStorage.setEffectiveNodeStake(
        identityId,
        STAKE_AMOUNT,
      );
      const scoreAtBase = await RandSampling.calculateNodeScore(identityId);

      // scoreAtDoubled > scoreAtBase proves effective is used for scoring
      // (sqrt(100K/2M) > sqrt(50K/2M))
      expect(scoreAtDoubled).to.be.gt(scoreAtBase);

      // The ratio should be sqrt(2) ≈ 1.414 (within 1% tolerance)
      const ratio =
        Number((scoreAtDoubled * 10000n) / scoreAtBase) / 10000;
      expect(ratio).to.be.closeTo(Math.sqrt(2), 0.01);
    });
  });
});
