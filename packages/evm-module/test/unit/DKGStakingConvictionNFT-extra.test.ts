/**
 * DKGStakingConvictionNFT-extra.test.ts — audit coverage.
 *
 * Covers findings (see .test-audit/BUGS_FOUND.md, evm-module):
 *   - E-2  (CRITICAL, SPEC-GAP): `DKGStakingConvictionNFT.unstake` is
 *     completely untested — `LockNotExpired`, `InsufficientStake`, partial
 *     withdraw vs full burn, and non-owner unstake are all uncovered.
 *   - E-16 (MEDIUM, TEST-DEBT): existing tests stub `StakingStorage` with
 *     an EOA. Real flow delegates to `Staking`. This file deploys the real
 *     `StakingStorage` contract into the fixture and pins what the
 *     NFT actually does with it (currently: stores the address but does
 *     NOT delegate — Phase 4 placeholder). A future Phase 5 wiring will
 *     flip this test into a positive delegation assertion; until then the
 *     test documents the drift.
 */
import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers';
import { expect } from 'chai';
import hre from 'hardhat';

import { Chronos, DKGStakingConvictionNFT, Hub, StakingStorage, Token } from '../../typechain';

type Fixture = {
  accounts: SignerWithAddress[];
  Hub: Hub;
  NFT: DKGStakingConvictionNFT;
  Token: Token;
  Chronos: Chronos;
  StakingStorage: StakingStorage;
};

