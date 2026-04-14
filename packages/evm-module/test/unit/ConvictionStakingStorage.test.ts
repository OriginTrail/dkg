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

// Multiplier scale: matches Staking.convictionMultiplier and
// DKGStakingConvictionNFT._convictionMultiplier (both 1e18-scaled), so
// fractional tiers like 1.5x (1.5e18) and 3.5x (3.5e18) are representable.
const SCALE18 = 10n ** 18n;
const ONE_X = SCALE18;
const ONE_AND_HALF_X = (15n * SCALE18) / 10n;
const TWO_X = 2n * SCALE18;
const THREE_X = 3n * SCALE18;
const THREE_AND_HALF_X = (35n * SCALE18) / 10n;
const FOUR_X = 4n * SCALE18;
const SIX_X = 6n * SCALE18;

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
    expect(await ConvictionStakingStorage.version()).to.equal('1.0.0');
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
      // createdAt=1, lock=11, mult=6x → expiry=12, effective 6000 in [1,11], 1000 after
      await ConvictionStakingStorage.createPosition(1, ALICE_ID, 1000, 11, SIX_X);
      const pos = await ConvictionStakingStorage.getPosition(1);
      expect(pos.expiryEpoch).to.equal(12);
      expect(pos.multiplier18).to.equal(SIX_X);

      expect(await ConvictionStakingStorage.getTotalEffectiveStakeAtEpoch(1)).to.equal(6000);
      expect(await ConvictionStakingStorage.getTotalEffectiveStakeAtEpoch(11)).to.equal(6000);
      expect(await ConvictionStakingStorage.getTotalEffectiveStakeAtEpoch(12)).to.equal(1000);
      expect(await ConvictionStakingStorage.getTotalEffectiveStakeAtEpoch(50)).to.equal(1000);
    });

    it('Fractional tier 1.5x: raw 2000 → effective 3000 during lock, 2000 after', async () => {
      // Mirrors Staking.convictionMultiplier(2) = 1.5e18. raw*mult/1e18 = 2000*1.5e18/1e18 = 3000.
      await ConvictionStakingStorage.createPosition(1, ALICE_ID, 2000, 5, ONE_AND_HALF_X);
      expect((await ConvictionStakingStorage.getPosition(1)).multiplier18).to.equal(ONE_AND_HALF_X);

      expect(await ConvictionStakingStorage.getTotalEffectiveStakeAtEpoch(1)).to.equal(3000);
      expect(await ConvictionStakingStorage.getTotalEffectiveStakeAtEpoch(5)).to.equal(3000);
      expect(await ConvictionStakingStorage.getTotalEffectiveStakeAtEpoch(6)).to.equal(2000);
      expect(await ConvictionStakingStorage.getTotalEffectiveStakeAtEpoch(100)).to.equal(2000);
    });

    it('Fractional tier 3.5x: raw 2000 → effective 7000 during lock, 2000 after', async () => {
      // Mirrors Staking.convictionMultiplier(6) = 3.5e18.
      await ConvictionStakingStorage.createPosition(1, ALICE_ID, 2000, 11, THREE_AND_HALF_X);
      expect((await ConvictionStakingStorage.getPosition(1)).multiplier18).to.equal(THREE_AND_HALF_X);

      expect(await ConvictionStakingStorage.getTotalEffectiveStakeAtEpoch(1)).to.equal(7000);
      expect(await ConvictionStakingStorage.getTotalEffectiveStakeAtEpoch(11)).to.equal(7000);
      expect(await ConvictionStakingStorage.getTotalEffectiveStakeAtEpoch(12)).to.equal(2000);
    });

    it('Reverts on invalid inputs', async () => {
      await expect(
        ConvictionStakingStorage.createPosition(1, 0, 1000, 11, SIX_X),
      ).to.be.revertedWith('Zero node');

      await expect(
        ConvictionStakingStorage.createPosition(1, ALICE_ID, 0, 11, SIX_X),
      ).to.be.revertedWith('Zero raw');

      await expect(
        ConvictionStakingStorage.createPosition(1, ALICE_ID, 1000, 11, 0),
      ).to.be.revertedWith('Bad multiplier');

      // Sub-1x multiplier is nonsense (effective stake below principal)
      await expect(
        ConvictionStakingStorage.createPosition(1, ALICE_ID, 1000, 11, SCALE18 / 2n),
      ).to.be.revertedWith('Bad multiplier');

      await expect(
        ConvictionStakingStorage.createPosition(1, ALICE_ID, 1000, 0, SIX_X),
      ).to.be.revertedWith('Lock0 must be 1x');

      await ConvictionStakingStorage.createPosition(1, ALICE_ID, 1000, 11, SIX_X);
      await expect(
        ConvictionStakingStorage.createPosition(1, ALICE_ID, 500, 5, TWO_X),
      ).to.be.revertedWith('Position exists');
    });
  });

  // ------------------------------------------------------------
  // Concurrent expiry denominator — plan literal
  // ------------------------------------------------------------

  describe('concurrent expiry denominator', () => {
    it('Alice 1000x6x expiring e12 + Bob 1000x1x perm → 7000 [1..11], 2000 [12..∞)', async () => {
      // Pin genesis: the plan literal relies on the first position landing at epoch 1.
      expect(await Chronos.getCurrentEpoch()).to.equal(1);

      await ConvictionStakingStorage.createPosition(1, ALICE_ID, 1000, 11, SIX_X); // expiry 12
      await ConvictionStakingStorage.createPosition(2, BOB_ID, 1000, 0, ONE_X); // perm

      for (let e = 1; e <= 11; e++) {
        expect(
          await ConvictionStakingStorage.getTotalEffectiveStakeAtEpoch(e),
          `epoch ${e}`,
        ).to.equal(7000);
      }
      expect(await ConvictionStakingStorage.getTotalEffectiveStakeAtEpoch(12)).to.equal(2000);
      expect(await ConvictionStakingStorage.getTotalEffectiveStakeAtEpoch(20)).to.equal(2000);
      expect(await ConvictionStakingStorage.getTotalEffectiveStakeAtEpoch(1000)).to.equal(2000);
    });
  });

  // ------------------------------------------------------------
  // Per-node diff + multi-NFT-per-node
  // ------------------------------------------------------------

  describe('per-node diff + multi-NFT-per-node', () => {
    it('Two NFTs under same identityId track independent expiries', async () => {
      // nft1: raw=500, lock=11, mult=6x → 3000 in [1..11], 500 in [12..∞)
      // nft2: raw=200, lock=5,  mult=3x → 600  in [1..5],  200 in  [6..∞)
      // per-node total: [1..5]=3600, [6..11]=3200, [12..∞)=700
      await ConvictionStakingStorage.createPosition(1, ALICE_ID, 500, 11, SIX_X);
      await ConvictionStakingStorage.createPosition(2, ALICE_ID, 200, 5, THREE_X);

      for (let e = 1; e <= 5; e++) {
        expect(
          await ConvictionStakingStorage.getNodeEffectiveStakeAtEpoch(ALICE_ID, e),
          `e${e}`,
        ).to.equal(3600);
      }
      for (let e = 6; e <= 11; e++) {
        expect(
          await ConvictionStakingStorage.getNodeEffectiveStakeAtEpoch(ALICE_ID, e),
          `e${e}`,
        ).to.equal(3200);
      }
      expect(await ConvictionStakingStorage.getNodeEffectiveStakeAtEpoch(ALICE_ID, 12)).to.equal(700);
      expect(await ConvictionStakingStorage.getNodeEffectiveStakeAtEpoch(ALICE_ID, 500)).to.equal(700);
    });

    it('Second node is unaffected by first node writes', async () => {
      await ConvictionStakingStorage.createPosition(1, ALICE_ID, 500, 11, SIX_X);
      await ConvictionStakingStorage.createPosition(2, ALICE_ID, 200, 5, THREE_X);

      for (let e = 1; e <= 20; e++) {
        expect(
          await ConvictionStakingStorage.getNodeEffectiveStakeAtEpoch(BOB_ID, e),
          `bob e${e}`,
        ).to.equal(0);
      }
      expect(await ConvictionStakingStorage.getNodeEffectiveStakeAtEpoch(OTHER_ID, 1)).to.equal(0);
    });

    it('Per-node mirrors global when there is a single node', async () => {
      await ConvictionStakingStorage.createPosition(1, ALICE_ID, 1000, 11, SIX_X);
      await ConvictionStakingStorage.createPosition(2, ALICE_ID, 1000, 0, ONE_X);

      for (const e of [1, 5, 11, 12, 20]) {
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
      // Create at e=1: raw=1000, lock=5, mult=2x → diff[1]+=2000, diff[6]-=1000
      await ConvictionStakingStorage.createPosition(1, ALICE_ID, 1000, 5, TWO_X);

      await advanceEpochs(5);
      expect(await Chronos.getCurrentEpoch()).to.equal(6);

      // Relock: lock=10, mult=3x → new expiry = 16, adds raw*(3-1)=2000 at e=6, -2000 at e=16
      await ConvictionStakingStorage.updateOnRelock(1, 10, THREE_X);
      const pos = await ConvictionStakingStorage.getPosition(1);
      expect(pos.lockEpochs).to.equal(10);
      expect(pos.multiplier18).to.equal(THREE_X);
      expect(pos.expiryEpoch).to.equal(16);

      expect(await ConvictionStakingStorage.getTotalEffectiveStakeAtEpoch(5)).to.equal(2000);
      expect(await ConvictionStakingStorage.getTotalEffectiveStakeAtEpoch(6)).to.equal(3000);
      expect(await ConvictionStakingStorage.getTotalEffectiveStakeAtEpoch(15)).to.equal(3000);
      expect(await ConvictionStakingStorage.getTotalEffectiveStakeAtEpoch(16)).to.equal(1000);
      expect(await ConvictionStakingStorage.getTotalEffectiveStakeAtEpoch(100)).to.equal(1000);
    });

    it('Upgrades a permanent 1x position to a boosted lock', async () => {
      await ConvictionStakingStorage.createPosition(1, ALICE_ID, 1000, 0, ONE_X);
      expect(await ConvictionStakingStorage.getTotalEffectiveStakeAtEpoch(1)).to.equal(1000);

      await advanceEpochs(2); // e=3
      expect(await Chronos.getCurrentEpoch()).to.equal(3);

      await ConvictionStakingStorage.updateOnRelock(1, 10, FOUR_X);
      const pos = await ConvictionStakingStorage.getPosition(1);
      expect(pos.lockEpochs).to.equal(10);
      expect(pos.multiplier18).to.equal(FOUR_X);
      expect(pos.expiryEpoch).to.equal(13);

      expect(await ConvictionStakingStorage.getTotalEffectiveStakeAtEpoch(1)).to.equal(1000);
      expect(await ConvictionStakingStorage.getTotalEffectiveStakeAtEpoch(2)).to.equal(1000);
      expect(await ConvictionStakingStorage.getTotalEffectiveStakeAtEpoch(3)).to.equal(4000);
      expect(await ConvictionStakingStorage.getTotalEffectiveStakeAtEpoch(12)).to.equal(4000);
      expect(await ConvictionStakingStorage.getTotalEffectiveStakeAtEpoch(13)).to.equal(1000);
      expect(await ConvictionStakingStorage.getTotalEffectiveStakeAtEpoch(100)).to.equal(1000);
    });

    it('Re-commit exactly at expiryEpoch is allowed (boundary)', async () => {
      await ConvictionStakingStorage.createPosition(1, ALICE_ID, 1000, 5, TWO_X);
      await advanceEpochs(5);
      expect(await Chronos.getCurrentEpoch()).to.equal(6);
      await expect(ConvictionStakingStorage.updateOnRelock(1, 4, THREE_X)).to.not.be.reverted;
    });

    it('Reverts if called before expiry', async () => {
      await ConvictionStakingStorage.createPosition(1, ALICE_ID, 1000, 5, TWO_X);
      await expect(
        ConvictionStakingStorage.updateOnRelock(1, 10, THREE_X),
      ).to.be.revertedWith('Not expired');
    });

    it('Reverts on 1x relock (degenerate rest state)', async () => {
      await ConvictionStakingStorage.createPosition(1, ALICE_ID, 1000, 5, TWO_X);
      await advanceEpochs(5);
      // multiplier18 == SCALE18 is the rest state; must be strictly greater
      await expect(
        ConvictionStakingStorage.updateOnRelock(1, 10, ONE_X),
      ).to.be.revertedWith('Bad multiplier');
    });

    it('Reverts on non-existent position', async () => {
      await expect(
        ConvictionStakingStorage.updateOnRelock(1, 10, THREE_X),
      ).to.be.revertedWith('No position');
    });
  });

  describe('updateOnRedelegate', () => {
    it('Moves per-node diff while leaving global totals unchanged', async () => {
      await ConvictionStakingStorage.createPosition(1, ALICE_ID, 1000, 11, SIX_X);
      await ConvictionStakingStorage.updateOnRedelegate(1, BOB_ID);
      expect((await ConvictionStakingStorage.getPosition(1)).identityId).to.equal(BOB_ID);

      expect(await ConvictionStakingStorage.getTotalEffectiveStakeAtEpoch(1)).to.equal(6000);
      expect(await ConvictionStakingStorage.getTotalEffectiveStakeAtEpoch(11)).to.equal(6000);
      expect(await ConvictionStakingStorage.getTotalEffectiveStakeAtEpoch(12)).to.equal(1000);

      for (const e of [1, 5, 11, 12, 20]) {
        expect(await ConvictionStakingStorage.getNodeEffectiveStakeAtEpoch(ALICE_ID, e)).to.equal(0);
      }
      expect(await ConvictionStakingStorage.getNodeEffectiveStakeAtEpoch(BOB_ID, 1)).to.equal(6000);
      expect(await ConvictionStakingStorage.getNodeEffectiveStakeAtEpoch(BOB_ID, 11)).to.equal(6000);
      expect(await ConvictionStakingStorage.getNodeEffectiveStakeAtEpoch(BOB_ID, 12)).to.equal(1000);
    });

    it('Redelegate of a post-expiry position moves only the raw tail', async () => {
      await ConvictionStakingStorage.createPosition(1, ALICE_ID, 1000, 4, TWO_X);
      await advanceEpochs(4);
      expect(await Chronos.getCurrentEpoch()).to.equal(5);

      await ConvictionStakingStorage.updateOnRedelegate(1, BOB_ID);

      expect(await ConvictionStakingStorage.getNodeEffectiveStakeAtEpoch(ALICE_ID, 5)).to.equal(0);
      expect(await ConvictionStakingStorage.getNodeEffectiveStakeAtEpoch(ALICE_ID, 50)).to.equal(0);
      expect(await ConvictionStakingStorage.getNodeEffectiveStakeAtEpoch(BOB_ID, 5)).to.equal(1000);
      expect(await ConvictionStakingStorage.getNodeEffectiveStakeAtEpoch(BOB_ID, 50)).to.equal(1000);

      // Pre-redelegate history on ALICE stays intact: boost was 2000 in [1..4]
      expect(await ConvictionStakingStorage.getNodeEffectiveStakeAtEpoch(ALICE_ID, 1)).to.equal(2000);
      expect(await ConvictionStakingStorage.getNodeEffectiveStakeAtEpoch(ALICE_ID, 4)).to.equal(2000);
    });

    it('Reverts when redelegating to same node', async () => {
      await ConvictionStakingStorage.createPosition(1, ALICE_ID, 1000, 11, SIX_X);
      await expect(
        ConvictionStakingStorage.updateOnRedelegate(1, ALICE_ID),
      ).to.be.revertedWith('Same node');
    });

    it('Reverts when redelegating to identityId 0', async () => {
      await ConvictionStakingStorage.createPosition(1, ALICE_ID, 1000, 11, SIX_X);
      await expect(
        ConvictionStakingStorage.updateOnRedelegate(1, 0),
      ).to.be.revertedWith('Zero node');
    });
  });

  describe('deletePosition', () => {
    it('Wipes position + cancels future diff contributions', async () => {
      await ConvictionStakingStorage.createPosition(1, ALICE_ID, 1000, 11, SIX_X);
      await ConvictionStakingStorage.deletePosition(1);

      const pos = await ConvictionStakingStorage.getPosition(1);
      expect(pos.raw).to.equal(0);
      expect(pos.identityId).to.equal(0);

      for (const e of [1, 5, 11, 12, 50]) {
        expect(await ConvictionStakingStorage.getTotalEffectiveStakeAtEpoch(e)).to.equal(0);
        expect(await ConvictionStakingStorage.getNodeEffectiveStakeAtEpoch(ALICE_ID, e)).to.equal(0);
      }
    });

    it('Delete after expiry removes remaining raw tail only', async () => {
      await ConvictionStakingStorage.createPosition(1, ALICE_ID, 1000, 4, TWO_X);
      await advanceEpochs(4); // e=5
      await ConvictionStakingStorage.deletePosition(1);

      expect(await ConvictionStakingStorage.getTotalEffectiveStakeAtEpoch(5)).to.equal(0);
      expect(await ConvictionStakingStorage.getTotalEffectiveStakeAtEpoch(100)).to.equal(0);
      expect(await ConvictionStakingStorage.getTotalEffectiveStakeAtEpoch(1)).to.equal(2000);
      expect(await ConvictionStakingStorage.getTotalEffectiveStakeAtEpoch(4)).to.equal(2000);
    });

    it('Reverts on missing position', async () => {
      await expect(ConvictionStakingStorage.deletePosition(42)).to.be.revertedWith('No position');
    });
  });

  describe('setLastClaimedEpoch', () => {
    it('Updates lastClaimedEpoch', async () => {
      await ConvictionStakingStorage.createPosition(1, ALICE_ID, 1000, 11, SIX_X);
      await ConvictionStakingStorage.setLastClaimedEpoch(1, 42);
      expect((await ConvictionStakingStorage.getPosition(1)).lastClaimedEpoch).to.equal(42);
    });

    it('Reverts on missing position', async () => {
      await expect(
        ConvictionStakingStorage.setLastClaimedEpoch(1, 1),
      ).to.be.revertedWith('No position');
    });
  });

  // ------------------------------------------------------------
  // Finalize edges
  // ------------------------------------------------------------

  describe('finalize edges', () => {
    it('Idempotent: re-finalize is a no-op (state + events)', async () => {
      await ConvictionStakingStorage.createPosition(1, ALICE_ID, 1000, 11, SIX_X);
      await advanceEpochs(5); // e=6

      await ConvictionStakingStorage.createPosition(2, BOB_ID, 500, 0, ONE_X);
      const after1 = await ConvictionStakingStorage.getLastFinalizedEpoch();
      expect(after1).to.equal(5n);
      const snap1 = await ConvictionStakingStorage.totalEffectiveStakeAtEpoch(5);

      await expect(
        ConvictionStakingStorage.createPosition(3, OTHER_ID, 100, 0, ONE_X),
      ).to.not.emit(ConvictionStakingStorage, 'EffectiveStakeFinalized');

      const after2 = await ConvictionStakingStorage.getLastFinalizedEpoch();
      expect(after2).to.equal(5n);
      expect(await ConvictionStakingStorage.totalEffectiveStakeAtEpoch(5)).to.equal(snap1);
    });

    it('External finalizeEffectiveStakeUpTo amortizes the read path', async () => {
      await ConvictionStakingStorage.createPosition(1, ALICE_ID, 1000, 11, SIX_X);
      await advanceEpochs(49);
      expect(await Chronos.getCurrentEpoch()).to.equal(50);
      expect(await ConvictionStakingStorage.getLastFinalizedEpoch()).to.equal(0n);

      await ConvictionStakingStorage.finalizeEffectiveStakeUpTo(49);
      expect(await ConvictionStakingStorage.getLastFinalizedEpoch()).to.equal(49n);

      expect(await ConvictionStakingStorage.totalEffectiveStakeAtEpoch(1)).to.equal(6000);
      expect(await ConvictionStakingStorage.totalEffectiveStakeAtEpoch(11)).to.equal(6000);
      expect(await ConvictionStakingStorage.totalEffectiveStakeAtEpoch(12)).to.equal(1000);
      expect(await ConvictionStakingStorage.totalEffectiveStakeAtEpoch(49)).to.equal(1000);
    });

    it('External finalizeNodeEffectiveStakeUpTo is per-node', async () => {
      await ConvictionStakingStorage.createPosition(1, ALICE_ID, 1000, 11, SIX_X);
      await advanceEpochs(19); // e=20

      await ConvictionStakingStorage.finalizeNodeEffectiveStakeUpTo(ALICE_ID, 19);
      expect(await ConvictionStakingStorage.getNodeLastFinalizedEpoch(ALICE_ID)).to.equal(19n);
      expect(await ConvictionStakingStorage.getNodeLastFinalizedEpoch(BOB_ID)).to.equal(0n);
      expect(await ConvictionStakingStorage.getLastFinalizedEpoch()).to.equal(0n);
    });

    it('External finalizeEffectiveStakeUpTo reverts on current epoch', async () => {
      await ConvictionStakingStorage.createPosition(1, ALICE_ID, 1000, 11, SIX_X);
      const current = await Chronos.getCurrentEpoch();
      await expect(
        ConvictionStakingStorage.finalizeEffectiveStakeUpTo(current),
      ).to.be.revertedWith('Future or current epoch');
    });

    it('External finalizeEffectiveStakeUpTo reverts on future epoch', async () => {
      await ConvictionStakingStorage.createPosition(1, ALICE_ID, 1000, 11, SIX_X);
      const current = await Chronos.getCurrentEpoch();
      await expect(
        ConvictionStakingStorage.finalizeEffectiveStakeUpTo(current + 10n),
      ).to.be.revertedWith('Future or current epoch');
    });

    it('External finalizeNodeEffectiveStakeUpTo reverts on current/future epoch', async () => {
      await ConvictionStakingStorage.createPosition(1, ALICE_ID, 1000, 11, SIX_X);
      const current = await Chronos.getCurrentEpoch();
      await expect(
        ConvictionStakingStorage.finalizeNodeEffectiveStakeUpTo(ALICE_ID, current),
      ).to.be.revertedWith('Future or current epoch');
      await expect(
        ConvictionStakingStorage.finalizeNodeEffectiveStakeUpTo(ALICE_ID, current + 5n),
      ).to.be.revertedWith('Future or current epoch');
    });

    it('Gap finalize: fills N dormant epochs in one call', async () => {
      await ConvictionStakingStorage.createPosition(1, ALICE_ID, 1000, 11, SIX_X);
      await advanceEpochs(19);
      expect(await Chronos.getCurrentEpoch()).to.equal(20);

      await ConvictionStakingStorage.createPosition(2, BOB_ID, 100, 0, ONE_X);

      expect(await ConvictionStakingStorage.getLastFinalizedEpoch()).to.equal(19n);
      for (let e = 1; e <= 11; e++) {
        expect(await ConvictionStakingStorage.totalEffectiveStakeAtEpoch(e), `e${e}`).to.equal(6000);
      }
      for (let e = 12; e <= 19; e++) {
        expect(await ConvictionStakingStorage.totalEffectiveStakeAtEpoch(e), `e${e}`).to.equal(1000);
      }
    });

    it('Lazy-finalize consistency: createPosition after gap sees correct denominator', async () => {
      await ConvictionStakingStorage.createPosition(1, ALICE_ID, 1000, 11, SIX_X);
      await advanceEpochs(2);

      await ConvictionStakingStorage.createPosition(2, BOB_ID, 500, 0, ONE_X);
      expect(await ConvictionStakingStorage.getTotalEffectiveStakeAtEpoch(3)).to.equal(6500);
      expect(await ConvictionStakingStorage.getTotalEffectiveStakeAtEpoch(1)).to.equal(6000);
      expect(await ConvictionStakingStorage.getTotalEffectiveStakeAtEpoch(2)).to.equal(6000);
      expect(await ConvictionStakingStorage.getTotalEffectiveStakeAtEpoch(12)).to.equal(1500);
    });

    it('Integer safety: expiry + delete + new create cannot underflow', async () => {
      await ConvictionStakingStorage.createPosition(1, ALICE_ID, 1000, 11, SIX_X);
      await advanceEpochs(11);
      await ConvictionStakingStorage.deletePosition(1);
      expect(await ConvictionStakingStorage.getTotalEffectiveStakeAtEpoch(12)).to.equal(0);
      await ConvictionStakingStorage.createPosition(2, BOB_ID, 500, 4, TWO_X);
      expect(await ConvictionStakingStorage.getTotalEffectiveStakeAtEpoch(12)).to.equal(1000);
      expect(await ConvictionStakingStorage.getTotalEffectiveStakeAtEpoch(16)).to.equal(500);
    });
  });
});
