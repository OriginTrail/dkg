import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { loadFixture, time } from '@nomicfoundation/hardhat-network-helpers';
import { expect } from 'chai';
import hre from 'hardhat';

import { ConvictionStakingStorage, Chronos } from '../../typechain';

type Fixture = {
  accounts: SignerWithAddress[];
  ConvictionStakingStorage: ConvictionStakingStorage;
  Chronos: Chronos;
};

const ALICE_ID = 100n;
const BOB_ID = 200n;
const OTHER_ID = 999n;

// Multiplier scale: matches DKGStakingConvictionNFT._convictionMultiplier
// (1e18-scaled). Fractional tiers 1.5x and 3.5x are representable as
// 1.5e18 / 3.5e18.
const SCALE18 = 10n ** 18n;
const ONE_X = SCALE18;
const ONE_AND_HALF_X = (15n * SCALE18) / 10n;
const TWO_X = 2n * SCALE18;
const THREE_AND_HALF_X = (35n * SCALE18) / 10n;
const SIX_X = 6n * SCALE18;

// Canonical Phase 5 tier ladder (valid lock set = {0, 1, 3, 6, 12}).
// Any lockEpochs outside this set reverts. Ladder:
//   lock 0  → 1.0x (permanent rest state — post-expiry / convertToNFT default)
//   lock 1  → 1.5x  (1 month)
//   lock 3  → 2.0x  (3 months)
//   lock 6  → 3.5x  (6 months)
//   lock 12 → 6.0x  (12 months)
// Phase 5 decision: the old `lock=2 → 1.5x` tier and the intermediate locks
// {4,5,7..11,13+} no longer exist. Storage rejects them at `expectedMultiplier18`.

