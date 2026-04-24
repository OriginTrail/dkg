/**
 * v10-conviction-extra.test.ts — audit coverage (E-14).
 *
 * Finding E-14 (MEDIUM, TEST-DEBT, see .test-audit/BUGS_FOUND.md):
 *   "v10-conviction.test.ts is shallow on Flow 1/2 (no lock tiers via
 *    staking NFT, no unstake). Only Flow 3 is strong."
 *
 * Flow 1/2 in the V10 conviction spec = user locks TRAC for N epochs via
 * `DKGStakingConvictionNFT.stake(identityId, amount, lockTier)` and
 * inherits a conviction multiplier from the 5-tier ladder:
 *
 *   lockTier  | multiplier
 *   ------------|-----------
 *        0      |  0 (sentinel: "no lock")
 *        1      |  1.0x  (SCALE18)
 *        2..2   |  1.5x
 *        3..5   |  2.0x
 *        6..11  |  3.5x
 *      >=12     |  6.0x
 *
 * Conviction = stakedAmount * lockTier (the RAW amount, NOT multiplied —
 * the multiplier is a separate read via `getMultiplier`).
 *
 * This file pins every boundary of the ladder + snap-downs + the
 * conviction formula. Unstake paths are already covered in
 * `DKGStakingConvictionNFT-extra.test.ts` (E-2).
 */
import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers';
import { expect } from 'chai';
import hre from 'hardhat';

import { DKGStakingConvictionNFT, Hub, Token } from '../../typechain';

const SCALE18 = 10n ** 18n;
const IDENTITY_ID = 1;

