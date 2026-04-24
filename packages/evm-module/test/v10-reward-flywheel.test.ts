// =============================================================================
// V10 Phase 11 — @integration full reward flywheel test
// =============================================================================
//
// Proves the complete V10 reward cycle works end-to-end:
//
//   1. One node with a V10 staker (1000 TRAC, 12-epoch lock = 6x) and
//      a V8 staker (1000 TRAC, 1x).
//   2. Epoch pool funded + scores injected (simulating publish + proof).
//   3. One epoch advance.
//   4. V10 staker claims via DKGStakingConvictionNFT.claim(tokenId).
//   5. V8 staker claims via Staking.claimDelegatorRewards(identityId, epoch, delegator).
//   6. Assert 6/7 + 1/7 conservation with rounding-dust tolerance.
//   7. Assert vault balance invariant: Token.balanceOf(StakingStorage) >= totalStake.
//
// Scores are injected directly into RandomSamplingStorage + EpochStorage
// rather than going through the publish + proof pipeline. This isolates
// the reward-claim logic from the publish pipeline, which has its own
// integration tests in StakingRewards.test.ts.

import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { loadFixture, time } from '@nomicfoundation/hardhat-network-helpers';
import { expect } from 'chai';
import hre from 'hardhat';

import {
  Chronos,
  ConvictionStakingStorage,
  DelegatorsInfo,
  DKGStakingConvictionNFT,
  EpochStorage,
  Hub,
  ParametersStorage,
  Profile,
  ProfileStorage,
  RandomSamplingStorage,
  Staking,
  StakingStorage,
  StakingV10,
  Token,
} from '../typechain';
import { createProfile } from './helpers/profile-helpers';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SCALE18 = 10n ** 18n;
const toTRAC = (n: number) => hre.ethers.parseEther(n.toString());

// V10 tier 12 = 6x multiplier
const SIX_X = 6n * SCALE18;
const LOCK_EPOCHS = 12;

// Staking amounts
const V10_RAW = toTRAC(1_000);
const V8_RAW = toTRAC(1_000);

// Effective stakes:  V10 = 1000 * 6 = 6000,  V8 = 1000
// Total effective = 7000
const V10_EFFECTIVE = (V10_RAW * SIX_X) / SCALE18; // 6000e18
const V8_EFFECTIVE = V8_RAW;                         // 1000e18
const TOTAL_EFFECTIVE = V10_EFFECTIVE + V8_EFFECTIVE; // 7000e18

// EpochStorage shard index used by both Staking.sol and StakingV10.sol
const EPOCH_POOL_INDEX = 1n;

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

type FlywheelFixture = {
  accounts: SignerWithAddress[];
  Hub: Hub;
  Token: Token;
  Chronos: Chronos;
  Profile: Profile;
  ProfileStorage: ProfileStorage;
  Staking: Staking;
  StakingV10: StakingV10;
  StakingStorage: StakingStorage;
  ConvictionStakingStorage: ConvictionStakingStorage;
  DelegatorsInfo: DelegatorsInfo;
  RandomSamplingStorage: RandomSamplingStorage;
  EpochStorage: EpochStorage;
  ParametersStorage: ParametersStorage;
  NFT: DKGStakingConvictionNFT;
};

