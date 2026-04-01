import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { loadFixture, time } from '@nomicfoundation/hardhat-network-helpers';
import { expect } from 'chai';
import hre from 'hardhat';

import { PublishingConvictionAccount, Hub, Chronos } from '../../typechain';

type Fixture = {
  accounts: SignerWithAddress[];
  Hub: Hub;
  PCA: PublishingConvictionAccount;
  Chronos: Chronos;
};

describe('@unit PublishingConvictionAccount contract', function () {
  let accounts: SignerWithAddress[];
  let Hub: Hub;
  let PCA: PublishingConvictionAccount;
  let ChronosContract: Chronos;

  async function deployFixture(): Promise<Fixture> {
    await hre.deployments.fixture(['PublishingConvictionAccount']);
    Hub = await hre.ethers.getContract<Hub>('Hub');
    PCA = await hre.ethers.getContract<PublishingConvictionAccount>('PublishingConvictionAccount');
    ChronosContract = await hre.ethers.getContract<Chronos>('Chronos');
    accounts = await hre.ethers.getSigners();
    await Hub.setContractAddress('HubOwner', accounts[0].address);
    return { accounts, Hub, PCA, Chronos: ChronosContract };
  }

  beforeEach(async () => {
    hre.helpers.resetDeploymentsJson();
    ({ accounts, Hub, PCA, Chronos: ChronosContract } = await loadFixture(deployFixture));
  });

  // ========================================================================
  // createAccount
  // ========================================================================

  describe('createAccount', () => {
    it('creates an account with 12-month lock, correct conviction, and epoch from Chronos', async () => {
      const token = await hre.ethers.getContract('Token');
      const amount = hre.ethers.parseEther('100000');

      // Advance time so Chronos returns epoch > 1. This proves createAccount
      // reads from Chronos rather than hardcoding epoch 1.
      const epochLength = await ChronosContract.EPOCH_LENGTH();
      await time.increase(epochLength * 3n);

      const expectedEpoch = await ChronosContract.getCurrentEpoch();
      expect(expectedEpoch).to.be.greaterThan(1n);

      await token.approve(await PCA.getAddress(), amount);
      const tx = await PCA.createAccount(amount);
      await tx.wait();

      const info = await PCA.getAccountInfo(1);

      expect(info.admin).to.equal(accounts[0].address);
      expect(info.lockedBalance).to.equal(amount);
      expect(info.topUpBalance).to.equal(0);
      expect(info.initialCommitment).to.equal(amount);
      expect(info.createdAtEpoch).to.equal(expectedEpoch);
      // conviction = amount * 12
      expect(info.conviction).to.equal(amount * 12n);
    });

    it('emits AccountCreated event', async () => {
      const token = await hre.ethers.getContract('Token');
      const amount = hre.ethers.parseEther('100000');

      await token.approve(await PCA.getAddress(), amount);

      await expect(PCA.createAccount(amount))
        .to.emit(PCA, 'AccountCreated')
        .withArgs(1, accounts[0].address, amount, amount * 12n);
    });

    it('transfers TRAC from caller to contract', async () => {
      const token = await hre.ethers.getContract('Token');
      const amount = hre.ethers.parseEther('100000');
      const pcaAddress = await PCA.getAddress();

      await token.approve(pcaAddress, amount);

      const balanceBefore = await token.balanceOf(pcaAddress);
      await PCA.createAccount(amount);
      const balanceAfter = await token.balanceOf(pcaAddress);

      expect(balanceAfter - balanceBefore).to.equal(amount);
    });

    it('sets admin as authorized key', async () => {
      const token = await hre.ethers.getContract('Token');
      const amount = hre.ethers.parseEther('100000');

      await token.approve(await PCA.getAddress(), amount);
      await PCA.createAccount(amount);

      expect(await PCA.authorizedKeys(1, accounts[0].address)).to.be.true;
    });

    it('reverts with ZeroAmount when amount is 0', async () => {
      await expect(PCA.createAccount(0)).to.be.revertedWithCustomError(PCA, 'ZeroAmount');
    });

    it('reverts with AdminAlreadyHasAccount on duplicate', async () => {
      const token = await hre.ethers.getContract('Token');
      const amount = hre.ethers.parseEther('100000');

      await token.approve(await PCA.getAddress(), amount * 2n);
      await PCA.createAccount(amount);

      await expect(PCA.createAccount(amount)).to.be.revertedWithCustomError(
        PCA,
        'AdminAlreadyHasAccount',
      );
    });

    it('has no lockEpochs parameter (enforced 12-month term)', async () => {
      // Verify the ABI only has createAccount(uint256), not createAccount(uint256,uint40)
      const createFuncs = PCA.interface.fragments
        .filter((f): f is import('ethers').FunctionFragment => f.type === 'function' && f.name === 'createAccount');
      expect(createFuncs).to.have.lengthOf(1);
      expect(createFuncs[0].inputs).to.have.lengthOf(1);
      expect(createFuncs[0].inputs[0].type).to.equal('uint256');

      const lockDuration = await PCA.LOCK_DURATION_EPOCHS();
      expect(lockDuration).to.equal(12);
    });
  });

  // ========================================================================
  // Discount tiers
  // ========================================================================

  describe('discount tiers', () => {
    async function createAccountWithAmount(amount: bigint) {
      const token = await hre.ethers.getContract('Token');
      await token.approve(await PCA.getAddress(), amount);
      await PCA.createAccount(amount);
    }

    it('returns 0% discount for below 25,000 TRAC', async () => {
      await createAccountWithAmount(hre.ethers.parseEther('24999'));
      expect(await PCA.getDiscount(1)).to.equal(0);
    });

    it('returns 10% (1000 bps) for 25,000 TRAC', async () => {
      await createAccountWithAmount(hre.ethers.parseEther('25000'));
      expect(await PCA.getDiscount(1)).to.equal(1000);
    });

    it('returns 20% (2000 bps) for 50,000 TRAC', async () => {
      await createAccountWithAmount(hre.ethers.parseEther('50000'));
      expect(await PCA.getDiscount(1)).to.equal(2000);
    });

    it('returns 30% (3000 bps) for 100,000 TRAC', async () => {
      await createAccountWithAmount(hre.ethers.parseEther('100000'));
      expect(await PCA.getDiscount(1)).to.equal(3000);
    });

    it('returns 40% (4000 bps) for 250,000 TRAC', async () => {
      await createAccountWithAmount(hre.ethers.parseEther('250000'));
      expect(await PCA.getDiscount(1)).to.equal(4000);
    });

    it('returns 50% (5000 bps) for 500,000 TRAC', async () => {
      await createAccountWithAmount(hre.ethers.parseEther('500000'));
      expect(await PCA.getDiscount(1)).to.equal(5000);
    });

    it('returns 75% (7500 bps) for 1,000,000 TRAC', async () => {
      await createAccountWithAmount(hre.ethers.parseEther('1000000'));
      expect(await PCA.getDiscount(1)).to.equal(7500);
    });

    it('returns 75% (7500 bps) for 2,000,000 TRAC (above max tier)', async () => {
      await createAccountWithAmount(hre.ethers.parseEther('2000000'));
      expect(await PCA.getDiscount(1)).to.equal(7500);
    });

    it('returns tier below when between thresholds', async () => {
      // Test just-below each threshold to catch off-by-one in tier boundaries
      const betweenCases: Array<[string, number]> = [
        ['49999', 1000],   // just below 50K -> 10%
        ['99999', 2000],   // just below 100K -> 20%
        ['249999', 3000],  // just below 250K -> 30%
        ['499999', 4000],  // just below 500K -> 40%
        ['999999', 5000],  // just below 1M -> 50%
      ];

      for (const [amount, expectedBps] of betweenCases) {
        // Each iteration needs a fresh account from a different admin
        const idx = betweenCases.indexOf(betweenCases.find(c => c[0] === amount)!);
        const signer = accounts[idx + 1]; // offset by 1, accounts[0] is deployer
        const token = await hre.ethers.getContract('Token');
        const parsedAmount = hre.ethers.parseEther(amount);

        await token.transfer(signer.address, parsedAmount);
        await token.connect(signer).approve(await PCA.getAddress(), parsedAmount);
        await PCA.connect(signer).createAccount(parsedAmount);

        const accountId = await PCA.adminToAccountId(signer.address);
        expect(await PCA.getDiscount(accountId)).to.equal(expectedBps);
      }
    });
  });

  // ========================================================================
  // getDiscountedCost
  // ========================================================================

  describe('getDiscountedCost', () => {
    it('applies 30% discount to base cost for 100K commitment', async () => {
      const token = await hre.ethers.getContract('Token');
      const amount = hre.ethers.parseEther('100000');
      const baseCost = hre.ethers.parseEther('1000');

      await token.approve(await PCA.getAddress(), amount);
      await PCA.createAccount(amount);

      const discountedCost = await PCA.getDiscountedCost(1, baseCost);
      // 30% discount -> cost = 1000 * 7000/10000 = 700 TRAC
      expect(discountedCost).to.equal(hre.ethers.parseEther('700'));
    });

    it('applies 75% discount for 1M commitment', async () => {
      const token = await hre.ethers.getContract('Token');
      const amount = hre.ethers.parseEther('1000000');
      const baseCost = hre.ethers.parseEther('1000');

      await token.approve(await PCA.getAddress(), amount);
      await PCA.createAccount(amount);

      const discountedCost = await PCA.getDiscountedCost(1, baseCost);
      // 75% discount -> cost = 1000 * 2500/10000 = 250 TRAC
      expect(discountedCost).to.equal(hre.ethers.parseEther('250'));
    });

    it('returns full cost when below minimum tier', async () => {
      const token = await hre.ethers.getContract('Token');
      const amount = hre.ethers.parseEther('10000');
      const baseCost = hre.ethers.parseEther('1000');

      await token.approve(await PCA.getAddress(), amount);
      await PCA.createAccount(amount);

      const discountedCost = await PCA.getDiscountedCost(1, baseCost);
      expect(discountedCost).to.equal(baseCost);
    });
  });

  // ========================================================================
  // topUp
  // ========================================================================

  describe('topUp', () => {
    it('adds to topUpBalance without changing conviction', async () => {
      const token = await hre.ethers.getContract('Token');
      const initialAmount = hre.ethers.parseEther('100000');
      const topUpAmount = hre.ethers.parseEther('50000');

      await token.approve(await PCA.getAddress(), initialAmount + topUpAmount);
      await PCA.createAccount(initialAmount);

      const infoBefore = await PCA.getAccountInfo(1);
      await PCA.topUp(1, topUpAmount);
      const infoAfter = await PCA.getAccountInfo(1);

      expect(infoAfter.topUpBalance).to.equal(topUpAmount);
      expect(infoAfter.lockedBalance).to.equal(initialAmount);
      expect(infoAfter.conviction).to.equal(infoBefore.conviction);
      expect(infoAfter.initialCommitment).to.equal(initialAmount);
    });

    it('discount stays fixed to initial commitment even when top-up crosses next tier', async () => {
      const token = await hre.ethers.getContract('Token');
      // 40K initial = 10% tier. Top up 60K so total funds = 100K (30% tier).
      // Discount must remain 10% because it's based on initialCommitment, not total.
      const initialAmount = hre.ethers.parseEther('40000');
      const topUpAmount = hre.ethers.parseEther('60000');

      await token.approve(await PCA.getAddress(), initialAmount + topUpAmount);
      await PCA.createAccount(initialAmount);

      expect(await PCA.getDiscount(1)).to.equal(1000); // 10%

      await PCA.topUp(1, topUpAmount);

      // Discount must NOT change to 30% despite total funds being 100K
      expect(await PCA.getDiscount(1)).to.equal(1000); // still 10%
    });

    it('emits TopUp event', async () => {
      const token = await hre.ethers.getContract('Token');
      const initialAmount = hre.ethers.parseEther('100000');
      const topUpAmount = hre.ethers.parseEther('50000');

      await token.approve(await PCA.getAddress(), initialAmount + topUpAmount);
      await PCA.createAccount(initialAmount);

      await expect(PCA.topUp(1, topUpAmount))
        .to.emit(PCA, 'TopUp')
        .withArgs(1, topUpAmount, topUpAmount);
    });

    it('reverts when called by non-admin', async () => {
      const token = await hre.ethers.getContract('Token');
      const amount = hre.ethers.parseEther('100000');

      await token.approve(await PCA.getAddress(), amount);
      await PCA.createAccount(amount);

      await expect(
        PCA.connect(accounts[1]).topUp(1, hre.ethers.parseEther('1000')),
      ).to.be.revertedWithCustomError(PCA, 'NotAccountAdmin');
    });

    it('reverts with ZeroAmount when amount is 0', async () => {
      const token = await hre.ethers.getContract('Token');
      const amount = hre.ethers.parseEther('100000');

      await token.approve(await PCA.getAddress(), amount);
      await PCA.createAccount(amount);

      await expect(PCA.topUp(1, 0)).to.be.revertedWithCustomError(PCA, 'ZeroAmount');
    });
  });

  // ========================================================================
  // closeAccount
  // ========================================================================

  describe('closeAccount', () => {
    it('reverts when lock has not expired', async () => {
      const token = await hre.ethers.getContract('Token');
      const amount = hre.ethers.parseEther('100000');

      await token.approve(await PCA.getAddress(), amount);
      await PCA.createAccount(amount);

      await expect(PCA.closeAccount(1)).to.be.revertedWithCustomError(PCA, 'LockNotExpired');
    });

    it('reverts when balances are not zero (even after lock expired)', async () => {
      const token = await hre.ethers.getContract('Token');
      const amount = hre.ethers.parseEther('100000');

      await token.approve(await PCA.getAddress(), amount);
      await PCA.createAccount(amount);

      // Advance time past 12 epochs
      const epochLength = await ChronosContract.EPOCH_LENGTH();
      await time.increase(epochLength * 13n);

      // Still has lockedBalance > 0
      await expect(PCA.closeAccount(1)).to.be.revertedWithCustomError(PCA, 'BalanceNotZero');
    });

    it('reverts when lockedBalance is zero but topUpBalance is non-zero', async () => {
      const hubAddress = await Hub.getAddress();
      const HarnessFactory = await hre.ethers.getContractFactory('PCATestHarness');
      const harness = await HarnessFactory.deploy(hubAddress);
      await harness.waitForDeployment();
      await Hub.setContractAddress('PCATestHarness', await harness.getAddress());
      await harness.initialize();

      const token = await hre.ethers.getContract('Token');
      const amount = hre.ethers.parseEther('100000');
      const topUpAmount = hre.ethers.parseEther('10000');

      await token.approve(await harness.getAddress(), amount + topUpAmount);
      await harness.createAccount(amount);
      await harness.topUp(1, topUpAmount);

      // Advance past lock
      const epochLength = await ChronosContract.EPOCH_LENGTH();
      await time.increase(epochLength * 13n);

      // Zero only lockedBalance, leave topUpBalance non-zero
      await harness.__test_drainBalances(1);
      // Re-add topUpBalance by topping up again
      await token.approve(await harness.getAddress(), topUpAmount);
      await harness.topUp(1, topUpAmount);

      await expect(harness.closeAccount(1)).to.be.revertedWithCustomError(harness, 'BalanceNotZero');
    });

    it('reverts at epoch createdAtEpoch + 11 (one epoch before unlock)', async () => {
      const hubAddress = await Hub.getAddress();
      const HarnessFactory = await hre.ethers.getContractFactory('PCATestHarness');
      const harness = await HarnessFactory.deploy(hubAddress);
      await harness.waitForDeployment();
      await Hub.setContractAddress('PCATestHarness', await harness.getAddress());
      await harness.initialize();

      const token = await hre.ethers.getContract('Token');
      const amount = hre.ethers.parseEther('100000');
      await token.approve(await harness.getAddress(), amount);
      await harness.createAccount(amount);
      await harness.__test_drainBalances(1);

      // Advance to exactly 11 epochs (one before unlock)
      const epochLength = await ChronosContract.EPOCH_LENGTH();
      await time.increase(epochLength * 11n);

      await expect(harness.closeAccount(1)).to.be.revertedWithCustomError(harness, 'LockNotExpired');
    });

    it('succeeds at exactly epoch createdAtEpoch + 12 (first valid unlock epoch)', async () => {
      const hubAddress = await Hub.getAddress();
      const HarnessFactory = await hre.ethers.getContractFactory('PCATestHarness');
      const harness = await HarnessFactory.deploy(hubAddress);
      await harness.waitForDeployment();
      await Hub.setContractAddress('PCATestHarness', await harness.getAddress());
      await harness.initialize();

      const token = await hre.ethers.getContract('Token');
      const amount = hre.ethers.parseEther('100000');
      await token.approve(await harness.getAddress(), amount);
      await harness.createAccount(amount);
      await harness.__test_drainBalances(1);

      // Advance to exactly 12 epochs (the unlock boundary)
      const epochLength = await ChronosContract.EPOCH_LENGTH();
      await time.increase(epochLength * 12n);

      await expect(harness.closeAccount(1))
        .to.emit(harness, 'AccountClosed')
        .withArgs(1, accounts[0].address);
    });

    it('reverts when called by non-admin', async () => {
      const token = await hre.ethers.getContract('Token');
      const amount = hre.ethers.parseEther('100000');

      await token.approve(await PCA.getAddress(), amount);
      await PCA.createAccount(amount);

      await expect(
        PCA.connect(accounts[1]).closeAccount(1),
      ).to.be.revertedWithCustomError(PCA, 'NotAccountAdmin');
    });

    it('closes account after lock expired and balances drained, clears admin mapping', async () => {
      // Deploy test harness that can drain balances (simulating coverPublishingCost from subtask 9)
      const hubAddress = await Hub.getAddress();
      const HarnessFactory = await hre.ethers.getContractFactory('PCATestHarness');
      const harness = await HarnessFactory.deploy(hubAddress);
      await harness.waitForDeployment();

      // Register harness in Hub so it can be initialized
      const harnessAddress = await harness.getAddress();
      await Hub.setContractAddress('PCATestHarness', harnessAddress);
      await harness.initialize();

      const token = await hre.ethers.getContract('Token');
      const amount = hre.ethers.parseEther('100000');

      await token.approve(harnessAddress, amount);
      await harness.createAccount(amount);

      // Verify admin mapping is set
      expect(await harness.adminToAccountId(accounts[0].address)).to.equal(1);

      // Advance past 12 epochs
      const epochLength = await ChronosContract.EPOCH_LENGTH();
      await time.increase(epochLength * 13n);

      // Drain balances via test harness
      await harness.__test_drainBalances(1);

      // Close account
      await expect(harness.closeAccount(1))
        .to.emit(harness, 'AccountClosed')
        .withArgs(1, accounts[0].address);

      // Verify admin mapping is cleared
      expect(await harness.adminToAccountId(accounts[0].address)).to.equal(0);

      // Verify account is deleted (getAccountInfo should revert)
      await expect(harness.getAccountInfo(1)).to.be.revertedWithCustomError(
        harness,
        'AccountNotFound',
      );

      // Verify admin can create a new account
      await token.approve(harnessAddress, amount);
      await harness.createAccount(amount);
      expect(await harness.adminToAccountId(accounts[0].address)).to.equal(2);
    });
  });

  // ========================================================================
  // Authorized keys
  // ========================================================================

  describe('authorized keys', () => {
    it('adds an authorized key', async () => {
      const token = await hre.ethers.getContract('Token');
      const amount = hre.ethers.parseEther('100000');

      await token.approve(await PCA.getAddress(), amount);
      await PCA.createAccount(amount);

      const otherKey = accounts[1].address;
      await PCA.addAuthorizedKey(1, otherKey);
      expect(await PCA.authorizedKeys(1, otherKey)).to.be.true;
    });

    it('emits AuthorizedKeyAdded event', async () => {
      const token = await hre.ethers.getContract('Token');
      const amount = hre.ethers.parseEther('100000');

      await token.approve(await PCA.getAddress(), amount);
      await PCA.createAccount(amount);

      await expect(PCA.addAuthorizedKey(1, accounts[1].address))
        .to.emit(PCA, 'AuthorizedKeyAdded')
        .withArgs(1, accounts[1].address);
    });

    it('removes an authorized key', async () => {
      const token = await hre.ethers.getContract('Token');
      const amount = hre.ethers.parseEther('100000');

      await token.approve(await PCA.getAddress(), amount);
      await PCA.createAccount(amount);

      const otherKey = accounts[1].address;
      await PCA.addAuthorizedKey(1, otherKey);
      await PCA.removeAuthorizedKey(1, otherKey);
      expect(await PCA.authorizedKeys(1, otherKey)).to.be.false;
    });

    it('emits AuthorizedKeyRemoved event', async () => {
      const token = await hre.ethers.getContract('Token');
      const amount = hre.ethers.parseEther('100000');

      await token.approve(await PCA.getAddress(), amount);
      await PCA.createAccount(amount);

      await PCA.addAuthorizedKey(1, accounts[1].address);
      await expect(PCA.removeAuthorizedKey(1, accounts[1].address))
        .to.emit(PCA, 'AuthorizedKeyRemoved')
        .withArgs(1, accounts[1].address);
    });

    it('prevents admin from removing their own key', async () => {
      const token = await hre.ethers.getContract('Token');
      const amount = hre.ethers.parseEther('100000');

      await token.approve(await PCA.getAddress(), amount);
      await PCA.createAccount(amount);

      await expect(
        PCA.removeAuthorizedKey(1, accounts[0].address),
      ).to.be.revertedWithCustomError(PCA, 'CannotRemoveOwnKey');
    });

    it('reverts when non-admin tries to add key', async () => {
      const token = await hre.ethers.getContract('Token');
      const amount = hre.ethers.parseEther('100000');

      await token.approve(await PCA.getAddress(), amount);
      await PCA.createAccount(amount);

      await expect(
        PCA.connect(accounts[1]).addAuthorizedKey(1, accounts[2].address),
      ).to.be.revertedWithCustomError(PCA, 'NotAccountAdmin');
    });

    it('reverts when non-admin tries to remove key', async () => {
      const token = await hre.ethers.getContract('Token');
      const amount = hre.ethers.parseEther('100000');

      await token.approve(await PCA.getAddress(), amount);
      await PCA.createAccount(amount);
      await PCA.addAuthorizedKey(1, accounts[1].address);

      await expect(
        PCA.connect(accounts[1]).removeAuthorizedKey(1, accounts[1].address),
      ).to.be.revertedWithCustomError(PCA, 'NotAccountAdmin');
    });
  });

  // ========================================================================
  // Error paths
  // ========================================================================

  describe('error paths', () => {
    it('reverts with AccountNotFound for nonexistent account', async () => {
      await expect(PCA.getAccountInfo(999)).to.be.revertedWithCustomError(
        PCA,
        'AccountNotFound',
      );
    });

    it('reverts with AccountNotFound for getDiscount on nonexistent account', async () => {
      await expect(PCA.getDiscount(999)).to.be.revertedWithCustomError(
        PCA,
        'AccountNotFound',
      );
    });

    it('reverts with AccountNotFound for topUp on nonexistent account', async () => {
      await expect(PCA.topUp(999, 100)).to.be.revertedWithCustomError(
        PCA,
        'AccountNotFound',
      );
    });
  });

  // ========================================================================
  // No withdraw function
  // ========================================================================

  describe('no withdraw function', () => {
    it('does not have a withdraw function on the contract', async () => {
      const pcaInterface = PCA.interface;
      const functionNames = Object.keys(pcaInterface.fragments)
        .map((key) => {
          const frag = pcaInterface.fragments[Number(key)];
          return frag && 'name' in frag ? frag.name : undefined;
        })
        .filter(Boolean);

      expect(functionNames).to.not.include('withdraw');
    });

    it('does not have a coverPublishingCost function (subtask 9)', async () => {
      const pcaInterface = PCA.interface;
      const functionNames = Object.keys(pcaInterface.fragments)
        .map((key) => {
          const frag = pcaInterface.fragments[Number(key)];
          return frag && 'name' in frag ? frag.name : undefined;
        })
        .filter(Boolean);

      expect(functionNames).to.not.include('coverPublishingCost');
    });
  });

  // ========================================================================
  // Initialization guard
  // ========================================================================

  describe('initialization', () => {
    it('starts nextAccountId at 1', async () => {
      expect(await PCA.nextAccountId()).to.equal(1);
    });

    it('re-initialization is idempotent: refreshes dependencies without resetting nextAccountId', async () => {
      const token = await hre.ethers.getContract('Token');
      const amount = hre.ethers.parseEther('25000');

      // Create an account to advance nextAccountId
      await token.approve(await PCA.getAddress(), amount);
      await PCA.createAccount(amount);
      expect(await PCA.nextAccountId()).to.equal(2);

      // Re-initialize via Hub.forwardCall (simulates Hub.setAndReinitializeContracts)
      const pcaAddress = await PCA.getAddress();
      const initializeData = PCA.interface.encodeFunctionData('initialize');
      await Hub.forwardCall(pcaAddress, initializeData);

      // nextAccountId must NOT reset to 1
      expect(await PCA.nextAccountId()).to.equal(2);

      // Existing account data survives re-initialization
      const info = await PCA.getAccountInfo(1);
      expect(info.admin).to.equal(accounts[0].address);
      expect(info.lockedBalance).to.equal(amount);
    });

    it('increments accountId correctly on sequential creates', async () => {
      const token = await hre.ethers.getContract('Token');
      const amount = hre.ethers.parseEther('25000');

      // Account 1
      await token.approve(await PCA.getAddress(), amount);
      await PCA.createAccount(amount);

      // Account 2 (different admin)
      await token.connect(accounts[1]).approve(await PCA.getAddress(), amount);
      await token.transfer(accounts[1].address, amount);
      await token.connect(accounts[1]).approve(await PCA.getAddress(), amount);
      await PCA.connect(accounts[1]).createAccount(amount);

      const info1 = await PCA.getAccountInfo(1);
      const info2 = await PCA.getAccountInfo(2);
      expect(info1.admin).to.equal(accounts[0].address);
      expect(info2.admin).to.equal(accounts[1].address);
      expect(await PCA.nextAccountId()).to.equal(3);
    });
  });
});
