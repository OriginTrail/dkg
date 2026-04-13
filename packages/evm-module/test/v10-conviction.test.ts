import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers';
import { expect } from 'chai';
import hre, { ethers } from 'hardhat';

import {
  Token,
  Profile,
  Staking,
  StakingStorage,
  ParametersStorage,
  Hub,
  Chronos,
  DelegatorsInfo,
  PublishingConvictionAccount,
} from '../typechain';

type ConvictionFixture = {
  accounts: SignerWithAddress[];
  Token: Token;
  Profile: Profile;
  Staking: Staking;
  StakingStorage: StakingStorage;
  ParametersStorage: ParametersStorage;
  Hub: Hub;
  Chronos: Chronos;
  DelegatorsInfo: DelegatorsInfo;
  PCA: PublishingConvictionAccount;
};

async function deployConvictionFixture(): Promise<ConvictionFixture> {
  await hre.deployments.fixture([
    'Profile',
    'Staking',
    'EpochStorage',
    'Chronos',
    'RandomSamplingStorage',
    'DelegatorsInfo',
    'PublishingConvictionAccount',
    'MigratorV10Staking',
  ]);
  const Staking = await hre.ethers.getContract<Staking>('Staking');
  const Profile = await hre.ethers.getContract<Profile>('Profile');
  const Token = await hre.ethers.getContract<Token>('Token');
  const StakingStorage =
    await hre.ethers.getContract<StakingStorage>('StakingStorage');
  const ParametersStorage =
    await hre.ethers.getContract<ParametersStorage>('ParametersStorage');
  const Hub = await hre.ethers.getContract<Hub>('Hub');
  const Chronos = await hre.ethers.getContract<Chronos>('Chronos');
  const DelegatorsInfo =
    await hre.ethers.getContract<DelegatorsInfo>('DelegatorsInfo');
  const PCA =
    await hre.ethers.getContract<PublishingConvictionAccount>(
      'PublishingConvictionAccount',
    );
  const accounts = await hre.ethers.getSigners();

  await Hub.setContractAddress('HubOwner', accounts[0].address);

  return {
    accounts,
    Token,
    Profile,
    Staking,
    StakingStorage,
    ParametersStorage,
    Hub,
    Chronos,
    DelegatorsInfo,
    PCA,
  };
}

