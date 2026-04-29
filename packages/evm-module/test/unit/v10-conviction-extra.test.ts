/**
 * v10-conviction-extra.test.ts — audit coverage (E-14).
 *
 * Finding E-14 (MEDIUM, TEST-DEBT, see .test-audit/BUGS_FOUND.md):
 *   "v10-conviction.test.ts is shallow on Flow 1/2 (no lock tiers via
 *    staking NFT, no withdraw). Only Flow 3 is strong."
 *
 * Flow 1/2 in the V10 conviction spec = user locks TRAC for N epochs via
 * `DKGStakingConvictionNFT.createConviction(identityId, amount, lockTier)`
 * and inherits a conviction multiplier from the active tier table seeded
 * in `ConvictionStakingStorage._tiers`:
 *
 *   lockTier  | multiplier (1x = 1e18)
 *   ----------|------------------------
 *        0    |  1.0x  (rest state, no lock)
 *        1    |  1.0x  (Flow 1 floor — 30-day lock)
 *        3    |  2.0x  (Flow 1 — 90-day lock)
 *        6    |  3.5x  (Flow 2 floor — 180-day lock)
 *       12    |  6.0x  (Flow 2 max — 366-day lock)
 *
 * Per Phase 5 the legacy 1.5x tier (lockTier=2) was removed; tiers 4/5/7-11
 * were never registered (the active set is {0, 1, 3, 6, 12}). Unregistered
 * tiers revert `InvalidLockTier` at the wrapper layer via
 * `_convictionMultiplier`. Position fields (raw, lockTier, multiplier18) are
 * read from `ConvictionStakingStorage.getPosition(tokenId)` — the V10 NFT
 * is a thin wrapper and intentionally does NOT proxy storage reads.
 *
 * Withdraw paths are already covered in
 * `DKGStakingConvictionNFT-extra.test.ts` (E-2).
 */
import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers';
import { expect } from 'chai';
import { randomBytes } from 'crypto';
import hre from 'hardhat';

import {
  Chronos,
  ConvictionStakingStorage,
  DKGStakingConvictionNFT,
  Hub,
  Profile,
  StakingV10,
  Token,
} from '../../typechain';

const SCALE18 = 10n ** 18n;

