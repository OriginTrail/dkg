import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers';
import { expect } from 'chai';
import hre from 'hardhat';

import { DKGStakingConvictionNFT, Hub, Token } from '../../typechain';

type Fixture = {
  accounts: SignerWithAddress[];
  Hub: Hub;
  NFT: DKGStakingConvictionNFT;
  Token: Token;
};

describe('@unit DKGStakingConvictionNFT', function () {
  let accounts: SignerWithAddress[];
  let HubContract: Hub;
  let NFT: DKGStakingConvictionNFT;
  let TokenContract: Token;

  const IDENTITY_ID = 1;
  const SCALE18 = BigInt(1e18);

  async function deployFixture(): Promise<Fixture> {
    await hre.deployments.fixture(['DKGStakingConvictionNFT', 'Token']);
    const Hub = await hre.ethers.getContract<Hub>('Hub');
    const NFT = await hre.ethers.getContract<DKGStakingConvictionNFT>('DKGStakingConvictionNFT');
    const Token = await hre.ethers.getContract<Token>('Token');
    const accounts = await hre.ethers.getSigners();
    await Hub.setContractAddress('HubOwner', accounts[0].address);
    // Use accounts[18] as a stub StakingStorage for token transfers
    await Hub.setContractAddress('StakingStorage', accounts[18].address);
    // Re-initialize to pick up the new StakingStorage address
    await Hub.forwardCall(await NFT.getAddress(), NFT.interface.encodeFunctionData('initialize'));
    return { accounts, Hub, NFT, Token };
  }

  beforeEach(async () => {
    hre.helpers.resetDeploymentsJson();
    ({ accounts, Hub: HubContract, NFT, Token: TokenContract } = await loadFixture(deployFixture));
  });

  describe('stake', () => {
    it('mints an ERC-721 and creates a position', async () => {
      const amount = hre.ethers.parseEther('50000');
      await TokenContract.approve(await NFT.getAddress(), amount);
      const tx = await NFT.stake(IDENTITY_ID, amount, 6);
      await tx.wait();

      expect(await NFT.ownerOf(1)).to.equal(accounts[0].address);
      expect(await NFT.balanceOf(accounts[0].address)).to.equal(1);

      const pos = await NFT.getPosition(1);
      expect(pos.owner_).to.equal(accounts[0].address);
      expect(pos.identityId).to.equal(IDENTITY_ID);
      expect(pos.stakedAmount).to.equal(amount);
      expect(pos.lockEpochs).to.equal(6);
    });

    it('emits PositionCreated event', async () => {
      const amount = hre.ethers.parseEther('50000');
      await TokenContract.approve(await NFT.getAddress(), amount);
      await expect(NFT.stake(IDENTITY_ID, amount, 6))
        .to.emit(NFT, 'PositionCreated')
        .withArgs(1, accounts[0].address, IDENTITY_ID, amount, 6);
    });

    it('reverts with zero amount', async () => {
      await expect(NFT.stake(IDENTITY_ID, 0, 6)).to.be.revertedWithCustomError(NFT, 'InvalidAmount');
    });

    it('reverts with zero lockEpochs', async () => {
      const amount = hre.ethers.parseEther('50000');
      await TokenContract.approve(await NFT.getAddress(), amount);
      await expect(NFT.stake(IDENTITY_ID, amount, 0)).to.be.revertedWithCustomError(NFT, 'InvalidLockEpochs');
    });

    it('assigns incrementing IDs', async () => {
      const amount = hre.ethers.parseEther('25000');
      await TokenContract.approve(await NFT.getAddress(), amount * 2n);
      await NFT.stake(IDENTITY_ID, amount, 3);
      await NFT.stake(2, amount, 6);

      expect(await NFT.totalSupply()).to.equal(2);
      expect(await NFT.tokenByIndex(0)).to.equal(1);
      expect(await NFT.tokenByIndex(1)).to.equal(2);
    });
  });

  describe('increaseStake', () => {
    it('adds to an existing position', async () => {
      const initial = hre.ethers.parseEther('50000');
      const added = hre.ethers.parseEther('10000');
      await TokenContract.approve(await NFT.getAddress(), initial + added);
      await NFT.stake(IDENTITY_ID, initial, 6);
      await NFT.increaseStake(1, added);

      const pos = await NFT.getPosition(1);
      expect(pos.stakedAmount).to.equal(initial + added);
    });

    it('emits PositionIncreased', async () => {
      const initial = hre.ethers.parseEther('50000');
      const added = hre.ethers.parseEther('10000');
      await TokenContract.approve(await NFT.getAddress(), initial + added);
      await NFT.stake(IDENTITY_ID, initial, 6);

      await expect(NFT.increaseStake(1, added))
        .to.emit(NFT, 'PositionIncreased')
        .withArgs(1, added, initial + added);
    });

    it('only owner can increase stake', async () => {
      const amount = hre.ethers.parseEther('50000');
      await TokenContract.approve(await NFT.getAddress(), amount);
      await NFT.stake(IDENTITY_ID, amount, 6);

      await expect(
        NFT.connect(accounts[5]).increaseStake(1, hre.ethers.parseEther('1000')),
      ).to.be.revertedWithCustomError(NFT, 'NotPositionOwner');
    });
  });

  describe('conviction and multiplier', () => {
    it('getConviction returns stakedAmount * lockEpochs', async () => {
      const amount = hre.ethers.parseEther('100000');
      await TokenContract.approve(await NFT.getAddress(), amount);
      await NFT.stake(IDENTITY_ID, amount, 12);

      const conviction = await NFT.getConviction(1);
      expect(conviction).to.equal(amount * 12n);
    });

    const tiers: [number, bigint][] = [
      [1, SCALE18],
      [2, 15n * SCALE18 / 10n],
      [3, 2n * SCALE18],
      [6, 35n * SCALE18 / 10n],
      [12, 6n * SCALE18],
    ];

    for (const [lockEpochs, expectedMult] of tiers) {
      it(`lockEpochs=${lockEpochs} → multiplier=${Number(expectedMult * 10n / SCALE18) / 10}x`, async () => {
        const amount = hre.ethers.parseEther('50000');
        await TokenContract.approve(await NFT.getAddress(), amount);
        await NFT.stake(IDENTITY_ID, amount, lockEpochs);
        expect(await NFT.getMultiplier(1)).to.equal(expectedMult);
      });
    }
  });

  describe('regression: tokens held in contract (not StakingStorage)', () => {
    it('contract balance increases on stake', async () => {
      const amount = hre.ethers.parseEther('50000');
      await TokenContract.approve(await NFT.getAddress(), amount);
      const nftAddr = await NFT.getAddress();

      const balBefore = await TokenContract.balanceOf(nftAddr);
      await NFT.stake(IDENTITY_ID, amount, 6);
      const balAfter = await TokenContract.balanceOf(nftAddr);

      expect(balAfter - balBefore).to.equal(amount);
    });

    it('contract balance increases on increaseStake', async () => {
      const initial = hre.ethers.parseEther('50000');
      const added = hre.ethers.parseEther('10000');
      await TokenContract.approve(await NFT.getAddress(), initial + added);
      await NFT.stake(IDENTITY_ID, initial, 6);

      const nftAddr = await NFT.getAddress();
      const balBefore = await TokenContract.balanceOf(nftAddr);
      await NFT.increaseStake(1, added);
      const balAfter = await TokenContract.balanceOf(nftAddr);

      expect(balAfter - balBefore).to.equal(added);
    });
  });

  describe('ERC-721 transferability', () => {
    it('transferring the NFT transfers position ownership', async () => {
      const amount = hre.ethers.parseEther('50000');
      await TokenContract.approve(await NFT.getAddress(), amount);
      await NFT.stake(IDENTITY_ID, amount, 6);

      await NFT.transferFrom(accounts[0].address, accounts[7].address, 1);

      expect(await NFT.ownerOf(1)).to.equal(accounts[7].address);
      const pos = await NFT.getPosition(1);
      expect(pos.owner_).to.equal(accounts[7].address);
      expect(pos.stakedAmount).to.equal(amount);
    });
  });

  describe('ERC-721 enumeration', () => {
    it('totalSupply and tokenOfOwnerByIndex work', async () => {
      const amount = hre.ethers.parseEther('25000');
      await TokenContract.approve(await NFT.getAddress(), amount * 3n);
      await NFT.stake(IDENTITY_ID, amount, 1);
      await NFT.stake(IDENTITY_ID, amount, 3);
      await NFT.stake(2, amount, 6);

      expect(await NFT.totalSupply()).to.equal(3);
      expect(await NFT.tokenOfOwnerByIndex(accounts[0].address, 0)).to.equal(1);
      expect(await NFT.tokenOfOwnerByIndex(accounts[0].address, 1)).to.equal(2);
      expect(await NFT.tokenOfOwnerByIndex(accounts[0].address, 2)).to.equal(3);
    });
  });

  describe('view functions', () => {
    it('getPosition returns all fields', async () => {
      const amount = hre.ethers.parseEther('100000');
      await TokenContract.approve(await NFT.getAddress(), amount);
      await NFT.stake(IDENTITY_ID, amount, 6);

      const pos = await NFT.getPosition(1);
      expect(pos.identityId).to.equal(IDENTITY_ID);
      expect(pos.stakedAmount).to.equal(amount);
      expect(pos.lockEpochs).to.equal(6);
      expect(pos.conviction).to.equal(amount * 6n);
      expect(pos.multiplier).to.equal(35n * SCALE18 / 10n);
    });

    it('reverts on nonexistent position', async () => {
      await expect(NFT.getPosition(999)).to.be.reverted;
    });
  });
});

