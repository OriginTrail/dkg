/**
 * DKG v10 conviction NFT audit coverage.
 *
 * Findings covered (see .test-audit/BUGS_FOUND.md):
 *   E-2  (CRITICAL, TEST-DEBT): `DKGStakingConvictionNFT.unstake` full coverage
 *         (LockNotExpired revert, InsufficientStake revert, partial withdraw,
 *         full burn, non-owner revert).
 *   E-6  (HIGH, TEST-DEBT):     `DKGPublishingConvictionNFT` `AccountExpired`
 *         revert paths on `topUp` and `coverPublishingCost`.
 *   E-14 (MEDIUM, SPEC-GAP):    Lock-tier sanity via staking NFT — enumerate
 *         lockTier tiers and confirm conviction/multiplier wiring.
 *   E-16 (MEDIUM, TEST-DEBT):   Replace EOA-StakingStorage fixture with a real
 *         StakingStorage integration (NFT-held TRAC invariant is retained;
 *         real StakingStorage is registered so the Hub dependency resolves
 *         to a live contract rather than an EOA stub).
 */

import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { loadFixture, time } from '@nomicfoundation/hardhat-network-helpers';
import { expect } from 'chai';
import hre from 'hardhat';

import {
  Chronos,
  DKGPublishingConvictionNFT,
  DKGStakingConvictionNFT,
  Hub,
  StakingStorage,
  Token,
} from '../../typechain';

type Fixture = {
  accounts: SignerWithAddress[];
  Hub: Hub;
  StakingNFT: DKGStakingConvictionNFT;
  PublishingNFT: DKGPublishingConvictionNFT;
  Token: Token;
  StakingStorage: StakingStorage;
  Chronos: Chronos;
};

const IDENTITY_ID = 1;