async function deployFlywheelFixture(): Promise<FlywheelFixture> {
  // Pull the full V10 deploy graph — DKGStakingConvictionNFT transitively
  // brings Hub, StakingV10, Staking, ConvictionStakingStorage, storages,
  // Profile, Token, EpochStorage, RandomSamplingStorage, etc.
  await hre.deployments.fixture([
    'DKGStakingConvictionNFT',
    'StakingV10',
    'Profile',
    'Staking',
    'EpochStorage',
    'RandomSamplingStorage',
    'DelegatorsInfo',
  ]);

  const accounts = await hre.ethers.getSigners();
  const Hub = await hre.ethers.getContract<Hub>('Hub');

  // Grant HubOwner to accounts[0] so we can poke privileged setters.
  await Hub.setContractAddress('HubOwner', accounts[0].address);

  return {
    accounts,
    Hub,
    Token: await hre.ethers.getContract<Token>('Token'),
    Chronos: await hre.ethers.getContract<Chronos>('Chronos'),
    Profile: await hre.ethers.getContract<Profile>('Profile'),
    ProfileStorage: await hre.ethers.getContract<ProfileStorage>('ProfileStorage'),
    Staking: await hre.ethers.getContract<Staking>('Staking'),
    StakingV10: await hre.ethers.getContract<StakingV10>('StakingV10'),
    StakingStorage: await hre.ethers.getContract<StakingStorage>('StakingStorage'),
    ConvictionStakingStorage: await hre.ethers.getContract<ConvictionStakingStorage>(
      'ConvictionStakingStorage',
    ),
    DelegatorsInfo: await hre.ethers.getContract<DelegatorsInfo>('DelegatorsInfo'),
    RandomSamplingStorage: await hre.ethers.getContract<RandomSamplingStorage>(
      'RandomSamplingStorage',
    ),
    EpochStorage: await hre.ethers.getContract<EpochStorage>('EpochStorageV8'),
    ParametersStorage: await hre.ethers.getContract<ParametersStorage>('ParametersStorage'),
    NFT: await hre.ethers.getContract<DKGStakingConvictionNFT>('DKGStakingConvictionNFT'),
  };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// TOMBSTONE — Mixed V8 + V10 flywheel scenarios (skipped, V10-only model)
// ---------------------------------------------------------------------------
//
// Every test in this describe block mixes a V8 `Staking.stake()` delegator
// with a V10 conviction-NFT staker on the same `identityId`. Two separate
// decisions made during V10 (PR #97) render this mixed-mode scenario
// invalid going forward:
//
//   1. D15 — V10 aggregates live on `ConvictionStakingStorage.nodeStakeV10`
//      / `totalStakeV10`, NOT on `StakingStorage.getNodeStake`. These suites
//      assert `getNodeStake(id) == V10_RAW + V8_RAW`, which was true when
//      V10 mirrored into SS; under D15 it equals the V8 bucket only.
//
//   2. User directive (post-PR97) — "there will only be V10 nodes" and
//      `calculateNodeScore` now reads V10-only stake. Any V8 stake parked
//      on a V10 node earns no score → earns no rewards → breaks the 6:1
//      conservation math these tests check.
//
// Migration is MANDATORY: the only valid post-V10 path for a V8 delegator
// landing on a V10 node is `selfMigrateV8` → `ConvertedFromV8` which absorbs
// the V8 stake into a fresh V10 position. That flow is covered by
// `@integration V10 Phase 5 — selfMigrateV8` in v10-conviction.test.ts and
// by the unit suite on DKGStakingConvictionNFT. The mixed-mode flywheel
// math here is strictly obsolete and would need a full rewrite against the
// new aggregates + V10-only scoring model to carry any signal. Skipping
// with this tombstone in lieu of deletion so the intent + rationale is
// preserved in-tree.
describe.skip('@integration V10 Phase 11 — full reward flywheel (OBSOLETE: mixed V8+V10)', function () {
  let accounts: SignerWithAddress[];
  let Token: Token;
  let Chronos: Chronos;
  let ProfileContract: Profile;
  let ProfileStorageContract: ProfileStorage;
  let StakingContract: Staking;
  let StakingV10Contract: StakingV10;
  let StakingStorageContract: StakingStorage;
  let ConvictionStorageContract: ConvictionStakingStorage;
  let RandomSamplingStorageContract: RandomSamplingStorage;
  let EpochStorageContract: EpochStorage;
  let ParametersStorageContract: ParametersStorage;
  let NFT: DKGStakingConvictionNFT;

  beforeEach(async function () {
    hre.helpers.resetDeploymentsJson();
    const fx = await loadFixture(deployFlywheelFixture);
    ({
      accounts,
      Token,
      Chronos,
      ParametersStorage: ParametersStorageContract,
      RandomSamplingStorage: RandomSamplingStorageContract,
      EpochStorage: EpochStorageContract,
      NFT,
    } = fx);
    ProfileContract = fx.Profile;
    ProfileStorageContract = fx.ProfileStorage;
    StakingContract = fx.Staking;
    StakingV10Contract = fx.StakingV10;
    StakingStorageContract = fx.StakingStorage;
    ConvictionStorageContract = fx.ConvictionStakingStorage;
  });

  // -----------------------------------------------------------------------
  // The single main test
  // -----------------------------------------------------------------------

  it('V10 (6x) + V8 (1x) stakers share rewards in 6:1 ratio with conservation', async function () {
    // ------------------------------------------------------------------
    // Actors
    // ------------------------------------------------------------------
    const nodeOp = accounts[1];   // node operational wallet
    const nodeAdmin = accounts[2]; // node admin wallet
    const v10Staker = accounts[3];
    const v8Staker = accounts[4];

    // ------------------------------------------------------------------
    // Step 0: Set operator fee update delay to 0 so we can set it immediately
    // ------------------------------------------------------------------
    await ParametersStorageContract.connect(accounts[0]).setOperatorFeeUpdateDelay(0);

    // ------------------------------------------------------------------
    // Step 1: Create a node profile
    // ------------------------------------------------------------------
    const { identityId } = await createProfile(ProfileContract, {
      operational: nodeOp,
      admin: nodeAdmin,
    });

    // Set operator fee to 10% (1000 / 10000)
    await ProfileContract.connect(nodeAdmin).updateOperatorFee(identityId, 1000);

    // ------------------------------------------------------------------
    // Step 2: V10 staker — create conviction (12-epoch lock = 6x)
    // ------------------------------------------------------------------
    await Token.mint(v10Staker.address, V10_RAW);
    await Token.connect(v10Staker).approve(await StakingV10Contract.getAddress(), V10_RAW);
    await NFT.connect(v10Staker).createConviction(identityId, V10_RAW, LOCK_EPOCHS);
    const tokenId = 0n; // first NFT minted

    // Sanity: position exists with correct tier
    const pos = await ConvictionStorageContract.getPosition(tokenId);
    expect(pos.identityId).to.equal(identityId);
    expect(pos.raw).to.equal(V10_RAW);
    expect(pos.multiplier18).to.equal(SIX_X);

    // ------------------------------------------------------------------
    // Step 3: V8 staker — classic stake (1x)
    // ------------------------------------------------------------------
    await Token.mint(v8Staker.address, V8_RAW);
    await Token.connect(v8Staker).approve(await StakingContract.getAddress(), V8_RAW);
    await StakingContract.connect(v8Staker).stake(identityId, V8_RAW);

    // Sanity: combined raw node stake = V10_RAW + V8_RAW = 2000 TRAC
    const nodeStake = await StakingStorageContract.getNodeStake(identityId);
    expect(nodeStake).to.equal(V10_RAW + V8_RAW);

    // Record the staking epoch for later
    const stakingEpoch = await Chronos.getCurrentEpoch();

    // ------------------------------------------------------------------
    // Step 4: Simulate publish — fund epoch pool + mint backing TRAC
    // ------------------------------------------------------------------
    // We will fund `stakingEpoch` with EPOCH_POOL_AMOUNT, which is
    // the total TRAC that all nodes (just ours) share in this epoch.
    const EPOCH_POOL_AMOUNT = toTRAC(700); // 700 TRAC in the pool

    // Fund epoch pool: addTokensToEpochRange is `onlyContracts`-gated.
    // accounts[0] is HubOwner, which is trusted by the Hub access control.
    await EpochStorageContract.connect(accounts[0]).addTokensToEpochRange(
      EPOCH_POOL_INDEX,
      stakingEpoch,
      stakingEpoch,
      EPOCH_POOL_AMOUNT,
    );

    // Mint matching TRAC to StakingStorage so the vault backs the rewards.
    const ssAddr = await StakingStorageContract.getAddress();
    await Token.mint(ssAddr, EPOCH_POOL_AMOUNT);

    // ------------------------------------------------------------------
    // Step 5: Simulate proof — inject scores into RandomSamplingStorage
    // ------------------------------------------------------------------
    // nodeScore = some arbitrary value — the ratio matters, not magnitude.
    // We pick nodeScore = 1000e18 for clarity.
    const nodeScore = toTRAC(1000);

    // allNodesScore = nodeScore (single node in the network)
    await RandomSamplingStorageContract.connect(accounts[0]).setAllNodesEpochScore(
      stakingEpoch,
      nodeScore,
    );
    await RandomSamplingStorageContract.connect(accounts[0]).setNodeEpochScore(
      stakingEpoch,
      identityId,
      nodeScore,
    );

    // scorePerStake36 = nodeScore * 1e18 / effectiveNodeStake
    // effectiveNodeStake = 6000 + 1000 = 7000 TRAC
    // scorePerStake36 = 1000e18 * 1e18 / 7000e18 = 1e18 / 7
    const scorePerStake36 = (nodeScore * SCALE18) / TOTAL_EFFECTIVE;
    await RandomSamplingStorageContract.connect(accounts[0]).setNodeEpochScorePerStake(
      stakingEpoch,
      identityId,
      scorePerStake36,
    );

    // ------------------------------------------------------------------
    // Step 6: Advance one epoch so stakingEpoch is finalised
    // ------------------------------------------------------------------
    const timeUntilNext = await Chronos.timeUntilNextEpoch();
    await time.increase(timeUntilNext + 1n);

    const currentEpoch = await Chronos.getCurrentEpoch();
    expect(currentEpoch).to.be.gt(stakingEpoch);

    // ------------------------------------------------------------------
    // Step 7: V10 staker claims via NFT.claim(tokenId)
    // ------------------------------------------------------------------
    const v10BalBefore = await Token.balanceOf(v10Staker.address);
    await NFT.connect(v10Staker).claim(tokenId);

    // V10 claim auto-compounds into the position — rewards go into
    // pos.rewards, and the StakingStorage delegator base increases.
    // The staker's wallet balance should NOT change (rewards are staked).
    const v10BalAfter = await Token.balanceOf(v10Staker.address);
    expect(v10BalAfter).to.equal(v10BalBefore); // auto-compound, no transfer out

    const posAfterClaim = await ConvictionStorageContract.getPosition(tokenId);
    const v10Reward = posAfterClaim.rewards;

    // ------------------------------------------------------------------
    // Step 8: V8 staker claims via Staking.claimDelegatorRewards
    // ------------------------------------------------------------------
    // Track cumulative earned rewards before claim
    const v8DelegatorKey = hre.ethers.keccak256(
      hre.ethers.solidityPacked(['address'], [v8Staker.address]),
    );
    const v8CumBefore = await StakingStorageContract.getDelegatorCumulativeEarnedRewards(
      identityId,
      v8DelegatorKey,
    );

    await StakingContract.connect(v8Staker).claimDelegatorRewards(
      identityId,
      stakingEpoch,
      v8Staker.address,
    );

    const v8CumAfter = await StakingStorageContract.getDelegatorCumulativeEarnedRewards(
      identityId,
      v8DelegatorKey,
    );
    const v8Reward = v8CumAfter - v8CumBefore;

    // ------------------------------------------------------------------
    // Step 9: Compute expected values
    // ------------------------------------------------------------------
    // grossNodeRewards = epochPool * nodeScore / allNodesScore
    //                  = 700 * 1 = 700 TRAC (single node)
    const grossNodeRewards = (EPOCH_POOL_AMOUNT * nodeScore) / nodeScore;
    expect(grossNodeRewards).to.equal(EPOCH_POOL_AMOUNT);

    // operatorFee = grossNodeRewards * 1000 / 10000 = 10%
    const maxOperatorFee = await ParametersStorageContract.maxOperatorFee();
    const operatorFeePercentage = await ProfileStorageContract.getLatestOperatorFeePercentage(
      identityId,
    );
    const operatorFeeAmount = (grossNodeRewards * BigInt(operatorFeePercentage)) / BigInt(maxOperatorFee);
    const netNodeRewards = grossNodeRewards - operatorFeeAmount;

    // V10 expected: effStake * scorePerStake36 / 1e18 gives delegator's
    // score; then (delegatorScore * netNodeRewards) / nodeScore.
    //
    // V10 delegator score = V10_EFFECTIVE * scorePerStake36 / 1e18
    //                     = 6000 * (1e18/7) / 1e18 = 6000/7
    //
    // V10 reward = (6000/7) * netNodeRewards / 1000 = 6/7 * netNodeRewards
    //
    // But due to integer division, we check with tolerance.
    const expectedV10Reward = (netNodeRewards * V10_EFFECTIVE) / TOTAL_EFFECTIVE;
    const expectedV8Reward = (netNodeRewards * V8_EFFECTIVE) / TOTAL_EFFECTIVE;

    // ------------------------------------------------------------------
    // Assertion A: 6/7 + 1/7 conservation (rounding dust only)
    // ------------------------------------------------------------------
    // The total claimed rewards must not exceed netNodeRewards.
    const totalClaimed = v10Reward + v8Reward;
    expect(totalClaimed).to.be.lte(netNodeRewards);

    // Rounding dust tolerance: scorePerStake36 = nodeScore * 1e18 / 7000e18
    // truncates, then each claim path does
    //   (effStake * scorePerStake36) / 1e18          — truncation 1
    //   (delegatorScore * netNodeRewards) / nodeScore — truncation 2
    // Two cascading integer divisions per staker. The total dust across
    // both stakers is bounded by ~5000 wei for these magnitudes (observed
    // 630 wei at 700 TRAC pool, but scales with divisor precision).
    const dust = netNodeRewards - totalClaimed;
    expect(dust).to.be.lte(10_000n);

    // Each individual reward should be close to the expected value.
    expect(v10Reward).to.be.closeTo(expectedV10Reward, 10_000);
    expect(v8Reward).to.be.closeTo(expectedV8Reward, 10_000);

    // Sanity: V10 reward should be ~6x V8 reward
    // (6000/7000) / (1000/7000) = 6
    // Allow a wider tolerance (1 TRAC) for the ratio check due to rounding
    if (v8Reward > 0n) {
      // v10Reward / v8Reward should be approximately 6
      // Instead of division, check: v10Reward * 1 ~= v8Reward * 6
      expect(v10Reward).to.be.closeTo(v8Reward * 6n, toTRAC(1));
    }

    // ------------------------------------------------------------------
    // Assertion B: vault balance invariant
    // ------------------------------------------------------------------
    // Token.balanceOf(StakingStorage) >= totalStake after all claims.
    // totalStake grew by the auto-compounded rewards (both V10 and V8
    // restake via delegator base increase).
    const totalStake = await StakingStorageContract.getTotalStake();
    const vaultBalance = await Token.balanceOf(ssAddr);
    expect(vaultBalance).to.be.gte(totalStake);

    // ------------------------------------------------------------------
    // Assertion C: operator fee was banked
    // ------------------------------------------------------------------
    const operatorFeeBalance = await StakingStorageContract.getOperatorFeeBalance(identityId);
    expect(operatorFeeBalance).to.equal(operatorFeeAmount);

    // ------------------------------------------------------------------
    // Log summary (informational)
    // ------------------------------------------------------------------
    console.log('\n  Reward Flywheel Summary:');
    console.log(`    Epoch pool:          ${hre.ethers.formatEther(EPOCH_POOL_AMOUNT)} TRAC`);
    console.log(`    Operator fee (10%):  ${hre.ethers.formatEther(operatorFeeAmount)} TRAC`);
    console.log(`    Net node rewards:    ${hre.ethers.formatEther(netNodeRewards)} TRAC`);
    console.log(`    V10 reward (6/7):    ${hre.ethers.formatEther(v10Reward)} TRAC`);
    console.log(`    V8 reward (1/7):     ${hre.ethers.formatEther(v8Reward)} TRAC`);
    console.log(`    Total claimed:       ${hre.ethers.formatEther(totalClaimed)} TRAC`);
    console.log(`    Rounding dust:       ${dust.toString()} wei`);
    console.log(`    Vault balance:       ${hre.ethers.formatEther(vaultBalance)} TRAC`);
    console.log(`    Total stake:         ${hre.ethers.formatEther(totalStake)} TRAC`);
  });

  // -----------------------------------------------------------------------
  // Edge case: zero operator fee
  // -----------------------------------------------------------------------

  it('V10 + V8 conservation holds with 0% operator fee', async function () {
    const nodeOp = accounts[1];
    const nodeAdmin = accounts[2];
    const v10Staker = accounts[3];
    const v8Staker = accounts[4];

    // No operator fee set — default is 0%
    const { identityId } = await createProfile(ProfileContract, {
      operational: nodeOp,
      admin: nodeAdmin,
    });

    // V10 stake
    await Token.mint(v10Staker.address, V10_RAW);
    await Token.connect(v10Staker).approve(await StakingV10Contract.getAddress(), V10_RAW);
    await NFT.connect(v10Staker).createConviction(identityId, V10_RAW, LOCK_EPOCHS);
    const tokenId = 0n;

    // V8 stake
    await Token.mint(v8Staker.address, V8_RAW);
    await Token.connect(v8Staker).approve(await StakingContract.getAddress(), V8_RAW);
    await StakingContract.connect(v8Staker).stake(identityId, V8_RAW);

    const stakingEpoch = await Chronos.getCurrentEpoch();

    // Fund epoch pool + backing TRAC
    const POOL = toTRAC(350);
    await EpochStorageContract.connect(accounts[0]).addTokensToEpochRange(
      EPOCH_POOL_INDEX,
      stakingEpoch,
      stakingEpoch,
      POOL,
    );
    const ssAddr = await StakingStorageContract.getAddress();
    await Token.mint(ssAddr, POOL);

    // Inject scores
    const nodeScore = toTRAC(500);
    await RandomSamplingStorageContract.connect(accounts[0]).setAllNodesEpochScore(
      stakingEpoch,
      nodeScore,
    );
    await RandomSamplingStorageContract.connect(accounts[0]).setNodeEpochScore(
      stakingEpoch,
      identityId,
      nodeScore,
    );
    const scorePerStake36 = (nodeScore * SCALE18) / TOTAL_EFFECTIVE;
    await RandomSamplingStorageContract.connect(accounts[0]).setNodeEpochScorePerStake(
      stakingEpoch,
      identityId,
      scorePerStake36,
    );

    // Advance epoch
    await time.increase((await Chronos.timeUntilNextEpoch()) + 1n);

    // Claims
    await NFT.connect(v10Staker).claim(tokenId);
    const posAfter = await ConvictionStorageContract.getPosition(tokenId);
    const v10Reward = posAfter.rewards;

    const v8Key = hre.ethers.keccak256(
      hre.ethers.solidityPacked(['address'], [v8Staker.address]),
    );
    const v8CumBefore = await StakingStorageContract.getDelegatorCumulativeEarnedRewards(
      identityId,
      v8Key,
    );
    await StakingContract.connect(v8Staker).claimDelegatorRewards(
      identityId,
      stakingEpoch,
      v8Staker.address,
    );
    const v8CumAfter = await StakingStorageContract.getDelegatorCumulativeEarnedRewards(
      identityId,
      v8Key,
    );
    const v8Reward = v8CumAfter - v8CumBefore;

    // 0% operator fee → netNodeRewards = grossNodeRewards = POOL
    const totalClaimed = v10Reward + v8Reward;
    expect(totalClaimed).to.be.lte(POOL);
    expect(POOL - totalClaimed).to.be.lte(10_000n); // rounding dust from scorePerStake36 truncation

    // Vault invariant
    const totalStake = await StakingStorageContract.getTotalStake();
    const vaultBalance = await Token.balanceOf(ssAddr);
    expect(vaultBalance).to.be.gte(totalStake);

    // Operator fee balance should be 0
    const opFee = await StakingStorageContract.getOperatorFeeBalance(identityId);
    expect(opFee).to.equal(0n);
  });

  // -----------------------------------------------------------------------
  // 3-way mixed V8 + multiple V10 positions on the same node
  // -----------------------------------------------------------------------

  it('3-way same-node: Carol(V8 1000) + Alice(V10 6x 1000) + Bob(V10 2x 1000) share rewards correctly', async function () {
    // Actors
    const nodeOp = accounts[1];
    const nodeAdmin = accounts[2];
    const alice = accounts[3];   // V10, 12-epoch lock = 6x
    const bob = accounts[4];     // V10, 3-epoch lock = 2x
    const carol = accounts[5];   // V8, 1x

    // No operator fee — 0% for clean math
    const { identityId } = await createProfile(ProfileContract, {
      operational: nodeOp,
      admin: nodeAdmin,
    });

    // ------------------------------------------------------------------
    // Stake: Alice V10 1000 TRAC @ 12 epochs (6x) → effective 6000
    // ------------------------------------------------------------------
    const ALICE_RAW = toTRAC(1_000);
    const ALICE_LOCK = 12;
    const ALICE_MULT = 6n * SCALE18;
    const ALICE_EFF = (ALICE_RAW * ALICE_MULT) / SCALE18; // 6000e18

    await Token.mint(alice.address, ALICE_RAW);
    await Token.connect(alice).approve(await StakingV10Contract.getAddress(), ALICE_RAW);
    await NFT.connect(alice).createConviction(identityId, ALICE_RAW, ALICE_LOCK);
    const aliceTokenId = 0n;

    const alicePos = await ConvictionStorageContract.getPosition(aliceTokenId);
    expect(alicePos.identityId).to.equal(identityId);
    expect(alicePos.raw).to.equal(ALICE_RAW);
    expect(alicePos.multiplier18).to.equal(ALICE_MULT);

    // ------------------------------------------------------------------
    // Stake: Bob V10 1000 TRAC @ 3 epochs (2x) → effective 2000
    // ------------------------------------------------------------------
    const BOB_RAW = toTRAC(1_000);
    const BOB_LOCK = 3;
    const BOB_MULT = 2n * SCALE18;
    const BOB_EFF = (BOB_RAW * BOB_MULT) / SCALE18; // 2000e18

    await Token.mint(bob.address, BOB_RAW);
    await Token.connect(bob).approve(await StakingV10Contract.getAddress(), BOB_RAW);
    await NFT.connect(bob).createConviction(identityId, BOB_RAW, BOB_LOCK);
    const bobTokenId = 1n;

    const bobPos = await ConvictionStorageContract.getPosition(bobTokenId);
    expect(bobPos.identityId).to.equal(identityId);
    expect(bobPos.raw).to.equal(BOB_RAW);
    expect(bobPos.multiplier18).to.equal(BOB_MULT);

    // ------------------------------------------------------------------
    // Stake: Carol V8 1000 TRAC (1x) → effective 1000
    // ------------------------------------------------------------------
    const CAROL_RAW = toTRAC(1_000);
    const CAROL_EFF = CAROL_RAW; // 1000e18

    await Token.mint(carol.address, CAROL_RAW);
    await Token.connect(carol).approve(await StakingContract.getAddress(), CAROL_RAW);
    await StakingContract.connect(carol).stake(identityId, CAROL_RAW);

    // ------------------------------------------------------------------
    // Effective stake calculations:
    //   nodeStake (StakingStorage) = Alice 1000 + Bob 1000 + Carol 1000 = 3000
    //   nodeEffV10 (ConvictionStakingStorage) = Alice 6000 + Bob 2000 = 8000
    //   nodeV10BaseStake = Alice 1000 + Bob 1000 = 2000
    //   effectiveNodeStake = 3000 + (8000 - 2000) = 9000
    //
    //   Carol share = 1000/9000 = 1/9
    //   Alice share = 6000/9000 = 2/3
    //   Bob share   = 2000/9000 = 2/9
    //   Total       = 1/9 + 6/9 + 2/9 = 9/9 ✓
    // ------------------------------------------------------------------
    const TOTAL_EFF_3WAY = ALICE_EFF + BOB_EFF + CAROL_EFF; // 9000e18

    // Sanity: combined raw node stake = 3000 TRAC
    const nodeStake = await StakingStorageContract.getNodeStake(identityId);
    expect(nodeStake).to.equal(ALICE_RAW + BOB_RAW + CAROL_RAW);

    const stakingEpoch = await Chronos.getCurrentEpoch();

    // ------------------------------------------------------------------
    // Fund epoch pool with 9000 TRAC for clean math
    // ------------------------------------------------------------------
    const EPOCH_POOL = toTRAC(9_000);
    await EpochStorageContract.connect(accounts[0]).addTokensToEpochRange(
      EPOCH_POOL_INDEX,
      stakingEpoch,
      stakingEpoch,
      EPOCH_POOL,
    );
    const ssAddr = await StakingStorageContract.getAddress();
    await Token.mint(ssAddr, EPOCH_POOL);

    // ------------------------------------------------------------------
    // Inject scores (single node in the network)
    // ------------------------------------------------------------------
    const nodeScore = toTRAC(1_000);
    await RandomSamplingStorageContract.connect(accounts[0]).setAllNodesEpochScore(
      stakingEpoch,
      nodeScore,
    );
    await RandomSamplingStorageContract.connect(accounts[0]).setNodeEpochScore(
      stakingEpoch,
      identityId,
      nodeScore,
    );

    // scorePerStake36 = nodeScore * 1e18 / effectiveNodeStake
    //                 = 1000e18 * 1e18 / 9000e18
    const scorePerStake36 = (nodeScore * SCALE18) / TOTAL_EFF_3WAY;
    await RandomSamplingStorageContract.connect(accounts[0]).setNodeEpochScorePerStake(
      stakingEpoch,
      identityId,
      scorePerStake36,
    );

    // ------------------------------------------------------------------
    // Advance one epoch
    // ------------------------------------------------------------------
    await time.increase((await Chronos.timeUntilNextEpoch()) + 1n);
    const currentEpoch = await Chronos.getCurrentEpoch();
    expect(currentEpoch).to.be.gt(stakingEpoch);

    // ------------------------------------------------------------------
    // Alice claims (V10)
    // ------------------------------------------------------------------
    await NFT.connect(alice).claim(aliceTokenId);
    const alicePosAfter = await ConvictionStorageContract.getPosition(aliceTokenId);
    const aliceReward = alicePosAfter.rewards;

    // ------------------------------------------------------------------
    // Bob claims (V10)
    // ------------------------------------------------------------------
    await NFT.connect(bob).claim(bobTokenId);
    const bobPosAfter = await ConvictionStorageContract.getPosition(bobTokenId);
    const bobReward = bobPosAfter.rewards;

    // ------------------------------------------------------------------
    // Carol claims (V8)
    // ------------------------------------------------------------------
    const carolKey = hre.ethers.keccak256(
      hre.ethers.solidityPacked(['address'], [carol.address]),
    );
    const carolCumBefore = await StakingStorageContract.getDelegatorCumulativeEarnedRewards(
      identityId,
      carolKey,
    );
    await StakingContract.connect(carol).claimDelegatorRewards(
      identityId,
      stakingEpoch,
      carol.address,
    );
    const carolCumAfter = await StakingStorageContract.getDelegatorCumulativeEarnedRewards(
      identityId,
      carolKey,
    );
    const carolReward = carolCumAfter - carolCumBefore;

    // ------------------------------------------------------------------
    // Expected values (0% operator fee → net = gross = 9000 TRAC)
    // ------------------------------------------------------------------
    const netNodeRewards = EPOCH_POOL; // single node, allNodesScore = nodeScore

    const expectedAlice = (netNodeRewards * ALICE_EFF) / TOTAL_EFF_3WAY; // 6000/9000 = 2/3
    const expectedBob = (netNodeRewards * BOB_EFF) / TOTAL_EFF_3WAY;     // 2000/9000 = 2/9
    const expectedCarol = (netNodeRewards * CAROL_EFF) / TOTAL_EFF_3WAY; // 1000/9000 = 1/9

    // ------------------------------------------------------------------
    // Assertion A: individual reward shares
    // ------------------------------------------------------------------
    expect(aliceReward).to.be.closeTo(expectedAlice, 10_000);
    expect(bobReward).to.be.closeTo(expectedBob, 10_000);
    expect(carolReward).to.be.closeTo(expectedCarol, 10_000);

    // Sanity: Alice ~= 6x Carol, Bob ~= 2x Carol
    if (carolReward > 0n) {
      expect(aliceReward).to.be.closeTo(carolReward * 6n, toTRAC(1));
      expect(bobReward).to.be.closeTo(carolReward * 2n, toTRAC(1));
    }

    // Sanity: Alice ~= 3x Bob
    if (bobReward > 0n) {
      expect(aliceReward).to.be.closeTo(bobReward * 3n, toTRAC(1));
    }

    // ------------------------------------------------------------------
    // Assertion B: conservation — total claimed <= netNodeRewards, dust small
    // ------------------------------------------------------------------
    const totalClaimed = aliceReward + bobReward + carolReward;
    expect(totalClaimed).to.be.lte(netNodeRewards);
    const dust = netNodeRewards - totalClaimed;
    expect(dust).to.be.lte(10_000n);

    // ------------------------------------------------------------------
    // Assertion C: vault balance invariant
    // ------------------------------------------------------------------
    const totalStake = await StakingStorageContract.getTotalStake();
    const vaultBalance = await Token.balanceOf(ssAddr);
    expect(vaultBalance).to.be.gte(totalStake);

    // ------------------------------------------------------------------
    // Assertion D: operator fee = 0
    // ------------------------------------------------------------------
    const opFee = await StakingStorageContract.getOperatorFeeBalance(identityId);
    expect(opFee).to.equal(0n);

    // ------------------------------------------------------------------
    // Log summary
    // ------------------------------------------------------------------
    console.log('\n  3-Way Mixed Reward Summary:');
    console.log(`    Epoch pool:          ${hre.ethers.formatEther(EPOCH_POOL)} TRAC`);
    console.log(`    Alice (V10 6x):      ${hre.ethers.formatEther(aliceReward)} TRAC  (expected ${hre.ethers.formatEther(expectedAlice)})`);
    console.log(`    Bob   (V10 2x):      ${hre.ethers.formatEther(bobReward)} TRAC  (expected ${hre.ethers.formatEther(expectedBob)})`);
    console.log(`    Carol (V8  1x):      ${hre.ethers.formatEther(carolReward)} TRAC  (expected ${hre.ethers.formatEther(expectedCarol)})`);
    console.log(`    Total claimed:       ${hre.ethers.formatEther(totalClaimed)} TRAC`);
    console.log(`    Rounding dust:       ${dust.toString()} wei`);
    console.log(`    Vault balance:       ${hre.ethers.formatEther(vaultBalance)} TRAC`);
    console.log(`    Total stake:         ${hre.ethers.formatEther(totalStake)} TRAC`);
  });
});