describe('@unit V10 Conviction System', function () {
  let accounts: SignerWithAddress[];
  let Token: Token;
  let Profile: Profile;
  let Staking: Staking;
  let StakingStorage: StakingStorage;
  let ParametersStorage: ParametersStorage;
  let Hub: Hub;
  let Chronos: Chronos;
  let DelegatorsInfo: DelegatorsInfo;
  let PCA: PublishingConvictionAccount;

  beforeEach(async () => {
    hre.helpers.resetDeploymentsJson();
    ({
      accounts,
      Token,
      Profile,
      Staking,
      StakingStorage,
      ParametersStorage,
      Hub,
      Chronos,
      DelegatorsInfo,
      PCA,
    } = await loadFixture(deployConvictionFixture));
  });

  // ========================================================================
  // Conviction Multiplier (pure function on Staking)
  // ========================================================================

  describe('convictionMultiplier', function () {
    const SCALE18 = 10n ** 18n;

    it('convictionMultiplier(0) returns 0', async () => {
      expect(await Staking.convictionMultiplier(0)).to.equal(0n);
    });

    it('convictionMultiplier(1) returns 1e18 (1x)', async () => {
      expect(await Staking.convictionMultiplier(1)).to.equal(1n * SCALE18);
    });

    it('convictionMultiplier(2) returns 1.5e18 (1.5x)', async () => {
      expect(await Staking.convictionMultiplier(2)).to.equal(
        (15n * SCALE18) / 10n,
      );
    });

    it('convictionMultiplier(3) returns 2e18 (2x)', async () => {
      expect(await Staking.convictionMultiplier(3)).to.equal(2n * SCALE18);
    });

    it('convictionMultiplier(5) returns 2e18 (snaps down to 3-epoch tier)', async () => {
      expect(await Staking.convictionMultiplier(5)).to.equal(2n * SCALE18);
    });

    it('convictionMultiplier(6) returns 3.5e18 (3.5x)', async () => {
      expect(await Staking.convictionMultiplier(6)).to.equal(
        (35n * SCALE18) / 10n,
      );
    });

    it('convictionMultiplier(11) returns 3.5e18 (snaps down to 6-epoch tier)', async () => {
      expect(await Staking.convictionMultiplier(11)).to.equal(
        (35n * SCALE18) / 10n,
      );
    });

    it('convictionMultiplier(12) returns 6e18 (6x)', async () => {
      expect(await Staking.convictionMultiplier(12)).to.equal(6n * SCALE18);
    });

    it('convictionMultiplier(100) returns 6e18 (caps at 6x)', async () => {
      expect(await Staking.convictionMultiplier(100)).to.equal(6n * SCALE18);
    });
  });

  // ========================================================================
  // PublishingConvictionAccount
  // ========================================================================

  describe('PublishingConvictionAccount', function () {
    it('createAccount locks TRAC and returns accountId', async () => {
      const amount = hre.ethers.parseEther('100000');
      const lockEpochs = 6;
      await Token.approve(await PCA.getAddress(), amount);

      const tx = await PCA.createAccount(amount, lockEpochs);
      await tx.wait();

      const info = await PCA.getAccountInfo(1);
      expect(info.admin).to.equal(accounts[0].address);
      expect(info.balance).to.equal(amount);
      expect(info.initialDeposit).to.equal(amount);
      expect(info.lockEpochs).to.equal(lockEpochs);
      expect(info.conviction).to.equal(amount * BigInt(lockEpochs));

      const pcaBal = await Token.balanceOf(await PCA.getAddress());
      expect(pcaBal).to.be.gte(amount);
    });

    it('addFunds increases balance', async () => {
      const initial = hre.ethers.parseEther('100000');
      const added = hre.ethers.parseEther('50000');
      await Token.approve(await PCA.getAddress(), initial + added);
      await PCA.createAccount(initial, 6);

      await PCA.addFunds(1, added);

      const info = await PCA.getAccountInfo(1);
      expect(info.balance).to.equal(initial + added);
    });

    it('coverCost applies discount correctly', async () => {
      const amount = hre.ethers.parseEther('500000');
      const lockEpochs = 6;
      await Token.approve(await PCA.getAddress(), amount);
      await PCA.createAccount(amount, lockEpochs);

      // conviction = 500_000 * 6 = 3_000_000 ether-units
      // C_HALF     = 3_000_000 ether
      // discount   = 5000 * 3M / (3M + 3M) = 2500 bps (25%)
      // discountedCost = baseCost * (10000 - 2500) / 10000 = baseCost * 75%
      const baseCost = hre.ethers.parseEther('1000');
      const discountedCost = await PCA.getDiscountedCost(1, baseCost);
      const expectedCost = (baseCost * 7500n) / 10000n;
      expect(discountedCost).to.equal(expectedCost);
    });

    it('non-admin cannot modify account', async () => {
      const amount = hre.ethers.parseEther('100000');
      await Token.approve(await PCA.getAddress(), amount);
      await PCA.createAccount(amount, 6);

      const nonAdmin = accounts[1];

      await expect(
        PCA.connect(nonAdmin).addFunds(1, hre.ethers.parseEther('1000')),
      ).to.be.revertedWithCustomError(PCA, 'NotAccountAdmin');

      await expect(
        PCA.connect(nonAdmin).extendLock(1, 3),
      ).to.be.revertedWithCustomError(PCA, 'NotAccountAdmin');

      await expect(
        PCA.connect(nonAdmin).addAuthorizedKey(1, nonAdmin.address),
      ).to.be.revertedWithCustomError(PCA, 'NotAccountAdmin');

      await expect(
        PCA.connect(nonAdmin).removeAuthorizedKey(1, accounts[0].address),
      ).to.be.revertedWithCustomError(PCA, 'NotAccountAdmin');
    });

    it('authorized keys can be added and removed', async () => {
      const amount = hre.ethers.parseEther('100000');
      await Token.approve(await PCA.getAddress(), amount);
      await PCA.createAccount(amount, 6);

      const otherKey = accounts[1].address;
      await PCA.addAuthorizedKey(1, otherKey);
      expect(await PCA.authorizedKeys(1, otherKey)).to.be.true;

      await PCA.removeAuthorizedKey(1, otherKey);
      expect(await PCA.authorizedKeys(1, otherKey)).to.be.false;
    });
  });

  // ========================================================================
  // MigratorV10Staking
  // ========================================================================

  describe('MigratorV10Staking', function () {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let Migrator: any;
    let oldDI: DelegatorsInfo;

    beforeEach(async () => {
      const DIFactory =
        await hre.ethers.getContractFactory('DelegatorsInfo');
      oldDI = (await DIFactory.deploy(
        await Hub.getAddress(),
      )) as DelegatorsInfo;
      await oldDI.waitForDeployment();

      Migrator = await hre.ethers.getContract('MigratorV10Staking');

      await Migrator.setOldDelegatorsInfo(await oldDI.getAddress());
      await Migrator.setNewDelegatorsInfo(
        await DelegatorsInfo.getAddress(),
      );
    });

    it('migrateNode copies all delegator state correctly', async () => {
      const identityId = 1;
      const delegator = accounts[2].address;

      await oldDI.addDelegator(identityId, delegator);
      await oldDI.setLastClaimedEpoch(identityId, delegator, 5);
      await oldDI.setDelegatorRollingRewards(identityId, delegator, 1000);
      await oldDI.setHasEverDelegatedToNode(identityId, delegator, true);
      await oldDI.setLastStakeHeldEpoch(identityId, delegator, 3);
      await oldDI.setIsOperatorFeeClaimedForEpoch(identityId, 4, true);
      await oldDI.setNetNodeEpochRewards(identityId, 4, 5000);
      await oldDI.setLastClaimedDelegatorsRewardsEpoch(identityId, 7);

      await Migrator.migrateNode(identityId, 4, 4);

      expect(
        await DelegatorsInfo.isNodeDelegator(identityId, delegator),
      ).to.be.true;
      expect(
        await DelegatorsInfo.getLastClaimedEpoch(identityId, delegator),
      ).to.equal(5);
      expect(
        await DelegatorsInfo.getDelegatorRollingRewards(
          identityId,
          delegator,
        ),
      ).to.equal(1000);
      expect(
        await DelegatorsInfo.hasEverDelegatedToNode(identityId, delegator),
      ).to.be.true;
      expect(
        await DelegatorsInfo.getLastStakeHeldEpoch(identityId, delegator),
      ).to.equal(3);
      expect(
        await DelegatorsInfo.isOperatorFeeClaimedForEpoch(identityId, 4),
      ).to.be.true;
      expect(
        await DelegatorsInfo.getNetNodeEpochRewards(identityId, 4),
      ).to.equal(5000);
      expect(
        await DelegatorsInfo.lastClaimedDelegatorsRewardsEpoch(identityId),
      ).to.equal(7);
    });

    it('migrateEpochRewardsClaimed copies claim status', async () => {
      const identityId = 1;
      const delegator = accounts[2].address;
      const delegatorKey = ethers.keccak256(
        ethers.solidityPacked(['address'], [delegator]),
      );
      const epoch = 5;

      await oldDI.setHasDelegatorClaimedEpochRewards(
        epoch,
        identityId,
        delegatorKey,
        true,
      );

      await Migrator.migrateEpochRewardsClaimed(epoch, identityId, [
        delegator,
      ]);

      expect(
        await DelegatorsInfo.hasDelegatorClaimedEpochRewards(
          epoch,
          identityId,
          delegatorKey,
        ),
      ).to.be.true;
    });

    it('only owner/multisig can call migration functions', async () => {
      const nonOwner = accounts[5];

      await expect(
        Migrator.connect(nonOwner).migrateNode(1, 1, 1),
      ).to.be.reverted;

      await expect(
        Migrator.connect(nonOwner).migrateEpochRewardsClaimed(1, 1, []),
      ).to.be.reverted;

      await expect(
        Migrator.connect(nonOwner).setOldDelegatorsInfo(
          ethers.ZeroAddress,
        ),
      ).to.be.reverted;

      await expect(
        Migrator.connect(nonOwner).setNewDelegatorsInfo(
          ethers.ZeroAddress,
        ),
      ).to.be.reverted;
    });

    it('lock fields default to 0 after migration', async () => {
      const identityId = 1;
      const delegator = accounts[2].address;

      await oldDI.addDelegator(identityId, delegator);
      await oldDI.setLastClaimedEpoch(identityId, delegator, 5);
      await oldDI.setHasEverDelegatedToNode(identityId, delegator, true);

      await Migrator.migrateNode(identityId, 1, 1);

      const [lockEpochs, lockStartEpoch] =
        await DelegatorsInfo.getDelegatorLock(identityId, delegator);
      expect(lockEpochs).to.equal(0);
      expect(lockStartEpoch).to.equal(0);
    });

    it('migrateNode is idempotent (safe to re-run)', async () => {
      const identityId = 99;
      const delegatorA = accounts[3].address;
      const delegatorB = accounts[4].address;

      await oldDI.addDelegator(identityId, delegatorA);
      await oldDI.addDelegator(identityId, delegatorB);
      await oldDI.setLastClaimedEpoch(identityId, delegatorA, 10);
      await oldDI.setDelegatorRollingRewards(identityId, delegatorB, 2000);

      await Migrator.migrateNode(identityId, 1, 1);
      await Migrator.migrateNode(identityId, 1, 1);

      const delegators = await DelegatorsInfo.getDelegators(identityId);
      expect(delegators.length).to.equal(2);
      expect(await DelegatorsInfo.isNodeDelegator(identityId, delegatorA)).to.be.true;
      expect(await DelegatorsInfo.isNodeDelegator(identityId, delegatorB)).to.be.true;
      expect(await DelegatorsInfo.getLastClaimedEpoch(identityId, delegatorA)).to.equal(10);
      expect(await DelegatorsInfo.getDelegatorRollingRewards(identityId, delegatorB)).to.equal(2000);
    });
  });
});