describe('@unit v10 conviction NFT audit', () => {
  let accounts: SignerWithAddress[];
  let HubContract: Hub;
  let StakingNFT: DKGStakingConvictionNFT;
  let PublishingNFT: DKGPublishingConvictionNFT;
  let TokenContract: Token;
  let StakingStorageContract: StakingStorage;
  let ChronosContract: Chronos;

  async function deployFixture(): Promise<Fixture> {
    await hre.deployments.fixture([
      'Hub',
      'Token',
      'Chronos',
      'EpochStorage',
      'StakingStorage',
      'DKGStakingConvictionNFT',
      'DKGPublishingConvictionNFT',
    ]);
    const Hub = await hre.ethers.getContract<Hub>('Hub');
    const StakingNFT = await hre.ethers.getContract<DKGStakingConvictionNFT>(
      'DKGStakingConvictionNFT',
    );
    const PublishingNFT = await hre.ethers.getContract<
      DKGPublishingConvictionNFT
    >('DKGPublishingConvictionNFT');
    const Token = await hre.ethers.getContract<Token>('Token');
    const StakingStorageC = await hre.ethers.getContract<StakingStorage>(
      'StakingStorage',
    );
    const Chronos = await hre.ethers.getContract<Chronos>('Chronos');
    const accounts = await hre.ethers.getSigners();
    await Hub.setContractAddress('HubOwner', accounts[0].address);
    await Token.mint(accounts[0].address, hre.ethers.parseEther('10000000'));
    await Token.mint(accounts[1].address, hre.ethers.parseEther('10000000'));

    // E-16: re-initialize the Staking NFT so it picks up the REAL
    // StakingStorage deployment (deploy tag `StakingStorage`). The default
    // DKGStakingConvictionNFT fixture in DKGStakingConvictionNFT.test.ts
    // uses an EOA stub for StakingStorage; here we exercise the live
    // contract reference to lock the Hub wiring.
    await Hub.forwardCall(
      await StakingNFT.getAddress(),
      StakingNFT.interface.encodeFunctionData('initialize'),
    );

    return {
      accounts,
      Hub,
      StakingNFT,
      PublishingNFT,
      Token,
      StakingStorage: StakingStorageC,
      Chronos,
    };
  }

  beforeEach(async () => {
    hre.helpers.resetDeploymentsJson();
    ({
      accounts,
      Hub: HubContract,
      StakingNFT,
      PublishingNFT,
      Token: TokenContract,
      StakingStorage: StakingStorageContract,
      Chronos: ChronosContract,
    } = await loadFixture(deployFixture));
  });

  async function advanceEpochs(n: number): Promise<void> {
    for (let i = 0; i < n; i++) {
      const remaining = await ChronosContract.timeUntilNextEpoch();
      await time.increase(remaining + 1n);
    }
  }

  // ========================================================================
  // E-16: live StakingStorage wiring sanity check
  // ========================================================================

  describe('E-16 — DKGStakingConvictionNFT uses real StakingStorage reference', () => {
    it('stakingStorageAddress resolves to the live StakingStorage deployment', async () => {
      const liveSSAddr = await StakingStorageContract.getAddress();
      expect(await StakingNFT.stakingStorageAddress()).to.equal(liveSSAddr);
      // And the live address is a contract (extcodesize > 0).
      const code = await hre.ethers.provider.getCode(liveSSAddr);
      expect(code).to.not.equal('0x');
    });
  });

  // ========================================================================
  // E-2: DKGStakingConvictionNFT.unstake full coverage
  // ========================================================================

  describe('E-2 — DKGStakingConvictionNFT.unstake full coverage', () => {
    async function stake(
      signer: SignerWithAddress,
      amount: bigint,
      lockTier: number,
    ): Promise<bigint> {
      // Fund the staker from the deployer if needed and approve.
      if (signer.address !== accounts[0].address) {
        await TokenContract.connect(accounts[0]).transfer(
          signer.address,
          amount,
        );
      }
      await TokenContract.connect(signer).approve(
        await StakingNFT.getAddress(),
        amount,
      );
      const tx = await StakingNFT.connect(signer).stake(
        IDENTITY_ID,
        amount,
        lockTier,
      );
      const receipt = await tx.wait();
      // PositionCreated(uint256,address,uint72,uint96,uint40) — id is topic[1]
      const topic = StakingNFT.interface.getEvent('PositionCreated').topicHash;
      const log = receipt!.logs.find((l) => l.topics[0] === topic)!;
      return BigInt(log.topics[1]);
    }

    it('reverts LockNotExpired when current epoch < createdAt + lockTier', async () => {
      const amount = hre.ethers.parseEther('50000');
      const positionId = await stake(accounts[0], amount, 6);

      await expect(
        StakingNFT.unstake(positionId, amount),
      ).to.be.revertedWithCustomError(StakingNFT, 'LockNotExpired');
    });

    it('non-owner unstake reverts NotPositionOwner', async () => {
      const amount = hre.ethers.parseEther('50000');
      const positionId = await stake(accounts[0], amount, 1);
      await advanceEpochs(1);

      await expect(
        StakingNFT.connect(accounts[1]).unstake(positionId, amount),
      ).to.be.revertedWithCustomError(StakingNFT, 'NotPositionOwner');
    });

    it('reverts InsufficientStake when amount > stakedAmount', async () => {
      const amount = hre.ethers.parseEther('50000');
      const positionId = await stake(accounts[0], amount, 1);
      await advanceEpochs(1);

      const over = amount + 1n;
      await expect(
        StakingNFT.unstake(positionId, over),
      ).to.be.revertedWithCustomError(StakingNFT, 'InsufficientStake');
    });

    it('partial withdraw: reduces stakedAmount, keeps NFT, emits PositionUnstaked', async () => {
      const amount = hre.ethers.parseEther('100000');
      const positionId = await stake(accounts[0], amount, 1);
      await advanceEpochs(1);

      const nftAddr = await StakingNFT.getAddress();
      const userBefore = await TokenContract.balanceOf(accounts[0].address);
      const nftBalBefore = await TokenContract.balanceOf(nftAddr);

      const partial = amount / 4n;
      await expect(StakingNFT.unstake(positionId, partial))
        .to.emit(StakingNFT, 'PositionUnstaked')
        .withArgs(positionId, partial);

      // NFT still owned, position still exists with reduced stake.
      expect(await StakingNFT.ownerOf(positionId)).to.equal(
        accounts[0].address,
      );
      const pos = await StakingNFT.getPosition(positionId);
      expect(pos.stakedAmount).to.equal(amount - partial);

      // TRAC balances: user receives exactly `partial`; NFT contract drops
      // exactly `partial`.
      expect(await TokenContract.balanceOf(accounts[0].address)).to.equal(
        userBefore + partial,
      );
      expect(await TokenContract.balanceOf(nftAddr)).to.equal(
        nftBalBefore - partial,
      );
    });

    it('full withdraw: burns the NFT, deletes the position, user gets all TRAC back', async () => {
      const amount = hre.ethers.parseEther('50000');
      const positionId = await stake(accounts[0], amount, 1);
      await advanceEpochs(1);

      const nftAddr = await StakingNFT.getAddress();
      const userBefore = await TokenContract.balanceOf(accounts[0].address);

      await expect(StakingNFT.unstake(positionId, amount))
        .to.emit(StakingNFT, 'PositionUnstaked')
        .withArgs(positionId, amount);

      // NFT burned: ownerOf reverts, totalSupply drops.
      await expect(StakingNFT.ownerOf(positionId)).to.be.reverted;
      expect(await StakingNFT.balanceOf(accounts[0].address)).to.equal(0n);

      // Position storage cleared (stakedAmount == 0, struct deleted).
      // getPosition calls _requireExists first, which reverts for burned ids.
      await expect(StakingNFT.getPosition(positionId)).to.be.reverted;

      // Full amount back to the user; NFT contract balance of this stake is 0.
      expect(await TokenContract.balanceOf(accounts[0].address)).to.equal(
        userBefore + amount,
      );
    });

    it('multiple partial withdraws until depletion → final withdraw burns NFT', async () => {
      const amount = hre.ethers.parseEther('90000');
      const positionId = await stake(accounts[0], amount, 1);
      await advanceEpochs(1);

      const third = amount / 3n;
      await StakingNFT.unstake(positionId, third);
      await StakingNFT.unstake(positionId, third);
      // still exists
      expect(await StakingNFT.ownerOf(positionId)).to.equal(
        accounts[0].address,
      );
      const remaining = amount - third * 2n;
      await StakingNFT.unstake(positionId, remaining);
      await expect(StakingNFT.ownerOf(positionId)).to.be.reverted;
    });
  });

  // ========================================================================
  // E-14: DKGStakingConvictionNFT lock-tier sanity (Flow 1 / Flow 2 strengthening)
  // ========================================================================

  describe('E-14 — staking NFT lock-tier multiplier ladder', () => {
    const SCALE18 = 10n ** 18n;
    // (lockTier, expected multiplier as fractional-x-SCALE18)
    const tiers: Array<[number, bigint]> = [
      [1, SCALE18],
      [2, (15n * SCALE18) / 10n],
      [3, 2n * SCALE18],
      [6, (35n * SCALE18) / 10n],
      [12, 6n * SCALE18],
      // Boundary: lockTier just above 12 should still cap at 6x.
      [24, 6n * SCALE18],
    ];

    for (const [lockTier, expected] of tiers) {
      it(`lockTier=${lockTier} yields multiplier = ${Number(
        (expected * 10n) / SCALE18,
      ) / 10}x`, async () => {
        const amount = hre.ethers.parseEther('50000');
        await TokenContract.approve(await StakingNFT.getAddress(), amount);
        const tx = await StakingNFT.stake(IDENTITY_ID, amount, lockTier);
        const receipt = await tx.wait();
        const topic =
          StakingNFT.interface.getEvent('PositionCreated').topicHash;
        const log = receipt!.logs.find((l) => l.topics[0] === topic)!;
        const positionId = BigInt(log.topics[1]);

        expect(await StakingNFT.getMultiplier(positionId)).to.equal(expected);
        expect(await StakingNFT.getConviction(positionId)).to.equal(
          amount * BigInt(lockTier),
        );
      });
    }
  });

  // ========================================================================
  // E-6: DKGPublishingConvictionNFT.AccountExpired
  // ========================================================================

  describe('E-6 — DKGPublishingConvictionNFT AccountExpired guard', () => {
    const LOCK_DURATION = 12;

    async function openAccount(
      owner: SignerWithAddress,
      committed: bigint,
    ): Promise<bigint> {
      if (owner.address !== accounts[0].address) {
        await TokenContract.connect(accounts[0]).transfer(
          owner.address,
          committed,
        );
      }
      await TokenContract.connect(owner).approve(
        await PublishingNFT.getAddress(),
        committed,
      );
      await PublishingNFT.connect(owner).createAccount(committed);
      return await PublishingNFT.totalSupply();
    }

    it('topUp reverts with AccountExpired after the 12-epoch window elapses', async () => {
      const owner = accounts[0];
      const committed = hre.ethers.parseEther('100000');
      const accountId = await openAccount(owner, committed);

      // Advance past expiresAtEpoch (createdAt + 12). We're at createdAt now.
      await advanceEpochs(LOCK_DURATION);

      const topAmount = hre.ethers.parseEther('1000');
      await TokenContract.connect(owner).approve(
        await PublishingNFT.getAddress(),
        topAmount,
      );
      await expect(
        PublishingNFT.connect(owner).topUp(accountId, topAmount),
      ).to.be.revertedWithCustomError(PublishingNFT, 'AccountExpired');
    });

    it('topUp reverts with AccountExpired even many epochs past expiry', async () => {
      const owner = accounts[0];
      const committed = hre.ethers.parseEther('100000');
      const accountId = await openAccount(owner, committed);

      await advanceEpochs(LOCK_DURATION + 5);

      const topAmount = hre.ethers.parseEther('1000');
      await TokenContract.connect(owner).approve(
        await PublishingNFT.getAddress(),
        topAmount,
      );
      await expect(
        PublishingNFT.connect(owner).topUp(accountId, topAmount),
      ).to.be.revertedWithCustomError(PublishingNFT, 'AccountExpired');
    });

    it('coverPublishingCost reverts with AccountExpired after the window', async () => {
      // Register account and publishing agent, then impersonate the KAV10
      // caller via Hub's "KnowledgeAssetsV10" registration (same pattern as
      // DKGPublishingConvictionNFT.test.ts).
      const owner = accounts[0];
      const agent = accounts[2];
      const committed = hre.ethers.parseEther('100000');
      const accountId = await openAccount(owner, committed);
      await PublishingNFT.connect(owner).registerAgent(accountId, agent.address);

      const Kav10Signer = accounts[5];
      await HubContract.setContractAddress(
        'KnowledgeAssetsV10',
        Kav10Signer.address,
      );

      // Advance past expiry.
      await advanceEpochs(LOCK_DURATION);

      await expect(
        PublishingNFT.connect(Kav10Signer).coverPublishingCost(
          agent.address,
          hre.ethers.parseEther('1'),
        ),
      ).to.be.revertedWithCustomError(PublishingNFT, 'AccountExpired');
    });

    it('boundary: topUp succeeds at expiresAtEpoch - 1, reverts at expiresAtEpoch', async () => {
      const owner = accounts[0];
      const committed = hre.ethers.parseEther('100000');
      const accountId = await openAccount(owner, committed);
      const info = await PublishingNFT.getAccountInfo(accountId);
      const current = await ChronosContract.getCurrentEpoch();
      const last = BigInt(info.expiresAtEpoch) - 1n; // inclusive last live epoch
      const forward = Number(last - current);
      await advanceEpochs(forward);

      const topAmount = hre.ethers.parseEther('1000');
      await TokenContract.connect(owner).approve(
        await PublishingNFT.getAddress(),
        topAmount * 2n,
      );
      // Still live one epoch before expiry.
      await PublishingNFT.connect(owner).topUp(accountId, topAmount);

      // Advance one more epoch → now at expiresAtEpoch → must revert.
      await advanceEpochs(1);
      await expect(
        PublishingNFT.connect(owner).topUp(accountId, topAmount),
      ).to.be.revertedWithCustomError(PublishingNFT, 'AccountExpired');
    });
  });
});
