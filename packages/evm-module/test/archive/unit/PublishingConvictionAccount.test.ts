import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers';
import { expect } from 'chai';
import hre from 'hardhat';

import { PublishingConvictionAccount, Hub } from '../../typechain';

type Fixture = {
  accounts: SignerWithAddress[];
  Hub: Hub;
  PCA: PublishingConvictionAccount;
};

describe('@unit PublishingConvictionAccount contract', function () {
  let accounts: SignerWithAddress[];
  let Hub: Hub;
  let PCA: PublishingConvictionAccount;

  async function deployFixture(): Promise<Fixture> {
    await hre.deployments.fixture(['PublishingConvictionAccount']);
    Hub = await hre.ethers.getContract<Hub>('Hub');
    PCA = await hre.ethers.getContract<PublishingConvictionAccount>('PublishingConvictionAccount');
    accounts = await hre.ethers.getSigners();
    await Hub.setContractAddress('HubOwner', accounts[0].address);
    return { accounts, Hub, PCA };
  }

  beforeEach(async () => {
    hre.helpers.resetDeploymentsJson();
    ({ accounts, Hub, PCA } = await loadFixture(deployFixture));
  });

  it('creates an account and returns correct info', async () => {
    const token = await hre.ethers.getContract('Token');
    const amount = hre.ethers.parseEther('100000');
    const lockEpochs = 6;

    await token.approve(await PCA.getAddress(), amount);
    const tx = await PCA.createAccount(amount, lockEpochs);
    await tx.wait();

    const info = await PCA.getAccountInfo(1);
    expect(info.admin).to.equal(accounts[0].address);
    expect(info.balance).to.equal(amount);
    expect(info.lockEpochs).to.equal(lockEpochs);

    const expectedConviction = amount * BigInt(lockEpochs);
    expect(info.conviction).to.equal(expectedConviction);
  });

  it('computes the correct discount', async () => {
    const token = await hre.ethers.getContract('Token');
    const amount = hre.ethers.parseEther('500000');
    const lockEpochs = 6;

    await token.approve(await PCA.getAddress(), amount);
    await PCA.createAccount(amount, lockEpochs);

    const discount = await PCA.getDiscount(1);
    // conviction = 500000 * 6 = 3,000,000 (in ether units)
    // discount = 5000 * conviction / (conviction + C_half) = 5000 * 3M / (3M + 3M) = 2500
    expect(Number(discount)).to.be.approximately(2500, 10);
  });

  it('applies discount to publishing cost', async () => {
    const token = await hre.ethers.getContract('Token');
    const amount = hre.ethers.parseEther('500000');
    const lockEpochs = 6;

    await token.approve(await PCA.getAddress(), amount);
    await PCA.createAccount(amount, lockEpochs);

    const baseCost = hre.ethers.parseEther('1000');
    const discountedCost = await PCA.getDiscountedCost(1, baseCost);

    // ~25% discount → discounted cost ≈ 750 TRAC
    expect(discountedCost).to.be.lessThan(baseCost);
    expect(discountedCost).to.be.greaterThan(0);
  });

  it('adds funds to existing account', async () => {
    const token = await hre.ethers.getContract('Token');
    const initialAmount = hre.ethers.parseEther('100000');
    const addAmount = hre.ethers.parseEther('50000');

    await token.approve(await PCA.getAddress(), initialAmount + addAmount);
    await PCA.createAccount(initialAmount, 6);
    await PCA.addFunds(1, addAmount);

    const info = await PCA.getAccountInfo(1);
    expect(info.balance).to.equal(initialAmount + addAmount);
  });

  it('extends lock and increases conviction', async () => {
    const token = await hre.ethers.getContract('Token');
    const amount = hre.ethers.parseEther('100000');

    await token.approve(await PCA.getAddress(), amount);
    await PCA.createAccount(amount, 6);

    const infoBefore = await PCA.getAccountInfo(1);
    await PCA.extendLock(1, 6);
    const infoAfter = await PCA.getAccountInfo(1);

    expect(infoAfter.lockEpochs).to.equal(12);
    expect(infoAfter.conviction).to.be.greaterThan(infoBefore.conviction);
  });

  it('manages authorized keys', async () => {
    const token = await hre.ethers.getContract('Token');
    const amount = hre.ethers.parseEther('100000');

    await token.approve(await PCA.getAddress(), amount);
    await PCA.createAccount(amount, 6);

    const otherKey = accounts[1].address;
    await PCA.addAuthorizedKey(1, otherKey);
    expect(await PCA.authorizedKeys(1, otherKey)).to.be.true;

    await PCA.removeAuthorizedKey(1, otherKey);
    expect(await PCA.authorizedKeys(1, otherKey)).to.be.false;
  });

  it('prevents non-admin from managing account', async () => {
    const token = await hre.ethers.getContract('Token');
    const amount = hre.ethers.parseEther('100000');

    await token.approve(await PCA.getAddress(), amount);
    await PCA.createAccount(amount, 6);

    await expect(
      PCA.connect(accounts[1]).addFunds(1, hre.ethers.parseEther('1000')),
    ).to.be.revertedWithCustomError(PCA, 'NotAccountAdmin');

    await expect(
      PCA.connect(accounts[1]).extendLock(1, 3),
    ).to.be.revertedWithCustomError(PCA, 'NotAccountAdmin');
  });

  it('reverts on nonexistent account', async () => {
    await expect(PCA.getAccountInfo(999)).to.be.revertedWithCustomError(
      PCA,
      'AccountNotFound',
    );
  });
});