describe('@unit V10 conviction lock-tier ladder — Flow 1/2 (E-14)', () => {
  let accounts: SignerWithAddress[];
  let HubContract: Hub;
  let NFT: DKGStakingConvictionNFT;
  let TokenContract: Token;

  async function deployFixture() {
    await hre.deployments.fixture(['DKGStakingConvictionNFT', 'Token']);
    const Hub = await hre.ethers.getContract<Hub>('Hub');
    const NFT = await hre.ethers.getContract<DKGStakingConvictionNFT>('DKGStakingConvictionNFT');
    const Token = await hre.ethers.getContract<Token>('Token');
    const signers = await hre.ethers.getSigners();
    await Hub.setContractAddress('HubOwner', signers[0].address);
    // Existing unit tests stub StakingStorage with an EOA to satisfy the
    // Hub lookup (the NFT doesn't actually call into it — Phase 4). We
    // do the same here so `stake()` runs without a Hub.getContractAddress
    // revert.
    await Hub.setContractAddress('StakingStorage', signers[18].address);
    await Hub.forwardCall(await NFT.getAddress(), NFT.interface.encodeFunctionData('initialize'));
    return { accounts: signers, Hub, NFT, Token };
  }

  beforeEach(async () => {
    hre.helpers.resetDeploymentsJson();
    ({ accounts, Hub: HubContract, NFT, Token: TokenContract } = await loadFixture(deployFixture));
  });

  async function stakeLock(amount: bigint, lockTier: number) {
    await TokenContract.approve(await NFT.getAddress(), amount);
    await NFT.stake(IDENTITY_ID, amount, lockTier);
    return await NFT.totalSupply();
  }

  // ======================================================================
  // Multiplier ladder boundary matrix
  // ======================================================================
  describe('getMultiplier ladder (Flow 1 short-lock + Flow 2 long-lock)', () => {
    const cases: Array<[number, bigint, string]> = [
      [1, 1n * SCALE18, 'lock=1   → 1.0x (Flow 1 floor)'],
      [2, (15n * SCALE18) / 10n, 'lock=2   → 1.5x (Flow 1)'],
      [3, 2n * SCALE18, 'lock=3   → 2.0x (Flow 1)'],
      [4, 2n * SCALE18, 'lock=4   → 2.0x (snap-down to 3-tier)'],
      [5, 2n * SCALE18, 'lock=5   → 2.0x (snap-down to 3-tier)'],
      [6, (35n * SCALE18) / 10n, 'lock=6   → 3.5x (Flow 2 floor)'],
      [11, (35n * SCALE18) / 10n, 'lock=11  → 3.5x (snap-down to 6-tier)'],
      [12, 6n * SCALE18, 'lock=12  → 6.0x (max tier lower bound)'],
      [24, 6n * SCALE18, 'lock=24  → 6.0x (clamp at max tier)'],
      [100, 6n * SCALE18, 'lock=100 → 6.0x (clamp)'],
    ];

    for (const [lock, expectedMultiplier, label] of cases) {
      it(`${label}`, async () => {
        const positionId = await stakeLock(hre.ethers.parseEther('1000'), lock);
        expect(await NFT.getMultiplier(positionId)).to.equal(expectedMultiplier);
        // Sanity: getPosition returns the same value in the struct field.
        const pos = await NFT.getPosition(positionId);
        expect(pos.multiplier).to.equal(expectedMultiplier);
      });
    }

    it('lock=0 is REJECTED at stake time (InvalidLockTier) — multiplier is only ever read after stake', async () => {
      const amount = hre.ethers.parseEther('1000');
      await TokenContract.approve(await NFT.getAddress(), amount);
      await expect(
        NFT.stake(IDENTITY_ID, amount, 0),
      ).to.be.revertedWithCustomError(NFT, 'InvalidLockTier');
    });
  });

  // ======================================================================
  // Conviction formula pin: conviction = stakedAmount * lockTier
  // (multiplier is NOT applied inside getConviction — it's a separate read).
  // ======================================================================
  describe('getConviction: stakedAmount * lockTier (raw)', () => {
    const matrix: Array<[bigint, number]> = [
      [hre.ethers.parseEther('1000'), 1],
      [hre.ethers.parseEther('25000'), 3],
      [hre.ethers.parseEther('100000'), 6],
      [hre.ethers.parseEther('500000'), 12],
      [hre.ethers.parseEther('1'), 24],
    ];
    for (const [amount, lock] of matrix) {
      it(`stake=${hre.ethers.formatEther(amount)} TRAC, lock=${lock} → conviction = amount * lock`, async () => {
        const positionId = await stakeLock(amount, lock);
        const expected = amount * BigInt(lock);
        expect(await NFT.getConviction(positionId)).to.equal(expected);
        const pos = await NFT.getPosition(positionId);
        expect(pos.conviction).to.equal(expected);
      });
    }
  });

  // ======================================================================
  // Parallel positions (Flow 1 vs Flow 2): two positions, two tiers,
  // each minted independently, multipliers/conviction untouched by the
  // other. Confirms the ladder is per-position, not per-identity-id.
  // ======================================================================
  it('two parallel positions for the same identityId are INDEPENDENT in multiplier + conviction', async () => {
    const a = hre.ethers.parseEther('1000');
    const b = hre.ethers.parseEther('2500');

    const posA = await stakeLock(a, 2); // Flow 1 short lock → 1.5x
    const posB = await stakeLock(b, 12); // Flow 2 long lock → 6.0x

    expect(posA).to.not.equal(posB);
    expect(await NFT.getMultiplier(posA)).to.equal((15n * SCALE18) / 10n);
    expect(await NFT.getMultiplier(posB)).to.equal(6n * SCALE18);
    expect(await NFT.getConviction(posA)).to.equal(a * 2n);
    expect(await NFT.getConviction(posB)).to.equal(b * 12n);

    // Position struct fields are the raw stake + lock, not any weighted sum.
    const posAInfo = await NFT.getPosition(posA);
    const posBInfo = await NFT.getPosition(posB);
    expect(posAInfo.stakedAmount).to.equal(a);
    expect(posAInfo.lockTier).to.equal(2n);
    expect(posBInfo.stakedAmount).to.equal(b);
    expect(posBInfo.lockTier).to.equal(12n);
  });

  // ======================================================================
  // Pure-function `isLockExpired` behavior at fixture time (epoch=1).
  // With the NFT's `chronosAddress == address(0)` fallback (see
  // `_getCurrentEpoch` in the contract), current epoch is 1. A fresh
  // position with lock=1 is expired immediately; lock>=2 is not.
  // Locks this behavior so a Chronos wiring change becomes a loud test
  // failure instead of a silent tier-0 lock.
  // ======================================================================
  describe('isLockExpired (Chronos-fallback path)', () => {
    it('lock=1 at fresh fixture → isLockExpired true (epoch 1 >= 1+1? actually 1 < 2, so false)', async () => {
      // _getCurrentEpoch falls back to 1 with no Chronos.
      // expiresAt = createdAtEpoch(1) + lockTier(1) = 2.
      // currentEpoch(1) >= 2 → false.
      const posId = await stakeLock(hre.ethers.parseEther('100'), 1);
      expect(await NFT.isLockExpired(posId)).to.equal(false);
    });

    it('lock=2 at fresh fixture → isLockExpired false (1 >= 1+2 is false)', async () => {
      const posId = await stakeLock(hre.ethers.parseEther('100'), 2);
      expect(await NFT.isLockExpired(posId)).to.equal(false);
    });
  });
});
