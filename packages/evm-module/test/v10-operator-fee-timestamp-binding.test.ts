// =============================================================================
// H-5 / F-204 regression — operator-fee retroactive capture blocked
// =============================================================================
//
// Confirms that StakingV10._claim applies the operator fee that was ACTIVE at
// the START of epoch `e` (via getOperatorFeePercentageByTimestampReverse),
// not the latest entry in profile.operatorFees[] (which may have a future
// effectiveDate). This blocks the H-STK-3a drain path where an operator:
//
//   1. Satisfies `isOperatorFeeClaimedForEpoch(id, currentEpoch - 1)`.
//   2. Calls Profile.updateOperatorFee to push a new high-fee entry with
//      effectiveDate = start of next epoch.
//   3. Races the first claim of the just-ended epoch — under the buggy
//      `getLatestOperatorFeePercentage` path the new (high) fee was applied
//      retroactively to the already-ended epoch.
//
// Timeline:
//
//   Epoch 1: profile created, fee set to FEE_OLD (5%), effective epoch 2.
//   Epoch 2: delegator stakes. FEE_OLD is now active.
//   Epoch 3: claim epoch 2 (satisfies guard). Operator pushes FEE_HIGH (99%),
//            effective epoch 4.
//   Epoch 4: Scenario A — claim epoch 3 must use FEE_OLD (not FEE_HIGH).
//   Epoch 5: Scenario B — FEE_HIGH is now active; claim epoch 4 uses FEE_HIGH.

import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { loadFixture, time } from '@nomicfoundation/hardhat-network-helpers';
import { expect } from 'chai';
import hre from 'hardhat';

import {
  Chronos,
  ConvictionStakingStorage,
  DKGStakingConvictionNFT,
  EpochStorage,
  Hub,
  ParametersStorage,
  Profile,
  ProfileStorage,
  RandomSamplingStorage,
  StakingV10,
  Token,
} from '../typechain';
import { createProfile } from './helpers/profile-helpers';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SCALE18 = 10n ** 18n;
const toTRAC = (n: number) => hre.ethers.parseEther(n.toString());

// Lock tier 0 = rest state, no expiry, 1x multiplier (simplest for reward math).
const LOCK_EPOCHS = 0;

// Principal
const RAW = toTRAC(10_000);

// Operator fees expressed in units of parametersStorage.maxOperatorFee()
// (10 000). 5% = 500, 99% = 9900.
const FEE_OLD = 500n;  // 5%
const FEE_HIGH = 9900n; // 99%

// Epoch pool per epoch (injected manually)
const EPOCH_POOL = toTRAC(1_000);

// EpochStorage shard index used by StakingV10
const EPOCH_POOL_INDEX = 1n;

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

type Fixture = {
  accounts: SignerWithAddress[];
  Hub: Hub;
  Token: Token;
  Chronos: Chronos;
  Profile: Profile;
  ProfileStorage: ProfileStorage;
  StakingV10: StakingV10;
  ConvictionStakingStorage: ConvictionStakingStorage;
  RandomSamplingStorage: RandomSamplingStorage;
  EpochStorage: EpochStorage;
  ParametersStorage: ParametersStorage;
  NFT: DKGStakingConvictionNFT;
};

