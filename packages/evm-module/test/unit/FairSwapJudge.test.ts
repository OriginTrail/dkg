import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers';
import { expect } from 'chai';
import hre from 'hardhat';

import { FairSwapJudge, Hub } from '../../typechain';

type Fixture = {
  accounts: SignerWithAddress[];
  Hub: Hub;
  FSJ: FairSwapJudge;
};

describe('@unit FairSwapJudge contract', function () {
  let accounts: SignerWithAddress[];
  let Hub: Hub;
  let FSJ: FairSwapJudge;

  async function deployFixture(): Promise<Fixture> {
    await hre.deployments.fixture(['FairSwapJudge']);
    Hub = await hre.ethers.getContract<Hub>('Hub');
    FSJ = await hre.ethers.getContract<FairSwapJudge>('FairSwapJudge');
    accounts = await hre.ethers.getSigners();
    await Hub.setContractAddress('HubOwner', accounts[0].address);
    return { accounts, Hub, FSJ };
  }

  beforeEach(async () => {
    hre.helpers.resetDeploymentsJson();
    ({ accounts, Hub, FSJ } = await loadFixture(deployFixture));
  });

  it('initiates a purchase and stores correct info', async () => {
    const token = await hre.ethers.getContract('Token');
    const price = hre.ethers.parseEther('1000');
    const seller = accounts[1].address;

    await token.approve(await FSJ.getAddress(), price);
    const tx = await FSJ.initiatePurchase(seller, 1, 1, price);
    await tx.wait();

    const info = await FSJ.getPurchase(1);
    expect(info.buyer).to.equal(accounts[0].address);
    expect(info.seller).to.equal(seller);
    expect(info.price).to.equal(price);
    expect(info.state).to.equal(1); // Initiated
  });

  it('reverts on purchase with zero price', async () => {
    await expect(
      FSJ.initiatePurchase(accounts[1].address, 1, 1, 0),
    ).to.be.revertedWithCustomError(FSJ, 'InvalidPrice');
  });

  it('reverts on nonexistent purchase', async () => {
    await expect(FSJ.getPurchase(999)).to.be.revertedWithCustomError(
      FSJ,
      'PurchaseNotFound',
    );
  });

  it('only seller can fulfill', async () => {
    const token = await hre.ethers.getContract('Token');
    const price = hre.ethers.parseEther('1000');

    await token.approve(await FSJ.getAddress(), price);
    await FSJ.initiatePurchase(accounts[1].address, 1, 1, price);

    // accounts[2] is not the seller
    await expect(
      FSJ.connect(accounts[2]).fulfillPurchase(
        1,
        hre.ethers.randomBytes(32),
        hre.ethers.randomBytes(32),
      ),
    ).to.be.revertedWithCustomError(FSJ, 'NotSeller');
  });

  it('seller can fulfill purchase', async () => {
    const token = await hre.ethers.getContract('Token');
    const price = hre.ethers.parseEther('1000');
    const seller = accounts[1];

    await token.approve(await FSJ.getAddress(), price);
    await FSJ.initiatePurchase(seller.address, 1, 1, price);

    const encRoot = hre.ethers.randomBytes(32);
    const keyCommitment = hre.ethers.randomBytes(32);
    await FSJ.connect(seller).fulfillPurchase(1, encRoot, keyCommitment);

    const info = await FSJ.getPurchase(1);
    expect(info.state).to.equal(2); // Fulfilled
  });
});
