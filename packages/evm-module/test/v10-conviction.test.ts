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

});
