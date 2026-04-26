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

// 1e18-scaled multiplier constants matching the baseline D20 tier ladder.
const SCALE18 = 10n ** 18n;
const ONE_X = SCALE18;
const ONE_AND_HALF_X = (15n * SCALE18) / 10n;
const TWO_X = 2n * SCALE18;
const THREE_AND_HALF_X = (35n * SCALE18) / 10n;
const SIX_X = 6n * SCALE18;

const DAY = 24n * 60n * 60n;
const TIER_DURATIONS: Record<number, bigint> = {
  0: 0n,
  1: 30n * DAY,
  3: 90n * DAY,
  6: 180n * DAY,
  12: 366n * DAY,
};

// D26 — timestamp-accurate accounting: no BLOCK_DRIFT_BUFFER padding, no
// epoch rounding. Lock wall-clock durations are exact.

async function latestTimestamp(): Promise<bigint> {
  return BigInt(await time.latest());
}

// Expected boost contribution to `runningNodeEffectiveStake` for a fresh
// `createPosition` at lockTier/multiplier18/raw. Under D26 the full
// `raw * mult / 1e18` is added while the position is boosted; on expiry the
// scheduled drop equals the boost-only portion (`raw * (mult-1) / 1e18`).
function effNow(raw: bigint, mult18: bigint): bigint {
  return (raw * mult18) / SCALE18;
}
function boostDrop(raw: bigint, mult18: bigint): bigint {
  return (raw * (mult18 - SCALE18)) / SCALE18;
}

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

  beforeEach(async () => {
    hre.helpers.resetDeploymentsJson();
    ({ accounts, ConvictionStakingStorage, Chronos } = await loadFixture(deployFixture));
  });

  // ------------------------------------------------------------
  // Metadata
  // ------------------------------------------------------------

  it('Should have correct name and version', async () => {
    expect(await ConvictionStakingStorage.name()).to.equal('ConvictionStakingStorage');
    // D26 code-review follow-ups bumped storage to 3.1.0 (M2/M3/L5/L9/L11).
    expect(await ConvictionStakingStorage.version()).to.equal('3.1.0');
  });

  // ------------------------------------------------------------
  // Tier ladder (exact wall-clock durations, no BLOCK_DRIFT_BUFFER)
  // ------------------------------------------------------------

  describe('expectedMultiplier18 tier ladder (D26 durations)', () => {
    it('Returns canonical multipliers for the baseline ladder {0,1,3,6,12}', async () => {
      expect(await ConvictionStakingStorage.expectedMultiplier18(0)).to.equal(ONE_X);
      expect(await ConvictionStakingStorage.expectedMultiplier18(1)).to.equal(ONE_AND_HALF_X);
      expect(await ConvictionStakingStorage.expectedMultiplier18(3)).to.equal(TWO_X);
      expect(await ConvictionStakingStorage.expectedMultiplier18(6)).to.equal(THREE_AND_HALF_X);
      expect(await ConvictionStakingStorage.expectedMultiplier18(12)).to.equal(SIX_X);
    });

    it('Returns exact wall-clock durations (BLOCK_DRIFT_BUFFER removed)', async () => {
      for (const [tierStr, duration] of Object.entries(TIER_DURATIONS)) {
        const tier = Number(tierStr);
        expect(await ConvictionStakingStorage.tierDuration(tier)).to.equal(duration);
      }
    });

    it('Reverts on every lock outside the discrete set', async () => {
      for (const invalid of [2, 4, 5, 7, 8, 9, 10, 11, 13, 24, 100]) {
        await expect(
          ConvictionStakingStorage.expectedMultiplier18(invalid),
        ).to.be.revertedWith('Invalid tier');
      }
    });
  });

  // ------------------------------------------------------------
  // createPosition — timestamp-accurate state
  // ------------------------------------------------------------

  describe('createPosition — single position', () => {
    it('Stores position fields with zero-lock (permanent 1x)', async () => {
      const currentEpoch = await Chronos.getCurrentEpoch();
      await ConvictionStakingStorage.createPosition(1, ALICE_ID, 1000, 0, 0);

      const pos = await ConvictionStakingStorage.getPosition(1);
      expect(pos.raw).to.equal(1000);
      expect(pos.cumulativeRewardsClaimed).to.equal(0);
      expect(pos.lockTier).to.equal(0);
      // Tier 0 expiry sentinel: no boost → 0.
      expect(pos.expiryTimestamp).to.equal(0);
      expect(pos.multiplier18).to.equal(ONE_X);
      expect(pos.identityId).to.equal(ALICE_ID);
      expect(pos.lastClaimedEpoch).to.equal(currentEpoch - 1n);
      expect(pos.migrationEpoch).to.equal(0);
    });

    it('Tier-12 position: expiryTimestamp = block.ts + 366d, full boost in running stake, drop at expiry', async () => {
      const tx = await ConvictionStakingStorage.createPosition(1, ALICE_ID, 1000, 12, 0);
      await tx.wait();
      const tsNow = await latestTimestamp();
      const expectedExpiry = tsNow + TIER_DURATIONS[12];

      const pos = await ConvictionStakingStorage.getPosition(1);
      expect(pos.expiryTimestamp).to.equal(expectedExpiry);
      expect(pos.multiplier18).to.equal(SIX_X);

      // Running stake at creation: full raw*6 = 6000.
      expect(await ConvictionStakingStorage.getNodeRunningEffectiveStake(ALICE_ID)).to.equal(
        effNow(1000n, SIX_X),
      );
      expect(await ConvictionStakingStorage.getNodeEffectiveStake(ALICE_ID)).to.equal(
        effNow(1000n, SIX_X),
      );

      // Expiry queue holds a single drop = raw*(6-1) = 5000 at `expectedExpiry`.
      const times = await ConvictionStakingStorage.getNodeExpiryTimes(ALICE_ID);
      expect(times.length).to.equal(1);
      expect(times[0]).to.equal(expectedExpiry);
      expect(await ConvictionStakingStorage.getNodeExpiryDrop(ALICE_ID, expectedExpiry)).to.equal(
        boostDrop(1000n, SIX_X),
      );

      // Simulated read past expiry: stake drops to raw (1x tail).
      expect(
        await ConvictionStakingStorage.getNodeEffectiveStakeAtTimestamp(
          ALICE_ID,
          expectedExpiry,
        ),
      ).to.equal(1000n);
      expect(
        await ConvictionStakingStorage.getNodeEffectiveStakeAtTimestamp(
          ALICE_ID,
          expectedExpiry + 10_000n,
        ),
      ).to.equal(1000n);
    });

    it('Fractional tier 1.5x (lock=1): raw 2000 → boost 1000, drop at +30d', async () => {
      await ConvictionStakingStorage.createPosition(1, ALICE_ID, 2000, 1, 0);
      const tsNow = await latestTimestamp();
      const expectedExpiry = tsNow + TIER_DURATIONS[1];

      const pos = await ConvictionStakingStorage.getPosition(1);
      expect(pos.expiryTimestamp).to.equal(expectedExpiry);

      expect(await ConvictionStakingStorage.getNodeRunningEffectiveStake(ALICE_ID)).to.equal(3000n);
      expect(await ConvictionStakingStorage.getNodeExpiryDrop(ALICE_ID, expectedExpiry)).to.equal(
        1000n,
      );
      expect(
        await ConvictionStakingStorage.getNodeEffectiveStakeAtTimestamp(
          ALICE_ID,
          expectedExpiry - 1n,
        ),
      ).to.equal(3000n);
      expect(
        await ConvictionStakingStorage.getNodeEffectiveStakeAtTimestamp(
          ALICE_ID,
          expectedExpiry,
        ),
      ).to.equal(2000n);
    });

    it('Fractional tier 3.5x (lock=6): raw 2000 → boost 5000, drop at +180d', async () => {
      await ConvictionStakingStorage.createPosition(1, ALICE_ID, 2000, 6, 0);
      const tsNow = await latestTimestamp();
      const expectedExpiry = tsNow + TIER_DURATIONS[6];

      expect(await ConvictionStakingStorage.getNodeRunningEffectiveStake(ALICE_ID)).to.equal(7000n);
      expect(await ConvictionStakingStorage.getNodeExpiryDrop(ALICE_ID, expectedExpiry)).to.equal(
        5000n,
      );
    });

    it('Reverts on invalid inputs', async () => {
      await expect(
        ConvictionStakingStorage.createPosition(1, 0, 1000, 12, 0),
      ).to.be.revertedWith('Zero node');

      await expect(
        ConvictionStakingStorage.createPosition(1, ALICE_ID, 0, 12, 0),
      ).to.be.revertedWith('Zero raw');

      // L11 — multiplier18 is now derived inside CSS; tier-mismatch paths
      //       are no longer reachable from the external surface. Only the
      //       "Invalid tier" check remains as the lock-validation signal.
      await expect(
        ConvictionStakingStorage.createPosition(99, ALICE_ID, 1000, 5, 0),
      ).to.be.revertedWith('Invalid tier');

      await ConvictionStakingStorage.createPosition(1, ALICE_ID, 1000, 12, 0);
      await expect(
        ConvictionStakingStorage.createPosition(1, ALICE_ID, 500, 3, 0),
      ).to.be.revertedWith('Position exists');
    });
  });

  // ------------------------------------------------------------
  // Sorted-insert invariant (Option A)
  // ------------------------------------------------------------

  describe('expiry queue — sorted insert invariant', () => {
    it('Inserts expiries in ascending order regardless of creation order (mixed tiers)', async () => {
      // Create tier-12 first (furthest expiry), then tier-1 (soonest), then tier-6.
      // Expected final order in the queue: [+30d, +180d, +366d].
      await ConvictionStakingStorage.createPosition(1, ALICE_ID, 100, 12, 0);
      const ts12 = (await latestTimestamp()) + TIER_DURATIONS[12];

      await ConvictionStakingStorage.createPosition(2, ALICE_ID, 100, 1, 0);
      const ts1 = (await latestTimestamp()) + TIER_DURATIONS[1];

      await ConvictionStakingStorage.createPosition(3, ALICE_ID, 100, 6, 0);
      const ts6 = (await latestTimestamp()) + TIER_DURATIONS[6];

      const times = await ConvictionStakingStorage.getNodeExpiryTimes(ALICE_ID);
      expect(times.length).to.equal(3);
      expect(times[0]).to.equal(ts1);
      expect(times[1]).to.equal(ts6);
      expect(times[2]).to.equal(ts12);
      expect(await ConvictionStakingStorage.getNodePendingExpiryCount(ALICE_ID)).to.equal(3);
    });

    it('Coalesces drops at the same timestamp (two boosted positions at identical expiry)', async () => {
      // Create two tier-12 positions in the same block. Their expiryTimestamps
      // collide, but the queue must still hold a SINGLE entry with the summed drop.
      await hre.network.provider.send('evm_setAutomine', [false]);
      try {
        await ConvictionStakingStorage.createPosition(1, ALICE_ID, 100, 12, 0);
        await ConvictionStakingStorage.createPosition(2, ALICE_ID, 200, 12, 0);
        await hre.network.provider.send('evm_mine', []);
      } finally {
        await hre.network.provider.send('evm_setAutomine', [true]);
      }

      const tsNow = await latestTimestamp();
      const expectedExpiry = tsNow + TIER_DURATIONS[12];

      const times = await ConvictionStakingStorage.getNodeExpiryTimes(ALICE_ID);
      expect(times.length).to.equal(1);
      expect(times[0]).to.equal(expectedExpiry);
      expect(
        await ConvictionStakingStorage.getNodeExpiryDrop(ALICE_ID, expectedExpiry),
      ).to.equal(boostDrop(300n, SIX_X));
    });
  });

  // ------------------------------------------------------------
  // Multi-position aggregation on a single node
  // ------------------------------------------------------------

  describe('per-node aggregation', () => {
    it('Two NFTs under same identityId sum their effective stake and decay independently', async () => {
      await ConvictionStakingStorage.createPosition(1, ALICE_ID, 500, 12, 0);
      const tsAtCreate1 = await latestTimestamp();
      const expiry12 = tsAtCreate1 + TIER_DURATIONS[12];

      await ConvictionStakingStorage.createPosition(2, ALICE_ID, 200, 3, 0);
      const tsAtCreate2 = await latestTimestamp();
      const expiry3 = tsAtCreate2 + TIER_DURATIONS[3];

      // Before any expiry: 500*6 + 200*2 = 3400.
      expect(await ConvictionStakingStorage.getNodeRunningEffectiveStake(ALICE_ID)).to.equal(3400n);

      // At expiry3 (tier-3 drops boost): 500*6 + 200 = 3200.
      expect(
        await ConvictionStakingStorage.getNodeEffectiveStakeAtTimestamp(ALICE_ID, expiry3),
      ).to.equal(3200n);

      // At expiry12 (tier-12 drops boost): 500 + 200 = 700.
      expect(
        await ConvictionStakingStorage.getNodeEffectiveStakeAtTimestamp(ALICE_ID, expiry12),
      ).to.equal(700n);
    });

    it('Second node is unaffected by first node writes', async () => {
      await ConvictionStakingStorage.createPosition(1, ALICE_ID, 500, 12, 0);
      await ConvictionStakingStorage.createPosition(2, ALICE_ID, 200, 3, 0);

      expect(await ConvictionStakingStorage.getNodeRunningEffectiveStake(BOB_ID)).to.equal(0n);
      expect(await ConvictionStakingStorage.getNodeRunningEffectiveStake(OTHER_ID)).to.equal(0n);
    });
  });

  // ------------------------------------------------------------
  // settleNodeTo — drains expiries in one pass
  // ------------------------------------------------------------

  describe('settleNodeTo', () => {
    it('Drains a single expiry, zeroes the drop, bumps the head cursor', async () => {
      await ConvictionStakingStorage.createPosition(1, ALICE_ID, 1000, 12, 0);
      const tsAtCreate = await latestTimestamp();
      const expiry = tsAtCreate + TIER_DURATIONS[12];

      // Advance past the expiry.
      await time.increaseTo(Number(expiry) + 1);
      await ConvictionStakingStorage.settleNodeTo(ALICE_ID, await latestTimestamp());

      expect(await ConvictionStakingStorage.getNodeRunningEffectiveStake(ALICE_ID)).to.equal(1000n);
      expect(await ConvictionStakingStorage.getNodeExpiryHead(ALICE_ID)).to.equal(1n);
      expect(await ConvictionStakingStorage.getNodeExpiryDrop(ALICE_ID, expiry)).to.equal(0n);
    });

    it('Drains multiple pending expiries across one call (dormancy resume)', async () => {
      // 3 positions with staggered expiries (tiers 1, 3, 12).
      await ConvictionStakingStorage.createPosition(1, ALICE_ID, 100, 1, 0);
      await ConvictionStakingStorage.createPosition(2, ALICE_ID, 100, 3, 0);
      await ConvictionStakingStorage.createPosition(3, ALICE_ID, 100, 12, 0);

      const tsBase = await latestTimestamp();
      // Jump well past all three expiries in one go.
      await time.increaseTo(Number(tsBase + TIER_DURATIONS[12] + 10n));
      await ConvictionStakingStorage.settleNodeTo(ALICE_ID, await latestTimestamp());

      // After full drain: raw-tail only = 100 + 100 + 100 = 300.
      expect(await ConvictionStakingStorage.getNodeRunningEffectiveStake(ALICE_ID)).to.equal(300n);
      expect(await ConvictionStakingStorage.getNodeExpiryHead(ALICE_ID)).to.equal(3n);
      expect(await ConvictionStakingStorage.getNodePendingExpiryCount(ALICE_ID)).to.equal(0);
    });

    it('Idempotent: settling to a past timestamp is a no-op', async () => {
      await ConvictionStakingStorage.createPosition(1, ALICE_ID, 1000, 12, 0);
      const tsAtCreate = await latestTimestamp();
      await ConvictionStakingStorage.settleNodeTo(ALICE_ID, tsAtCreate);
      await ConvictionStakingStorage.settleNodeTo(ALICE_ID, tsAtCreate - 1n);
      // Still fully boosted.
      expect(await ConvictionStakingStorage.getNodeRunningEffectiveStake(ALICE_ID)).to.equal(6000n);
      expect(await ConvictionStakingStorage.getNodeExpiryHead(ALICE_ID)).to.equal(0n);
    });
  });

  // ------------------------------------------------------------
  // Mutators — running-state maintenance
  // ------------------------------------------------------------

  // M1 / L11 — `updateOnRelock` was removed. Post-expiry relocks now go
  // through `createNewPositionFromExisting` (burn old tokenId, mint a fresh
  // one keyed to the new lockTier). See `DKGStakingConvictionNFT.test.ts`
  // for the token-side coverage and the D26 integration suite for the
  // end-to-end flow.

  describe('updateOnRedelegate', () => {
    it('Moves full effective contribution from old node to new node; cancels + reschedules the boost drop', async () => {
      await ConvictionStakingStorage.createPosition(1, ALICE_ID, 1000, 12, 0);
      const expiry = (await latestTimestamp()) + TIER_DURATIONS[12];

      await ConvictionStakingStorage.updateOnRedelegate(1, BOB_ID);

      expect((await ConvictionStakingStorage.getPosition(1)).identityId).to.equal(BOB_ID);
      expect(await ConvictionStakingStorage.getNodeRunningEffectiveStake(ALICE_ID)).to.equal(0n);
      expect(await ConvictionStakingStorage.getNodeRunningEffectiveStake(BOB_ID)).to.equal(6000n);

      // Alice's queue entry was cancelled; Bob's queue has the same ts.
      expect(await ConvictionStakingStorage.getNodeExpiryDrop(ALICE_ID, expiry)).to.equal(0n);
      expect(await ConvictionStakingStorage.getNodeExpiryDrop(BOB_ID, expiry)).to.equal(5000n);
    });

    it('Redelegating a post-expiry position moves only the raw tail (no boost to cancel)', async () => {
      await ConvictionStakingStorage.createPosition(1, ALICE_ID, 1000, 3, 0);
      await time.increase(Number(TIER_DURATIONS[3]) + 1);
      await ConvictionStakingStorage.settleNodeTo(ALICE_ID, await latestTimestamp());

      await ConvictionStakingStorage.updateOnRedelegate(1, BOB_ID);

      expect(await ConvictionStakingStorage.getNodeRunningEffectiveStake(ALICE_ID)).to.equal(0n);
      expect(await ConvictionStakingStorage.getNodeRunningEffectiveStake(BOB_ID)).to.equal(1000n);
    });

    it('Reverts when redelegating to same node / identityId 0', async () => {
      await ConvictionStakingStorage.createPosition(1, ALICE_ID, 1000, 12, 0);
      await expect(
        ConvictionStakingStorage.updateOnRedelegate(1, ALICE_ID),
      ).to.be.revertedWith('Same node');
      await expect(
        ConvictionStakingStorage.updateOnRedelegate(1, 0),
      ).to.be.revertedWith('Zero node');
    });
  });

  describe('deletePosition', () => {
    it('Wipes a pre-expiry position and cancels its pending boost drop', async () => {
      await ConvictionStakingStorage.createPosition(1, ALICE_ID, 1000, 12, 0);
      const expiry = (await latestTimestamp()) + TIER_DURATIONS[12];

      await ConvictionStakingStorage.deletePosition(1);
      const pos = await ConvictionStakingStorage.getPosition(1);
      expect(pos.raw).to.equal(0);
      expect(pos.identityId).to.equal(0);

      expect(await ConvictionStakingStorage.getNodeRunningEffectiveStake(ALICE_ID)).to.equal(0n);
      expect(await ConvictionStakingStorage.getNodeExpiryDrop(ALICE_ID, expiry)).to.equal(0n);
    });

    it('Post-expiry delete: boost was already drained, only raw tail is unwound', async () => {
      await ConvictionStakingStorage.createPosition(1, ALICE_ID, 1000, 3, 0);
      await time.increase(Number(TIER_DURATIONS[3]) + 1);
      await ConvictionStakingStorage.settleNodeTo(ALICE_ID, await latestTimestamp());

      await ConvictionStakingStorage.deletePosition(1);
      expect(await ConvictionStakingStorage.getNodeRunningEffectiveStake(ALICE_ID)).to.equal(0n);
    });

    it('Reverts on missing position', async () => {
      await expect(ConvictionStakingStorage.deletePosition(42)).to.be.revertedWith('No position');
    });

    it('Succeeds on a rewards-only position (raw==0, identityId!=0)', async () => {
      await ConvictionStakingStorage.createPosition(1, ALICE_ID, 1000, 0, 0);
      await ConvictionStakingStorage.decreaseRaw(1, 1000);
      const pos = await ConvictionStakingStorage.getPosition(1);
      expect(pos.raw).to.equal(0);
      expect(pos.identityId).to.equal(ALICE_ID);
      await expect(ConvictionStakingStorage.deletePosition(1)).to.not.be.reverted;
    });
  });

  describe('decreaseRaw / increaseRaw', () => {
    it('Pre-expiry decreaseRaw shrinks running stake by amount*mult and cancels proportional boost drop', async () => {
      await ConvictionStakingStorage.createPosition(1, ALICE_ID, 1000, 12, 0);
      const expiry = (await latestTimestamp()) + TIER_DURATIONS[12];

      await ConvictionStakingStorage.decreaseRaw(1, 400);
      const pos = await ConvictionStakingStorage.getPosition(1);
      expect(pos.raw).to.equal(600);

      // Running effective: (1000-400)*6 = 3600.
      expect(await ConvictionStakingStorage.getNodeRunningEffectiveStake(ALICE_ID)).to.equal(3600n);
      // Boost drop shrunk to 600*(6-1) = 3000.
      expect(await ConvictionStakingStorage.getNodeExpiryDrop(ALICE_ID, expiry)).to.equal(3000n);
    });

    it('Post-expiry decreaseRaw removes a flat `amount` (boost already drained)', async () => {
      await ConvictionStakingStorage.createPosition(1, ALICE_ID, 1000, 3, 0);
      await time.increase(Number(TIER_DURATIONS[3]) + 1);
      await ConvictionStakingStorage.settleNodeTo(ALICE_ID, await latestTimestamp());

      await ConvictionStakingStorage.decreaseRaw(1, 300);
      expect(await ConvictionStakingStorage.getNodeRunningEffectiveStake(ALICE_ID)).to.equal(700n);
    });

    it('increaseRaw pre-expiry grows running stake by amount*mult and adds to the same expiry bucket', async () => {
      await ConvictionStakingStorage.createPosition(1, ALICE_ID, 600, 12, 0);
      const expiry = (await latestTimestamp()) + TIER_DURATIONS[12];

      await ConvictionStakingStorage.increaseRaw(1, 200);
      expect(await ConvictionStakingStorage.getNodeRunningEffectiveStake(ALICE_ID)).to.equal(4800n);
      // drop grew: 800*(6-1) = 4000.
      expect(await ConvictionStakingStorage.getNodeExpiryDrop(ALICE_ID, expiry)).to.equal(4000n);
    });

    it('Round-trip: decreaseRaw then increaseRaw restores running stake exactly (pre-expiry)', async () => {
      await ConvictionStakingStorage.createPosition(1, ALICE_ID, 1000, 12, 0);
      const expiry = (await latestTimestamp()) + TIER_DURATIONS[12];
      const runningBefore = await ConvictionStakingStorage.getNodeRunningEffectiveStake(ALICE_ID);
      const dropBefore = await ConvictionStakingStorage.getNodeExpiryDrop(ALICE_ID, expiry);

      await ConvictionStakingStorage.decreaseRaw(1, 400);
      await ConvictionStakingStorage.increaseRaw(1, 400);

      expect(await ConvictionStakingStorage.getNodeRunningEffectiveStake(ALICE_ID)).to.equal(
        runningBefore,
      );
      expect(await ConvictionStakingStorage.getNodeExpiryDrop(ALICE_ID, expiry)).to.equal(
        dropBefore,
      );
    });

    it('decreaseRaw reverts on insufficient raw / non-existent position', async () => {
      await ConvictionStakingStorage.createPosition(1, ALICE_ID, 1000, 12, 0);
      await expect(ConvictionStakingStorage.decreaseRaw(1, 1001)).to.be.revertedWith(
        'Insufficient raw',
      );
      await expect(ConvictionStakingStorage.decreaseRaw(42, 1)).to.be.revertedWith('No position');
    });

    it('Zero-amount ops are no-ops', async () => {
      await ConvictionStakingStorage.createPosition(1, ALICE_ID, 1000, 12, 0);
      const runningBefore = await ConvictionStakingStorage.getNodeRunningEffectiveStake(ALICE_ID);
      await ConvictionStakingStorage.increaseRaw(1, 0);
      await ConvictionStakingStorage.decreaseRaw(1, 0);
      expect(await ConvictionStakingStorage.getNodeRunningEffectiveStake(ALICE_ID)).to.equal(
        runningBefore,
      );
    });
  });

  // ------------------------------------------------------------
  // D26-specific: find-and-remove on delete before expiry is O(1)
  // amortized (queue entry stays, drop goes to 0; drained later).
  // ------------------------------------------------------------

  describe('boost-drop cancellation leaves queue entry intact', () => {
    it('Deletes the only pending position: queue entry remains but drop is 0', async () => {
      await ConvictionStakingStorage.createPosition(1, ALICE_ID, 1000, 12, 0);
      const expiry = (await latestTimestamp()) + TIER_DURATIONS[12];
      await ConvictionStakingStorage.deletePosition(1);

      // Entry is still present in the array (drained later as a no-op).
      const times = await ConvictionStakingStorage.getNodeExpiryTimes(ALICE_ID);
      expect(times.length).to.equal(1);
      expect(times[0]).to.equal(expiry);
      // But the drop has been cancelled to 0.
      expect(await ConvictionStakingStorage.getNodeExpiryDrop(ALICE_ID, expiry)).to.equal(0n);

      // Settling past expiry drains the zero entry without blowing up.
      await time.increaseTo(Number(expiry) + 1);
      await ConvictionStakingStorage.settleNodeTo(ALICE_ID, await latestTimestamp());
      expect(await ConvictionStakingStorage.getNodeRunningEffectiveStake(ALICE_ID)).to.equal(0n);
      expect(await ConvictionStakingStorage.getNodeExpiryHead(ALICE_ID)).to.equal(1n);
    });
  });

  // ------------------------------------------------------------
  // D20 — mutable tier ladder (unchanged admin surface)
  // ------------------------------------------------------------

  describe('Mutable tier ladder (v2.1.0)', () => {
    it('Seeds the full baseline ladder with exact wall-clock durations', async () => {
      const ids = await ConvictionStakingStorage.allTierIds();
      expect(ids.map((i) => Number(i)).sort((a, b) => a - b)).to.deep.equal([0, 1, 3, 6, 12]);
      expect(await ConvictionStakingStorage.tierCount()).to.equal(5);

      for (const tier of [0, 1, 3, 6, 12]) {
        const tc = await ConvictionStakingStorage.getTier(tier);
        expect(tc.exists).to.equal(true);
        expect(tc.active).to.equal(true);
        expect(tc.duration).to.equal(TIER_DURATIONS[tier]);
      }
    });

    it('HubOwner can append a new tier and createPosition picks it up', async () => {
      const newTier = 24;
      const newDuration = 2n * 366n * DAY;
      const newMult = 12n * SCALE18;
      await expect(ConvictionStakingStorage.addTier(newTier, newDuration, newMult))
        .to.emit(ConvictionStakingStorage, 'TierAdded')
        .withArgs(newTier, newDuration, newMult);

      expect(await ConvictionStakingStorage.expectedMultiplier18(newTier)).to.equal(newMult);
      expect(await ConvictionStakingStorage.tierDuration(newTier)).to.equal(newDuration);

      await ConvictionStakingStorage.createPosition(1, ALICE_ID, 1000, newTier, 0);
      const pos = await ConvictionStakingStorage.getPosition(1);
      expect(pos.lockTier).to.equal(newTier);
      expect(pos.multiplier18).to.equal(newMult);
      // Expected expiry = ts + 2 years.
      const tsNow = await latestTimestamp();
      expect(pos.expiryTimestamp).to.equal(tsNow + newDuration);
    });

    it('addTier rejects duplicates, degenerate tier-0 configs, and boost-less non-zero tiers', async () => {
      // Duplicate id.
      await expect(
        ConvictionStakingStorage.addTier(1, 30n * DAY, ONE_AND_HALF_X),
      ).to.be.revertedWith('Tier exists');
      // M3/M4 — non-zero tier with sub-1x multiplier is rejected as a degenerate
      // boost (would make the "big sum" == "raw sum" and break our fast-path
      // shortcuts in StakingV10._delegatorIncrementForEpoch).
      await expect(
        ConvictionStakingStorage.addTier(24, 2n * 366n * DAY, SCALE18 / 2n),
      ).to.be.revertedWith('Non-zero tier needs boost');
      // M3/M4 — non-zero tier with exactly 1x is rejected for the same reason.
      await expect(
        ConvictionStakingStorage.addTier(24, 2n * 366n * DAY, ONE_X),
      ).to.be.revertedWith('Non-zero tier needs boost');
      // M3/M4 — non-zero tier with duration == 0 is rejected (would install a
      // position whose expiryTimestamp == block.timestamp, i.e. already expired).
      await expect(
        ConvictionStakingStorage.addTier(24, 0n, TWO_X),
      ).to.be.revertedWith('Non-zero tier needs duration');
      // M3/M4 — tier 0 is reserved as the "rest state"; duration/mult must be
      // exactly (0, 1x) or we break the canonical rest-state contract.
      await expect(
        ConvictionStakingStorage.addTier(0, 1n, ONE_X),
      ).to.be.revertedWith('Tier exists');
    });

    it('Non-owner cannot addTier / deactivateTier', async () => {
      await expect(
        ConvictionStakingStorage.connect(accounts[1]).addTier(24, 100n, ONE_AND_HALF_X),
      ).to.be.reverted;
      await expect(ConvictionStakingStorage.connect(accounts[1]).deactivateTier(1)).to.be.reverted;
    });

    it('deactivateTier rejects fresh stakes but relock still honors original commitment', async () => {
      await ConvictionStakingStorage.createPosition(1, ALICE_ID, 1000, 3, 0);
      await time.increase(Number(TIER_DURATIONS[3]) + 1);
      await ConvictionStakingStorage.settleNodeTo(ALICE_ID, await latestTimestamp());

      await ConvictionStakingStorage.deactivateTier(3);
      await expect(
        ConvictionStakingStorage.createPosition(2, ALICE_ID, 1000, 3, 0),
      ).to.be.revertedWith('Tier inactive');

      // L11 — existing holder can still relock into the deactivated tier via
      //       `createNewPositionFromExisting` (relocks are exempt from the
      //       active-tier check; only fresh `createPosition` enforces it).
      await expect(
        ConvictionStakingStorage.createNewPositionFromExisting(1, 2, ALICE_ID, 3),
      ).to.not.be.reverted;
    });
  });

  // ------------------------------------------------------------
  // CCO-8 — Code-review follow-ups (M2 / L5 / L7 / L9).
  // ------------------------------------------------------------

  describe('CCO-8 — code-review follow-up regressions', () => {
    it('M2 — cancel → reschedule at the same expiryTimestamp does not duplicate queue slots', async () => {
      // Create, cancel (deletePosition), then re-create another position with a
      // `createPosition` in the same block. Because `_scheduleNodeExpiry` uses
      // `nodeExpiryPresent` to dedupe, the queue should contain a SINGLE slot
      // with the combined drop from the surviving position only.
      await hre.network.provider.send('evm_setAutomine', [false]);
      try {
        await ConvictionStakingStorage.createPosition(1, ALICE_ID, 1000, 12, 0);
        await ConvictionStakingStorage.deletePosition(1);
        await ConvictionStakingStorage.createPosition(2, ALICE_ID, 1000, 12, 0);
        await hre.network.provider.send('evm_mine', []);
      } finally {
        await hre.network.provider.send('evm_setAutomine', [true]);
      }

      const tsNow = await latestTimestamp();
      const expectedExpiry = tsNow + TIER_DURATIONS[12];

      // There must be exactly one live entry — the delete+recreate MUST NOT
      // append a second slot at the same ts.
      const times = await ConvictionStakingStorage.getNodeExpiryTimes(ALICE_ID);
      expect(times.length).to.equal(1);
      expect(times[0]).to.equal(expectedExpiry);
      expect(
        await ConvictionStakingStorage.getNodeExpiryDrop(ALICE_ID, expectedExpiry),
      ).to.equal(boostDrop(1000n, SIX_X));
    });

    it('L5 — cancelling the entire drop zeroes `nodeExpiryDrop` for a gas refund', async () => {
      await ConvictionStakingStorage.createPosition(1, ALICE_ID, 1000, 12, 0);
      const expiry = (await latestTimestamp()) + TIER_DURATIONS[12];
      expect(await ConvictionStakingStorage.getNodeExpiryDrop(ALICE_ID, expiry)).to.equal(
        boostDrop(1000n, SIX_X),
      );
      // `deletePosition` fully cancels the only pending drop.
      await ConvictionStakingStorage.deletePosition(1);
      // After cancellation the slot's drop is 0 (storage actually `delete`d,
      // which returns a gas refund and preserves the invariant that
      // `getNodeExpiryDrop` returns 0 for drained/cancelled entries).
      expect(await ConvictionStakingStorage.getNodeExpiryDrop(ALICE_ID, expiry)).to.equal(0n);
    });

    it('L7 — `getNodeEffectiveStakeAtEpoch` tolerates epoch >= horizon (Chronos boundary)', async () => {
      // Create a pre-expiry position and read its effective stake at a very
      // distant epoch. The getter must not revert even if Chronos returns 0
      // for `timestampForEpoch(epoch + 1)` (which is the "no bound" sentinel).
      await ConvictionStakingStorage.createPosition(1, ALICE_ID, 1000, 12, 0);
      const farFutureEpoch = 10_000n;
      // Defensive: the contract must not revert on out-of-horizon reads.
      await expect(
        ConvictionStakingStorage.getNodeEffectiveStakeAtEpoch(ALICE_ID, farFutureEpoch),
      ).to.not.be.reverted;
    });

    it('L9 — `setV10LaunchEpoch` is one-shot and rejects the second call', async () => {
      // Seeding a launch epoch succeeds once; subsequent calls must revert.
      await expect(ConvictionStakingStorage.setV10LaunchEpoch(5)).to.not.be.reverted;
      await expect(ConvictionStakingStorage.setV10LaunchEpoch(6)).to.be.revertedWith(
        'V10 launch already set',
      );
    });
  });
});