describe('@unit DKGStakingConvictionNFT — extra audit coverage (E-2, E-16)', () => {
  let accounts: SignerWithAddress[];
  let HubContract: Hub;
  let NFT: DKGStakingConvictionNFT;
  let TokenContract: Token;
  let ChronosContract: Chronos;
  let StakingStorageContract: StakingStorage;

  const IDENTITY_ID = 1;

  async function deployFixture(): Promise<Fixture> {
    // Deploy the REAL StakingStorage + Chronos, not EOA stubs (E-16).
    await hre.deployments.fixture([
      'Hub',
      'Token',
      'Chronos',
      'StakingStorage',
      'DKGStakingConvictionNFT',
    ]);
    const Hub = await hre.ethers.getContract<Hub>('Hub');
    const Token = await hre.ethers.getContract<Token>('Token');
    const Chronos = await hre.ethers.getContract<Chronos>('Chronos');
    const StakingStorage = await hre.ethers.getContract<StakingStorage>('StakingStorage');
    const NFT = await hre.ethers.getContract<DKGStakingConvictionNFT>('DKGStakingConvictionNFT');
    const signers = await hre.ethers.getSigners();
    await Hub.setContractAddress('HubOwner', signers[0].address);
    // Re-initialize the NFT so it picks up the REAL StakingStorage / Chronos
    // that were deployed above. Everything else (Token) the fixture already
    // wired via hardhat-deploy.
    await Hub.forwardCall(await NFT.getAddress(), NFT.interface.encodeFunctionData('initialize'));
    return { accounts: signers, Hub, NFT, Token, Chronos, StakingStorage };
  }

  beforeEach(async () => {
    hre.helpers.resetDeploymentsJson();
    ({
      accounts,
      Hub: HubContract,
      NFT,
      Token: TokenContract,
      Chronos: ChronosContract,
      StakingStorage: StakingStorageContract,
    } = await loadFixture(deployFixture));
  });

  // ======================================================================
  // E-16 — wire the NFT against the real StakingStorage contract.
  // ======================================================================
  describe('E-16: real StakingStorage wire (not an EOA stub)', () => {
    it('stakingStorageAddress resolves to a contract, not an EOA', async () => {
      const ssAddr = await NFT.stakingStorageAddress();
      expect(ssAddr).to.equal(await StakingStorageContract.getAddress());

      const code = await hre.ethers.provider.getCode(ssAddr);
      // EOA has code '0x'; a real contract has non-empty runtime.
      expect(code.length).to.be.gt(2);
    });

    it('SPEC-DRIFT: stake() does NOT delegate to StakingStorage (Phase 4 placeholder)', async () => {
      // Spec target (Phase 5): `stake` should move TRAC into StakingStorage
      // and bump total delegated stake. Phase 4 code just transfers TRAC
      // into the NFT contract itself (see DKGStakingConvictionNFT.sol
      // lines 87-116). We PIN that drift here: StakingStorage's totalStake
      // is untouched by the NFT. When Phase 5 ships, this assertion will
      // flip from `.to.equal(0n)` to `.to.equal(amount)` — a noisy test
      // failure so the drift is impossible to miss.
      const amount = hre.ethers.parseEther('50000');
      await TokenContract.approve(await NFT.getAddress(), amount);

      const totalBefore = await StakingStorageContract.getTotalStake();
      const nodeDataBefore = await StakingStorageContract.getNodeStake(IDENTITY_ID);

      await NFT.stake(IDENTITY_ID, amount, 6);

      const totalAfter = await StakingStorageContract.getTotalStake();
      const nodeDataAfter = await StakingStorageContract.getNodeStake(IDENTITY_ID);
      // Phase 4 placeholder: no StakingStorage mutation.
      expect(totalAfter - totalBefore, 'total stake untouched in Phase 4').to.equal(0n);
      expect(nodeDataAfter - nodeDataBefore, 'node stake untouched in Phase 4').to.equal(0n);

      // TRAC landed on the NFT itself — mirrors the regression the existing
      // DKGStakingConvictionNFT.test.ts "tokens held in contract" test
      // already covers but with the real StakingStorage alongside to pin
      // the boundary.
      expect(await TokenContract.balanceOf(await NFT.getAddress())).to.equal(amount);
    });
  });

  // ======================================================================
  // E-2 — unstake matrix. None of this was previously covered.
  // ======================================================================
  describe('E-2: unstake full matrix', () => {
    async function stakeAs(signer: SignerWithAddress, amount: bigint, lockTier: number) {
      await TokenContract.connect(accounts[0]).transfer(signer.address, amount);
      await TokenContract.connect(signer).approve(await NFT.getAddress(), amount);
      await NFT.connect(signer).stake(IDENTITY_ID, amount, lockTier);
      return await NFT.totalSupply();
    }

    it('LockNotExpired reverts before the lock expires', async () => {
      const amount = hre.ethers.parseEther('50000');
      const lock = 6;
      await TokenContract.approve(await NFT.getAddress(), amount);
      await NFT.stake(IDENTITY_ID, amount, lock);
      const positionId = await NFT.totalSupply();

      // Chronos is at epoch 1 immediately after deploy (the deploy script
      // pins a fresh epoch). Current epoch < createdAt + lock → LockNotExpired.
      await expect(NFT.unstake(positionId, amount)).to.be.revertedWithCustomError(
        NFT,
        'LockNotExpired',
      );
    });

    it('InsufficientStake reverts when amount > stakedAmount (even after lock expires)', async () => {
      const amount = hre.ethers.parseEther('1000');
      const lock = 1;
      await TokenContract.approve(await NFT.getAddress(), amount);
      await NFT.stake(IDENTITY_ID, amount, lock);
      const positionId = await NFT.totalSupply();

      // Advance past the lock window so LockNotExpired does NOT mask the
      // InsufficientStake branch.
      const epochLen = Number(await ChronosContract.epochLength());
      for (let i = 0; i < lock + 1; i++) {
        await hre.ethers.provider.send('evm_increaseTime', [epochLen + 1]);
        await hre.ethers.provider.send('evm_mine', []);
      }
      const now = await ChronosContract.getCurrentEpoch();
      expect(now).to.be.gte(1n + BigInt(lock));

      await expect(
        NFT.unstake(positionId, amount + 1n),
      ).to.be.revertedWithCustomError(NFT, 'InsufficientStake');
    });

    it('partial withdraw decrements stakedAmount and keeps the NFT alive', async () => {
      const amount = hre.ethers.parseEther('1000');
      const lock = 1;
      await TokenContract.approve(await NFT.getAddress(), amount);
      await NFT.stake(IDENTITY_ID, amount, lock);
      const positionId = await NFT.totalSupply();

      const epochLen = Number(await ChronosContract.epochLength());
      for (let i = 0; i < lock + 1; i++) {
        await hre.ethers.provider.send('evm_increaseTime', [epochLen + 1]);
        await hre.ethers.provider.send('evm_mine', []);
      }

      const partial = amount / 3n;
      const balBefore = await TokenContract.balanceOf(accounts[0].address);
      await expect(NFT.unstake(positionId, partial))
        .to.emit(NFT, 'PositionUnstaked')
        .withArgs(positionId, partial);
      // NFT still owned; position still live.
      expect(await NFT.ownerOf(positionId)).to.equal(accounts[0].address);
      const pos = await NFT.getPosition(positionId);
      expect(pos.stakedAmount).to.equal(amount - partial);

      // TRAC flowed back to the owner.
      const balAfter = await TokenContract.balanceOf(accounts[0].address);
      expect(balAfter - balBefore).to.equal(partial);
    });

    it('full withdraw burns the NFT and clears the position', async () => {
      const amount = hre.ethers.parseEther('500');
      const lock = 1;
      await TokenContract.approve(await NFT.getAddress(), amount);
      await NFT.stake(IDENTITY_ID, amount, lock);
      const positionId = await NFT.totalSupply();

      const epochLen = Number(await ChronosContract.epochLength());
      for (let i = 0; i < lock + 1; i++) {
        await hre.ethers.provider.send('evm_increaseTime', [epochLen + 1]);
        await hre.ethers.provider.send('evm_mine', []);
      }

      await expect(NFT.unstake(positionId, amount))
        .to.emit(NFT, 'PositionUnstaked')
        .withArgs(positionId, amount);

      // Burn assertion: ownerOf must revert (ERC-721: no owner for burned token).
      await expect(NFT.ownerOf(positionId)).to.be.reverted;
      // Position struct cleared. `positions(id)` returns zero fields.
      const raw = await NFT.positions(positionId);
      expect(raw.stakedAmount).to.equal(0n);
      expect(raw.identityId).to.equal(0n);
      expect(raw.lockTier).to.equal(0n);
      expect(raw.createdAtEpoch).to.equal(0n);
    });

    it('non-owner unstake reverts NotPositionOwner', async () => {
      const amount = hre.ethers.parseEther('500');
      const lock = 1;
      const staker = accounts[0];
      const attacker = accounts[4];
      await TokenContract.connect(staker).approve(await NFT.getAddress(), amount);
      await NFT.connect(staker).stake(IDENTITY_ID, amount, lock);
      const positionId = await NFT.totalSupply();

      const epochLen = Number(await ChronosContract.epochLength());
      for (let i = 0; i < lock + 1; i++) {
        await hre.ethers.provider.send('evm_increaseTime', [epochLen + 1]);
        await hre.ethers.provider.send('evm_mine', []);
      }

      await expect(NFT.connect(attacker).unstake(positionId, amount))
        .to.be.revertedWithCustomError(NFT, 'NotPositionOwner')
        .withArgs(positionId, attacker.address);
    });

    it('unstake on a non-existent position reverts (ERC721: _requireOwned)', async () => {
      await expect(NFT.unstake(999, 1)).to.be.reverted;
    });

    it('partial then full: two calls drain the stake and burn on the second', async () => {
      // Two-step drain. Confirms `_burn` only fires when stakedAmount hits
      // zero, matching the spec: "burn the NFT if the full amount is
      // withdrawn".
      const amount = hre.ethers.parseEther('300');
      const lock = 1;
      await TokenContract.approve(await NFT.getAddress(), amount);
      await NFT.stake(IDENTITY_ID, amount, lock);
      const positionId = await NFT.totalSupply();

      const epochLen = Number(await ChronosContract.epochLength());
      for (let i = 0; i < lock + 1; i++) {
        await hre.ethers.provider.send('evm_increaseTime', [epochLen + 1]);
        await hre.ethers.provider.send('evm_mine', []);
      }

      await NFT.unstake(positionId, amount / 2n);
      // still alive
      expect(await NFT.ownerOf(positionId)).to.equal(accounts[0].address);

      await NFT.unstake(positionId, amount / 2n);
      // burned
      await expect(NFT.ownerOf(positionId)).to.be.reverted;
    });

    // Sanity glue to prove setup works with a non-default signer (fund
    // flow via accounts[0] top-up). Keeps the `stakeAs` helper exercised
    // so future additions can piggyback on it.
    it('sanity: staking from a non-deployer signer works', async () => {
      const positionId = await stakeAs(accounts[3], hre.ethers.parseEther('25000'), 2);
      expect(await NFT.ownerOf(positionId)).to.equal(accounts[3].address);
    });
  });
});