describe('@unit DKGStakingConvictionNFT (time-dependent)', function () {
  const IDENTITY_ID = 1;

  async function deployWithChronos() {
    await hre.deployments.fixture(['DKGStakingConvictionNFT', 'Token', 'Chronos']);
    const Hub = await hre.ethers.getContract<Hub>('Hub');
    const NFT = await hre.ethers.getContract<DKGStakingConvictionNFT>('DKGStakingConvictionNFT');
    const Token = await hre.ethers.getContract<Token>('Token');
    const accounts = await hre.ethers.getSigners();
    await Hub.setContractAddress('HubOwner', accounts[0].address);
    await Hub.setContractAddress('StakingStorage', accounts[18].address);
    await Hub.forwardCall(await NFT.getAddress(), NFT.interface.encodeFunctionData('initialize'));
    return { accounts, Hub, NFT, Token };
  }

  it('regression: increaseStake reverts with PositionExpired after lock expires', async () => {
    const { NFT: nft, Token: tok } = await loadFixture(deployWithChronos);
    const Chronos = await hre.ethers.getContract('Chronos');
    const epochLen = await Chronos.EPOCH_LENGTH();

    const amount = hre.ethers.parseEther('50000');
    const added = hre.ethers.parseEther('10000');
    await tok.approve(await nft.getAddress(), amount + added);
    await nft.stake(IDENTITY_ID, amount, 1);

    await hre.network.provider.send('evm_increaseTime', [Number(epochLen) + 1]);
    await hre.network.provider.send('evm_mine');

    await expect(
      nft.increaseStake(1, added),
    ).to.be.revertedWithCustomError(nft, 'PositionExpired');
  });
});