async function deployFixture(): Promise<Fixture> {
  await hre.deployments.fixture([
    'DKGStakingConvictionNFT',
    'StakingV10',
    'Profile',
    'EpochStorage',
    'RandomSamplingStorage',
  ]);

  const accounts = await hre.ethers.getSigners();
  const Hub = await hre.ethers.getContract<Hub>('Hub');
  // Give accounts[0] hub-owner privileges so tests can call privileged setters.
  await Hub.setContractAddress('HubOwner', accounts[0].address);

  const ParametersStorage =
    await hre.ethers.getContract<ParametersStorage>('ParametersStorage');

  return {
    accounts,
    Hub,
    Token: await hre.ethers.getContract<Token>('Token'),
    Chronos: await hre.ethers.getContract<Chronos>('Chronos'),
    Profile: await hre.ethers.getContract<Profile>('Profile'),
    ProfileStorage: await hre.ethers.getContract<ProfileStorage>('ProfileStorage'),
    StakingV10: await hre.ethers.getContract<StakingV10>('StakingV10'),
    ConvictionStakingStorage: await hre.ethers.getContract<ConvictionStakingStorage>(
      'ConvictionStakingStorage',
    ),
    RandomSamplingStorage: await hre.ethers.getContract<RandomSamplingStorage>(
      'RandomSamplingStorage',
    ),
    EpochStorage: await hre.ethers.getContract<EpochStorage>('EpochStorageV8'),
    ParametersStorage,
    NFT: await hre.ethers.getContract<DKGStakingConvictionNFT>('DKGStakingConvictionNFT'),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Inject scores + epoch pool for `epoch` on a single-node network,
 * so the node earns EPOCH_POOL (gross rewards = full pool).
 * effectiveStake is used to compute scorePerStake36.
 */
async function injectEpochRewards(
  ctx: Fixture,
  identityId: number,
  epoch: bigint,
  effectiveStake: bigint,
): Promise<void> {
  const { RandomSamplingStorage, EpochStorage, accounts } = ctx;
  const hub0 = accounts[0];

  // single-node network: nodeScore == allNodesScore → grossRewards = EPOCH_POOL
  const nodeScore = toTRAC(1_000);
  await RandomSamplingStorage.connect(hub0).setAllNodesEpochScore(epoch, nodeScore);
  await RandomSamplingStorage.connect(hub0).setNodeEpochScore(epoch, identityId, nodeScore);

  const scorePerStake36 = (nodeScore * SCALE18) / effectiveStake;
  await RandomSamplingStorage.connect(hub0).setNodeEpochScorePerStake(
    epoch,
    identityId,
    scorePerStake36,
  );

  await EpochStorage.connect(hub0).addTokensToEpochRange(
    EPOCH_POOL_INDEX,
    epoch,
    epoch,
    EPOCH_POOL,
  );

  // Back the CSS vault so the claim payout is covered.
  await ctx.Token.mint(await ctx.ConvictionStakingStorage.getAddress(), EPOCH_POOL);
}

/** Advance time to the start of the next epoch. */
async function advanceEpoch(chronos: Chronos): Promise<void> {
  const remaining = await chronos.timeUntilNextEpoch();
  await time.increase(remaining + 1n);
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('@integration H-5 regression — operator fee bound to epoch timestamp', function () {
  let accounts: SignerWithAddress[];
  let Token: Token;
  let Chronos: Chronos;
  let ProfileContract: Profile;
  let ProfileStorageContract: ProfileStorage;
  let StakingV10Contract: StakingV10;
  let CSS: ConvictionStakingStorage;
  let ParametersStorageContract: ParametersStorage;
  let NFT: DKGStakingConvictionNFT;
  let ctx: Fixture;

  beforeEach(async function () {
    hre.helpers.resetDeploymentsJson();
    ctx = await loadFixture(deployFixture);
    ({
      accounts,
      Token,
      Chronos,
      Profile: ProfileContract,
      ProfileStorage: ProfileStorageContract,
      StakingV10: StakingV10Contract,
      ConvictionStakingStorage: CSS,
      ParametersStorage: ParametersStorageContract,
      NFT,
    } = ctx);
  });

  // -------------------------------------------------------------------------
  // Scenario A + B: combined to share timeline state
  // -------------------------------------------------------------------------
  it(
    'Scenario A: retroactive fee drain blocked; ' +
    'Scenario B: prospective fee applies from its effectiveDate',
    async function () {
      // ----------------------------------------------------------------
      // Actors
      // ----------------------------------------------------------------
      const nodeOp = accounts[1];
      const nodeAdmin = accounts[2];
      const delegator = accounts[3];

      const maxFee = await ParametersStorageContract.maxOperatorFee();

      // ----------------------------------------------------------------
      // Epoch 1: Create profile. Set initial fee FEE_OLD (5%).
      //
      // Profile.updateOperatorFee sets effectiveDate = start of epoch 2
      // (since we're in the first half of epoch 1). Guard at line 226 is
      // skipped because `currentEpoch > 1` is false on epoch 1.
      // ----------------------------------------------------------------
      expect(await Chronos.getCurrentEpoch()).to.equal(1n);

      const { identityId } = await createProfile(ProfileContract, {
        operational: nodeOp,
        admin: nodeAdmin,
      });

      await ProfileContract.connect(nodeAdmin).updateOperatorFee(
        identityId,
        Number(FEE_OLD),
      );

      // Confirm FEE_OLD was added with an effectiveDate in the future.
      const feeOldEffective =
        await ProfileStorageContract.getLatestOperatorFeeEffectiveDate(identityId);
      const epoch2Start = await Chronos.timestampForEpoch(2n);
      // effectiveDate should be epoch 2 start (first half of epoch 1 → nextEpochStart)
      expect(feeOldEffective).to.equal(epoch2Start);

      // ----------------------------------------------------------------
      // Advance to epoch 2. FEE_OLD is now active.
      // ----------------------------------------------------------------
      await advanceEpoch(Chronos);
      const epoch2 = await Chronos.getCurrentEpoch();
      expect(epoch2).to.equal(2n);

      // ----------------------------------------------------------------
      // Epoch 2: Delegator stakes (1-epoch lock, 1x multiplier).
      // ----------------------------------------------------------------
      await Token.mint(delegator.address, RAW);
      await Token.connect(delegator).approve(
        await StakingV10Contract.getAddress(),
        RAW,
      );
      await NFT.connect(delegator).createConviction(identityId, RAW, LOCK_EPOCHS);
      const tokenId = 1n; // first NFT minted

      // Inject rewards for epoch 2 (staking epoch).
      await injectEpochRewards(ctx, identityId, epoch2, RAW);

      // ----------------------------------------------------------------
      // Advance to epoch 3.
      // ----------------------------------------------------------------
      await advanceEpoch(Chronos);
      const epoch3 = await Chronos.getCurrentEpoch();
      expect(epoch3).to.equal(3n);

      // ----------------------------------------------------------------
      // Epoch 3: First claim of epoch 2 (sets isOperatorFeeClaimedForEpoch(id,2) = true).
      // This satisfies the guard in Profile.updateOperatorFee for epoch 3
      // (requires currentEpoch - 1 = epoch 2 to be claimed).
      // ----------------------------------------------------------------
      await NFT.connect(delegator).claim(tokenId);

      // Confirm epoch 2 fee was claimed at FEE_OLD (5%).
      expect(await CSS.isOperatorFeeClaimedForEpoch(identityId, epoch2)).to.equal(true);

      const opFeeBalAfterEpoch2 = await CSS.getOperatorFeeBalance(identityId);
      const expectedOpFeeEpoch2 = (EPOCH_POOL * FEE_OLD) / BigInt(maxFee);
      expect(opFeeBalAfterEpoch2).to.be.closeTo(expectedOpFeeEpoch2, toTRAC(1) / 1000n);

      // ----------------------------------------------------------------
      // Epoch 3: Inject rewards for epoch 3.
      //          Then operator changes fee to FEE_HIGH (99%).
      //
      // Profile.updateOperatorFee: currentEpoch = 3, guard passes because
      // isOperatorFeeClaimedForEpoch(id, 2) = true. effectiveDate = start
      // of epoch 4 (first half of epoch 3 → nextEpochStart).
      // ----------------------------------------------------------------
      await injectEpochRewards(ctx, identityId, epoch3, RAW);

      await ProfileContract.connect(nodeAdmin).updateOperatorFee(
        identityId,
        Number(FEE_HIGH),
      );

      // Confirm FEE_HIGH was pushed with effectiveDate >= epoch 4 start.
      const epoch4Start = await Chronos.timestampForEpoch(4n);
      const feeHighEffective =
        await ProfileStorageContract.getLatestOperatorFeeEffectiveDate(identityId);
      expect(feeHighEffective).to.be.gte(epoch4Start);

      // getLatestOperatorFeePercentage now returns FEE_HIGH (buggy path).
      expect(
        await ProfileStorageContract.getLatestOperatorFeePercentage(identityId),
      ).to.equal(FEE_HIGH);

      // But the fee at epoch 3's START must still be FEE_OLD.
      const epoch3Start = await Chronos.timestampForEpoch(epoch3);
      const feeAtEpoch3Start =
        await ProfileStorageContract.getOperatorFeePercentageByTimestampReverse(
          identityId,
          epoch3Start,
        );
      expect(feeAtEpoch3Start).to.equal(FEE_OLD);

      // ----------------------------------------------------------------
      // Advance to epoch 4.
      // ----------------------------------------------------------------
      await advanceEpoch(Chronos);
      const epoch4 = await Chronos.getCurrentEpoch();
      expect(epoch4).to.equal(4n);

      // ----------------------------------------------------------------
      // Scenario A: First claim of epoch 3. Must use FEE_OLD (5%), not FEE_HIGH.
      // ----------------------------------------------------------------
      const opFeeBalBefore = await CSS.getOperatorFeeBalance(identityId);
      await NFT.connect(delegator).claim(tokenId);
      const opFeeBalAfterEpoch3 = await CSS.getOperatorFeeBalance(identityId);
      const opFeeIncreaseEpoch3 = opFeeBalAfterEpoch3 - opFeeBalBefore;

      const expectedOpFeeEpoch3Old = (EPOCH_POOL * FEE_OLD) / BigInt(maxFee);
      const expectedOpFeeEpoch3High = (EPOCH_POOL * FEE_HIGH) / BigInt(maxFee);

      // Must match old fee with dust tolerance.
      expect(opFeeIncreaseEpoch3).to.be.closeTo(
        expectedOpFeeEpoch3Old,
        toTRAC(1) / 1000n,
      );

      // Must NOT be near the high fee (retroactive drain was blocked).
      expect(opFeeIncreaseEpoch3).to.be.lt(expectedOpFeeEpoch3High);

      // Cross-check via cached netNodeEpochRewards.
      const netEpoch3 = await CSS.getNetNodeEpochRewards(identityId, epoch3);
      const expectedNetEpoch3 = EPOCH_POOL - expectedOpFeeEpoch3Old;
      expect(netEpoch3).to.be.closeTo(expectedNetEpoch3, toTRAC(1) / 1000n);

      // ----------------------------------------------------------------
      // Scenario B: FEE_HIGH effectiveDate = epoch 4 start. Claiming epoch 4
      // uses timestamp = timestampForEpoch(5) - 1, which is strictly greater
      // than epoch4Start, so the fast path returns FEE_HIGH.
      //
      // Inject rewards for epoch 4, advance to epoch 5, claim epoch 4.
      // The fee applied for epoch 4 must be FEE_HIGH.
      // ----------------------------------------------------------------

      // Inject rewards for epoch 4.
      await injectEpochRewards(ctx, identityId, epoch4, RAW);

      // Advance to epoch 5 so epoch 4 is claimable.
      await advanceEpoch(Chronos);
      const epoch5 = await Chronos.getCurrentEpoch();
      expect(epoch5).to.equal(5n);

      // Verify FEE_HIGH is the latest entry (fast path: timestampForEpoch(5)-1 > epoch4Start).
      // Note: getOperatorFeePercentageByTimestampReverse at exactly epoch4Start still returns
      // FEE_OLD (boundary semantics), but the claim uses timestampForEpoch(e+1)-1 which is
      // strictly inside the epoch. We verify correctness via the post-claim balance delta.

      // Claim epoch 4 — should apply FEE_HIGH via the timestamp-bound lookup.
      const opFeeBalBeforeE4 = await CSS.getOperatorFeeBalance(identityId);
      await NFT.connect(delegator).claim(tokenId);
      const opFeeBalAfterE4 = await CSS.getOperatorFeeBalance(identityId);
      const opFeeIncreaseEpoch4 = opFeeBalAfterE4 - opFeeBalBeforeE4;

      const expectedOpFeeEpoch4High = (EPOCH_POOL * FEE_HIGH) / BigInt(maxFee);
      expect(opFeeIncreaseEpoch4).to.be.closeTo(
        expectedOpFeeEpoch4High,
        toTRAC(1) / 1000n,
      );

      // Cross-check via cached netNodeEpochRewards for epoch 4.
      const netEpoch4 = await CSS.getNetNodeEpochRewards(identityId, epoch4);
      const expectedNetEpoch4 = EPOCH_POOL - expectedOpFeeEpoch4High;
      expect(netEpoch4).to.be.closeTo(expectedNetEpoch4, toTRAC(1) / 1000n);
    },
  );
});