describe('@unit V10 conviction lock-tier ladder — Flow 1/2 (E-14)', () => {
  let accounts: SignerWithAddress[];
  let NFT: DKGStakingConvictionNFT;
  let StakingV10Contract: StakingV10;
  let ConvictionStakingStorageContract: ConvictionStakingStorage;
  let ProfileContract: Profile;
  let TokenContract: Token;
  let identityId: number;

  async function deployFixture() {
    await hre.deployments.fixture(['DKGStakingConvictionNFT', 'StakingV10', 'Profile']);
    const Hub = await hre.ethers.getContract<Hub>('Hub');
    const NFT = await hre.ethers.getContract<DKGStakingConvictionNFT>(
      'DKGStakingConvictionNFT',
    );
    const StakingV10 = await hre.ethers.getContract<StakingV10>('StakingV10');
    const ConvictionStakingStorage = await hre.ethers.getContract<ConvictionStakingStorage>(
      'ConvictionStakingStorage',
    );
    const Profile = await hre.ethers.getContract<Profile>('Profile');
    const Token = await hre.ethers.getContract<Token>('Token');
    const Chronos = await hre.ethers.getContract<Chronos>('Chronos');
    const signers = await hre.ethers.getSigners();
    await Hub.setContractAddress('HubOwner', signers[0].address);
    return {
      accounts: signers,
      NFT,
      StakingV10,
      ConvictionStakingStorage,
      Profile,
      Token,
      Chronos,
    };
  }

  beforeEach(async () => {
    hre.helpers.resetDeploymentsJson();
    ({
      accounts,
      NFT,
      StakingV10: StakingV10Contract,
      ConvictionStakingStorage: ConvictionStakingStorageContract,
      Profile: ProfileContract,
      Token: TokenContract,
    } = await loadFixture(deployFixture));

    // Mint a fresh node profile so every stake call has a real identity to
    // delegate against (StakingV10.stake fail-fasts on a non-existent
    // identityId via `profileStorage.profileExists`).
    const nodeId = '0x' + randomBytes(32).toString('hex');
    const tx = await ProfileContract.connect(accounts[1]).createProfile(
      accounts[0].address,
      [],
      `Node ${Math.floor(Math.random() * 1_000_000)}`,
      nodeId,
      0,
    );
    const receipt = await tx.wait();
    identityId = Number(receipt!.logs[0].topics[1]);
  });

  // Helper: stake `amount` from the deployer at `lockTier` and return the
  // freshly minted tokenId (parsed off the wrapper-layer PositionCreated
  // event so we don't have to track nextTokenId externally).
  async function stakeLock(amount: bigint, lockTier: number): Promise<bigint> {
    await TokenContract.mint(accounts[0].address, amount);
    await TokenContract.connect(accounts[0]).approve(
      await StakingV10Contract.getAddress(),
      amount,
    );
    const tx = await NFT.connect(accounts[0]).createConviction(identityId, amount, lockTier);
    const receipt = await tx.wait();
    const topic = NFT.interface.getEvent('PositionCreated').topicHash;
    const log = receipt!.logs.find((l) => l.topics[0] === topic)!;
    return BigInt(log.topics[2]);
  }

  // ======================================================================
  // Active-tier multiplier matrix. Phase 5 dropped the 1.5x tier and the
  // 4-5/7-11 snap-down rows the legacy ladder used: only the seeded active
  // tiers {0, 1, 3, 6, 12} are accepted by `_convictionMultiplier`.
  // ======================================================================
  describe('createConviction multiplier ladder (active tiers only)', () => {
    // Seeded baseline (see ConvictionStakingStorage._seedBaselineTiers):
    //   tier 0  → 1.0x (rest state, 0 days)
    //   tier 1  → 1.5x (30 days)
    //   tier 3  → 2.0x (90 days)
    //   tier 6  → 3.5x (180 days)
    //   tier 12 → 6.0x (366 days)
    const cases: Array<[number, bigint, string]> = [
      [0, SCALE18, 'lock=0  → 1.0x (rest-state, no lock — first-class V10 position)'],
      [1, (15n * SCALE18) / 10n, 'lock=1  → 1.5x (30-day lock, Flow 1 floor)'],
      [3, 2n * SCALE18, 'lock=3  → 2.0x (90-day lock, Flow 1)'],
      [6, (35n * SCALE18) / 10n, 'lock=6  → 3.5x (180-day lock, Flow 2 floor)'],
      [12, 6n * SCALE18, 'lock=12 → 6.0x (366-day lock, Flow 2 max)'],
    ];

    for (const [lock, expectedMultiplier, label] of cases) {
      it(`${label}`, async () => {
        const tokenId = await stakeLock(hre.ethers.parseEther('1000'), lock);
        const pos = await ConvictionStakingStorageContract.getPosition(tokenId);
        expect(pos.multiplier18).to.equal(expectedMultiplier);
        expect(pos.lockTier).to.equal(BigInt(lock));
      });
    }

    // Negative-tier matrix: Phase 5 explicitly DROPPED tier 2, and 4/5/7-11
    // were never registered. `_convictionMultiplier` must reject every one
    // of them via `InvalidLockTier`.
    const rejected = [2, 4, 5, 7, 11, 13, 24, 100];
    for (const lock of rejected) {
      it(`lock=${lock} reverts InvalidLockTier (not in the active tier set)`, async () => {
        const amount = hre.ethers.parseEther('1000');
        await TokenContract.mint(accounts[0].address, amount);
        await TokenContract.connect(accounts[0]).approve(
          await StakingV10Contract.getAddress(),
          amount,
        );
        await expect(
          NFT.connect(accounts[0]).createConviction(identityId, amount, lock),
        ).to.be.revertedWithCustomError(NFT, 'InvalidLockTier');
      });
    }
  });

  // ======================================================================
  // Position raw amount + lockTier are pinned per-position (the storage
  // ledger). Flow 1/2 conviction = raw stake at the chosen tier: rewards
  // get COMPOUNDED into `raw` later (D19) but `lockTier` never changes
  // for a given position. This locks the tier-table read so a future
  // refactor can't silently drop a multiplier row.
  // ======================================================================
  describe('Position storage records raw stake + lock tier', () => {
    const matrix: Array<[bigint, number]> = [
      [hre.ethers.parseEther('1000'), 1],
      [hre.ethers.parseEther('25000'), 3],
      [hre.ethers.parseEther('100000'), 6],
      [hre.ethers.parseEther('500000'), 12],
    ];
    for (const [amount, lock] of matrix) {
      it(`stake=${hre.ethers.formatEther(amount)} TRAC, lock=${lock} → position.raw=amount, position.lockTier=lock`, async () => {
        const tokenId = await stakeLock(amount, lock);
        const pos = await ConvictionStakingStorageContract.getPosition(tokenId);
        expect(pos.raw).to.equal(amount);
        expect(pos.lockTier).to.equal(BigInt(lock));
      });
    }
  });

  // ======================================================================
  // Two parallel positions on the same identityId stay independent: each
  // has its own multiplier + raw stake + tokenId. Confirms the ladder is
  // per-position, not per-identity-id (D21 — NFTs are ephemeral, the
  // tokenId is the unit of accounting, not the staker × identity tuple).
  // ======================================================================
  it('two parallel positions for the same identityId are INDEPENDENT (multiplier + raw + tokenId)', async () => {
    const a = hre.ethers.parseEther('1000');
    const b = hre.ethers.parseEther('2500');

    const posA = await stakeLock(a, 3); // Flow 1 → 2.0x
    const posB = await stakeLock(b, 12); // Flow 2 max → 6.0x

    expect(posA).to.not.equal(posB);

    const posAInfo = await ConvictionStakingStorageContract.getPosition(posA);
    const posBInfo = await ConvictionStakingStorageContract.getPosition(posB);

    expect(posAInfo.multiplier18).to.equal(2n * SCALE18);
    expect(posBInfo.multiplier18).to.equal(6n * SCALE18);
    expect(posAInfo.raw).to.equal(a);
    expect(posBInfo.raw).to.equal(b);
    expect(posAInfo.lockTier).to.equal(3n);
    expect(posBInfo.lockTier).to.equal(12n);
    // Same identity on both — Flow 1 and Flow 2 stack on the same node.
    expect(posAInfo.identityId).to.equal(posBInfo.identityId);
    expect(posAInfo.identityId).to.equal(BigInt(identityId));
  });

  // ======================================================================
  // Lock-expiry semantics. `expiryTimestamp == 0` is the rest-state
  // sentinel (tier 0, permanent), every other tier sets a future
  // timestamp computed inside `_computeExpiryTimestamp` from the active
  // tier's `durationSeconds`. Pinning these so a Chronos / tier-table
  // wiring change becomes a loud test failure instead of a silent
  // never-expiring lock.
  // ======================================================================
  describe('Position expiryTimestamp (rest-state sentinel + non-zero locks)', () => {
    it('lock=0 (rest state) sets expiryTimestamp=0 (permanent — no boost to decay)', async () => {
      const tokenId = await stakeLock(hre.ethers.parseEther('100'), 0);
      const pos = await ConvictionStakingStorageContract.getPosition(tokenId);
      expect(pos.expiryTimestamp).to.equal(0n);
    });

    it('lock=1 sets expiryTimestamp > current block timestamp (non-zero, future)', async () => {
      const tokenId = await stakeLock(hre.ethers.parseEther('100'), 1);
      const pos = await ConvictionStakingStorageContract.getPosition(tokenId);
      const block = await hre.ethers.provider.getBlock('latest');
      expect(pos.expiryTimestamp).to.be.gt(BigInt(block!.timestamp));
    });

    it('lock=12 expiry timestamp is strictly later than lock=1 expiry timestamp', async () => {
      const tokenIdShort = await stakeLock(hre.ethers.parseEther('100'), 1);
      const tokenIdLong = await stakeLock(hre.ethers.parseEther('100'), 12);
      const posShort = await ConvictionStakingStorageContract.getPosition(tokenIdShort);
      const posLong = await ConvictionStakingStorageContract.getPosition(tokenIdLong);
      expect(posLong.expiryTimestamp).to.be.gt(posShort.expiryTimestamp);
    });
  });
});