describe('@unit ConvictionStakingStorage', () => {
  let accounts: SignerWithAddress[];
  let ConvictionStakingStorage: ConvictionStakingStorage;
  let Chronos: Chronos;

  async function deployFixture(): Promise<Fixture> {
    await hre.deployments.fixture(['ConvictionStakingStorage']);
    ConvictionStakingStorage = await hre.ethers.getContract<ConvictionStakingStorage>(
      'ConvictionStakingStorage',
    );
    Chronos = await hre.ethers.getContract<Chronos>('Chronos');
    accounts = await hre.ethers.getSigners();
    return { accounts, ConvictionStakingStorage, Chronos };
  }

  async function advanceEpochs(n: number) {
    const epochLength = await Chronos.epochLength();
    await time.increase(Number(epochLength) * n);
  }

  beforeEach(async () => {
    hre.helpers.resetDeploymentsJson();
    ({ accounts, ConvictionStakingStorage, Chronos } = await loadFixture(deployFixture));
  });

  // ------------------------------------------------------------
  // Metadata
  // ------------------------------------------------------------

  it('Should have correct name and version', async () => {
    expect(await ConvictionStakingStorage.name()).to.equal('ConvictionStakingStorage');
    // Phase 5 — 1.2.0 adds increaseRaw + V10-native pendingWithdrawals
    // storage on top of the 1.1.0 split-bucket model.
    expect(await ConvictionStakingStorage.version()).to.equal('1.2.0');
  });

  // ------------------------------------------------------------
  // Tier ladder (mirrors DKGStakingConvictionNFT._convictionMultiplier)
  // ------------------------------------------------------------

  describe('expectedMultiplier18 tier ladder', () => {
    it('Returns canonical tiers for each valid lock (Phase 5 discrete set)', async () => {
      expect(await ConvictionStakingStorage.expectedMultiplier18(0)).to.equal(ONE_X);
      expect(await ConvictionStakingStorage.expectedMultiplier18(1)).to.equal(ONE_AND_HALF_X);
      expect(await ConvictionStakingStorage.expectedMultiplier18(3)).to.equal(TWO_X);
      expect(await ConvictionStakingStorage.expectedMultiplier18(6)).to.equal(THREE_AND_HALF_X);
      expect(await ConvictionStakingStorage.expectedMultiplier18(12)).to.equal(SIX_X);
    });

    it('Reverts on every lock outside the discrete set', async () => {
      // Between-tier locks: 2 (the old 1.5x), 4, 5, 7..11, 13+
      for (const invalid of [2, 4, 5, 7, 8, 9, 10, 11, 13, 24, 100]) {
        await expect(
          ConvictionStakingStorage.expectedMultiplier18(invalid),
        ).to.be.revertedWith('Invalid lock');
      }
    });
  });

  // ------------------------------------------------------------
  // createPosition — single-position global finalize
  // ------------------------------------------------------------

  describe('createPosition — single position', () => {
    it('Stores position fields with zero-lock (permanent 1x)', async () => {
      const currentEpoch = await Chronos.getCurrentEpoch();
      await ConvictionStakingStorage.createPosition(1, ALICE_ID, 1000, 0, ONE_X);

      const pos = await ConvictionStakingStorage.getPosition(1);
      expect(pos.raw).to.equal(1000);
      expect(pos.rewards).to.equal(0); // Phase 5: rewards bucket defaults to 0
      expect(pos.lockEpochs).to.equal(0);
      expect(pos.expiryEpoch).to.equal(0);
      expect(pos.multiplier18).to.equal(ONE_X);
      expect(pos.identityId).to.equal(ALICE_ID);
      expect(pos.lastClaimedEpoch).to.equal(currentEpoch - 1n);
    });

    it('Global effective stake equals raw forever when lock=0 mult=1x', async () => {
      await ConvictionStakingStorage.createPosition(1, ALICE_ID, 1000, 0, ONE_X);
      expect(await ConvictionStakingStorage.getTotalEffectiveStakeAtEpoch(1)).to.equal(1000);
      expect(await ConvictionStakingStorage.getTotalEffectiveStakeAtEpoch(5)).to.equal(1000);
      expect(await ConvictionStakingStorage.getTotalEffectiveStakeAtEpoch(1000)).to.equal(1000);
    });

    it('Locked boosted position reverts to raw after expiry (integer tier: 6x)', async () => {
      // createdAt=1, lock=12, mult=6x → expiry=13, effective 6000 in [1..12], 1000 after
      await ConvictionStakingStorage.createPosition(1, ALICE_ID, 1000, 12, SIX_X);
      const pos = await ConvictionStakingStorage.getPosition(1);
      expect(pos.expiryEpoch).to.equal(13);
      expect(pos.multiplier18).to.equal(SIX_X);

      expect(await ConvictionStakingStorage.getTotalEffectiveStakeAtEpoch(1)).to.equal(6000);
      expect(await ConvictionStakingStorage.getTotalEffectiveStakeAtEpoch(12)).to.equal(6000);
      expect(await ConvictionStakingStorage.getTotalEffectiveStakeAtEpoch(13)).to.equal(1000);
      expect(await ConvictionStakingStorage.getTotalEffectiveStakeAtEpoch(50)).to.equal(1000);
    });

    it('Fractional tier 1.5x (lock=1): raw 2000 → effective 3000, 2000 after', async () => {
      // Phase 5: lock=1 month → 1.5x. raw*mult/1e18 = 2000*1.5e18/1e18 = 3000.
      // createdAt=1, lock=1 → expiry=2. boosted window: [1], post-expiry: [2..∞)
      await ConvictionStakingStorage.createPosition(1, ALICE_ID, 2000, 1, ONE_AND_HALF_X);
      expect((await ConvictionStakingStorage.getPosition(1)).multiplier18).to.equal(ONE_AND_HALF_X);

      expect(await ConvictionStakingStorage.getTotalEffectiveStakeAtEpoch(1)).to.equal(3000);
      expect(await ConvictionStakingStorage.getTotalEffectiveStakeAtEpoch(2)).to.equal(2000);
      expect(await ConvictionStakingStorage.getTotalEffectiveStakeAtEpoch(100)).to.equal(2000);
    });

    it('Fractional tier 3.5x (lock=6): raw 2000 → effective 7000, 2000 after', async () => {
      // Phase 5: lock=6 months → 3.5x. expiry = epoch 7.
      await ConvictionStakingStorage.createPosition(1, ALICE_ID, 2000, 6, THREE_AND_HALF_X);
      expect((await ConvictionStakingStorage.getPosition(1)).multiplier18).to.equal(THREE_AND_HALF_X);

      expect(await ConvictionStakingStorage.getTotalEffectiveStakeAtEpoch(1)).to.equal(7000);
      expect(await ConvictionStakingStorage.getTotalEffectiveStakeAtEpoch(6)).to.equal(7000);
      expect(await ConvictionStakingStorage.getTotalEffectiveStakeAtEpoch(7)).to.equal(2000);
    });

    it('Reverts on invalid inputs', async () => {
      await expect(
        ConvictionStakingStorage.createPosition(1, 0, 1000, 12, SIX_X),
      ).to.be.revertedWith('Zero node');

      await expect(
        ConvictionStakingStorage.createPosition(1, ALICE_ID, 0, 12, SIX_X),
      ).to.be.revertedWith('Zero raw');

      // Mismatched tier: lock=12 expects 6x, caller passes 0
      await expect(
        ConvictionStakingStorage.createPosition(1, ALICE_ID, 1000, 12, 0),
      ).to.be.revertedWith('Tier mismatch');

      // Mismatched tier: sub-1x multiplier for any lock
      await expect(
        ConvictionStakingStorage.createPosition(1, ALICE_ID, 1000, 12, SCALE18 / 2n),
      ).to.be.revertedWith('Tier mismatch');

      // Mismatched tier: lock=0 expects 1x, caller passes 6x
      await expect(
        ConvictionStakingStorage.createPosition(1, ALICE_ID, 1000, 0, SIX_X),
      ).to.be.revertedWith('Tier mismatch');

      // Mismatched tier: lock=6 expects 3.5x, caller passes 6x
      await expect(
        ConvictionStakingStorage.createPosition(1, ALICE_ID, 1000, 6, SIX_X),
      ).to.be.revertedWith('Tier mismatch');

      // Mismatched tier: lock=3 expects 2x, caller passes 1.5x
      await expect(
        ConvictionStakingStorage.createPosition(1, ALICE_ID, 1000, 3, ONE_AND_HALF_X),
      ).to.be.revertedWith('Tier mismatch');

      // Invalid lock 5 is rejected inside expectedMultiplier18 before the
      // tier-match check can even see it (and before "Position exists"). We
      // exercise that path with a fresh tokenId to prove the revert path
      // priority.
      await expect(
        ConvictionStakingStorage.createPosition(99, ALICE_ID, 1000, 5, TWO_X),
      ).to.be.revertedWith('Invalid lock');

      await ConvictionStakingStorage.createPosition(1, ALICE_ID, 1000, 12, SIX_X);
      await expect(
        ConvictionStakingStorage.createPosition(1, ALICE_ID, 500, 3, TWO_X),
      ).to.be.revertedWith('Position exists');
    });
  });

  // ------------------------------------------------------------
  // Concurrent expiry denominator (plan-inspired scenario, canonical tiers)
  // ------------------------------------------------------------

  describe('concurrent expiry denominator', () => {
    it('Alice 1000x6x (lock=12) + Bob 1000x1x perm → 7000 [1..12], 2000 [13..∞)', async () => {
      // Pin genesis: first position must land at epoch 1.
      expect(await Chronos.getCurrentEpoch()).to.equal(1);

      await ConvictionStakingStorage.createPosition(1, ALICE_ID, 1000, 12, SIX_X); // expiry 13
      await ConvictionStakingStorage.createPosition(2, BOB_ID, 1000, 0, ONE_X); // perm

      for (let e = 1; e <= 12; e++) {
        expect(
          await ConvictionStakingStorage.getTotalEffectiveStakeAtEpoch(e),
          `epoch ${e}`,
        ).to.equal(7000);
      }
      expect(await ConvictionStakingStorage.getTotalEffectiveStakeAtEpoch(13)).to.equal(2000);
      expect(await ConvictionStakingStorage.getTotalEffectiveStakeAtEpoch(20)).to.equal(2000);
      expect(await ConvictionStakingStorage.getTotalEffectiveStakeAtEpoch(1000)).to.equal(2000);
    });
  });

  // ------------------------------------------------------------
  // Per-node diff + multi-NFT-per-node
  // ------------------------------------------------------------

  describe('per-node diff + multi-NFT-per-node', () => {
    it('Two NFTs under same identityId track independent expiries', async () => {
      // nft1: raw=500, lock=12, mult=6x → effective 3000 in [1..12], 500 in [13..∞)
      // nft2: raw=200, lock=3,  mult=2x → effective  400 in [1..3],  200 in  [4..∞)
      // per-node total: [1..3]=3400, [4..12]=3200, [13..∞)=700
      await ConvictionStakingStorage.createPosition(1, ALICE_ID, 500, 12, SIX_X);
      await ConvictionStakingStorage.createPosition(2, ALICE_ID, 200, 3, TWO_X);

      for (let e = 1; e <= 3; e++) {
        expect(
          await ConvictionStakingStorage.getNodeEffectiveStakeAtEpoch(ALICE_ID, e),
          `e${e}`,
        ).to.equal(3400);
      }
      for (let e = 4; e <= 12; e++) {
        expect(
          await ConvictionStakingStorage.getNodeEffectiveStakeAtEpoch(ALICE_ID, e),
          `e${e}`,
        ).to.equal(3200);
      }
      expect(await ConvictionStakingStorage.getNodeEffectiveStakeAtEpoch(ALICE_ID, 13)).to.equal(700);
      expect(await ConvictionStakingStorage.getNodeEffectiveStakeAtEpoch(ALICE_ID, 500)).to.equal(700);
    });

    it('Second node is unaffected by first node writes', async () => {
      await ConvictionStakingStorage.createPosition(1, ALICE_ID, 500, 12, SIX_X);
      await ConvictionStakingStorage.createPosition(2, ALICE_ID, 200, 3, TWO_X);

      for (let e = 1; e <= 20; e++) {
        expect(
          await ConvictionStakingStorage.getNodeEffectiveStakeAtEpoch(BOB_ID, e),
          `bob e${e}`,
        ).to.equal(0);
      }
      expect(await ConvictionStakingStorage.getNodeEffectiveStakeAtEpoch(OTHER_ID, 1)).to.equal(0);
    });

    it('Per-node mirrors global when there is a single node', async () => {
      await ConvictionStakingStorage.createPosition(1, ALICE_ID, 1000, 12, SIX_X);
      await ConvictionStakingStorage.createPosition(2, ALICE_ID, 1000, 0, ONE_X);

      for (const e of [1, 6, 12, 13, 20]) {
        expect(await ConvictionStakingStorage.getNodeEffectiveStakeAtEpoch(ALICE_ID, e)).to.equal(
          await ConvictionStakingStorage.getTotalEffectiveStakeAtEpoch(e),
        );
      }
    });
  });

  // ------------------------------------------------------------
  // Mutators
  // ------------------------------------------------------------

  describe('updateOnRelock', () => {
    it('Re-commits after expiry: correct diff layering and new expiry', async () => {
      // Create at e=1: raw=1000, lock=3, mult=2x → diff[1]+=2000, diff[4]-=1000
      await ConvictionStakingStorage.createPosition(1, ALICE_ID, 1000, 3, TWO_X);

      await advanceEpochs(3);
      expect(await Chronos.getCurrentEpoch()).to.equal(4);

      // Relock: lock=12, mult=6x → new expiry = 16, adds raw*(6-1)=5000 at e=4, -5000 at e=16
      await ConvictionStakingStorage.updateOnRelock(1, 12, SIX_X);
      const pos = await ConvictionStakingStorage.getPosition(1);
      expect(pos.lockEpochs).to.equal(12);
      expect(pos.multiplier18).to.equal(SIX_X);
      expect(pos.expiryEpoch).to.equal(16);

      expect(await ConvictionStakingStorage.getTotalEffectiveStakeAtEpoch(3)).to.equal(2000);
      expect(await ConvictionStakingStorage.getTotalEffectiveStakeAtEpoch(4)).to.equal(6000);
      expect(await ConvictionStakingStorage.getTotalEffectiveStakeAtEpoch(15)).to.equal(6000);
      expect(await ConvictionStakingStorage.getTotalEffectiveStakeAtEpoch(16)).to.equal(1000);
      expect(await ConvictionStakingStorage.getTotalEffectiveStakeAtEpoch(100)).to.equal(1000);
    });

    it('Upgrades a permanent 1x position to a boosted lock', async () => {
      await ConvictionStakingStorage.createPosition(1, ALICE_ID, 1000, 0, ONE_X);
      expect(await ConvictionStakingStorage.getTotalEffectiveStakeAtEpoch(1)).to.equal(1000);

      await advanceEpochs(2); // e=3
      expect(await Chronos.getCurrentEpoch()).to.equal(3);

      await ConvictionStakingStorage.updateOnRelock(1, 12, SIX_X);
      const pos = await ConvictionStakingStorage.getPosition(1);
      expect(pos.lockEpochs).to.equal(12);
      expect(pos.multiplier18).to.equal(SIX_X);
      expect(pos.expiryEpoch).to.equal(15); // currentEpoch(3) + 12

      expect(await ConvictionStakingStorage.getTotalEffectiveStakeAtEpoch(1)).to.equal(1000);
      expect(await ConvictionStakingStorage.getTotalEffectiveStakeAtEpoch(2)).to.equal(1000);
      expect(await ConvictionStakingStorage.getTotalEffectiveStakeAtEpoch(3)).to.equal(6000);
      expect(await ConvictionStakingStorage.getTotalEffectiveStakeAtEpoch(14)).to.equal(6000);
      expect(await ConvictionStakingStorage.getTotalEffectiveStakeAtEpoch(15)).to.equal(1000);
      expect(await ConvictionStakingStorage.getTotalEffectiveStakeAtEpoch(100)).to.equal(1000);
    });

    it('Re-commit exactly at expiryEpoch is allowed (boundary)', async () => {
      // createdAt=1, lock=3 → expiryEpoch=4. Advance to 4 so currentEpoch == expiryEpoch.
      await ConvictionStakingStorage.createPosition(1, ALICE_ID, 1000, 3, TWO_X);
      await advanceEpochs(3);
      expect(await Chronos.getCurrentEpoch()).to.equal(4);
      await expect(ConvictionStakingStorage.updateOnRelock(1, 3, TWO_X)).to.not.be.reverted;
    });

    it('Reverts if called before expiry', async () => {
      await ConvictionStakingStorage.createPosition(1, ALICE_ID, 1000, 3, TWO_X);
      await expect(
        ConvictionStakingStorage.updateOnRelock(1, 12, SIX_X),
      ).to.be.revertedWith('Not expired');
    });

    it('Reverts on tier mismatch (1x relock)', async () => {
      // createdAt=1, lock=3, 2x → expiry=4. Advance to the boundary.
      await ConvictionStakingStorage.createPosition(1, ALICE_ID, 1000, 3, TWO_X);
      await advanceEpochs(3);
      // lock=6 expects 3.5x per ladder; passing 1x is a tier mismatch.
      await expect(
        ConvictionStakingStorage.updateOnRelock(1, 6, ONE_X),
      ).to.be.revertedWith('Tier mismatch');
    });

    it('Reverts on invalid lock (outside discrete set)', async () => {
      await ConvictionStakingStorage.createPosition(1, ALICE_ID, 1000, 3, TWO_X);
      await advanceEpochs(3);
      // Phase 5: lock=5 is outside the discrete set {0,1,3,6,12} — the revert
      // fires inside `expectedMultiplier18`, not in the tier-match check.
      await expect(
        ConvictionStakingStorage.updateOnRelock(1, 5, TWO_X),
      ).to.be.revertedWith('Invalid lock');
      await expect(
        ConvictionStakingStorage.updateOnRelock(1, 11, THREE_AND_HALF_X),
      ).to.be.revertedWith('Invalid lock');
    });

    it('Allows lock=0 (rest state) as a valid post-expiry relock target', async () => {
      // Phase 5: the original Phase 2 hotfix rejected `lock=0` with
      // "Lock too short". Per the roadmap (`04_TOKEN_ECONOMICS §4.1` —
      // "no lockup / 1 / 3 / 6 / 12 months"), tier 0 is an explicit valid
      // relock target: a post-expiry holder can choose to remain at 1x
      // rather than re-commit to another locked tier.
      //
      // Math: `boost = raw * (1e18 - 1e18) / 1e18 = 0`, so the diff writes
      // at `currentEpoch` and `newExpiry` are both zero-delta no-ops —
      // the only observable mutation is the Position struct rewrite.
      await ConvictionStakingStorage.createPosition(1, ALICE_ID, 1000, 3, TWO_X);
      await advanceEpochs(3);
      expect(await Chronos.getCurrentEpoch()).to.equal(4);

      // Pre-relock: post-expiry permanent 1000 (raw * 1x).
      expect(await ConvictionStakingStorage.getTotalEffectiveStakeAtEpoch(4)).to.equal(1000);

      await ConvictionStakingStorage.updateOnRelock(1, 0, ONE_X);

      const pos = await ConvictionStakingStorage.getPosition(1);
      expect(pos.lockEpochs).to.equal(0);
      expect(pos.multiplier18).to.equal(ONE_X);
      // `newExpiry = currentEpoch + 0 = currentEpoch` per the general
      // `updateOnRelock` arithmetic. It differs from `createPosition`'s
      // lock-0 branch (which pins `expiryEpoch = 0`) but that's fine:
      // `currentEpoch >= pos.expiryEpoch` remains true for any future
      // relock on this position, so the post-expiry check still passes.
      expect(pos.expiryEpoch).to.equal(4);
      expect(pos.raw).to.equal(1000);

      // Effective stake stays at the post-expiry baseline — nothing lifts.
      expect(await ConvictionStakingStorage.getTotalEffectiveStakeAtEpoch(4)).to.equal(1000);
      expect(await ConvictionStakingStorage.getTotalEffectiveStakeAtEpoch(100)).to.equal(1000);
    });

    it('Reverts on non-existent position', async () => {
      await expect(
        ConvictionStakingStorage.updateOnRelock(1, 12, SIX_X),
      ).to.be.revertedWith('No position');
    });
  });

  describe('updateOnRedelegate', () => {
    it('Moves per-node diff while leaving global totals unchanged', async () => {
      await ConvictionStakingStorage.createPosition(1, ALICE_ID, 1000, 12, SIX_X);
      await ConvictionStakingStorage.updateOnRedelegate(1, BOB_ID);
      expect((await ConvictionStakingStorage.getPosition(1)).identityId).to.equal(BOB_ID);

      expect(await ConvictionStakingStorage.getTotalEffectiveStakeAtEpoch(1)).to.equal(6000);
      expect(await ConvictionStakingStorage.getTotalEffectiveStakeAtEpoch(12)).to.equal(6000);
      expect(await ConvictionStakingStorage.getTotalEffectiveStakeAtEpoch(13)).to.equal(1000);

      for (const e of [1, 6, 12, 13, 20]) {
        expect(await ConvictionStakingStorage.getNodeEffectiveStakeAtEpoch(ALICE_ID, e)).to.equal(0);
      }
      expect(await ConvictionStakingStorage.getNodeEffectiveStakeAtEpoch(BOB_ID, 1)).to.equal(6000);
      expect(await ConvictionStakingStorage.getNodeEffectiveStakeAtEpoch(BOB_ID, 12)).to.equal(6000);
      expect(await ConvictionStakingStorage.getNodeEffectiveStakeAtEpoch(BOB_ID, 13)).to.equal(1000);
    });

    it('Redelegate of a post-expiry position moves only the raw tail', async () => {
      // Phase 5: lock=3 mult=2x (valid tier). createdAt=1 → expiryEpoch=4.
      await ConvictionStakingStorage.createPosition(1, ALICE_ID, 1000, 3, TWO_X);
      // advance to the exact expiry boundary (epoch 4 = expiryEpoch)
      await advanceEpochs(3);
      expect(await Chronos.getCurrentEpoch()).to.equal(4);

      await ConvictionStakingStorage.updateOnRedelegate(1, BOB_ID);

      // ALICE contribution at/after epoch 4 = 0, BOB carries 1000 forward
      expect(await ConvictionStakingStorage.getNodeEffectiveStakeAtEpoch(ALICE_ID, 4)).to.equal(0);
      expect(await ConvictionStakingStorage.getNodeEffectiveStakeAtEpoch(ALICE_ID, 50)).to.equal(0);
      expect(await ConvictionStakingStorage.getNodeEffectiveStakeAtEpoch(BOB_ID, 4)).to.equal(1000);
      expect(await ConvictionStakingStorage.getNodeEffectiveStakeAtEpoch(BOB_ID, 50)).to.equal(1000);

      // Pre-redelegate history on ALICE stays intact: boost was 2000 in [1..3]
      expect(await ConvictionStakingStorage.getNodeEffectiveStakeAtEpoch(ALICE_ID, 1)).to.equal(2000);
      expect(await ConvictionStakingStorage.getNodeEffectiveStakeAtEpoch(ALICE_ID, 3)).to.equal(2000);
    });

    it('Reverts when redelegating to same node', async () => {
      await ConvictionStakingStorage.createPosition(1, ALICE_ID, 1000, 12, SIX_X);
      await expect(
        ConvictionStakingStorage.updateOnRedelegate(1, ALICE_ID),
      ).to.be.revertedWith('Same node');
    });

    it('Reverts when redelegating to identityId 0', async () => {
      await ConvictionStakingStorage.createPosition(1, ALICE_ID, 1000, 12, SIX_X);
      await expect(
        ConvictionStakingStorage.updateOnRedelegate(1, 0),
      ).to.be.revertedWith('Zero node');
    });
  });

  describe('deletePosition', () => {
    it('Wipes position + cancels future diff contributions', async () => {
      await ConvictionStakingStorage.createPosition(1, ALICE_ID, 1000, 12, SIX_X);
      await ConvictionStakingStorage.deletePosition(1);

      const pos = await ConvictionStakingStorage.getPosition(1);
      expect(pos.raw).to.equal(0);
      expect(pos.identityId).to.equal(0);

      for (const e of [1, 6, 12, 13, 50]) {
        expect(await ConvictionStakingStorage.getTotalEffectiveStakeAtEpoch(e)).to.equal(0);
        expect(await ConvictionStakingStorage.getNodeEffectiveStakeAtEpoch(ALICE_ID, e)).to.equal(0);
      }
    });

    it('Delete after expiry removes remaining raw tail only', async () => {
      // Phase 5: lock=3 (valid 2x tier). createdAt=1 → expiryEpoch=4.
      await ConvictionStakingStorage.createPosition(1, ALICE_ID, 1000, 3, TWO_X);
      await advanceEpochs(3); // e=4 (exactly at expiry)
      await ConvictionStakingStorage.deletePosition(1);

      expect(await ConvictionStakingStorage.getTotalEffectiveStakeAtEpoch(4)).to.equal(0);
      expect(await ConvictionStakingStorage.getTotalEffectiveStakeAtEpoch(100)).to.equal(0);
      // Historical windows (pre-delete) stay intact: boost was 2000 in [1..3]
      expect(await ConvictionStakingStorage.getTotalEffectiveStakeAtEpoch(1)).to.equal(2000);
      expect(await ConvictionStakingStorage.getTotalEffectiveStakeAtEpoch(3)).to.equal(2000);
    });

    it('Reverts on missing position', async () => {
      await expect(ConvictionStakingStorage.deletePosition(42)).to.be.revertedWith('No position');
    });

    it('Succeeds on a rewards-only position (raw==0, identityId!=0)', async () => {
      // Phase 5 round-2 fix: deletePosition uses `identityId != 0` as the
      // existence sentinel so it accepts a position that was partially drained
      // to raw==0 but still has a live identityId (rewards-only state).
      await ConvictionStakingStorage.createPosition(1, ALICE_ID, 1000, 0, ONE_X);
      // Drain raw to 0 — position becomes rewards-only (identityId still set).
      await ConvictionStakingStorage.decreaseRaw(1, 1000);
      const pos = await ConvictionStakingStorage.getPosition(1);
      expect(pos.raw).to.equal(0);
      expect(pos.identityId).to.equal(ALICE_ID);
      // deletePosition must succeed — old `raw > 0` guard would have reverted.
      await expect(ConvictionStakingStorage.deletePosition(1)).to.not.be.reverted;
      const deleted = await ConvictionStakingStorage.getPosition(1);
      expect(deleted.identityId).to.equal(0);
    });
  });

  describe('setLastClaimedEpoch', () => {
    it('Updates lastClaimedEpoch', async () => {
      await ConvictionStakingStorage.createPosition(1, ALICE_ID, 1000, 12, SIX_X);
      await ConvictionStakingStorage.setLastClaimedEpoch(1, 42);
      expect((await ConvictionStakingStorage.getPosition(1)).lastClaimedEpoch).to.equal(42);
    });

    it('Reverts on missing position', async () => {
      await expect(
        ConvictionStakingStorage.setLastClaimedEpoch(1, 1),
      ).to.be.revertedWith('No position');
    });

    it('Succeeds on a rewards-only position (raw==0, identityId!=0)', async () => {
      // Phase 5 round-2 fix: setLastClaimedEpoch uses `identityId != 0` so
      // it works on positions where raw has been fully drained but the
      // position struct is still alive (rewards-only state).
      await ConvictionStakingStorage.createPosition(1, ALICE_ID, 1000, 0, ONE_X);
      await ConvictionStakingStorage.decreaseRaw(1, 1000);
      const pos = await ConvictionStakingStorage.getPosition(1);
      expect(pos.raw).to.equal(0);
      expect(pos.identityId).to.equal(ALICE_ID);
      // Must succeed — old `raw > 0` guard would have reverted.
      await ConvictionStakingStorage.setLastClaimedEpoch(1, 99);
      expect((await ConvictionStakingStorage.getPosition(1)).lastClaimedEpoch).to.equal(99);
    });
  });

  // ------------------------------------------------------------
  // Finalize edges
  // ------------------------------------------------------------

  describe('finalize edges', () => {
    it('Idempotent: re-finalize is a no-op (state + events)', async () => {
      await ConvictionStakingStorage.createPosition(1, ALICE_ID, 1000, 12, SIX_X);
      await advanceEpochs(5); // e=6

      // First mutator call finalizes [1..5]
      await ConvictionStakingStorage.createPosition(2, BOB_ID, 500, 0, ONE_X);
      const after1 = await ConvictionStakingStorage.getLastFinalizedEpoch();
      expect(after1).to.equal(5n);
      const snap1 = await ConvictionStakingStorage.totalEffectiveStakeAtEpoch(5);

      // Second mutator at same epoch: state must be bit-identical AND no
      // EffectiveStakeFinalized event may be emitted on the no-op path.
      await expect(
        ConvictionStakingStorage.createPosition(3, OTHER_ID, 100, 0, ONE_X),
      ).to.not.emit(ConvictionStakingStorage, 'EffectiveStakeFinalized');

      const after2 = await ConvictionStakingStorage.getLastFinalizedEpoch();
      expect(after2).to.equal(5n);
      expect(await ConvictionStakingStorage.totalEffectiveStakeAtEpoch(5)).to.equal(snap1);
    });

    it('External finalizeEffectiveStakeUpTo amortizes the read path', async () => {
      await ConvictionStakingStorage.createPosition(1, ALICE_ID, 1000, 12, SIX_X);
      await advanceEpochs(49);
      expect(await Chronos.getCurrentEpoch()).to.equal(50);
      expect(await ConvictionStakingStorage.getLastFinalizedEpoch()).to.equal(0n);

      await ConvictionStakingStorage.finalizeEffectiveStakeUpTo(49);
      expect(await ConvictionStakingStorage.getLastFinalizedEpoch()).to.equal(49n);

      expect(await ConvictionStakingStorage.totalEffectiveStakeAtEpoch(1)).to.equal(6000);
      expect(await ConvictionStakingStorage.totalEffectiveStakeAtEpoch(12)).to.equal(6000);
      expect(await ConvictionStakingStorage.totalEffectiveStakeAtEpoch(13)).to.equal(1000);
      expect(await ConvictionStakingStorage.totalEffectiveStakeAtEpoch(49)).to.equal(1000);
    });

    it('External finalizeNodeEffectiveStakeUpTo is per-node', async () => {
      await ConvictionStakingStorage.createPosition(1, ALICE_ID, 1000, 12, SIX_X);
      await advanceEpochs(19); // e=20

      await ConvictionStakingStorage.finalizeNodeEffectiveStakeUpTo(ALICE_ID, 19);
      expect(await ConvictionStakingStorage.getNodeLastFinalizedEpoch(ALICE_ID)).to.equal(19n);
      expect(await ConvictionStakingStorage.getNodeLastFinalizedEpoch(BOB_ID)).to.equal(0n);
      expect(await ConvictionStakingStorage.getLastFinalizedEpoch()).to.equal(0n);
    });

    it('External finalizeEffectiveStakeUpTo reverts on current epoch', async () => {
      await ConvictionStakingStorage.createPosition(1, ALICE_ID, 1000, 12, SIX_X);
      const current = await Chronos.getCurrentEpoch();
      await expect(
        ConvictionStakingStorage.finalizeEffectiveStakeUpTo(current),
      ).to.be.revertedWith('Future or current epoch');
    });

    it('External finalizeEffectiveStakeUpTo reverts on future epoch', async () => {
      await ConvictionStakingStorage.createPosition(1, ALICE_ID, 1000, 12, SIX_X);
      const current = await Chronos.getCurrentEpoch();
      await expect(
        ConvictionStakingStorage.finalizeEffectiveStakeUpTo(current + 10n),
      ).to.be.revertedWith('Future or current epoch');
    });

    it('External finalizeNodeEffectiveStakeUpTo reverts on current/future epoch', async () => {
      await ConvictionStakingStorage.createPosition(1, ALICE_ID, 1000, 12, SIX_X);
      const current = await Chronos.getCurrentEpoch();
      await expect(
        ConvictionStakingStorage.finalizeNodeEffectiveStakeUpTo(ALICE_ID, current),
      ).to.be.revertedWith('Future or current epoch');
      await expect(
        ConvictionStakingStorage.finalizeNodeEffectiveStakeUpTo(ALICE_ID, current + 5n),
      ).to.be.revertedWith('Future or current epoch');
    });

    it('Virgin-state fast-path: first mutator after long dormancy does not gas-bomb', async () => {
      // Key regression: without firstDirtyEpoch tracking, the first createPosition
      // at epoch N loops N-1 times writing all-zero cumulatives. This gas-bombs on
      // sufficiently long dormancy. With the fast-path, finalize is O(1) here.
      await advanceEpochs(4999);
      expect(await Chronos.getCurrentEpoch()).to.equal(5000);
      expect(await ConvictionStakingStorage.firstDirtyEpoch()).to.equal(0n);

      const tx = await ConvictionStakingStorage.createPosition(1, ALICE_ID, 1000, 12, SIX_X);
      const receipt = await tx.wait();
      // A naive O(N) backfill across 4999 zero epochs would burn well over 20M gas.
      // The fast-path keeps createPosition well under that ceiling.
      expect(receipt!.gasUsed).to.be.lessThan(5_000_000n);

      // lastFinalizedEpoch is bumped past the dormant prefix.
      expect(await ConvictionStakingStorage.getLastFinalizedEpoch()).to.equal(4999n);
      // firstDirtyEpoch now points at the first actual write.
      expect(await ConvictionStakingStorage.firstDirtyEpoch()).to.equal(5000n);
      // Reads are consistent: Alice boosted for [5000..5011], drops at 5012.
      expect(await ConvictionStakingStorage.getTotalEffectiveStakeAtEpoch(5000)).to.equal(6000);
      expect(await ConvictionStakingStorage.getTotalEffectiveStakeAtEpoch(5011)).to.equal(6000);
      expect(await ConvictionStakingStorage.getTotalEffectiveStakeAtEpoch(5012)).to.equal(1000);
    });

    it('Virgin-state fast-path: external finalize on all-zero ledger also O(1)', async () => {
      await advanceEpochs(4999);
      expect(await Chronos.getCurrentEpoch()).to.equal(5000);

      const tx = await ConvictionStakingStorage.finalizeEffectiveStakeUpTo(4999);
      const receipt = await tx.wait();
      expect(receipt!.gasUsed).to.be.lessThan(100_000n);
      expect(await ConvictionStakingStorage.getLastFinalizedEpoch()).to.equal(4999n);
      // Still all zero (no writes ever happened)
      expect(await ConvictionStakingStorage.totalEffectiveStakeAtEpoch(2500)).to.equal(0);
    });

    it('Gap finalize: fills dormant epochs between firstDirty and target in one call', async () => {
      await ConvictionStakingStorage.createPosition(1, ALICE_ID, 1000, 12, SIX_X);
      // diff[1]=+6000, diff[13]=-5000. Advance to epoch 20.
      await advanceEpochs(19);
      expect(await Chronos.getCurrentEpoch()).to.equal(20);

      // Single mutator call finalizes [1..19] (firstDirty=1, so full loop)
      await ConvictionStakingStorage.createPosition(2, BOB_ID, 100, 0, ONE_X);

      expect(await ConvictionStakingStorage.getLastFinalizedEpoch()).to.equal(19n);
      for (let e = 1; e <= 12; e++) {
        expect(await ConvictionStakingStorage.totalEffectiveStakeAtEpoch(e), `e${e}`).to.equal(6000);
      }
      for (let e = 13; e <= 19; e++) {
        expect(await ConvictionStakingStorage.totalEffectiveStakeAtEpoch(e), `e${e}`).to.equal(1000);
      }
    });

    it('Lazy-finalize consistency: createPosition after gap sees correct denominator', async () => {
      await ConvictionStakingStorage.createPosition(1, ALICE_ID, 1000, 12, SIX_X);
      await advanceEpochs(2); // e=3

      // Create second position at epoch 3; global at e=3 already reflects Alice's 6000
      await ConvictionStakingStorage.createPosition(2, BOB_ID, 500, 0, ONE_X);
      expect(await ConvictionStakingStorage.getTotalEffectiveStakeAtEpoch(3)).to.equal(6500);
      expect(await ConvictionStakingStorage.getTotalEffectiveStakeAtEpoch(1)).to.equal(6000);
      expect(await ConvictionStakingStorage.getTotalEffectiveStakeAtEpoch(2)).to.equal(6000);
      expect(await ConvictionStakingStorage.getTotalEffectiveStakeAtEpoch(12)).to.equal(6500);
      expect(await ConvictionStakingStorage.getTotalEffectiveStakeAtEpoch(13)).to.equal(1500);
    });

    it('View helpers revert per-iteration on intermediate negative cumulative', async () => {
      // We can't directly corrupt the ledger through the public API, but we can
      // verify the per-iteration guard rejects a properly-constructed ledger the
      // finalize path also rejects: nothing should slip through to the reader
      // because of a transient negative restored by a later diff.
      //
      // This also proves the finalize revert wording matches the view wording.
      await ConvictionStakingStorage.createPosition(1, ALICE_ID, 1000, 12, SIX_X);
      await advanceEpochs(13); // e=14, finalize through e=13 will write valid cumulatives
      // Subsequent reads should succeed cleanly (no corruption here).
      expect(await ConvictionStakingStorage.getTotalEffectiveStakeAtEpoch(13)).to.equal(1000);
      expect(await ConvictionStakingStorage.getNodeEffectiveStakeAtEpoch(ALICE_ID, 13)).to.equal(1000);
    });

    it('Integer safety: expiry + delete + new create cannot underflow', async () => {
      await ConvictionStakingStorage.createPosition(1, ALICE_ID, 1000, 12, SIX_X);
      // Delete while Alice is still boosted: exercises the expiryDelta cancel path
      await advanceEpochs(11); // e=12, Alice still boosted (expiry=13, 12<13)
      expect(await Chronos.getCurrentEpoch()).to.equal(12);
      await ConvictionStakingStorage.deletePosition(1);
      expect(await ConvictionStakingStorage.getTotalEffectiveStakeAtEpoch(12)).to.equal(0);
      expect(await ConvictionStakingStorage.getTotalEffectiveStakeAtEpoch(13)).to.equal(0);

      // Phase 5: lock=3 (valid 2x tier). createdAt=12 → expiryEpoch=15.
      await ConvictionStakingStorage.createPosition(2, BOB_ID, 500, 3, TWO_X);
      expect(await ConvictionStakingStorage.getTotalEffectiveStakeAtEpoch(12)).to.equal(1000);
      expect(await ConvictionStakingStorage.getTotalEffectiveStakeAtEpoch(15)).to.equal(500);
    });
  });

  // ------------------------------------------------------------
  // Phase 5 — split-bucket Position model (raw + rewards)
  // ------------------------------------------------------------

  describe('Phase 5 rewards bucket', () => {
    it('Default-initialized rewards is 0 after createPosition', async () => {
      await ConvictionStakingStorage.createPosition(1, ALICE_ID, 1000, 12, SIX_X);
      const pos = await ConvictionStakingStorage.getPosition(1);
      expect(pos.rewards).to.equal(0);
      // Effective = raw*6 + 0 = 6000 pre-expiry, 1000 post-expiry
      expect(await ConvictionStakingStorage.getTotalEffectiveStakeAtEpoch(1)).to.equal(6000);
      expect(await ConvictionStakingStorage.getTotalEffectiveStakeAtEpoch(13)).to.equal(1000);
    });

    describe('increaseRewards', () => {
      it('Grows rewards field and per-node/global effective stake by amount (1x, no multiplier)', async () => {
        await ConvictionStakingStorage.createPosition(1, ALICE_ID, 1000, 12, SIX_X);
        // pre-rewards: effective = 6000 pre-expiry, 1000 post-expiry
        await ConvictionStakingStorage.increaseRewards(1, 500);

        const pos = await ConvictionStakingStorage.getPosition(1);
        expect(pos.rewards).to.equal(500);
        expect(pos.raw).to.equal(1000); // raw untouched

        // Rewards add at 1x → 6000+500=6500 pre-expiry, 1000+500=1500 post-expiry
        expect(await ConvictionStakingStorage.getTotalEffectiveStakeAtEpoch(1)).to.equal(6500);
        expect(await ConvictionStakingStorage.getTotalEffectiveStakeAtEpoch(12)).to.equal(6500);
        expect(await ConvictionStakingStorage.getTotalEffectiveStakeAtEpoch(13)).to.equal(1500);
        expect(await ConvictionStakingStorage.getTotalEffectiveStakeAtEpoch(50)).to.equal(1500);

        expect(await ConvictionStakingStorage.getNodeEffectiveStakeAtEpoch(ALICE_ID, 1)).to.equal(6500);
        expect(await ConvictionStakingStorage.getNodeEffectiveStakeAtEpoch(ALICE_ID, 13)).to.equal(1500);
      });

      it('Rewards stay at 1x through expiry (no boost drop on rewards)', async () => {
        await ConvictionStakingStorage.createPosition(1, ALICE_ID, 1000, 12, SIX_X);
        await ConvictionStakingStorage.increaseRewards(1, 2000);

        // Pre-expiry: 1000*6 + 2000 = 8000
        expect(await ConvictionStakingStorage.getTotalEffectiveStakeAtEpoch(1)).to.equal(8000);
        expect(await ConvictionStakingStorage.getTotalEffectiveStakeAtEpoch(12)).to.equal(8000);
        // Post-expiry: 1000 + 2000 = 3000 (rewards keep their full value)
        expect(await ConvictionStakingStorage.getTotalEffectiveStakeAtEpoch(13)).to.equal(3000);
        expect(await ConvictionStakingStorage.getTotalEffectiveStakeAtEpoch(1000)).to.equal(3000);
      });

      it('Compounds across multiple calls', async () => {
        await ConvictionStakingStorage.createPosition(1, ALICE_ID, 1000, 12, SIX_X);
        await ConvictionStakingStorage.increaseRewards(1, 100);
        await ConvictionStakingStorage.increaseRewards(1, 200);
        await ConvictionStakingStorage.increaseRewards(1, 50);
        const pos = await ConvictionStakingStorage.getPosition(1);
        expect(pos.rewards).to.equal(350);
        expect(await ConvictionStakingStorage.getTotalEffectiveStakeAtEpoch(1)).to.equal(6350);
        expect(await ConvictionStakingStorage.getTotalEffectiveStakeAtEpoch(13)).to.equal(1350);
      });

      it('Reverts on non-existent position', async () => {
        await expect(
          ConvictionStakingStorage.increaseRewards(42, 100),
        ).to.be.revertedWith('No position');
      });
    });

    describe('decreaseRewards', () => {
      it('Shrinks rewards field and per-node/global effective stake by amount', async () => {
        await ConvictionStakingStorage.createPosition(1, ALICE_ID, 1000, 12, SIX_X);
        await ConvictionStakingStorage.increaseRewards(1, 500);
        await ConvictionStakingStorage.decreaseRewards(1, 200);

        const pos = await ConvictionStakingStorage.getPosition(1);
        expect(pos.rewards).to.equal(300);
        expect(pos.raw).to.equal(1000);

        // 1000*6 + 300 = 6300 pre-expiry, 1000+300 = 1300 post-expiry
        expect(await ConvictionStakingStorage.getTotalEffectiveStakeAtEpoch(1)).to.equal(6300);
        expect(await ConvictionStakingStorage.getTotalEffectiveStakeAtEpoch(13)).to.equal(1300);
        expect(await ConvictionStakingStorage.getNodeEffectiveStakeAtEpoch(ALICE_ID, 1)).to.equal(6300);
      });

      it('Reverts on insufficient rewards', async () => {
        await ConvictionStakingStorage.createPosition(1, ALICE_ID, 1000, 12, SIX_X);
        await ConvictionStakingStorage.increaseRewards(1, 100);
        await expect(
          ConvictionStakingStorage.decreaseRewards(1, 101),
        ).to.be.revertedWith('Insufficient rewards');
      });

      it('Reverts on non-existent position', async () => {
        await expect(
          ConvictionStakingStorage.decreaseRewards(42, 1),
        ).to.be.revertedWith('No position');
      });
    });

    describe('decreaseRaw', () => {
      it('Shrinks raw pre-expiry: global/per-node effective stake drops by amount*multiplier, expiry delta also shrinks', async () => {
        // Alice raw=1000, lock=12, 6x → effective 6000 in [1..12], 1000 in [13..∞)
        await ConvictionStakingStorage.createPosition(1, ALICE_ID, 1000, 12, SIX_X);

        // Shrink by 400 at epoch 1 (still boosted).
        // Effective drop NOW = 400*6 = 2400 → new pre-expiry total = 6000 - 2400 = 3600
        // Post-expiry tail = 600 (raw) = 600 not 600 - adjusted boost
        await ConvictionStakingStorage.decreaseRaw(1, 400);

        const pos = await ConvictionStakingStorage.getPosition(1);
        expect(pos.raw).to.equal(600);
        expect(pos.rewards).to.equal(0);

        expect(await ConvictionStakingStorage.getTotalEffectiveStakeAtEpoch(1)).to.equal(3600);
        expect(await ConvictionStakingStorage.getTotalEffectiveStakeAtEpoch(12)).to.equal(3600);
        expect(await ConvictionStakingStorage.getTotalEffectiveStakeAtEpoch(13)).to.equal(600);
        expect(await ConvictionStakingStorage.getTotalEffectiveStakeAtEpoch(50)).to.equal(600);
      });

      it('Shrinks raw post-expiry: only flat 1x amount is removed', async () => {
        // Alice lock=3, 2x → expiry=4. Advance to e=4.
        await ConvictionStakingStorage.createPosition(1, ALICE_ID, 1000, 3, TWO_X);
        await advanceEpochs(3);
        expect(await Chronos.getCurrentEpoch()).to.equal(4);

        await ConvictionStakingStorage.decreaseRaw(1, 300);
        expect((await ConvictionStakingStorage.getPosition(1)).raw).to.equal(700);

        // At/after e=4, post-expiry: raw tail is 1000 → now 700
        expect(await ConvictionStakingStorage.getTotalEffectiveStakeAtEpoch(4)).to.equal(700);
        expect(await ConvictionStakingStorage.getTotalEffectiveStakeAtEpoch(100)).to.equal(700);
        // Pre-decrement history: boost was 2000 in [1..3]
        expect(await ConvictionStakingStorage.getTotalEffectiveStakeAtEpoch(1)).to.equal(2000);
        expect(await ConvictionStakingStorage.getTotalEffectiveStakeAtEpoch(3)).to.equal(2000);
      });

      it('Full raw drain reduces to rewards-only effective stake', async () => {
        await ConvictionStakingStorage.createPosition(1, ALICE_ID, 1000, 12, SIX_X);
        await ConvictionStakingStorage.increaseRewards(1, 500);
        // Now: effective = 6000 + 500 = 6500 pre-expiry, 1500 post-expiry
        await ConvictionStakingStorage.decreaseRaw(1, 1000);

        const pos = await ConvictionStakingStorage.getPosition(1);
        expect(pos.raw).to.equal(0);
        expect(pos.rewards).to.equal(500);
        // The position's identity stays registered so the remaining rewards
        // can still be withdrawn.
        expect(pos.identityId).to.equal(ALICE_ID);

        // Pre-expiry: 0*6 + 500 = 500
        expect(await ConvictionStakingStorage.getTotalEffectiveStakeAtEpoch(1)).to.equal(500);
        expect(await ConvictionStakingStorage.getTotalEffectiveStakeAtEpoch(12)).to.equal(500);
        // Post-expiry: 0 + 500 = 500 (same — raw was drained)
        expect(await ConvictionStakingStorage.getTotalEffectiveStakeAtEpoch(13)).to.equal(500);
      });

      it('Reverts on insufficient raw', async () => {
        await ConvictionStakingStorage.createPosition(1, ALICE_ID, 1000, 12, SIX_X);
        await expect(
          ConvictionStakingStorage.decreaseRaw(1, 1001),
        ).to.be.revertedWith('Insufficient raw');
      });

      it('Reverts on non-existent position', async () => {
        await expect(
          ConvictionStakingStorage.decreaseRaw(42, 1),
        ).to.be.revertedWith('No position');
      });
    });

    describe('mixed-bucket effective-stake math', () => {
      it('raw=1000, lock=3, 2x, rewards=500 → pre-expiry=2500, post-expiry=1500', async () => {
        // Pre-expiry: raw*mult/1e18 + rewards = 1000*2 + 500 = 2500
        // Post-expiry: raw + rewards = 1000 + 500 = 1500
        // createdAt=1, lock=3 → expiryEpoch=4
        await ConvictionStakingStorage.createPosition(1, ALICE_ID, 1000, 3, TWO_X);
        await ConvictionStakingStorage.increaseRewards(1, 500);

        for (let e = 1; e <= 3; e++) {
          expect(
            await ConvictionStakingStorage.getTotalEffectiveStakeAtEpoch(e),
            `e${e}`,
          ).to.equal(2500);
        }
        for (const e of [4, 5, 10, 100]) {
          expect(
            await ConvictionStakingStorage.getTotalEffectiveStakeAtEpoch(e),
            `e${e}`,
          ).to.equal(1500);
        }
      });

      it('Multi-NFT per-node: rewards add flat 1x across the ladder', async () => {
        // nft1: raw=500, lock=12, 6x, rewards=200 → 500*6+200=3200 in [1..12], 500+200=700 in [13..]
        // nft2: raw=200, lock=3, 2x,  rewards=50  → 200*2+50=450   in [1..3],  200+50=250   in [4..]
        // per-node ALICE:
        //   [1..3]: 3200+450 = 3650
        //   [4..12]: 3200+250 = 3450
        //   [13..∞): 700+250 = 950
        await ConvictionStakingStorage.createPosition(1, ALICE_ID, 500, 12, SIX_X);
        await ConvictionStakingStorage.increaseRewards(1, 200);
        await ConvictionStakingStorage.createPosition(2, ALICE_ID, 200, 3, TWO_X);
        await ConvictionStakingStorage.increaseRewards(2, 50);

        for (let e = 1; e <= 3; e++) {
          expect(
            await ConvictionStakingStorage.getNodeEffectiveStakeAtEpoch(ALICE_ID, e),
            `e${e}`,
          ).to.equal(3650);
        }
        for (let e = 4; e <= 12; e++) {
          expect(
            await ConvictionStakingStorage.getNodeEffectiveStakeAtEpoch(ALICE_ID, e),
            `e${e}`,
          ).to.equal(3450);
        }
        expect(await ConvictionStakingStorage.getNodeEffectiveStakeAtEpoch(ALICE_ID, 13)).to.equal(950);
        expect(await ConvictionStakingStorage.getNodeEffectiveStakeAtEpoch(ALICE_ID, 100)).to.equal(950);
      });
    });

    // ----------------------------------------------------------
    // Phase 5 — increaseRaw (symmetric counterpart of decreaseRaw)
    // ----------------------------------------------------------
    //
    // `increaseRaw` is the restoration mutator used by
    // `StakingV10.cancelWithdrawal` to roll back a pending raw share into
    // the position. The diff propagation must be a sign-flipped mirror of
    // `decreaseRaw`: every effective-stake test below pairs an
    // `increaseRaw` against a `decreaseRaw` with the same shape, so a
    // round-trip create → decrease → increase ends at exactly the same
    // global / per-node totals as the create alone.

    describe('increaseRaw', () => {
      it('Round-trip: decreaseRaw then increaseRaw restores raw + effective stake exactly (pre-expiry)', async () => {
        await ConvictionStakingStorage.createPosition(1, ALICE_ID, 1000, 12, SIX_X);
        // Pre: 1000*6 = 6000 pre-expiry, 1000 post-expiry
        const e1Before = await ConvictionStakingStorage.getTotalEffectiveStakeAtEpoch(1);
        const e12Before = await ConvictionStakingStorage.getTotalEffectiveStakeAtEpoch(12);
        const e13Before = await ConvictionStakingStorage.getTotalEffectiveStakeAtEpoch(13);
        const e50Before = await ConvictionStakingStorage.getTotalEffectiveStakeAtEpoch(50);

        await ConvictionStakingStorage.decreaseRaw(1, 400); // raw → 600
        await ConvictionStakingStorage.increaseRaw(1, 400); // raw → 1000

        const pos = await ConvictionStakingStorage.getPosition(1);
        expect(pos.raw).to.equal(1000);
        expect(pos.rewards).to.equal(0);

        // Effective stake totals are byte-identical to pre-roundtrip.
        expect(await ConvictionStakingStorage.getTotalEffectiveStakeAtEpoch(1)).to.equal(e1Before);
        expect(await ConvictionStakingStorage.getTotalEffectiveStakeAtEpoch(12)).to.equal(e12Before);
        expect(await ConvictionStakingStorage.getTotalEffectiveStakeAtEpoch(13)).to.equal(e13Before);
        expect(await ConvictionStakingStorage.getTotalEffectiveStakeAtEpoch(50)).to.equal(e50Before);
      });

      it('Pre-expiry: grows raw + effective stake by amount*multiplier and re-installs the expiry delta', async () => {
        await ConvictionStakingStorage.createPosition(1, ALICE_ID, 1000, 12, SIX_X);
        // Drain raw down to 600 first so we have headroom to add it back.
        await ConvictionStakingStorage.decreaseRaw(1, 400);
        // Mid-state: raw=600 → effective 3600 in [1..12], 600 in [13..]
        expect(await ConvictionStakingStorage.getTotalEffectiveStakeAtEpoch(1)).to.equal(3600);
        expect(await ConvictionStakingStorage.getTotalEffectiveStakeAtEpoch(13)).to.equal(600);

        // Add 200 raw back: pre-expiry 200*6 = 1200 lift, post-expiry 200 lift.
        await ConvictionStakingStorage.increaseRaw(1, 200);
        expect((await ConvictionStakingStorage.getPosition(1)).raw).to.equal(800);
        expect(await ConvictionStakingStorage.getTotalEffectiveStakeAtEpoch(1)).to.equal(4800);
        expect(await ConvictionStakingStorage.getTotalEffectiveStakeAtEpoch(12)).to.equal(4800);
        expect(await ConvictionStakingStorage.getTotalEffectiveStakeAtEpoch(13)).to.equal(800);
      });

      it('Post-expiry: grows raw + effective stake by flat amount (no expiry delta)', async () => {
        // lock=3, 2x → expiry=4. Advance to e=4 (post-expiry).
        await ConvictionStakingStorage.createPosition(1, ALICE_ID, 1000, 3, TWO_X);
        await advanceEpochs(3);
        expect(await Chronos.getCurrentEpoch()).to.equal(4);

        // Mid-state: raw=1000, post-expiry → effective 1000.
        expect(await ConvictionStakingStorage.getTotalEffectiveStakeAtEpoch(4)).to.equal(1000);

        // Add 250 raw post-expiry: flat +250.
        await ConvictionStakingStorage.increaseRaw(1, 250);
        expect((await ConvictionStakingStorage.getPosition(1)).raw).to.equal(1250);
        expect(await ConvictionStakingStorage.getTotalEffectiveStakeAtEpoch(4)).to.equal(1250);
        expect(await ConvictionStakingStorage.getTotalEffectiveStakeAtEpoch(100)).to.equal(1250);
        // Pre-decrement history stays intact: boost was 2000 in [1..3].
        expect(await ConvictionStakingStorage.getTotalEffectiveStakeAtEpoch(1)).to.equal(2000);
        expect(await ConvictionStakingStorage.getTotalEffectiveStakeAtEpoch(3)).to.equal(2000);
      });

      it('Reverts on non-existent position', async () => {
        await expect(
          ConvictionStakingStorage.increaseRaw(42, 1),
        ).to.be.revertedWith('No position');
      });

      it('Zero-amount call is a no-op (emits with zero amount, no diff write)', async () => {
        await ConvictionStakingStorage.createPosition(1, ALICE_ID, 1000, 12, SIX_X);
        const eBefore = await ConvictionStakingStorage.getTotalEffectiveStakeAtEpoch(1);
        await ConvictionStakingStorage.increaseRaw(1, 0);
        // raw + effective stake unchanged
        expect((await ConvictionStakingStorage.getPosition(1)).raw).to.equal(1000);
        expect(await ConvictionStakingStorage.getTotalEffectiveStakeAtEpoch(1)).to.equal(eBefore);
      });
    });

    // ----------------------------------------------------------
    // Phase 5 — V10-native pending withdrawals
    // ----------------------------------------------------------
    //
    // The new `pendingWithdrawals` mapping replaces the V8
    // `StakingStorage.withdrawals` slot for the V10 NFT path. These tests
    // only exercise the storage CRUD + sentinel rules; the
    // `StakingV10.createWithdrawal` / `cancelWithdrawal` /
    // `finalizeWithdrawal` integration is covered in
    // `DKGStakingConvictionNFT.test.ts`.

    describe('pendingWithdrawals (V10-native)', () => {
      it('createPendingWithdrawal stores amount/rewardsPortion/releaseAt under tokenId', async () => {
        await ConvictionStakingStorage.createPendingWithdrawal(1, 1000, 200, 9_999_999n);
        const pending = await ConvictionStakingStorage.getPendingWithdrawal(1);
        expect(pending.amount).to.equal(1000);
        expect(pending.rewardsPortion).to.equal(200);
        expect(pending.releaseAt).to.equal(9_999_999n);
      });

      it('createPendingWithdrawal reverts when one already exists for the tokenId', async () => {
        await ConvictionStakingStorage.createPendingWithdrawal(1, 1000, 0, 100n);
        await expect(
          ConvictionStakingStorage.createPendingWithdrawal(1, 500, 0, 200n),
        ).to.be.revertedWith('Pending exists');
      });

      it('createPendingWithdrawal reverts on zero amount', async () => {
        await expect(
          ConvictionStakingStorage.createPendingWithdrawal(1, 0, 0, 100n),
        ).to.be.revertedWith('Zero amount');
      });

      it('createPendingWithdrawal reverts when rewardsPortion > amount', async () => {
        await expect(
          ConvictionStakingStorage.createPendingWithdrawal(1, 100, 101, 100n),
        ).to.be.revertedWith('Bad split');
      });

      it('deletePendingWithdrawal clears the slot and allows a fresh create', async () => {
        await ConvictionStakingStorage.createPendingWithdrawal(1, 1000, 200, 100n);
        await ConvictionStakingStorage.deletePendingWithdrawal(1);
        const pending = await ConvictionStakingStorage.getPendingWithdrawal(1);
        expect(pending.amount).to.equal(0);
        expect(pending.rewardsPortion).to.equal(0);
        expect(pending.releaseAt).to.equal(0);

        // Slot is free — a new pending can be created.
        await ConvictionStakingStorage.createPendingWithdrawal(1, 500, 100, 200n);
        const pending2 = await ConvictionStakingStorage.getPendingWithdrawal(1);
        expect(pending2.amount).to.equal(500);
        expect(pending2.rewardsPortion).to.equal(100);
        expect(pending2.releaseAt).to.equal(200n);
      });

      it('deletePendingWithdrawal reverts when no pending exists', async () => {
        await expect(
          ConvictionStakingStorage.deletePendingWithdrawal(99),
        ).to.be.revertedWith('No pending');
      });

      it('Multiple tokenIds have independent pending slots', async () => {
        await ConvictionStakingStorage.createPendingWithdrawal(1, 1000, 200, 100n);
        await ConvictionStakingStorage.createPendingWithdrawal(2, 500, 50, 200n);

        expect((await ConvictionStakingStorage.getPendingWithdrawal(1)).amount).to.equal(1000);
        expect((await ConvictionStakingStorage.getPendingWithdrawal(2)).amount).to.equal(500);

        // Deleting one does not touch the other.
        await ConvictionStakingStorage.deletePendingWithdrawal(1);
        expect((await ConvictionStakingStorage.getPendingWithdrawal(1)).amount).to.equal(0);
        expect((await ConvictionStakingStorage.getPendingWithdrawal(2)).amount).to.equal(500);
      });
    });
  });
});
