import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers';
import { expect } from 'chai';
import hre from 'hardhat';

import { DKGPublishingConvictionNFT, Hub, Token } from '../../typechain';

type Fixture = {
  accounts: SignerWithAddress[];
  Hub: Hub;
  NFT: DKGPublishingConvictionNFT;
  Token: Token;
};

describe('@unit DKGPublishingConvictionNFT', function () {
  let accounts: SignerWithAddress[];
  let HubContract: Hub;
  let NFT: DKGPublishingConvictionNFT;
  let TokenContract: Token;

  async function deployFixture(): Promise<Fixture> {
    await hre.deployments.fixture([
      'DKGPublishingConvictionNFT',
      'Token',
    ]);
    const Hub = await hre.ethers.getContract<Hub>('Hub');
    const NFT = await hre.ethers.getContract<DKGPublishingConvictionNFT>('DKGPublishingConvictionNFT');
    const Token = await hre.ethers.getContract<Token>('Token');
    const accounts = await hre.ethers.getSigners();
    await Hub.setContractAddress('HubOwner', accounts[0].address);
    return { accounts, Hub, NFT, Token };
  }

  beforeEach(async () => {
    hre.helpers.resetDeploymentsJson();
    ({ accounts, Hub: HubContract, NFT, Token: TokenContract } = await loadFixture(deployFixture));
  });

  describe('createAccount', () => {
    it('mints an ERC-721 token and sets correct account data', async () => {
      const amount = hre.ethers.parseEther('120000');
      await TokenContract.approve(await NFT.getAddress(), amount);
      const tx = await NFT.createAccount(amount);
      await tx.wait();

      expect(await NFT.ownerOf(1)).to.equal(accounts[0].address);
      expect(await NFT.balanceOf(accounts[0].address)).to.equal(1);

      const info = await NFT.getAccountInfo(1);
      expect(info.owner_).to.equal(accounts[0].address);
      expect(info.committedTRAC).to.equal(amount);
      expect(info.epochAllowance).to.equal(amount / 12n);
    });

    it('emits AccountCreated event', async () => {
      const amount = hre.ethers.parseEther('120000');
      await TokenContract.approve(await NFT.getAddress(), amount);
      await expect(NFT.createAccount(amount))
        .to.emit(NFT, 'AccountCreated')
        .withArgs(1, accounts[0].address, amount, amount / 12n);
    });

    it('reverts with zero amount', async () => {
      await expect(NFT.createAccount(0)).to.be.revertedWithCustomError(NFT, 'InvalidAmount');
    });

    it('assigns incrementing IDs', async () => {
      const amount = hre.ethers.parseEther('60000');
      await TokenContract.approve(await NFT.getAddress(), amount * 2n);
      await NFT.createAccount(amount);
      await NFT.createAccount(amount);
      expect(await NFT.totalSupply()).to.equal(2);
      expect(await NFT.ownerOf(1)).to.equal(accounts[0].address);
      expect(await NFT.ownerOf(2)).to.equal(accounts[0].address);
    });
  });

  describe('discrete discount tiers', () => {
    const tiers: [string, bigint, bigint][] = [
      ['< 50k → 0%', hre.ethers.parseEther('30000'), 0n],
      ['50k-100k → 10%', hre.ethers.parseEther('50000'), 1000n],
      ['100k-250k → 20%', hre.ethers.parseEther('100000'), 2000n],
      ['250k-500k → 30%', hre.ethers.parseEther('250000'), 3000n],
      ['500k-1M → 40%', hre.ethers.parseEther('500000'), 4000n],
      ['1M+ → 50%', hre.ethers.parseEther('1000000'), 5000n],
    ];

    for (const [label, amount, expectedBps] of tiers) {
      it(`${label}`, async () => {
        expect(await NFT.getDiscountBps(amount)).to.equal(expectedBps);
      });
    }

    it('applies discount correctly to a cost', async () => {
      const amount = hre.ethers.parseEther('500000');
      await TokenContract.approve(await NFT.getAddress(), amount);
      await NFT.createAccount(amount);

      const baseCost = hre.ethers.parseEther('1000');
      const discounted = await NFT.getDiscountedCost(1, baseCost);
      // 40% discount → 600 TRAC
      expect(discounted).to.equal(hre.ethers.parseEther('600'));
    });
  });

  describe('agent management', () => {
    beforeEach(async () => {
      const amount = hre.ethers.parseEther('60000');
      await TokenContract.approve(await NFT.getAddress(), amount);
      await NFT.createAccount(amount);
    });

    it('registers and deregisters agents', async () => {
      const agent = accounts[3].address;
      await NFT.registerAgent(1, agent);

      const agents = await NFT.getRegisteredAgents(1);
      expect(agents).to.deep.equal([agent]);
      expect(await NFT.agentToAccountId(agent)).to.equal(1);

      await NFT.deregisterAgent(1, agent);
      const after = await NFT.getRegisteredAgents(1);
      expect(after).to.deep.equal([]);
      expect(await NFT.agentToAccountId(agent)).to.equal(0);
    });

    it('emits AgentRegistered and AgentDeregistered', async () => {
      const agent = accounts[3].address;
      await expect(NFT.registerAgent(1, agent))
        .to.emit(NFT, 'AgentRegistered').withArgs(1, agent);
      await expect(NFT.deregisterAgent(1, agent))
        .to.emit(NFT, 'AgentDeregistered').withArgs(1, agent);
    });

    it('enforces one-account-per-agent', async () => {
      const agent = accounts[3].address;
      await NFT.registerAgent(1, agent);

      const amount2 = hre.ethers.parseEther('60000');
      await TokenContract.approve(await NFT.getAddress(), amount2);
      await NFT.createAccount(amount2);

      await expect(NFT.registerAgent(2, agent))
        .to.be.revertedWithCustomError(NFT, 'AgentAlreadyRegistered');
    });

    it('enforces agent cap', async () => {
      await NFT.setMaxAgentsPerAccount(2);

      await NFT.registerAgent(1, accounts[3].address);
      await NFT.registerAgent(1, accounts[4].address);

      await expect(NFT.registerAgent(1, accounts[5].address))
        .to.be.revertedWithCustomError(NFT, 'AgentCapReached');
    });

    it('only owner can register agents', async () => {
      await expect(
        NFT.connect(accounts[5]).registerAgent(1, accounts[3].address),
      ).to.be.revertedWithCustomError(NFT, 'NotAccountOwner');
    });
  });

  describe('ERC-721 transferability', () => {
    it('transferring the NFT transfers account ownership', async () => {
      const amount = hre.ethers.parseEther('60000');
      await TokenContract.approve(await NFT.getAddress(), amount);
      await NFT.createAccount(amount);

      await NFT.transferFrom(accounts[0].address, accounts[7].address, 1);
      expect(await NFT.ownerOf(1)).to.equal(accounts[7].address);

      const info = await NFT.getAccountInfo(1);
      expect(info.owner_).to.equal(accounts[7].address);
    });
  });

  describe('governance', () => {
    it('setMaxAgentsPerAccount can be called by hub owner', async () => {
      await NFT.setMaxAgentsPerAccount(200);
      expect(await NFT.maxAgentsPerAccount()).to.equal(200);
    });

    it('non-owner cannot set maxAgentsPerAccount', async () => {
      await expect(
        NFT.connect(accounts[5]).setMaxAgentsPerAccount(200),
      ).to.be.revertedWith('Only Hub Owner or Hub');
    });

    it('defaults to 100', async () => {
      expect(await NFT.maxAgentsPerAccount()).to.equal(100);
    });
  });

  describe('view functions', () => {
    it('getAccountInfo returns all fields', async () => {
      const amount = hre.ethers.parseEther('500000');
      await TokenContract.approve(await NFT.getAddress(), amount);
      await NFT.createAccount(amount);

      const info = await NFT.getAccountInfo(1);
      expect(info.committedTRAC).to.equal(amount);
      expect(info.epochAllowance).to.equal(amount / 12n);
      expect(info.discountBps).to.equal(4000n);
      expect(info.agentCount).to.equal(0);
    });

    it('reverts on nonexistent account', async () => {
      await expect(NFT.getAccountInfo(999)).to.be.reverted;
    });
  });
});
